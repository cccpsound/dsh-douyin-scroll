/**
 * dsh-douyin-scroll —— host 半端
 * ============================================================================
 * 它是一条**完整的值班链路**（架构参考 dsh-bili-scroll，判据层换成抖音的）：
 *   1. 采集/预筛直接调 `tools/*.py`（只读接口 tab/feed + hot/search），
 *      不再有内置 Python MCP / bb-browser / playwright 那一套。
 *   2. 谷时定时器：中午 12:00–14:00、夜间 18:00–09:00（`lib/state.mjs` 的 WINDOWS）。
 *   3. 「跑一轮」= 先在插件里抓好证据包 `round-evidence.json`，再起一个
 *      `dsh --profile headless --patch <overlay> <prompt>`，把 `duty.md` 交给它，
 *      报告写进 `<家>/out/<日期>.md`。
 *   4. 设置页（`client.js`）通过 `/api/douyin-duty/*` 读写配置、看状态、存 Cookie、测通知。
 *
 * 家里（`$DSH_HOME/douyin-duty/`）都有什么：
 *   `config.json` / `collector.json` / `forward-pick.json` / `round-evidence.json` /
 *   `duty.md` / `out/` / `inbox/` / `duty.log` / `health.json`
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// ⭐ 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
//    起因见 lib/hostdeps.mjs：它们是 optional peer，桌面版 profile 永远不装 ⇒ 裸 import 会整条不激活。
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS, stateDirOf, readJson, writeJson, ensureHomeFiles, ensureCharter, charterPath, inWindow, dayKey, windowDayKey, redactCookie } from './lib/state.mjs'
import { saveCookie, readCookie, hasCredential, credentialInfo, clearCredential, cookiePath } from './lib/credential.mjs'
import { sendWebhook, condense, maskUrl } from './lib/notify.mjs'
import { whichInPath } from './lib/quiet.mjs'
import { sendToast, toastSummary } from './lib/toast.mjs'
import { ensureUv } from './lib/uvfetch.mjs'
import {
  loadDmMemory, mergeDmMemory, noteSent, addFacts, dmContext,
  loadCommentMemory, noteMyComment, markSeen,
  memoryStats, forgetDm, forgetAll,
} from './lib/memory.mjs'

export const name = 'douyin-scroll'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段
 *    （`volatileForm(schema)`），没有这个标记写设置时会抛 "Plugin entry … has no volatile fields"。
 *    另外两个条件：**loader entry 的 id 必须等于命名空间名**（patch 里就是 `douyin-scroll`）+ 本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  /** 每天最多挑几条（0 = 不自动刷，但还能手动跑） */
  perDay: z.natural().default(5).extra('volatile', true),
  /** 每次最多筛选几个候选（送给模型判断的上限，省 token） */
  maxPerRun: z.natural().default(12).extra('volatile', true),
  /** 峰谷自动刷（总开关） */
  peakValley: z.boolean().default(false).extra('volatile', true),
  /** 峰谷子开关：中午 / 晚上（内置窗口，保留兼容） */
  noon: z.boolean().default(true).extra('volatile', true),
  night: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐ 自定义时段：`[{ start: '12:00', end: '14:00', label: '中午' }]`
   *    - 支持跨零点（`23:00`–`02:00`）
   *    - 和内置的中午/晚上**叠加**：只要有任意一个窗口命中就跑
   *    - 空数组 = 只用内置那两个开关
   *    - 每个时段每天只用一次（跟内置窗口同一套去重）
   */
  windows: z.array(z.object({
    start: z.string(),
    end: z.string(),
    // ⚠️ 2026-10-22：这里原来写 `z.string().optional()` —— 但这个 schemastery 版本
    //    的字符串**没有 .optional() 方法**，整个 index.js 在 import 阶段就抛
    //    `TypeError: z.string(...).optional is not a function` ⇒ 插件 fiber 建不起来
    //    ⇒ fiberPhase 永远是 null ⇒ 设置页没有面板、工具也不注册。
    //    改用 .default('') 代替（效果一样：可以不给，给了就用）。
    label: z.string().default(''),
  })).default([]).extra('volatile', true),
  /** 关注关键词（空了用 duty.md 里默认那几组） */
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  /** 推荐流分类（游戏 / 美食 / 搞笑 …） */
  channels: z.array(z.string()).default([]).extra('volatile', true),
  /** 指定作者（sec_uid 或主页链接） */
  authors: z.array(z.string()).default([]).extra('volatile', true),
  /** 文案太短（<N 字）**且**评论少 ⇒ 直接跳过 */
  minDescLen: z.natural().default(12).extra('volatile', true),
  /** 评论数 <N **且** 文案短 ⇒ 直接跳过 */
  minComments: z.natural().default(3).extra('volatile', true),
  /** 自动评论并 @（默认关 —— 会拿用户的号说话） */
  autoComment: z.boolean().default(false).extra('volatile', true),
  /**
   * ⭐ **自动发送总开关**（2026-10-22 用户要求）
   *
   * 含义：**插件自己在后台跑一轮时**，允不允许它往外发东西
   *      （私信 / 分享卡片 / 评论）。
   *
   * 🔴 2026-10-22 用户明确要求：**默认就是要发消息**。
   *    之前默认 false 是我理解错了 —— 用户说"默认状态，刚下载的时候，
   *    点了自己跑一轮，跟让它自己刷抖音，都不要确认，直接发送"。
   *    ⇒ 现在默认 **true**。
   *
   * 仍然是**可关**的：面板上有明确开关，不想让它自动发就关掉。
   */
  autoSend: z.boolean().default(true).extra('volatile', true),
  /**
   * ⭐⭐ **在评论区 @ 你**（2026-10-22 用户要求，加在「自动发送」下面）
   *
   * 含义：插件跑完一轮，挑到值得看的视频时，**去那个视频的评论区发一条评论 @ 你**，
   *      等于把"找到好东西"这件事直接推到你的抖音通知里。
   *
   * 为什么好用：抖音的 @ 通知比私信/Toast 都更容易被看见 —— 你刷抖音时自然就看到。
   *
   * 🔴 依赖两件事（缺一不可）：
   *   ① `autoSend` 开着（总闸）
   *   ② `commentSelfName` 填了（要 @ 的人 = 你自己）
   *   ③ 走的是 `comment-mention-ui.mjs`（真 UI 点选，sec_uid 才保得住）
   *
   * ⚠️ 默认 **false** —— 这个跟 autoSend 不一样：
   *    发私信是发给"你选的那个人"，而这个是**在别人的视频下面公开评论**，
   *    所有路人都看得到。默认开不合适，得你自己点开。
   */
  commentAtMe: z.boolean().default(false).extra('volatile', true),
  /**
   * ⭐ 「在评论区 @ 你」要 @ 谁 —— 填**你自己抖音昵称**。
   *    留空就用登录账号的昵称（account.json 里那个），所以一般不用填。
   *    只有当你的登录号跟"你想被 @ 的那个号"不是同一个时才需要。
   */
  commentSelfName: z.string().default('').extra('volatile', true),
  /** 评论执行器：off / builtin（不可用）/ browser / http */
  commentExecutor: z.string().default('off').extra('volatile', true),
  commentPerRun: z.natural().default(1).extra('volatile', true),
  commentPerDay: z.natural().default(0).extra('volatile', true),
  /** 要 @ 谁（抖音昵称）；留空 = 不发评论 */
  mentionName: z.string().default('').extra('volatile', true),
  /** http 执行器的地址 */
  httpCommentUrl: z.string().default('').extra('volatile', true),
  /** ⭐⭐ 聊天盯梢（2026-10-24）：后台每 N 秒读一次私信对象的会话，有新消息就通知。
   *  来源：使用者当天实测的「会话模式」——30 秒一读、看见就回（实测响应 ~12 秒）。
   *  间隔默认 30 秒；读取走 HTTP 快路径（im-http.py，~1.1 秒/次、不启浏览器、身份铁闸）。 */
  /**
   * ⭐ 聊天模式总开关（2026-10-24 定稿：使用者拍板「默认开启，要关就整个关掉」）。
   *    一个开关管全部：30 秒一读 + 新消息通知 + 状态屏。不再有单独的「自动回话」——
   *    回话由 AI 值班做（已活着的会话，~12 秒），插件只做眼睛。
   */
  chatWatch: z.boolean().default(true).extra('volatile', true),
  /** 盯梢间隔（秒），10–300，默认 30 */
  chatWatchSec: z.natural().default(30).extra('volatile', true),
  /**
   * ⭐⭐ 自动回「评论区 @ 我」（2026-10-25，使用者要求「让她自己能自动回复别人的艾特」）。
   *
   * 与 `commentAtMe` 是**相反方向**，别搞混：
   *   · `commentAtMe` = 她**主动去**别人视频下 @ 使用者（推东西给主人）
   *   · `atWatch`     = **别人 @ 她**，她自己在对方那条评论下回复对方
   *
   * 走 `tools/at-me-watch.mjs`（规则写死在脚本里，不靠模型临场发挥）：
   *   只回**指定视频/全站**下 @ 她的；特殊称呼只给号主；每条 ≤100 字；
   *   同一人同一楼最多 1 次；连续 10 分钟没人 @ 自己收工；撞 403 立刻停（越重试封越久）。
   *
   * ⚠️ 默认 **false** —— 这是**拿使用者账号对外说话**，得他自己点开。
   */
  atWatch: z.boolean().default(false).extra('volatile', true),
  /** 多久查一次 @（秒），30–3600，默认 120（别太频，通知接口会限流） */
  atWatchSec: z.natural().default(120).extra('volatile', true),
  /** 每次最多回几条，1–20，默认 3 */
  atWatchMax: z.natural().default(3).extra('volatile', true),
  /**
   * 只盯这一条视频下的 @；留空 = **全站盯**（任何视频下 @ 她的都算）。
   * 填了就是限流/试水用。
   */
  atWatchAweme: z.string().default('').extra('volatile', true),
  /**
   * 号主的抖音 uid（数字）。不给就认不出「谁是主人」⇒
   * 「特殊称呼只属于号主」那条边界会退化（对谁都不带称呼）。
   */
  ownerUid: z.string().default('').extra('volatile', true),
  /**
   * ⭐⭐ 自动回私信（2026-10-25，使用者原话「私聊已读不回呢」）。
   *
   * 与 `chatWatch` 的区别：`chatWatch` 只「看见 + 记录」；打开这个才会**真的回话**。
   * 与 `atWatch` 的区别：那个盯评论区 @，这个盯私信。
   *
   * 走 `tools/dm-auto-reply.mjs`（规则写死在脚本里，不靠模型临场发挥）：
   *   只回 `dmToId` 这一个人；特殊称呼只给号主；每条 ≤100 字、不带链接；
   *   同一条消息最多回 1 次；夜间静默；使唤式/引战/要隐私的一律不回；
   *   第一拍只对表，不把历史消息重播一遍。
   *
   * ⚠️ 默认 **false** —— 这是**拿使用者账号对外说话**，得他自己点开。
   */
  dmAuto: z.boolean().default(false).extra('volatile', true),
  /** 多久查一次私信（秒），30–3600，默认 90 */
  dmAutoSec: z.natural().default(90).extra('volatile', true),
  /** 每天最多自动回几条：0 = 不设上限，非零夹 1–999 */
  dmAutoMax: z.natural().default(0).extra('volatile', true),   // 0 = 不设上限（2026-10-25 使用者要求）
  /** 夜间静默区间（北京时间 HH:MM-HH:MM）：空串 = 不静默 */
  dmAutoQuiet: z.string().default('').extra('volatile', true),   // '' = 不静默、全天都回（2026-10-25 使用者要求）
  /**
   * ⭐ 自动回抖音群聊（2026-10-27 使用者要求）。
   *
   * 原话：「没有被 @ 或被点名时回（默认），不做无差别接话，然后可以有 10% 的概率
   *        去回复别人发的视频或者消息，群里发的视频要也抽帧看，所有群都监控，
   *        没有回复上限，不要冷却」
   *
   * 走 `tools/group-reply.mjs` —— 与私聊那条链路完全独立的进程：
   *   ① 只在被 @ 或被点名时回（默认）
   *   ② 另外按 `groupChance` 概率主动回别人的视频/消息
   *   ③ 群里视频也抽帧（`groupFrames`）
   *   ④ 所有群都监控，无每日上限、无冷却
   *
   * ⚠️ 与 dmAuto 一样是**拿使用者账号对外说话**，默认 false。
   */
  groupAuto: z.boolean().default(false).extra('volatile', true),
  /** 多久查一轮群聊（秒），60–3600，默认 120 */
  groupAutoSec: z.natural().default(120).extra('volatile', true),
  /** 非 @/点名消息的回复概率：0 = 只回 @/点名，1 = 每条都想办法回，默认 0.1（使用者定的 10%） */
  groupChance: z.number().default(0.1).extra('volatile', true),
  /** 群里的视频/图文要不要抽帧看。默认开（使用者明确要求） */
  groupFrames: z.boolean().default(true).extra('volatile', true),
  /**
   * 自动回私信的范围。
   *   · 'all'（默认）= 盯所有私聊会话，谁发来都回
   *   · 'one'        = 只盯 dmToId 那一个人（老行为）
   *
   * 🔴 为什么要有这个键：dm-auto-reply.mjs 从 0.11.0 起就支持「不给 --peer 就盯所有会话」，
   * 但 index.js 的 dmEnsure 一直写死传 `--peer <dmToId>`，于是多会话改造等于没生效 ——
   * 使用者反馈「为什么还是回不了陌生人私信」就是这个。
   */
  dmScope: z.string().default('all').extra('volatile', true),
  /**
   * ⭐ 2026-10-26 加：自动回私信时**能不能发视频卡片**。
   *
   * 使用者原话：「为什么抖音里的小鲸鱼不会发我发视频?」—— 以前确实不会：
   * 那条链路只会 `im-send.mjs --text` 打字，从不调 `card-share.mjs`。
   * 抖音的分享卡片是前端把结构化消息交给服务端生成的，纯文字 + URL 做不出来，
   * 而且文本链接在抖音里点不开。
   *
   * 现在接上了，但要控频：一次 card-share 要开新标签页跑 1~4 分钟，
   * 且纯甩视频很突兀 —— 所以只在「刚好回过一句话」之后、按概率发。
   *   · videoAuto      总开关
   *   · videoEverySec  两条视频之间至少隔多少秒（默认 1800 = 30 分钟）
   *   · videoMax       每天最多几条（0 = 不限）
   *   · videoReplyChance  对方**发了视频**时，跟着回一条视频的概率
   *   · videoIdleChance   对方只是说话时，主动分享一条的概率
   */
  videoAuto: z.boolean().default(true).extra('volatile', true),
  videoEverySec: z.natural().default(1800).extra('volatile', true),
  videoMax: z.natural().default(3).extra('volatile', true),
  videoReplyChance: z.number().default(0.35).extra('volatile', true),
  videoIdleChance: z.number().default(0.05).extra('volatile', true),
  /**
   * ⭐ 2026-10-25 加：回话前先查 AstrBot 的长期记忆（LivingMemory）。
   *
   * 抖音这边本来只有「本会话最近 16 条」，隔天再聊就白纸了；QQ 那边攒了
   * 两百多条记忆（谁吃什么、聊过什么梗），人两边是同一个。
   * 关掉就只靠本会话短期上下文，行为回到加这个功能之前。
   * 依赖 `lib/memory-bridge.mjs`（走 AstrBot 面板接口，需要 AstrBot 在跑）。
   */
  memoryEnabled: z.boolean().default(true).extra('volatile', true),
  // ⚠️ 2026-10-24 petOn 已随桌宠搬到独立插件 dsh-deskpet（状态源 /pet/state 还在）。
  /**
   * ⭐ 2026-10-24 定稿（使用者：「我要的是迁移，不是开发新功能」）：
   *    聊天模式 = 今早实测那套的「读」半边（30 秒一读 + 通知 + 状态屏）。
   *    「回话」半边**不做在插件里**——今早的 12 秒来自**已活着的 AI 直接回**；
   *    插件里曾做过「每条消息现起一个会话」，实测 73 秒、还吞消息，已拆掉。
   *    回话 = AI 值班（常驻会话 + 定时器），插件的状态屏负责让它可见。
   */
  /** 通知：toast（Windows 通知，默认）/ file（不额外提醒）/ webhook / both */
  notifyMode: z.string().default('toast').extra('volatile', true),
  /** 私信发给谁：昵称（只用于显示/提醒） */
  dmTo: z.string().default('').extra('volatile', true),
  /**
   * ⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。真正决定发给谁的是这个，不是昵称。
   * 抖音重名极其常见 ⇒ 昵称只当"人类可读的名字"，`dmToId` 才是身份。
   * 留空时：只有在会话列表里昵称**唯一**才允许发；重名会直接拒绝并列出候选。
   */
  dmToId: z.string().default('').extra('volatile', true),
  webhookUrl: z.string().default('').extra('volatile', true),
  webhookPreset: z.string().default('custom').extra('volatile', true),
  /**
   * ⭐ 检查更新的地址（可选）。留空 = 自动：
   *   ① npm registry 的 `/<包名>/latest`（包要是发到 npm 了才查得到）
   *   ② 包里 `repository` 指向 GitHub 时，读仓库根目录的 package.json
   * 填了就只查这一个（要返回 JSON，至少有 { "version": "x.y.z" }）。
   */
  updateUrl: z.string().default('').extra('volatile', true),
  /** 日报形态：full / brief / off */
  reportLevel: z.string().default('full').extra('volatile', true),
  /** Python：指向 venv 里那个最好 */
  pythonPath: z.string().default('python').extra('volatile', true),
  /** dsh 的 bin.js（不填就试自动探测） */
  dshBin: z.string().default('').extra('volatile', true),
  headlessProfile: z.string().default('headless').extra('volatile', true),
  /** 给那一轮叠一份插件自己的 patch */
  overlayMcp: z.boolean().default(true).extra('volatile', true),
  // ⚠️ 2026-10-21 删掉了 `workspace`：它原来是"读那个目录下的 AGENTS.md 当人设"，
  //    正是这个口子让插件能读到**别的插件**的设定（抖音口吻被搬到刷B站那边）。
  //    现在人设只来自插件自带的 `prompts/persona.md`，外面没有任何路径可读。
})

