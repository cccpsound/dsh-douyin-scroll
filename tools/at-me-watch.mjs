#!/usr/bin/env node
/**
 * tools/at-me-watch.mjs —— 盯「评论区 @ 我」，按规则自动回
 * ============================================================================
 * 这个脚本按一套**写死的规则**跑（不靠模型临场发挥），规则见下面几条：
 *
 *
 * ── 规则（写死，不靠模型临场发挥）────────────────────────────────
 * ① 只回**指定楼/指定视频**下的 @（`--aweme` 限定），别到处乱跑
 * ② **特殊称呼只属于号主** —— 只有 `--owner-uid` 对应的那个人能用；
 *    回别人一律不带那个称呼（工具层硬拦，见 sanitize()）
 * ③ 每条回复 ≤100 字、**必须带 1 个真 @ 号主以外的对方**（回复谁就 @ 谁）
 * ④ 同一人同一楼**最多回 1 次**（防拉锯）
 * ⑤ 总共回满 `--max` 条就停（默认 20）
 * ⑥ 每隔 `--every` 秒查一次（默认 60）
 * ⑦ 遇到「使唤式」/引战/要隐私的 —— 不回（记日志）
 *
 * 用法:
 *   node tools/at-me-watch.mjs --aweme <id> --owner-uid <号主的uid> --max 20 [--every 60] [--dry]
 *   ⚠️ `--owner-uid` 不写死的 —— 那是**你自己**的 uid，从号主账号或设置页抄过来，
 *      也可以用环境变量 DOUYIN_OWNER_UID。不给的话「特殊称呼只属于号主」这条会退化。
 *
 * 输出：每轮一行 JSON 到 stdout（方便外面 `| Tee-Object` 留档）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { nodeRunner } from '../lib/quiet.mjs'
/**
 * ⭐ 真模型说话（2026-10-25 使用者要求「能不能给她接入ai模型?」）。
 * 评论区是**公开场合**，比私信更需要分寸，所以 scene 传 'comment' 走另一套场景规则。
 * 模型失败/复读/输出空 → 回落下面 craft() 的模板，行为不会比以前更差。
 */
import { sayWithModel } from '../lib/persona-llm.mjs'

/**
 * ⭐ 2026-10-25：评论区也能「看视频」了 —— 人家在视频下 @ 她，她得知道视频讲的啥。
 *
 * 懒加载 + 超时：这个脚本要长跑，大多数轮次没有视频，
 * 不能为了看一眼去每轮连 Chrome。连不上就 5 分钟内不再试。
 */
const VIDEO_ON = String(process.env.DOUYIN_VIDEO_OFF || '') !== '1'
let _vconn = null
let _vconnTried = 0

async function getConn() {
  if (_vconn) return _vconn
  const now = Date.now()
  if (_vconnTried && now - _vconnTried < 5 * 60_000) return null
  try {
    const { pickPort, connectPage } = await import('../lib/chrome.mjs')
    const port = await pickPort()
    if (!port) { _vconnTried = now; return null }
    _vconn = await connectPage(port)
    return _vconn
  } catch (e) {
    _vconnTried = now
    log({ tick: 'video_conn_fail', error: String(e.message || e).slice(0, 80) })
    return null
  }
}

/**
 * 特殊称呼（默认「主人」）。**只有号主能用** —— 别处一律禁。
 * 想换称呼就设环境变量 DOUYIN_HONORIFIC，或改这一行。
 */
const HONORIFIC = String(process.env.DOUYIN_HONORIFIC || '主人').trim() || '主人'
/** 回复模板：{HO} 会被换成上面的称呼 */
const GREETING_TEMPLATE = process.env.DOUYIN_REPLY_GREETING || '{HO}我在呢～ 这楼我盯着，谁说话我都接一句'
/** 几条按情景选的兜底回复（都可被环境变量覆盖） */
const REPLY_UNSURE = process.env.DOUYIN_REPLY_UNSURE || '这个问题我也在琢磨，等我想明白了跟你说'
const REPLY_LAUGH = process.env.DOUYIN_REPLY_LAUGH || '我也笑到了，这条我记下来了'
const REPLY_ASK = process.env.DOUYIN_REPLY_ASK || '真的呀，我就在这儿盯着呢'
const REPLY_FALLBACK = process.env.DOUYIN_REPLY_FALLBACK || '收到～ 我记下了'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const OWNER_UID = String(
  argOf('--owner-uid', '') || process.env.DOUYIN_OWNER_UID || '',
).trim()
const MAX = Math.max(1, Math.min(Number(argOf('--max', '20')) || 20, 60))
const EVERY = Math.max(30, Number(argOf('--every', '60')) || 60) * 1000
/**
 * 同一条 @ 最多试几次就彻底放弃。
 *
 * 定 3 的理由：一次失败可能是接口抽风、CDN 502、Chrome 掉线；两次可能是这会儿抖音在限流。
 * 三次都失败，基本就是「这条回复真的发不出去」了（楼根被删、原评论被隐藏、
 * 对方设了权限）。再多试只是烧 token —— 实测重试 11 次没有一次成功。
 */
