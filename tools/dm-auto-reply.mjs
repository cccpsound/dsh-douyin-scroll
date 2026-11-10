#!/usr/bin/env node
/**
 * tools/dm-auto-reply.mjs —— 盯私信，按规则自动回
 * ============================================================================
 * 使用者原话（2026-10-25）：「私聊已读不回呢」→ 要求私信也能自己回。
 *
 * 与 at-me-watch.mjs 的关系：
 *   · at-me-watch 盯**评论区 @**（notice-read.py 读 type 45/46）→ comment-api.mjs 回
 *   · 这个脚本盯**私信**（im-http.py 只读）→ im-send.mjs 回
 *   两个脚本的规则哲学一致：**规则写死，不靠模型临场发挥** ——
 *   这是拿使用者账号对外说话，宁可回得朴素，也不能乱说。
 *
 * ── 规则（写死）──────────────────────────────────────────────────
 * ① 只回 `--peer` 指定的这一个人（配置里的 dmToId），不在会话列表里乱撒
 * ② **特殊称呼只属于号主** —— 只有 `--owner-uid` 那个人能用；别人一律剔掉
 * ③ 每条 ≤100 字，不带链接、不带内部术语
 * ④ **同一条消息最多回 1 次**（按对方消息的 `at` 时间戳去重）
 * ⑤ **对方每说一句就回一句**（2026-10-25 使用者要求；原规则是「一轮只回最后一条」）。
 *    保留一条护栏：同一轮里连着两条会得到**完全相同**的回复时，第二条跳过
 *    （否则连发四五句一样的话，真变刷屏）。
 * ⑥ 每隔 `--every` 秒查一次（默认 90；当前配置用 30）
 * ⑦ 使唤式/引战/要隐私/要钱的 —— 不回（记日志）
 * ⑧ **`--max` 每天上限：0 = 不设上限**（当前配置用 0）
 * ⑨ **`--quiet` 夜间静默：空串 = 不静默，24 小时都回**（当前配置用空串）
 * ⑩ 首拍只「对表」：把当前已存在的历史**逐条**标成 skip:history，不重播
 *
 * 用法:
 *   node tools/dm-auto-reply.mjs --peer <sec_uid|uid> --owner-uid <号主uid> \
 *        [--max 0] [--every 30] [--quiet ""] [--dry] [--once]
 *   --max 0     不设每天上限
 *   --quiet ""  不静默（传空串记得加引号）
 *
 * 输出：每轮一行 JSON 到 stdout（方便外面留档）
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { nodeRunner } from '../lib/quiet.mjs'
/**
 * ⭐ 真模型说话（2026-10-25 使用者要求「能不能给她接入ai模型?」，并指定用
 *    workbuddy 的 deepseek-v4.1-flash）。
 *
 * 为什么不再全靠 craft()：那一套是写死的模板，同一个意思换句话它就接不住，
 * 根本原因是**它没在思考**。模型负责「说什么」，craft() 退居二线做兜底 ——
 * 模型超时/报错/被规则判为不可发时回落，行为不会比以前更差。
 */
import { sayWithModel } from '../lib/persona-llm.mjs'
/**
 * ⭐ 2026-10-27 加：记忆双向打通（使用者「A+B」）。
 *   A = 把抖音私信按天压成摘要推进 AstrBot 的 LivingMemory（pushDmToLivingMemory）
 *   B = 把看过的作品内容落成本地 videos[] + 推一条 QQ 侧可见的记忆（addVideoMemory / pushVideoMemo）
 * 两个模块都永不 throw（内部全 try），失败只返回 {ok:false}，不影响回消息。
 */
import { addVideoMemory, mergeDmMemory, noteSent, dmContext } from '../lib/memory.mjs'
import { pushDmToLivingMemory, pushVideoMemo } from '../lib/memory-push.mjs'

/**
 * ⭐ 2026-10-25 使用者问「她回复不了视频吗」—— 以前确实不行：
 * 卡片只会被转成「（对方发来一个视频，标题是「…」）」，模型知道**有**视频、
 * 但**看不见画面**，所以只能回「收到」「这个我看了」这类空话。
 *
 * 现在遇到卡片先做一次「看一眼」：
 *   页面内 fetch 详情（拿文案/时长/作者/数据/封面）→ 下载封面 → 视觉模型描述画面
 *   → 把画面内容拼进给模型的 prompt。
 *
 * 为什么懒加载 + 加超时：这是常驻子进程，每 30 秒 tick 一次；
 * 大多数轮次根本没有卡片，不能为了它去连 Chrome。而且 Chrome 没开、
 * 页面卡死、模型超时都不能拖住主循环 —— 拿不到就老老实实退回
 * 「没看到画面，别猜内容」，绝不编。
 */
const VIDEO_ON = String(process.env.DOUYIN_VIDEO_OFF || '') !== '1'
let _conn = null
let _connTried = 0

/**
 * 🔴 2026-11-10 修：**缓存的连接断了必须丢，不能一直拿死连接去发**。
 *
 * 原来这里只有 `if (_conn) return _conn` —— 一旦 `connectPage()` 成功一次，
 * 这个 conn 就永久缓存。可 CDP 的 ws 会因为下面任意一件事断掉：
 *   · `card-share.mjs` / `comment-*` 把那个页面导航去了 `/video/<id>`；
 *   · 页面自己跳验证码、或者 Target 被浏览器替换；
 *   · Chrome 重启过。
 * ws 一断，`lib/chrome.mjs` 里 `flushPend()` 会把 `closed` 置 true，之后每次
 * `send()` 都立刻抛 `CDP WebSocket 已断开，无法发送 Runtime.evaluate`。
 * 但 `_conn` 还是那个死对象 ⇒ 每一轮 tick 都失败，**永远不重连**，直到进程
 * 重启为止。日志实证（2026-11-10 07:51→08:27 连续 7 次）：
 *   `{"tick":"video_fail","error":"Error: CDP WebSocket 已断开，无法发送 Runtime.evaluate"}`
 * 现象就是「能读字、但再也看不见画面」。
 *
 * 现在改成：调 `isAlive()` 探一下，死了就 close 掉、把缓存清空、立刻重连
 * （下次调用时 `_connTried` 已被重置，不会被困在 5 分钟冷却里）。
 */
const CONN_RETRY_MS = 15_000

const sleep2 = (ms) => new Promise((z) => setTimeout(z, ms))

function dropConn(why) {
  if (_conn) {
    try { _conn.close && _conn.close() } catch { /* 已经断了 */ }
  }
  _conn = null
  _connTried = 0          // 关键：清掉冷却，允许立刻重连
  if (why) log({ tick: 'conn_drop', why: String(why).slice(0, 100) })
}

async function connAlive(c) {
  if (!c || !c.send) return false
  try {
    // 用一个极廉价、不依赖页面状态的 CDP 方法探活。
    // 死连接的 send() 会立刻 reject（flushPend 已经把 closed 置 true）。
    await Promise.race([
      c.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 4000),
      sleep2(5000).then(() => { throw new Error('probe_timeout') }),
    ])
    return true
  } catch {
    return false
  }
}

async function getConn() {
  if (_conn) {
    if (await connAlive(_conn)) return _conn
    dropConn('缓存连接已失效（探活失败）')
  }
  const now = Date.now()
  // 连不上就 15 秒内不再试。原来是 5 分钟 —— 太长：Chrome 起来得很快，
  // 一次失败罚 5 分钟，等于整个窗口期都瞎了。
  if (_connTried && now - _connTried < CONN_RETRY_MS) return null
  try {
    const { pickPort, connectPage } = await import('../lib/chrome.mjs')
    const port = await pickPort()
    if (!port) { _connTried = now; return null }
    _conn = await connectPage(port)
    _connTried = 0
    return _conn
  } catch (e) {
    _connTried = now
    log({ tick: 'video_conn_fail', error: String(e.message || e).slice(0, 80) })
    return null
  }
}

/**
 * 拿到「这视频在讲什么」。任何一步失败都返回 null（调用方按「没看过」处理）。
 * 硬超时 25 秒：详情 0.3s + 封面 0.1s + 视觉 2.6s，留足余量还不至于拖住 tick。
 */
const sleep = (ms) => new Promise((z) => setTimeout(z, ms))

/**
 * 表情包：直接拿 url 当图喂给视觉模型，让她"看得见"你发的是只狗还是一张无语脸。
 * 为什么不复用 understandVideoCard：那个要先查 aweme detail（表情包没有 aweme_id）。
 * 失败一律返回 null，调用方按「看到了个表情但没看清」处理。
 */
async function lookAtEmoji(card) {
  const url = String(card?.url || '').trim()
  if (!VIDEO_ON || !/^https?:\/\//.test(url)) return null
  try {
    const { fetchImageAsDataUri } = await import('../lib/video-understand.mjs')
    const { describeImage } = await import('../lib/video-card.mjs')
    // ⚠️ fetchImageAsDataUri 返回 {ok, dataUri, bytes, mime}，不是字符串。
    //    直接把对象传给 describeImage 会让 data URI 变成 "[object Object]" → 视觉端 502
    //    （实测报错 "[workbuddy 11101] Parse message fail"）。必须取 .dataUri。
    const fres = await Promise.race([
      fetchImageAsDataUri(url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 12_000 }),
      sleep(13_000).then(() => null),
    ])
    if (!fres || !fres.ok || !fres.dataUri) {
      log({ tick: 'emoji_nofetch', error: String(fres?.error || 'timeout').slice(0, 60) })
      return null
    }
    const v = await Promise.race([
      describeImage(fres.dataUri, { timeoutMs: 30_000, maxTokens: 100 }),
      sleep(31_000).then(() => null),
    ])
    // ⚠️ describeImage 返回 {ok, text, ms}，不是字符串 —— 直接当字符串用会得到 "[object Object]"。
    const scene = String(v?.ok ? v.text : '').trim()
    if (!scene) { log({ tick: 'emoji_novision', error: String(v?.error || '').slice(0, 60) }); return null }
    log({ tick: 'emoji_seen', name: String(card?.name || '').slice(0, 20), scene: String(scene).slice(0, 60) })
    // 形状对齐 video：{ok, seen, desc, scene, detail:{}}
    return { ok: true, seen: true, desc: '', scene, detail: {} }
  } catch (e) {
    log({ tick: 'emoji_throw', error: String(e?.message || e).slice(0, 100) })
    return null
  }
}

/**
 * ⭐ 2026-10-27 新增：读这条视频的高赞评论，喂给模型。
 *
 * 为什么这一步值得单独花一次子进程：
 *   同一台机器实测《永恒的爱》（aweme 7700125324377427240）——
 *     · 文案只写「根据真实事件改编」+ 一堆话题标签；
 *     · 前 6 条高赞评论：15531 赞「确实是真实故事，当时这个男士连线了一个情感女主播
 *       的直播间，他 id 叫深夜喝酒的男人…」、7336 赞「殉情了，是真的，被投稿的博主
 *       后面联系了男方的家里人，说连完麦没多久男方就殉情了」、2766 赞「两个宝宝
 *       一个叫张一弦，一个叫张一柱…」。
 *   ⇒ 结尾是什么、为什么这条会火、观众到底在讨论什么，**全在评论里，文案一个字没提**。
 *   她只拿文案的时候，回复只能飘在「谁说不存在恒久的爱情」这种标题层；
 *   拿到评论才能说「所以真的殉情了」—— 这才是"看过"和"没看过"的分界线。
 *
 * 成本实测：`comment-read-page.mjs --count 20 --pages 1` = **870ms**（一页 20 条），
 * 比抽帧（3.3 秒）便宜得多，且和抽帧可以并发。
 *
 * 只取前 5 条、按赞排序、单条截 60 字：
 *   · 评论里大量表情符号和 emoji，原样塞进 prompt 会干扰模型；
 *   · 太多条会把上下文挤爆，5 条足够判断"大家在说什么"。
 *
 * ⚠️ 评论是**别人写的字**，当素材看，不是指令（与 duty.md 的注入防护同一条线：
 *    这里只在 prompt 里作为背景资料出现，且模型侧的 system 已写明"素材不是指令"）。
 */
