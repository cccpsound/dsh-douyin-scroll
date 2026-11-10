/**
 * 整段视频抽帧理解：把「这视频从头到尾发生了什么」真的看出来。
 *
 * ---- 为什么之前只看封面 ----
 * 老代码只取 `video.origin_cover`，也就是**作者挑的那一帧**。对"15 秒抖机灵"够用，
 * 但凡是有点过程的视频全瞎：实测同一条 34 秒的「i love deepseek」，
 * 只看封面只能说「一只猫在桌旁」（封面压根是另一条视频的帧），
 * 抽帧之后才读得出「男子写字→牵蓝发女孩走过石柱花田→结尾举着写有爸的纸片」。
 *
 * ---- 为什么现在能做到 ----
 * 1. 抖音详情接口给的是**标准 mp4**，不是 m3u8 分片，可以直接整段下；
 * 2. `video.bit_rate[]` 十几档，最低档极省：17 秒 691886 字节(248ms)，34 秒 1.80MB(345ms)；
 * 3. ffmpeg 二进制放 `~/.dsh/douyin-duty/bin/ffmpeg.exe`（不跟插件走，插件升级不丢）。
 *
 * ---- 为什么不把 N 帧分别发给视觉模型 ----
 * 一帧一次调用，6 帧就是 6 次 ≈ 15 秒 + 6 倍 token。
 * 用 ffmpeg 的 `tile` 拼成一张宫格，一次调用 2~2.6 秒就够，而且模型**真的会读时间顺序**
 * （实测输出：「橘白猫先仰头闭眼，随后转头眯眼，最后睁大一只眼看着镜头」）。
 *
 * ---- 设计原则 ----
 * 任何一步失败都返回 `{ok:false, error}`，由上层**回落到封面**，绝不编造画面。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fitDescBrief } from './desc.mjs'

/** ffmpeg 候选路径：先看数据目录（推荐安装位），再看 PATH */
const FFMPEG_CANDIDATES = [
  join(homedir(), '.dsh', 'douyin-duty', 'bin', 'ffmpeg.exe'),
  join(homedir(), '.dsh', 'douyin-duty', 'bin', 'ffmpeg'),
]

let ffmpegPathCache = null
let ffmpegChecked = false

/**
 * 找 ffmpeg。找不到返回 null（整条链自动跳过，不乱报错）。
 * 结果缓存：一次进程生命周期内只找一次。
 */
export function findFfmpeg() {
  if (ffmpegChecked) return ffmpegPathCache
  ffmpegChecked = true
  ffmpegPathCache = null
  for (const p of FFMPEG_CANDIDATES) {
    try {
      if (existsSync(p)) { ffmpegPathCache = p; break }
    } catch {}
  }
  return ffmpegPathCache
}

/**
 * 跑一条 ffmpeg 命令，成功 resolve stdout Buffer，失败 reject 带 stderr 尾巴。
 *
 * ⚠️ 2026-10-27 实测踩到的坑（很重要，别再踩）：
 *    在 DSH 沙箱里跑时，**子进程写文件会被拒**（ffmpeg 报 `Could not open file` /
 *    `av_interleaved_write_frame(): I/O error` / `Permission denied`），
 *    而同一个 shell 自己 touch 是成功的 —— 也就是说拦的是子进程的文件写入，
 *    不是 ffmpeg 语法问题、不是磁盘满、不是路径分隔符。
 *    ⇒ 所以这里一律用 `-f image2pipe` 把帧吐到 **stdout**，由 Node 接住内存里的 Buffer。
 *    好处不止是绕开限制：连临时文件都不用落盘，跑完什么都不留。
 */
function runFfmpeg(args, { timeoutMs = 60_000 } = {}) {
  const bin = findFfmpeg()
  if (!bin) return Promise.reject(new Error('no_ffmpeg'))
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message || '').slice(-300)
          reject(new Error('ffmpeg_failed: ' + tail))
        } else resolve(stdout)
      }
    )
  })
}