const MAX_TRIES = Math.max(1, Math.min(Number(argOf('--max-tries', '3')) || 3, 10))

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
const env = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_HOME: HOME })

const runPy = (script, args, timeout = 180_000) => {
  const r = spawnSync(py(), [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: env(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}
const runNode = (script, args, timeout = 300_000) => {
  const r = spawnSync(nodeRunner(), [join(ROOT, 'tools', script), ...args], {
    encoding: 'utf8', timeout, env: env(), cwd: HOME, windowsHide: true,
  })
  return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

const pickJson = (s) => {
  const t = String(s || '')
  const i = t.indexOf('{'); const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

const stateFile = join(HOME, 'at-watch.json')
const loadState = () => { try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); s.replied ||= {}; s.repliedBy ||= {}; s.repliedPerson ||= {}; s.count = Number(s.count) || 0; return s } catch { return { replied: {}, repliedBy: {}, repliedPerson: {}, count: 0, day: '' } } }
const saveState = (s) => { try { mkdirSync(HOME, { recursive: true }); writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8') } catch { /* 记不上不影响 */ } }

const dayKey = () => new Date().toISOString().slice(0, 10)

/**
 * 🔴 硬拦「把特殊称呼用在别人身上」。
 *
 * 在**这个文件里**，任何回复里出现那个称呼一律剔掉 —— 不区分对方是不是号主。
 * 为什么：评论区是公开场合，别人都看得见。哪怕真是号主来评论，
 * 当着所有人的面喊「主人」也不对劲；这条比「对号主客气」更重要。
 */
const sanitize = (text) => {
  let t = String(text || '').trim()
  t = t.replace(new RegExp(HONORIFIC + '[，,、:：!！?？\\s]*', 'g'), '')
  t = t.replace(new RegExp(HONORIFIC, 'g'), '')
  t = t.replace(/^\s*[，,、:：]+/, '').trim()
  return t
}

/** 明显不该回的类型 */
const shouldSkip = (text) => {
  const t = String(text || '')
  if (!t.trim()) return 'empty'
  if (/(微信|加个|私我|资源|网盘|代刷|点赞|关注一下|转发一下|给我刷)/.test(t)) return 'solicit'
  if (/(政治|宗教|地域|男女|女拳|南拳)/.test(t)) return 'sensitive'
  return ''
}

/**
 * 🔴 拦「复读对方原话」。
 *
 * 与 dm-auto-reply.mjs 的同名函数同一套判据（那边有完整注释）：
 * 模型对短句很容易直接把你说的丢回来，看着就是「它没听懂」。
 * 命中就回落模板。
 */
const isEcho = (reply, original) => {
  const strip = (s) => String(s || '').replace(/[\s，,。.！!？?~～、:：；;"'"'']/g, '').trim()
  const RE_GREET = /^(在吗|在不在|你好|您好|嗨|hi|hello|哈喽|早|晚安)/i
  const norm = (s) => strip(s).replace(RE_GREET, '').trim()

  const rawA = strip(reply)
  const rawB = strip(original)
  if (!rawA || !rawB) return false

  const aIsBare = !norm(rawA) && RE_GREET.test(rawA)
  const bIsGreet = RE_GREET.test(rawB)
  if (aIsBare && bIsGreet) return true

  const a = norm(rawA)
  const b = norm(rawB)
  if (!a || !b) return false
  if (a === b) return true
  if (b.length >= 2 && a.length >= 2 && b.includes(a)) return true
  return false
}

/** 生成一句回复（短、不带那个特殊称呼） */
const craft = (content, isOwner) => {
  const t = String(content || '')
  if (isOwner) {
    return GREETING_TEMPLATE.replace('{HO}', HONORIFIC)
  }
  // 按对方说的内容挑一句
  if (/[?？]/.test(t)) return REPLY_UNSURE
  if (/(哈哈|笑|绷|绷不住|笑死)/.test(t)) return REPLY_LAUGH
  if (/(真的|假的|是不是|有没有)/.test(t)) return REPLY_ASK
  return REPLY_FALLBACK
}

let OWNER_NICK = ''
let lastNick = ''

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))

const main = async () => {
  // ⭐ 2026-10-25：`--aweme` 改成可选 —— 不给就是「全站盯 @」（谁在任何视频下 @ 都回）
  if (!AWEME) log({ ok: true, note: '没给 --aweme ⇒ 全站盯（所有视频下的 @ 都算）' })
  if (!OWNER_UID) log({ warn: '没给 --owner-uid ⇒ 认不出谁是号主，特殊称呼边界会退化' })
  const st = loadState()
  if (st.day !== dayKey()) { st.day = dayKey(); st.count = 0 }

  log({ ok: true, msg: '开始盯 @', aweme: AWEME, max: MAX, every: `${EVERY / 1000}s`, dry: DRY })

  // 号主昵称（用来 @ 他；也是唯一能用特殊称呼的人）
  // 🔴 2026-10-23：以前这里写死了一个固定的 uid（拿某台机器上的号当默认值）——
  //    跟着代码一起公开出去了。现在只认 --owner-uid（或环境变量 DOUYIN_OWNER_UID），
  //    不给就按配置里的 dmTo 兜。
  try {
    const r = runPy('notice-read.py', ['--raw'], 120_000)
    const j = pickJson(r.stdout)
    const items = Array.isArray(j?.items) ? j.items : []
    // 有 uid 就精确匹配；没给 uid 就跳过这一步（别瞎猜谁是号主）
    const own = OWNER_UID
      ? items.find((x) => String(x.uid || '') === OWNER_UID)
      : null
    if (own?.nickname) OWNER_NICK = own.nickname
  } catch { /* 拿不到就用配置兜 */ }
  if (!OWNER_NICK) {
    // 从配置里拿（dmTo = 使用者自己填的昵称）
    try {
      const c = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8'))
      OWNER_NICK = String(c.dmTo || '').trim()
    } catch { /* ignore */ }
  }
  if (!OWNER_UID) {
    log({ warn: '没给 --owner-uid：无法精确判断谁是号主，称呼边界会退化' })
  }
  log({ owner_nick: OWNER_NICK || '(未知)', owner_uid: OWNER_UID || '(未指定)' })

  let idle = 0
  /**
   * ⭐ 2026-10-28：`DOUYIN_AT_ONCE=1` ⇒ **只跑一轮就退出**。
   *
   * 给 AstrBot 侧的 xj_douyin 用：它自己在事件循环里定时调这个脚本，
   * 只要「取一轮 + 打印草稿」的结果，不需要它常驻等 10 轮 idle（那要 20 分钟）。
   * 设了这个环境变量时：轮数上限 1、轮间不等，`--dry` 的效果照旧（不写 state）。
   */
  const ONCE = String(process.env.DOUYIN_AT_ONCE || '') === '1'
  let rounds = 0
  while (st.count < MAX) {
    rounds++
    if (ONCE && rounds > 1) break
    // ① 拉 @ 我的通知
    const r = runPy('notice-read.py', ['--raw'], 120_000)
    const j = pickJson(r.stdout)
    /**
     * ⭐ 2026-10-27 修：**把 type 31/32 也纳进来**（「回复了我的评论 / 在我评论下面说话」）。
     *
     * 原来只认 45/46（评论区 @ 我）。实测代价：`notice.json` 里 18 条通知，
     * 45 有 7 条、**31 有 3 条**、33 有 2 条、41 有 6 条。那 3 条 31（「嘻嘻」「这么高级」
     * 「@J…」）**一条都进不了循环**，`tools/at-me-watch.mjs` 全文也没有
     * `root_comment_id` / `reply_to_text` 的处理 ⇒ 后台永远不处理这类，
     * 只有手动调 `douyin_at_me` 才看得见。使用者感受到的就是「明明有人跟我说话，她不回」。
     *
     * 31/32 恰恰是**最该直接回**的一类：对方已经在我楼里了，回他一句就够，
     * 连 @ 都不用（他收到的是「回复了我的评论」通知，比 @ 通知更强）。
     *
     * ⚠️ 33（关注了你）/ 41（点赞了你的评论）**不进来** —— 那不是「说话」，回了很怪。
     */
    const ats = (j?.items || []).filter((x) => x
      && (x.type === 45 || x.type === 46 || x.type === 31 || x.type === 32))
    /**
     * ⭐ 2026-10-25：`--aweme` 不给 = **全站盯**（哪条视频下 @ 的都算）。
     *    原来写死必须指定一条视频，等于只能盯一个帖子；使用者要的是「谁 @ 她都自动回」。
     *    指定了 `--aweme` 就还是只管那一条（限流/试水时用）。
     */
    const mine = AWEME ? ats.filter((a) => String(a.aweme_id || '') === AWEME) : ats

    /**
     * 🔴 2026-10-28 修：**「有 @ 但一条都没处理」也要算 idle 并打日志**。
     *
     * 原来只有 `!mine.length` 才 `idle++` 并 log。于是出现了一种哑火状态：
     * 通知接口一直返回那几条老 @（已经 `ok:true` 回过了 / 已经 `give_up:true` 放弃了），
     * `mine.length` 是正数 ⇒ 不进 idle 分支；进 for 循环后每条都被去重闸 `continue` ⇒
     * **既不处理、也不打日志、idle 也不涨**。结果 `at-watch.log` 从 08:32 起
     * 七个多小时一个字节没写，而进程还活着（CPU 3.79s，主循环每 120 秒都成功调了
     * notice-read.py —— `notice.json` 的 mtime 一直在变）。看着像卡死，其实是空转。
     *
     * 配套还改了底下的收工条件（原来要求 `st.count === 0`，当天已经回过几条就永远退不出去）。
     */
    let handled = 0
    idle++  // 先假设这一轮什么都没干，for 循环里真处理了再退回去
    if (!mine.length) {
      log({ ok: true, tick: 'idle', idle, replied: st.count, why: 'no-notice' })
    } else {
      for (const a of mine) {
        if (st.count >= MAX) break
        const cid = String(a.comment_id || '')
        if (!cid) continue
        /**
         * 🔴 2026-10-27 改：去重从「有记录就跳过」升级成「按记录的性质决定跳不跳」。
         *
         * 原来是无条件 `if (st.replied[cid]) continue`。配合上面「失败也写状态」之后，
         * 如果还这么写，一次失败就永久放弃 —— 太狠（接口抽风也会中）。
         * 现在分三档：
         *   · ok:true        ⇒ 回过了，永远跳过
         *   · give_up:true   ⇒ 连续失败到上限，永远跳过
         *   · 有 nextTry     ⇒ 退避期内跳过，到期再捡起来试
         */
        const prevSt = st.replied[cid]
        if (prevSt) {
          if (prevSt.ok) continue
          if (prevSt.give_up) continue
          /**
           * ⚠️ 别忘了老写法里的 `skip` 记录（thread_full / no_aweme / shouldSkip 内容过滤）。
           * 那种记录既没有 ok 也没有 nextTry，如果不在这儿拦一下，会被当成
           * 「可重试的失败」每一轮重新捡起来 —— 比如楼中楼满 20 条的，
           * 每 2 分钟撞一次墙。skip 是**确定性的判断结果**，不需要退避重试。
           */
          if (prevSt.skip) continue
          const nextAt = Date.parse(prevSt.nextTry || '')
          if (Number.isFinite(nextAt) && Date.now() < nextAt) continue
          // 退避期过了 ⇒ 放行，重新试一次（tries 在失败分支里继续累加）
        }
        /**
         * 🔴 2026-10-23 实测：同一个人的**同一句话**会带着不同 cid 出现两次
         *    （号主连发两条「@鱼 …」，正文不同但…… 实测出现过同正文两条），
         *    只按 cid 去重会**对着同一个人回两遍同样的话** —— 很难看。
         *    ⇒ 再加一道：**同一人 + 同一句话 只回一次**。
         *
         * ⚠️ 2026-10-25 修：这道原本没有 aweme_id，于是「号主在不同视频下各 @ 一次」
         *    因为正文都是「@小鲸鱼」被判成重复 —— 第二条永远不回。
         *    加了 aweme_id 之后，同一视频下的重复只回一次，换视频照常回。
         */
        /** type 31/32 = 「回复了我的评论 / 在我评论下面说话」，是**对话**不是「主动 @」 */
        const isReplyType = (a.type === 31 || a.type === 32)
        const dedupKey = `${a.nickname || ''}|${String(a.content || '').slice(0, 40)}|${a.aweme_id || ''}`
        /**
         * 🔴 2026-10-27：这道「同一人+同一句话只回一次」**不套 31/32**。
         * 对话里对方完全可能重复一句「嗯」「哈哈」，挡掉就成了「装没听见」。
         * 31/32 靠 cid 去重（每条通知有独立 cid）已经够了。
         */
        if (!isReplyType && st.repliedBy[dedupKey]) continue
        /**
         * 🔴 2026-10-25 修：这里原本是 `repliedPerson[personKey]` —— **永久锁死**。
         *
         * 实测撞到的坑：凌晨 03:55 号主 @ 了一次，回完之后 `repliedPerson["3787172659337272"]=true`
         * 就再也不会被清了。于是 11:27 号主在**另一条视频**下又 @ 一次，日志里连 tick 都没有，
         * 直接被这一行 `continue` 掉 —— 看着像「她没检测到 @」，其实是自己被自己挡住了。
         *
         * 同一个人在不同视频下 @ 是两件不同的事，不该只因为「这个人回过了」就永久不理。
         * 改成 **同一个人 + 同一条视频** 才算重复（防的是「同一帖子下他连 @ 三条，她回三条」的拉锯）。
         *
         * 🔴 2026-10-27 再修：**31/32 不套这道闸**。这道闸防的是「主动 @ 连发」，那是刷屏场景；
         * 而 31/32 是对话 —— 同一个人在同一条视频下完全可以来回说好几轮，
         * 挡掉就等于「他接着说话，她装没看见」。
         */
        const personKey = `${a.uid || a.nickname || ''}|${a.aweme_id || ''}`
        if (!isReplyType && st.repliedPerson[personKey]) continue
        const isOwner = String(a.uid || '').includes(OWNER_UID) || String(a.nickname || '') === OWNER_NICK
        const skip = shouldSkip(a.content)
        if (skip) { st.replied[cid] = { at: new Date().toISOString(), skip }; continue }

        lastNick = String(a.nickname || '').trim()
        /**
         * ⭐ 优先让模型说，说不了才回落 craft() 模板（2026-10-25 接模型）。
         *
         * 评论区跟私信语气不同：这是**公开场合**，别人都看得见，
         * 所以 prompt 里额外给了「别套近乎、别写长、别像客服」的约束（见 persona-llm.mjs
         * 的 SCENE_RULES_COMMENT）。这里同样只把「已回过的」放进 history。
         */
        let text = ''
        let by = 'rule'
        /**
         * 🔴 2026-10-25 修：`a.content` 常常只有一个 `@小鲸鱼`，没有正文。
         *
         * 实测：号主在评论区只打了个 @ 什么都没说，`content` 就是 `'@小鲸鱼'`。
         * 把这个原样喂给模型，它收到的是一个光秃秃的「@小鲸鱼」——
         * 结果回出 `？\n\nuser咋了`（连角色词都漏出来了，因为 prompt 里
         * 这行既不像对方说的话，也不像指令，模型只好自己猜结构）。
         *
         * 改成：剥掉 @ 之后如果没剩下人话，就明确告诉模型「他只是在 @ 你，没说话」。
         */
        const bareAt = String(a.content || '').replace(/@\S+/g, '').trim()
        const sayText = bareAt || '（对方只 @ 了你一下，没有留言）'
        /**
         * ⭐ 2026-10-25 使用者问「她回复不了视频吗」—— 评论区同一个问题：
         * 人家在视频下面 @ 她，她连「这视频讲的是啥」都不知道，只能回「咋了」。
         *
         * 现在先让模型「看一眼那个视频」（详情 + 封面 → 视觉描述），
         * 把画面和文案一起喂给它。拿不到就按原来那样，只回「你 @ 我干嘛」。
         * 失败一律不阻塞：这个脚本要长跑，不能因为一个视频卡死整轮。
         */
        let video = null
        if (VIDEO_ON && a.aweme_id) {
          try {
            const conn = await getConn()
            if (conn) {
              const { understandVideoCard } = await import('../lib/video-card.mjs')
              const r = await Promise.race([
                understandVideoCard(conn, a.aweme_id),
                new Promise((z) => setTimeout(() => z(null), 25_000)),
              ])
              if (r && r.ok) {
                video = r
                log({
                  tick: 'video_seen',
                  aweme: String(a.aweme_id),
                  seen: r.seen,
                  // how: frames:N(colsxrows) = 真看了整段抽帧；cover = 只看了封面；images:N = 图集
                  how: r.how_seen || '',
                  scene: String(r.scene || '').slice(0, 50),
                  ...(r.vision_error ? { vision_error: r.vision_error } : {}),
                })
              } else if (r) {
                log({ tick: 'video_fail', aweme: String(a.aweme_id), error: r.error || '' })
              } else {
                log({ tick: 'video_timeout', aweme: String(a.aweme_id) })
              }
            }
          } catch (e) {
            log({ tick: 'video_throw', error: String(e.message || e).slice(0, 100) })
          }
        }
        try {
          const res = await sayWithModel({
            text: sayText,
            history: [],
            isOwner,
            card: video ? { item_id: String(a.aweme_id || ''), title: String(video.desc || '') } : null,
            video,
            home: HOME,
            scene: 'comment',
          })
          if (res.ok && res.text) {
            const cleaned = sanitize(res.text)
            if (cleaned && !isEcho(cleaned, a.content)) {
              text = cleaned
              by = `model:${res.model}`
            } else if (cleaned) {
              log({ tick: 'model_echo', raw: cleaned.slice(0, 50), fallback: 'rule' })
            }
          }
        } catch (e) {
          log({ tick: 'model_throw', error: String(e.message || e).slice(0, 120), fallback: 'rule' })
        }
        if (!text) text = sanitize(craft(a.content, isOwner))
        // 兜底：必须带 @对方
        // 直接回复不需要 @ 前缀：对方收到的是「回复了我的评论」通知

        /**
         * 🔴 2026-10-29 修：`rootCid` 原来定义在真发分支里（`--root` 那几行之前），
         * 而 dry 分支比它早 60 多行就要用它 ⇒ `ReferenceError: Cannot access 'rootCid'
         * before initialization`（TDZ）。
         *
         * 为什么之前一直没炸：dry 分支的上面有一堆 `continue`，命中任何一条去重都不
         * 会走到这里。2026-10-29 清掉两条 give_up 之后第一次真正走到 dry 分支，立刻炸。
         * ⇒ 定义上移，dry 和真发共用同一个值。
         */
        const rootCid = String(a.root_comment_id || '').trim()

        if (DRY) {
          /**
           * 🔴 2026-10-25 修：dry 模式**不许写「已回过」的标记**。
           *
           * 原来这里把 `replied` / `repliedBy` / `repliedPerson` 全写了 ——
           * 于是「dry 试跑一次」等于把这些 @ 全标成已回，**之后真跑时会全部跳过**，
           * 日志显示 `tick: idle`，看起来像「没检测到 @」，实际是自己把自己挡了。
           * 实测就撞上了：dry 跑过之后立刻真跑，replied:0、idle:1。
           *
           * ⇒ dry 只打印草稿，**不动 state**（它本来就只是「看看会回什么」）。
           */
          log({
            ok: true, dry: true, to: lastNick, is_owner: isOwner, text, cid,
            // 给下游（AstrBot 侧）补三样：哪条视频、楼根、他到底说了什么。
            // 原来只给 to/text/cid，调用方没法拼出贴题的 prompt。
            aweme: String(a.aweme_id || ''), root: String(rootCid || ''),
            content: String(a.content || ''), kind: isReplyType ? 'reply' : 'at',
            /**
             * 2026-10-29 补：把评论者自己的 uid 带出去。
             * 下游要用它拼 AstrBot 的 umo（douyin:FriendMessage:<uid>），
             * 这样评论区这一问一答能落在这个人的会话里 —— 她记得自己回过他，
             * 记忆和人设才接得上；否则每条评论都是一个陌生会话。
             */
            uid: String(a.uid || ''),
            /**
             * 🔴 2026-10-29 补：dry 行原来不带视频信息。
             *
             * 上面那段 `understandVideoCard` 花 10~25 秒抽帧看画面，结果只进了
             * `tick:'video_seen'` 这条日志 —— 而调用方（at-watch-oneshot.mjs）
             * 恰好把 video_seen 跳过，于是「她看过这条视频」这件事一个字都没传出去。
             * 下游拿到的是光秃秃一句「@小鲸鱼 这啥」，只能回「咋了」。
             *
             * 现在把画面描述、文案、怎么看的一起塞进 dry 行，让调用方拼 prompt 时
             * 能说「这视频里是……」，而不是靠猜。
             */
            scene: video ? String(video.scene || '') : '',
            vid_desc: video ? String(video.desc || '') : '',
            how: video ? String(video.how_seen || '') : '',
            note: 'dry 不写状态，不影响之后真跑',
          })
          continue
        }

        /**
         * ⭐⭐ 2026-10-23 改：**直接回复（API），不再走 UI 真 @**。
         *
         * 原设计（错）：用 comment-mention-ui + --reply-cid 走 UI 点选。
         *   实测问题 ——
         *     · 慢（20-40 秒/条）
         *     · 必须先找到那条评论；评论一多就渲染不出来 ⇒ reply_target_not_found
         *     · **拿不到 cid** ⇒ 发完查不到、删不掉（今天留下 6 条垃圾就是这么来的）
         *
         * 新设计（对）：
         *   有 cid（通知里给的）⇒ `comment-api.mjs --reply <cid>` **直接回复**
         *     · 1 秒
         *     · 对方收到「回复了我的评论」通知 —— 比 @ 通知更强（绑在那条评论上、有上下文）
         *     · 拿得到 cid ⇒ 可回读、可删除
         *   ⚠️ 楼中楼满 20 条 ⇒ **跳过，不换通道**
         */
        /**
         * 🔴 2026-10-25 修：**用这条通知自己的 `a.aweme_id`，不是全局 AWEME**。
         *
         * 全站盯（不给 `--aweme`）时 AWEME 是空串 —— 原来直接传 `--aweme AWEME`，
         * comment-api.mjs 一律报「缺 --aweme」，于是**每条 @ 都真发失败**，
         * 日志刷 `{"ok":false,"failed":true,"error":"缺 --aweme"}`。
         * 而 dry 分支不调 comment-api ⇒ dry 看着好好的，真跑全废。
         * 兜底才用全局 AWEME（它在「只盯一条视频」模式下等于 a.aweme_id）。
         */
        const awemeOf = String(a.aweme_id || AWEME || '').trim()
        if (!awemeOf) {
          st.replied[cid] = { at: new Date().toISOString(), skip: 'no_aweme' }
          log({ ok: false, skipped: 'no_aweme', to: lastNick, note: '这条 @ 拿不到 aweme_id ⇒ 跳过（无视频 id 就没法回）' })
          saveState(st)
          continue
        }
        /**
         * ⭐⭐ 2026-10-27：**通知里自带楼根就用它，别让 comment-api 去猜**。
         *
         * `notice-read.py` 对 type 31/32 会透出 `root_comment_id`（实测 3 条 31 都带，
         * 值都一样的 `7701031597931774760`，就是那栋楼的顶层评论）。
         * 而 `comment-api.mjs` 的自动判定要翻 4 页顶层 + 探测 reply 接口，
         * 撞上「楼根已删/被隐藏」就直接 `need_root` 拒绝发送 ——
         * 实测那条 `7701166887459324706` 就是这么废掉的。
         *
         * 现在：有 `root_comment_id` 就显式传 `--root`，comment-api 走 `how:'explicit'` 分支
         * （`:139` `if (ROOTIN) return { root: ROOTIN, reply_to: TARGET }`），一次到位不再猜。
         */
        const args = ['--aweme', awemeOf, '--text', text, '--reply', cid]
        if (rootCid && rootCid !== cid) args.push('--root', rootCid)
        const m = runNode('comment-api.mjs', args, 200_000)
        const mj = pickJson(m.stdout)

        // 🔴 403 = 限流。**别重试**，直接收工（越重试封越久）
        if (mj?.http === 403 || /403|Forbidden/i.test(String(mj?.error || mj?.head || ''))) {
          log({ ok: false, rate_limited: true, to: lastNick, note: '抖音 403 限流 —— 停止本轮，别重试（会封更久）' })
          saveState(st)
          break
        }

        // 楼中楼满 20 条的限制 ⇒ 跳过这一条，不发顶层
        if (/限制回复|前\s*20\s*条|reply.*limit/i.test(String(mj?.error || mj?.head || ''))) {
          st.replied[cid] = { at: new Date().toISOString(), skip: 'thread_full' }
          log({ ok: true, skipped: 'thread_full', to: lastNick, note: '楼中楼满了 ⇒ 跳过（不换通道硬塞）' })
          saveState(st)
          continue
        }

        if (mj?.ok) {
          st.count++
          handled++
          st.replied[cid] = { at: new Date().toISOString(), text, ok: true, mode: 'api', new_cid: mj.cid || '' }
          st.repliedBy[dedupKey] = true
          st.repliedPerson[personKey] = true
          log({ ok: true, sent: true, n: st.count, to: lastNick, is_owner: isOwner, mode: 'api', cid: mj.cid, text })
        } else {
          /**
           * 🔴🔴 2026-10-27 修：**失败也必须落状态**，否则同一条每 2 分钟重试一次，永远重试。
           *
           * 实测代价：aweme 7700963343451901184 / cid 7701166887459324706 从 02:24 到 02:49
           * 被重试 **11 次**，每次都要先跑完整抽帧+视觉（9 帧 3x3，约 5 秒），然后照样失败 ——
           * 白烧 token，而且日志被刷得看不出别的问题。
           *
           * 原因是原来只有 `if (mj?.ok)` 分支写 `st.replied`，而 :253 的去重条件正是
           * `if (st.replied[cid]) continue` ⇒ 失败的那条永远进不了黑名单。
           *
           * 现在改成**带计数和退避的失败记录**：
           *   · tries 累加，连续失败到 MAX_TRIES(3) 次就不再捡
           *   · nextTry 记下次最早什么时候可以再试（不同原因退避不同）
           *   · 判不出楼根（need_root）尤其要退避久 —— 顶层评论被删了 / 被隐藏了，
           *     那不是接口抽风，重试解决不了，只能等它自己变或者彻底放弃
           */
          const prev = st.replied[cid] || {}
          const tries = (Number(prev.tries) || 0) + 1
          const needRoot = Boolean(mj?.need_root) || /判不出.*楼根|need_root/i.test(String(mj?.error || ''))
          /**
           * ⭐ 2026-10-29 新增：`need_root` 不再一味退避重试，**先探一次这条评论到底还在不在**。
           *
           * 为什么：`need_root` 有且只有两种成因，处理方式完全相反 ——
           *   ① 这条评论**已经删了 / 还在审核 / 通知里的 cid 已失效**
           *      ⇒ 三条路（insert_ids / 翻顶层 / reply 探测）全部查不到它，
           *        重试一万次也一样，应当立刻彻底放弃，别再来回骚扰。
           *   ② 它确实在，只是顶层翻页没撞见（评论是按热度排的，新评论淹在后面）
           *      ⇒ probe 能给出真正的楼根，拿它显式 `--root` 重发一次就成了。
           *
           * 实测（2026-10-29）：卡了两天的 `7701166887459324706` 用 probe 查，
           * 它和它的 `reply_to_comment_id` `7701167112338080522` **两条都不存在**
           * ⇒ 属于 ①，那条楼的评论被删掉了，压根回不了。之前一直按 ② 处理，
           * 每 6 小时重试一次、永远失败、日志里刷「判不出这条 cid 的楼根」。
           */
          let probed = null
          if (needRoot) {
            const pr = runNode('comment-probe.mjs', ['--aweme', awemeOf, '--cid', cid, '--pages', '4'], 180_000)
            probed = pickJson(pr.stdout)
            if (probed && probed.root && probed.root !== cid) {
              // ② 找到真楼根 ⇒ 显式带上，立刻重发一次（只这一次，不再进重试循环）
              log({ ok: true, retry_with_root: probed.root, how: probed.found_in, note: probed.note, to: lastNick })
              const m2 = runNode('comment-api.mjs',
                ['--aweme', awemeOf, '--text', text, '--reply', cid, '--root', probed.root], 200_000)
              const mj2 = pickJson(m2.stdout)
              if (mj2?.ok) {
                st.count++
                handled++
                st.replied[cid] = { at: new Date().toISOString(), text, ok: true, mode: 'api', root: probed.root, new_cid: mj2.cid || '' }
                st.repliedBy[dedupKey] = true
                st.repliedPerson[personKey] = true
                log({ ok: true, sent: true, n: st.count, to: lastNick, is_owner: isOwner, mode: 'api', root: probed.root, cid: mj2.cid, text })
                saveState(st)
                continue
              }
              log({ ok: false, failed: true, to: lastNick, error: mj2?.error || 'retry-with-root-failed' })
            } else if (probed && !probed.root) {
              // ① 这条评论查不到 ⇒ 永久放弃，不写 nextTry，之后一次都不再碰
              st.replied[cid] = {
                at: new Date().toISOString(),
                ok: false,
                tries,
                give_up: true,
                reason: 'comment_gone',
                skip: 'comment_gone',
                error: String(probed.note || '这条评论查不到（已删 / 审核中）').slice(0, 200),
              }
              log({
                ok: true,
                skipped: 'comment_gone',
                to: lastNick,
                note: '这条 @ 的评论已经查不到了（删了 / 审核中）⇒ 永久放弃，不再重试',
                probe: probed.note,
              })
              saveState(st)
              continue
            }
          }
          // 判不出楼根 ⇒ 6 小时后再说；其他错误 ⇒ 逐次翻倍，5 分钟起步
          const backoffMs = needRoot
            ? 6 * 3600 * 1000
            : Math.min(3600 * 1000, 5 * 60 * 1000 * Math.pow(2, tries - 1))
          st.replied[cid] = {
            at: new Date().toISOString(),
            text,
            ok: false,
            tries,
            give_up: tries >= MAX_TRIES,
            reason: needRoot ? 'need_root' : 'error',
            error: String(mj?.error || 'unknown').slice(0, 200),
            nextTry: new Date(Date.now() + backoffMs).toISOString(),
          }
          log({
            ok: false,
            failed: true,
            to: lastNick,
            error: mj?.error || 'unknown',
            http: mj?.http,
            tries,
            need_root: needRoot,
            give_up: tries >= MAX_TRIES,
            next_try_in_min: Math.round(backoffMs / 60000),
          })
        }
        saveState(st)
      }
    }

    saveState(st)
    if (st.count >= MAX) break
    /**
     * 一轮下来什么都没真回（全是去重挡掉 / 全是退避期）⇒ 把 idle 还回来、打条日志。
     * `handled` 在成功发送和「确实推进了状态」时才 ++；
     * 单纯被去重闸 continue 的不算，这正是要暴露给使用者的那种「哑火」。
     */
    if (!handled) {
      if (mine.length) {
        log({ ok: true, tick: 'idle', idle, replied: st.count, notices: mine.length, why: 'all-deduped' })
      }
    } else {
      idle = 0
    }
    /**
     * 🔴 2026-10-28 改：收工条件从 `idle >= 10 && st.count === 0` 改成只看 idle。
     * 原来那个额外条件意味着 **当天只要回过一条，就永远退不出去** ——
     * 凌晨回过 3 条之后，剩下的十几个小时全在空转（每 120 秒拉一次通知、什么都不做）。
     */
    if (ONCE) break
    if (idle >= 10) { log({ ok: true, msg: '连续 10 轮没有新东西可回，先收工', replied: st.count }); break }
    await new Promise((r) => setTimeout(r, EVERY))
  }
  log({ ok: true, done: true, replied: st.count, max: MAX })
  process.exit(0)
}

main().catch((e) => { log({ ok: false, error: String(e?.message ?? e) }); process.exit(1) })