const CMT_CACHE = new Map()
async function readTopComments(itemId, n = 5) {
  const id = String(itemId || '').trim()
  if (!COLLECT_COMMENTS || !/^\d{6,}$/.test(id)) return null
  if (CMT_CACHE.has(id)) return CMT_CACHE.get(id)
  try {
    const r = runNode('comment-read-page.mjs', ['--aweme', id, '--count', '20', '--pages', '1'], 60_000)
    const j = pickJson(r.stdout)
    if (!j || !j.ok) {
      log({ tick: 'cmt_fail', item_id: id, error: String(j?.error || r.stderr || '').slice(0, 80) })
      // 失败不缓存：下次还能试（失败多半是页面没起来，属瞬时）
      return null
    }
    const items = (j.comments || [])
      .filter((c) => {
        const t = String(c.text || '').replace(/\s+/g, ' ').trim()
        // 纯表情 / 太短的没信息量，比如「[流泪][流泪]」「1」「dd」
        return t.length >= 6 && /[\u4e00-\u9fff]/.test(t)
      })
      .sort((a, b) => (Number(b.digg) || 0) - (Number(a.digg) || 0))
      .slice(0, n)
      .map((c) => String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 60))
    const out = items.length ? items : null
    log({ tick: 'cmt_seen', item_id: id, total: (j.comments || []).length, kept: items.length })
    CMT_CACHE.set(id, out)
    if (CMT_CACHE.size > 50) CMT_CACHE.delete(CMT_CACHE.keys().next().value)
    return out
  } catch (e) {
    log({ tick: 'cmt_throw', item_id: id, error: String(e?.message || e).slice(0, 80) })
    return null
  }
}

/**
 * ⭐ 2026-11-10 新增：**对方直接发来的图片 / 动图**（aweType 2702 / 2703）。
 *
 * 🔴 为什么必须单独一个函数：`lookAtVideo` 第一行是
 *     `const id = String(card?.item_id || '').trim(); if (!/^\d{6,}$/.test(id)) return null`
 *   而 2702/2703 的 card **只有 url，没有 item_id**（im-http.py 那个分支只填
 *   kind/url/w/h/size/md5）。于是它立刻返回 null ⇒ 她只拿到 `text="[图片]"`，
 *   prompt 里一个字的画面信息都没有。使用者「发了个图文她没读明白」，
 *   如果那条是截屏/切图私发，走的就是这条路 —— 她压根没看。
 *
 * 提示词为什么这么长：默认那句是「用一两句话（40 字以内）说这张图里在发生什么」，
 *   **不读字**。私发的图十有八九是截图：聊天记录、网页、报错、备忘录、二维码。
 *   不读字等于没看。所以这里要求先逐字抄文字，再描述画面。
 *
 * GIF（2703）同样走这里：只描述静态一帧就够她接话，不抽帧。
 */
async function lookAtPhoto(card) {
  const url = String(card?.url || '').trim()
  if (!VIDEO_ON || !/^https?:\/\//.test(url)) return null
  const isGif = String(card?.kind || '') === 'gif'
  // 抖音私信图床给的是 AES-256-GCM 密文，密钥在 card.skey 里（im-http.py 带出来的）
  const skey = String(card?.skey || '').trim()
  try {
    const { fetchImageAsDataUri } = await import('../lib/video-understand.mjs')
    const { describeImage } = await import('../lib/video-card.mjs')
    // GIF 可能偏大，给 8MB；静态图 6MB 足够（原图 1052x1324 也就 200KB 级）
    const fres = await Promise.race([
      fetchImageAsDataUri(url, { maxBytes: isGif ? 8 * 1024 * 1024 : 6 * 1024 * 1024, timeoutMs: 15_000, skey }),
      sleep(16_000).then(() => null),
    ])
    if (!fres || !fres.ok || !fres.dataUri) {
      log({ tick: 'photo_nofetch', error: String(fres?.error || 'timeout').slice(0, 60), skey: skey ? 1 : 0 })
      return null
    }
    const prompt = [
      isGif ? '这是一张对方发来的动图（只有一帧可看）。' : '这是对方直接发来的一张图片。',
      '请按下面顺序说，不要跳步：',
      '① 把图里能看清的文字**尽量逐字抄下来**（正文、对话、按钮、标题、数字、水印都算）。',
      '   文字往往就是这张图想说的内容，抄的时候不要总结、不要改写成通顺句子。',
      '② 再说这张图是什么：照片 / 手机截图 / 聊天记录 / 表情图 / 长图 / 纯文字卡片 / 表格。',
      '③ 最后用一两句话说清画面里有什么（谁、在哪、在做什么）。',
      '抄不出文字就说「图里没有可读的文字」，绝对不要编。总长度 300 字以内，文字多可以更长。',
    ].join('\n')
    const v = await Promise.race([
      describeImage(fres.dataUri, { timeoutMs: 45_000, maxTokens: 900, prompt }),
      sleep(46_000).then(() => null),
    ])
    const scene = String(v?.ok ? v.text : '').trim()
    if (!scene) { log({ tick: 'photo_novision', error: String(v?.error || '').slice(0, 60) }); return null }
    log({ tick: 'photo_seen', kind: String(card?.kind || ''), scene: String(scene).slice(0, 80) })
    // 形状对齐 video：{ok, seen, desc, scene, detail}
    return { ok: true, seen: true, desc: '', scene, detail: {}, how_seen: isGif ? 'gif' : 'image' }
  } catch (e) {
    log({ tick: 'photo_throw', error: String(e?.message || e).slice(0, 100) })
    return null
  }
}

async function lookAtVideo(card) {
  const id = String(card?.item_id || '').trim()
  if (!VIDEO_ON || !/^\d{6,}$/.test(id)) return null
  try {
    const conn = await getConn()
    if (!conn) return null
    const { understandVideoCard } = await import('../lib/video-card.mjs')
    /**
     * 抽帧理解（最慢，要下整段 + 跑 ffmpeg）和读评论（870ms）**并发**：
     * 两者互不依赖，串行白白多等近一秒。总耗时仍由 25 秒那个 race 兜住。
     */
    const [r, cmts] = await Promise.all([
      Promise.race([understandVideoCard(conn, id), sleep(25_000).then(() => null)]),
      readTopComments(id),
    ])
    if (!r) { log({ tick: 'video_timeout', item_id: id }); return null }
    if (!r.ok) {
      log({ tick: 'video_fail', item_id: id, error: r.error || '' })
      /**
       * 🔴 连接类失败要立刻把缓存丢掉，别等探活。
       * `understandVideoCard` 内部把 CDP 错误原样带在 `r.error` 里，
       * 这里认出来就重连 —— 否则 25 秒 race 一旦先到点，后面几轮还会
       * 拿着同一个死连接继续失败。
       */
      if (/CDP WebSocket|disconnected|Target closed|无法发送/i.test(String(r.error || ''))) {
        dropConn('video_fail: ' + String(r.error || '').slice(0, 60))
      }
      return null
    }
    log({
      tick: 'video_seen',
      item_id: id,
      seen: r.seen,
      // how: frames:N(colsxrows) = 真看了整段抽帧；cover = 只看了封面；images:N = 图集
      how: r.how_seen || '',
      scene: String(r.scene || '').slice(0, 60),
      desc: String(r.desc || '').slice(0, 60),
      ...(cmts ? { cmt_n: cmts.length, cmt_top: cmts[0].slice(0, 40) } : {}),
      ...(r.vision_error ? { vision_error: r.vision_error } : {}),
    })
    return { ...r, comments: cmts }
  } catch (e) {
    const msg = String(e.message || e)
    log({ tick: 'video_throw', item_id: id, error: msg.slice(0, 100) })
    if (/CDP WebSocket|disconnected|Target closed|无法发送/i.test(msg)) {
      dropConn('video_throw: ' + msg.slice(0, 60))
    }
    return null
  }
}


/**
 * 特殊称呼（默认「主人」）。**只有号主能用** —— 别处一律禁。
 */
const HONORIFIC = String(process.env.DOUYIN_HONORIFIC || '主人').trim() || '主人'

/** 几条按情景选的短回复（都可被环境变量覆盖，风格：短、口语、不客服腔） */
const REPLY_GREET = process.env.DOUYIN_DM_GREET || '{HO}我在呢～'
const REPLY_QUESTION = process.env.DOUYIN_DM_QUESTION || '这个我得想想，想好了跟你说'
const REPLY_LAUGH = process.env.DOUYIN_DM_LAUGH || '哈哈哈这条我看笑了'
const REPLY_ASK = process.env.DOUYIN_DM_ASK || '真的假的，我怎么不太信'
const REPLY_MEDIA = process.env.DOUYIN_DM_MEDIA || '收到～ 我看了'
const REPLY_FALLBACK = process.env.DOUYIN_DM_FALLBACK || '嗯嗯，看到了'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const ONCE = argv.includes('--once')
const PEER = String(argOf('--peer', '') || process.env.DOUYIN_DM_PEER || '').trim()
const OWNER_UID = String(argOf('--owner-uid', '') || process.env.DOUYIN_OWNER_UID || '').trim()
/**
 * 每天上限。0 = 不设上限（2026-10-25 使用者要求「每天无上限」）。
 * 非零时夹在 1~999 之间 —— 上限本来就是为了防止刷屏失控，
 * 真需要无限制就直接传 0，别用一个大数字假装无限制。
 */
const MAX_RAW = Number(argOf('--max', '3'))
const MAX = MAX_RAW === 0 ? 0 : Math.max(1, Math.min(MAX_RAW || 3, 999))
const EVERY = Math.max(30, Number(argOf('--every', '90')) || 90) * 1000
/**
 * 夜间静默时段。传空串 '' = 不静默，24 小时都回（2026-10-25 使用者要求）。
 * inQuiet('') 里 parts.length !== 2 直接返回 false，天然支持关掉。
 */
const QUIET = String(argOf('--quiet', '01:00-08:00')).trim()
/**
 * 首拍对表时「多久以内的算新消息、要回」。
 * 默认 120 分钟：既能接住「刚发来正在等我回」的，又不会一上线把几个月的历史全回一遍。
 * 传 --prime-fresh 0 = 一律当历史（老行为）；传很大的值 = 一律当新消息。
 */
const PRIME_FRESH_MS = Math.max(0, Number(argOf('--prime-fresh', '120')) || 0) * 60 * 1000

/**
 * ⭐ 2026-10-26 使用者问「为什么抖音里的小鲸鱼不会发我发视频?」
 *
 * 根因：这条链路以前**只会打字**。`sendDm()` 只调 `im-send.mjs --text`，
 * 而 `im-send.mjs` 唯一的发送动作是 `Input.insertText`（纯文字）。
 * 抖音的分享卡片（aweType 800）是前端把结构化消息交给服务端生成的，
 * 纯文本 + URL 永远做不出卡片，而且文本链接在抖音里点不开。
 *
 * 发卡片的能力其实**早就有了** —— `card-share.mjs`（DSH 侧 `douyin_share_card`
 * 用的就是它）。这里把那条路接进来自动发，参数：
 *   --video 0            关掉（默认开）
 *   --video-every 1800   两条视频之间至少隔多少秒（防刷屏，默认 30 分钟）
 *   --video-max 3        每天最多发几条（0 = 不限）
 *   --video-reply 0.35   对方**发了视频**时，跟着回一条视频的概率
 *   --video-idle 0.05    对方只是说话、但很久没发过视频时的主动分享概率
 */
const VIDEO_ENABLED = String(argOf('--video', '1')).trim() !== '0'
const VIDEO_EVERY_MS = Math.max(300, Number(argOf('--video-every', '1800')) || 1800) * 1000
const VIDEO_MAX_RAW = Number(argOf('--video-max', '3'))
const VIDEO_MAX = VIDEO_MAX_RAW === 0 ? 0 : Math.max(0, Math.min(VIDEO_MAX_RAW || 3, 20))
const VIDEO_REPLY_CHANCE = Math.max(0, Math.min(Number(argOf('--video-reply', '0.35')) || 0, 1))
const VIDEO_IDLE_CHANCE = Math.max(0, Math.min(Number(argOf('--video-idle', '0.05')) || 0, 1))
/**
 * 读不读视频的高赞评论。
 *
 * 默认开 —— 这是「她到底看没看过这条片子」的分水岭（见 readTopComments 注释里的实测）。
 * 留 `--no-comments` / `DOUYIN_DM_COMMENTS_OFF=1` 两个关掉的口子，
 * 因为读评论要起一次子进程（870ms）；账号被限流、或者只想压延迟时可以关。
 */
const COLLECT_COMMENTS = String(process.env.DOUYIN_DM_COMMENTS_OFF || '') !== '1'
  && !argv.includes('--no-comments')

const HOME = (() => {
  const e = String(process.env.DOUYIN_HOME || '').trim()
  if (e) return e
  const dshHome = String(process.env.DSH_HOME || '').trim()
  return join(dshHome || join(homedir(), '.dsh'), 'douyin-duty')
})()

const ROOT = join(import.meta.dirname, '..')
const py = () => {
  const v = join(HOME, '.venv', process.platform === 'win32' ? 'Scripts/pythonw.exe' : 'bin/python')
  return existsSync(v) ? v : (process.platform === 'win32' ? 'python' : 'python3')
}
const envOf = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_HOME: HOME })

