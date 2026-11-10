#!/usr/bin/env node
/**
 * tools/look-video.mjs —— 「看一眼这条作品」跑一次就退出
 * ============================================================================
 * 给 AstrBot 侧的 xj_douyin 用（私聊/群里随手发来的视频卡片）。
 *
 * 为什么单独一个文件：`video-oneshot.mjs` 是「挑推荐流 + 发出去」的链路，
 * 它自己要先 forward-pick 拉候选；而这里只需要「已知 aweme_id，看它在讲什么」。
 * 抖音消息里的卡片（`im-http.py` 的 `card.item_id`）恰好就给了这个 id。
 *
 * 干什么：aweme_id → 页面内 fetch 详情 → 抽帧拼宫格 → 视觉模型说一个字幕级描述。
 * 拿不到就返回 `seen:false` + 原因，**绝不编造画面内容**。
 *
 * 用法：
 *   node tools/look-video.mjs --aweme 7701810317436685619
 *   node tools/look-video.mjs --aweme <id> --no-vision   # 只取元信息（desc/时长/作者）
 *   node tools/look-video.mjs --aweme <id> --timeout 45
 *
 * 输出（单行 JSON）：
 *   {"ok":true,"aweme_id":"…","seen":true,"scene":"…","how_seen":"frames:6(3x2)",
 *    "desc":"…","duration_s":18,"author":"…","ms":8421}
 *   seen:false 时带 "error" / "vision_error"
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { connectPage, ensureChrome, openIsolatedTab, sleep } from '../lib/chrome.mjs'
import { understandVideoCard } from '../lib/video-card.mjs'
import { fitDesc } from '../lib/desc.mjs'
import { nodeRunner } from '../lib/quiet.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}

const AID = String(argOf('--aweme', '')).trim()
const NO_VISION = argv.includes('--no-vision')
/**
 * ⭐ 2026-11-01 加：读评论。
 *
 * 为什么必须有（这是本文件最大的窟窿，用户实测发现的）：
 *   `video-oneshot.mjs`（她自己刷推荐流）一直读评论，`CMT_N=6`；
 *   但 `look-video.mjs`（用户手动发视频给她）**一条都不读** ——
 *   grep "comment" 在这里是空的。
 *
 *   后果：视频里是谁、讲了什么事，只能靠 4~9 帧画面 + 220 字文案。
 *   用户发一部毛泽东电视剧，她看到的是「一个中年男人在桌前讲话」，
 *   因为视觉模型被提示词按着「不猜」，而评论、弹幕里写着的答案她根本拿不到。
 *
 *   评论对「这是谁 / 讲的什么事」的信息量远大于抽帧：
 *   观众会把片名、人名、剧情全写出来，而且文字是 100% 读准的，不会认错脸。
 */
const NO_COMMENTS = argv.includes('--no-comments')
const CMT_N = Math.max(1, Math.min(Number(argOf('--cmt', '8')) || 8, 20))
const ROOT = join(import.meta.dirname, '..')
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
const TIMEOUT_MS = Math.max(5, Math.min(Number(argOf('--timeout', '150')) || 150, 300)) * 1000

/**
 * 从一段可能带杂质（BOM、日志行、进度输出）的 stdout 里抠出 JSON。
 *
 * 🔴 2026-11-01：这个函数是从 `video-oneshot.mjs` 抄评论逻辑时**漏掉的**，
 *    结果 `pickJson is not defined` → 读评论整段抛异常 → 被外层 catch 吞成
 *    `comments_error`，评论永远是 0 条，而且**不报错**。
 *    教训：跨文件抄代码时，先 grep 目标文件里所有被引用的自由函数。
 */