/**
 * 按视频时长决定抽几帧。
 * 为了宫格排版整齐，只取 4 / 6 / 9 三档（2x2 / 3x2 / 3x3）。
 * 帧太少读不出过程，帧太多单帧就糊了、而且 tile 出来分辨率下降。
 *
 * ⚠️ 2026-10-27 晚：分档线跟着 videoToGrid 的 600 秒上限一起放宽。
 *    原来 20s→4 / 60s→6 / 其余→9，3 分钟以上其实进不来。
 *    现在 195 秒的剧情短片也会走 9 帧（3x3），正好够看出起承转合。
 */
export function pickFrameCount(durationMs) {
  const sec = Math.max(0, Number(durationMs) || 0) / 1000
  /**
   * 🔴 2026-11-01 改：档位重排，目标是「相邻两帧别超过约 12 秒」。
   *
   * 老档位（20→4 / 90→6 / 其余 9）有两个问题：
   *   ① 90 秒的梯度是反的：90 秒抽 6 帧（15 秒/帧）比 120 秒抽 9 帧
   *      （13.3 秒/帧）**还稀**，档位在 90 秒处跳变得莫名其妙。
   *   ② 用户实际只会发 ≤5 分钟的片子。老档位下 5 分钟只有 9 帧 =
   *      33 秒一帧 —— 30 秒足够整段换场景，等于中间发生了什么全丢。
   *
   * 新档位按「覆盖密度」分段，间隔控制在 12 秒内：
   *   10 秒 → 4 帧（2.5 秒/帧）    短视频动作细节看得清
   *   30 秒 → 6 帧（5.0 秒/帧）
   *   60 秒 → 8 帧（7.5 秒/帧）
   *   120 秒 → 12 帧（10 秒/帧）
   *   300 秒 → 16 帧（18.8 秒/帧） 5 分钟上限，4x4 宫格
   *
   * 为什么敢加到 16：ffmpeg 是 `-frames:v 1` 单进程单次输出，帧数只影响
   * 「解码时多看几帧」，实测 34 秒 6 帧 ~400ms，16 帧也就 500ms 量级。
   * 真正的代价在视觉模型侧（tile 图从 146 万像素涨到 260 万），
   * 走本机 8765 中转不花钱，只多 1~3 秒。
   *
   * ⚠️ 上限 16 不是随便定的：tile 是 4x4，再往上（5x5=25 帧）每格在模型
   *    眼里就太小了，脸和文字都糊。宁可少而清楚。
   */
  if (sec <= 10) return 4
  if (sec <= 30) return 6
  if (sec <= 60) return 8
  if (sec <= 120) return 12
  return 16
}

/** 宫格列数：4→2x2，6→3x2，9→3x3 */
function tileCols(n) {
  /**
   * 宫格列数。必须让 cols*rows 刚好装下 n（差一帧 tile 就留黑块，
   * 见 extractGrid 里 `fps=(n+0.5)/span` 那段注释），而且形状尽量接近方形 ——
   * 竖屏视频的帧本身是长的，宫格再拉成 3x6 那种细长条，每格会被压得更扁。
   *
   *   4 帧  → 2x2
   *   6 帧  → 3x2
   *   8 帧  → 3x3（第 9 格黑，靠 +0.5 帧补上，见注释）
   *  12 帧  → 4x3
   *  16 帧  → 4x4
   */
  if (n <= 4) return 2
  if (n <= 6) return 3
  if (n <= 9) return 3
  return 4
}

/**
 * 下载整段视频到临时文件。
 *
 * 必须带 Referer —— 抖音视频 CDN 对 Referer 敏感，不带会 403。
 *
 * 🔴 2026-10-29：maxBytes 从 **24MB 提到 48MB**，超时 30s → 45s。
 *
 * 为什么原来的 24MB 是错的：它和上面 600 秒的时长上限**互相打架** ——
 *   实测一条 23 秒的片子，抖音最低档（`540_2_1`）是 **636 kbps**，
 *   按这个码率算 600 秒需要 636kbps × 600s ÷ 8 ≈ **47.7MB**。
 *   也就是说时长闸门放行到 600 秒，体积闸门却在 **317 秒** 左右就把它砍了，
 *   10 分钟那条永远走不到抽帧，静默回落成「只看封面一帧」
 *   （实测封面是个黑底字幕帧，视觉模型回「纯黑背景，无可见人物」）。
 *
 * 48MB 就是按「600 秒 × 636kbps」这个典型值定的，正好卡满。
 * 代价可接受：实测抖音 CDN 带 Referer 直连 **8.67MB/s**，48MB ≈ 5.5 秒下完；
 * 抽 9 帧（3x3 / 540px 单帧）实测 1.5~3 秒 —— 落在 `videoLookBudget`（75 秒）里很松。
 * 超时同步放到 45 秒，容忍 1MB/s 的烂网络（原来 30 秒要求 1.6MB/s，偏紧）。
 *
 * @returns {Promise<{ok:boolean, path?:string, dir?:string, bytes?:number, ms?:number, error?:string}>}
 */