const runPy = (script, args, timeout = 90_000) => {
  const r = spawnSync(py(), [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: envOf(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
const runNode = (script, args, timeout = 300_000) => {
  const r = spawnSync(nodeRunner(), [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: envOf(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

const pickJson = (s) => {
  const t = String(s || '')
  const i = t.indexOf('{'); const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

const stateFile = join(HOME, 'dm-auto-reply.json')
const loadState = () => {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'))
    s.repliedAt ||= {}          // { "<对方消息的 at>": "回复时间" } —— 同一条只回一次
    s.count = Number(s.count) || 0
    s.day = String(s.day || '')
    s.videoSent ||= {}          // { "<aweme_id>": "发送时间" } —— 同一个视频不重复发
    s.videoCount = Number(s.videoCount) || 0
    s.videoLastAt = Number(s.videoLastAt) || 0
    return s
  } catch {
    return { repliedAt: {}, count: 0, day: '', videoSent: {}, videoCount: 0, videoLastAt: 0 }
  }
}
const saveState = (s) => {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8')
  } catch { /* 记不上不影响 */ }
}

const beijingKey = () => {
  const d = new Date(Date.now() + 8 * 3600_000)
  return d.toISOString().slice(0, 10)
}
/** 北京时间的 HH:MM */
const bjHHMM = () => {
  const d = new Date(Date.now() + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  return m ? (Number(m[1]) * 60 + Number(m[2])) : null
}
/** 夜间静默：支持跨零点（如 01:00-08:00） */
const inQuiet = (spec) => {
  const parts = String(spec || '').split('-')
  if (parts.length !== 2) return false
  const a = toMin(parts[0]); const b = toMin(parts[1])
  if (a === null || b === null || a === b) return false
  const now = toMin(bjHHMM())
  if (now === null) return false
  return a < b ? (now >= a && now < b) : (now >= a || now < b)
}

/**
 * 🔴 硬拦「把特殊称呼用在别人身上」。
 * 除了号主本人，任何回复里出现那个称呼一律剔掉（跟 at-me-watch 同一套）。
 */
const sanitize = (text, isOwner) => {
  let t = String(text || '').trim()
  if (!isOwner) {
    t = t.replace(new RegExp(HONORIFIC + '[，,、:：!！?？\\s]*', 'g'), '')
    t = t.replace(new RegExp(HONORIFIC, 'g'), '')
    t = t.replace(/^\s*[，,、:：]+/, '').trim()
  }
  // 链接一律不带（私信里点不开，而且泄露里外信息）
  t = t.replace(/https?:\/\/\S+/g, '').trim()
  return t.slice(0, 100)
}

/**
 * 🔴 拦「复读对方原话」。
 *
 * 实测（2026-10-25 接模型后第一轮）：对方说「你好呀」，模型直接回「你好呀」——
 * 语法上是合法回复，但人看着就是「它没听懂，只是把我的话丢回来」。
 * prompt 里写了「不复述对方的话」，模型照样会犯（短句尤其容易），
 * 所以必须有个程序化的兜底判据。
 *
 * 判据：把两边的标点/空白/语气词都去掉后，
 *   · 完全相等 → 复读
 *   · 回复是原话的子串（去掉招呼词后长度 ≥2）→ 复读
 * 命中就返回 true，调用方改走模板。
 */
const isEcho = (reply, original) => {
  const strip = (s) => String(s || '').replace(/[\s，,。.！!？?~～、:：；;"'"'']/g, '').trim()
  const RE_GREET = /^(在吗|在不在|你好|您好|嗨|hi|hello|哈喽|早|晚安)/i
  const norm = (s) => strip(s).replace(RE_GREET, '').trim()

  const rawA = strip(reply)
  const rawB = strip(original)
  if (!rawA || !rawB) return false

  /**
   * ⭐ 纯招呼词单独判。
   *
   * 对方说「你好呀」、模型回「你好」—— 剥掉招呼词后两边都成了空串，
   * 按下面的逻辑会提前 `!a` 返回 false（漏判）。所以先把「回复本身就是一句招呼」
   * 这种情况挑出来：只要原话也是招呼，就是复读。
   */
  const aIsBare = !norm(rawA) && RE_GREET.test(rawA)
  const bIsGreet = RE_GREET.test(rawB)
  if (aIsBare && bIsGreet) return true

  const a = norm(rawA)
  const b = norm(rawB)
  if (!a || !b) return false
  if (a === b) return true
  // 「你好呀」vs「你好呀」已经被上面拦住；这里管「回复是原话一小段」的情况
  if (b.length >= 2 && a.length >= 2 && b.includes(a)) return true
  return false
}

/** 该不该回：使唤式 / 引战 / 要隐私 / 要钱 —— 一律不回 */
const shouldSkip = (text) => {
  const t = String(text || '')
  if (!t.trim()) return 'empty'
  if (/(微信|加个|私我|资源|网盘|代刷|点赞|关注一下|转发一下|给我刷|扫码|投资|转账|借钱)/.test(t)) return 'solicit'
  if (/(政治|宗教|地域|女拳|南拳|颜色革命)/.test(t)) return 'sensitive'
  if (/(密码|身份证|银行卡|家庭住址|手机号|住在哪)/.test(t)) return 'privacy'
  return ''
}

/** 按对方说的内容挑一句（短、口语） */
/**
 * 按对方这句话的内容挑一句回复。
 *
 * ⭐ 2026-10-25 修：原来第一行是 `if (isOwner) return REPLY_GREET` —— 号主说啥都回
 *    同一句「主人我在呢～」。原来「一轮只回最后一条」时看不出来，改成「每条都回」
 *    之后，连发三句会得到三遍一模一样的话，被 same_as_prev 全拦掉，看着像没生效。
 *
 *    现在号主也走内容分支，只是**称呼不同**（带 {HO}）。判断顺序是从具体到笼统：
 *    问句 > 笑 > 求证 > 媒体 > 纯招呼 > 兜底。
 */
/**
 * 从对方这句话里摘一段可以复述的片段（不引入任何新信息）。
 *
 * 为什么需要：模板只有 6 个，对方换种说法就撞兜底。「每条都回」之后，
 * 连发三句不同的话会收到三遍「嗯嗯，看到了」—— 规则写死的目的是不乱说，
 * 不是把同样的话说三遍。摘对方自己的字复述回去，既不编内容，也天然不重样。
 *
 * 只做很保守的清洗：去掉链接、@、话题标签、过多空白、成串标点。
 * 摘不出来（比如整句都是表情/标点）就返回空串，调用方退回纯模板。
 */
const echoOf = (text) => {
  let t = String(text || '')
  t = t.replace(/https?:\/\/\S+/g, ' ')        // 链接不念
  t = t.replace(/@[\w\u4e00-\u9fa5]+/g, ' ')     // @某人 不念
  t = t.replace(/#([^#\s]{1,20})#?/g, '$1')      // 话题标签留文字去掉井号
  t = t.replace(/\[.{1,12}?\]/g, ' ')            // [表情] 这类占位
  t = t.replace(/[\s\u3000]+/g, ' ').trim()
  t = t.replace(/^[，,。.、；;：:！!？?\-—~～]+/, '').replace(/[，,。.、；;：:]+$/, '')
  if (!t) return ''
  /**
   * 太长就取一段，**优先在分隔符处切**。
   * 早期版本直接 slice(-12) 会把词切断（"《time machine》纯钢琴完整版 #钢"
   * 被切成 "ine》纯钢琴完整版 钢"，尾巴那个孤零零的「钢」很难看）。
   * 现在按「空格/标点」把整句切块，从后往前拼到 14 字左右，凑不够就退回整块。
   */
  if (t.length > 14) {
    const parts = t.split(/[\s，,、；;：:·—~～]+/).filter(Boolean)
    if (parts.length > 1) {
      // 从最后一块往前拼，凑满 ≥4 字就停
      let acc = ''
      for (let i = parts.length - 1; i >= 0; i--) {
        const next = parts[i] + (acc ? ' ' + acc : '')
        if (next.length > 14 && acc) break
        acc = next
        if (acc.length >= 4) break
      }
      t = acc || parts[parts.length - 1]
    }
    // 仍是超长块（没有分隔符），硬截但要落在汉字边界上
    if (t.length > 14) t = t.slice(-14)
  }
  // 太短（一个字）复述出来很傻，宁可不摘
  if (t.length < 3) return ''
  return t.slice(0, 14)
}

/**
 * 带回声的兜底：分两档，按原话长短挑。
 *   · 对方说了事（≥6 字）→ 先复述一截，再给一句短反应
 *   · 对方就几个字     → 只给短反应（复述两个字反而怪）
 */
/**
 * 摘不出回声时的兜底（同样按原话 hash 选，保证可复现）。
 * 这几句都只说「收到了」，不猜对方意思 —— 规则写死的前提是不乱说。
 */
const REPLY_PLAIN_TEMPLATES = [
  '嗯嗯，看到了',
  '收到～',
  '这个我看到了',
  '行，知道了',
]

const REPLY_ECHO_TEMPLATES = [
  '{X} —— 这个我记下了',
  '「{X}」是这么回事啊',
  '{X}，嗯，我听到了',
  '{X} 这个我回头想想',
]

/**
 * 视频/图文卡片的回应模板。
 *
 * ⭐ 2026-10-25 新增。以前 card 消息只当普通文字处理 —— 对方发个视频过来，
 *    我们手上只有一串「标题 + #话题标签」，复述出去就是「「《time machine》纯钢琴
 *    完整版 #钢琴 #timemachine」是这么回事啊」，等于把标签念一遍，比不回还怪。
 *
 * 现在带 card 走这里：不猜视频内容（看不到画面就不硬编），只对「收到一个视频」这件事回应。
 * 从标题里能摘出**人话**（不是纯标签）时，顺带提一句，证明真点开看过。
 */
/**
 * 🔴 2026-11-10：模板里的「视频」改成占位符 `{N}`。
 *
 * 事故：对方直接私发一张截图过来（`card.kind === 'image'`），视觉那条路
 * 万一没跑通（额度 429 / 图床 403 / 图片太大），就落到这里兜底，
 * 而模板写死「这个视频我点开看了」—— 对方发的是图，她说看了个视频，
 * 一眼就露馅。`{N}` 由 `cardWord(card)` 按 kind 填「图片 / 动图 / 视频」。
 */
const REPLY_CARD_TEMPLATES = [
  '这个{N}我点开看了，{X}',
  '收到{N}～{X}',
  '{X}，我看完了',
  '这个我看了，{X}',
]
const REPLY_CARD_PLAIN = [
  '这个{N}我点开看了',
  '看到{N}了，我记着',
  '收到，{N}我看了',
  '这个我看过了',
]

/**
 * 卡片到底叫「图片」「动图」还是「视频」。
 * 依据是 `tools/im-http.py` 打给 card 的 kind：2702 → image、2703 → gif，
 * 转发来的视频/图集卡片没有这个字段（或叫 card），一律当视频。
 */
const cardWord = (card) => {
  const k = String(card?.kind || '').toLowerCase()
  if (k === 'image') return '图片'
  if (k === 'gif') return '动图'
  return '视频'
}

/**
 * 把 `scene` 压成一句能直接说出口的话，给兜底文案用。
 *
 * 🔴 为什么不能直接 `scene.slice(0, 26)`：2026-11-10 之后 `scene` 不再是
 * 一句平铺的描述 —— 图片/图文走的是「① 抄文字 / ② 说形态 / ③ 说画面」三段式，
 * 原样截 26 字会得到「看到了 ① 图里能看清的文字：kaoee ②」，把结构符号念出来，
 * 又长又不像人话。这里按下面的顺序挑最能代表这张图的一句：
 *   ① 有「③ 画面」段就用它（那是真正的画面描述）；
 *   ② 没有就退到「② 形态」段；
 *   ③ 都没有（老格式一句话）就用整段。
 * 段内再去掉行首的 ①②③ / 1. / - 之类记号、压缩空白，最后按句读截断。
 */
const briefScene = (scene, cap = 26) => {
  const s = String(scene || '').replace(/\r/g, '')
  if (!s) return ''
  const lines = s.split('\n').map((x) => x.trim()).filter(Boolean)
  /**
   * 段首记号的真实形态（2026-11-10 实测）是 `③ 画面里…` —— 圈号后面**是空格**，
   * 不是点号。第一版正则写死 `[③3][.、)．]` 于是一个都没匹配上，`pic`/`form`
   * 双双落空，最后把 ①②③ 整段原样截断念出去。所以这里的标点必须可选。
   */
  const MARK = /^[①②③④⑤1-5][.、)．]?\s*/
  const pick = (re) => lines.find((x) => re.test(x)) || ''
  // ③ 画面 / 3. 画面 —— 图片提示词里最后一段，最能代表这张图
  const pic = pick(/^[③3][.、)．]?\s*(画面|内容)/) || pick(/^[③3][.、)．]\s*/)
  // ② 形态
  const form = pick(/^[②2][.、)．]?\s*/)
  let out = pic || form || s
  out = out
    .replace(MARK, '')                              // 段首记号
    .replace(/^(画面|内容)(内容)?\s*[:：]\s*/, '')     // 「画面内容：」
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length <= cap) return out.replace(/[。！？，、；：\s]+$/, '')
  /**
   * 超长时先在句读处收 —— 但只在句读落点够靠后的时候才用（`cap*0.6`），
   * 否则会出现「一边是卡尔·布什比走回赫尔老家那个瞬间，媒体和一」这种
   * 为了凑句号硬拖到 cap+8 的断头话，不如老老实实截在 cap。
   */
  const win = out.slice(0, cap + 8)
  let cut = ''
  for (let i = win.length - 1; i >= 0; i--) {
    if ('。！？；'.includes(win[i])) { cut = win.slice(0, i); break }
  }
  if (!cut || cut.length < Math.floor(cap * 0.6)) cut = out.slice(0, cap)
  return cut.replace(/[。！？，、；：\s]+$/, '')
}

/**
 * 从卡片标题里摘一段「人话」——去掉 #话题、@某人、尾部空白。
 * 摘不出（整句都是标签/太短）返回空串，交给 PLAIN 兜底。
 */
const cardGist = (title) => {
  let s = String(title || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 去掉首尾的引号/书名号/标点，留正文
  s = s.replace(/^[\s"'"'「『（(\-—]+/, '').replace(/[\s"'"'」』）)\-—,，。.、]+$/, '')
  if (s.length < 4) return ''
  // 太长就按标点切块，从前往后拼到 ~18 字（视频标题的重点一般在最前面）
  if (s.length > 18) {
    const parts = s.split(/[，,。.！!？?；;…\s]+/).filter(Boolean)
    let out = ''
    for (const p of parts) {
      if (!out) { out = p; continue }
      if ((out + '，' + p).length > 18) break
      out += '，' + p
    }
    s = out || parts[0] || ''
    if (s.length > 18) s = s.slice(0, 18)
  }
  // 拼接过程会在中间塞「，」，收尾时再清理一次尾部标点/引号
  // （否则会得到「…同一片天空，”」—— 那个 ” 是书名号里带出来的右引号）
  //
  // ⚠️ 引号一律用 \u 转义写，不直接写弯引号字符：
  //    正则字符集里混排直引号与弯引号（" ' " '）极容易写坏，
  //    而且不同编辑器/终端对同一串的显示还不一样，改坏了根本看不出来。
  s = s.replace(/[\s,\uFF0C\u3002.\u3001\uFF1B;\uFF1A:!\uFF01?\uFF1F\u2026\u2014\u2013\-\u0022\u0027\u201C\u201D\u2018\u2019\u300D\u300F\uFF09)\u3011]+$/, '')
  s = s.replace(/^[\s,\uFF0C\u3002.\u3001\uFF1B;\uFF1A:!\uFF01?\uFF1F\u2026\u2014\u2013\-\u0022\u0027\u201C\u201D\u2018\u2019\u300C\u300E\uFF08(\u3010]+/, '')
  return s
}

const craft = (text, isOwner, card) => {
  const t = String(text || '').trim()
  const ho = isOwner ? HONORIFIC : ''
  const withHo = (s2) => (ho ? s2.replace(/\{HO\}/g, ho) : s2.replace(/\{HO\}/g, '').trim())

  // ⭐ 卡片优先于一切文字分支：card 的 text 是「标题+标签」，走下面的问句/笑/复述分支
  //    只会把标签念一遍。这里直接按「收到一个视频」回应。
  if (card) {
    const gist = cardGist(card.title || t)
    const seed = String(card.item_id || t || gist)
    const nw = cardWord(card)
    let hc = 0
    for (let i = 0; i < seed.length; i++) hc = (hc * 31 + seed.charCodeAt(i)) >>> 0
    if (gist) {
      const tpl = REPLY_CARD_TEMPLATES[hc % REPLY_CARD_TEMPLATES.length]
      return withHo(tpl.replace(/\{X\}/g, gist).replace(/\{N\}/g, nw))
    }
    return withHo(REPLY_CARD_PLAIN[hc % REPLY_CARD_PLAIN.length].replace(/\{N\}/g, nw))
  }

  // 问号只是最容易认的一种；中文里大量问句根本不打问号（"你在干嘛"「吃了吗」）。
  // 这些也要走问句分支，否则会被复述成「XX 是这么回事啊」，答非所问。
  if (
    /[?？]/.test(t) ||
    /(干嘛|干什么|干啥|吃了吗|在吗|在不在|是不是|有没有|能不能|可不可以|怎么样|如何|为什么|为啥|哪里|哪个|什么|谁|几点了|多少|对吗|好不好|行不行|要不要)/.test(t) ||
    /[吗嘛呢]$/.test(t)   // 「你有男朋友吗」「真的呀呢」—— 中文最常见的是句尾语气词，不打问号
  ) {
    return withHo(REPLY_QUESTION)
  }
  if (/(哈哈|笑|绷|绷不住|笑死|笑死我)/.test(t)) return withHo(REPLY_LAUGH)
  if (/(真的|假的|是不是|有没有|骗人|当真)/.test(t)) return withHo(REPLY_ASK)
  if (/(视频|图片|表情|转发|分享|链接|这首|这首歌)/.test(t)) return withHo(REPLY_MEDIA)
  // 纯招呼（很短、且就是打招呼的词）
  if (t.length <= 6 && /^(你好|您好|在吗|在不在|嗨|hi|hello|哈喽|早|早上好|晚安|睡了吗|1|。|\.)$/i.test(t)) {
    return withHo(REPLY_GREET)
  }
  // ⭐ 走到这里说明没有现成分支能匹配。带一句回声，免得连发几句收到同一句回复。
  const echo = echoOf(t)
  if (echo) {
    // 用「回复内容的 hash」挑模板，保证同一句话永远得到同一条回复（可复现），
    // 不同的话大概率落到不同模板上。
    let h = 0
    for (let i = 0; i < echo.length; i++) h = (h * 31 + echo.charCodeAt(i)) >>> 0
    const tpl = REPLY_ECHO_TEMPLATES[h % REPLY_ECHO_TEMPLATES.length]
    return withHo(tpl.replace(/\{X\}/g, echo))
  }
  /**
   * 摘不出回声（整句都是标签/链接/单个字）时，也别永远回同一句。
   * 同样按原话 hash 挑一档 —— 同一句话永远得到同一条，不同的话大概率不同。
   */
  let hf = 0
  for (let i = 0; i < t.length; i++) hf = (hf * 31 + t.charCodeAt(i)) >>> 0
  return withHo(REPLY_PLAIN_TEMPLATES[hf % REPLY_PLAIN_TEMPLATES.length])
}

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))

const readDm = () => {
  /**
   * ⭐ 2026-10-25 使用者问「为什么别人给她发消息她不回也不读」。
   *
   * 真因：这个脚本原来只盯 `--peer` 指定的那**一个人**（配置里的 dmToId）。
   * 别人发来的消息它连看都不看 —— 日志里全是 `tick:"idle"`，因为那个人的会话确实没新消息。
   * 实测当时会话列表里 `CCCPsound`（unread 0）+ `J…`（unread 1，预览「哈咯 1」），
   * 后面这位永远没人理。
   *
   * 现在不传 `--peer-sec-uid`，让 im-http.py 把所有会话都吐出来，
   * 然后在 tick 里逐个会话处理。传了 `--peer` 仍然只看那一个人（保留原有用法）。
   */
  const args = ['--read', '--limit', String(Math.max(12, Math.min(60, Number(argOf('--read-limit', '40')) || 40)))]
  if (PEER) args.push('--peer-sec-uid', PEER)
  const r = runPy('im-http.py', args, 60_000)
  const j = pickJson(r.stdout)
  if (!j) return { ok: false, error: (r.stderr || r.stdout || '没返回可解析结果').slice(0, 200) }
  if (!j.ok) return { ok: false, error: String(j.error || 'im-http 返回 ok:false').slice(0, 200) }

  // 指定了 --peer：沿用严格核验（匹配不到就报错，绝不按昵称猜人）
  if (PEER) {
    if (!j.matched) return { ok: false, error: String(j.match_note || '匹配不到这个人').slice(0, 200) }
    /**
     * 🔴 2026-11-10 修：`--peer` 模式下**永远走不到任何一条回复**。
     *
     * 上面的 `list_fail` 闸（:1032）判据是
     *   `listCount === 0 && targets.some(t => !t.mapped)`
     * 而非 peer 分支才填 `list_count` / `mapped` 两个字段；peer 分支的 target 是
     * 直接展开 `j.matched` 出来的，既没有 `mapped`，`rd.list_count` 也是 undefined
     * ⇒ `Number(undefined) || 0` 得 0 ⇒ 闸必然触发 ⇒ 每轮只打一行 `list_fail` 就 return。
     * 实测 `--peer ... --dry --once` 只吐
     * `{"tick":"list_fail","convs":1,"list_count":0,...}`，一条 draft 都没有。
     *
     * peer 模式的核验来自 im-http 的 `matched`（严格按 sec_uid 对上，对不上直接报错
     * 返回 ok:false），根本不需要 `im-send --list` 去猜人 ⇒ 对上了就是 `mapped: true`。
     * 把这两个字段补齐，闸自然放过。
     */
    return {
      ok: true,
      targets: [{ ...j.matched, mapped: true, key: String(j.matched.uid || j.matched.sec_uid || '') }],
      list_count: Array.isArray(j.conversations) ? j.conversations.length : 1,
      ms: j.ms,
    }
  }

  /**
   * 没指定 --peer：处理所有「别人发过话」的私聊会话。
   *
   * 只取 `type === 1`（私聊）—— 群聊不参与，抖音群消息量大且规则完全不同。
   * 每个会话要有 `peer_uid` 才能回（im-send 需要稳定 id），拿不到就跳过并记日志。
   */
  const convs = Array.isArray(j.conversations) ? j.conversations : []
  /**
   * ⭐ 2026-10-25：im-http 只给数字 peer_uid、不给 sec_uid，也不给昵称；而 im-send 发送要靠
   * sec_uid（列表里根本没有数字 uid 这个字段，实测 DOM 的 fiber conversation 对象只有
   * toParticipantSecUserId / sortOrder 两个键）。两边差一个映射，直接传 uid 会报
   * 「会话列表里没有昵称为「」的人」。
   *
   * 这里补一次 im-send --list，拿到 [{sec_uid, nick, preview}]，再用「对方最后一条消息的
   * 开头几个字」去 preview 里对齐 —— 比昵称可靠（名字可能重复、可能被截断成「J…」）。
   */
  const listMap = (() => {
    try {
      const lr = runNode('im-send.mjs', ['--list'], 120_000)
      const lj = pickJson(lr.stdout)
      const people = Array.isArray(lj?.people) ? lj.people : []
      if (!people.length) return []
      /**
       * 🔴 2026-10-28 修：**只留私聊**（`sec_uid` 非空的才是人）。
       *
       * `im-send --list` 把群和人都列在 `people` 里，群的 `sec_uid` 是空串
       * （实测「好记的群名」「不能出去玩」都是 `has_id:false`）。原来不过滤，
       * 后果是：
       *   ① 群排在前面，`preview.includes(probe)` 会先命中群 —— 实测会话
       *      3787172659337272 对方最后一条是「1」，probe 就是 `"1"`，
       *      而「不能出去玩」的 preview 是 `"130 6分钟前 CCCPsound：魔了"`，
       *      含 "1" ⇒ 被判成"这个人在群里"，`sec_uid` 拿到空串 ⇒
       *      整条落到 `skip:no_sec_uid`，一天 298 次，人根本没被回过。
       *   ② `orderUsable` 要求「数量相等」，5 个（含 2 群）对上 3 个私聊
       *      永远不相等 ⇒ 顺序兜底也一起失效。
       * 过滤之后 5 → 3，正好等于 `convs.filter(c => c.type === 1).length`。
       */
      return people
        .filter((p) => String(p.sec_uid || '').trim())
        .map((p) => ({
          sec_uid: String(p.sec_uid || ''),
          nick: String(p.nick || ''),
          preview: String(p.preview || ''),
        }))
    } catch {
      return []
    }
  })()

  /** 从 im-send 的 preview（形如「12分钟前 在听呢，你说」）里剥掉时间前缀，只留正文 */
  const previewBody = (pv) => String(pv || '')
    .replace(/^\s*(\d+\s*(分钟|小时|秒|天)前|昨天|前天|刚刚|\d{1,2}:\d{2})\s*/, '')
    .trim()

  /**
   * ⭐ 兜底：按「列表顺序」对齐（2026-10-26 新增）
   *
   * 背景：preview 是**渲染文案**，不是消息正文。对方发视频卡片时，
   * preview 显示「分享[视频] 3」，而消息的 text 是完整标题
   * 「斩断昔日旧枷锁 今日方知我是我 #OiiOii …」—— 一个字都对不上，
   * 于是整条被判定 no_sec_uid 直接不说。用户看到的就是「抖音的 AI 不回我了」。
   *
   * 为什么顺序可信：`im-http.py --read` 的会话顺序和 `im-send.mjs --list`
   * 的 DOM 顺序都来自同一个会话列表，按 sortOrder 排列（实测两个会话、
   * 多次调用完全一致）。所以当「数量相等」且「文本一条都没对上」时，
   * 按下标一一对应是唯一还站得住的线索。
   *
   * 保守条件（缺一不可，宁可发不出去也不能发给错的人）：
   *   · 两边数量必须相等（不等说明有一边漏了会话，下标会错位）
   *   · 只对「文本比对完全没命中」的会话用这个兜底
   *   · **收件人昵称必须能对上**：DM 的 `nick`（im-http 从会话里取的）和
   *     im-send 的 `nick` 都是同一来源，能对上才证明这条下标没串位。
   *     比对时忽略 `…`/省略号（列表里长昵称会被截成「J…」）。
   */
  const normNick = (s) => String(s || '')
    .replace(/[…]|\.\.\./g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const orderUsable = listMap.length > 0 && listMap.length === convs.filter((c) => Number(c.type) === 1).length

  const targets = []
  let type1Idx = -1
  for (const c of convs) {
    if (Number(c.type) !== 1) continue
    type1Idx += 1
    const msgs = Array.isArray(c.messages) ? c.messages : []
    const theirs = msgs.filter((m) => m.from === 'them' && m.at)
    if (!theirs.length) continue
    const peer = String(c.peer_uid || '').trim()
    if (!/^\d{10,}$/.test(peer)) continue

    /**
     * 用「这个会话的最后一条消息」去会话列表对齐 sec_uid —— **不是**「对方最后一条」。
     *
     * 踩过的坑：列表 preview 显示的是「这个会话最新的一条」，不管谁发的。
     * 一开始拿 `theirs`（对方发的）最后一条去比，主人那边刚被机器人回过一句，
     * preview 显示的是机器人的话，永远对不上 ⇒ 6 条全被判 no_sec_uid。
     */
    const lastAny = msgs.length ? String(msgs[msgs.length - 1].text || '').trim() : ''
    const probe = lastAny.replace(/\s+/g, ' ').slice(0, 12)
    let hit = null
    let how = ''
    /**
     * 🔴 `probe` 太短就不许拿去比 preview。
     *
     * 实测：对方只发了个「1」时 probe 就是 `"1"`，`preview.includes("1")`
     * 几乎命中任何会话（preview 里带未读数、时间、群成员昵称）。
     * 短于 4 个字、或者全是数字符号的，一律跳过 preview 匹配，
     * 直接交给下面的顺序兜底（那里有数量相等 + 串位检查两道保护）。
     */
    const probeOk = probe.length >= 4 && /[^\d\s\p{P}]/u.test(probe)
    if (probe && probeOk) {
      hit = listMap.find((p) => p.preview.includes(probe))
      if (hit) how = 'preview-head'
      if (!hit && probe.length >= 6) {
        // 再退一步：比正文前 6 个字（防 emoji/标点差异）
        const p2 = probe.slice(0, 6)
        hit = listMap.find((p) => previewBody(p.preview).includes(p2))
        if (hit) how = 'preview-partial'
      }
      if (!hit) {
        // 再兜一层：正文末尾 8 个字（长句被 preview 截断时靠尾部对）
        const tail = lastAny.replace(/\s+/g, ' ').slice(-8)
        if (tail.length >= 4) hit = listMap.find((p) => previewBody(p.preview).includes(tail))
        if (hit) how = 'preview-tail'
      }
    }
    if (!hit && orderUsable) {
      /**
       * 文本彻底对不上时按顺序对齐。这里**不校验 preview 内容**是对的 ——
       * 卡片消息的 preview 和正文本来就不同源，硬校验等于放弃。
       * 保证不发错人的是：两边数量相等（多的少的一个都会错位）。
       *
       * 额外防护：这条 position 上如果 preview 里存在**另一个会话**的文本特征，
       * 说明下标可能串位，宁可放弃也不赌。判断方式是把「本会话最后一条正文」
       * 和「其他会话的 preview 正文」比一次 —— 只要本会话的正文出现在
       * 别的下标上，就认定顺序不可信。
       */
      const selfBody = previewBody(lastAny)
      const stolen = selfBody.length >= 6
        ? listMap.findIndex((p, pi) => pi !== type1Idx && previewBody(p.preview).includes(selfBody.slice(0, 6)))
        : -1
      if (stolen < 0) {
        hit = listMap[type1Idx] || null
        if (hit) how = 'order'
      } else {
        how = 'order-conflict'
      }
    }
    const sec = hit ? hit.sec_uid : ''
    const nick = (hit && hit.nick) || peer
    targets.push({
      uid: peer, sec_uid: sec, nickname: nick,
      conv_id: c.conv_id, messages: msgs,
      key: peer, mapped: Boolean(sec), how,
    })
  }
  return { ok: true, targets, ms: j.ms, conv_count: convs.length, list_count: listMap.length }
}

const sendDm = (text, toId) => {
  // im-send 的 --to-id 要 sec_uid 或 16 位 uid；两种都试过能通
  const args = ['--to-id', toId, '--text', text]
  const r = runNode('im-send.mjs', args, 240_000)
  const j = pickJson(r.stdout)
  if (!j) return { ok: false, error: (r.stderr || r.stdout || '没返回可解析结果').slice(0, 200) }
  return j
}

/**
 * ⭐ 发一条**视频卡片**（2026-10-26）。
 *
 * 走 `card-share.mjs --isolated`：那个开关让它在**新标签页**里干活，
 * 不碰本循环正在用的 /chat 页 —— 否则它 `Page.navigate` 到视频页，
 * 这边下一轮就读不到私信了（会连续 read_fail）。
 *
 * 为什么只传 `--to-id`、不传昵称：分享面板里同名的人不少，
 * 而 sec_uid 是稳定的；面板里捞不到这个人时它会如实报错（不猜）。
 */
const sendVideoCard = (awemeId, toId, nick) => {
  const args = [String(awemeId), '', '--to-id', String(toId), '--isolated']
  const r = runNode('card-share.mjs', args, 260_000)
  const j = pickJson(r.stdout)
  if (!j) return { ok: false, error: (r.stderr || r.stdout || '没返回可解析结果').slice(0, 200) }
  return j
}

/**
 * 从 `forward-pick.json`（插件自己刷推荐流留下的候选）里挑一条视频。
 *
 * 为什么用这个池子而不是现场搜：`forward-pick.json` 是插件按使用者的
 * 关键词/口味筛过的，质量比随机抓热榜高；而且它是现成的，不用为了发一条
 * 视频再跑一轮 5 分钟的浏览。
 */
const pickVideoCandidate = (st) => {
  let rows = []
  try {
    const d = JSON.parse(readFileSync(join(HOME, 'forward-pick.json'), 'utf8'))
    rows = Array.isArray(d.rows) ? d.rows : []
  } catch { return null }
  if (!rows.length) return null
  const used = new Set(Object.keys(st.videoSent || {}))
  const pool = rows.filter((r) => {
    const id = String(r.aweme_id || '')
    return /^\d{10,}$/.test(id) && !used.has(id)
  })
  if (!pool.length) {
    // 池子发完了就把「发过」记录清掉，允许重发（比彻底没得发好）
    st.videoSent = {}
    return rows.find((r) => /^\d{10,}$/.test(String(r.aweme_id || ''))) || null
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 现在能不能发视频：开关 + 间隔 + 日上限 */
const canSendVideo = (st) => {
  if (!VIDEO_ENABLED) return { ok: false, why: 'video_off' }
  if (VIDEO_MAX > 0 && Number(st.videoCount || 0) >= VIDEO_MAX) return { ok: false, why: 'video_daily_cap' }
  const last = Number(st.videoLastAt || 0)
  if (last && Date.now() - last < VIDEO_EVERY_MS) {
    return { ok: false, why: 'video_gap', wait_s: Math.round((VIDEO_EVERY_MS - (Date.now() - last)) / 1000) }
  }
  return { ok: true }
}

const main = async () => {
  // ⭐ 2026-10-25 起 `--peer` 不再是必须的：不给就盯**所有**私聊会话（原行为保留）
  if (!PEER) log({ info: '没给 --peer ⇒ 盯所有私聊会话（只回别人说过话的那些）' })
  if (!OWNER_UID) log({ warn: '没给 --owner-uid ⇒ 认不出谁是号主，特殊称呼边界会退化' })

  const st = loadState()
  const today = beijingKey()
  if (st.day !== today) { st.day = today; st.count = 0; st.videoCount = 0 }
  /**
   * 每个会话一个首拍标记。原来是全局一个 `st.primedAt`，
   * 改成多会话后必须按人分开，否则 A 会话对完表，B 会话的历史会被当成新消息全回一遍。
   */
  if (!st.primed) st.primed = {}

  const tick = async () => {
    if (inQuiet(QUIET)) { log({ tick: 'quiet', quiet: QUIET, now: bjHHMM() }); return }
    if (MAX > 0 && st.count >= MAX) { log({ tick: 'cap', count: st.count, max: MAX }); return }

    /**
     * 🔴 2026-10-27 加：验证码冷却闸。
     *
     * 验证码是临时的（人点一下就没了），但「2 分钟前刚撞过验证码」这件事必须记住，
     * 否则每 30 秒都会起一次无头 Chrome、打开私信页、被浮层挡住、失败 ——
     * 一天 2880 次白跑，还可能让风控持续盯着这个号。
     *
     * 所以：`st.needVerify.at` 在 2 分钟内 ⇒ 整轮跳过（日志 tick=captcha_cool）。
     * 2 分钟后放行去试一次 —— 如果人点掉了验证，这一下就通了；
     * 还没点掉就再撞一次，重新计时，仍然是 2 分钟一次而不是 30 秒一次。
     */
    const nv = st.needVerify
    if (nv && nv.at) {
      const ageMs = Date.now() - Date.parse(nv.at)
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 2 * 60 * 1000) {
        log({ tick: 'captcha_cool', since: nv.at, in_sec: Math.round((2 * 60 * 1000 - ageMs) / 1000), kind: nv.kind })
        return
      }
    }

    const rd = readDm()
    if (!rd.ok) { log({ tick: 'read_fail', error: rd.error }); return }
    const targets = Array.isArray(rd.targets) ? rd.targets : []
    if (!targets.length) { log({ tick: 'idle', note: '没有任何私聊会话里有对方的消息' }); return }

    /**
     * 🔴 2026-10-27 加：会话列表读不到 ⇒ 整轮跳过，**不写任何 repliedAt 标记**。
     *
     * 实测事故：把 Chrome 里带验证码的主页面关掉之后，`im-send.mjs --list` 有一阵
     * 返回 `count: 0`（页面刚开、会话列表还没渲染完），于是 sec_uid 映射全落空，
     * 她发来的 4 条真消息（#椎名林檎 图文卡 /「为什么不回我这个视频」/「1」/
     * 《永恒的爱》卡片）全被写成 `skip:no_sec_uid` —— 而那是**终态**，
     * 列表恢复之后也不会再试，表现就是「永久已读不回」。
     *
     * 判据：list_count 为 0 但确实有会话要处理 ⇒ 这是**环境故障**（列表没渲染），
     * 不是「这个人对不上号」。环境故障绝不能污染消息状态。
     * 列表正常、只是某个人对不上号时才走 no_sec_uid（那是真的对不上）。
     */
    const listCount = Number(rd.list_count) || 0
    if (listCount === 0 && targets.some((t) => !t.mapped)) {
      log({
        tick: 'list_fail', convs: targets.length, list_count: 0,
        note: '会话列表读不到（页面还没渲染完），本轮不判定任何人、不写状态，下一拍重试',
      })
      return
    }

    let totalReplied = 0
    for (const t of targets) {
      if (MAX > 0 && st.count >= MAX) { log({ tick: 'cap_mid', count: st.count }); break }
      try {
        const n = await handleOne(t, st)
        totalReplied += n
      } catch (e) {
        log({ tick: 'conv_crash', peer: t.key, error: String(e?.message || e).slice(0, 140) })
      }
    }
    log({ tick: 'done', replied: totalReplied, count: st.count, max: MAX, convs: targets.length })

    /**
     * ⭐ 2026-10-27 加：这一轮真回过话，就把「还没推过的那几天」推给 QQ 记忆库。
     *
     * 为什么放在 done 之后而不是每条消息之后：A 是按天聚合的（一天一条摘要），
     * 一轮里可能回好几条同一天的消息，逐条推会撞去重键、白跑几次 HTTP。
     * 一轮推一次，游标（memory-push.json）保证同一天不会重复推。
     *
     * ⚠️ 必须 fire-and-forget：`pushDmToLivingMemory` 要 POST AstrBot 面板
     *    （可能 20 秒超时），await 它会把 30 秒的 tick 拖成 50 秒，
     *    下一拍就会被单飞锁判 busy。记忆是锦上添花，绝不能拖慢回复。
     */
    if (totalReplied > 0 && !DRY) {
      pushDmToLivingMemory(HOME, { timeoutMs: 20_000 })
        .then((r) => {
          if (!r.ok) { log({ tick: 'mem_push_fail', why: String(r.error || '').slice(0, 100) }); return }
          if (!r.memos) return
          log({ tick: 'mem_push', memos: r.memos, imported: r.imported, skipped: r.skipped })
        })
        .catch((e) => log({ tick: 'mem_push_throw', error: String(e?.message || e).slice(0, 100) }))
    }
  }

  /**
   * 处理一个会话。返回这一轮真发出去几条。
   * 抽成函数是因为多会话循环里要各自独立 —— 一个人失败不能拖垮其他人。
   */
  const handleOne = async (rd, st) => {
    const msgs = Array.isArray(rd.messages) ? rd.messages : []
    const theirs = msgs.filter((m) => m.from === 'them' && m.at)
    if (!theirs.length) return 0

    /**
     * ⭐ 2026-10-28 加：私聊也落盘、也取跨轮上下文（原来只有群聊有）。
     *
     * 为什么必须加：私信这边的 history 原来只来自**这一轮 readDm 读到的 12 条**
     * （`--limit 12`），也就是说「这一轮最多记得 12 条，下一轮从第 13 条起就断了」。
     * 而 `--every 30` 每 30 秒跑一轮、每轮只处理新消息 —— 对方隔一天再说话，
     * 上下文是一张白纸，她只能靠 LivingMemory 的向量召回盲猜。
     * 群聊侧（`tools/group-reply.mjs:324`）早就是「先 merge 再 dmContext」，
     * 私聊这边一直缺这一步，就是使用者反复说的「感觉没有上下文一样」。
     *
     * key 优先 sec_uid：那是「这个人」的稳定标识，也是 index.js 的 chatWatch
     * 和 pushDmToLivingMemory 扫描 `dm-*.json` 时认的键。拿不到 sec_uid
     * （会话列表没渲染完）才退到数字 uid —— 宁可写一份独立的，也别把两个
     * 不同的人合进同一个文件。
     *
     * ⚠️ 必须在挑消息**之前**存：这一轮读到的可能比上次多，先合并再取上下文，
     *    这一轮就能用到「上一轮她说过什么」。
     * ⚠️ dry 不落盘：`--dry` 的语义是只演练不动真格（踩过：dry 把状态写坏）。
     */
    /**
     * 🔴 2026-10-28 收紧：**只认 sec_uid，没有就不落盘**。
     *
     * 第一版写成 `rd.sec_uid || rd.uid || rd.key`，实测当场串号：
     * 会话列表没渲染完时 `rd.sec_uid` 是空的（日志 `skip:no_sec_uid`），
     * 于是退到数字 uid 写了一份 `dm-3787172659337272.json`，里面装的却是
     * CCCPsound 那边读回来的 12 条消息（`即梦网页改版…` / `大肥鱼，我也想给你完整的一生啊`）。
     * 数字 uid 是「会话列表这一行暂时对应的账号」，列表错位时它随时会变，
     * 拿它当身份键等于把 A 的话记到 B 头上 —— 宁可这一轮不记，也不能记错。
     */
    const memKey = String(rd.sec_uid || '').trim()
    if (memKey && !DRY) {
      try { mergeDmMemory(HOME, memKey, rd.nickname || '', msgs) } catch { /* 记忆失败不阻断回话 */ }
    }
    // 上一轮之前说过的话（跨轮次，不只是这一轮读到的十几条）
    const ctx = (() => {
      if (!memKey) return null
      try { return dmContext(HOME, memKey, { recent: 16 }) } catch { return null }
    })()

    /**
     * 首拍对表：把「早就过去的历史」逐条标成 skip:history，**但最近的留着回**。
     *
     * 两个坑都踩过：
     *   ① 只记一个 primedAt 时间戳：对方连发三条落在同一秒时三条 at 完全一样，
     *      只记一个戳会把其中两条永久吞掉（实测 2026-10-25 07:59:28 那批只回了 1 条）。→ 逐条落盘。
     *   ② 一律全标 history：新会话第一次上线会把「刚刚才发来、正在等回复」的消息也标成历史，
     *      表现就是「她明明在看就是不理我」（实测 2026-10-25：J… 那条「哈咯 1」被吞）。
     *      → 只标早于 PRIME_FRESH_MS 的，近的当成待回。
     */
    if (!st.primed[rd.key]) {
      const cutoff = Date.now() - PRIME_FRESH_MS
      let marked = 0
      let kept = 0
      for (const m of theirs) {
        /**
         * ⚠️ `m.at` 是 ISO 字符串（im-http.py 用 iso(at_ms) 给的），
         *    直接 Number() 得到 NaN，NaN < cutoff 恒 false ⇒ 会把所有历史都当新消息全回一遍。
         *    必须 Date.parse 解析，解析失败（NaN）按「老」处理，宁可不回也不轰炸。
         */
        const ts = Date.parse(String(m.at || ''))
        if (!Number.isFinite(ts) || ts < cutoff) {
          st.repliedAt[`${rd.key}|${m.at}`] = 'skip:history'
          marked += 1
        } else {
          kept += 1
        }
      }
      st.primed[rd.key] = theirs[theirs.length - 1].at
      /**
       * ⚠️ dry 模式**不能落盘**：`--dry` 的语义是「只演练、不动真格」。
       *    2026-10-25 实测踩过：dry 跑一次把 8 条真实待回消息全标成 skip:history，
       *    之后真跑时全部跳过，表现成「她又不回我」—— 查了半天才发现是 dry 自己写坏的。
       */
      if (!DRY) saveState(st)
      log({
        tick: 'primed', peer: rd.key,
        marked, kept, dry: DRY || undefined,
        note: '首拍对表：老历史不重播，近 ' + Math.round(PRIME_FRESH_MS / 60000) + ' 分钟内的留着回',
      })
      if (!kept) return 0
    }

    /**
     * 取「需要回的」：时间基准之后、且没被标过的。
     * ⚠️ 这里**不能**用 `m.at > st.primedAt` —— 同一毫秒的多条会被基准卡掉一半。
     *    改用「不在 repliedAt 里」作为唯一判据：标记是我们自己维护的，
     *    每条被处理过的消息（回过 / 主动跳过 / 历史）都有标记，没标记的就是待处理。
     *
     * 🔴 2026-10-27 修：`skip:need_verify` **不算处理完了**，要放回来重试。
     *    实测事故：11:14 抖音弹验证 → 两条（#椎名林檎 那条、之后她追问「为什么不回我这个视频」）
     *    被标成 `skip:need_verify`；验证码是**临时**的，人点一下就没，但这两条被永久标死，
     *    表现成「已读不回」——对方连发两条催，这边一条都没回。
     *    现在：带 need_verify 标记的当成待回；但如果验证码还在（上一次发送又撞上 captcha），
     *    那一条会重新被标回 need_verify，不会变成每 30 秒撞一次墙 —— 因为
     *    `st.needVerify` 最后一次命中时间在 2 分钟内就跳过整轮（见上面 trySend 前的闸）。
     *
     * 🔴 同日再修：`skip:no_sec_uid` 也**不算处理完了**。
     *    它原本的语义是「这个人对不上号，别瞎发」—— 看起来是确定性判断，但实测里
     *    它绝大多数时候来自**瞬时故障**：会话列表没渲染完（`--list` 返回 0 或只返回 1 条），
     *    preview 自然对不上。上面加了 `list_fail` 闸之后，list=0 已经不会走到这里；
     *    但 list 只返回部分（比如 1/2）时仍会落到 no_sec_uid，一样是环境问题。
     *    所以它也放回来重试。防止无限重试靠两道：①`list_fail` 闸整轮跳过不写状态
     *    ②重试是每 `--every` 秒一次、每次只多一度 `--list`，不比正常轮次更贵。
     */
    const RETRY_SET = new Set(['skip:need_verify', 'skip:no_sec_uid'])
    const fresh = theirs.filter((m) => {
      const k = `${rd.key}|${m.at}`
      const mark = st.repliedAt[k]
      if (!mark) return true
      if (RETRY_SET.has(mark)) return true   // 验证码 / 列表瞬时故障挡的，恢复之后要补回
      return false
    })
    if (!fresh.length) { log({ tick: 'idle', peer: rd.key, base: st.primed[rd.key], n: theirs.length }); return 0 }

    /**
     * ⭐ 2026-10-25 使用者要求：改成**每条都回**（原来只回最后一条）。
     *
     * 原来只回最后一条的理由是「对方连发四五句是一个意思，逐条回会变成刷屏」。
     * 现在明确要逐条回，那就照做 —— 但保留两条护栏，避免真变成刷屏：
     *   ① 同一轮里如果前一条刚回过，后一条的内容和它**一模一样** ⇒ 跳过（重复话不必回两遍）；
     *   ② 每条各自的去重仍然生效（repliedAt 记的是对方消息的时间戳，不是回的时间）。
     * 顺序按时间正序处理，保证回复的先后与对方说话的先后一致。
     */
    let replied = 0
    let lastReplyText = ''
    for (const m of fresh) {
      if (MAX > 0 && st.count >= MAX) { log({ tick: 'cap_mid', count: st.count }); break }
      const why = shouldSkip(m.text)
      if (why) {
        st.repliedAt[`${rd.key}|${m.at}`] = 'skip:' + why
        if (!DRY) saveState(st)
        log({ tick: 'skip', peer: rd.key, why, text: String(m.text || '').slice(0, 40) })
        continue
      }
      const isOwner = Boolean(OWNER_UID) && String(rd.uid || '') === String(OWNER_UID)
      /**
       * ⭐ 优先让模型说，说不了才回落到 craft() 的模板。
       *
       * history 只带**对方已回过的**那几条（`st.repliedAt[at]` 是真时间戳的），
       * 这样模型有上下文但不会把「我刚才那句没发出去」当成自己说过的话。
       * 兜底判据是 `res.ok`：
       *   · 网络/网关/欠费/超时 → ok:false → 用 craft()
       *   · 输出空或清洗后为空 → 也走 craft()，绝不发空消息
       */
      let text = ''
      let by = 'rule'
      // ⭐ 带视频卡片时先「看一眼」：拿到画面描述，模型才有得聊（拿不到就按没看过处理）
      // ⭐ 表情包同理：以前 card.kind==='emoji' 没有 item_id，lookAtVideo 直接返回 null，
      //    她收到的 text 只有「[表情]」两个字 ⇒ 完全不知道你发的是啥。
      let video = null
      if (m.card?.kind === 'emoji') video = await lookAtEmoji(m.card)
      // ⭐ 2026-11-10：对方直接发的图片 / 动图（2702/2703）没有 item_id，
      //    以前落到 lookAtVideo 立刻 return null ⇒ 只看到「[图片]」两个字。
      else if (m.card?.kind === 'image' || m.card?.kind === 'gif') video = await lookAtPhoto(m.card)
      else if (m.card) video = await lookAtVideo(m.card)
      /**
       * ⭐ 2026-10-27 加：看过就把这条作品**落盘成记忆**（使用者要的 B）。
       *
       * 以前 `video.scene` 只活在这一次 prompt 里，回完消息就随内存没了 ——
       * 第二天提起「你昨天看的那个片子」她完全不认。现在两处都写：
       *   ① 本地 `memory/dm-<sec_uid>.json` 的 `videos[]`（抖音侧自己的记忆，
       *      下一轮 sayWithModel 能读到，见 lib/memory.mjs 的 loadVideoMemory）
       *   ② AstrBot 的 LivingMemory（QQ 侧也能看到，见 lib/memory-push.mjs）
       * 两处都 try 住：记忆失败绝不能影响这条消息回不出去。
       */
      if (video && (video.seen || video.scene) && rd.sec_uid) {
        try {
          /**
           * 🔴 2026-11-10：图片/动图没有 item_id，`addVideoMemory` 会直接 return null，
           * 于是「她看过这张图」永远落不了盘 —— 下一轮再问就只能重看一遍或干脆装不记得。
           * 这里给它造一个稳定的伪 id：优先用抖音给的 md5，没有就退到 url 的短哈希。
           * 同一个 md5 的图下次还是同一条记忆，不会每次新增。
           */
          const cardKind = String(m.card?.kind || '')
          const isPhoto = cardKind === 'image' || cardKind === 'gif'
          let memId = String(m.card?.item_id || '')
          if (!memId && isPhoto) {
            const seed = String(m.card?.md5 || m.card?.url || '')
            memId = 'img-' + createHash('sha1').update(seed).digest('hex').slice(0, 16)
          }
          /**
           * 🔴 2026-11-10：`addVideoMemory` 有个隐藏前置 —— 它第一段是
           *   `const prev = loadDmMemory(home, secUid); if (!prev) return null`
           * 也就是**必须先有 `memory/dm-<sec_uid>.json`**，否则不管 itemId 多合法都写不进去。
           * 这个文件平时由上面 `:1184` 的 `mergeDmMemory` 建，但它被 `!DRY` 挡着；
           * 万一某轮是 `--dry`、或者 merge 那次刚好抛了异常被 catch 吞掉，
           * 这里就会静默失败（返回 null，没有任何日志），表现为「她看过这张图、
           * 但下一轮完全不记得」。所以拿 add 的返回值兜一层：
           * 拿不到记忆就当场补建一次再写，还失败就留一行日志 —— 别再让它无声无息。
           */
          const added = addVideoMemory(HOME, rd.sec_uid, {
            itemId: memId,
            title: String(video.desc || m.card?.title || (isPhoto ? (cardKind === 'gif' ? '[动图]' : '[图片]') : '')),
            scene: String(video.scene || ''),
            comments: Array.isArray(video.comments) ? video.comments : [],
            howSeen: String(video.how_seen || ''),
          })
          if (!added) {
            if (!DRY) {
              try {
                mergeDmMemory(HOME, rd.sec_uid, rd.nickname || '', msgs)
                const retry = addVideoMemory(HOME, rd.sec_uid, {
                  itemId: memId,
                  title: String(video.desc || m.card?.title || (isPhoto ? (cardKind === 'gif' ? '[动图]' : '[图片]') : '')),
                  scene: String(video.scene || ''),
                  comments: Array.isArray(video.comments) ? video.comments : [],
                  howSeen: String(video.how_seen || ''),
                })
                if (!retry) log({ tick: 'vmemo_local_fail', memId: memId.slice(0, 24) })
              } catch {
                log({ tick: 'vmemo_local_fail', memId: memId.slice(0, 24) })
              }
            }
          } else {
            log({ tick: 'vmemo_local', memId: memId.slice(0, 24), total: added.total, how: String(video.how_seen || '') })
          }
          if (!DRY) {
            pushVideoMemo(HOME, {
              secUid: rd.sec_uid,
              nick: rd.nickname,
              itemId: memId,
              title: String(video.desc || m.card?.title || ''),
              scene: String(video.scene || ''),
              comments: Array.isArray(video.comments) ? video.comments : [],
            }).then((r) => {
              if (!r.ok) log({ tick: 'vmemo_fail', why: String(r.error || '').slice(0, 80) })
              else log({ tick: 'vmemo', imported: r.imported, skipped: r.skipped, chars: r.chars })
            }).catch(() => {})
          }
        } catch (e) {
          log({ tick: 'vmemo_throw', error: String(e?.message || e).slice(0, 100) })
        }
      }
      try {
        const res = await sayWithModel({
          text: m.text,
          /**
           * 🔴🔴 2026-10-25 晚修（关键 bug）：history 里**自己说过的话全被丢了**。
           *
           * 原来只有一条过滤条件：
           *   `st.repliedAt[key|at] && !startsWith('skip:')`
           * 而 `st.repliedAt` 记的是「**对方的哪条消息我回过了**」——
           * 它从来不给 `me` 的消息打记录。于是 me 的消息一条都进不来。
           *
           * 实测 dump（20 条真实私信）：传给模型的 history 是
           *   them: 你的人设是啥样的 / them: 发完整的 / them: 发完整的人设 /
           *   them: [表情] / them: 好吧 / them: 你今天心情咋样 / them: 区是什么意思 …
           * `其中 me 的条数: 0` —— 全是对方向，她自己的回答一条没有。
           *
           * 模型看到的就是「一个人只记得别人问过什么、完全不记得自己答过什么」，
           * 所以永远接不上，问「啥意思」它也不知道在问哪句。使用者反馈的
           * 「她回复还是感觉没有上下文一样」根因就在这。
           *
           * 现在的规则：
           *   · `me` 的发言  → **永远算历史**（她自己说过什么，必须记得）
           *   · `them` 的发言 → 只有「已经回过的」才算（`repliedAt` 有记录且不是 skip）
           *                     还没回的不能算，因为它可能正是当前要处理的那条
           *   · `skip:history` 的老消息 → 不算（首拍对表时标掉的，不重播）
           */
          /**
           * ⭐ 2026-10-28：来源换成跨轮记忆（`ctx.recent`，覆盖上一轮之前），
           * 退回落这一轮读到的。和 `tools/group-reply.mjs:418` 一致。
           *
           * 🔴 判「哪些算历史」的判据改了两次，最终定在**时间先后**：
           *   ① 最初：`me` 无条件算、`them` 要求 `st.repliedAt` 里有标记。
           *      问题是记忆里的 `at` 以前一律写成"我写盘的那一刻"（memory.mjs 已修），
           *      和 `repliedAt` 的键（抖音原始时间戳）根本对不上 ⇒ 所有 `them`
           *      被当成"还没回"滤掉，上下文只剩自己说的话。正好是使用者说的
           *      「感觉她根本不知道我在说什么」。
           *   ② 改成「比当前正在回的这条更早的，就是历史」。
           *      ISO 时间字符串可以直接比大小，不依赖任何状态表 ——
           *      落盘记忆、这一轮读到的、跨轮次的，全都统一适用。
           *      同时天然排除了「对方刚发来、我还没回」的那条（它 `at` 等于当前 m.at
           *      或更晚），不会出现回答完又把它当成历史再答一次的循环。
           */
          history: (ctx?.recent?.length ? ctx.recent : msgs)
            .filter((x) => {
              const t = String(x?.text || '').trim()
              if (!t) return false
              if (x.from !== 'me' && x.from !== 'them') return false
              if (x === m) return false
              // 只收严格早于当前这条的
              if (m.at && x.at) return String(x.at) < String(m.at)
              return false
            })
            .slice(-16)
            .map((x) => ({ from: x.from, text: String(x.text) })),
          isOwner,
          card: m.card,
          video,
          home: HOME,
          secUid: rd.sec_uid || '',
        })
        // 诊断：这一轮到底给了模型多少上下文、跨轮的占多少
        {
          const hs = (ctx?.recent?.length ? ctx.recent : msgs)
            .filter((x) => x?.text && (x.from === 'me' || x.from === 'them') && x !== m
              && m.at && x.at && String(x.at) < String(m.at))
          log({
            tick: 'ctx', peer: rd.key, mem: Boolean(ctx?.recent?.length),
            n: Math.min(hs.length, 16), me: hs.filter((x) => x.from === 'me').length,
            them: hs.filter((x) => x.from === 'them').length,
          })
        }
        if (res.ok && res.text) {
          const cleaned = sanitize(res.text, isOwner)
          if (!cleaned) {
            log({ tick: 'model_rejected', raw: res.text.slice(0, 60), why: 'sanitize_empty' })
          } else if (isEcho(cleaned, m.text)) {
            // 复读对方原话：模型懒得动脑时的默认行为，改走模板给个真回应
            log({ tick: 'model_echo', raw: cleaned.slice(0, 50), fallback: 'rule' })
          } else {
            text = cleaned
            by = `model:${res.model}`
            if (!st.llmOkSince) { st.llmOkSince = new Date().toISOString(); if (!DRY) saveState(st) }
          }
        } else if (res.error) {
          // 只记一次，避免每 30 秒刷同一行；恢复后由 llmOkSince 清掉
          if (st.llmLastError !== res.error) {
            st.llmLastError = res.error
            if (!DRY) saveState(st)
            log({ tick: 'model_fail', error: res.error, fallback: 'rule' })
          }
        }
      } catch (e) {
        log({ tick: 'model_throw', error: String(e.message || e).slice(0, 120), fallback: 'rule' })
      }
      if (!text) {
        // m.card 由 im-http.py 透出（视频/图文卡片才有）：带它进去，craft 才不会把话题标签念一遍
        text = sanitize(craft(m.text, isOwner, m.card), isOwner)
        by = 'rule'
        // ⭐ 兜底也用画面：看到了就说看到了，别退回到「收到～我看了」这种空话
        const sc = String(video?.scene || '').trim()
        if (sc && m.card) {
          const brief = briefScene(sc, 26)
          if (brief) text = sanitize(`看到了 ${brief}`, isOwner)
        }
      }
      if (!text) { log({ tick: 'skip', peer: rd.key, why: 'empty_after_sanitize' }); continue }
      /**
       * 同一轮里连着两条会得到几乎一样的回复 ⇒ 第二条不必再发。
       *
       * 判「几乎一样」而不是「一模一样」：实测 2026-10-25，对方连发两句招呼，
       * 模型给出「你好，咋了」和「你好 咋了」—— 只差一个标点，全等比较拦不住，
       * 连着两条几乎一样的消息看着就是复读机。所以这里抹掉标点与空白再比。
       */
      const squash = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
      if (text && lastReplyText && squash(text) === squash(lastReplyText)) {
        st.repliedAt[`${rd.key}|${m.at}`] = 'skip:same_as_prev'
        if (!DRY) saveState(st)
        log({ tick: 'skip', peer: rd.key, why: 'same_as_prev', text: String(m.text || '').slice(0, 40) })
        continue
      }

      if (DRY) {
        log({ tick: 'draft', to: rd.nickname, peer: rd.key, is_owner: isOwner, text, note: 'dry 不写状态、不发送' })
        continue
      }

      // 优先用 sec_uid（列表里唯一靠谱的稳定 id），没有再退回数字 uid
      const toId = rd.sec_uid || rd.uid || rd.key
      if (!rd.sec_uid) {
        log({
          tick: 'skip', peer: rd.key, why: 'no_sec_uid',
          note: '会话列表里没能把这个人对上号（preview 对不齐），不敢瞎发',
        })
        st.repliedAt[`${rd.key}|${m.at}`] = 'skip:no_sec_uid'
        if (!DRY) saveState(st)
        continue
      }
      const sent = sendDm(text, toId)
      if (sent?.sent) {
        st.repliedAt[`${rd.key}|${m.at}`] = new Date().toISOString()
        st.count += 1
        st.lastText = text
        st.primed[rd.key] = m.at
        saveState(st)
        replied += 1
        lastReplyText = text
        /**
         * 把自己发出去的话也记进记忆 —— 不记的话下一轮 `readDm` 再从抖音读回来
         * 会以为「凭空出现一句话」，而且 `ctx.recent` 里缺自己那一半，
         * 上下文就成了「只有对方问、没有自己答」。
         */
        if (memKey) { try { noteSent(HOME, memKey, rd.nickname || '', text, 'text') } catch { /* ignore */ } }
        log({
          ok: true, sent: true, to: rd.nickname, peer: rd.key, is_owner: isOwner, text,
          readback: sent.readback, to_msg: String(m.text || '').slice(0, 40),
        })

        /**
         * ⭐ 发视频卡片（2026-10-26 使用者：「这个能自动发啊」）。
         *
         * 时机只有两种，都要求「刚好回过一句话」，因为纯甩视频很突兀：
         *   ① 对方**发了视频** → 按 `--video-reply` 概率跟着回一条视频
         *      （他分享了一个，我也回一个，这是最自然的）
         *   ② 对方只是说话   → 按 `--video-idle` 低概率主动分享一个
         * 无论哪种，`canSendVideo()` 的三道闸（开关 / 间隔 / 日上限）都先生效。
         *
         * ⚠️ 必须 try 住：card-share 要开新标签页跑 4 分钟，它挂掉不能把
         *    这一轮的其它消息、更不能把整个常驻循环带崩。
         */
        if (m.card || Math.random() < VIDEO_IDLE_CHANCE) {
          const gate = canSendVideo(st)
          if (!gate.ok) {
            if (gate.why === 'video_gap' && m.card) {
              log({ tick: 'video_skip', why: gate.why, wait_s: gate.wait_s })
            }
          } else {
            const want = m.card ? Math.random() < VIDEO_REPLY_CHANCE : true
            if (want) {
              const cand = pickVideoCandidate(st)
              if (!cand) {
                log({ tick: 'video_skip', why: 'no_candidate', hint: 'forward-pick.json 里没有可用视频，等她刷一轮推荐流' })
              } else {
                const vid = String(cand.aweme_id)
                try {
                  if (DRY) {
                    log({ tick: 'video_draft', to: rd.nickname, aweme_id: vid, desc: String(cand.desc || '').slice(0, 40), note: 'dry 不发' })
                  } else {
                    const vr = sendVideoCard(vid, toId, rd.nickname)
                    if (vr.ok && vr.verified) {
                      st.videoSent[vid] = new Date().toISOString()
                      st.videoCount += 1
                      st.videoLastAt = Date.now()
                      saveState(st)
                      log({
                        ok: true, tick: 'video_sent', to: rd.nickname, peer: rd.key,
                        aweme_id: vid, to_sec_uid: vr.to_sec_uid,
                        desc: String(cand.desc || '').slice(0, 40), evidence: vr.evidence,
                      })
                    } else {
                      log({
                        tick: 'video_fail', aweme_id: vid,
                        error: String(vr.error || '').slice(0, 160),
                        hint: String(vr.hint || '').slice(0, 160) || undefined,
                      })
                    }
                  }
                } catch (e) {
                  log({ tick: 'video_throw', aweme_id: vid, error: String(e?.message || e).slice(0, 140) })
                }
              }
            }
          }
        }
      } else if (sent?.captcha) {
        /**
         * 🔴 抖音弹了验证（实测 2026-10-25：私信页弹「依次点击文字」点选验证，
         *    380×348 可见浮层盖住输入框，insertText 打进去的字直接被吞）。
         *
         *    这里**不自动过验证**：点错一次风控等级就往上升，可能直接把这个号
         *    打成「疑似机器」—— 比起少回一条私信，那个代价大得多。
         *    所以：记一条 needs_verify，停下等人手动点一下。
         *    同一条消息也标成 skip，免得每分钟反复撞同一面墙。
         */
        st.repliedAt[`${rd.key}|${m.at}`] = 'skip:need_verify'
        st.needVerify = { at: new Date().toISOString(), kind: sent.captcha.kind, tip: sent.captcha.tip || '' }
        saveState(st)
        log({
          tick: 'need_verify', peer: rd.key, captcha: sent.captcha,
          note: '抖音弹验证了，这一轮不回；需要本人到这台机器的浏览器里点一下验证',
        })
        break
      } else {
        log({ tick: 'send_fail', peer: rd.key, error: String(sent?.error || sent?.hint || JSON.stringify(sent || {}).slice(0, 160)) })
        break   // 发不出去就停这一轮，别连着重试（跟 at-me-watch 撞 403 的处理一致）
      }
    }
    return replied
  }

  /**
   * ⭐ tick 必须是 async：里面有 `await sayWithModel(...)` 调模型。
   *    调用点用 `void tick().catch(...)` —— 不 await 是故意的（定时器每 30 秒触发，
   *    不等上一轮跑完会叠起来），但**必须挂 catch**，否则模型抛错会变成
   *    unhandledRejection 直接把进程打掉，日志里只会看到「进程退出」查不出原因。
   */
  if (ONCE) { await tick(); return }

  log({ ok: true, msg: '开始盯私信', peer: PEER, max: MAX, every: `${EVERY / 1000}s`, quiet: QUIET, dry: DRY })
  /**
   * 🔴 2026-10-27 加：单飞锁 —— 上一轮没跑完就不许开新一轮。
   *
   * 实测事故（当天 20:12，正好是 `skip:no_sec_uid` 修复后第一次补发那 4 条）：
   * 一轮 tick 从 12:11:53 跑到 12:12:37 共 **44 秒**（要起无头 Chrome、读会话、
   * 对每个人调模型生成、逐条发、回读核实），而 `setInterval` 是 **30 秒**。
   * 于是 30 秒时第二轮起来，读到的还是同一批未标记的消息（第一轮刚发完前两条、
   * 还没来得及 saveState），**两轮并发处理同一批** —— 结果《永恒的爱》那张卡被回了两次，
   * 第一次还文不对题地接着说椎名林檎（模型只看到上一轮遗留的上下文）。
   * 对方视角：连刷 5 条，其中两条重复、一条答错。
   *
   * 修法：一个 `running` 旗标，跑着就直接跳过这一拍（记 `busy` 日志便于排查）。
   * 比「加大 EVERY」稳：慢的一轮不会推迟后面的轮次节奏，只是这一拍不上马。
   */
  let running = false
  const runTick = () => {
    if (running) { log({ tick: 'busy', note: '上一轮还没跑完，这一拍跳过' }); return }
    running = true
    tick()
      .catch((e) => log({ tick: 'crash', error: String(e?.message || e).slice(0, 160) }))
      .finally(() => { running = false })
  }
  /**
   * ⚠️ 这里千万不能写 `t.unref()`。
   *
   * 踩过的坑（2026-10-25，一整天都没在自动回私信）：定时器 unref 之后，
   * Node 认为「没有需要等的东西了」⇒ 进程跑完第一轮 tick 立刻以 code=0 退出。
   * index.js 的守护段看到 code=0 当成正常结束，60 秒后又拉起来 ⇒ 又立刻退出。
   * 日志表现是「已启动 → 进程退出（code=0）」每 60 秒循环一次，
   * 看着一直在跑，实际每条私信都没人回。
   *
   * 常驻进程必须**引用住**定时器，让事件循环保持活着。
   */
  const t = setInterval(runTick, EVERY)
  process.on('SIGTERM', () => { clearInterval(t); process.exit(0) })
  process.on('SIGINT', () => { clearInterval(t); process.exit(0) })
}

main().catch((e) => { log({ ok: false, error: String(e?.message ?? e) }); process.exitCode = 1 })