const pickJson = (s) => {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

const out = (o) => {
  process.stdout.write(JSON.stringify(o) + '\n')
}

if (!/^\d{6,}$/.test(AID)) {
  out({ ok: false, error: 'bad_aweme_id', aweme_id: AID })
  process.exit(0)
}

const t0 = Date.now()
let conn = null
try {
  // 🔴 必须用 openIsolatedTab，不能用 openPage：
  //    openPage → connectPage 会挑那个唯一的 `/chat` 页，把它导航到视频页
  //    之后不还原 ⇒ 下一个 group-send / im-send 连上来就找不到会话列表
  //    ⇒ `no-editor-after-open`。2026-10-29 那次一天五次群聊发不出去就是这个坑。
  //    独立标签页只碰自己这一页，用完 dispose() 关掉，别的页一个都不动。
  //
  // 🔴 而且必须直接开 `/video/<id>`，不能开抖音首页：
  //    实测（2026-10-29）新标签页打 `https://www.douyin.com/` 会落到
  //    **「验证码中间页」**（title=验证码中间页，bodyLen=4），此时页内 fetch
  //    详情接口一律 `403 Blocked by ArgusSecurityPlugin Uifid Not Found`。
  //    直接开 `/video/<id>` 则正常出内容（bodyLen≈2965）且详情接口 200 / 66KB。
  //    ⇒ 这一页既是「打开给它看」，也是签名上下文，一步两用。
  //
  // 🔴🔴 2026-11-08 —— 上面那条「开 /video/<id> 就正常」**已经失效**。
  //
  //    实况：36 次抽帧**一次都没成功**，错误码清一色 `look-timeout`，
  //    而真正的原因藏在 `_probe-captcha-state.mjs` 里：
  //
  //        A: 新标签页 /video/7700… 等 8s  → title="验证码中间页" bodyLen=4
  //        B: 新标签页 /video/7700… 等 15s → title="验证码中间页" bodyLen=4
  //        C: 新标签页 首页              → title="验证码中间页" bodyLen=4
  //        D: 回访 /chat                 → 正常（bodyLen=176，会话列表都在）
  //
  //    也就是说：**登录态是好的，被拦的只是"新导航"这个动作**。
  //    抖音对这台机器的会话加了 Argus 风控 —— 只要开新页就送验证码中间页，
  //    而原来那条 `/chat` 页一直活着、一直能用。
  //
  //    于是换成「借壳」：不导航任何页，直接在**已经活着的 `/chat` 页**上下文里
  //    `fetch` 详情接口。`_probe-chatfetch.mjs` 实测这条路：
  //
  //        /aweme/v1/web/aweme/detail/… → status 200，73089 字节真数据
  //        /aweme/v1/web/comment/list/… → status 200，20 条评论正文+r昵称+赞数
  //
  //    注意 `window.webmssdk` 在这条路上是 `undefined` —— **不需要签名器**，
  //    详情接口只认页面身份（cookie + 同源 referer），不校验 mssdk。
  //    视频二进制在页内会跨域失败（`Failed to fetch`），但 `play_addr` 拿得到，
  //    由 Python 侧直下（实测 `206 video/mp4`，文件头 `ftyp` 正确）。
  //
  //    所以顺序改了：**先借 /chat，失败才退回开新页**。开新页那条留着是因为
  //    抖音的风控会变，哪天真能开了就别浪费。
  const { port } = await ensureChrome({ url: 'https://www.douyin.com/chat' })
  let borrowed = ''
  /**
   * ⭐ 2026-11-10：记下「最终用的是借来的页还是新开的页」。
   * 只有借来的 /chat 页需要在收尾时导航回去；新开的页直接关掉就行。
   * 注意 `borrowed` 上面那个变量存的是**失败原因**，别混用。
   */
  let usedBorrowed = false
  conn = await connectPage(port)
  if (!conn || !conn.ev) {
    out({ ok: false, seen: false, error: 'no_cdp_page', aweme_id: AID, ms: Date.now() - t0 })
    process.exit(0)
  }
  // 借来的页必须先确认它还活着 —— 被导航走过、或者已经落到验证码页，就不能借
  {
    const ttl0 = String((await conn.ev('document.title')) || '')
    const href0 = String((await conn.ev('location.href')) || '')
    const len0 = Number((await conn.ev('document.body ? document.body.innerText.length : 0')) || 0)
    if (/验证码|安全验证|captcha/i.test(ttl0) || len0 < 50 || !href0.includes('douyin.com')) {
      borrowed = `home_dead(title=${ttl0.slice(0, 20)},len=${len0})`
      try { conn.close && conn.close() } catch { /* ignore */ }
      conn = null
    }
  }
  if (conn) usedBorrowed = true

  if (!conn) {
    // 借不到就退回老路：开一个新标签页，指望这次没被拦
    conn = await openIsolatedTab(port, `https://www.douyin.com/video/${AID}`)
    if (!conn || !conn.ev) {
      out({ ok: false, seen: false, error: 'no_cdp_page', aweme_id: AID, ms: Date.now() - t0 })
      process.exit(0)
    }
    // 视频页要把 webmssdk 挂上才有签名；实测 6 秒足够，8 秒更稳
    await sleep(8000)

    // 必须在 douyin.com 上，页面签名器才挂在 window 上
    const cur = String((await conn.ev('location.href')) || '')
    if (!cur.includes('douyin.com')) {
      await conn.send('Page.navigate', { url: `https://www.douyin.com/video/${AID}` })
      await sleep(7000)
    }

    // 落到「验证码中间页」时页面里没有签名器，详情接口会 403。提前判掉，别白等 50 秒。
    const ttl = String((await conn.ev('document.title')) || '')
    if (/验证码|安全验证|captcha/i.test(ttl)) {
      out({
        ok: false,
        seen: false,
        aweme_id: AID,
        error: 'captcha_wall',
        note: '没借到活着的 /chat 页，开新标签页又落到验证码中间页 —— '
          + '这台机器的抖音会话被 Argus 风控了。人工开一次浏览器过掉验证码就能恢复。',
        borrowed,
        ms: Date.now() - t0,
      })
      process.exit(0)
    }
  }

  // ── 评论：先读，因为它比抽帧快、而且抽帧失败时它往往是唯一线索 ──────
  const cmts = []
  let commentsError = ''
  if (!NO_COMMENTS) {
    try {
      const cr = spawnSync(
        nodeRunner(),
        [join(ROOT, 'tools', 'comment-read-page.mjs'), '--aweme', AID, '--count', '20', '--pages', '1'],
        /**
         * 超时 25 秒，不是 video-oneshot 那个 60 秒。
         *
         * 原因是预算不一样：oneshot 是后台任务，没人等它；这里是用户
         * 发完视频**当场等回复**，整条链路的预算只有 videoLookBudget=75 秒。
         * 拆开看：
         *   8s   等页面挂签名器
         *   25s  读评论（最坏；正常 3~8 秒就回）
         *   13s  抽帧（实测 300 秒片子 9 帧 12.1 秒 / 16 帧 13.2 秒）
         *   4s   视觉模型
         *   ≈ 50s 最坏，正常 25~30s —— 留足余量。
         *
         * 评论是「锦上添花」，绝不能因为它把整条「看一眼」拖崩。
         * 25 秒还读不出来就当没有，画面和文案本身也有用。
         */
        { encoding: 'utf8', timeout: 25000, env, cwd: ROOT, windowsHide: true }
      )
      const cj = pickJson(String(cr.stdout || ''))
      const raw = (cj && (cj.comments || cj.items)) || []
      const rows = raw
        .map((c) => ({
          text: String(c.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90),
          digg: Number(c.digg || c.digg_count || 0) || 0,
          nick: String(c.nickname || c.nick || '')
            .trim()
            .slice(0, 16),
        }))
        /**
         * 过滤掉「没有信息量」的评论。
         *
         * 🔴 2026-11-01 实测踩到的：`7701329322238149410` 拿到 7 条评论，
         *    全部是 `@小鲸鱼` / `@某某` 这种纯 @ —— 是群友在评论区互相点名，
         *    一个字的内容都没有。这种东西喂给模型只会占位置，
         *    还会让它以为「大家都在叫小鲸鱼」这种无关结论。
         *
         * 判据：
         *   ① 去掉所有 @xxx 之后，剩下的实义字符 >= 4
         *      （`@小鲸鱼` 剥完是空串，`@小王 这歌好听` 剥完还剩 4 个字，留）
         *   ② 必须含中文 —— 纯 emoji / 纯标点 / 纯数字没有理解价值
         *   ③ 排除纯复读标签的（`#话题#` 单独一条）
         */
        .map((c) => ({ ...c, bare: c.text.replace(/@[^\s@]+/g, '').replace(/#[^#]+#/g, '').trim() }))
        .filter((c) => c.bare.length >= 4 && /[\u4e00-\u9fff]/.test(c.bare))
        // 用剥掉 @ 之后的正文喂模型（@ 谁对理解内容没帮助，还占字数）
        .map((c) => ({ ...c, text: c.bare }))
      rows.sort((a, b) => b.digg - a.digg)
      // 置顶 + 热门会把同一条列两次，去个重
      const seenTxt = new Set()
      cmts.push(...rows.filter((c) => (seenTxt.has(c.text) ? false : seenTxt.add(c.text))).slice(0, CMT_N))
    } catch (e) {
      // 读评论失败绝不能让整条「看一眼」失败 —— 画面和文案本身也有用
      commentsError = String((e && e.message) || e).slice(0, 120)
    }
  }

  // 抽帧要下视频 + ffmpeg，慢；超时就只靠元信息
  const v = await Promise.race([
    understandVideoCard(conn, AID, { withVision: !NO_VISION }),
    new Promise((z) => setTimeout(() => z(null), TIMEOUT_MS)),
  ])

  if (!v) {
    out({
      ok: false,
      seen: false,
      error: 'timeout',
      aweme_id: AID,
      // 🔴 2026-11-01：失败分支也必须带 cmts。
      //
      // 原来这三个 out() 都不带评论，等于「画面拿不到 = 整条白跑」。
      // 但恰恰是画面上限最低的时候评论最重要：详情接口被风控拦（no_detail）、
      // 抽帧超时、视频太大下不动 —— 这些情况下画面一个字都拿不到，
      // 而评论里观众照样写着「这是《XXX》第 12 集」「前面那个人是谁啊」。
      // 对「这是谁 / 讲的什么事」来说，评论比画面还可靠，不能跟着一起丢。
      cmts,
      ...(commentsError ? { comments_error: commentsError } : {}),
      ms: Date.now() - t0,
    })
  } else if (!v.ok) {
    out({
      ok: false,
      seen: false,
      aweme_id: AID,
      error: String(v.error || 'look_failed'),
      // 🔴 2026-11-08：抖音自己给的原因。`no_detail` + `status_self_see`
      // 是「作品被作者删了/设成仅自己可见」，跟「我们被风控」不是一回事，
      // 上层要能分开说 —— 前者老实承认「这条没了」，别顺着文案编。
      ...(v.filter_msg ? { filter_msg: String(v.filter_msg) } : {}),
      ...(v.filter_reason ? { filter_reason: String(v.filter_reason) } : {}),
      cmts,
      ...(commentsError ? { comments_error: commentsError } : {}),
      ms: Date.now() - t0,
    })
  } else {
    const d = v.detail || {}
    const dur = Number(d.duration_ms || 0)
    out({
      ok: true,
      aweme_id: AID,
      // ⭐ 2026-11-05：原来只认 scene。现在可能只听到声音、画面没抽出来，
      // 那也算看过了 —— 光有 speech 也算，否则上层会以为她什么都没拿到。
      seen: Boolean(v.scene || v.speech),
      scene: String(v.scene || ''),
      how_seen: String(v.how_seen || ''),
      // ⭐ 2026-11-10：图文作品到底看了几张 / 一共几张。
      // 上层要能用这两项告诉使用者「只看到前 N 张」，不然她会把 3 张当全篇。
      ...(Number(v.images_seen) > 0 ? { images_seen: Number(v.images_seen) } : {}),
      ...(Number(v.images_total) > 0 ? { images_total: Number(v.images_total) } : {}),
      // ⭐ 2026-11-05 新增：视频里说的话（SenseVoice 转写）。
      // 空串 = 没转出来 / 这条没人说话 / 转写不可用，不写这一项。
      ...(v.speech ? { speech: String(v.speech) } : {}),
      ...(v.speech_error ? { speech_error: String(v.speech_error) } : {}),
      // 🔴 2026-11-05：300 → fitDesc（上限 2000，软截断）。
      // 原来这里切 300，是四道截断里的第一道；使用者贴的尼采长文 900+ 字
      // 在这一步就没了一半，后面三道再砍到底只剩 200。改成共用的 fitDesc，
      // 四道用同一个上限，不再各写一个数字。
      desc: fitDesc(v.desc),
      duration_s: dur ? Math.round(dur / 1000) : 0,
      author: String(d.author || d.nickname || '').slice(0, 40),
      is_image_post: Boolean(d.is_image_post),
      // ⭐ 评论：这是理解「这条在讲什么 / 里面是谁」最可靠的一手材料。
      //    观众会把片名、人名、剧情直接写出来，而且是文字，不会认错脸。
      cmts,
      ...(commentsError ? { comments_error: commentsError } : {}),
      ...(v.vision_error ? { vision_error: String(v.vision_error) } : {}),
      ms: Date.now() - t0,
    })
  }
} catch (e) {
  out({
    ok: false,
    seen: false,
    aweme_id: AID,
    error: String((e && e.message) || e).slice(0, 160),
    ms: Date.now() - t0,
  })
} finally {
  /**
   * 🔴 2026-11-10 修：**借来的 /chat 页用完必须还回去**。
   *
   * `look-video` 走的是「先借 /chat，失败才开新页」这条路（见上面 130 行附近）。
   * 借来的那个页在跑的过程中会被 `Page.navigate` 换成 `/video/<id>`，
   * 收尾时原来只做 `conn.close()` —— 而 `close()` 只断 WebSocket，
   * **页面本身还停在视频页**。于是：
   *   · 下一轮 `connectPage()` 挑不到 `/chat`，`dm-auto-reply` 的
   *     `understandVideoCard` 拿到的是一张视频页 ⇒ 详情接口 `bad_json`；
   *   · 更糟的是页面切换会把 CDP Target 换掉，已缓存的 ws 全断，
   *     日志里就是成片的 `CDP WebSocket 已断开，无法发送 Runtime.evaluate`。
   * `card-share.mjs` 早就做了这件事（它 finally 里 `Page.navigate` 回 `_origUrl`），
   * 这里补齐同样的处理。
   */
  try {
    if (conn && usedBorrowed) {
      await conn.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
      await sleep(1200)
    }
  } catch { /* 导航不回去就算了，下一轮 connectPage 会挑别的页 */ }
  try {
    if (conn && typeof conn.dispose === 'function') await conn.dispose()
    else if (conn && typeof conn.close === 'function') conn.close()
  } catch {}
  /**
   * 🔴🔴 2026-11-08：**必须显式 exit**，这是「看不了视频」的第三个根因，
   *    也是最阴的一个 —— 因为脚本自己报告的 `ms` 是对的（10.8 秒），
   *    只有墙钟时间暴露了问题。
   *
   *    实测：
   *        脚本输出 {"seen":true,...,"ms":10819}   ← 10.8 秒就全跑完了
   *        命令 wall time                          ← **175 秒**才返回
   *
   *    差的那 164 秒全花在「node 不肯退出」上：`conn.close()` 关掉了 WebSocket
   *    的 message 监听，但底层 TCP socket / 定时器没有被彻底解除，
   *    事件循环里始终有活着的 handle ⇒ 进程挂着。
   *
   *    调用方（`xj_douyin._look_video_sync`）用的是
   *    `subprocess.run(..., timeout=videoLookBudget)` —— 它等的是**进程退出**，
   *    不是等 JSON 写到 stdout。所以：
   *        配 75 秒  → 75 秒时 kill ⇒ `look-timeout`，JSON 明明已经在管道里了
   *        配 180 秒 → 175 秒才拿到，但 `_tick` 只给 55 秒、外层 wait_for 只给 90 秒
   *    ⇒ **不管预算配多大都拿不到**。这就是为什么改成 180 之后仍然失败。
   *
   *    修法：JSON 已经 process.stdout.write 过了，直接 exit(0)，
   *    不等 GC、不等 socket 自然关闭。`out()` 是同步写，数据已经进管道。
   */
  process.exit(0)
}