export async function downloadVideo(url, { maxBytes = 48 * 1024 * 1024, timeoutMs = 45_000 } = {}) {
  if (!url) return { ok: false, error: 'empty_url' }
  const t0 = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'dyframe-'))
  const path = join(dir, 'src.mp4')
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Referer: 'https://www.douyin.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      },
    })
    clearTimeout(timer)
    if (!r.ok) { await rm(dir, { recursive: true, force: true }); return { ok: false, error: 'http_' + r.status } }
    // 先看 Content-Length，超限就不下（省得白下 50MB）
    const cl = Number(r.headers.get('content-length') || 0)
    if (cl > maxBytes) {
      await rm(dir, { recursive: true, force: true })
      return { ok: false, error: 'too_large', bytes: cl }
    }
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) { await rm(dir, { recursive: true, force: true }); return { ok: false, error: 'empty_body' } }
    if (buf.length > maxBytes) {
      await rm(dir, { recursive: true, force: true })
      return { ok: false, error: 'too_large', bytes: buf.length }
    }
    await writeFile(path, buf)
    return { ok: true, path, dir, bytes: buf.length, ms: Date.now() - t0 }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: String(e.message || e).slice(0, 120) }
  }
}

/**
 * 抽帧并拼成一张宫格图，返回 data URI。
 *
 * ⭐ 一条命令搞定，全流程不落盘：
 *      `-vf "select='...',scale=..,tile=..x..'"` → `-f image2pipe` → stdout
 *    为什么不是"先抽 N 帧再拼"：那样要么写临时文件（沙箱里子进程写不了，见 runFfmpeg 注释），
 *    要么起 N+1 个进程。一条 select+tile 只要一个进程，实测 34 秒视频 6 帧约 400ms。
 *
 * 选帧用 `select='not(mod(n\,K))'`（按帧号等间隔），不用 fps 滤镜：
 * fps 遇到静止镜头会重复抽同一画面，select 按帧号走，覆盖更均匀。
 *
 * @param {string} videoPath  本地 mp4
 * @param {number} durationMs 视频时长（用来算每几帧取一张）
 * @returns {Promise<{ok:boolean, dataUri?:string, frames?:number, cols?:number, rows?:number, bytes?:number, error?:string}>}
 */