/** ⭐ 给所有 Python 子进程统一 UTF-8（Windows 默认 GBK，中文/emoji 一进管道就可能炸） */
const pyEnv = (extra = {}) => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  ...extra,
})

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  /**
   * ⭐ 版本号：**按 mtime 缓存**，文件一变就重读。
   * 🔴 2026-10-23 使用者指出「本地插件版本你是不是写错了」——
   *    原来 `if (myVer) return myVer` 读一次就永久记住：宿主启动后改了
   *    package.json 的版本号，面板/douyin_status 还一直报旧版本，
   *    看起来就像"版本写错了"。现在 statSync 的 mtimeMs 变了就重读。
   */
  let myVer = ''
  let myVerMtime = -1
  const myVersion = () => {
    const pkgFile = join(pluginDir, 'package.json')
    try {
      const mtime = statSync(pkgFile).mtimeMs
      if (myVer && mtime === myVerMtime) return myVer
      myVer = String(JSON.parse(readFileSync(pkgFile, 'utf8')).version || '')
      myVerMtime = mtime
      return myVer
    } catch {
      return myVer || ''
    }
  }
  const stateDir = stateDirOf(ctx)
  const cfgFile = join(stateDir, 'config.json')
  const collectorFile = join(stateDir, 'collector.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  const inboxDir = join(stateDir, 'inbox')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(inboxDir, { recursive: true })
  /** ⭐ Toast 的 ps1 和临时 json 也放 D 盘家目录（用户要求所有东西装 D 盘，别往 C:\Temp 撒） */
  const toastDir = join(stateDir, 'toast')
  const toastSend = (o) => sendToast({ ...o, dir: toastDir })

  /* ── 日志：别让模型输出把结构化行粘在一起（抄 bili-scroll 的教训） ── */
  let atLineStart = true
  const rawWrite = (s) => {
    try {
      appendFileSync(logFile, s, 'utf8')
      atLineStart = String(s).endsWith('\n')
    } catch { /* 日志写不进去也不致命 */ }
  }
  const log = (msg) => {
    rawWrite((atLineStart ? '' : '\n') + `${new Date().toISOString()}  ${msg}\n`)
    try { ctx.logger?.info?.(`[douyin-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  for (const n of hostDeps.notes) log(n)

  /* ── 配置：逐字段按默认值类型挑一遍（apply 传进来的值不保证是标量） ── */
  const DEFAULTS = {
    perDay: 5, maxPerRun: 12, peakValley: false, noon: true, night: true,
    windows: [],
    keywords: [], channels: [], authors: [],
    minDescLen: 12, minComments: 3,
    autoComment: false, autoSend: true, commentAtMe: false, commentSelfName: '',
    commentExecutor: 'off', commentPerRun: 1, commentPerDay: 0,
    mentionName: '', httpCommentUrl: '',
    notifyMode: 'toast', webhookUrl: '', webhookPreset: 'custom',
    updateUrl: '',
    dmTo: '', dmToId: '',
    // ⭐ 聊天模式（2026-10-24 定稿：默认开启，使用者拍板；要关就整个关掉）。
    //    ⚠️ DEFAULTS / zod 必须同步（漏加过 ⇒ 开关点了没反应）。
    chatWatch: true, chatWatchSec: 30,
    // ⭐ 自动回「别人 @ 我」（2026-10-25）。默认关：这是拿使用者账号对外说话。
    atWatch: false, atWatchSec: 120, atWatchMax: 3, atWatchAweme: '', ownerUid: '',
    // 自动回私信（2026-10-25）：默认关 —— 拿使用者账号对外说话，得他自己点开
    dmAuto: false, dmAutoSec: 90, dmAutoMax: 0, dmAutoQuiet: '',
    dmScope: 'all',
    // ⭐ 自动回抖音群聊（2026-10-27）：默认关（拿账号对外说话）。只有 @/点名必回，
    //    其余按 groupChance 概率回；群里视频抽帧；所有群都监控，无上限无冷却。
    groupAuto: false, groupAutoSec: 120, groupChance: 0.1, groupFrames: true,
    // ⭐ 自动回私信时发视频卡片（2026-10-26）。默认开，但每 30 分钟最多一条、每天 3 条
    videoAuto: true, videoEverySec: 1800, videoMax: 3,
    videoReplyChance: 0.35, videoIdleChance: 0.05,
    // 回话前查 AstrBot 长期记忆（2026-10-25）；默认开，靠它才记得住跨天的旧事
    memoryEnabled: true,
    reportLevel: 'full', pythonPath: 'python', dshBin: '', headlessProfile: 'headless',
    overlayMcp: true,
  }
  // ⭐ 哪些数组字段装的是**对象**（不能按字符串过滤）
  //    之前判断 `base[k].length && typeof base[k][0] === 'object'` —— 但 DEFAULTS 里
  //    `windows: []` 是空的，length=0，于是走了字符串分支，用户存的自定义时段全被吃掉。
  //    改成显式声明，别靠"数组里恰好有元素"来判断。
  const OBJECT_ARRAYS = new Set(['windows'])
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) {
        if (!Array.isArray(v)) continue
        out[k] = OBJECT_ARRAYS.has(k)
          ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
          : v.filter((x) => typeof x === 'string')
      }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /**
   * ⭐ 「设置里能写什么范围」收在一处 —— HTTP 接口、douyin_config 工具、**读配置**三处都走它。
   *    原生设置页那条路我们钳不到写 ⇒ loadCfg 读回来也过一遍（写进去和读出来一个口径）。
   */
  const ENUMS = {
    commentExecutor: ['off', 'builtin', 'browser', 'http'],
    notifyMode: ['file', 'toast', 'webhook', 'both'],
    webhookPreset: ['custom', 'wecom', 'feishu', 'dingtalk'],
    reportLevel: ['full', 'brief', 'off'],
  }
  const clampPatch = (patch) => {
    // ⭐ 只认 schema 里真有的字段。
    //    2026-10-21 实测：外面塞进来一个未知键（比如 `dmMode`），DSH 那边会把**整批**拒掉，
    //    报 `Config field "dmMode" is not volatile`，连带着私信对象一起没同步上。
    const p = {}
    for (const k of Object.keys(patch || {})) if (k in DEFAULTS) p[k] = patch[k]
    if ('perDay' in p) p.perDay = Math.max(0, Math.min(Number(p.perDay) || 0, 300))
    if ('maxPerRun' in p) p.maxPerRun = Math.max(1, Math.min(Number(p.maxPerRun) || 1, 30))
    if ('minDescLen' in p) p.minDescLen = Math.max(0, Math.min(Number(p.minDescLen) || 0, 200))
    if ('minComments' in p) p.minComments = Math.max(0, Math.min(Number(p.minComments) || 0, 1000))
    if ('commentPerRun' in p) p.commentPerRun = Math.max(0, Math.min(Number(p.commentPerRun) || 0, 20))
    if ('commentPerDay' in p) p.commentPerDay = Math.max(0, Math.min(Number(p.commentPerDay) || 0, 50))
    for (const [k, vals] of Object.entries(ENUMS)) {
      if (k in p) p[k] = vals.includes(String(p[k])) ? String(p[k]) : DEFAULTS[k]
    }
    return p
  }

  const CFG_SIG = ['perDay', 'maxPerRun', 'mentionName', 'commentExecutor']
  let settingsRow = { at: 0, row: null }
  const settingsDesc = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && CFG_SIG.every((k) => k in r.value)) || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响跑）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }
  const hostCfg = () => normalize(config, { ...DEFAULTS })
  const savedCfg = () => normalize(readJson(cfgFile, {}), { ...DEFAULTS })
  const loadCfg = () => {
    const saved = savedCfg()
    const row = settingsDesc()
    if (!row) return clampPatch(saved)
    const user = row.user || {}
    const out = { ...hostCfg() }
    for (const k of Object.keys(DEFAULTS)) if (user[k] === undefined) out[k] = saved[k]
    // host 那层退回默认值、而 config.json 里有非默认值时，以 config.json 为准
    const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b) } catch { return a === b } }
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] === undefined) continue
      if (same(out[k], DEFAULTS[k]) && !same(saved[k], DEFAULTS[k])) out[k] = saved[k]
    }
    return clampPatch(out)
  }
  const cfg = loadCfg()
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }
  const saveCfg = (patch) => {
    Object.assign(cfg, normalize(patch, cfg))
    // ⭐ 2026-10-21 实测事故：`dmTo` / `dmToId` 被清空过 —— 日志里连着三条 `设置已更新：{}`，
    //    设置页一渲染就把空输入框 blur 出去一次。清空的后果是私信直接发不出去（还不知道为什么）。
    //    规矩：空值不许覆盖磁盘上已有的非空值。
    const onDisk = readJson(cfgFile, {})
    for (const k of ['dmTo', 'dmToId']) {
      if (!String(cfg[k] || '').trim() && String(onDisk[k] || '').trim()) {
        cfg[k] = onDisk[k]
        log(`配置：${k} 差点被空值覆盖 —— 已保住磁盘上的原值`)
      }
    }
    writeJson(cfgFile, cfg)
  }
  const saveCfgHost = async (patch) => {
    const attempt = async (fresh) => {
      const row = settingsDesc(fresh)
      if (!row?.ns || typeof ctx.settings?.update !== 'function') {
        throw Object.assign(new Error('DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）'), { noForm: true })
      }
      await ctx.settings.update(row.ns, patch, row.revision)
      return row.ns
    }
    try { return { ok: true, ns: await attempt(false) } }
    catch (e) {
      if (!e?.noForm) { try { return { ok: true, ns: await attempt(true), retried: true } } catch (e2) { e = e2 } }
      log(`写 DSH 设置失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
  /** ⭐ 落配置的唯一入口：config.json + DSH 原生设置页，钳完范围一起写 */
  const persistCfg = async (patch) => {
    const clean = clampPatch(patch)
    saveCfg(clean)
    syncCollectorCfg()               // ⭐ Python 那头的 router 读 collector.json
    const host = await saveCfgHost(clean)
    return { clean, host }
  }

  /**
  /**
   * ⭐ 把判据相关的配置同步给 Python 脚本（forward-pick.py 读它当预筛门槛）。
   *    不再有「采集来源」这条 —— 2026-10-21 砍掉 MCP 后只有一条路：只读接口取候选。
   */
  const syncCollectorCfg = () => {
    try {
      writeJson(collectorFile, {
        minDescLen: Number(cfg.minDescLen) || 0,
        minComments: Number(cfg.minComments) || 0,
        updatedAt: new Date().toISOString(),
      })
    } catch (e) { log(`写 collector.json 失败：${e?.message ?? e}`) }
  }

  ensureHomeFiles(pluginDir, stateDir, log)
  ensureCharter(pluginDir, stateDir, log)
  syncCollectorCfg()

  /* ─────────────── 环境（venv / uv） ─────────────── */
  const sitePkgs = (venvRoot) => {
    const win = join(venvRoot, 'Lib', 'site-packages')
    if (existsSync(win)) return win
    try {
      const lib = join(venvRoot, 'lib')
      for (const d of readdirSync(lib)) {
        if (!d.startsWith('python')) continue
        const p = join(lib, d, 'site-packages')
        if (existsSync(p)) return p
      }
    } catch { /* 没有就算了 */ }
    return win
  }
  const hasPkg = (venvRoot, prefix) => {
    try { return readdirSync(sitePkgs(venvRoot)).some((n) => n.startsWith(prefix)) } catch { return false }
  }
  /**
   * ⚠ 2026-10-28：Windows 上一律用 pythonw.exe，不用 python.exe。
   *
   * `spawnSync(..., { windowsHide: true })` 在这台机器上**压不住**控制台窗口 ——
   * 实测同一个 im-http.py，python.exe 每次都在屏幕上闪一个
   * ConsoleWindowClass 窗（标题就是 python.exe 的完整路径），
   * pythonw.exe 则是 0 个窗口。原因是 Win11 把「新建控制台」交给了
   * Windows Terminal 托管，WT 不受 CREATE_NO_WINDOW / ShowWindow=0 约束。
   * pythonw 是 GUI 子系统程序，**根本不申请控制台**，于是没有窗口可弹。
   *
   * 输出不受影响：pythonw 只有在「自己是顶层进程、没有 stdout」时 sys.stdout 才是 None；
   * 这里的 spawnSync 全都带 stdio 管道，Python 会自动把 stdout 绑到管道上。实测
   * spawnSync(pythonw, ['-c','print("x")']) 能正常拿到 "x
"。
   */
  const venvPython = () => process.platform === 'win32'
    ? join(stateDir, '.venv', 'Scripts', 'pythonw.exe')
    : join(stateDir, '.venv', 'bin', 'python')
  /** ⭐ "就绪"必须检查依赖真的装上了，不能只看目录存不存在 */
  const venvReadyNow = () => existsSync(venvPython()) && hasPkg(join(stateDir, '.venv'), 'httpx')

  const installLogFile = join(stateDir, 'install.log')
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 算了 */ } }

  const spawnTo = (cmd, args, { sink = appendInstall, env = null, cwd = stateDir } = {}) => new Promise((resolve) => {
    sink(`\n$ ${cmd} ${args.join(' ')}\n`)
    let c
    try {
      c = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv(env || {}) })
    } catch (e) { sink(`起不来：${e?.message ?? e}\n`); return resolve(1) }
    const w = (b) => sink(String(b))
    c.stdout?.on('data', w)
    c.stderr?.on('data', w)
    c.on('exit', (code) => { sink(`\n--- exit ${code} ---\n`); resolve(code) })
    c.on('error', (e) => { sink(`起不来：${e?.message ?? e}\n`); resolve(1) })
  })

  const probeCmd = (cmd) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' })
      c.on('exit', (code) => resolve(code === 0))
      c.on('error', () => resolve(false))
    } catch { resolve(false) }
  })
  let uvOk = null
  const haveUv = async () => {
    if (uvOk) return true
    const ok = await probeCmd('uv')
    if (ok) uvOk = true
    return ok
  }
  const resolveUv = async () => {
    if (await haveUv()) return 'uv'
    const bundled = join(stateDir, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (existsSync(bundled)) return bundled
    appendInstall('这台机器上没有 uv —— 我下一份放进插件家目录（单文件、免管理员、约 15MB，只需要一次）…\n')
    try {
      const got = await ensureUv({ dir: join(stateDir, 'bin'), log: appendInstall })
      if (got) appendInstall('uv 已就位：' + got + '\n')
      return got
    } catch (e) { appendInstall(`下 uv 失败：${e?.message ?? e}\n`); return null }
  }
  const MIRRORS = [
    process.env.DOUYIN_PIP_MIRROR || 'https://pypi.tuna.tsinghua.edu.cn/simple',
    'https://mirrors.ustc.edu.cn/pypi/simple',
    'https://mirrors.aliyun.com/pypi/simple',
  ]

  let installing = false
  /** 建 venv + 装主依赖 —— ⭐ **起完就返回，不等它装完**（否则会话会僵住几分钟） */
  const runInstall = () => {
    if (installing) return { ok: true, busy: true, log: installLogFile, hint: '正在装，别重复起' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 开始装主依赖 ===\n`)
    ;(async () => {
      try {
        const req = join(pluginDir, 'requirements.txt')
        const venvPy = venvPython()
        const uvCmd = await resolveUv()
        if (!existsSync(venvPy)) {
          if (uvCmd) await spawnTo(uvCmd, ['venv', '--seed', join(stateDir, '.venv')])
          if (!existsSync(venvPy)) await spawnTo(String(cfg.pythonPath || 'python'), ['-m', 'venv', join(stateDir, '.venv')])
        }
        if (!existsSync(venvPy)) {
          const msg = '建不了 Python 环境 —— 这台机器上既没有可用的 uv，也没有可用的 python。\n'
            + '装一个就行：uv（单文件 exe，https://docs.astral.sh/uv/）或 Python 3.10+（安装时勾 Add to PATH），然后回来再点一次。\n'
          appendInstall(msg); log('装依赖：建环境失败'); installing = false; return
        }
        let code = 1
        for (const m of MIRRORS) {
          if (code === 0) break
          if (uvCmd) code = await spawnTo(uvCmd, ['pip', 'install', '--python', venvPy, '-i', m, '-r', req])
          if (code !== 0) code = await spawnTo(venvPy, ['-m', 'pip', 'install', '-i', m, '-r', req])
        }
        if (code === 0 && existsSync(venvPy)) {
          await persistCfg({ pythonPath: venvPy })
          appendInstall(`已把 pythonPath 设为 ${venvPy}\n`)
        }
        appendInstall(`=== 结束（exit ${code}，venvReady=${venvReadyNow()}）===\n`)
        log(`装主依赖结束：exit=${code} venvReady=${venvReadyNow()}`)
      } catch (e) {
        appendInstall(`装依赖崩了：${e?.stack ?? e}\n`)
        log(`装依赖崩了：${e?.message ?? e}`)
      } finally { installing = false }
    })()
    return { ok: true, started: true, log: installLogFile, hint: '正在后台装依赖（走国内镜像，通常几十秒）' }
  }

  /* ─────────────── MCP（已移除） ───────────────
   * 2026-10-21：原来这里起一份内置 Python MCP（家里那份 mcp_server.py），
   * 把「搜 / 预筛 / 评论 / 状态」注册成工具。那套走 bb-browser / playwright / cookie 三个驱动，
   * 一个都没跑通过真数据，还要求开浏览器 —— 整包删掉，改用下面的 runPy() 直接调 tools/*.py。
   */

  /* ─────────────── 工具 ─────────────── */
  /* ─────────────── 顺序哨兵：先卡片，后文字 ───────────────
   * 🔴 使用者 2026-10-21 亲自立的规矩：既要发卡片又要发文字时，**永远先卡片、后文字**。
   *    反过来他先看到一句话，却不知道在说哪条视频。
   *    2026-10-21 真翻过车：Chrome 被 DSH 重启带走，卡片那步 ECONNREFUSED 崩掉，
   *    紧接着发理由的脚本却自己把 Chrome 拉起来发出了 —— 结果他先收到「这条一定要发你…」，
   *    过一会儿才收到卡片。这就是要防的形态。
   *    这里只做**软拦**（返回值里带 order_warning），不硬拒绝 —— 顺序错了也要发，但要说出来。
   */
  const recentDm = { at: 0, secUid: '', kind: '' }
  const noteDm = (kind, secUid) => { recentDm.at = Date.now(); recentDm.secUid = String(secUid || ''); recentDm.kind = String(kind || '') }
  /** 发卡片之前问一句：刚是不是已经给同一个人发过纯文字了？ */
  const orderWarning = (secUid) => {
    if (recentDm.kind !== 'text') return null
    const age = Date.now() - recentDm.at
    if (age > 180_000) return null
    if (secUid && recentDm.secUid && String(secUid) !== recentDm.secUid) return null
    return `⚠️ 规矩是「先卡片，后文字」—— ${Math.round(age / 1000)} 秒前刚给同一个人发过纯文字，卡片这次才到，顺序反了。下次用 share_card 的 reason 一次办完。`
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  /** 工具返回值一律过这里：宿主只吃"无损 JSON" */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  /**
   * 跑插件自带的 node 脚本（tools/*.mjs），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-22：这里以前写死 `IM_CDP_PORT: '9334'` —— 那等于把 lib/chrome.mjs 的
   *    端口自动探测**废掉**（强制 9334，撞上就死）。现在只注入家目录，端口交给 lib 自己找。
   */
  const runNodeTool = (script, args = [], { timeout = 240_000 } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    // ⭐ 2026-10-29：这里以前是 process.execPath（DSH 的 Electron/node，Console 子系统=3），
    //    每次调用都在屏幕上弹一个 Windows Terminal 窗口、把全屏游戏顶掉。
    //    改成 no-control-console 的 node 副本（见 findNodeExe 上方那段说明）。
    const runner = quietNode || process.execPath
    const r = spawnSync(runner, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }
  /**
   * 跑插件自带的 Python 脚本（tools/*.py），返回 {status, stdout, stderr} —— 永不抛
   * ⚠️ 2026-10-21：这里以前是一份内置 MCP server（vendor/douyin-mcp，33 个文件 / 506 KB）+
   *    5 个 bb-browser/cookie 驱动。那套东西一个都没跑通过真数据，还被「必须开浏览器」绑着；
   *    现在采集/发送全走「HTTP + 无头 Chrome」，那些全删了。
   */
  const runPy = (script, args = [], { timeout = 240_000 } = {}) => {
    const f = join(pluginDir, 'tools', script)
    if (!existsSync(f)) return { status: -1, stdout: '', stderr: `缺少 tools/${script}` }
    const py = existsSync(venvPython()) ? venvPython() : (cfg.pythonPath || 'python')
    const r = spawnSync(py, [f, ...args], {
      encoding: 'utf8',
      timeout,
      env: pyEnv({ DOUYIN_HOME: stateDir }),
      windowsHide: true,
    })
    return { status: r.status ?? -1, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error || '') }
  }

  /** 从脚本输出里抠出最后一个完整 JSON 对象 */
  const pickJson = (s) => {
    const t = String(s || '')
    const i = t.indexOf('{'), j = t.lastIndexOf('}')
    if (i < 0 || j <= i) return null
    try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
  }

  /**
   * ⭐⭐ 2026-10-23 新增：**发送闸 / 限流退避 / 三态回读**
   *    起因：使用者问「回评论用什么方案比较快」，一量才发现三个真问题 ——
   *    ① 连发 3 条评论后 API 直接 **403**（抖音限流），原来代码只会把 403 当普通失败返回，
   *       调用方一看失败就重试 ⇒ 越重试封得越久。
   *    ② 发完看不见：**不是"进审核"**（2026-10-23 实测推翻了这个说法）——
   *       真实原因是抖音评论列表**按热度排序**，刚发的 0 赞评论排在最后，
   *       而这个视频**不给切「最新」排序**（页面根本没有那个按钮）；
   *       按 cid 查详情的接口也是 404。⇒ "读不到"只说明**我够不着**，
   *       不说明它没发出去（能按 cid 删掉 = 服务端收下了，这是硬证据）。
   *    ③ 两条通道（api 快但假 @、ui 真 @ 但慢）混在一个工具里，调用方不知道自己在走哪条。
   *    ⇒ 这里给前三样补上：全局最小间隔、403 退避窗口、回读三态。
   */
  const sendGateFile = join(stateDir, 'send-gate.json')
  /** 两条通道的最小间隔（秒）—— api 快但更容易撞限流，给宽一点 */
  const MIN_GAP = { api: 45, ui: 20 }

  const sendGate = async (dir, mode) => {
    const st = readJson(sendGateFile, {}) || {}
    const now = Date.now()
    const blockedUntil = Number(st.blockedUntil) || 0
    if (now < blockedUntil) {
      return {
        ok: false, reason: 'cooldown',
        waitSec: Math.ceil((blockedUntil - now) / 1000),
        note: `上次撞了限流，冷却中（到 ${new Date(blockedUntil).toLocaleTimeString('zh-CN')}）`,
      }
    }
    /**
     * 🔴 闸按**两条通道各自的间隔**算，但也要算"另一条通道刚发过"——
     *    抖音的风控看的是**这个号在评论区发言的频率**，不分 api/ui。
     *    所以取 max(本通道间隔, 跨通道最小间隔 15 秒)。
     */
    const lastSame = Number(st[`last_${mode}`]) || 0
    const lastAny = Math.max(Number(st.last_api) || 0, Number(st.last_ui) || 0)
    const gapSame = (MIN_GAP[mode] || 30) * 1000
    const gapAny = 15_000
    const sinceSame = now - lastSame
    const sinceAny = now - lastAny
    if (lastSame && sinceSame < gapSame) {
      return {
        ok: false, reason: 'too-fast', mode,
        waitSec: Math.ceil((gapSame - sinceSame) / 1000),
        lastSec: Math.round(sinceSame / 1000),
        note: `mode=${mode} 的最小间隔是 ${MIN_GAP[mode]} 秒，上次才过 ${Math.round(sinceSame / 1000)} 秒`,
      }
    }
    if (lastAny && sinceAny < gapAny) {
      return {
        ok: false, reason: 'too-fast-any',
        waitSec: Math.ceil((gapAny - sinceAny) / 1000),
        lastSec: Math.round(sinceAny / 1000),
        note: `刚用另一条通道发过（${Math.round(sinceAny / 1000)} 秒前），跨通道也要隔 ${gapAny / 1000} 秒`,
      }
    }
    return { ok: true }
  }
  /** 记一条"刚发过" —— **只更新本通道的时间戳**（以前两个都写，等于把另一条通道的间隔也重置了） */
  const markSent = (dir, mode = 'api') => {
    try {
      const st = readJson(sendGateFile, {}) || {}
      st[`last_${mode}`] = Date.now()
      st.lastMode = mode
      st.lastAt = new Date().toISOString()
      writeFileSync(sendGateFile, JSON.stringify(st, null, 2), 'utf8')
    } catch { /* 记不上不影响发 */ }
  }
  /** 撞限流：设一个冷却窗口，期间所有发送都直接拒 */
  const bumpBlock = (dir, minutes = 10) => {
    try {
      const st = readJson(sendGateFile, {}) || {}
      st.blockedUntil = Date.now() + minutes * 60_000
      st.blockedAt = new Date().toISOString()
      writeFileSync(sendGateFile, JSON.stringify(st, null, 2), 'utf8')
    } catch { /* 记不上不影响 */ }
  }

  /**
   * 三态回读：**别再只说 found / not found**。
   *   visible   —— 评论区里真的刷到了（按 cid 或正文片段）
   *   pending   —— 刷不到，但很可能只是审核/延迟（如实报，不谎报成功也不谎报失败）
   *   unknown   —— 回读本身失败了（工具挂了），更不能当成"没发出去"
   */
  const readbackAfter = async (dir, aweme, { text = '', cid = '' } = {}) => {
    const tries = 3
    for (let i = 0; i < tries; i++) {
      await new Promise((done) => setTimeout(done, 2000))
      try {
        // ① 有 cid 就按 cid 查（最准）
        if (cid) {
          const cr = runPy('api-comments.py', [aweme], { timeout: 300_000 })
          const out = String(cr.stdout || '')
          if (out.includes(cid)) return { state: 'visible', by: 'cid', cid, attempt: i + 1 }
        }
        // ② 没 cid（UI 路径）或 cid 没查到 ⇒ 按正文片段查 DOM（页面默认按最新渲染）
        if (text) {
          const dr = runNodeTool('comment-read-dom.mjs', ['--aweme', aweme, '--mine', '--scroll', '6'], { timeout: 200_000 })
          const j = pickJson(dr.stdout)
          const needle = String(text).slice(0, 12)
          const items = Array.isArray(j?.items) ? j.items : []
          if (items.some((x) => String(x.text || '').includes(needle))) {
            return { state: 'visible', by: 'dom', attempt: i + 1 }
          }
        }
      } catch { /* 这一轮回读挂了，继续试 */ }
    }
    return {
      state: 'pending', by: cid ? 'cid+dom' : 'dom',
      note: '读不到这条评论**不等于没发出去**：抖音评论按热度排序，刚发的 0 赞评论排最后，'
        + '这个视频也没有「最新」排序可切 ⇒ 回读够不着。有 cid 且能按 cid 删除 = 服务端收下了。'
        + '报告里写「已提交，未在评论区核实到（热度排序够不着）」，别写成"进审核了"（那是没根据的推测）',
    }
  }


  tool({
    name: 'douyin_doctor',
    description: '⭐ **环境体检**（换台设备 / 装完插件第一件事就跑它）：家目录、Python、venv、Cookie、'
      + 'Node、浏览器、CDP 端口、关键脚本 —— 八项逐个查，哪项红了直接给「怎么办」。'
      + '只读，什么都不改。',
    parameters: {},
    async execute() {
      // ⭐ 用纯 Node 版：第一次装的时候还没有 Python，不能让它依赖 Python
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return {
          ok: false, error: '体检脚本没返回可解析结果',
          stdout: String(r.stdout || '').slice(0, 400), stderr: String(r.stderr || '').slice(0, 300),
        }
      }
      const bad = j.must_fix || []
      const warn = j.warns || []
      if (bad.length) log(`doctor: ${bad.length} 项要修（${bad.map((x) => x.item).join('、')}）`)
      return {
        ok: j.ok !== false,
        items: j.items,
        must_fix: bad,
        todo: warn,
        hint: bad.length
          ? `先把这些修掉：${bad.map((x) => x.item).join('、')}`
          : (warn.length ? `没有硬伤，这些装完依赖/登录后会自己变绿：${warn.map((x) => x.item).join('、')}` : '全绿，可以跑值班了'),
      }
    },
  })

  tool({
    name: 'douyin_whoami',
    description: '看抖音这边的登录状态（会话还活着吗、nick 是谁）。不确定时先调它 —— **只读体检**，不影响登录态。',
    parameters: {},
    async execute() {
      if (!hasCredential(stateDir)) {
        return { ok: false, logged_in: false, hint: '还没有 Cookie —— 设置页「抖音 Cookie / 登录」扫码，或粘一条 Cookie' }
      }
      const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '体检没返回结果', stderr: String(r.stderr || '').slice(0, 300) }
      return { ok: true, logged_in: j.alive === true, ...j }
    },
  })

  tool({
    name: 'douyin_backend',
    description: '看当前这套采集 / 发送分别是怎么走的、各自的限制是什么。',
    parameters: {},
    async execute() {
      return {
        ok: true,
        stack: [
          { part: '取候选（清单）', how: '不签名的只读接口 tab/feed + hot/search', tool: 'douyin_forward', risk: '不碰写接口 ⇒ 不影响登录态' },
          { part: '读评论 / 读通知', how: '签名只读（dy-signer.mjs 出 a_bogus）', tool: 'douyin_comments / douyin_notices', risk: '低' },
          { part: '发私信 / 发卡片 / 发评论', how: '无头 Chrome 里跑抖音自己的前端', tool: 'douyin_dm / douyin_share_card / douyin_comment_reply', risk: '≈0（页面自己签名），但发前必须先问用户' },
        ],
        removed_2026_10_21: '删掉了 vendor/douyin-mcp（33 个文件 / 506 KB）和 bb-browser 那套驱动 —— 一个真数据都没跑通过',
        browser_policy: '可见浏览器只在扫码登录时用一次（tools/qr-login.mjs）；其余全是无头 Chrome 或纯 HTTP',
        not_available: ['视频详情（web 详情接口被 ArgusSecurityPlugin 挡 —— 但抽帧理解走的是 video.bit_rate 直链，不受影响）'],
        available_2026_10_27: {
          '关键词搜索': '推荐流 tab/feed 只有视频；图文要单独走 /aweme/v1/web/general/search/single/（forward-pick.py 已加第 3 路，读 config.json 的 keywords）',
          '图文作品': 'aweme_type=68 / media_type=2 / images[]；证据包带 is_image / images_n，视觉走 images 前 3 张',
          '整段视频': '下载最低档 mp4（约 0.66MB）→ ffmpeg 抽 4/6/9 帧拼宫格 → 视觉读。证据包 how_seen 标 frames:N / images:N / cover',
        },
      }
    },
  })

  tool({
    name: 'douyin_prescreen',
    description: '⭐ 一轮的主入口：取候选 → 打分 →（可选）给前几条拉高赞评论 → 返回「判断用的证据包」。'
      + '**判断就基于返回的 list[].evidence，别自己再逐条搜。**',
    parameters: {
      top: { type: 'number', description: '返回前几条（默认 10，最多 30）' },
      with_comments: { type: 'number', description: '给前 N 条拉评论（默认 5；0 = 不拉）' },
    },
    async execute(args = {}) {
      const top = Math.max(1, Math.min(Number(args.top) || 10, 30))
      const wcRaw = args.with_comments === undefined ? 5 : Number(args.with_comments)
      const withComments = Math.max(0, Math.min(Number.isFinite(wcRaw) ? wcRaw : 5, 15))
      const r = runPy('forward-pick.py', [], { timeout: 300_000 })
      if (r.status !== 0) return { ok: false, error: '取候选失败', stderr: String(r.stderr || '').slice(0, 400) }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, top)
      if (!rows.length) return { ok: true, kept: 0, note: '推荐流这轮没返回候选，稍后再试' }
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          /**
           * ⭐ 2026-10-27 加：图文标记。
           *
           * 图文的 duration 是 null（`duration_s: null`），以前模型看到「时长未知」
           * 会当成「拿不到时长的视频」，在 reason 里写「这条十几秒」这种瞎话。
           * 带上 is_image / images_n 之后，模型知道这是 N 张图的图集，
           * 措辞就能对上（图集不该提「几秒」「看个新鲜」）。
           */
          is_image: Boolean(x.is_image),
          images_n: Number(x.images_n) || 0,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
        }
        if (i < withComments && Number(x.comment) > 0) {
          const c = runPy('api-comments.py', [String(x.aweme_id)], { timeout: 200_000 })
          const lines = String(c.stdout || '').split('\n').filter((l) => /^\s{2}cid=/.test(l))
          item.evidence = lines.length
            ? lines.slice(0, 5).map((s) => s.replace(/^\s+/, '').replace(/^cid=\d+\s+/, '').slice(0, 160))
            : ['（没拉到评论）']
        }
        list.push(item)
      }
      return { ok: true, kept: list.length, sources: picked.meta || [], dropped: picked.dropped || {}, thresholds: picked.thresholds || {}, list }
    },
  })

  tool({
    name: 'douyin_forward',
    description: '⭐「转发视频给我」：拉推荐流候选 → 打分 → 出清单（含 douyin.com 分享链接），可同时弹 Windows 通知。'
      + '只用**不签名**的只读接口（tab/feed、hot/search），不碰写接口，因此**不会**影响登录态。',
    parameters: {
      toast: { type: 'boolean', description: '是否弹 Windows 通知（默认 true）' },
      top: { type: 'number', description: '通知里放几条（默认 3，最多 4）' },
    },
    async execute(args = {}) {
      const script = join(pluginDir, 'tools', 'forward-pick.py')
      if (!existsSync(script)) return { ok: false, error: '缺少 tools/forward-pick.py（插件包不完整）' }
      if (!existsSync(cookiePath(stateDir))) {
        return { ok: false, error: '还没有 Cookie', hint: '先扫码登录（tools/qr-login.mjs start），或设置页粘贴 Cookie' }
      }
      const venvPy = join(stateDir, '.venv', 'Scripts', 'pythonw.exe')
      const py = existsSync(venvPy) ? venvPy : (cfg.pythonPath || 'python')
      const r = spawnSync(py, [script], {
        encoding: 'utf8',
        timeout: 240_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }),
        windowsHide: true,
      })
      if (r.status !== 0) {
        return { ok: false, error: 'forward-pick.py 执行失败', stderr: String(r.stderr || r.error || '').slice(0, 400) }
      }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = Array.isArray(picked.rows) ? picked.rows : []
      if (!rows.length) return { ok: true, picked: 0, note: '这一轮没拉到候选（推荐流可能返回空），稍后再试' }

      const fm = (n) => {
        n = Number(n) || 0
        if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
        if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
        return String(n)
      }
      const wantToast = args.toast !== false
      let toastRes = { ok: true, sent: false, skipped: 'disabled' }
      if (wantToast) {
        const n = Math.max(1, Math.min(Number(args.top) || 3, 4))
        const head = rows.slice(0, n).map((x) => `· ${fm(x.digg)}赞｜${String(x.desc || '').replace(/\s+/g, ' ').slice(0, 34)}`)
        const more = rows.length > n ? `\n… 还有 ${rows.length - n} 条，见 out/` : ''
        toastRes = toastSend({ title: `刷抖音 · 挑到 ${rows.length} 条`, body: head.join('\n') + more })
      }
      log(`forward: 挑到 ${rows.length} 条，通知=${toastRes.ok && toastRes.sent ? '已弹' : (toastRes.error || toastRes.skipped || '未弹')}`)
      return {
        ok: true,
        picked: rows.length,
        sources: picked.meta || [],
        toast: toastRes,
        list: rows.map((x) => ({
          aweme_id: x.aweme_id,
          desc: x.desc,
          author: x.author,
          duration_s: x.duration_s,
          digg: x.digg,
          comment: x.comment,
          collect: x.collect,
          share: x.share,
          share_url: x.share_url,
          share_desc: x.share_desc,
          web_url: x.web_url,
        })),
      }
    },
  })

  tool({
    name: 'douyin_dm',
    description: '通过**无头 Chrome**（屏幕上不出现任何窗口）把一条私信发给指定抖音好友。'
      + '消息由抖音自己的前端发出 —— 连接、签名、protobuf 编码都由它完成，'
      + '所以**不会像自己拼签名那样把登录态搞掉**。'
      + 'from_list=true 时自动取最近一轮清单当正文（用官方 share_url 分享链接）。'
      + '🔴 规矩：**先卡片，后文字** —— 这次如果还要把视频给他，先调 `douyin_share_card`'
      + '（它的 `reason` 就是那条文字），**不要**先用这里发文字再补卡片。',
    parameters: {
      to: { type: 'string', description: '发给谁（抖音昵称，只用于显示；leave空用配置 dmTo）' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid 或 uid）。重名时**必须**给这个；留空用配置 dmToId' },
      text: { type: 'string', description: '私信正文（与 from_list 二选一）' },
      from_list: { type: 'boolean', description: '用最近一轮刷到的清单当正文（默认 false）' },
      top: { type: 'number', description: 'from_list 时放几条（默认 3，最多 5）' },
      dry: { type: 'boolean', description: '只验证通道，不真发（默认 false）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只返回草稿不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      let file = ''
      if (args.from_list) {
        const n = String(Math.max(1, Math.min(Number(args.top) || 3, 5)))
        const r1 = runNodeTool('mk-msg.mjs', [n], { timeout: 60_000 })
        if (r1.status !== 0) return { ok: false, error: '生成清单正文失败', stderr: r1.stderr.slice(0, 300) }
        file = join(stateDir, 'forward-msg.txt')
      }
      const text = String(args.text || '').trim()
      if (!file && !text) return { ok: false, error: '正文为空', hint: '传 text，或 from_list=true' }
      // 🔴 用户闸：没经本人当场同意，只回草稿，绝不发出
      if (args.confirm !== true) {
        let draft = text
        if (file) { try { draft = readFileSync(file, 'utf8') } catch { draft = '' } }
        return {
          ok: true, sent: false, needsConfirm: true, to, to_id: toId || undefined,
          draft: draft.slice(0, 1500), len: draft.length,
          note: '没发送 —— 先把这段草稿给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      if (file) argv.push('--file', file)
      else argv.push('--text', text)
      if (args.dry) argv.push('--dry')
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const res = pickJson(r.stdout)
      if (!res) return { ok: false, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
      if (res.ok) log(`dm -> ${res.to || to}${res.to_sec_uid ? ' (' + res.to_sec_uid + ')' : ''}: ${res.sent ? '已发送' : res.dry ? 'dry-run' : '未发送'}（${res.len} 字）`)
      if (res.sent) noteDm('text', res.to_sec_uid || toId)
      // ⭐ 发出去的话要进记忆 —— 不然下次读私信会以为这句话是凭空出现的
      if (res.sent) {
        try {
          const secUid = String(res.to_sec_uid || toId || '').trim()
          if (secUid) noteSent(stateDir, secUid, res.to || to, text, 'text')
        } catch (e) { log(`记发送记忆失败（不影响已发出）：${e?.message ?? e}`) }
      }
      return res
    },
  })

  tool({
    name: 'douyin_share_card',
    description: '⭐ 把视频以**抖音分享卡片**发给好友 —— 不是文字链接。'
      + '（文字链接在抖音里点不开，卡片才是「分享→发送给好友」那种可点的预览图。）'
      + '走无头 Chrome 里抖音自己的「分享给朋友」面板，屏幕上无窗口。'
      + '发完会**回读核实**卡片真的出现在「我发的」消息里；核实通过后再隔几秒自动补发 `reason`（为什么值得看）。'
      + '🔴 规矩：**先卡片，后文字** —— 要给文字就用 `reason`（会自动排在卡片后面），'
      + '别再调一次 `douyin_dm`，那样顺序会反成「文字 → 卡片」。',
    parameters: {
      aweme_id: { type: 'string', description: '视频 ID（19 位）。不给就用最近一轮清单里的' },
      to: { type: 'string', description: '发给谁（昵称，只用于显示）；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 发给谁：**稳定 id**（sec_uid）。重名时必须给这个；留空用配置 dmToId' },
      top: { type: 'number', description: '不给 aweme_id 时，发清单前 N 条（默认 1，最多 3）' },
      reason: { type: 'string', description: '⭐ 分享的理由（卡片之后单独发的一条正文，≤300 字）。'
        + '写"为什么值得你看"，不是操作台账；留空就只有一张光秃秃的卡片' },
      reason_delay_sec: { type: 'number', description: '卡片发出后隔几秒再发 reason（默认 5，0 = 立刻发）' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回预览不发送' },
    },
    async execute(args = {}) {
      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道发给谁', hint: '传 to / to_id，或在设置里填「私信发给谁」+「稳定 ID」' }
      const reasonText = String(args.reason || '').trim()
      const gapSec = args.reason_delay_sec === undefined ? 5 : Math.max(0, Math.min(Number(args.reason_delay_sec) || 0, 60))
      const orderWarn = orderWarning(toId)
      let ids = []
      if (args.aweme_id) {
        ids = [String(args.aweme_id).trim()]
      } else {
        let rows = []
        const readRows = () => {
          try { return JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { return [] }
        }
        rows = readRows()
        if (!rows.length) {
          runNodeTool('forward-run.mjs', ['--no-toast'], { timeout: 300_000 })
          rows = readRows()
        }
        ids = rows.slice(0, Math.max(1, Math.min(Number(args.top) || 1, 3))).map((r) => String(r.aweme_id))
      }
      if (!ids.length) return { ok: false, error: '没有可用视频 ID', hint: '先 douyin_forward 拉一轮' }
      // 🔴 用户闸
      if (args.confirm !== true) {
        let rows = []
        try { rows = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || [] } catch { rows = [] }
        const preview = ids.map((id) => {
          const r = rows.find((x) => String(x.aweme_id) === id) || {}
          return { aweme_id: id, desc: String(r.desc || '').slice(0, 60), author: r.author || '', digg: r.digg || 0, share_url: r.share_url || '' }
        })
        return {
          ok: true, sent: false, needsConfirm: true, to, count: ids.length, preview,
          reason: reasonText || undefined,
          reason_delay_sec: reasonText ? gapSec : undefined,
          warn: reasonText ? undefined : '没给 reason —— 卡片后面会一句话都没有，建议补一条「为什么值得看」',
          order_warning: orderWarn || undefined,
          note: '没发送 —— 先把这几条给用户看，他点头后再用 confirm:true 调一次',
        }
      }
      const results = []
      for (const id of ids) {
        const argv = [id, to]
        if (toId) argv.push('--to-id', toId)
        const r = runNodeTool('card-share.mjs', argv, { timeout: 200_000 })
        const j = pickJson(r.stdout)
        results.push(j || { ok: false, aweme_id: id, stdout: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 200) })
        if (!(j && j.ok)) break
        await new Promise((res) => setTimeout(res, 2200))
      }
      const sentN = results.filter((x) => x && x.sent).length
      // ⭐ 回读核实 —— 以前只验「分享面板关掉了」，那什么都证明不了。
      //    现在把会话读一遍，确认这张卡片真的出现在「我发的」消息里（aweType=800 + 同一个视频 id）。
      let readback = null
      if (sentN) {
        await new Promise((res) => setTimeout(res, 1500))
        const rArgs = ['--read']
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        const r2 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j2 = pickJson(r2.stdout)
        if (j2 && j2.ok) {
          const mineCards = (Array.isArray(j2.messages) ? j2.messages : []).filter((m) => m.from === 'me' && m.awe === 800)
          readback = {
            ok: true,
            sender_attribution: j2.sender_attribution,
            checked: ids.map((id) => ({
              aweme_id: id,
              in_my_messages: mineCards.some((m) => String(m.item) === String(id)),
            })),
            my_cards_in_view: mineCards.length,
          }
        } else {
          readback = { ok: false, error: '回读失败', detail: (j2 && j2.error) || String(r2.stderr || '').slice(0, 200) }
        }
      }
      const verified = !!(readback && readback.ok && readback.checked.every((c) => c.in_my_messages))
      if (sentN) noteDm('card', toId)

      // ⭐ 卡片之后隔几秒，补一句「为什么值得你看」。
      //    光一张卡片过去，对方只看到封面和标题，不知道你想让他注意哪儿 —— 理由才是分享这件事的一半。
      //    只在卡片**核实通过**之后才发：卡片都没落地就说"我为什么发给你"，对方会一头雾水。
      let reasonResult = null
      if (verified && reasonText) {
        if (gapSec > 0) await new Promise((res) => setTimeout(res, gapSec * 1000))
        const rArgs = []
        if (to) rArgs.push('--to', to)
        if (toId) rArgs.push('--to-id', toId)
        rArgs.push('--text', reasonText)
        const r3 = runNodeTool('im-send.mjs', rArgs, { timeout: 240_000 })
        const j3 = pickJson(r3.stdout)
        reasonResult = j3
          ? {
            ok: !!j3.ok, sent: !!j3.sent, len: reasonText.length,
            readback: !!j3.readback, my_msg_before: j3.my_msg_before, my_msg_after: j3.my_msg_after,
            newest_from: j3.newest_from, error: j3.error,
          }
          : { ok: false, error: '理由那一条没返回可解析结果', stderr: String(r3.stderr || '').slice(0, 200) }
        if (reasonResult.ok) log(`share-card reason -> ${to || toId}: 已发送（卡片后隔 ${gapSec}s，${reasonText.length} 字）`)
        else log(`share-card reason 发送失败：${reasonResult.error || '未知'}`)
      }

      // ⭐ 分享卡片也要进记忆（同时记"发的是哪个视频"）—— 聊过什么、发过什么都要有据可查
      if (sentN) {
        try {
          const secUid = String(toId || '').trim()
          if (secUid) {
            for (const r of results) {
              if (!r || !r.sent) continue
              const row = (() => { try { return (JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')).rows || []).find((x) => String(x.aweme_id) === String(r.aweme_id)) || {} } catch { return {} } })()
              noteSent(stateDir, secUid, to, `[分享视频] ${String(row.desc || '').slice(0, 60) || r.aweme_id}`, 'card')
            }
            if (reasonResult && reasonResult.ok && reasonText) noteSent(stateDir, secUid, to, reasonText, 'text')
          }
        } catch (e) { log(`记分享记忆失败（不影响已发出）：${e?.message ?? e}`) }
      }

      const allOk = sentN === ids.length && verified && (!reasonResult || reasonResult.ok)
      if (sentN) log(`share-card -> ${to}: 发出 ${sentN}/${ids.length} 张卡片，回读${verified ? '核实通过' : '未核实'}${reasonResult ? '，理由' + (reasonResult.ok ? '已发' : '失败') : ''}`)
      return {
        ok: allOk, sent: sentN, total: ids.length, to,
        readback,
        reason: reasonResult || undefined,
        reason_skipped: (verified && !reasonText) ? '没给 reason —— 只发了卡片，后面一句话都没跟上' : undefined,
        order_warning: orderWarn || undefined,
        results: results.map((x) => ({ aweme_id: x.aweme_id, ok: !!x.ok, sent: !!x.sent, error: x.error })),
        hint: verified ? undefined
          : (sentN ? '面板已经发出去点击了，但回读没在「我发的」消息里找到这张卡片 —— 别跟用户说发出去了，也没发理由' : undefined),
      }
    },
  })

  tool({
    name: 'douyin_notices',
    description: '读抖音互动通知：**谁 @ 了你**（含「别人评论区里的 @」）、'
      + '**谁回复了你的评论 / 在你评论下面说话**（type=31，2026-10-23 起才认出来 —— 以前这类全漏）、'
      + '谁关注/评论/点赞了你。'
      + '网页版没有通知中心页面，这个工具直接打通接口（只读，is_mark_read=0 不改变已读状态）。'
      + '返回里 at_n 是 @ 的条数，reply_n 是"回复类"的条数。'
      + '⭐ 每条都带 comment_id（要回就回这条）和 **root_comment_id**（楼根）—— '
      + '回复楼中楼里的人时，把这两个传给 douyin_comment_reply（mode:"api"）就行。',
    parameters: {
      raw: { type: 'boolean', description: '连原始条目一起返回（默认 false）' },
    },
    async execute(args = {}) {
      const venvPy = join(stateDir, '.venv', 'Scripts', 'pythonw.exe')
      if (!existsSync(venvPy)) return { ok: false, error: '还没装运行环境', hint: '设置页点「装主依赖」' }
      if (!existsSync(cookiePath(stateDir))) return { ok: false, error: '还没有 Cookie', hint: '先扫码登录' }
      const argv = [join(pluginDir, 'tools', 'notice-read.py')]
      if (args.raw) argv.push('--raw')
      const r = spawnSync(venvPy, argv, {
        encoding: 'utf8', timeout: 150_000,
        env: pyEnv({ DOUYIN_HOME: stateDir }), windowsHide: true,
      })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
      /**
       * ⭐ 把"回复类"单拎出来（type=31/32）—— 这是**回评论的真正入口**：
       *    别人在我楼里说话，我该"直接回复"他，不是 @ 他。
       *    以前只统计 type 45/46（@ 我），于是"别人回了我"这件事完全看不见。
       */
      const items = Array.isArray(j.items) ? j.items : []
      const replies = items.filter((x) => x && (x.type === 31 || x.type === 32) && x.comment_id)
      j.reply_n = replies.length
      if (replies.length) {
        j.replies = replies.slice(0, 10).map((x) => ({
          nickname: x.nickname,
          content: String(x.content || '').slice(0, 200),
          aweme_id: x.aweme_id,
          comment_id: x.comment_id,
          root_comment_id: x.root_comment_id,
          reply_to_text: x.reply_to_text || undefined,
          created_at: x.create_time,
        }))
        j.reply_hint = '要回他们：douyin_comment_reply { aweme_id, comment_id, root_comment_id, text, mode:"api" } —— '
          + '用**直接回复**，不要用 @（对方会收到「回复了我的评论」通知）。'
      }
      if (j.n) log(`notices: ${j.n} 条（@ 我 ${j.at_n}，回复类 ${j.reply_n}）`)
      return j
    },
  })

  tool({
    name: 'douyin_comment_reply',
    /**
     * ⭐⭐ 2026-10-23 **重新设计**（使用者：「回评论好像还有问题，要不要重新设计一下」）
     *
     * 老设计的三个坑（全部实测过）：
     *   ① 一个工具两副面孔：传了 mention_* 就偷偷走 UI 点选，不传就走 API ——
     *      调用方根本不知道自己走的是哪条、会不会真 @、要不要等 30 秒。
     *   ② 「真 @」依赖「先找到目标评论」：`--reply-cid` 遍历 React fiber
     *      （撞循环引用直接抛异常），改按正文找又要评论已渲染（80+ 条就找不到）。
     *      两条路一死，真 @ 就发不出去。
     *   ③ 发完看不见：评论列表按热度排、不给切最新 ⇒ 刚发的 0 赞评论读不到
 *      （注意：**不是"进审核"**，2026-10-23 实测推翻）。走 UI 那条路还拿不到 cid ⇒ 删不掉。
     *
     * 新设计：**把 mode 摆到明面上**，两条通道各司其职，谁也不偷偷降级。
     *   mode=api（默认）：回复楼层 / 发普通评论。**1 秒**，对方收到「回复了我的评论」通知，
     *                     正文里的 @昵称 只是文字（不是真 @）。
     *   mode=ui        ：**真 @**（名字可点、对方收到 @ 通知）。只能发**顶层评论**，
     *                     因为顶层不需要先找到任何评论 —— 这样彻底躲开"找不到评论"的死锁。
     *                     慢（20-40 秒），要 Chrome。
     *
     * ⭐⭐ 2026-10-23 **判断规则定稿**（使用者连着问了两次，我前两版都想错了）：
     *
     *   唯一判据 = **有没有"对话对象"**（对方留下过一条具体评论、我拿得到它的 cid）
     *
     *     有对话对象  ⇒ mode=api + comment_id（**直接回复**）
     *     没有对话对象 ⇒ mode=ui（@ 顶层，只能用于"我主动推东西给他"）
     *     楼中楼满 20 条 ⇒ **跳过，不管**（别换通道硬塞，那样既刷屏又把通知降级）
     *
     *   为什么"直接回复"更强（这是之前一直搞反的地方）：
     *     · 通知落「**回复我的**」流，绑定在那条评论上，点进去有上下文
     *     · @ 落「@我的」流，只是一句孤零零的话，对方不知道你在回他哪句
     *     · 楼中楼位置永久固定；@ 顶层热度 0，很快沉底（他自己都翻不到）
     *     · api 1 秒 + 拿得到 cid（可回读、可删除）；ui 20-40 秒 + 拿不到 cid（删不掉）
     *
     *   ⚠️ 曾经想过「顶层评论能让所有人看到，所以某些场景要用 ui」——
     *      **这个场景不存在**：本插件是给一个人用的（推视频/回话），"公开"不是目的，
     *      是抖音没有"只通知一个人"的顶层评论这一事实带来的副作用。
     */
    description: '在抖音评论区发言 / 回复某条评论。'
      + '⭐ **有 comment_id（要回某条评论）⇒ 用 mode:api，不要用 @**：'
      + '1 秒发出，对方收到「回复了我的评论」通知（比 @ 通知更强：绑定在那条评论上、有上下文、位置永久固定）。'
      + '⭐ **没有 comment_id（我主动推东西给使用者、他没留下可回的评论）⇒ 才用 mode:ui**：'
      + '真 @ 顶层评论，慢 20-40 秒、要 Chrome、拿不到 cid（删不掉）。'
      + '⚠️ 楼中楼满 20 条就跳过，别换通道硬塞。'
      + '⭐ **回复楼中楼里的人**（别人回了我的评论 / 回了我楼里的人）：'
      + '传那条 level-2 的 cid 当 comment_id 就行 —— 工具会自动判出"楼根"，'
      + '把 reply_id 填成楼根、reply_to_reply_id 填成对方那条（这是抖音的两个不同字段，'
      + '填错就变成一条冒出来的顶层评论）。也可以用 root_comment_id 显式指定楼根。'
      + '配合 douyin_notices / douyin_at_me 用：它们返回的 comment_id 就是 mode=api 的 comment_id，'
      + 'root_comment_id 就是可以直接传的楼根。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 id（douyin_notices 返回的 aweme_id）' },
      text: { type: 'string', description: '评论正文（≤500 字）。mode=ui 时**不要自己写 @昵称**，工具会自动加' },
      mode: {
        type: 'string',
        description: 'api = 快（回复/普通评论，@ 是文字）｜ui = 真 @（顶层评论，慢）。不传 = api',
      },
      comment_id: { type: 'string', description: '要回复的评论 cid（**只有 mode=api 支持**）；留空 = 发顶层评论。可以是顶层评论，也可以是楼中楼里的某条' },
      root_comment_id: {
        type: 'string',
        description: '【可选】楼根 cid（这栋楼的第一条顶层评论）。'
          + '回复**楼中楼**时用：不给就自动判（翻顶层列表找这条属于哪栋楼）；'
          + '判不出来工具会拒绝发送，不会瞎猜。回复顶层评论时不用传。',
      },
      mention_name: { type: 'string', description: '【mode=ui 必填】要真 @ 的昵称（必须和对方昵称完全一致）' },
      mention_uid: { type: 'string', description: '【可选】被 @ 人的 uid，用于拦「@ 自己」；不给就不拦' },
      confirm: { type: 'boolean', description: '🔴 必须由用户当场同意后传 true，否则只回草稿不发送' },
    },
    async execute(args = {}) {
      const aweme = String(args.aweme_id || '').trim()
      const text = String(args.text || '').trim()
      const replyTo = String(args.comment_id || '').trim()
      const rootCid = String(args.root_comment_id || '').trim()
      const mentionName = String(args.mention_name || '').trim()
      const mentionUid = String(args.mention_uid || '').trim()
      const mode = String(args.mode || 'api').trim().toLowerCase()
      if (!aweme) return { ok: false, error: '缺 aweme_id', hint: '先 douyin_notices 拿到 aweme_id' }
      if (!text) return { ok: false, error: '正文是空的' }
      if (text.length > 500) return { ok: false, error: `正文太长（${text.length} 字），抖音评论放不下` }
      if (mode !== 'api' && mode !== 'ui') return { ok: false, error: `mode 只能是 api 或 ui（收到 ${mode}）` }

      /**
       * 🔴 两条通道的**硬约束**（别让调用方踩空）：
       *   api 不支持真 @ —— 直接拒，别静默降级成"看着像 @ 的文字"
       *   ui  不支持回复楼层 —— 真 @ 只能顶层（否则又回到"先找评论"的死锁）
       */
      if (mode === 'api' && mentionName) {
        return {
          ok: false, unsupported: 'mention-in-api-mode',
          error: 'mode=api 发不了真 @（API 直发时服务端会剥掉 sec_uid：名字变蓝但对方收不到通知）',
          /**
           * ⭐ 2026-10-23 改提示：**先引导"根本不需要 @"**。
           *    以前这里教人"要真 @ 就用 ui"，等于把调用方往更差的那条路上推 ——
           *    如果他有 comment_id，直接回复就够了，通知还更强。
           */
          fix: replyTo
            ? '⭐ 你已经有 comment_id 了 ⇒ **不需要 @**：去掉 mention_name、直接用 mode:"api" + comment_id 回复他，'
              + '对方会收到「回复了我的评论」通知（绑定在那条评论上、有上下文、比 @ 通知更强，而且 1 秒就发出、拿得到 cid）'
            : '没有 comment_id 才需要 @：用 mode:"ui"（慢 20-40 秒，只能发顶层评论）',
        }
      }
      if (mode === 'ui' && replyTo) {
        return {
          ok: false, unsupported: 'reply-in-ui-mode',
          error: 'mode=ui 不能指定 comment_id（真 @ 只能发顶层评论）',
          fix: '⭐ 有 comment_id 就直接回复，**不要用 @**：改成 mode:"api" + comment_id，'
            + '对方收到「回复了我的评论」通知，1 秒发出、位置永久固定在楼里、还拿得到 cid 可以回读和删除。'
            + '只有"我主动推东西、他没有评论可回"时才用 mode:"ui"。',
        }
      }
      if (mode === 'ui' && !mentionName) return { ok: false, error: 'mode=ui 必须给 mention_name（要 @ 谁）' }
      /**
       * ⭐ 主动提醒（不拦）：有 comment_id 却选了 ui —— 上面已经拦了；
       *    这里反过来：**没有 comment_id 却想"回复"** —— 提醒他 mode=api 会发成顶层普通评论，
       *    不会通知任何人。别让他以为"发出去就有人收到"。
       */
      if (mode === 'api' && !replyTo) {
        // 顶层普通评论：没人会收到通知。只在草稿/结果里标注，不拦（有时就是要发顶层）。
      }
      // root_comment_id 只在"回复"时才讲得通
      if (mode === 'ui' && rootCid) {
        return { ok: false, error: 'mode=ui 不需要 root_comment_id（真 @ 只发顶层评论）' }
      }

      // 🔴 用户闸
      if (args.confirm !== true) {
        return {
          ok: true, sent: false, needsConfirm: true, mode,
          aweme_id: aweme, comment_id: replyTo || '(顶层评论)',
          root_comment_id: rootCid || '(自动判)',
          mention: mentionName || undefined,
          draft: mode === 'ui' ? `@${mentionName} ${text}` : text, len: text.length,
          eta: mode === 'ui' ? '约 20-40 秒（要起无头 Chrome 点选）' : '约 1 秒',
          /**
           * ⭐ 把"回复方式"讲清楚 —— 这是使用者反复问的那个点：
           *    回顶层评论的人 vs 回楼中楼里的人，抖音用的是**两个不同字段**。
           */
          how: mode !== 'api' ? undefined
            : (!replyTo
              ? '顶层普通评论：落在评论区第一层，**不会通知任何人**'
              : (rootCid
                ? `楼中楼回复：reply_id=${rootCid}（楼根）、reply_to_reply_id=${replyTo}（对方那条）`
                : `楼中楼回复：reply_id=<自动判出的楼根>、reply_to_reply_id=${replyTo}（对方那条）`)),
          note: '没发送 —— 先把这段给用户看，他点头后再用 confirm:true 调一次',
        }
      }

      /* ── ① 全局发送闸：防连发被限流（今天连发 3 条后 API 直接 403） ── */
      const gate = await sendGate(stateDir, mode)
      if (!gate.ok) {
        return {
          ok: false, error: '发送太密，被本地闸拦下了', wait_sec: gate.waitSec,
          hint: `上一轮发送在 ${gate.lastSec} 秒前。抖音对连发很敏感（实测连发 3 条后 403）。`
            + `等 ${gate.waitSec} 秒再试，或者干脆攒一批、隔几分钟发。`,
        }
      }

      /* ── ② mode=ui：真 @（顶层评论，不找任何目标 ⇒ 没有死锁） ── */
      if (mode === 'ui') {
        if (!selfUidCache) {
          const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
          const j = pickJson(g.stdout)
          if (j?.uid) selfUidCache = String(j.uid)
        }
        if (mentionUid && selfUidCache && String(mentionUid) === selfUidCache) {
          return { ok: false, error: `mention_uid=${mentionUid} 是登录号自己的 uid —— 这是 @ 自己` }
        }
        const mArgs = ['--aweme', aweme, '--name', mentionName, '--text', text]
        const mr = runNodeTool('comment-mention-ui.mjs', mArgs, { timeout: 300_000 })
        const mres = pickJson(mr.stdout)
        if (!mres) {
          return { ok: false, mode, error: '真 @ 执行器没返回可解析结果', stdout: String(mr.stdout || '').slice(0, 400), stderr: String(mr.stderr || '').slice(0, 300) }
        }
        markSent(stateDir, 'ui')
        if (mres.ok) {
          log(`comment-mention-ui -> ${aweme}: 真 @${mentionName} 已发布（UI 点选）`)
          try {
            noteMyComment(stateDir, aweme, { text, mention: mentionName })
            if (replyTo) markSeen(stateDir, aweme, [replyTo])
          } catch { /* 记不上不影响发 */ }
        }
        const readback = await readbackAfter(stateDir, aweme, { text, cid: '' })
        return {
          ...mres, mode, mention_verified: Boolean(mres.ok), readback,
          note: mres.ok
            ? '真 @ 走的是 UI 点选，sec_uid 保住了（对方会收到通知）。⚠️ UI 路径**拿不到 cid**，所以删不掉也查不到，回读只能按正文片段找'
            : undefined,
        }
      }

      /* ── ③ mode=api：回复楼层 / 普通评论（快，@ 是文字） ── */
      const argv = ['--aweme', aweme, '--text', text]
      if (replyTo) argv.push('--reply', replyTo)
      if (rootCid) argv.push('--root', rootCid)
      const r = runNodeTool('comment-api.mjs', argv, { timeout: 260_000 })
      const res = pickJson(r.stdout)
      if (!res) return { ok: false, mode, error: '发送器没返回可解析结果', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }

      /**
       * ⭐ 判不出楼根 ⇒ 脚本会明确拒绝（need_root），**千万别当成功**。
       *    以前 reply_id 填的是"对方那条"，服务端就把这条评论存成了**另一条顶层评论**：
       *    看着发出去了、还拿得到 cid，其实压根没进楼。这种"看起来成功"必须拦住。
       */
      if (res.need_root || (!res.ok && /判不出楼根/.test(String(res.error || '')))) {
        return {
          ok: false, mode, need_root: true, ...res,
          hint: '这条 cid 属于楼中楼，但工具判不出"楼根" ⇒ **已中止，没发出**。'
            + '处理办法：① 先 douyin_at_me / douyin_notices 读一次（它们会给出 root_comment_id）'
            + '② 把那个值传进 root_comment_id 再发。',
        }
      }

      /**
       * 🔴 403 = 被限流。这是今天新踩的坑：连发几条之后 API 直接 403。
       *    要**明确告诉调用方"等一会儿"**，而不是让它重试（重试只会更糟）。
       */
      if (res.http === 403 || /403|Forbidden/i.test(String(res.error || res.head || ''))) {
        bumpBlock(stateDir, 10)
        return {
          ok: false, mode, rate_limited: true, ...res,
          hint: '抖音限流了（403）。**别重试** —— 至少等 10 分钟。'
            + '连发评论会被判定异常，再发只会更久。',
        }
      }

      markSent(stateDir, 'api')
      if (res.ok) {
        try { noteMyComment(stateDir, aweme, { cid: res.cid || '', text }) } catch { /* 记不上不影响发 */ }
      }
      /**
       * ⭐ 核实"真的进了楼没有"（2026-10-23 定稿）
       *    comment-api.mjs 发完会**重读那一楼**核实（不再只信 publish 的响应 ——
       *    实测：同一台机器同一个视频，前 5 条响应带 level、后 7 条全不带）。
       *    三种结果都要如实说：
       *      placement.ok === true   ⇒ 真进了楼
       *      placement.ok === false  ⇒ 变成顶层评论了（楼根填错），别谎报成功
       *      placement.verified === false ⇒ 读不到（热度排序够不着）—— **不等于失败**
       */
      const placedRight = res.placement || undefined
      const readback = res.ok ? await readbackAfter(stateDir, aweme, { text, cid: String(res.cid || '') }) : null
      if (res.ok) {
        const pl = placedRight
        const plTag = !pl ? '?' : (pl.ok === true ? 'level=2 进楼' : (pl.ok === false ? '⚠️ 变成顶层了' : '未核实'))
        log(`comment-reply(api) -> ${aweme}/${replyTo || 'top'}（楼根=${rootCid || res.root || '自动'}）: cid=${res.cid}，落位=${plTag}，回读=${readback?.state || '?'}`)
      }
      return { ...res, mode, placement: placedRight, readback }
    },
  })

  /**
   * ⭐ 读"谁在评论区 @ 了我" —— 抽成函数，工具（douyin_at_me）和面板（/inbox）共用。
   *
   * 🔴 2026-10-22 改：以前这个逻辑**每次读都顺手 markSeen**，
   *    于是面板一打开就把所有 @ 标成"看过了"，后面的工具再也看不到 ——
   *    等于"看一眼就消失"，非常坑。
   *    ⇒ 现在默认**不标记**；只有明确回复了才标记（在 douyin_comment_reply 里做）。
   *
   * @param {{limit?:number, include_seen?:boolean, mark_seen?:boolean}} args
   */
  const readAtMe = (args = {}) => {
    if (!hasCredential(stateDir)) return { ok: false, error: '还没登录', hint: '先在设置页扫码登录' }
    const r = runPy('notice-read.py', ['--raw'], { timeout: 150_000 })
    const j = pickJson(r.stdout)
    if (!j) return { ok: false, error: '没读到通知', stderr: String(r.stderr || '').slice(0, 300) }
    const items = Array.isArray(j.items) ? j.items : []
    /**
     * ⭐ 两类都算"有人在跟我说话"：
     *   type 45/46 = 评论区 @ 我
     *   type 31/32 = **回复了评论 / 在我评论下面说话**（2026-10-23 才认出来）
     * 🔴 以前只看 45/46 ⇒「别人回了我的评论」全漏。这类恰恰是最该"直接回复"的：
     *    对方已经在我楼里了，回他一句就够，根本不用 @。
     */
    const ats = items.filter((x) => x && (x.type === 45 || x.type === 46 || x.type === 31 || x.type === 32))
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30))
    const includeSeen = args.include_seen === true

    const out = []
    for (const a of ats) {
      const aweme = String(a.aweme_id || '')
      const cid = String(a.comment_id || '')
      let mem = null
      try { mem = aweme ? loadCommentMemory(stateDir, aweme) : null } catch { mem = null }
      const alreadyReplied = Boolean(mem && cid && mem.seen.includes(cid))
      const myCommentsHere = mem ? (mem.mine || []).slice(-3) : []
      if (alreadyReplied && !includeSeen) continue
      const isReply = (a.type === 31 || a.type === 32)
      out.push({
        kind: isReply ? '回复了我的评论' : '@ 了我',
        nickname: a.nickname || '',
        uid: a.uid || '',
        content: String(a.content || '').slice(0, 300),
        aweme_id: aweme || undefined,
        comment_id: cid || undefined,
        /** ⭐ 楼根：回复楼中楼时**必须**传给 douyin_comment_reply 当 root_comment_id */
        root_comment_id: a.root_comment_id || undefined,
        /** 对方是在回我哪一句（type=31 才有） */
        replying_to: a.reply_to_text || undefined,
        video_url: a.video_url || (aweme ? `https://www.douyin.com/video/${aweme}` : undefined),
        created_at: a.create_time || undefined,
        before: alreadyReplied ? '回过' : '没回过',
        /** ⭐ 我在这条视频下说过什么（有记忆才知道该不该重复） */
        my_comments_here: myCommentsHere.map((m) => ({ at: m.at, text: m.text, mention: m.mention || undefined })),
      })
      if (out.length >= limit) break
    }

    // ⚠️ 只有**明确要求**才标记看过了（默认不标，免得"看一眼就消失"）
    if (args.mark_seen === true) {
      try {
        const byAweme = {}
        for (const a of ats) {
          const w = String(a.aweme_id || '')
          const c = String(a.comment_id || '')
          if (w && c) (byAweme[w] = byAweme[w] || []).push(c)
        }
        for (const [w, cs] of Object.entries(byAweme)) markSeen(stateDir, w, cs)
      } catch { /* 标记失败不影响读 */ }
    }

    log(`at-me: ${ats.length} 条（@ 我 / 回复我），未回的 ${out.length} 条`)
    return {
      ok: true,
      at_n: ats.filter((x) => x.type === 45 || x.type === 46).length,
      reply_n: ats.filter((x) => x.type === 31 || x.type === 32).length,
      total_n: ats.length,
      shown: out.length,
      list: out,
      /**
       * ⭐ 回法分两种，**看对方是在"顶层评论"还是在"楼中楼"**：
       *   · 顶层评论（对方的 cid 就是一条一级评论）⇒ 直接回他，reply_id = 他的 cid
       *   · 楼中楼（对方回在别人/我的楼下）      ⇒ reply_id = **楼根**、reply_to_reply_id = 他那条
       * 两种都用 mode:"api"（直接回复），区别只是**楼根要不要传**。
       * 工具会自动判楼根；判不出来会拒绝发送，让你显式传 root_comment_id。
       */
      hint: out.length
        ? '要回的话：douyin_comment_reply { aweme_id, comment_id, root_comment_id, text, mode:"api" }，先给用户看草稿。'
          + '⭐ 一律 mode:"api"（直接回复）—— 对方收到「回复了我的评论」通知，比 @ 通知更强、1 秒发出、拿得到 cid。'
          + '**不要用 @ 去"回复"人**。'
          + '⭐ 如果返回里对了 root_comment_id，**原样传进去**（那是楼根，别自己猜）；'
          + '没给就不用传，工具会翻列表自动判。'
        : (ats.length ? '这些都回过了（加 include_seen:true 可以再看一遍）' : '最近没有新的 @ / 回复'),
    }
  }

  tool({
    name: 'douyin_at_me',
    description: '⭐ **谁在跟我说话** —— 一次把「谁 / 在哪个视频 / 说了什么 / 我回过没有」整理好，'
      + '带上记忆上下文，方便决定回不回。只读，不发任何东西。'
      + '包含两类：① 评论区 @ 我（type 45/46）② **回复了我的评论 / 在我评论下面说话**（type 31/32，2026-10-23 起才认出）。'
      + '每条都带 kind（"@ 了我" / "回复了我的评论"）、comment_id、root_comment_id（楼根）。'
      + '⭐ 要回：用返回里的 aweme_id + comment_id + root_comment_id 调 douyin_comment_reply（mode:"api"）—— '
      + '**有 comment_id 就直接回复，不要用 @**：对方收到「回复了我的评论」通知，'
      + '绑定在那条评论上、有上下文、位置永久固定在楼里，1 秒发出还拿得到 cid。',
    parameters: {
      limit: { type: 'number', description: '最多看几条（默认 10，最多 30）' },
      include_seen: { type: 'boolean', description: '连已经回过的也列出来（默认 false，只看新的）' },
    },
    async execute(args = {}) {
      return readAtMe({ ...args, mark_seen: false })
    },
  })

  tool({
    name: 'douyin_remember',
    description: '⭐ 把关于某个人的**长期事实**记进记忆（住哪、养什么、在意什么、讨厌什么）。'
      + '下次聊天时 douyin_im_read 会把这些一起返回，回话就能接得上。'
      + '⚠️ 只记**对方亲口说过 / 明确能看出来**的事，别自己推测。',
    parameters: {
      to_id: { type: 'string', description: '⭐ 那个人的 sec_uid（douyin_im_read 返回里 to_sec_uid）' },
      facts: { type: 'array', items: { type: 'string' }, description: '要记的事实，一条一句（比如 ["在杭州", "养了只橘猫"]）' },
    },
    async execute(args = {}) {
      const secUid = String(args.to_id || cfg.dmToId || '').trim()
      if (!secUid) return { ok: false, error: '缺 to_id', hint: 'douyin_im_read 返回里有 to_sec_uid' }
      const facts = Array.isArray(args.facts) ? args.facts : []
      if (!facts.length) return { ok: false, error: 'facts 是空的' }
      const before = loadDmMemory(stateDir, secUid)
      if (!before) return { ok: false, error: '记忆里还没有这个人 —— 先 douyin_im_read 读一次会话，再记' }
      const after = addFacts(stateDir, secUid, facts)
      log(`记住 ${after.who.nick || secUid} 的 ${facts.length} 条事实（共 ${after.facts.length} 条）`)
      return { ok: true, who: after.who, facts: after.facts, added: facts.length }
    },
  })

  tool({
    name: 'douyin_memory',
    description: '看 / 管记忆：不传参就是看有多少；传 forget_uid 忘掉某个人；传 clear=true 清空全部（慎用）。',
    parameters: {
      forget_uid: { type: 'string', description: '要忘掉的那个人的 sec_uid' },
      clear: { type: 'boolean', description: '清空所有记忆（会删私信和评论区的全部记录）' },
    },
    async execute(args = {}) {
      if (args.clear === true) {
        const r = forgetAll(stateDir)
        log(`记忆：已清空（删了 ${r.removed} 个文件）`)
        return { ...r, stats: memoryStats(stateDir) }
      }
      if (args.forget_uid) {
        const uid = String(args.forget_uid).trim()
        const r = forgetDm(stateDir, uid)
        log(`记忆：忘掉了 ${uid}`)
        return { ...r, stats: memoryStats(stateDir) }
      }
      return { ok: true, stats: memoryStats(stateDir) }
    },
  })

  tool({
    name: 'douyin_im_groups',
    description: '列出我已建立的**抖音群聊**（type=2）：群名 + conv_id + 成员数/最后一条消息。只读，不发任何东西。'
      + '拿到的 conv_id 传给 douyin_im_read 的 `group_id` 就能读那个群的聊天记录。'
      + '⚠️ 只覆盖「已建立会话」（在消息列表里出现过的群）；没聊过、没被拉进去的群不在这里。',
    parameters: {},
    async execute() {
      let j = null
      try {
        const r = runPy('im-http.py', ['--list-groups'], { timeout: 30_000 })
        j = pickJson(r.stdout)
      } catch (e) {
        return { ok: false, error: `列群失败：${e?.message ?? e}` }
      }
      if (!j) return { ok: false, error: '列群失败：脚本没有输出 JSON' }
      if (!j.ok) return j
      log(`im-groups: ${j.group_count} 个群 / 共 ${j.conversation_count} 个会话，${j.ms}ms`)
      return {
        ok: true, via: 'http',
        group_count: j.group_count,
        conversation_count: j.conversation_count,
        groups: j.groups,
        hint: '读哪个群就把它的 conv_id 传给 douyin_im_read 的 group_id',
      }
    },
  })

  tool({
    name: 'douyin_im_read',
    description: '读私信/群聊：**有 to_id（sec_uid）时先走纯 HTTP 快路径**（~1 秒，不启浏览器，每条带真实时间戳和发送者），'
      + '目标按 sec_uid 反查核验、不在已建立会话里（比如陌生人）时自动退回无头 Chrome 路径。'
      + '每条都带 `from`（me / them / unknown），能分清「他刚回了什么」和「我上次说了什么」。只读，不发任何东西。'
      + '⭐ **群聊**：传 `group_id`（群 conv_id，先用 douyin_im_groups 拿）就走群聊只读路径 —— '
      + '群聊的 peer_uid 是群 id、不在人的 sec_uid 体系里，所以群聊**只按 conv_id 直读，不按人匹配**。'
      + '⭐ **会自动带上记忆**：返回里 `context` 是我记得的这个人（长期事实 + 之前聊过的内容），'
      + '回话之前先看它，别把聊过的事当没说过。返回里 `via` 标明这次走的哪条路。',
    parameters: {
      to: { type: 'string', description: '要打开的会话昵称；留空用配置 dmTo' },
      to_id: { type: 'string', description: '⭐ 稳定 id（sec_uid）；重名时给这个' },
      group_id: { type: 'string', description: '⭐ 群聊 conv_id（douyin_im_groups 返回的 conv_id）。给了就走群聊只读，忽略 to/to_id' },
      limit: { type: 'number', description: '返回最近几条（默认 30，最多 60）' },
    },
    async execute(args = {}) {
      const limit = Math.max(1, Math.min(Number(args.limit) || 30, 60))
      const groupId = String(args.group_id || '').trim()

      const withSeeHint = (list) => (Array.isArray(list) ? list : []).map((m) => {
        const c = m?.card
        if (!c) return m
        const id = String(c.item_id || '').trim()
        const u = String(c.url || '').trim()
        const sk = String(c.skey || '').trim()
        if (/^\d{6,}$/.test(id)) {
          return {
            ...m,
            see_hint: {
              tool: 'douyin_see',
              args: { aweme_id: id },
              why: '这是一条作品（视频或图文），上面的 text 只是标题，画面要用 douyin_see 去读',
            },
          }
        }
        if (/^https?:\/\//.test(u)) {
          const k = String(c.kind || 'image').toLowerCase()
          // 动图：card.url 是静帧（still.image），card.origin_url 才是整段动图。
          // 优先给 origin_url —— 静帧只能看到一帧，"她做了什么"经常在后面的帧里。
          const og = String(c.origin_url || '').trim()
          const best = k === 'gif' && /^https?:\/\//.test(og) ? og : u
          return {
            ...m,
            see_hint: {
              tool: 'douyin_see',
              args: { url: best, ...(sk ? { skey: sk } : {}), kind: k === 'gif' ? 'gif' : 'image' },
              why: k === 'gif'
                ? '这是一个动图，text 只是占位符「[动图]」，画面要用 douyin_see 去读（url 给的是整段动图，skey 别忘了）'
                : '这是一张图片，text 只是占位符「[图片]」，画面要用 douyin_see 去读（注意 skey 别忘了）',
            },
          }
        }
        return m
      })

      // ⭐ 群聊只读路径（2026-10-27）：
      //   🔴 群里没有「一个人」可以核验，peer_uid 是群 id。所以这里**不做身份推断**，
      //      调用方必须给 conv_id，工具照单直读；不给就报错，绝不按昵称/序号猜群。
      if (groupId) {
        let j = null
        try {
          const r = runPy('im-http.py', ['--conv-id', groupId, '--limit', String(limit)], { timeout: 30_000 })
          j = pickJson(r.stdout)
        } catch (e) {
          return { ok: false, error: `读群聊失败：${e?.message ?? e}` }
        }
        if (!j) return { ok: false, error: '读群聊失败：脚本没有输出 JSON' }
        if (!j.ok) return j
        const m = j.matched || {}
        const allMsgs = Array.isArray(m.messages) ? m.messages : []
        log(`im-read(群) ${m.name || groupId}: ${allMsgs.length} 条，${j.ms}ms`)
        return {
          ok: true, via: 'http', scope: 'group',
          group: m.name || '(无名群)',
          group_id: m.conv_id,
          matched_by: j.matched_by,
          count: m.message_count,
          messages: withSeeHint(allMsgs),
          their_latest: withSeeHint(allMsgs).filter((x) => x.from === 'them').slice(-3).reverse(),
          note: '群聊只读：发送侧（im-send.mjs）只支持私聊，别拿这里的 group_id 去发消息',
        }
      }

      const to = String(args.to || cfg.dmTo || '').trim()
      const toId = String(args.to_id || cfg.dmToId || '').trim()
      if (!to && !toId) return { ok: false, error: '不知道读谁的会话', hint: '传 to / to_id，或在设置里填私信对象；读群用 group_id' }

      /**
       * ⭐ 快路径（2026-10-24，二版）：先试纯 HTTP（tools/im-http.py，curl_cffi 伪装
       *    Chrome 指纹，不碰浏览器）。~1s 拿到全部已建立会话 + 每会话 20 条消息，
       *    每条带真实毫秒时间戳和发送者 uid（浏览器路径这两样都拿不到）。
       *    🔴 身份铁闸：**有 to_id（sec_uid）才走这条路**，并且必须由 im-http.py
       *      当场把 sec_uid 反查成数字 uid、与会话 peer_uid **严格相等**才算命中；
       *      反查失败 / 不在已建立会话里 / 没给 sec_uid ⇒ matched:null ⇒ 退浏览器。
       *      一版在这里栽过「认错人」：拿 sec_uid 和数字 uid 直接比（永远比不中），
       *      实际全靠「只有一个会话就拿来用」的侥幸捷径在撑 —— 已删，永不回来。
       */
      let http = null
      if (toId) {
        try {
          const r0 = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', String(limit)], { timeout: 30_000 })
          http = pickJson(r0.stdout)
        } catch { http = null }
        if (http && http.ok && http.matched) {
          const allMsgs = http.matched.messages || []
          const msgs = allMsgs.slice(-limit)
          let context = null
          let memory = null
          try {
            memory = mergeDmMemory(stateDir, toId, to || http.matched.nickname || '', allMsgs)
            context = dmContext(stateDir, toId, { recent: 12 })
          } catch (e) { log(`读私信记忆失败（不影响这次读）：${e?.message ?? e}`) }
          log(`im-read(HTTP) ${http.matched.nickname || toId}: ${allMsgs.length} 条，${http.ms}ms，没启浏览器`)
          return {
            ok: true, via: 'http',
            to: to || http.matched.nickname, to_sec_uid: toId,
            matched_by: 'sec_uid反查→uid严格相等（已建立会话）',
            count: allMsgs.length,
            mine: allMsgs.filter((m) => m.from === 'me').length,
            them: allMsgs.filter((m) => m.from === 'them').length,
            unknown: 0,
            sender_attribution: '协议字段（发送者 uid，不是头像左右推断）',
            messages: withSeeHint(msgs),
            their_latest: withSeeHint(allMsgs).filter((m) => m.from === 'them').slice(-3).reverse(),
            context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
            memory: memory ? { rounds: memory.rounds, total: memory.total, added: memory.added } : null,
          }
        }
        // matched:null（陌生人 / 反查失败 / 接口挂）⇒ 落到浏览器路径，它能读陌生人
      }

      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '读不到会话', stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 300) }
      if (!j.ok) return j
      const allMsgs = Array.isArray(j.messages) ? j.messages : []
      const msgs = allMsgs.slice(-limit)

      /**
       * ⭐ 记忆：读到的会话**合并进记忆**，然后把"上下文"一起返回。
       *    ⚠️ 顺序：**先合并、再取上下文** —— 反过来的话第一次读某人会返回
       *    "这个人以前没聊过"，但其实这一下刚读到一堆消息，等于刚认识就说不认识。
       */
      let context = null
      let memory = null
      try {
        const secUid = String(j.to_sec_uid || toId || '').trim()
        if (secUid) {
          memory = mergeDmMemory(stateDir, secUid, j.to || to, allMsgs)
          context = dmContext(stateDir, secUid, { recent: 12 })
        }
      } catch (e) { log(`读私信记忆失败（不影响这次读）：${e?.message ?? e}`) }

      if (j.count) log(`im-read <- ${j.to || to}: ${j.count} 条（我 ${j.mine} / 他 ${j.them} / 不明 ${j.unknown}）`)
      return {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid, matched_by: j.matched_by,
        count: j.count, mine: j.mine, them: j.them, unknown: j.unknown,
        sender_attribution: j.sender_attribution,
        messages: withSeeHint(msgs),
        // 他最近说的话（从新到旧），方便一眼看出要不要回。
        // ⚠️ 从**全量**算，不是从截断后的 msgs 算 —— 不然 limit 一小，他刚说的话就被切没了。
        their_latest: withSeeHint(allMsgs).filter((m) => m.from === 'them').slice(-3).reverse(),
        /** ⭐ 我记得的这个人（长期事实 + 之前聊过的）—— 回话前先看这个 */
        context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
        memory: memory ? { rounds: memory.rounds, total: memory.total, added: memory.added } : null,
      }
    },
  })

  tool({
    name: 'douyin_comments',
    description: '取一个作品/图文下的评论（**签名的只读接口**，带楼中楼层级）。这是判断「好不好玩」的主要文本依据。',
    parameters: {
      aweme_id: { type: 'string', description: '作品/图文 ID' },
    },
    async execute(args = {}) {
      const id = String(args.aweme_id || '').trim()
      if (!id) return { ok: false, error: '缺 aweme_id' }
      const r = runPy('api-comments.py', [id], { timeout: 300_000 })
      const text = String(r.stdout || '')
      const lines = text.split('\n')
      const head = lines.find((l) => /status_code=/.test(l)) || ''
      const items = lines.filter((l) => /^\s{2}cid=|^\s{6}└ /.test(l)).map((s) => s.replace(/^\s+/, ''))
      if (r.status !== 0) return { ok: false, error: '拉评论失败', stderr: String(r.stderr || '').slice(0, 300), head }
      return {
        ok: true, aweme_id: id, head,
        count: items.filter((s) => s.startsWith('cid=')).length,
        comments: items,
      }
    },
  })

  tool({
    name: 'douyin_comment_status',
    description: '查「发评论」这套现在什么状态：三个闸开没开、今天发了几条、还剩多少额度。'
      + '只读，什么都不发。**真要发评论用 douyin_comment_reply。**',
    parameters: {},
    async execute() {
      let today = 0
      try {
        const log = JSON.parse(readFileSync(join(stateDir, 'comment-log.json'), 'utf8'))
        today = (log[dayKey()] || []).length
      } catch { today = 0 }
      const perDay = Number(cfg.commentPerDay) || 0
      return {
        ok: true,
        autoComment: Boolean(cfg.autoComment),
        commentExecutor: cfg.commentExecutor || 'off',
        mentionName: cfg.mentionName || '',
        perRun: Number(cfg.commentPerRun) || 0,
        perDay,
        today,
        quotaLeft: Math.max(0, perDay - today),
        note: '真正发评论走 douyin_comment_reply，而且必须用户点头（confirm:true）才发得出去',
      }
    },
  })

  tool({
    name: 'douyin_status',
    description: '看它今天的状态：跑了没跑、挑了几条、额度剩多少、报告在哪、后端/登录/环境怎么样。',
    parameters: {},
    async execute() { return status() },
  })

  tool({
    name: 'douyin_run',
    description: '**立刻跑一轮**（不等窗口）：起一个 headless 会话，把 duty.md 交给它去刷、写报告。',
    parameters: {},
    async execute() { return { ok: true, ...runDuty('manual') } },
  })

  tool({
    name: 'douyin_update',
    description: '检查「刷抖音」插件有没有新版本。只读，不安装、不自动升级 —— 只告诉你当前版本、最新版本和升级命令。',
    parameters: { force: { type: 'boolean', description: '忽略 10 分钟缓存，立刻重查（默认 false）' } },
    async execute(args = {}) { return checkUpdate(args?.force === true) },
  })

  tool({
    name: 'douyin_notify',
    description: '**往用户屏幕上发一条消息**（Windows 通知）。不给参数就用当前通知方式做一次连通性测试；'
      + '给了 title/body 就直接把这条内容弹出去。返回到底弹没弹成功。',
    parameters: {
      title: { type: 'string', description: '通知标题（可省）' },
      body: { type: 'string', description: '通知正文（可省，建议 ≤ 200 字）' },
    },
    async execute(args) {
      const t = String(args?.title ?? '').trim()
      const b = String(args?.body ?? '').trim()
      if (!t && !b) return notifyTest()
      const r = toastSend({ title: t || '刷抖音', body: b || '（空消息）' })
      log(`手动通知：${r.sent ? '已弹出' : '失败'}${r.error ? ' / ' + r.error : ''}`)
      return { ok: r.ok, sent: r.sent, via: 'toast', error: r.error || '' }
    },
  })

  tool({
    name: 'douyin_setup',
    description: '装运行环境：在插件家目录建独立 venv、装 MCP 依赖，装完自动把 pythonPath 指过去。'
      + '**第一次用之前跑一次**。起完就返回，进度看 install.log。',
    parameters: {},
    async execute() { return runInstall() },
  })

  tool({
    name: 'douyin_login_save',
    description: '存抖音 Cookie（现在只有一条采集路，所以**所有功能都要它**）。'
      + '把浏览器 F12 → Network → 任意 douyin.com 请求 → Request Headers → 整行 Cookie 粘进来。',
    parameters: { cookie: { type: 'string', description: '整行 Cookie 字符串' } },
    async execute(args) {
      const r = saveCookie(stateDir, String(args.cookie ?? ''), log)
      // ⭐ 日志里绝不出现明文 Cookie
      log(`收到 Cookie（${redactCookie(String(args.cookie ?? '')).slice(0, 40)}…）`)
      return r
    },
  })

  /* ─────────────── 看一眼（补 2026-11-10 的窟窿） ─────────────── */
  /**
   * 🔴 2026-11-10 新增，起因是一次真实的翻车：
   *
   *   使用者发来一条图文作品（`itemId 7706176565289897209`，awemeType=68，1 张图），
   *   `douyin_im_read` 只回了 `{text:"遥想公瑾当年.", item:"770617..."}` ——
   *   **一个标题 + 一个 id，没有任何画面**。而当时 24 个 douyin_* 工具里
   *   没有任何一个能「拿 item_id 去看一眼画面」，于是只能照着标题猜。
   *   猜出来的话就是「我这边看不清字，只能说个意思」，然后被使用者当场抓到。
   *
   *   `tools/look-video.mjs` 其实早就写好了（看视频、看图文、读评论一条龙），
   *   问题是**它从来没有被暴露成工具** —— `grep look-video index.js` 是空的。
   *   这就是「能力有，但调不到」：工具清单里没有的东西，等于不存在。
   *
   *   所以这里给它补一个入口。支持三种输入，按消息里实际能拿到的字段来：
   *     · `aweme_id` —— 图文/视频作品（`douyin_im_read` 返回的 `item` 字段）
   *     · `url` + `skey` —— 私信里直接发的图片/动图（card.url / card.skey）
   *     · `md5`/`url` 只用于去重日志，不影响识别
   */
  tool({
    name: 'douyin_see',
    description: '⭐ 真正「看」一条内容：给作品的 aweme_id（图文/视频），或私信图片的 url+skey，'
      + '返回画面描述（逐字抄出图里的文字）+ 视频文案 + 高赞评论。'
      + '🔴 为什么要有它：`douyin_im_read` 对图文/图片只返回标题和 item，**没有画面**；'
      + '在拿到画面之前不要去描述那条内容 —— 照着标题猜一定会翻车。'
      + '用法：读到一条 `kind:"card"` 的消息后，拿它的 `item` 调这里，再回话。',
    parameters: {
      aweme_id: { type: 'string', description: '作品 id（`douyin_im_read` 返回的 item 字段，纯数字 15 位以上）' },
      url: { type: 'string', description: '私信图片/动图的地址（card.url 或 card.origin_url）' },
      skey: { type: 'string', description: '私信图床的解密密钥（card.skey，64 位 hex）；图片消息必带，否则拿到的是密文' },
      kind: { type: 'string', description: '图片消息的类型：image / gif（跟 card.kind 一致）' },
      comments: { type: 'boolean', description: '要不要读评论（默认 true，作品才有效）' },
      no_vision: { type: 'boolean', description: '只要元信息、不做视觉（调试用）' },
    },
    async execute(args = {}) {
      const aid = String(args.aweme_id || '').replace(/\D/g, '')
      const url = String(args.url || '').trim()
      const skey = String(args.skey || '').trim()
      const kind = String(args.kind || 'image').toLowerCase()
      // ⚠️ 不要试图改 url 里的 `~tplv-x-get:` 后缀去拿"更大的图/整段动图"：
      // 那串后缀是签名的一部分，改一个字符就 403（实测 medium/origin/thumb/空 全挂）。
      // 要整段动图就让调用方传 card.origin_url（see_hint 已经这么带了）。

      // ── 分支 A：私信图片/动图 —— 走 lib 里那条已经解过密的路径 ──
      if (!aid && url) {
        if (!/^https?:\/\//.test(url)) return { ok: false, error: 'url 不是 http(s) 地址' }
        try {
          const { fetchImageAsDataUri } = await import('./lib/video-understand.mjs')
          const { describeImage } = await import('./lib/video-card.mjs')
          const isGif = kind === 'gif'
          const f = await fetchImageAsDataUri(url, {
            maxBytes: isGif ? 8 * 1024 * 1024 : 6 * 1024 * 1024,
            timeoutMs: 15_000,
            skey,
          })
          if (!f?.ok || !f?.dataUri) {
            return {
              ok: false, seen: false,
              error: String(f?.error || 'fetch_failed'),
              hint: skey ? '解密失败，检查 skey 是否为 64 位 hex' : '抖音私信图床是 AES-256-GCM 密文，必须带 skey',
            }
          }
          const prompt = [
            isGif ? '这是对方发来的动图（只有一帧可看）。' : '这是对方发来的图片。',
            '按下面顺序说，不要跳步：',
            '① 把图里能看清的文字**尽量逐字抄下来**（正文、对话、按钮、标题、数字、水印都算）。',
            '   文字往往就是这张图想说的内容，不要总结、不要改写成通顺句子。',
            '② 再说这张图是什么：照片 / 手机截图 / 聊天记录 / 表情图 / 长图 / 纯文字卡片 / 表格。',
            '③ 最后用一两句话说清画面里有什么（谁、在哪、在做什么）。',
            '抄不出文字就说「图里没有可读的文字」，绝对不要编。总长度 300 字以内，文字多可以更长。',
          ].join('\n')
          const v = await describeImage(f.dataUri, { timeoutMs: 45_000, maxTokens: 900, prompt })
          const scene = String(v?.ok ? v.text : '').trim()
          if (!scene) return { ok: false, seen: false, error: String(v?.error || 'vision_failed') }
          log(`douyin_see(图片) ${isGif ? 'gif' : 'image'} ${f.bytes}B${f.decrypted ? '/解密' : ''}`)
          return {
            ok: true, seen: true, kind: isGif ? 'gif' : 'image',
            scene, bytes: f.bytes, decrypted: Boolean(f.decrypted), mime: f.mime || '',
            note: isGif ? '动图只给了静帧，只能描述这一帧' : '',
          }
        } catch (e) {
          return { ok: false, error: `看图片失败：${e?.message ?? e}` }
        }
      }

      // ── 分支 B：作品（图文/视频）—— 走 look-video.mjs ──
      if (!/^\d{6,}$/.test(aid)) {
        return { ok: false, error: '既没给可用的 aweme_id，也没给 url', hint: 'aweme_id 是 douyin_im_read 返回的 item 字段（纯数字）' }
      }
      const argv = ['--aweme', aid]
      if (args.comments === false) argv.push('--no-comments')
      if (args.no_vision) argv.push('--no-vision')
      const r = runNodeTool('look-video.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return { ok: false, error: '看不了这条作品（脚本没有输出 JSON）', stderr: String(r.stderr || '').slice(0, 400) }
      if (j.ok) {
        log(`douyin_see(作品) ${aid} how=${j.how_seen || '-'} scene=${String(j.scene || '').length}字`)
        return {
          ok: true, seen: Boolean(j.seen), aweme_id: aid,
          scene: String(j.scene || ''), speech: String(j.speech || ''),
          how_seen: String(j.how_seen || ''),
          desc: String(j.desc || ''), author: String(j.author || ''),
          cmts: Array.isArray(j.cmts) ? j.cmts : [],
          ...(j.images_total ? { images_total: j.images_total, images_seen: j.images_seen } : {}),
        }
      }
      return {
        ok: false, seen: false, aweme_id: aid,
        error: String(j.error || 'look_failed'),
        ...(j.filter_msg ? { filter_msg: String(j.filter_msg) } : {}),
        cmts: Array.isArray(j.cmts) ? j.cmts : [],
      }
    },
  })

  tool({
    name: 'douyin_config',
    description: '读 / 改「刷抖音」的设置。不给 patch 就是读；给了就改。'
      + '**只认 schema 里真有的字段**，别的键一律丢掉（塞一个未知键会让 DSH 那边整批拒绝）。'
      + '私信投递是这两个：`dmTo`（昵称，只显示用）+ `dmToId`（**稳定 id，真正决定发给谁**）。'
      + '例：`{"perDay":5,"noon":true,"night":true,"keywords":["搞笑","猫"],"dmTo":"示例好友","dmToId":"MS4wLjABAAAA…"}`',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      let host = null
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        host = (await persistCfg(args.patch)).host
      }
      return { ok: true, config: cfg, windows: WINDOWS, home: stateDir, venvReady: venvReadyNow(), host }
    },
  })

  /* ─────────────── 跑一轮 ─────────────── */
  const dutyStateFile = join(stateDir, 'state.json')
  // 登录号自己的 uid（懒加载缓存）—— 用于拦「@ 自己」
  let selfUidCache = ''





  /**
   * ⭐ 跨天翻篇：插件可能连续挂好几天，`state.json` 的 day 不该停在旧日期。
   *    只重置**按天算的计数**（轮数 / 挑了几条 / 谷时窗口），
   *    `dutyRunningAt` / `roundActive` 必须留着 —— 半夜跨点那一轮可能还在跑，不能把防双开的闸拆了。
   */
  const rollDay = () => {
    const st = readJson(dutyStateFile, {})
    const today = dayKey()
    if (st.day === today) return st
    const next = { ...st, day: today, count: 0, picked: 0, windows: {} }
    writeJson(dutyStateFile, next)
    return next
  }
  const bumpState = (patch) => {
    const st = { ...rollDay(), ...patch }
    writeJson(dutyStateFile, st)
    return st
  }
  // 加载时先翻一次篇：哪怕今天还没跑过任何一轮，state.json 也不该显示昨天
  rollDay()

  /**
   * ⭐ 「每天最多挑几条」承诺的是**全天总量** ⇒ 数**今天报告里那些 `### <视频ID>` 标题行**。
   *    围栏 ``` 里的内容一律不看（兜底报告会把日志尾部贴进去，那里的 ID 是"看过的"不是"挑中的"）。
   *    数不出来就当 0 条 —— 宁可少算，也别把"提到过"算成"挑中"。
   */
  const PICK_RE = /^#{2,3}[ \t]*(\d{15,25})/gm
  const reportFileOf = (now = new Date()) => join(outDir, `${dayKey(now)}.md`)
  const countPicks = (file) => {
    try {
      const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
      const ids = new Set()
      for (const m of text.matchAll(PICK_RE)) ids.add(m[1])
      return ids.size
    } catch { return 0 }
  }
  const countPickedToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    const fromState = st.day === dayKey(now) ? Number(st.picked || 0) : 0
    return Math.max(fromState, countPicks(reportFileOf(now)))
  }
  const roundsToday = (now = new Date()) => {
    const st = readJson(dutyStateFile, {})
    return st.day === dayKey(now) ? Number(st.count || 0) : 0
  }

  /**
   * ⭐ 优先用**真正的 Node.js** 去跑 dsh，而不是 Electron 的 `process.execPath`。
   *
   * 🔴 2026-10-20 实测（桌面版真机上必现）：
   *    用 `process.execPath`（Electron）+ `ELECTRON_RUN_AS_NODE=1` 起 dsh 会崩在启动阶段：
   *      `unsupported Electron runtime fingerprint: Node 24.21.0, V8 15.2.124.28-electron.0
   *       (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)`
   *    原因是 dsh 里有个 native addon（node-addon-require-builtin）按 Electron 大版本白名单校验，
   *    这台机器的 Electron 版本不在白名单里 ⇒ **那一轮直接 code=1 挂掉**。
   *    ⇒ 只要机器上有独立 node（开发机基本都有），就用它；没有才退回 Electron。
   *    （这也是 bili-scroll「桌面版上自动跑会卡/失败」那类反馈的根因之一。）
   */
  /**
   * ⭐⭐ 2026-10-29：无控制台的 node 解释器 —— 把 PE Subsystem 从 3(Console) 改成 2(GUI) 的副本。
   *
   * 🔴 起因：使用者反馈「打游戏被强行退出来」。查明是 Win11 把**新建控制台**交给
   *    Windows Terminal 托管（`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Console\%%Startup`
   *    的 DelegationConsole/DelegationTerminal 不存在 ⇒ 交给系统默认 = WT），
   *    而 WT **不受** `CREATE_NO_WINDOW` / `ShowWindow=0` / `windowsHide:true` 约束 ——
   *    所以本文件里所有 spawn 都带了 windowsHide，照样每次弹一个终端窗口抢焦点。
   *
   * ✅ 真正管用的只有一条：**让进程根本不申请控制台**。PE Subsystem 字段 = 2 的 exe
   *    连「申请控制台」这一步都不会做，Windows 也就没有窗口可画。
   *    实测：node.exe/ollama.exe/ python.exe 全是 2? 不 —— 它们都是 3；
   *    pythonw.exe 和 DSH Desktop.exe 是 2，所以它们从来不弹。
   *
   * 做法：复制一份 node.exe，读 PE 头 `e_lfanew`(0x3C) → `+0x5C` 的 Subsystem 字节改成 2。
   * 副本放在 `E:\_bot\bin\nodew.exe`（已验证 stdio 管道完全正常：stdout/stderr/stdin/argv 全通，
   * GUI 子系统只是在「没有管道可绑」时才不给控制台，有管道时照样读写）。
   *
   * 可用 `cfg.nodeQuietBin` 或环境变量 `DOUYIN_NODEW` 覆盖；找不到就退回原逻辑（会弹窗但能跑）。
   */
  const quietNode = (() => {
    const explicit = String(cfg.nodeQuietBin || process.env.DOUYIN_NODEW || '').trim()
    for (const p of [explicit, 'E:\\_bot\\bin\\nodew.exe'].filter(Boolean)) {
      try { if (existsSync(p)) return p } catch { /* 下一个 */ }
    }
    return ''
  })()

  const findNodeExe = () => {
    // ⭐ 先给无控制台副本 —— 它是 node 的完整拷贝，只是不申请控制台。
    if (quietNode) return quietNode
    try {
      // 没有 quietNode 时只做存在性探测，绝不再 spawn 一个裸 'node' 或 'where' ——
      // 两者都是 Console 子系统，在无控制台的父进程下会拉起可见的 Windows Terminal 窗口。
      // 查 PATH 在 JS 里做即可（lib/quiet.mjs 的 whichInPath）。
      return whichInPath('node') || ''
    } catch { return '' }
  }
  let nodeExeCache
  const nodeExe = () => {
    if (nodeExeCache === undefined) nodeExeCache = findNodeExe()
    return nodeExeCache
  }

  const resolveDsh = () => {
    // 运行时脚本用哪个解释器：有独立 node 就用它（见上面那段实测说明）
    const jsRunner = () => nodeExe() || process.execPath
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: jsRunner(), args: [explicit], shell: false }

    /**
     * ⭐⭐ 2026-10-23 重写（起因：使用者反馈「总是显示找不到 dsh：桌面版多半不是 NPM 全局安装的」）
     *
     * 🔴 原来只猜了两种形态：npm 全局装（APPDATA/npm/…）和「asar 被解开到 DSH_HOME/extracted-asar」。
     *    后者是**我这台机器的特例**（我手动解开过 asar），别人的桌面版**根本没解** ⇒
     *    四条候选路径全落空 ⇒ 每一轮都报"找不到 dsh"，后台轮次完全起不来。
     *
     * ✅ 现在按「**桌面版真正怎么跑起来**」的顺序找，而且把入口类型分成两种：
     *    ① `dsh/lib/bin.js`      —— 纯 CLI（npm 全局装、或解开的 asar）
     *    ② `dsh-desktop-host/lib/cli.js` —— ⭐ **桌面版自带的 CLI 入口**（Electron 里那个），
     *       任何桌面安装都必有：`<安装目录>/windows/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
     *       它就是 `DeepSeek Harness.exe … cli.js --profile headless …` 里的那个脚本。
     *
     * ⚠️ 顺带一条更硬的线索：**宿主自己的进程参数里就写着入口**（process.argv / execPath），
     *    优先从那里反推 —— 比猜路径靠谱得多。
     */
    const candidates = []

    // ① 宿主进程自己的入口（最靠谱）：Electron 跑的是 .../dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
    //    同一目录下的 cli.js 就是 headless 入口；同级再往上还有 @deepseek-ai/dsh/lib/bin.js
    try {
      for (const a of [...process.argv, process.execPath]) {
        const s = String(a || '')
        const m = /[\\/](dsh-desktop-host|dsh)[\\/](?:lib[\\/])?([\w.-]+\.(?:js|mjs))$/i.exec(s)
        if (!m) continue
        const dir = dirname(s)                       // .../@deepseek-ai/dsh-desktop-host/lib
        const pkgRoot = dirname(dir)                 // .../@deepseek-ai/dsh-desktop-host
        const scopeDir = dirname(pkgRoot)            // .../@deepseek-ai
        candidates.push(join(pkgRoot, 'lib', 'cli.js'))
        candidates.push(join(scopeDir, 'dsh', 'lib', 'bin.js'))
        candidates.push(join(scopeDir, 'dsh-desktop-host', 'lib', 'cli.js'))
      }
    } catch { /* 反推不到就继续猜 */ }

    // ② 桌面版标准安装位置：resources/app.asar/dsh/node_modules/@deepseek-ai/…
    //    （asar 里的文件 Node 也能直接读，不需要解开 —— 这是别人机器上唯一必然存在的路径）
    const resPaths = [process.resourcesPath, process.env.DSH_RESOURCES].filter(Boolean)
    for (const rp of resPaths) {
      for (const rel of [
        ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
        ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) candidates.push(join(rp, ...rel))
    }

    // ③ asar 被解开到 DSH_HOME/extracted-asar 的形态（我这台机器就是这样）
    try {
      const dshHome = process.env.DSH_HOME || dirname(stateDir)
      for (const rel of [
        ['extracted-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
        ['extracted-asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['extracted-asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) candidates.push(join(dshHome, ...rel))
    } catch { /* 继续 */ }

    // ④ npm 全局装（web 版 / 命令行装的用户）
    for (const g of [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)) candidates.push(g)

    /**
     * 🔴 关键：**不能只靠 existsSync** —— 桌面版的 `app.asar` 是虚拟文件系统，
     *    纯 node 的 existsSync 对它返回 false，但 Electron 宿主里（我们就在里面）
     *    通过 fs 补丁是**能读能跑**的。所以这里分两轮：
     *    ① 先挑 existsSync 为真的（最快、最稳）
     *    ② 再把 asar 内路径挨个**真跑一次 `--version`** 验证（跑通就用）
     *       —— 这一步是给"没解 asar 的普通桌面安装"准备的。
     */
    const isAsar = (p) => /\.asar[\\/]/i.test(String(p))
    const runnable = (p) => {
      try {
        const r = spawnSync(jsRunner(), [p, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 25_000 })
        const out = `${r.stdout || ''}${r.stderr || ''}`
        return r.status === 0 || /\d+\.\d+\.\d+/.test(out)
      } catch { return false }
    }

    // ① 真实存在（非 asar）的候选，直接返回
    for (const p of candidates) {
      if (!p || isAsar(p)) continue
      try { if (existsSync(p)) return { command: jsRunner(), args: [p], shell: false } } catch { /* 下一个 */ }
    }
    // ② asar 内的候选：真跑一次验证（Electron 宿主能跑）
    for (const p of candidates) {
      if (!p || !isAsar(p)) continue
      if (runnable(p)) {
        log(`dsh 入口（asar 内，已验证可跑）：${p}`)
        return { command: jsRunner(), args: [p], shell: false }
      }
    }
    // ③ 最后再兜一遍：非 asar 但 existsSync 没命中的（权限/符号链接怪情况）
    for (const p of candidates) {
      if (!p || isAsar(p)) continue
      if (runnable(p)) return { command: jsRunner(), args: [p], shell: false }
    }

    /**
     * ⚠️ 最后兜底：直接 `dsh`（走 PATH，shell:true）。
     *    桌面版 PATH 里通常没有 ⇒ 大概率还是失败，所以日志里把**试过哪些路径**打出来，
     *    使用者照着填设置里的「dsh 路径」就行，不用瞎猜。
     */
    log('⚠️ 找不到 dsh 入口。桌面版不是 npm 全局安装的，请把设置里「dsh 路径」填成下面之一：')
    log('   · <安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    log('   · <安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    log(`   （已试过 ${candidates.length} 条路径，都不存在）`)
    return { command: 'dsh', args: [], shell: true }
  }

  /**
   * ⭐ 值班轮能看到哪些 MCP 工具（抄 bili-scroll 的白名单思路）：
   *    overlay 把整个 server 挂成 stdio server ⇒ 那一轮的模型能看见**注册的所有工具**。
   *    发评论那条链路只该在用户显式打开时才给 ⇒ 用 env 在**注册层**拦掉。
   *    扫码登录（`douyin_login_interactive`）**永远不给** —— 那是给人做的。
   */
  const ensureOverlay = () => {
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const yml = []
    // ⭐ 0.2.1-rc.2 的 headless 自带 patch 把这三个服务 disabled 了 —— 在这里打开
    for (const id of ['credentials', 'authorization', 'deepseek-account']) {
      yml.push('- id: ' + id, '  disabled: false', '')
    }
    /**
     * 🔴 2026-10-20 实测（本机必现，不修就永远写不出报告）：
     *    headless 那一轮的沙箱默认把**工作区**当成唯一可写目录（本机是 `D:\aiagent\deepseek`），
     *    而报告要写到插件家（`<DSH_HOME>/douyin-duty/out/`）——**在插件家外面** ⇒ 被拒：
     *      「该路径在工作区 D:\aiagent\deepseek 之外，workspace-write 模式下拒绝访问」
     *    ⇒ 模型明明把 `douyin_prescreen` 调通了、也写出了正文，**最后一步落盘失败**，
     *      报告为空。而且它可能会**自作主张写到别处**或放弃。
     *    ✅ 修法：把这一轮的 sandbox 工作区**改成插件家**（仍然受限，不是 danger-full-access）：
     *       只放开"它该写的那一亩三分地"，别的照旧禁止。
     *    ⚠️ 注意这里必须用 **posix 路径**（YAML 里反斜杠会被当转义）。
     */
    yml.push(
      // ⭐ 让那一轮**的工作目录 = 插件家**（这是 bili-scroll 那条"cwd=插件家"的设计真正落地的地方）：
      //    `working-directory.defaultDirectory` 决定会话工作区，而 sandbox 的 workspaceRoot 默认跟着它走。
      //    只设 sandbox-policy 不够 —— 实测模型仍然把报告写到了 D:\aiagent\deepseek（宿主当前工作区）。
      '- id: working-directory',
      '  config:',
      `    defaultDirectory: '${posix(stateDir)}'`,
      '',
      // ⭐ 再显式钉一次 sandbox 工作区：两道都设，避免哪一层被 profile 自己那份覆盖掉。
      '- id: sandbox-policy',
      '  config:',
      "    mode: 'workspace-write'",
      `    workspaceRoot: '${posix(stateDir)}'`,
      '',
    )
    // ⭐ 让那一轮跟随桌面版当前选的模型（overlay 是最后叠加的一层 ⇒ 它赢）
    try {
      const deskPatch = join(dirname(stateDir), 'profiles', 'desktop', 'cordis.patch.yml')
      if (existsSync(deskPatch)) {
        const dlines = readFileSync(deskPatch, 'utf8').split(/\r?\n/)
        let start = -1
        for (let i = 0; i < dlines.length; i++) {
          /**
           * 🔴 2026-10-22 修的真 bug：这一行结尾**带注释** —— `- id: agent-default-model # magpie`
           *    旧正则 `/^-\s+id:\s*agent-default-model\s*$/` 要求 id 后面直接行尾，
           *    遇到 `# 注释` 就永远匹配不到 ⇒ overlay 里从来没写过模型
           *    ⇒ headless 一直用它自己 profile 里那份**错的** `workbuddy-ai/...`
           *    ⇒ 每轮一启动就 429（那条通道被限流），而桌面版用的 `workbuddy/...` 是好的。
           *    修法：允许 id 后面跟 ` # 注释`。
           */
          if (/^-\s+id:\s*agent-default-model\s*(?:#.*)?$/.test(dlines[i])) { start = i; break }
        }
        if (start >= 0) {
          let end = dlines.length
          for (let j = start + 1; j < dlines.length; j++) {
            if (/^-\s+id:/.test(dlines[j])) { end = j; break }
          }
          const block = dlines.slice(start + 1, end).join('\n')
          const grab = (k) => {
            const m = new RegExp('^\\s+' + k + ':\\s*(.+?)\\s*$', 'm').exec(block)
            return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : ''
          }
          const rawProvider = grab('provider'); const rawModel = grab('model'); const rawEffort = grab('reasoningEffort')
          if (rawProvider && rawModel) {
            /**
             * 🔴 2026-10-25 实测（本机必现，不修就每轮都失败）：
             *    桌面版那一行写的是 `provider: workbuddy` / `model: deepseek-v4.1-flash` /
             *    `reasoningEffort: high`，照抄进 overlay ⇒
             *      dsh: UNKNOWN_MODEL: pi-ai provider "workbuddy" has no configured model "deepseek-v4.1-flash"
             *    退出码 1，报告只剩占位。
             *    原因：headless 装的是 `dsh-connect-workbuddy`，它的模型目录比桌面版窄，
             *    没有 `.1-flash` 这个 id；能跑的是 `deepseek-v4-flash`。
             *    另外 `deepseek-v4-flash` **不接受 reasoningEffort** —— high/max/low 三种取值
             *    全部报 `UNSUPPORTED_REASONING_EFFORT`，所以对 workbuddy 系一律不写这个键。
             *    ⇒ 照抄之前先过一层「headless 认得的名字」校正。
             *    逃生口：DOUYIN_OVERLAY_PROVIDER / DOUYIN_OVERLAY_MODEL 环境变量可以直接钉死。
             */
            // 2026-10-27 实测（headless 真跑，纯文本轮 + 工具轮各验一次）：
            //   纯文本轮能过：deepseek-v4-flash / deepseek-v4-pro / kimi-k2.6 / glm-5.3 / hy3
            //   工具轮能过：  deepseek-v4-pro ✅ / glm-5.3 ✅ / hy3 ✅
            //   工具轮崩：    deepseek-v4-flash ❌ / kimi-k2.6 ❌ —— 报的也是 UNKNOWN_MODEL
            // ⇒ 这两个 id 的模型描述符在工具调用路径上解析不出来，纯文本轮看着"能用"是假象。
            //   刷抖音整轮都要工具调用，所以兜底目标必须是**工具轮实测能过的** deepseek-v4-pro。
            const WORKBUDDY_MODELS = new Set([
              'deepseek-v4-pro', 'glm-5.3', 'hy3',
            ])
            const MODEL_ALIAS = {
              'deepseek-v4-flash': 'deepseek-v4-pro', // 纯文本能用、工具轮崩，别放行
              'deepseek-v4.1-flash': 'deepseek-v4-pro',
              'deepseek-v4.1-flash-1017': 'deepseek-v4-pro',
              'mimo-v2.6-pro': 'deepseek-v4-pro', // 桌面版走 qwen 通道时的 id
            }
            const provider = String(process.env.DOUYIN_OVERLAY_PROVIDER || rawProvider).trim()
            // 只放行实测工具轮能过的；其余（含别的通道 id）一律兜底到 deepseek-v4-pro
            const mapped = MODEL_ALIAS[rawModel] || (WORKBUDDY_MODELS.has(rawModel) ? rawModel : 'deepseek-v4-pro')
            const model = String(process.env.DOUYIN_OVERLAY_MODEL || mapped).trim()
            // workbuddy 那两路（cn/global）的模型都不吃 reasoningEffort，写了反而直接报错
            const noEffort = /^workbuddy(-global)?$/.test(provider)
            const effort = noEffort ? '' : rawEffort
            yml.push('- id: agent-default-model', "  name: '@deepseek-ai/dsh-agent-default-model'", '  config:',
              `    provider: '${provider}'`, `    model: '${model}'`, ...(effort ? [`    reasoningEffort: '${effort}'`] : []), '')
            log(`overlay: 模型跟随桌面版 = ${provider} / ${model}（桌面写的 ${rawProvider} / ${rawModel}${rawModel !== model ? ' → 已按 headless 目录改名' : ''}）`)
          }
        }
      }
    } catch (e) { log(`读桌面版模型配置失败（不影响跑）：${e?.message ?? e}`) }

    /**
     * ⭐⭐ **给那一轮挂上 douyin 工具**（2026-10-22 修）
     *
     * 🔴 事故：之前那一轮的提示词里明写「你手上没有 douyin_* 工具，也不需要」——
     *    于是 `autoSend` / `在评论区 @ 你` 这些开关**全是空开关**：
     *    模型判断得再准，也没有发消息的入口，报告里只能写"建议发给他"。
     *
     * ✅ 现在：把插件自带的 MCP server（tools/mcp-server.mjs，12 个工具）
     *    挂进那一轮。它跟 DSH 里的 douyin_* 共用同一批脚本，
     *    发送类工具仍然带 confirm 闸 —— 自动跑时提示词会明确告诉它传 confirm:true。
     *
      * ⚠️ 挂载条件是 `autoSend || commentAtMe`：
     *    两个都关着的时候连工具都不给，从**能力层**保证"发不出去"，比靠提示词约束更硬。
     *
     * 🔴 2026-10-29 拆开（第 4 档分工）：
     *    原来只认 `autoSend`，于是「关掉 DSH 自己发卡片、全交 QQ 发」这个操作
     *    会把 MCP 工具整个抽走 ⇒ 连「在评论区 @ 你」也一起死掉。
     *    但真 @ 走的是 comment-mention-ui.mjs 的 UI 点选（要 CDP + 有头 Chrome），
     *    **QQ 侧根本没有这个能力** ⇒ 这条必须留在 DSH。
     *    ⇒ 改成 autoSend 管「发卡片/发私信」，commentAtMe 管「评论区 @」，
     *      两个开关各管一件事，挂工具看的是"两者之一还要不要"。
     */
    if (cfg.autoSend || cfg.commentAtMe) {
      try {
        const mcpServer = join(pluginDir, 'tools', 'mcp-server.mjs')
        if (existsSync(mcpServer)) {
          /**
           * 🔴 2026-10-22 实测 bug：`process.execPath` 在 Electron 宿主里是
           *    `DeepSeek Harness.exe`（桌面主程序），**不是 Node** ——
           *    MCP server 用它启动会跑飞（Electron 把 .mjs 当 app 入口）。
           *    必须用**独立 Node**。nodeExe() 是现成的探测（优先真 Node）。
           */
          /**
           * 🔴 2026-10-22 实测 bug ②：Loader 方言两条规矩（dsh-app-boot 的 applyEntryPatches）：
           *    ① 顶层必须是**数组**，每个元素是一个 patch；
           *    ② 新增插件要写 `- insert: [...]`（数组项里的 insert 键），且 insert **无 id** 时
           *       追加到树尾。之前直接写 `- id: mcp-douyin` —— 语义是"覆盖已有行"，
           *       headless 树里没有这个 id ⇒ 整条被**静默跳过**，模型还是看不见 douyin 工具。
           *    （2026-10-22 19:34 实测：这个格式 probe 会话列出全部 12 个 mcp__douyin__* 工具）
           */
          const nodeCmd = nodeExe() || process.execPath
          yml.push(
            '- insert:',
            '    - id: mcp-douyin',
            "      name: '@deepseek-ai/dsh-mcp-client'",
            '      config:',
            '        serverName: douyin',
            '        transport: stdio',
            `        command: '${posix(nodeCmd)}'`,
            `        args: ['${posix(mcpServer)}']`,
            '        env:',
            `          DOUYIN_HOME: '${posix(stateDir)}'`,
            '        # 发送类工具慢（要起无头浏览器），给足时间',
            '        toolCallTimeoutMs: 300000',
            '        failOnStartupError: false',
            '',
          )
          log(`overlay: 已给这一轮挂上 douyin MCP 工具（autoSend 开着，node=${nodeCmd}）`)
        } else {
          log(`⚠️ overlay: 找不到 ${mcpServer}，这一轮没有 douyin 工具（发不出去）`)
        }
      } catch (e) { log(`overlay 挂 MCP 失败（不影响判断）：${e?.message ?? e}`) }
    } else {
      log(`overlay: autoSend 关着 ⇒ 这一轮不挂 douyin 工具（从能力层保证发不出去）`)
    }

    try { writeFileSync(file, yml.join('\n'), 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  const promptFor = (why = 'manual') => {
    let duty = charterPath(pluginDir, stateDir)
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 按原文用 */ }
    const kws = Array.isArray(cfg.keywords) ? [...new Set(cfg.keywords.filter(Boolean))] : []
    const chs = Array.isArray(cfg.channels) ? [...new Set(cfg.channels.filter(Boolean))] : []
    const aus = Array.isArray(cfg.authors) ? [...new Set(cfg.authors.filter(Boolean))] : []
    // ⭐ 关键词轮转：每轮取「最久没刷」的 6 个，再打乱顺序（别每轮把全库搜一遍，那太慢太贵）
    const kwPick = (() => {
      if (!kws.length) return { take: [], note: '用章程里的默认那几组' }
      let st = {}
      try { st = readJson(join(stateDir, 'kw_rotation.json'), {}) || {} } catch { st = {} }
      const roundNo = (Number(st.round) || 0) + 1
      const used = (st.used && typeof st.used === 'object') ? st.used : {}
      const take = kws.slice().sort((a, b) => (Number(used[a]) || 0) - (Number(used[b]) || 0)).slice(0, Math.min(6, kws.length))
      for (let i = take.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[take[i], take[j]] = [take[j], take[i]] }
      try {
        const nextUsed = { ...used }
        for (const k of take) nextUsed[k] = roundNo
        writeJson(join(stateDir, 'kw_rotation.json'), { round: roundNo, used: nextUsed })
      } catch { /* 写不了就退化成随机，不影响这一轮 */ }
      return { take, note: '' }
    })()
    const nowBJT = (() => {
      try {
        const d = new Date(Date.now() + 8 * 3600_000).toISOString()
        return d.slice(0, 10) + ' ' + d.slice(11, 16) + '（Asia/Shanghai，+08:00）'
      } catch { return '' }
    })()
    // ⭐ 人设：**三层**，从上往下找，找到就用，绝不读插件外面任意路径。
    //    ① `$DOUYIN_HOME/persona.md` —— 使用者自己那份（设置页「我的人设」写的，或他手放进去的）
    //    ② `prompts/persona.md`     —— 插件包里那份（本地私有配置，**不随公开仓库发布**）
    //    ③ `prompts/persona.default.md` —— 中性默认（谁装了都能用，不带任何具体人）
    //    身份牌必须对得上，对不上就往下退 —— 这样用户放错文件也不会串人设。
    let ownerDoc = ''
    let personaWarn = ''
    let personaFrom = ''
    try {
      const cands = [
        { file: join(stateDir, 'persona.md'), who: 'douyin-scroll', from: '使用者自己那份（$DOUYIN_HOME/persona.md）' },
        { file: join(pluginDir, 'prompts', 'persona.md'), who: 'douyin-scroll', from: '插件自带' },
        { file: join(pluginDir, 'prompts', 'persona.default.md'), who: 'default', from: '默认中性人设' },
      ]
      const bad = []
      for (const c of cands) {
        if (!existsSync(c.file)) continue
        const raw = readFileSync(c.file, 'utf8')
        const firstLine = raw.split(/\r?\n/, 1)[0] || ''
        const m = /persona:\s*([A-Za-z0-9_-]+)/i.exec(firstLine)
        const who = m ? m[1].toLowerCase() : ''
        if (who !== c.who) { bad.push(`${c.file}（牌子是「${who || '没有'}」，应为 ${c.who}）`); continue }
        ownerDoc = `\n\n===== 我的人设（${c.from}，**按这个来**）=====\n` + raw.slice(0, 6000) + '\n===== 设定结束 =====\n'
        personaFrom = c.from
        break
      }
      if (bad.length) {
        personaWarn = `\n\n⚠️ 有 ${bad.length} 份人设文件的身份牌不对，已跳过：${bad.join('；')}\n`
        log(`人设身份牌不对，已跳过：${bad.join(' | ')}`)
      }
      if (personaFrom) log(`本轮人设来源：${personaFrom}`)
    } catch (e) { log(`读人设失败：${e?.message ?? e}`) }

    const quota = Math.max(0, Number(cfg.perDay) || 0)
    const already = countPickedToday()
    const left = Math.max(0, quota - already)
    const commentOn = Boolean(cfg.autoComment && cfg.mentionName && cfg.commentExecutor !== 'off')

    return `你是这个账号的抖音助手。`
      + `⏰ **现在时间（真实北京时间）：${nowBJT}** —— 报告里凡是提到时间，一律用这个，**别自己猜**。`
      + `⭐ 这一轮的工作目录是 ${stateDir}（插件家），**报告和判重表都写在这里面**。`
      + ownerDoc
      + personaWarn
      + (ownerDoc ? '' : '⭐ 这一轮**没有**拿到使用者的人设 ⇒ **按中性说话**，别扮演任何人。')
      + `\n\n⭐ **这一轮只有一件事**：读章程 ${duty}，按里面的判据刷一轮抖音，把报告写到 `
      + `${join(outDir, `${dayKey()}.md`)}。`
      + (cfg.reportLevel === 'brief'
        ? `日报写成**薄版**：每条一两行（值不值得 + 链接）就够，别写长摘要。`
        : cfg.reportLevel === 'off'
          ? `这一轮**不要写日报文件**；只有真发了评论才留一句话。`
          : `日报写**完整版**（为什么值得 + 你自己的一句话）。`)
      + (cfg.reportLevel === 'off' ? '' : `⚠️ 今天那份报告里可能已有上一轮的内容 ⇒ **追加到末尾，别覆盖**（配额按全天算）。`)
      + (cfg.reportLevel === 'off' ? '' : '⭐ 报告里**每挑中一条**，第一行必须顶格写 `### 视频ID`（例 `### 7401234567890123401`）—— 宿主**就数这些标题行**算今天挑了几条。只是提到 / 跳过 / 判断不了 的**不要**加这种标题（加了会吃掉额度）。')
      + `\n\n📋 **这一轮的输入**：`
      + `关键词：${kwPick.take.length ? kwPick.take.join('、') : kwPick.note}`
      + (chs.length ? `；分类：${chs.join('、')}` : '')
      + (aus.length ? `；指定作者：${aus.join('、')}` : '')
      + `。⭐ **就搜这些，别自己加词**（尤其是别自造"翻跳/宅舞"那类词把类型带偏）。`
      + `\n🎯 **先读** \`${join(stateDir, 'round-evidence.json')}\` —— 候选和证据已经帮你抓好放在那儿了。`
      + ` 每条都有：文案 / 作者 / 时长 / 发布时长 / 四个互动数 / 三个比值 / 前几条的高赞评论。`
      /**
       * ⭐⭐ 工具说明（2026-10-22 改）
       * 🔴 事故：这里原来写「你手上没有 douyin_* 工具，也不需要」——
       *    结果 `autoSend` / `在评论区 @ 你` 全是空开关，模型想发也没入口。
       *    现在按 autoSend 分流：开着就挂 MCP 工具（见 ensureOverlay），并且明说有哪些。
       */
      + (cfg.autoSend
        ? ` ⭐ **这一轮你手上有 douyin 抖音工具**（通过 MCP 挂载，**以你手上真实的工具清单为准**——名字可能带 \`mcp__douyin__\` 前缀，比如 \`mcp__douyin__douyin_dm\`，用清单里的全名调用）：\n`
          + `   - 发私信：\`douyin_dm\`（参数 to / to_id / text / confirm:true）\n`
          + `   - 发分享卡片：\`douyin_share_card\`（参数 aweme_id / to / to_id / reason / confirm:true）—— 文字链接点不开，**必须用它**\n`
          + `   - 发评论 / 回复评论：\`douyin_comment_reply\`（参数 aweme_id / text / comment_id? / confirm:true）\n`
          + `   - 真 @：\`douyin_comment_mention\`（参数 aweme_id / name / text / confirm:true）\n`
          + `   - 查状态：\`douyin_status\` / \`douyin_whoami\`\n`
          + `   ⚠️ 采集和算比值仍然是代码干的活（证据包已经抓好），你不用重新取候选。\n`
          + `   ⚠️ 发送类工具**必须传 confirm:true**，否则只回草稿不发送。\n`
        /**
         * 🔴 2026-10-29 新分支（第 4 档分工）：autoSend 关着、但「在评论区 @ 你」开着。
         *    工具**还在手上**，但只准用 mention 那一个 —— 卡片归 QQ 侧发，DSH 不许再发。
         */
        : (cfg.commentAtMe && cfg.mentionName && cfg.commentExecutor !== 'off')
          ? ` ⭐ **这一轮你手上有 douyin 抖音工具，但只用得上一个**（以你手上真实的工具清单为准，名字可能带 \`mcp__douyin__\` 前缀）：\n`
            + `   - ✅ 可以用：\`douyin_comment_mention\`（真 @，参数 aweme_id / name / text / confirm:true）\n`
            + `   - 🔴 **不许用** \`douyin_share_card\` / \`douyin_dm\` —— 发卡片这件事已经交给另一个端做（它读你的报告、按自己的人设发），\n`
            + `       你在这里再发一遍 = 同一个视频发两次卡片，他看到会莫名其妙。\n`
            + `   ⚠️ 采集和算比值仍然是代码干的活（证据包已经抓好），你不用重新取候选。\n`
          : ` ⚠️ 这一轮**你手上没有 douyin\_* 工具**（自动发送和评论都关着）—— 采集和算比值是代码干的活，你只负责判断和写报告。\n`)
      + `⚠️ 抖音 web **没有可用的关键词搜索接口**，上面这些关键词/分类**只能当报告里的标注**，别以为它按词搜了。`
      + `\n🔎 **判断口径**（章程里有更细的）：你**看不到画面**，只能看**文案 + 标签 + 互动比值 + 高赞评论**。`
      + `所以你要回答的是「**值不值得他花 15 秒点开**」，不是「视频讲了什么」。`
      + `⭐ **每条结论都要引用具体证据**（哪条评论、哪个比值）；证据不够就写「判断不了」，**别硬猜**。`
      + `\n📉 **跳过要计数**：证据包里的 \`dropped\` 就是采集侧硬筛掉的条数——`
      + `\`no_desc\` 没文案 / \`too_short_video\` 时长<12 秒 / \`short_and_quiet\` 文案太短且评论少。`
      + `照实写进报告（「因文案太短且评论少跳过 N 条」…），别让使用者以为漏抓了。`
      + `\n`
      + (already > 0
        ? `今天已经挑过 ${already} 条 ⇒ **这一轮最多再挑 ${left} 条**（「每天最多 ${quota} 条」是全天总量，不是每轮）；`
        : `今天最多挑 ${quota} 条；`)
      + `采集：推荐流只读接口（不签名、不碰写接口）。`
      + `\n判重表 = ${join(stateDir, 'seen.md')}（**就是这个绝对路径**）；读不出来/写不进去**必须在报告里明说**。`
      + `\n`
      /**
       * ⭐ 自动发送总开关（autoSend）—— 这一段是"后台跑一轮时到底能不能发东西"的唯一判据。
       *    默认开（用户要求）；关掉就一个字都不许发。
       *
       * 🔴 2026-10-29 改（第 4 档分工）：关着的时候不再等于"什么都不许发"，
       *    而是"发卡片/私信不归你管了，归 QQ 那个端"；评论区的 @ 仍然归 DSH，
       *    因为真 @ 要 CDP 点选，QQ 侧没有这个能力。
       */
      + (!cfg.autoSend
        ? `🔴 **发卡片这件事不归你了** —— 不开分享卡片、不发私信。`
          + `\n   ⭐ 原因：另一个端（QQ 那个）会读你写的这份报告，按她自己的人设把卡片发给他。`
          + `\n   🔴 所以：**不要调用 \`douyin_share_card\` / \`douyin_dm\`** —— 你再发一遍就是同一个视频两张卡片。`
          + `\n   报告照旧写全（尤其「一句话」和「为什么值得」两栏，那是她发卡片时要用的素材）。`
          + `\n   报告里写「待发：<视频ID>」就够，别写「已发卡片」。`
          + (cfg.commentAtMe ? '' : `\n   📝 评论也一起关着，这一轮只判断、只写报告。`)
        : [
          /**
           * 🔴 2026-10-22 收紧：原来写「可以发私信/分享卡片」——模型把它当可选项，
           *    19:34 轮只发了 @ 评论、卡片没发。使用者的规矩是「默认就是要发消息」：
           *    挑到推荐（### 那条）⇒ **必须**发分享卡片给 dmTo（reason 里带理由，
           *    工具自己保证先卡片后文字）。@ 评论是叠加任务，不是替代。
           */
          `🟡 **自动发送开着 —— 挑到的每一条推荐（加了 \`###\` 那条）都要发**：\n`
          + `   ⭐ **有几条 \`###\` 就发几张卡片**（同一轮 3 条推荐 = 3 张卡片），\n`
          + `      只有「同一个视频」才不许发两遍。别把「一轮最多发一次」误读成整轮只发 1 条。\n`
          + `   ① 对**每一条**推荐都调一次 \`douyin_share_card\`，参数：\n`
          + `      - aweme_id = 那一条的 ID（一条一次调用）\n`
          + `      - to_id = '${String(cfg.dmToId || '').trim()}'（**私信目标**，配置里的稳定 id）\n`
          + `      - to = '${String(cfg.dmTo || '').trim()}'（只用于显示的昵称）\n`
          + `      - reason = 那一条为什么值得看，**20-60 字**（各写各的，别复制同一句）\n`
          // 2026-10-27 修：使用者原话「她发视频之后给的那个评论太没有活人感了」。
          // 旧规则只说「为什么值得看」，没禁指标 ⇒ 模型每句都念「转/赞 0.62、藏赞比 0.17、转发 91 万」，
          // 念出来像数据日报，不像人推荐视频。这条是给人看的私信，不是分析报告。
          + `        ⭐ reason 要像**随手打给人**的一句话，不像报告：\n`
          + `          · 先写画面/梗本身（视频里到底发生了啥、哪一秒好笑），再写你什么反应\n`
          + `          · 🔴 **禁止任何数字指标**：不许出现「转/赞」「藏/赞」「万赞」「倍数」「0.62」「91万」\n`
          + `            「参与度」「信号」「置信度」「数据」这类词 —— 那是报告里的「为什么值得」栏，\n`
          + `            不是私信。（报告里照旧写指标，私信里一个字都别带）\n`
          + `          · 短句、口语、少标点。像发微信不像写作文\n`
          + `          ✅「狗头卡进纸箱那个洞，翻来翻去一脸无所谓，评论区一句怎么翻都有面，笑死」\n`
          + `          ✅「猫凑到洋葱旁边闻了一下 眼睛直接红成那样 后面还硬撑着不走」\n`
          + `          ✗「转/赞 1.06，转发比点赞还多，是本轮最强的想转给朋友的信号」（数据播报）\n`
          + `          ✗「双梗叠加，转发是点赞的0.62倍，12秒看个新鲜」（数据 + 分析腔）\n`
          + `      - confirm = true\n`
          + `      ⚠️ 两条卡片之间隔几秒再发下一条（工具自己会把 reason 排在卡片后面）\n`
          + `      ⚠️ 不要再单独调 \`douyin_dm\` 补文字 —— reason 会自动排成「先卡片、后理由」\n`
          + `   ② 发完在报告里**逐条**写「已发卡片：<视频ID>」（发了几条写几行）`,
          (commentOn
            ? `📝 自动评论也开着：每轮最多 ${Number(cfg.commentPerRun) || 0} 条，每条 **≤120 字**，`
              + `**正文必须以「@${cfg.mentionName} 」开头**。直接发就好，不用先做任何「额度确认」。\n`
              + `   ⚠️ 这条和下面「在评论区 @ 你」**共用同一个额度** —— 真 @ 已经发了，`
              + `就别再补一条普通评论（同一个视频下面留两条 = 刷屏）。`
            : `📝 评论：默认不发。`),
          // ⭐ 「在评论区 @ 你」已搬出这个数组（2026-10-29）—— 见下面 autoSend 判断之后那段。
          //    原因：它原来嵌在这里 ⇒ 一关 autoSend 整段消失，真 @ 跟着死掉；
          //    但真 @ 要 CDP 点选，QQ 侧没有这个能力，所以必须独立存活，只受 commentAtMe 管。
        ].filter(Boolean).join('\n'))
      /**
       * ⭐⭐ 「在评论区 @ 你」—— 用户 2026-10-22 要求。
       *    这一轮挑到值得看的视频后，去那个视频的评论区发一条 @ 使用者本人的评论。
       *    前提：commentAtMe 开着 + 知道要 @ 谁。
       *
       * 🔴 2026-10-29 从 autoSend 数组里搬出来（第 4 档分工）：
       *    原来它嵌在 `autoSend 开着` 的那个数组里 ⇒ 一关 autoSend，这段提示整段消失，
       *    真 @ 跟着一起死。但真 @ 要 CDP 点选（comment-mention-ui.mjs），QQ 侧没有这个能力
       *    ⇒ 它必须独立存活，只受 commentAtMe 管。
       *
       * ⭐ 2026-10-23 判断规则定稿（使用者连着问了两次，前两版都想错了）：
       *    这个功能是**主动推东西**给使用者 —— 那个视频下面**没有他的评论可回**
       *    ⇒ 属于"没有对话对象"，所以用 @ 顶层是**正确的**。
       *    但「有人 @ 我，回他」是另一回事：有 comment_id ⇒ 必须**直接回复**，不许用 @。
       *    规则一句话：**有评论可回就回复，没评论可回才 @。**
       */
      + (cfg.commentAtMe
        ? (() => {
          const who = String(cfg.commentSelfName || '').trim() || (readJson(join(stateDir, 'account.json'), {})?.nick || '')
          if (!who) {
            return `⚠️ 「在评论区 @ 你」开着，但**不知道要 @ 谁**（commentSelfName 空、account.json 也没有昵称）`
              + ` ⇒ 这一轮**跳过 @ 评论**，只写报告。`
          }
          return `🔴 **「在评论区 @ 你」开着 —— 这是这一轮的重点任务**：\n`
            + `   ⭐ 为什么这里用 @ 而不是"直接回复"：这个视频下面**没有他的评论可回**，\n`
            + `      只能靠 @ 通知把他叫过来。这是 @ 唯一该用的场景。\n`
            + `   挑到**最值得的那 1 条**（只挑 1 条，别贪）之后：\n`
            // 2026-10-27 修：headless 轮挂的是 mcp-server.mjs 那层，它的 douyin_comment_reply
            // 只有 aweme_id/text/comment_id/root_comment_id/confirm，**没有 mode、没有 mention_name**
            // ⇒ 旧提示词让模型去调一个不存在的参数，每轮都要自己纠错一遍。真 @ 的工具是 douyin_comment_mention。
            + `   ① 调 \`douyin_comment_mention\`（真 @，UI 点选，会起无头 Chrome，约 20-40 秒），参数：\n`
            + `      - aweme_id = 那条视频的 ID\n`
            + `      - name = "${who}"（**必须和对方昵称完全一致**）\n`
            + `      - text = 一句 20-60 字的话（**不要自己写 @${who}**，工具会自动加这个 mention）\n`
            + `      - confirm = true（自动跑，不用再问）\n`
            + `      ⚠️ 如果返回 \`@ 弹层里没找到这个名字\` ⇒ 这一轮**放弃 @**，在报告里写明\n`
            + `        「真 @ 没成（昵称搜不到）」—— **不要**改成发普通评论凑数（那是刷屏）。\n`
            // 2026-10-27 修：旧模板「这条我觉得你会喜欢 —— <一句话理由>」是明显的模板腔，
            // 破折号 + 万能开场白，谁看都知道是机器发的。评论区的话要像随手评论。
            + `   ② 评论内容（20-60 字）：**直接说视频里那一幕**，别加"这条我觉得你会喜欢"这类开场白，\n`
            + `      也别用破折号硬接。「@${who} 」工具会自己加，你只管正文。\n`
            + `      🔴 同样**不许出现任何数字指标**（转/赞、藏/赞、万赞、倍数、参与度）—— 评论区没人这么说话。\n`
            + `      ✅「洋葱那一刀下去 它凑过去闻 眼睛当场就红了 还不走 笑不活了」\n`
            + `      ✅「翻来翻去都一脸无所谓 评论区那句怎么翻都有面 精准」\n`
            + `      ✗「这条我觉得你会喜欢 —— 转/赞 1.06 是本轮最强信号」\n`
            + `   ③ 发完在报告里写一行「已在评论区 @ 你：<视频ID>」\n`
            + `   ⚠️ 只在**最值得的那一条**发，不要每条都发（会被当成刷屏）。`
        })()
        : ``)
      + `\n⭐ 保底：不管发生什么，**报告至少留一行**（哪怕只写「本轮失败：原因是 X」），别让 out/ 空着。`
      + `\n最后用两三句话汇报你挑到了什么。`
  }

  /**
   * ⭐ 保底：那一轮**没写出报告**时，宿主自己补一份"占位报告"。
   *    （bili-scroll 的用户实测反馈：卡住时 out/ 是空的 ⇒ 使用者完全看不到发生了什么）
   */
  /** 最近一次的失败诊断（通知里用）—— 必须在使用前声明 */
  let lastFailure = null

  /**
   * ⭐ 从日志尾部认出"这一轮为什么没跑成" —— 别只给一个退出码。
   *   2026-10-22 实测：点「现在跑一轮」后 54 秒结束、code=1，
   *   报告里只写"常见原因：工具连续失败" —— 真正原因是**上游模型 429 限流**，
   *   使用者完全看不出来，以为插件坏了。
   */
  const diagnoseFailure = (code) => {
    let tail = ''
    try { tail = readFileSync(logFile, 'utf8').slice(-4000) } catch { return null }
    // ① 上游限流（最常见：WorkBuddy / 其他 provider 的 429）
    const m429 = /RATE_LIMIT[^\n]*?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})[^\n]*?(UTC[+-]\d+)?/i.exec(tail)
    if (/RATE_LIMIT|"code":\s*429|usage exceeds frequency limit/i.test(tail)) {
      const when = m429 ? m429[1].replace('T', ' ') : ''
      return {
        kind: 'rate_limit',
        title: '模型被限流了（429）',
        detail: when
          ? `上游模型这轮被限流，额度会在 ${when}（UTC+8）恢复。`
          : '上游模型这轮被限流（429），等额度恢复后再试。',
        fix: '要么等额度恢复，要么在「设置 → 模型」里换一个模型（插件会自动跟随桌面版当前模型）。这不是插件的问题。',
      }
    }
    // ② 找不到 dsh / 起不来
    if (/找不到 dsh|刷抖音起不来|spawn .* ENOENT/i.test(tail)) {
      return {
        kind: 'dsh_missing',
        title: '找不到 dsh，那一轮根本没启动',
        detail: '插件要去调 dsh 命令行来跑值班，但这台机器上没找到。',
        fix: '在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js',
      }
    }
    // ③ 登录/凭证
    if (/还没登录|cred_missing|无有效 Cookie|sessionid/i.test(tail) && /失败|error|missing/i.test(tail)) {
      return {
        kind: 'no_login',
        title: '可能没登录 / 登录过期了',
        detail: '那一轮读不到数据。',
        fix: '点「扫码登录」重新登一次，或先点「检查环境」看看。',
      }
    }
    // ④ 超时
    if (/超过 \d+ 分钟没结束|watchdog/i.test(tail)) {
      return {
        kind: 'timeout',
        title: '那一轮跑超时被强制结束了',
        detail: '可能卡在某个网络请求上。',
        fix: '再试一次；连续超时的话把「每次最多筛选几个」调小。',
      }
    }
    // ⑤ 其它
    return code
      ? {
        kind: 'unknown',
        title: `那一轮异常结束（退出码 ${code}）`,
        detail: '日志里有线索，但没归到已知类型。',
        fix: '看下面的日志尾部，或点「检查环境」。',
      }
      : null
  }

  const stubReportIfMissing = (code) => {
    try {
      if (String(cfg.reportLevel || 'full') === 'off') return
      const f = join(outDir, `${dayKey()}.md`)
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
      const diag = diagnoseFailure(code)
      writeFileSync(f, [
        `# 刷抖音 · ${dayKey()} —— 这一轮没跑成`,
        '',
        diag
          ? [
            `> ❌ **${diag.title}**`,
            `> ${diag.detail}`,
            `> `,
            `> **怎么办**：${diag.fix}`,
          ].join('\n')
          : `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。`,
        '',
        '> 下面附日志尾部，方便定位（插件数据目录里的 `duty.log` 有完整版）。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log(`这一轮没写报告 ⇒ 已补占位报告${diag ? `（原因：${diag.title}）` : ''}`)
      // 把诊断结果留在内存里，通知那边也能用
      lastFailure = diag
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  const rotateLogIfBig = (limit = 2 * 1024 * 1024) => {
    try {
      if (!existsSync(logFile) || statSync(logFile).size < limit) return
      const bak = logFile + '.1'
      try { rmSync(bak, { force: true }) } catch { /* 删不掉就算了 */ }
      renameSync(logFile, bak)
      appendFileSync(logFile, `${new Date().toISOString()}  日志超过 2MB，旧的滚到 duty.log.1\n`, 'utf8')
    } catch { /* 轮转失败不该影响跑一轮 */ }
  }

  /* ⭐ 防双开：内存标记 + 落盘标记（改配置会重新挂载插件，内存标记会丢） */
  let dutyRunning = false
  /**
   * 一轮的"陈旧"阈值。
   * 🔴 2026-10-22 实测事故：夜间那轮被 429 打断后 `roundActive` 没清，
   *    而阈值是 **30 分钟** ⇒ 接下来半小时里点「现在跑一轮」全被"上一轮还在跑"挡掉，
   *    面板还只显示"没跑起来"，用户以为按钮坏了。
   *    现在：
   *      ① 阈值降到 12 分钟（比看门狗的 15 分钟略短一点点，不会误杀正常轮次）
   *      ② 每次启动插件时**主动清一次**残留（进程重启 = 上一轮的子进程已经没了）
   *      ③ 被挡住时把**原因和时间**一起返回，面板能显示
   */
  const ROUND_STALE_MS = 12 * 60 * 1000
  const roundBusyInState = () => {
    try {
      const st = readJson(dutyStateFile, {})
      if (!st || !st.roundActive) return false
      const at = Number(st.dutyRunningAt || 0)
      if (!at || Date.now() - at > ROUND_STALE_MS) {
        bumpState({ roundActive: false, dutyRunningAt: 0 })
        log('发现上一轮的"运行中"标记是陈旧的（超过 12 分钟）⇒ 已自动清掉')
        return false
      }
      return true
    } catch { return false }
  }
  /**
   * ⭐ 插件每次（重新）加载时，清掉上次残留的"运行中"标记。
   *    理由：插件重新加载 = 宿主重建了 fiber ⇒ 上一轮起的 headless 子进程
   *    要么已经被带走、要么已经结束，绝不可能还在"跑"。
   *    不清的话就会出现"看着没在跑，但点不动"。
   */
  const clearStaleRoundOnBoot = () => {
    try {
      const st = readJson(dutyStateFile, {})
      if (!st || !st.roundActive) return
      bumpState({ roundActive: false, dutyRunningAt: 0 })
      log('插件重新加载：清掉了上次残留的"运行中"标记（否则点「现在跑一轮」会被误挡）')
    } catch { /* 清不掉不影响启动 */ }
  }
  clearStaleRoundOnBoot()

  /**
   * 一轮结束后：按 notifyMode 把结果推出去。
   *   toast   —— Windows 通知（默认；零配置，真能弹到用户屏幕上）
   *   file    —— 不额外提醒（报告照样写进 out/）
   *   webhook —— 推群/机器人
   *   both    —— toast + webhook
   * 报告文件**永远**写，这里只管"额外提醒"。
   */
  const notifyRoundEnd = async (code) => {
    try {
      const mode = String(cfg.notifyMode || 'toast')
      if (mode === 'file') return
      const wantToast = mode === 'toast' || mode === 'both'
      const wantHook = mode === 'webhook' || mode === 'both'
      const f = join(outDir, `${dayKey()}.md`)
      const text = (() => { try { return readFileSync(f, 'utf8') } catch { return '' } })()
      const fallback = `（这一轮没有产出报告，退出码 ${code}）`

      if (wantToast) {
        /**
         * ⭐ 失败时通知要说**真原因**，不能只说"没产出报告"。
         *    2026-10-22 实测：429 限流时弹的是"（这一轮没有产出报告，退出码 1）"，
         *    使用者完全不知道是被限流了，以为插件坏了。
         */
        let title, body
        if (lastFailure) {
          title = `刷抖音 · ${lastFailure.title}`
          body = String(lastFailure.fix || lastFailure.detail || '').slice(0, 200)
        } else {
          const s = toastSummary(text || fallback, { day: dayKey() })
          title = s.title
          body = s.body
        }
        const r = toastSend({ title, body })
        /**
         * ⭐ 把**通知标题和正文**也写进日志。
         *    2026-10-22 实测：只记"Toast 已弹出"，出问题时根本不知道弹的是什么内容，
         *    没法判断"是通知内容错了"还是"用户没看见"。
         */
        log(`通知：Toast ${r.sent ? '已弹出' : '失败'}｜标题=${title}｜正文=${String(body).slice(0, 120)}${r.error ? ' / ' + r.error : ''}`)
      }
      if (!wantHook) return
      const url = String(cfg.webhookUrl || '').trim()
      if (!url) { log('通知：选了 webhook 但没填地址 ⇒ 跳过'); return }
      const { title, text: body } = condense(text || fallback, { title: `刷抖音 · ${dayKey()}` })
      const r = await sendWebhook({ url, preset: cfg.webhookPreset, title, markdown: body })
      log(`通知：webhook ${r.ok ? '已发送' : '失败'} → ${maskUrl(url)}${r.error ? ' / ' + r.error : ''}`)
    } catch (e) { log(`通知异常（不影响这一轮）：${e?.message ?? e}`) }
  }

  /** 设置页「测试通知」：按当前 notifyMode 真发一次，返回到底通没通 */
  const notifyTest = async () => {
    const mode = String(cfg.notifyMode || 'toast')
    const out = { mode, toast: null, webhook: null, ok: false, error: '' }
    try {
      if (mode === 'file') {
        out.error = '当前是「只写文件」，不会弹通知/推 webhook —— 先换成别的通知方式再测'
        return out
      }
      if (mode === 'toast' || mode === 'both') {
        const r = toastSend({
          title: '刷抖音 · 通知测试',
          body: `能看到这条，就说明消息通道通了 ✅\n${new Date().toLocaleString('zh-CN')}\n报告目录：${outDir}`,
        })
        out.toast = r
        if (!r.ok) out.error = 'Toast 失败：' + (r.error || '未知')
      }
      if (mode === 'webhook' || mode === 'both') {
        const r = await sendWebhook({
          url: cfg.webhookUrl,
          preset: cfg.webhookPreset,
          title: '刷抖音 · 通知测试',
          markdown: `这是一条测试消息。\n\n- 时间：${new Date().toISOString()}\n- 预设：${cfg.webhookPreset}\n- 报告目录：\`${outDir}\`\n\n收到这条就说明通知通了 ✅`,
        })
        out.webhook = r
        if (!r.ok && !out.error) out.error = 'webhook 失败：' + (r.error || '未知')
      }
      out.ok = Boolean((out.toast?.sent) || (out.webhook?.ok))
      return out
    } catch (e) {
      out.error = String(e?.message ?? e)
      return out
    } finally {
      log(`通知测试（${mode}）：${out.ok ? '通过' : '没通过'} ${out.error || ''}`)
    }
  }

  /**
   * ⭐ 这一轮给模型看的证据包：**在插件里先抓好**，写到 `<家>/round-evidence.json`。
   *
   * 为什么不在那一轮里调工具：2026-10-21 砍掉内置 MCP 之后，headless 那一轮手上已经没有
   * 任何 douyin_* 工具了 —— 而且本来也不该有：采集 + 预筛 + 算比值是**代码活**，
   * 交给模型只会烧 token、还会因为"工具失败两次"把整轮预算耗光。
   */
  const buildEvidence = (limit = 12) => {
    try {
      const max = Math.max(1, Math.min(Number(limit) || 12, 30))
      const r = runPy('forward-pick.py', ['--limit', String(max)], { timeout: 300_000 })
      if (r.status !== 0) return { ok: false, error: String(r.stderr || '').slice(0, 300) }
      let picked = {}
      try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
      const rows = (Array.isArray(picked.rows) ? picked.rows : []).slice(0, max)
      const list = []
      for (let i = 0; i < rows.length; i++) {
        const x = rows[i]
        const item = {
          aweme_id: x.aweme_id, desc: x.desc, author: x.author,
          duration_s: x.duration_s, age_h: x.age_h,
          digg: x.digg, comment: x.comment, collect: x.collect, share: x.share,
          // ⭐ 2026-10-27 加：图文标记（图集 duration 为 null，别让模型当视频说「几秒」）
          is_image: Boolean(x.is_image),
          images_n: Number(x.images_n) || 0,
          ratios: {
            '评/赞': x.comment_ratio,
            '藏/赞': x.digg ? Number((x.collect / x.digg).toFixed(4)) : 0,
            '转/赞': x.digg ? Number((x.share / x.digg).toFixed(4)) : 0,
          },
          share_url: x.share_url, web_url: x.web_url,
        }
        // 前 5 条顺手拉一下高赞评论 —— 这是判断"好不好玩"最有力的证据
        if (i < 5 && Number(x.comment) > 0) {
          const c = runPy('api-comments.py', [String(x.aweme_id)], { timeout: 200_000 })
          const lines = String(c.stdout || '').split('\n').filter((l) => /^\s{2}cid=/.test(l))
          item.top_comments = lines.slice(0, 5).map((s) => s.replace(/^\s+/, '').replace(/^cid=\d+\s+/, '').slice(0, 160))
        }
        list.push(item)
      }
      writeJson(join(stateDir, 'round-evidence.json'), {
        builtAt: new Date().toISOString(),
        sources: picked.meta || [],
        dropped: picked.dropped || {},
        thresholds: picked.thresholds || {},
        count: list.length,
        list,
      })
      return { ok: true, count: list.length }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  const runDuty = (why = 'window') => {
    try {
      if (dutyRunning || roundBusyInState()) {
        /**
         * ⭐ 被挡住时要说**具体是怎样**，不能只说"上一轮还没结束"：
         *    - 已经跑了多久
         *    - 什么时候会自己解除（12 分钟阈值）
         *    - 如果确实卡死了，怎么手动解除
         */
        let detail = ''
        try {
          const st = readJson(dutyStateFile, {})
          const at = Number(st.dutyRunningAt || 0)
          if (at) {
            const mins = Math.round((Date.now() - at) / 60000)
            const leftMs = Math.max(0, ROUND_STALE_MS - (Date.now() - at))
            detail = `上一轮从 ${new Date(at).toLocaleString('zh-CN')} 开始，已经 ${mins} 分钟；`
              + (leftMs > 0
                ? `${Math.ceil(leftMs / 60000)} 分钟后会自动解除。`
                : '马上会自动解除，再点一次就行。')
              + '如果它其实早就不跑了（比如那轮被限流打断了），等它自动解除或重启 dsh。'
          }
        } catch { /* 拿不到就只给通用说法 */ }
        log(`刷抖音已在跑，忽略这次触发（${why}）：${detail || '上一轮未结束'}`)
        return {
          started: false, why, busy: true,
          error: '上一轮还在跑，这次没启动',
          hint: detail || '上一轮还没结束，等它跑完再点',
        }
      }
      refreshCfg()
      syncCollectorCfg()
      // ⭐ 手动触发也要过每日配额闸（bili-scroll 踩过：连点两次手动，一天从 20 条刷到 80 条）
      const quota = Number(cfg.perDay || 0)
      const picked = countPickedToday()
      if (quota > 0 && picked >= quota) {
        log(`配额已满：今天已挑 ${picked} 条（上限 ${quota}），这一轮不跑`)
        return { started: false, why, quotaFull: true, picked, quota, error: `今天的配额已经用完了（已挑 ${picked} / 上限 ${quota}）` }
      }
      // ⭐ 先把闸拉上（防双开），再去异步准备证据包 + 起那一轮 —— 准备证据要十几秒，
      //    同步做会把宿主卡住（HTTP 请求和定时器都在这条线程上）。
      dutyRunning = true
      bumpState({
        dutyRunningAt: Date.now(),
        roundActive: true,
        lastRunAt: new Date().toISOString(),
        lastWhy: why,
        count: roundsToday() + 1,
      })
      ;(async () => {
        try {
          const ev = buildEvidence(Math.max(1, Math.min(Number(cfg.maxPerRun) || 12, 30)))
          log(ev.ok
            ? `证据包已备好：${ev.count} 条 → ${join(stateDir, 'round-evidence.json')}`
            : `证据包没备成（${ev.error}）—— 这一轮照样起，模型会读到空包并如实写进报告`)
          const dsh = resolveDsh()
          const overlay = ensureOverlay()
          const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
          if (overlay) args.push('--patch', overlay)
          args.push(promptFor(why))
          const cwd = stateDir
          log(`刷抖音开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} …  cwd=${cwd}`)
          const child = spawn(dsh.command, args, {
            cwd,
            shell: dsh.shell,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: pyEnv({ DOUYIN_DUTY_HOME: stateDir, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }),
          })
          /**
           * ⭐ 超时看门狗（2026-10-20 实测加）：那一轮**干完活之后可能不退出** ——
           *    实测模型已经把报告写完了、也回话了，但进程又挂了十几分钟（MCP 子进程把事件循环撑住）。
           *    没有这道闸，`dutyRunning` 会一直是 true ⇒ 之后的定时器全被"防双开"挡掉，
           *    直到 30 分钟后陈旧标记才恢复。
           *    ⇒ 超过 roundTimeoutMin（默认 15 分钟）就杀掉，并按"超时"记账。
           */
          const timeoutMin = Math.max(3, Math.min(Number(process.env.DOUYIN_ROUND_TIMEOUT_MIN) || 15, 120))
          const watchdog = setTimeout(() => {
            try {
              log(`⚠️ 这一轮超过 ${timeoutMin} 分钟没结束 ⇒ 强制结束（报告可能已经写了）`)
              child.kill()
              // 再给 10 秒收尸，还不退就硬杀整棵子树
              setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已经没了 */ } }, 10_000).unref?.()
            } catch (e) { log(`看门狗杀进程失败：${e?.message ?? e}`) }
          }, timeoutMin * 60_000)
          watchdog.unref?.()
          // ⚠️ 这里是 stream 的 data 回调 —— 抛异常会**杀掉整个宿主进程** ⇒ rawWrite 内部已全包 try/catch
          child.stdout?.on('data', (b) => rawWrite(String(b)))
          child.stderr?.on('data', (b) => rawWrite(String(b)))
          child.on('exit', (code) => {
            try { clearTimeout(watchdog) } catch { /* 无所谓 */ }
            dutyRunning = false
            bumpState({ dutyRunningAt: 0, roundActive: false })
            log(`刷抖音结束（${why}，code=${code}）`)
            stubReportIfMissing(code)
            rotateLogIfBig()
            try {
              const st = readJson(dutyStateFile, {})
              const prev = st.day === dayKey() ? Number(st.picked || 0) : 0
              const picked = countPickedToday()
              if (picked > prev) { bumpState({ picked }); log(`今天挑到 ${picked} 条（上限 ${Number(cfg.perDay) || 0} 条）`) }
            } catch (e) { log(`数挑了几条时出错（不影响这一轮）：${e?.message ?? e}`) }
            // 通知（不阻塞、失败只记日志）
            Promise.resolve(notifyRoundEnd(code)).catch((e) => log('通知异常：' + (e?.message ?? e)))
          })
          child.on('error', (e) => { dutyRunning = false; bumpState({ roundActive: false }); log(`刷抖音起不来：${e?.message ?? e}`) })
        } catch (e) {
          dutyRunning = false
          bumpState({ dutyRunningAt: 0, roundActive: false })
          log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
        }
      })()
      return { started: true, why, profile: cfg.headlessProfile, note: '正在准备证据包（十几秒），随后起那一轮 —— 进度看 duty.log' }
    } catch (e) {
      dutyRunning = false
      bumpState({ roundActive: false })
      log(`刷抖音开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── 谷时定时器 ───────────────
   * 🔴 定时器回调里抛的异常**没人接**，会直接把整个宿主进程带走 ⇒ 必须自己兜住所有异常。
   */
  const tick = () => {
    try {
      refreshCfg()
      // ⚠️ 2026-10-22：去掉了 `if (!cfg.peakValley) return`。
      //    那个总开关在设置页重构后**已经没有 UI 了**，而它的默认值是 false ⇒
      //    用户怎么配时段都不会跑，属于"配了没反应"的死锁。
      //    现在「有没有任何一个时段开着」本身就是开关：全关 = 只手动跑。
      const now = new Date()
      const st = readJson(dutyStateFile, {})
      const today = dayKey(now)
      if (countPickedToday(now) >= Number(cfg.perDay || 0)) return
      if (String(cfg.reportLevel || 'full') === 'off' && roundsToday(now) >= 1) return
      // ⭐ 把所有生效的时段拼成一个列表：内置中午/晚上 + 用户自定义
      //    自定义的也按「每天一次」去重，key 用 `custom:<下标>`，改时段后旧 key 自然失效。
      const range = []
      if (cfg.noon) range.push({ key: 'noon', label: '中午', ...WINDOWS.noon })
      if (cfg.night) range.push({ key: 'night', label: '晚上', ...WINDOWS.night })
      const customs = Array.isArray(cfg.windows) ? cfg.windows : []
      customs.forEach((w, i) => {
        const s = String(w?.start || '').trim()
        const e = String(w?.end || '').trim()
        if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e)) return
        range.push({ key: `custom:${i}`, label: String(w?.label || '').trim() || `${s}–${e}`, start: s, end: e })
      })

      for (const w of range) {
        if (!inWindow(now, w)) continue
        // ⭐ 2026-10-27 修跨午夜 bug：key 的前缀必须是「这个窗口开始那天」，
        //    不能用 today —— night 是 18:00–09:00，用 today 会把同一个夜晚切成两天，
        //    而且昨晚凌晨跑过之后，今天 18:00 起的整晚都会顶着同一个 key 被判「已跑过」，
        //    定时器一动不动。详见 lib/state.mjs 的 windowDayKey 注释。
        const key = `${windowDayKey(now, w)}:${w.key}`
        if (st.windows?.[key]) continue
        // 只记「这个时段用过了」；轮数 / lastRunAt / lastWhy 由 runDuty 统一记
        bumpState({ windows: { ...(st.windows || {}), [key]: true } })
        runDuty(`window:${w.key}`)
        return
      }
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }
  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'douyin-duty: 谷时定时器')
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 聊天盯梢（2026-10-24，使用者实测的「会话模式」进插件） ───────────────
   * 每 chatWatchSec 秒读一次私信对象（dmToId）的会话——走 HTTP 快路径（im-http.py），
   * 不启浏览器。发现「对方新说的话」⇒ Windows 通知 + 写 chat-watch.log + 合并进记忆。
   * 回复仍由人（或值班轮）来：这一层只负责「看见 + 提醒」。
   * 🔴 定时器回调必须自己兜异常（同上）；盯梢失败只记日志、不重试轰炸。
   */
  let chatWatchLastMs = 0            // 上次盯梢时刻（节流用）
  let chatWatchLastSeenAt = ''       // 已经提醒过的最新一条「对方消息」时间戳
  let chatWatchBusy = false
  let chatWatchPrimed = false        // 启动后第一拍只「对表」不提醒（不把历史消息重播一遍）
  const chatWatchLog = (s) => { try { appendFileSync(join(stateDir, 'chat-watch.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志写不进就算了 */ } }
  /** ⭐ 每一拍都把状态写进 chat-watch-state.json —— 面板轮询它，用户能实时看到
   *    「几秒前看过 · 结果如何 · 通知弹没弹 · 错在哪」（2026-10-24 使用者要求）。 */
  const cwStateFile = join(stateDir, 'chat-watch-state.json')
  const cwState = { lastCheckAt: 0, lastResult: '', lastError: '', lastNote: '', lastNewAt: '', lastNewText: '', toast: '', checks: 0, notified: 0 }
  const cwWrite = (patch) => {
    try {
      Object.assign(cwState, patch)
      writeFileSync(cwStateFile, JSON.stringify({
        ...cwState, ts: Date.now(), on: Boolean(cfg.chatWatch),
        sec: Math.max(10, Math.min(Number(cfg.chatWatchSec || 30), 300)),
        to: cfg.dmTo || '', via: 'http（不启浏览器）',
      }, null, 1), 'utf8')
    } catch { /* 状态写不进也不能出事 */ }
  }

  const chatWatchTick = async () => {
    const nowMs = Date.now()
    const sec = Math.max(10, Math.min(Number(cfg.chatWatchSec || 30), 300))
    if (chatWatchBusy) return
    if (nowMs - chatWatchLastMs < sec * 1000) return
    chatWatchLastMs = nowMs
    chatWatchBusy = true
    try {
      refreshCfg()
      if (!cfg.chatWatch) { cwWrite({ lastResult: 'off' }); return }
      const toId = String(cfg.dmToId || '').trim()
      if (!toId) { cwWrite({ lastResult: 'skip_no_to' }); return } // 身份铁闸要 sec_uid
      if (!hasCredential(stateDir)) { cwWrite({ lastResult: 'skip_no_login' }); return }
      const r = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', '8'], { timeout: 30_000 })
      const j = pickJson(r.stdout)
      cwState.checks += 1
      if (!j || !j.ok) {
        // 限流 / 接口挂 / Cookie 失效：记下来给面板看，静默等下一拍
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'error', lastError: String((j && j.error) || r.stderr || '没返回可解析结果').slice(0, 160) })
        return
      }
      if (!j.matched) {
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'no_match', lastNote: String(j.match_note || ''), lastError: '' })
        return
      }
      const msgs = Array.isArray(j.matched.messages) ? j.matched.messages : []
      // 合并进记忆（这样面板/值班轮打开就能看到，不会"刚读到却说没聊过"）
      try { mergeDmMemory(stateDir, toId, cfg.dmTo || j.matched.nickname || '', msgs) } catch { /* 记忆失败不影响盯梢 */ }
      const theirs = msgs.filter((m) => m.from === 'them' && m.at && m.at > chatWatchLastSeenAt)
      // 第一拍只「对表」：以最新一条为基准，不把历史消息重播一遍
      if (!chatWatchPrimed) {
        chatWatchPrimed = true
        const newestTheirs = msgs.filter((m) => m.from === 'them' && m.at)
        chatWatchLastSeenAt = newestTheirs.length ? newestTheirs[newestTheirs.length - 1].at : ''
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok_prime', lastError: '' })
        chatWatchLog(`已接上班（基准 = ${chatWatchLastSeenAt || '无对方消息'}，之前的不重播）`)
        return
      }
      // ⭐ 2026-10-25 修：`lastNote` 以前只在 no_match 分支写、别的分支不清
      //    ⇒ 修好之后 lastResult 已经是 ok，面板上却还挂着上一拍的
      //    「这个人不在已建立会话里」，看着像还在坏。
      //    现在读取成功的分支一律把 note 清掉，并带上读到了几条（眼睛是活的）。
      if (!theirs.length) {
        cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok', lastNote: '', lastError: '', readCount: msgs.length })
        return
      }
      // 基准推进：插件只负责「看见 + 提醒」；回话由 AI 值班（常驻会话）做，
      // 它有自己的读取基准，不和这里的混淆。
      chatWatchLastSeenAt = theirs[theirs.length - 1].at
      cwState.notified += theirs.length
      const head = theirs[0].text.slice(0, 60)
      chatWatchLog(`新消息 ${theirs.length} 条（${cfg.dmTo || toId}）：${head}`)
      // 通知：2026-10-24 使用者要求「不用弹这种通知」⇒ 聊天模式**不弹** Windows 通知，
      //    只写日志 + 状态屏（回话由 AI 值班做，本来也不需要桌面通知提醒人）。
      //    webhook 仍按配置走（有人拿它接手机推送，不在这条指令范围内）。
      let toastState = 'off（使用者 2026-10-24 关的：聊天模式不弹通知）'
      const mode = String(cfg.notifyMode || 'toast')
      if (mode === 'webhook' || mode === 'both') {
        sendWebhook({ url: cfg.webhookUrl, preset: cfg.webhookPreset, title: `${cfg.dmTo || '私信'} 来消息了`, markdown: theirs.map((m) => `- ${m.text.slice(0, 100)}`).join('\n') }).catch(() => { /* webhook 失败不影响 */ })
      }
      cwWrite({ lastCheckAt: Date.now(), lastResult: 'ok_new', lastError: '', lastNewAt: theirs[theirs.length - 1].at, lastNewText: theirs[theirs.length - 1].text.slice(0, 40), toast: toastState })
    } catch (e) {
      chatWatchLog(`这一拍出错（已兜住）：${e?.message ?? e}`)
      cwWrite({ lastCheckAt: Date.now(), lastResult: 'error', lastError: String(e?.message ?? e).slice(0, 160) })
    } finally {
      chatWatchBusy = false
    }
  }
  try {
    const cw = setInterval(() => { chatWatchTick() }, 10_000)   // 10 秒醒一次看「到没到点」，真正读的频率由 chatWatchSec 决定
    cw.unref?.()
    ctx.effect(() => () => clearInterval(cw), 'douyin-duty: 聊天盯梢')
  } catch (e) { log(`聊天盯梢没起来：${e?.message ?? e}`) }

  /* ─────────────── ⭐ 自动回「别人 @ 我」（2026-10-25，使用者要求） ───────────────
   * 使用者原话：「让她自己能自动回复别人的艾特」。
   *
   * 与上面 chatWatch 的区别：
   *   · chatWatch 盯的是**私信**（im-http.py，HTTP 快路径，只看见不回复）
   *   · atWatch   盯的是**评论区 @**（notice-read.py 读 type 45/46），而且**会真的回复**
   *
   * 为什么不在这一层自己写回复逻辑，而是拉 tools/at-me-watch.mjs：
   *   那个脚本里把「谁能被回、回几句、同一人只回一次、撞 403 立刻停」全写死了，
   *   不靠模型临场发挥 —— 这条正是「拿使用者账号对外说话」时要的确定性。
   *   state 记在 $DOUYIN_HOME/at-watch.json，重启不会重复回同一条。
   *
   * 守护方式：长驻子进程 + 每 60 秒体检一次；配置改了（开关/间隔/条数）自动重启。
   * 🔴 子进程必须自己兜住：它挂了要能拉起来，但**不许无限重启轰炸**（连续 3 次失败就停到下一轮体检）。
   */
  let atProc = null
  let atProcSig = ''
  let atFailStreak = 0
  const atStateFile = join(stateDir, 'at-watch-state.json')
  const atLog = (s) => { try { appendFileSync(join(stateDir, 'at-watch.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志写不进就算了 */ } }
  const atWriteState = (patch) => {
    try {
      const cur = readJson(atStateFile, {}) || {}
      writeFileSync(atStateFile, JSON.stringify({
        ...cur, ...patch, ts: Date.now(),
        on: Boolean(cfg.atWatch),
        sec: Math.max(30, Math.min(Number(cfg.atWatchSec || 120), 3600)),
        max: Math.max(1, Math.min(Number(cfg.atWatchMax || 3), 20)),
        scope: String(cfg.atWatchAweme || '').trim() || '全站',
        pid: atProc ? atProc.pid : null,
      }, null, 1), 'utf8')
    } catch { /* 状态写不进也不能出事 */ }
  }
  const atKill = () => {
    if (!atProc) return
    try { atProc.kill() } catch { /* 已经死了 */ }
    atProc = null
    atProcSig = ''
  }
  const atEnsure = () => {
    try {
      refreshCfg()
      if (!cfg.atWatch) {
        if (atProc) { atKill(); atLog('开关关了 ⇒ 停掉盯 @ 进程'); atWriteState({ result: 'off' }) }
        return
      }
      if (!hasCredential(stateDir)) { atWriteState({ result: 'skip_no_login' }); return }
      const sec = Math.max(30, Math.min(Number(cfg.atWatchSec || 120), 3600))
      const max = Math.max(1, Math.min(Number(cfg.atWatchMax || 3), 20))
      /**
       * 🔴 2026-10-27 加：当天配额满了就别再拉子进程。
       *
       * 实测事故：`at-me-watch.mjs` 的主循环是 `while (st.count < MAX)`，
       * 而 `st.count` 是**当天累计已回条数**、`MAX` 是每天上限。
       * 今天 5 条配额一满，脚本启动后一次都不进循环、立刻 `process.exit(0)`；
       * index.js 的 60 秒体检看到进程没了又拉 → 又立刻退出 ——
       * 于是每 60 秒空转一次，at-watch.log 里刷满
       * 「盯 @ 已启动 → 盯 @ 进程退出（code=0）」。
       * 一整天下来几百次无意义 spawn，还让使用者以为程序在跑。
       *
       * 修法：拉起之前先读 at-watch.json，把「日期 + 已回条数 + 上限」比一遍。
       * 只有当天的计数才作数（跨天自动复位，与脚本里 `st.day !== dayKey()` 同口径）。
       */
      let quotaFull = false
      try {
        const at0 = readJson(join(stateDir, 'at-watch.json'), {})
        const used = at0?.day === dayKey() ? Number(at0.count || 0) : 0
        if (used >= max) {
          quotaFull = true
          if (atProc) { atKill(); atLog('今日配额已满 ⇒ 停掉盯 @ 进程') }
          atWriteState({ result: 'quota_full', used, max })
        }
      } catch { /* 读不到就当没满，交给脚本自己判断 */ }
      if (quotaFull) return
      const aweme = String(cfg.atWatchAweme || '').trim()
      const owner = String(cfg.ownerUid || cfg.dmToId || '').trim()
      const sig = `${sec}|${max}|${aweme}|${owner}`
      if (atProc && atProcSig === sig) return          // 已经在跑且参数没变
      if (atProc) { atKill(); atLog('参数变了 ⇒ 重启盯 @ 进程') }
      const args = [join(pluginDir, 'tools', 'at-me-watch.mjs'),
        '--max', String(max), '--every', String(sec)]
      if (aweme) args.push('--aweme', aweme)
      if (owner) args.push('--owner-uid', owner)
      /**
       * ⭐ 用真正的 node.exe 跑常驻子进程，不用 `process.execPath`。
       *
       * 🔴 2026-10-25 实测（一整天的死循环）：DSH Desktop 是 Electron 宿主，
       *    `process.execPath` 指向 `DSH Desktop.exe`。不带 ELECTRON_RUN_AS_NODE
       *    时它把自己当 GUI 启动 —— **立刻以 code=0 返回**，脚本一行都没跑。
       *    日志表现：`盯 @ 已启动 → 进程退出（code=0）` 每 60 秒循环，
       *    看着一直在跑，实际一条 @ 都没回过。
       *    （上面 resolveDsh 那段已经踩过同一个坑，这里漏了。）
       */
      const atRunner = nodeExe() || process.execPath
      /** 🔴 2026-10-27 同 dmEnsure：exit 回调必须认 child，否则迟到的 exit 会把新进程引用抹掉，进程越堆越多 */
      const atChild = spawn(atRunner, args, {
        cwd: stateDir, env: { ...process.env, DOUYIN_HOME: stateDir, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(nodeExe() ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      atProc = atChild
      atProcSig = sig
      atFailStreak = 0
      // 每一行输出（一条 JSON）落到 at-watch.log，面板/使用者都能看
      try { atChild.stdout.on('data', (b) => { const s = String(b || '').trim(); if (s) atLog(s.slice(0, 400)) }) } catch { /* pipe 异常不影响 */ }
      try { atChild.stderr.on('data', (b) => { const s = String(b || '').trim(); if (s) atLog(`[stderr] ${s.slice(0, 300)}`) }) } catch { /* 同上 */ }
      atChild.on('exit', (code) => {
        atLog(`盯 @ 进程退出（code=${code}${atProc === atChild ? '' : '，非当前进程'}）`)
        if (atProc === atChild) { atProc = null; atProcSig = '' }
        if (code !== 0) atFailStreak += 1
        atWriteState({ result: 'exited', exit_code: code })
      })
      atLog(`盯 @ 已启动：每 ${sec} 秒 / 最多回 ${max} 条 / 范围=${aweme || '全站'} / 号主=${owner || '(未指定)'}`)
      atWriteState({ result: 'started', error: '' })
    } catch (e) {
      atFailStreak += 1
      atLog(`盯 @ 没起来（第 ${atFailStreak} 次）：${e?.message ?? e}`)
      atWriteState({ result: 'error', error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  try {
    const atT = setInterval(() => {
      // 连续 3 次重启都失败 ⇒ 这一轮不硬拉，等下一轮（避免死循环重启把 CPU 打满）
      if (atFailStreak >= 3) { atFailStreak = 0; atLog('连续失败 3 次 ⇒ 跳过这次体检'); return }
      atEnsure()
    }, 60_000)
    atT.unref?.()
    ctx.effect(() => () => { clearInterval(atT); atKill() }, 'douyin-duty: 盯 @ 进程')
    atEnsure()                                   // 启动时就来一次，别等 60 秒
  } catch (e) { log(`盯 @ 定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── ⭐ 自动回「私信」（2026-10-25，使用者：「私聊已读不回呢」） ───────────────
   * 上面 chatWatch 是「眼睛」（只读 + 记录 + 通知），这一层才是「嘴」。
   * 走 `tools/dm-auto-reply.mjs`：规则全写死在脚本里，不靠模型临场发挥 ——
   * 这是拿使用者账号对外说话，宁可回得朴素，也不能乱说。
   *
   * 与 atWatch 用同一套守护方式（长驻子进程 + 60 秒体检 + 连续失败就歇一轮），
   * 区别只在 args：那边按 aweme 盯 @，这边按 dmToId 盯私信。
   */
  let dmProc = null
  let dmProcSig = ''
  let dmFailStreak = 0
  const dmStateFile = join(stateDir, 'dm-auto-reply-state.json')
  const dmLog = (s) => { try { appendFileSync(join(stateDir, 'dm-auto-reply.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志写不进就算了 */ } }
  const dmWriteState = (patch) => {
    try {
      const cur = readJson(dmStateFile, {}) || {}
      writeFileSync(dmStateFile, JSON.stringify({
        ...cur, ...patch, ts: Date.now(),
        on: Boolean(cfg.dmAuto),
        sec: Math.max(30, Math.min(Number(cfg.dmAutoSec || 90), 3600)),
        max: (() => {
          const v = Number(cfg.dmAutoMax)
          return v === 0 ? 0 : Math.max(1, Math.min(v || 5, 999))
        })(),
        max_note: Number(cfg.dmAutoMax) === 0 ? '不设上限' : '',
        quiet: String(cfg.dmAutoQuiet || ''),
        peer: String(cfg.dmTo || cfg.dmToId || ''),
        pid: dmProc ? dmProc.pid : null,
      }, null, 1), 'utf8')
    } catch { /* 状态写不进也不能出事 */ }
  }
  const dmKill = () => {
    if (!dmProc) return
    try { dmProc.kill() } catch { /* 已经死了 */ }
    dmProc = null
    dmProcSig = ''
  }
  const dmEnsure = () => {
    try {
      refreshCfg()
      if (!cfg.dmAuto) {
        if (dmProc) { dmKill(); dmLog('开关关了 ⇒ 停掉自动回私信进程'); dmWriteState({ result: 'off' }) }
        return
      }
      if (!hasCredential(stateDir)) { dmWriteState({ result: 'skip_no_login' }); return }
      /**
       * ⭐ 2026-10-25 晚改：`--peer` 不再是必需。
       *
       * 原来这里写死 `const peer = cfg.dmToId` + `if (!peer) return skip_no_peer`，
       * 于是 dm-auto-reply.mjs 虽然早就支持「不给 --peer 就盯所有会话」，
       * 但守护这层永远只传一个 peer ⇒ **别人发来的私信一律不看**，
       * 表现就是「为什么还是回不了陌生人私信」。
       *
       * 现在两种模式并存：
       *   · `dmScope === 'one'`  → 只盯 dmToId 那个人（老行为，保留给需要的人）
       *   · `dmScope === 'all'`（默认）→ 不给 --peer，盯所有私聊会话
       * dmScope 是 'one' 时才要求 peer 非空。
       */
      const scope = String(cfg.dmScope || 'all').trim() === 'one' ? 'one' : 'all'
      const peer = String(cfg.dmToId || '').trim()
      if (scope === 'one' && !peer) {
        dmWriteState({ result: 'skip_no_peer', error: 'dmScope=one 但 dmToId 空着，不知道回谁' })
        return
      }
      const sec = Math.max(30, Math.min(Number(cfg.dmAutoSec || 90), 3600))
      /**
       * max = 0 表示不设每天上限（2026-10-25 使用者要求）；非零时夹 1~999。
       * quiet = 空串表示不静默、全天都回（inQuiet('') 天然返回 false）。
       * 注意这里不能再写 `cfg.dmAutoQuiet || '01:00-08:00'` ——
       * 空串是「使用者主动选的不静默」，用 || 会被兜回默认值，等于改了没用。
       */
      const maxRaw = Number(cfg.dmAutoMax)
      const max = maxRaw === 0 ? 0 : Math.max(1, Math.min(maxRaw || 5, 999))
      const quiet = String(cfg.dmAutoQuiet ?? '01:00-08:00').trim()
      const owner = String(cfg.ownerUid || peer).trim()
      /**
       * ⭐ 视频卡片参数（2026-10-26）。跟着 dmAuto 一起下发 ——
       * 这些键只影响自动回私信这条链路，单独在别处读没有意义。
       */
      const vOn = cfg.videoAuto !== false
      const vEvery = Math.max(300, Number(cfg.videoEverySec) || 1800)
      const vMaxRaw = Number(cfg.videoMax)
      const vMax = vMaxRaw === 0 ? 0 : Math.max(0, Math.min(vMaxRaw || 3, 20))
      const vReply = Math.max(0, Math.min(Number(cfg.videoReplyChance) || 0, 1))
      const vIdle = Math.max(0, Math.min(Number(cfg.videoIdleChance) || 0, 1))
      const sig = `${scope}|${peer}|${sec}|${max}|${quiet}|${owner}|v${vOn ? 1 : 0}:${vEvery}:${vMax}:${vReply}:${vIdle}`
      if (dmProc && dmProcSig === sig) return          // 已经在跑且参数没变
      if (dmProc) { dmKill(); dmLog('参数变了 ⇒ 重启自动回私信进程') }
      const args = [join(pluginDir, 'tools', 'dm-auto-reply.mjs')]
      if (scope === 'one') args.push('--peer', peer)
      args.push('--max', String(max), '--every', String(sec))
      /**
       * ⭐ `--quiet` **必须无条件传**，哪怕值是空串。
       *
       * 🔴 2026-10-25 实测：原来写 `if (quiet) args.push('--quiet', quiet)`，
       *    使用者把 `dmAutoQuiet` 设成 `''`（要求「夜间不静默、全天都回」）时，
       *    空串为假 ⇒ 参数不传 ⇒ dm-auto-reply.mjs 回落到自己的默认
       *    `argOf('--quiet', '01:00-08:00')` ⇒ **夜里 1 点到 8 点照样静默**，
       *    改配置等于没改，而且日志里 quiet 会显示 `01:00-08:00` 露馅。
       *    空串在脚本侧 `String(argOf(...)).trim()` 得到 `''`，
       *    `inQuiet('')` 天然返回 false ⇒ 正确表示「不静默」。
       */
      args.push('--quiet', quiet)
      if (owner) args.push('--owner-uid', owner)
      /**
       * ⭐ 视频卡片参数。`--video 0` 才关，其余数值全部无条件传 ——
       * 和 `--quiet` 同一个道理：靠脚本自己的默认值兜底会让人以为改了配置却没用。
       */
      args.push('--video', vOn ? '1' : '0',
        '--video-every', String(vEvery),
        '--video-max', String(vMax),
        '--video-reply', String(vReply),
        '--video-idle', String(vIdle))
      /**
       * ⭐ 同 atWatch：必须用真 node.exe，不能用 Electron 的 process.execPath。
       *    用 execPath 的话子进程立刻 code=0 退出，自动回私信永远跑不起来
       *    （实测：日志每 60 秒 `已启动 → 进程退出（code=0）` 循环一整天）。
       */
      const dmRunner = nodeExe() || process.execPath
      /**
       * 🔴 2026-10-27 修「一条私信被回了两遍」：进程越堆越多。
       *
       * 原来的 exit 回调无条件 `dmProc = null` —— 但 kill 一个进程是异步的：
       * `dmKill()` → 旧进程的 exit 事件晚到 → 那时 `dmProc` 已经指向**刚拉起的新进程**，
       * 被这个迟到的回调抹成 null ⇒ 下一秒 dmEnsure 看到「没进程」又拉一个。
       * 结果每一轮重启净增一个人：实测 08:48:52 与 08:49:52 各起一个，两个同时跑，
       * 各自读到同一条待回私信、各自回一遍（日志 count 一次 10 → 11 跳着涨）。
       *
       * 修法：把 child 闭包进来，只有「当前引用还是我」才清空。
       */
      const dmChild = spawn(dmRunner, args, {
        cwd: stateDir, env: { ...process.env, DOUYIN_HOME: stateDir, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(nodeExe() ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      dmProc = dmChild
      dmProcSig = sig
      dmFailStreak = 0
      try { dmChild.stdout.on('data', (b) => { const s = String(b || '').trim(); if (s) dmLog(s.slice(0, 400)) }) } catch { /* pipe 异常不影响 */ }
      try { dmChild.stderr.on('data', (b) => { const s = String(b || '').trim(); if (s) dmLog(`[stderr] ${s.slice(0, 300)}`) }) } catch { /* 同上 */ }
      dmChild.on('exit', (code) => {
        dmLog(`自动回私信进程退出（code=${code}${dmProc === dmChild ? '' : '，非当前进程' }）`)
        // 只有当前引用还是这个 child 才清空；否则会把「已经替换上去的新进程」抹掉
        if (dmProc === dmChild) { dmProc = null; dmProcSig = '' }
        if (code !== 0) dmFailStreak += 1
        dmWriteState({ result: 'exited', exit_code: code })
      })
      dmLog(`自动回私信已启动：每 ${sec} 秒 / 每天最多 ${max} 条 / 静默 ${quiet || '无'} / 对象=${cfg.dmTo || peer}`)
      dmWriteState({ result: 'started', error: '' })
    } catch (e) {
      dmFailStreak += 1
      dmLog(`自动回私信没起来（第 ${dmFailStreak} 次）：${e?.message ?? e}`)
      dmWriteState({ result: 'error', error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  try {
    const dmT = setInterval(() => {
      // 连续 3 次重启都失败 ⇒ 这一轮不硬拉（避免死循环重启把 CPU 打满）
      if (dmFailStreak >= 3) { dmFailStreak = 0; dmLog('连续失败 3 次 ⇒ 跳过这次体检'); return }
      dmEnsure()
    }, 60_000)
    dmT.unref?.()
    ctx.effect(() => () => { clearInterval(dmT); dmKill() }, 'douyin-duty: 自动回私信进程')
    dmEnsure()                                   // 启动时就来一次，别等 60 秒
  } catch (e) { log(`自动回私信定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── ⭐ 自动回群聊（2026-10-27 使用者要求） ───────────────
   * 原话：「没有被 @ 或被点名时回（默认），不做无差别接话，然后可以有 10% 的概率
   *        去回复别人发的视频或者消息，群里发的视频要也抽帧看，所有群都监控，
   *        没有回复上限，不要冷却」
   *
   * 为什么跟 dmAuto 分成两个进程而不是并进 dm-auto-reply.mjs：
   *   ① dm-auto-reply 取会话时写死 `type === 1`（私聊），兼容群会把已经稳定的私聊链路改坏
   *   ② 群的「谁在跟我说话」判据（@ / 点名）、发送路径（先点开群）都不一样
   *   ③ 出问题能单独关：groupAuto=false 只停群聊，私聊照跑
   *
   * 与 dmAuto 一样用真 node.exe 拉子进程（用 Electron execPath 会立刻 code=0 退出），
   * 并且用「child 闭包 + 只有当前引用还是我才清空」防越堆越多。
   */
  const groupStateFile = join(stateDir, 'group-reply-state.json')
  const groupLog = (s) => { try { appendFileSync(join(stateDir, 'group-reply.log'), `[${new Date().toISOString()}] ${s}\n`, 'utf8') } catch { /* 日志写不进就算了 */ } }
  let groupProc = null
  let groupProcSig = ''
  let groupFailStreak = 0
  const groupKill = () => { const p = groupProc; groupProc = null; groupProcSig = ''; try { p?.kill() } catch { /* 已经退了 */ } }
  const groupWriteState = (patch) => {
    try {
      const prev = readJson(groupStateFile, {})
      writeJson(groupStateFile, {
        ...prev, ...patch, ts: Date.now(),
        on: Boolean(cfg.groupAuto),
        sec: Math.max(60, Math.min(Number(cfg.groupAutoSec || 120), 3600)),
        chance: Math.max(0, Math.min(Number(cfg.groupChance ?? 0.1), 1)),
        frames: cfg.groupFrames !== false,
      })
    } catch { /* ignore */ }
  }
  const groupEnsure = () => {
    try {
      if (!cfg.groupAuto) {
        if (groupProc) { groupKill(); groupLog('开关关了 ⇒ 停掉自动回群聊进程'); groupWriteState({ result: 'off' }) }
        return
      }
      if (!hasCredential(stateDir)) {
        groupWriteState({ result: 'skip_no_credential', error: '还没登录' })
        return
      }
      const sec = Math.max(60, Math.min(Number(cfg.groupAutoSec || 120), 3600))
      /**
       * chance = 0.1 是使用者定的「10% 概率回别人的视频/消息」。
       * 允许配 0（只回 @/点名）和 1（每条都想办法回）。
       * frames 默认开 —— 使用者明确要求「群里发的视频要也抽帧看」。
       */
      const chance = Math.max(0, Math.min(Number(cfg.groupChance ?? 0.1), 1))
      const frames = cfg.groupFrames !== false
      const sig = `${sec}|${chance}|${frames ? 1 : 0}`
      if (groupProc && groupProcSig === sig) return
      if (groupProc) { groupKill(); groupLog('参数变了 ⇒ 重启自动回群聊进程') }
      const args = [
        join(pluginDir, 'tools', 'group-reply.mjs'),
        '--every', String(sec),
        '--chance', String(chance),
        '--python', String(cfg.pythonPath || 'python'),
      ]
      if (!frames) args.push('--no-frames')
      const runner = nodeExe() || process.execPath
      const child = spawn(runner, args, {
        cwd: stateDir,
        env: { ...process.env, DOUYIN_HOME: stateDir, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(nodeExe() ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      groupProc = child
      groupProcSig = sig
      groupFailStreak = 0
      try { child.stdout.on('data', (b) => { const s = String(b || '').trim(); if (s) groupLog(s.slice(0, 500)) }) } catch { /* pipe 异常不影响 */ }
      try { child.stderr.on('data', (b) => { const s = String(b || '').trim(); if (s) groupLog(`[stderr] ${s.slice(0, 300)}`) }) } catch { /* 同上 */ }
      child.on('exit', (code) => {
        groupLog(`自动回群聊进程退出（code=${code}${groupProc === child ? '' : '，非当前进程'}）`)
        if (groupProc === child) { groupProc = null; groupProcSig = '' }
        if (code !== 0) groupFailStreak += 1
        groupWriteState({ result: 'exited', exit_code: code })
      })
      groupLog(`自动回群聊已启动：每 ${sec} 秒一轮 / 随机回概率 ${chance} / 抽帧 ${frames ? '开' : '关'}`)
      groupWriteState({ result: 'started', error: '' })
    } catch (e) {
      groupFailStreak += 1
      groupLog(`自动回群聊没起来（第 ${groupFailStreak} 次）：${e?.message ?? e}`)
      groupWriteState({ result: 'error', error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  try {
    const gT = setInterval(() => {
      if (groupFailStreak >= 3) { groupFailStreak = 0; groupLog('连续失败 3 次 ⇒ 跳过这次体检'); return }
      groupEnsure()
    }, 60_000)
    gT.unref?.()
    ctx.effect(() => () => { clearInterval(gT); groupKill() }, 'douyin-duty: 自动回群聊进程')
    groupEnsure()
  } catch (e) { log(`自动回群聊定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── ⭐ 桌宠（2026-10-24 v2：桌面级置顶窗口） ───────────────
   * 主人验收 0.4.0 后两条指令：①图裂了（素材在 layers/ 子目录 + 带空格层名，已修）；
   * ②「悬浮在所有窗口上」——网页浮层出不了 DSH 窗口 ⇒ 桌宠搬进独立置顶小窗。
   * 这层是**状态源**：聚合真实状态 + 写 pet-window-state.json（桌面窗轮询它）。
   * 桌面窗本体在 tools/pet-window.py（WPF Topmost 透明窗），由 petKeeper 拉起/收掉。
   */
  const petSpriteDirOf = () => join(pluginDir, 'assets', 'pet', 'sprite')
  const petManifestOf = () => readJson(join(petSpriteDirOf(), 'manifest.json'), null)
  const petStateOf = () => {
    const st = readJson(dutyStateFile, {})
    const cw = readJson(join(stateDir, 'chat-watch-state.json'), {})
    // ⚠️ 聚合口径：chat-watch-state.json 是「最后已知状态」，即使现在关了它也留着旧值
    //    ⇒ 只有 cfg.chatWatch 开着才算 watch，否则看别的信号。
    const watching = Boolean(cfg.chatWatch) && String(cw.lastResult || '') !== 'off'
    const running = Boolean(st.roundActive)
    const cwErrFresh = watching && cw.lastResult === 'error' && Date.now() - Number(cw.ts || 0) < 180_000
    // 「她睡了」的口径：聊天模式关了、也没有任何跑的时段（noon/night/自定义全关）
    const customs = Array.isArray(cfg.windows) ? cfg.windows : []
    const anyWindow = Boolean(cfg.noon) || Boolean(cfg.night)
      || customs.some((w) => /^\d{1,2}:\d{2}$/.test(String(w?.start || '')) && /^\d{1,2}:\d{2}$/.test(String(w?.end || '')))
    let state = 'idle'
    if (!anyWindow && !cfg.chatWatch) state = 'sleep'
    else if (running) state = 'run'
    else if (cwErrFresh) state = 'error'
    else if (watching) state = 'watch'
    return {
      ok: true,
      state,                                     // idle | watch | run | sleep | error
      round_active: running,
      chat: cfg.chatWatch ? {
        on: true,
        result: String(cw.lastResult || ''),
        new_text: String(cw.lastNewText || '').slice(0, 40),
        checked_ago: cw.lastCheckAt ? Math.round((Date.now() - cw.lastCheckAt) / 1000) : null,
      } : { on: false },
      asset_ok: Boolean(petManifestOf()),
      now: Date.now(),
    }
  }
  /* ── 桌宠已搬去独立插件 dsh-deskpet（2026-10-24 主人指令 ⑦：新建桌宠项目）。
   *    这里只留「状态源」：petStateOf() + /pet/state 供外部读；
   *    不再拉窗口、不写 pet-window-state.json、不养 keeper —— 那些归 dsh-deskpet。
   *    （旧的窗口守护代码已整体删除，历史见 CHANGELOG 0.4.x。） */

  /* ─────────────── 健康信号 ─────────────── */
  const healthFile = join(stateDir, 'health.json')
  const writeHealth = () => {
    try {
      const st = rollDay()
      const alerts = []
      if (!venvReadyNow()) alerts.push('venv_missing: 没装运行环境（设置页点「装主依赖」）')
      if (!hasCredential(stateDir)) alerts.push('cred_missing: 还没登录（设置页扫码，或粘一条 Cookie）')
      if (dutyRunning && st.dutyRunningAt && Date.now() - Number(st.dutyRunningAt) > 20 * 60_000) {
        alerts.push(`duty_slow: 当前轮已经跑了 ${Math.round((Date.now() - Number(st.dutyRunningAt)) / 60_000)} 分钟还没结束`)
      }
      writeFileSync(healthFile, JSON.stringify({
        ts: new Date().toISOString(),
        plugin: myVersion(),
        peakValley: cfg.peakValley,
        dutyRunning,
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        pickedToday: countPickedToday(),
        perDay: Number(cfg.perDay || 0),
        loggedIn: hasCredential(stateDir),
        venvReady: venvReadyNow(),
        alerts,
      }, null, 2), 'utf8')
    } catch { /* 健康文件写不进去也不能出事 */ }
  }
  writeHealth()
  try {
    const ht = setInterval(writeHealth, 90_000)
    ht.unref?.()
    ctx.effect(() => () => clearInterval(ht), 'douyin-duty: 健康信号')
  } catch { /* 起不来就算了 */ }

  /* ─────────────── HTTP（设置页用） ─────────────── */
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  /* ─────────────── 检查更新 ───────────────
   * 🔴 三条设计约束：
   *   ① **不能拖慢面板**：走异步 fetch + 3 秒超时，查不到就报"查不到"，绝不让设置页转圈。
   *   ② **不写死仓库地址**：发布者可能换 GitHub 用户名、也可能只发 npm ⇒ 按下面顺序自己找。
   *   ③ **不自动升级**：只告诉有没有新版本 + 怎么升。装插件是使用者的事（改 profile 是他的机器）。
   *   查过的结果落 `<家>/update.json`，10 分钟内不重复打网络（面板会反复渲染）。
   */
  const updateFile = join(stateDir, 'update.json')
  let updateCache = null
  const cmpVer = (a, b) => {
    const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x > y ? 1 : -1
    }
    return 0
  }
  const pkgMeta = () => {
    try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) } catch { return {} }
  }
  /** 从 package.json 的 repository 里掏出 owner/repo（支持字符串和对象两种写法） */
  const repoSlug = () => {
    const r = pkgMeta().repository
    const url = typeof r === 'string' ? r : (r && r.url) || ''
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(String(url))
    return m ? `${m[1]}/${m[2]}` : ''
  }
  const fetchJson = async (url, timeoutMs = 3000) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, json: await res.json() }
    } catch (e) {
      return { ok: false, error: String(e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? e)).slice(0, 160) }
    } finally { clearTimeout(timer) }
  }
  /**
   * 查一次最新版本。没网/没发布都不算错，返回 checked:false + 为什么。
   * @param {boolean} force 忽略 10 分钟缓存
   */
  const checkUpdate = async (force = false) => {
    const cur = myVersion()
    const explicit = String(cfg.updateUrl || '').trim()
    // ⚠️ 缓存必须带**来源指纹**：改了「更新地址」还拿旧缓存，用户会以为新地址没生效
    //    （2026-10-22 实测踩过：把 updateUrl 指到本地假服务，面板还显示旧结果）
    const sig = `${cur}|${explicit}`
    const cached = readJson(updateFile, null)
    const fresh = (o) => o && Date.now() - Number(o.at || 0) < 600_000 && o.sig === sig
    if (!force && fresh(updateCache)) return { ...updateCache, cached: true }
    if (!force && fresh(cached)) return { ...cached, cached: true }
    const meta = pkgMeta()
    const name = String(meta.name || 'dsh-douyin-scroll')
    const sources = []
    if (explicit) sources.push({ kind: 'url', name: '自定义地址', url: explicit })
    sources.push({ kind: 'npm', name: 'npm registry', url: `https://registry.npmjs.org/${encodeURIComponent(name)}/latest` })
    const slug = repoSlug()
    if (slug) {
      for (const br of ['main', 'master']) {
        sources.push({ kind: 'github', name: `GitHub ${slug}@${br}`, url: `https://raw.githubusercontent.com/${slug}/${br}/package.json` })
      }
    }
    const tried = []
    let latest = ''
    let from = ''
    for (const s of sources) {
      const r = await fetchJson(s.url)
      if (r.ok && r.json && r.json.version) {
        latest = String(r.json.version)
        from = s.name
        tried.push({ source: s.name, ok: true, version: latest })
        break
      }
      tried.push({ source: s.name, ok: false, error: r.error || '没有 version 字段' })
    }
    const out = {
      ok: true,
      current: cur,
      latest: latest || '',
      source: from,
      checked: Boolean(latest),
      hasUpdate: Boolean(latest) && cmpVer(latest, cur) > 0,
      tried,
      sig,
      at: Date.now(),
      // 升级怎么做——别让使用者猜
      how: latest && cmpVer(latest, cur) > 0
        ? `dsh plugin --profile <你的profile> add ${name}@${latest}  然后重启 dsh`
        : '',
      note: latest ? '' : `查不到最新版本（试了 ${sources.length} 个来源）。插件可能还没发布到 npm / GitHub，或者这台机器连不上外网 —— 可以在设置里填「更新地址」。`,
    }
    updateCache = out
    try { writeJson(updateFile, out) } catch { /* 写不进去不影响 */ }
    log(`检查更新：当前 ${cur} / 最新 ${latest || '(查不到)'}${from ? '（' + from + '）' : ''}`)
    return out
  }

  const status = () => {
    refreshCfg()
    const st = rollDay()
    const today = dayKey()
    const tail = (f) => { try { return readFileSync(f, 'utf8').slice(-1400) } catch { return '' } }
    const cred = credentialInfo(stateDir)
    return {
      ok: true,
      home: stateDir,
      config: cfg,
      windows: WINDOWS,
      today,
      ranToday: st.day === today ? Number(st.count || 0) : 0,
      pickedToday: countPickedToday(),
      perDay: Number(cfg.perDay || 0),
      lastRunAt: st.lastRunAt || null,
      lastWhy: st.lastWhy || null,
      loggedIn: cred.hasCredential,
      hasCredential: cred.hasCredential,
      keys: cred.important.length ? cred.important : cred.keys.slice(0, 8),
      /** ⭐ 登录的是哪个号（扫码/体检时记下来的；没有就 null） */
      account: readJson(join(stateDir, 'account.json'), null),
      venvReady: venvReadyNow(),
      installing,
      installLog: installLogFile,
      installTail: tail(installLogFile),
      report: reportFileOf(new Date()),
      version: myVersion(),
      cookieFile: cookiePath(stateDir),
      /**
       * ⭐ 盯 @ 的实时状态（2026-10-25）：开关、范围、进程在不在、上一拍结果。
       *    使用者要判断「她到底有没有在自动回」，只看这一块就够。
       */
      atWatch: {
        on: Boolean(cfg.atWatch),
        running: Boolean(atProc),
        pid: atProc ? atProc.pid : null,
        sec: Math.max(30, Math.min(Number(cfg.atWatchSec || 120), 3600)),
        max: Math.max(1, Math.min(Number(cfg.atWatchMax || 3), 20)),
        scope: String(cfg.atWatchAweme || '').trim() || '全站',
        owner_uid: String(cfg.ownerUid || '').trim() || '(未指定 ⇒ 特殊称呼对谁都不用)',
        state: readJson(atStateFile, null),
        log_tail: tail(join(stateDir, 'at-watch.log')).split('\n').filter(Boolean).slice(-6),
      },
      /**
       * ⭐ 自动回私信的实时状态（2026-10-25）：开关、对象、进程在不在、上一拍结果。
       *    使用者问过「私聊已读不回呢」⇒ 这块就是回答「现在到底会不会回」的地方。
       */
      dmAuto: {
        on: Boolean(cfg.dmAuto),
        running: Boolean(dmProc),
        pid: dmProc ? dmProc.pid : null,
        sec: Math.max(30, Math.min(Number(cfg.dmAutoSec || 90), 3600)),
        max: (() => {
          const v = Number(cfg.dmAutoMax)
          return v === 0 ? 0 : Math.max(1, Math.min(v || 5, 999))
        })(),
        max_note: Number(cfg.dmAutoMax) === 0 ? '不设上限' : '',
        quiet: String(cfg.dmAutoQuiet || ''),
        peer: String(cfg.dmTo || '').trim() || '(未设置)',
        peer_id: String(cfg.dmToId || '').trim() || '(未设置 ⇒ 不会回)',
        owner_uid: String(cfg.ownerUid || '').trim() || '(未指定 ⇒ 特殊称呼对谁都不用)',
        state: readJson(dmStateFile, null),
        /**
         * ⭐ 抖音风控需要人工过验证（2026-10-25 实测：私信页弹「依次点击文字」点选验证，
         *    浮层盖住输入框，自动打字被吞）。到这一步插件**不自动过验证** ——
         *    点错一次风控等级就往上跳。这里把「卡在哪一步」如实抬到面板上，
         *    使用者打开浏览器点一下就恢复。
         */
        verify_needed: (() => {
          const st0 = readJson(dmStateFile, null) || {}
          const nv = st0.needVerify
          return nv ? { ...nv, hint: '去这台机器的浏览器里,把抖音那个「依次点击文字」验证点掉,下一拍就自己恢复' } : null
        })(),
        log_tail: tail(join(stateDir, 'dm-auto-reply.log')).split('\n').filter(Boolean).slice(-6),
      },
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/douyin-duty/status') return sendJson(res, 200, status())
    if (req.method === 'GET' && path === '/api/douyin-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: WINDOWS, home: stateDir })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/config') {
      const body = await readBody(req)
      const patch = {}
      for (const k of Object.keys(DEFAULTS)) if (k in body) patch[k] = body[k]
      const { clean, host } = await persistCfg(patch)
      log(`设置已更新：${JSON.stringify(clean)}（DSH 那边${host.ok ? '已同步' : '没写成：' + host.error}）`)
      return sendJson(res, 200, { ok: true, config: cfg, host })
    }
    /**
     * ⭐ 「现在跑一轮」
     * 🔴 2026-10-22 修：以前不管有没有真跑起来都返回 `ok: true`。
     *    runDuty 可能因为「配额满了 / 上一轮还在跑 / 别的」直接拒绝，
     *    面板却显示"已经开跑了" —— 使用者等半天没消息，以为点了没反应。
     *    现在：**只有真的起来了才 ok:true**，否则把原因原样带回去。
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/run') {
      const r = runDuty('manual')
      const started = r && r.started === true
      return sendJson(res, 200, {
        ...r,
        ok: started,
        // 给面板一句人话
        message: started
          ? (r.note || '已经开跑了，跑完会弹通知')
          : (r.error || r.hint || '这次没跑起来'),
      })
    }

    /* ── 检查更新 ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/update') {
      const force = String(url.searchParams.get('force') || '') === '1'
      return sendJson(res, 200, await checkUpdate(force))
    }

    /* ── 当前账号：面板显示"登录的哪个号" ──
     * 先给缓存（account.json），再后台刷新一次（慢，但准）。
     * 拿不到就说拿不到，别编一个昵称出来。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/account') {
      const cached = readJson(join(stateDir, 'account.json'), null)
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: true, logged_in: false, account: null })
      const force = String(url.searchParams.get('refresh') || '') === '1'
      // 有缓存且不超过 1 小时、又不是强制刷新 ⇒ 直接给缓存（面板打开时别卡 10 秒）
      if (!force && cached && Date.now() - Number(new Date(cached.at).getTime() || 0) < 3600_000) {
        return sendJson(res, 200, { ok: true, logged_in: true, account: cached, cached: true })
      }
      try {
        const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
        const j = pickJson(g.stdout)
        if (!j) return sendJson(res, 200, { ok: false, logged_in: true, account: cached, error: '体检脚本没返回结果' })
        const acc = { nick: j.nick || '', uid: j.uid || '', alive: j.alive === true, at: new Date().toISOString() }
        try { writeJson(join(stateDir, 'account.json'), acc) } catch { /* 写不进去也能用 */ }
        return sendJson(res, 200, { ok: true, logged_in: true, account: acc, cached: false })
      } catch (e) {
        return sendJson(res, 200, { ok: false, logged_in: true, account: cached, error: String(e?.message ?? e) })
      }
    }

    /* ── ⭐ 聊天模式：实时状态（面板每 15 秒拉一次，显示「它现在在干嘛」） ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/chat/watch') {
      const s = readJson(join(stateDir, 'chat-watch-state.json'), {})
      return sendJson(res, 200, { ok: true, ...s, now: Date.now() })
    }

    /* ─────────────── ⭐ 桌宠状态源（2026-10-24 v3：只留状态，窗口归 dsh-deskpet）───────────────
     * /pet/state  —— 聚合真实状态（petStateOf()），dsh-deskpet 的窗口经它联动。
     * /pet/asset/* —— 白名单素材服务（历史保留；dsh-deskpet 自带素材，这里不再必需）。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/pet/state') {
      return sendJson(res, 200, petStateOf())
    }
    if (req.method === 'GET' && path.startsWith('/api/douyin-duty/pet/asset/')) {
      // 只放行白名单里的文件名（层名 / 道具名），别开成任意文件服务器。
      // ⚠️ 层图在 layers/ 子目录；「back hair」这种带空格的层名：
      //    浏览器 <img src> 会发 %20 编码，手写测试常发原样空格 —— 两种都认。
      const mf = petManifestOf()
      const allow = new Map()
      for (const n of mf?.layers || []) allow.set(encodeURIComponent(n) + '.png', join('layers', n + '.png'))
      for (const n of mf?.props || []) allow.set(encodeURIComponent(n) + '.png', n + '.png')
      const key = path.slice('/api/douyin-duty/pet/asset/'.length)
      const rel = allow.get(key) || allow.get(decodeURIComponent(key))
      if (!mf || !rel) return sendJson(res, 404, { ok: false, error: 'no such asset' })
      try {
        const buf = readFileSync(join(petSpriteDirOf(), rel))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=300' })
        return res.end(buf)
      } catch {
        return sendJson(res, 404, { ok: false, error: 'asset read failed' })
      }
    }

    /* ── ⭐ 收件箱：评论区 @ 我 + 谁私信我（面板「消息」用的） ──
     * 一次把两件事都读了，面板只调一次。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/inbox') {
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: false, error: '还没登录', at: [], dm: [] })
      const out = { ok: true, at: [], dm: [], at_n: 0, dm_n: 0, errors: [] }

      // ① 评论区 @ 我
      try {
        const r = readAtMe({ limit: 20, include_seen: false })
        if (r && r.ok) { out.at = r.list || []; out.at_n = r.at_n || 0 }
        else out.errors.push('评论区 @：' + ((r && (r.error || r.hint)) || '读不到'))
      } catch (e) { out.errors.push('评论区 @：' + String(e?.message ?? e)) }

      /**
       * ② "谁私信我"：读**会话列表**（不是打开某个会话）。
       *    抖音的会话列表只有「最近聊过的人 + 最后一句话」，没有"未读"标记可用，
       *    所以这里如实说：列出最近跟我聊过的人 + 他最后说了什么 + 是不是他说的。
       */
      try {
        const r = runNodeTool('im-send.mjs', ['--list'], { timeout: 180_000 })
        const j = pickJson(r.stdout)
        if (j && j.ok) {
          const list = Array.isArray(j.people) ? j.people : []
          // 给每个人补上"最后一句是谁说的"（有记忆才知道）
          out.dm = list.map((p) => {
            let mem = null
            try { mem = p.sec_uid ? loadDmMemory(stateDir, p.sec_uid) : null } catch { mem = null }
            const last = mem && mem.messages.length ? mem.messages[mem.messages.length - 1] : null
            const lastTheirs = mem ? [...mem.messages].reverse().find((m) => m.from === 'them') : null
            return {
              nick: p.nick,
              sec_uid: p.sec_uid,
              preview: p.preview,
              duplicate: p.duplicate,
              /** 我们以前聊过几条（没聊过 = 0） */
              remembered: mem ? mem.messages.length : 0,
              /** 他最后说的一句（记忆里能找到的话） */
              their_last: lastTheirs ? { text: lastTheirs.text, at: lastTheirs.at } : null,
              /** 最后一条是谁说的 —— 判断"是不是该我回了" */
              last_from: last ? last.from : null,
              /** ⭐ 要不要回：他最后说的，比我说得晚 ⇒ 该回了 */
              needs_reply: Boolean(lastTheirs && (!last || last.from === 'them')),
            }
          })
          out.dm_n = out.dm.filter((x) => x.needs_reply).length
        } else out.errors.push('私信列表：' + ((j && (j.error || j.hint)) || '读不到'))
      } catch (e) { out.errors.push('私信列表：' + String(e?.message ?? e)) }

      return sendJson(res, 200, out)
    }

    /* ── ⭐ 聊天模式：读某个人的完整上下文（面板「跟他聊」用） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/chat/read') {
      const body = await readBody(req)
      const toId = String(body?.to_id || cfg.dmToId || '').trim()
      const to = String(body?.to || cfg.dmTo || '').trim()
      if (!toId && !to) return sendJson(res, 200, { ok: false, error: '不知道读谁的会话' })
      /**
       * ⭐ 快路径（2026-10-24）：有 to_id 就先走 HTTP（im-http.py，~1.1 秒、不启浏览器、
       *    身份铁闸=sec_uid 反查核验）。命不中（陌生人/接口挂）再退回浏览器路径。
       *    和 douyin_im_read 工具同一套双路径。
       */
      if (toId) {
        try {
          const r0 = runPy('im-http.py', ['--read', '--peer-sec-uid', toId, '--limit', '40'], { timeout: 30_000 })
          const h = pickJson(r0.stdout)
          if (h && h.ok && h.matched) {
            const msgs = Array.isArray(h.matched.messages) ? h.matched.messages : []
            let context = null
            try {
              mergeDmMemory(stateDir, toId, to || h.matched.nickname || '', msgs)
              context = dmContext(stateDir, toId, { recent: 20 })
            } catch { /* 记忆失败不影响读 */ }
            log(`chat/read(HTTP) ${h.matched.nickname || toId}: ${msgs.length} 条，${h.ms}ms`)
            return sendJson(res, 200, {
              ok: true, via: 'http', to: to || h.matched.nickname, to_sec_uid: toId,
              count: msgs.length,
              mine: msgs.filter((m) => m.from === 'me').length,
              them: msgs.filter((m) => m.from === 'them').length,
              unknown: 0,
              messages: msgs.slice(-40),
              context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
            })
          }
        } catch { /* 快路径失败 → 下面走浏览器 */ }
      }
      const argv = ['--read']
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return sendJson(res, 200, { ok: false, error: '读不到会话', detail: String(r.stderr || r.stdout || '').slice(-400) })
      if (!j.ok) return sendJson(res, 200, j)
      // 合并进记忆 + 取上下文
      let context = null
      try {
        const secUid = String(j.to_sec_uid || toId || '').trim()
        if (secUid) {
          /**
           * ⚠️ 顺序很重要：**先合并、再取上下文**。
           *    以前是先取 context 再 merge ⇒ 第一次读某个人的会话时，
           *    context 永远是空的（"这个人以前没聊过"），
           *    但其实这一下刚读到 11 条 —— 等于刚认识就说"我不认识你"。
           */
          mergeDmMemory(stateDir, secUid, j.to || to, Array.isArray(j.messages) ? j.messages : [])
          context = dmContext(stateDir, secUid, { recent: 20 })
        }
      } catch { /* 记忆失败不影响读 */ }
      return sendJson(res, 200, {
        ok: true, to: j.to, to_sec_uid: j.to_sec_uid,
        count: j.count, mine: j.mine, them: j.them, unknown: j.unknown,
        messages: Array.isArray(j.messages) ? j.messages.slice(-40) : [],
        context: context || { note: '这个人以前没聊过（记忆里没有记录）' },
      })
    }

    /* ── ⭐ 聊天模式：发一条（带记忆，确认后才发） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/chat/send') {
      const body = await readBody(req)
      const toId = String(body?.to_id || cfg.dmToId || '').trim()
      const to = String(body?.to || cfg.dmTo || '').trim()
      const text = String(body?.text || '').trim()
      if (!text) return sendJson(res, 200, { ok: false, error: '正文是空的' })
      // 🔴 用户闸：面板点「发送」= 当场同意，所以这里直接放行（前端已经二次确认过）
      if (body?.confirm !== true) return sendJson(res, 200, { ok: false, needsConfirm: true, draft: text })
      const argv = []
      if (to) argv.push('--to', to)
      if (toId) argv.push('--to-id', toId)
      argv.push('--text', text)
      const r = runNodeTool('im-send.mjs', argv, { timeout: 240_000 })
      const j = pickJson(r.stdout)
      if (!j) return sendJson(res, 200, { ok: false, error: '发送器没返回可解析结果', detail: String(r.stderr || r.stdout || '').slice(-400) })
      if (j.ok && j.sent) {
        try {
          const secUid = String(j.to_sec_uid || toId || '').trim()
          if (secUid) noteSent(stateDir, secUid, j.to || to, text, 'text')
        } catch { /* 记忆失败不影响已发出 */ }
        log(`chat -> ${j.to || to}: 已发送（${text.length} 字）`)
      }
      return sendJson(res, 200, j)
    }

    /* ── 最近一轮发生了什么（面板「看日志」用） ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/log') {
      const tail = (() => { try { return readFileSync(logFile, 'utf8').slice(-8000) } catch { return '' } })()
      const st = readJson(dutyStateFile, {})
      return sendJson(res, 200, {
        ok: true,
        logFile,
        tail,
        lastRunAt: st.lastRunAt || null,
        lastWhy: st.lastWhy || null,
        roundActive: Boolean(st.roundActive),
        // ⭐ 现在能不能跑（把"为什么不能"提前说清楚，别等点了才说）
        canRun: !dutyRunning && !roundBusyInState() && countPickedToday() < Number(cfg.perDay || 0),
        pickedToday: countPickedToday(),
        perDay: Number(cfg.perDay || 0),
      })
    }

    /* ── 记忆：看有多少 / 清掉 ── */
    if (req.method === 'GET' && path === '/api/douyin-duty/memory') {
      return sendJson(res, 200, { ok: true, stats: memoryStats(stateDir) })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/memory/clear') {
      const r = forgetAll(stateDir)
      log(`记忆：用户从面板清空了全部记忆（删了 ${r.removed} 个文件）`)
      return sendJson(res, 200, { ...r, stats: memoryStats(stateDir) })
    }

    /* ── 新手流程说明（面板上「怎么用？」拿这份）── */
    if (req.method === 'GET' && path === '/api/douyin-duty/guide') {
      let text = ''
      let err = ''
      try { text = readFileSync(join(pluginDir, 'GUIDE.md'), 'utf8') } catch (e) { err = String(e?.message ?? e) }
      return sendJson(res, 200, { ok: true, text, file: join(pluginDir, 'GUIDE.md'), error: err || undefined })
    }

    /* ── 给别的 AI 用：MCP 配置 + 使用说明 ──
     * 面板上「复制这段配置」拿的就是这里生成的东西 —— 路径按**这台机器**算好，
     * 不写盘符（不然别人抄过去一定错）。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/ai-usage') {
      const serverPath = join(pluginDir, 'tools', 'mcp-server.mjs')
      const mcpConfig = {
        mcpServers: {
          douyin: {
            command: 'node',
            args: [serverPath],
            env: { DOUYIN_HOME: stateDir },
          },
        },
      }
      let doc = ''
      let docError = ''
      try { doc = readFileSync(join(pluginDir, 'AI-USAGE.md'), 'utf8') } catch (e) { docError = String(e?.message ?? e) }
      return sendJson(res, 200, {
        ok: true,
        doc,
        doc_error: docError || undefined,
        file: join(pluginDir, 'AI-USAGE.md'),
        mcp: {
          server: serverPath,
          exists: existsSync(serverPath),
          selfTest: `node "${serverPath}" --selftest`,
          home: stateDir,
          config: mcpConfig,
          configText: JSON.stringify(mcpConfig, null, 2),
          note: '任何支持 MCP 的工具（Claude Code / Cursor / Cline / 另一个 DSH）把这段填进它的 MCP 配置即可。',
        },
        // DSH 自己也能把这份 server 挂成 MCP —— 给一段可以直接抄的 patch
        dshPatch: [
          '- id: mcp-douyin',
          "  name: '@deepseek-ai/dsh-mcp-client'",
          '  config:',
          '    serverName: douyin',
          '    transport: stdio',
          `    command: 'node'`,
          `    args: ['${serverPath.replace(/\\/g, '/')}']`,
          '    env:',
          `      DOUYIN_HOME: '${stateDir.replace(/\\/g, '/')}'`,
          '',
        ].join('\n'),
      })
    }

    /* ── 环境体检（纯 Node，不需要 Python —— 用户第一次点它时还没有 venv） ── */
    if (req.method === 'POST' && path === '/api/douyin-duty/doctor') {
      const r = runNodeTool('doctor.mjs', ['--json'], { timeout: 90_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, items: [], must_fix: [],
          error: '体检脚本没返回可解析结果',
          stderr: String(r.stderr || '').slice(0, 300),
        })
      }
      log(`doctor: ${(j.must_fix || []).length} 项必须修 / ${(j.warns || []).length} 项待办`)
      return sendJson(res, 200, j)
    }

    /* ── 人设：读 / 写使用者自己那份（$DOUYIN_HOME/persona.md）──
     * 优先级：使用者自己那份 > 插件自带 > 默认中性。
     * 这里只让写使用者那份 —— 插件包里那两份是随包发布的，不该被页面改。
     */
    if (req.method === 'GET' && path === '/api/douyin-duty/persona') {
      const mine = join(stateDir, 'persona.md')
      const has = existsSync(mine)
      let text = ''
      try { if (has) text = readFileSync(mine, 'utf8') } catch { text = '' }
      let defText = ''
      try { defText = readFileSync(join(pluginDir, 'prompts', 'persona.default.md'), 'utf8') } catch { defText = '' }
      return sendJson(res, 200, {
        ok: true, custom: has, text, default_text: defText,
        file: mine,
        hint: has ? '正在用你这份' : '还没写自己的 —— 现在用的是插件自带 / 默认人设',
      })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/persona') {
      const body = await readBody(req)
      const text = String(body.text ?? '')
      const mine = join(stateDir, 'persona.md')
      if (!text.trim()) {
        // 空 = 删掉自己那份，退回默认
        try { if (existsSync(mine)) rmSync(mine) } catch { /* 已经没了 */ }
        log('人设：已清空自定义，退回默认')
        return sendJson(res, 200, { ok: true, custom: false })
      }
      // ⭐ 身份牌必须有，否则下一轮会被跳过 —— 帮用户补上，别让他踩坑
      let out = text
      if (!/^<!--\s*persona:/i.test(out.trimStart())) {
        out = '<!-- persona: douyin-scroll -->\n' + out
      }
      try {
        writeFileSync(mine, out, 'utf8')
        log(`人设：已保存自定义（${out.length} 字）→ ${mine}`)
        return sendJson(res, 200, { ok: true, custom: true, file: mine })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/install') return sendJson(res, 200, runInstall())
    if (req.method === 'POST' && path === '/api/douyin-duty/install-browser') {
      return sendJson(res, 200, { ok: false, gone: true, hint: '2026-10-21 起不再需要浏览器依赖 —— bb-browser / playwright 那套已经整个删掉了' })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/check') {
      const out = { ok: false, steps: [] }
      if (!venvReadyNow()) { out.error = '环境还没装好 —— 点「装主依赖」'; return sendJson(res, 200, out) }
      if (!hasCredential(stateDir)) { out.error = '还没登录 —— 先扫码，或粘一条 Cookie'; return sendJson(res, 200, out) }
      try {
        const r = runPy('session-guard.py', ['check'], { timeout: 90_000 })
        const j = pickJson(r.stdout) || {}
        out.session = { alive: j.alive === true, nick: j.nick || null, code: j.code ?? null }
        if (j.alive === true) out.steps.push(`登录有效${j.nick ? '（' + j.nick + '）' : ''}`)
        else { out.error = `会话不健康：code=${j.code ?? '?'} ${j.why || ''}`; return sendJson(res, 200, out) }
      } catch (e) { out.error = '体检失败：' + (e?.message ?? e); return sendJson(res, 200, out) }
      try {
        runPy('forward-pick.py', [], { timeout: 300_000 })
        let picked = {}
        try { picked = JSON.parse(readFileSync(join(stateDir, 'forward-pick.json'), 'utf8')) } catch { picked = {} }
        const rows = Array.isArray(picked.rows) ? picked.rows : []
        out.sample = JSON.stringify(rows.slice(0, 2).map((x) => String(x.desc || '').slice(0, 40))).slice(0, 300)
        out.ok = rows.length > 0
        if (out.ok) out.steps.push(`能拿到候选（${rows.length} 条）`)
        else out.error = '拿不到候选 —— 推荐流这轮可能返回空，过会儿再试'
      } catch (e) { out.error = '取候选失败：' + (e?.message ?? e) }
      return sendJson(res, 200, out)
    }
    if (req.method === 'GET' && path === '/api/douyin-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 200000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/open') {
      const body = await readBody(req)
      const dir = String(body?.what || 'out') === 'home' ? stateDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, opened: dir, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }
    // ── Cookie ──
    if (req.method === 'GET' && path === '/api/douyin-duty/login/status') {
      const info = credentialInfo(stateDir)
      return sendJson(res, 200, {
        ok: true, hasCredential: info.hasCredential, keys: info.keys,
        who: info.important.join(', '), at: info.at, bytes: info.bytes,
        backend: 'feed（只读推荐流接口）',
      })
    }

    /* ⭐ 扫码登录（2026-10-22 加）—— 以前只写在文档里让人敲命令行，新手根本走不到。
     *   现在面板一键：出二维码 → 手机扫 → 点「我扫完了」。
     *
     *   QR 是**有头** Chrome 截的图，存 $DOUYIN_HOME/login-qr.png；
     *   面板拿 `qr_url` 直接 <img> 显示（同一个 webServer 下加了一条静态路由）。
     */
    if (req.method === 'POST' && path === '/api/douyin-duty/login/qr') {
      const force = String((await readBody(req))?.force || '') === '1'
      // 先确保后台无头浏览器不占着 profile —— 它和扫码窗口共用一个 user-data-dir
      if (force) {
        runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
        await new Promise((r) => setTimeout(r, 1200))
      }
      const r = runNodeTool('qr-login.mjs', ['start'], { timeout: 120_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        log(`扫码登录：出码失败（exit=${r.status}）${String(r.stderr || '').slice(0, 160)}`)
        return sendJson(res, 200, {
          ok: false,
          error: '出二维码失败',
          detail: String(r.stderr || r.stdout || '').slice(-600),
          hint: '常见原因：没装浏览器 / Chrome 被别的进程锁住。点「关掉后台浏览器重试」再试一次',
        })
      }
      if (!j.ok) {
        log(`扫码登录：${j.conflict || '失败'} ${j.error || ''}`)
        return sendJson(res, 200, j)
      }
      // 转成浏览器能直接 <img src> 的地址
      const qrName = String(j.qr || '').split(/[\\/]/).pop() || 'login-qr.png'
      log(`扫码登录：二维码已出（${qrName}，端口 ${j.port}）`)
      return sendJson(res, 200, {
        ...j,
        qr_url: `/api/douyin-duty/login/qr.png?v=${Date.now()}`,
      })
    }
    // 二维码图片本身（面板 <img src> 用）
    if (req.method === 'GET' && path === '/api/douyin-duty/login/qr.png') {
      const f = join(stateDir, 'login-qr.png')
      if (!existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('还没有二维码 —— 先点「扫码登录」') }
      try {
        const buf = readFileSync(f)
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(String(e?.message ?? e))
      }
    }
    // 「我扫完了」：轮询到登录成功（最多 ~120 秒）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/wait') {
      const body = await readBody(req)
      const sec = Math.max(10, Math.min(Number(body?.seconds) || 120, 300))
      const r = runNodeTool('qr-login.mjs', ['watch', String(sec)], { timeout: (sec + 30) * 1000 })
      // watch 会打多行 JSON，取最后一个完整对象
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      let last = null
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        try { last = JSON.parse(lines[i]) } catch { /* 继续往上找 */ }
      }
      if (!last) {
        return sendJson(res, 200, { ok: false, error: '没等到结果', detail: String(r.stderr || r.stdout || '').slice(-400) })
      }
      if (last.ok) {
        log(`扫码登录：成功，凭证已保存（${last.cookies || '?'} 条 Cookie）`)
        // ⭐ 记下"登录的是哪个号" —— 面板要显示昵称（用户要知道自己在给谁刷）
        try {
          const g = runPy('session-guard.py', ['check'], { timeout: 90_000 })
          const j = pickJson(g.stdout)
          if (j && (j.nick || j.uid)) {
            writeJson(join(stateDir, 'account.json'), {
              nick: j.nick || '', uid: j.uid || '', alive: j.alive === true,
              at: new Date().toISOString(),
            })
            log(`扫码登录：账号 = ${j.nick || '(无昵称)'} (uid=${j.uid || '?'})`)
          }
        } catch { /* 拿不到昵称不影响登录本身 */ }
        // 登完把有头浏览器收掉，别让它一直占着 profile（不然发私信会起不来）
        try { runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 }) } catch { /* 关不掉也不致命 */ }
        refreshCfg()
      }
      return sendJson(res, 200, last)
    }
    // 关掉登录用的浏览器（用户嫌窗口碍事 / 出码失败要重来时）
    if (req.method === 'POST' && path === '/api/douyin-duty/login/close') {
      const r = runNodeTool('qr-login.mjs', ['close'], { timeout: 40_000 })
      return sendJson(res, 200, pickJson(r.stdout) || { ok: true })
    }

    /* ⭐ 列出会话里的人（昵称 + sec_uid）—— 让用户点选"私信发给谁"，
     *    别再让他手填 sec_uid（新手根本不知道那是什么，也找不到）。只读。 */
    if (req.method === 'POST' && path === '/api/douyin-duty/dm/people') {
      if (!hasCredential(stateDir)) return sendJson(res, 200, { ok: false, error: '还没登录', hint: '先在上面扫码登录' })
      // 后台无头浏览器可能正在跑；先让它别占着（跟登录窗口同一个 profile）
      const r = runNodeTool('im-send.mjs', ['--list'], { timeout: 180_000 })
      const j = pickJson(r.stdout)
      if (!j) {
        return sendJson(res, 200, {
          ok: false, error: '没读到会话列表',
          detail: String(r.stderr || r.stdout || '').slice(-500),
          hint: '确认已登录；如果一直读不到，点「检查环境」看看浏览器那一项',
        })
      }
      if (j.ok) log(`会话列表：${j.count} 个人${j.no_id_count ? `（${j.no_id_count} 个没拿到稳定 id）` : ''}`)
      return sendJson(res, 200, j)
    }

    if (req.method === 'POST' && path === '/api/douyin-duty/login/save') {
      const body = await readBody(req)
      const r = saveCookie(stateDir, String(body?.cookie ?? ''), log)
      log(`Cookie 已保存（${redactCookie(String(body?.cookie ?? '')).slice(0, 40)}…）`)
      return sendJson(res, 200, r)
    }
    if (req.method === 'POST' && path === '/api/douyin-duty/login/clear') {
      return sendJson(res, 200, clearCredential(stateDir))
    }
    // ── 通知测试 ──
    if (req.method === 'POST' && path === '/api/douyin-duty/notify/test') {
      const result = await notifyTest()
      return sendJson(res, 200, result)
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'douyin-duty: /api/douyin-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { mcp?.stop() } catch { /* 收摊 */ } }, 'douyin-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，采集=推荐流只读接口，python=${cfg.pythonPath}，峰谷=${cfg.peakValley ? '开' : '关'}）`)
}