export async function extractGrid(videoPath, durationMs, { frameWidth = 540 } = {}) {
  if (!findFfmpeg()) return { ok: false, error: 'no_ffmpeg' }
  if (!videoPath || !existsSync(videoPath)) return { ok: false, error: 'no_video' }
  const n = pickFrameCount(durationMs)
  const cols = tileCols(n)
  const rows = Math.ceil(n / cols)
  const fwd = (p) => String(p).replace(/\\/g, '/')

  /**
   * 🔴 2026-10-29：抽帧从「按帧号 step」改成「按时间 fps」。
   *
   * 老实现（一直在悄悄丢帧）：
   *   estFrames = round(sec * 30)          // fps 是猜的
   *   step      = floor(estFrames / n)
   *   skip      = floor(estFrames * 0.08)
   *   select    = between(n, skip, estFrames - skip) * not(mod(n - skip, step))
   *
   * 两个致命处：
   *   ① 命中点固定在 `skip + k*step`。第 n 个点是 `skip + (n-1)*step`，
   *      而 `(n-1)*step = estFrames - step`，只要 `step > 2*skip` 就越界。
   *      600 秒 / 9 帧：estFrames=18000、step=2000、skip=1440，
   *      最后一个点 17440 > 上界 16560 ⇒ 被 between 掐掉 ⇒ **只有 8 帧**。
   *      实测 600 秒样片的宫格右下角就是纯黑块。
   *      这条影响所有 `sec > 90` 的片子（9 帧档），即长视频全中招，
   *      而且不报错 —— 视觉模型只是看到一块黑，还以为「结尾是黑屏」。
   *   ② `sec*30` 是猜的。竖屏 30fps 大致对，但 24 / 25 / 60fps 的片子全偏，
   *      偏少就丢结尾，偏多就 `between` 上界算错。
   *
   * 新实现完全不碰帧号：
   *   · `trim` 先切掉首尾各 8%（开头黑场 / 结尾水印关注引导）
   *   · `fps=(n+0.5)/区间秒数` 按**时间**均匀采，不依赖 fps、不依赖总帧数
   *   · 多要半帧是为了保证 tile 收满 `cols*rows` —— 差一帧 tile 就留黑块，
   *     而 `-frames:v 1` 只要第一张，多出来的自然被丢掉，无副作用
   */
  const sec = Math.max(0.1, (Number(durationMs) || 0) / 1000)
  const pad = Math.min(sec * 0.08, 3) // 首尾各切 8%，但最多切 3 秒（短片别切太多）
  const s0 = pad
  const s1 = Math.max(s0 + 0.5, sec - pad)
  const span = s1 - s0
  const vf = [
    `trim=start=${s0.toFixed(3)}:end=${s1.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    `fps=${((n + 0.5) / span).toFixed(6)}`,
    `scale=${frameWidth}:-2`,
    `tile=${cols}x${rows}:padding=4:margin=0`,
  ].join(',')

  try {
    const buf = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', fwd(videoPath),
      '-vf', vf,
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2pipe', '-vcodec', 'mjpeg',
      '-',
    ])
    if (!buf || !buf.length) return { ok: false, error: 'empty_grid' }
    return {
      ok: true,
      dataUri: 'data:image/jpeg;base64,' + buf.toString('base64'),
      frames: n,
      cols,
      rows,
      bytes: buf.length,
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) }
  }
}

/**
 * 一步到位：URL + 时长 → 一张宫格 data URI。
 * 调用方拿到之后自己发给视觉模型（复用 video-card.mjs 的 describeImage）。
 *
 * @returns {Promise<{ok:boolean, dataUri?:string, frames?:number, cols?:number, rows?:number,
 *                    bytes?:number, videoBytes?:number, ms?:number, error?:string}>}
 */
export async function videoToGrid(videoUrl, durationMs, opts = {}) {
  if (!findFfmpeg()) return { ok: false, error: 'no_ffmpeg' }
  const sec = Math.max(0, Number(durationMs) || 0) / 1000

  /**
   * 🔴 2026-10-27 晚改：时长上限从 **180 秒提到 600 秒**。
   *
   * 原来的注释说「3 分钟以上一条条看，时间成本不划算」—— 那是**猜的**，实测推翻了：
   * 拿《永恒的爱》（195.07 秒 / 7,895,353 B 的最低档 mp4）在同一台机器上量：
   *   · 整段下载 7895353 B **868ms**（8.67 MB/s，带 Referer 直连 CDN）
   *   · 本地抽 9 帧（3x3，540px 单帧）**2444ms**
   *   · 合计 **3.3 秒**
   * 对照「远端 seek 不下载」方案（`-ss` + URL 输入）：**9695ms** —— 慢三倍，
   * 因为每次 seek 都要重新建连并读到关键帧，抖音 CDN 的 range 响应并不便宜。
   *
   * ⇒ 结论：这个体积区间（8MB 上下）整段下载是最优解，180 秒这条线纯属自伤。
   *   它把 195 秒的剧情短片挡在门外，让她只能看封面 + 文案 —— 表现就是「念标题」。
   *
   * 🔴 2026-10-29 补：600 秒这个闸门当初**没走通** —— 配的是 maxBytes 24MB，
   *   而 636kbps × 600s ≈ 47.7MB，体积闸门在 317 秒左右就砍了，
   *   实测 601 秒样片被 `too_long` 挡住、600 秒却因体积回落封面。
   *   现在 maxBytes 提到 48MB（见 downloadVideo 的注释），两个闸门才对得上：
   *   **600 秒 + 636kbps 约 47.7MB，正好卡在 48MB 以内**。
   *   超 600 秒才回落封面（那种是真·长视频，整段下载 + 抽帧会顶掉一整拍）。
   */
  if (sec > 600) return { ok: false, error: 'too_long', sec: Math.round(sec) }

  const t0 = Date.now()
  const dl = await downloadVideo(videoUrl, { maxBytes: 48 * 1024 * 1024, ...opts })
  if (!dl.ok) return dl
  try {
    const g = await extractGrid(dl.path, durationMs, opts)
    if (!g.ok) return g
    return {
      ok: true,
      dataUri: g.dataUri,
      frames: g.frames,
      cols: g.cols,
      rows: g.rows,
      bytes: g.bytes,
      videoBytes: dl.bytes,
      downloadMs: dl.ms,
      ms: Date.now() - t0,
    }
  } finally {
    // 临时目录整个删掉（视频 + 单帧 + 宫格都不留）
    await rm(dl.dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 拼给视觉模型的提示词。
 *
 * 三件事必须说清，否则模型会偷懒：
 *  1. 这是**同一个视频**按时间顺序抽的帧（不说的话它当成 N 张不相干的图）；
 *  2. 宫格怎么读（从左到右、从上到下）；
 *  3. 要**说出动作变化和结尾**（只说"一只猫"等于没说，封面就能给这个答案）。
 */
export function gridPrompt(frames, cols, rowCount, { durationMs = 0, desc = '' } = {}) {
  const sec = Math.round((Number(durationMs) || 0) / 1000)
  const reads = cols === 2 && rowCount === 2 ? '2x2（左上→右上→左下→右下）' : `${cols}x${rowCount}（从左到右、从上到下）`
  const bits = [
    `这是同一个竖屏短视频里按时间顺序抽取的 ${frames} 帧，按 ${reads} 排列，依次是时间先后。`,
    sec > 0 ? `原视频 ${sec} 秒。` : '',
    /**
     * ⚠️ 长视频必须点明「帧与帧之间隔了很久」。
     *
     * 195 秒的片子抽 9 帧，平均 21 秒一帧 —— 相邻两帧可能已经是不同场景。
     * 不明说的话模型会按"短视频连拍"的读法去描述，把三个不同场景说成
     * "他先是坐着，然后转动了一下手"这种看不出跨度的假连续。
     */
    /**
     * 🔴 2026-11-01 改：判据从「时长 > 60 秒」改成「实际间隔 > 15 秒」。
     *
     * 老判据 `sec > 60` 会误伤：85 秒的片子现在抽 8 帧，间隔才 11 秒，
     * 明明能连起来看，却被警告「可能已经是不同场景」—— 等于叫模型别信自己的眼睛。
     * 反过来 60 秒抽 8 帧间隔 7.5 秒，老判据压根不提示。
     *
     * 该提示的是**稀疏**，不是**长**。所以直接算间隔。
     */
    sec > 0 && frames > 0 && sec / frames > 15
      ? `注意：${sec} 秒的片子只抽了 ${frames} 帧，相邻两帧之间大约隔了 ${Math.round(sec / frames)} 秒，可能已经是不同场景或不同人物，别把它们当成连续动作。`
      : '',
    /**
     * 🔴 2026-11-03 改：60 → 150。
     *
     * 使用者报「文案读不全」。这是四道截断里的第二道，而且断得最难看：
     * 60 字在中文里正好是一句话说到一半。实测一条 110 字的真文案
     * 断在「…像是刚走丢不」，81 字的断在「…如璀璨星空而」——
     * 视觉模型看到的是一个悬空的句子，后半段讲什么它完全不知道。
     *
     * 为什么视觉模型也要更多文案：文案是作者自己写的「这条片子在讲什么」，
     * 是判断画面内容最省事的一手线索。抽帧只有几帧、脸很小，
     * 光靠图猜容易把 A 段当成 B 段（实测那条猫，封面和正片根本不是一回事）。
     *
     * 🔴 2026-11-05 第三次改：150 → fitDescBrief(400)，首段 + 末段。
     *
     * 长文的重点经常在结尾。使用者贴的那条尼采长文，全篇 900+ 字，
     * 最后一句「他抱住的，是那个被所有人抛弃的自己」才是落点 ——
     * 只给前半段，视觉模型永远看不到这句话。
     * 所以这里不是简单调大，改成「首段 + ……（中间略）…… + 末段」。
     */
    desc ? `作者文案：「${fitDescBrief(desc, 400)}」。` : '',
    /**
     * 字数：80 → 150。
     *
     * 原来卡 80 字是因为「只描述动作」用不了几个字。现在要报人名 + 说清了谁做了什么，
     * 80 字装不下 —— 实测模型会为了省字数把人名或动作其中一样砍掉，
     * 而这两样恰恰是唯一有用的部分。150 字对应的 token 也就 200 出头，不心疼。
     */
    `请用两到三句话（150 字以内）说清：这段视频从头到尾**发生了什么**、**结尾是什么样**。`,
    `如果帧与帧之间能看出动作或场景变化，一定要说出来（谁做了什么、怎么变的）。`,
    /**
     * 🔴 2026-11-01 定稿：认人的优先级 = 字幕/标志 > 长相，长相只作辅助。
     *
     * 演进过程（三轮实测，别退回前两版）：
     *
     * ① 老版本 `只说画面里能看见的事实，不评价、不猜`
     *    后果：发一部毛泽东电视剧，她只会说「一个中年男人在桌前讲话」，
     *    永远说不出里面是谁。那句「不猜」把「从画面识别身份」一起禁了。
     *
     * ② 中间版本「有把握就直接说名字，没把握说像是某某」
     *    后果：**她会自信地认错**。同一张图连跑 5 次，给出 3 个不同答案：
     *      古天乐｜高 / 高市早苗｜— / 刘德华｜高 / 刘德华｜高 / 古天乐｜高
     *    全错，而且每次都报「把握：高」。追问「先描述特征再判断」时它更糟：
     *    先列出「硬朗方脸、颧骨明显、下颌线清晰」，再下结论「骨骼完全吻合」——
     *    这是先定人后倒推理由，不是比对。列宁那张 5 次里 4 次认不出、1 次说成
     *    「伊藤诚」，说明它**没有视觉记忆，只有相似度邻域**，
     *    古天乐/刘德华/高市早苗在它的参数里都挨着。
     *
     * ③ 现在这版：**把顺序写死 —— 先读字，再看脸**。
     *    理由是文字线索（字幕/招牌/标语/旗帜/徽章）100% 读得准，几乎不可能错；
     *    而脸只能给方向。所以强制它先报文字再看人，脸降级为「辅助佐证」。
     *    用户的原话：可以靠长相，但主要还是靠字幕和标志以及评论区。
     *
     * 评论区不在这个函数里 —— 那是 `look-video.mjs` 读、`xj_douyin/main.py` 拼的，
     * 优先级最高（观众会直接把片名和人名写出来）。
     */
    `认人按这个顺序来，别反过来：`,
    `① 先看画面里的文字和标志：字幕、台词、片名水印、招牌、标语、横幅、旗帜、`,
    `   徽章、制服肩章领章、路牌、报纸标题。这些读出来基本不会错，是最可靠的线索。`,
    `② 再看长相：脸只能当辅助。认出是谁就直接说名字；只有五六分像就说「像是某某」。`,
    `   注意：只凭脸认人很容易错 —— 长相相近的人太多了，错认比说不出名字更糟。`,
    `③ 实在认不出，就把第 ① 项里看到的东西原样报出来，这比瞎猜一个人名有用得多。`,
    `把看到的文字原样写出来（不要翻译、不要转述），它们是判断这是什么片子的主要依据。`,
    `不评价、不提"帧""截图""图片"。`,
  ]
  return bits.filter(Boolean).join('\n')
}
