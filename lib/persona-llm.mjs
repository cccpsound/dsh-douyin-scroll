/**
 * lib/persona-llm.mjs —— 用真模型说话（复用 AstrBot 的 provider 与人设）
 * ============================================================================
 * 背景（2026-10-25 使用者原话）：「为什么这么笨,能不能给她接入ai模型?」
 *
 * 此前抖音这边所有对外发言（私信自动回、评论区 @ 回）都是 `craft()` 里的
 * 一堆写死模板 + 按 hash 挑一句 —— 它根本没在思考，当然显得笨。
 *
 * 这个模块把「说什么」交给模型，但**保留原来那层规则兜底**：
 *   模型超时/报错/输出被规则判为不可发 → 调用方回落 `craft()`，行为与以前一致。
 * 为什么不直接把模型当成唯一路径：这是拿使用者账号对外说话，
 * 模型抽风发出去的东西收不回来；规则兜底保证「最差也是以前那样，不会更差」。
 *
 * ── 配置来源（三级，前面优先）─────────────────────────────────
 *   ① 环境变量：DOUYIN_LLM_BASE / DOUYIN_LLM_KEY / DOUYIN_LLM_MODEL / DOUYIN_LLM_PERSONA
 *   ② 家目录 config.json：llmBase / llmKey / llmModel / llmPersona
 *   ③ 自动读 AstrBot：cmd_config.json 里指定 provider 的 key+api_base+model，
 *      人设从 data_v4.db 的 personas 表取 —— 好处是以后在 AstrBot 里换模型/改人设，
 *      这边自动跟着变，不用两处维护。
 *
 * ── 为什么不塞整份人设 ──────────────────────────────────────
 * `xiaojingyu` 那份 8211 字里大半是 QQ 群聊专用（表情包、点歌、拍一拍、群黑话），
 * 抖音私信用不上，每轮多烧 8K token 还容易把群聊口癖带过来。
 * 这里改成「从人设里抽核心几条 + 抖音场景专用规则」拼一个精简 prompt，
 * 实测 system 约 900 字，单轮 0.5~2 秒。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { recallForPrompt } from './memory-bridge.mjs'
import { loadVideoMemory } from './memory.mjs'
import { findKnownMemes, renderMemeNote, splitMemeNote, lookupMeme, pickCandidates, pickShortTerms, addMeme } from './meme.mjs'
import { fitDesc } from './desc.mjs'
import { learnTerm, buildEvidenceBlock, buildWebEvidenceBlock } from './memelearn.mjs'

const ASTRBOT_DIR = process.env.ASTRBOT_HOME || 'E:/_bot/astrbot/AstrBot-master'
const ASTRBOT_CFG = join(ASTRBOT_DIR, 'data', 'cmd_config.json')
const ASTRBOT_DB = join(ASTRBOT_DIR, 'data', 'data_v4.db')

/** 从家目录 config.json 读，读不到返回 {} */
function readHomeCfg(home) {
  try {
    const p = join(home || join(homedir(), '.dsh', 'douyin-duty'), 'config.json')
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 从 AstrBot 的 cmd_config.json 挖出某个 provider 的 {base, key, model}。
 *
 * 结构分两层（踩过坑）：`provider[]` 是「用哪个模型」，
 * 真正的 `key` / `api_base` 挂在 `provider_sources[]` 里，
 * 靠 `provider[].provider_source_id` 关联。
 * 早期只看 `provider[].key` 会全是空串。
 */
function providerFromAstrBot(wantId) {
  if (!existsSync(ASTRBOT_CFG)) return null
  let cfg
  try {
    // ⚠️ AstrBot 写出来的 json 带 BOM，utf8 直接 JSON.parse 会报
    //    `Unexpected token  in JSON at position 0`
    cfg = JSON.parse(readFileSync(ASTRBOT_CFG, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }

  const provs = Array.isArray(cfg.provider) ? cfg.provider : []
  const sources = Array.isArray(cfg.provider_sources) ? cfg.provider_sources : []

  // 没指定就先用 agent_runner 当前在跑的那个，再不行挑第一个 enable 的 chat_completion
  let target = wantId
    ? provs.find((p) => p && p.id === wantId)
    : null
  if (!target) {
    const cur = cfg?.agent_runner?.config?.model?.provider_id
    target = provs.find((p) => p && p.id === cur) || null
  }
  if (!target) {
    target = provs.find((p) => p && p.enable !== false && p.provider_type !== 'embedding') || null
  }
  if (!target) return null

  const src = sources.find((s) => s && s.id === target.provider_source_id) || {}
  const pickKey = (v) => (Array.isArray(v) ? v[0] : v) || ''
  const key = String(pickKey(target.key) || pickKey(src.key) || '').trim()
  const base = String(target.api_base || src.api_base || '').trim()
  let model = ''
  const m = target.model
  if (typeof m === 'string') model = m
  else if (m && typeof m === 'object') model = String(m.model || m.id || '')

  if (!key || !base || !model) return null
  return { base, key, model, providerId: target.id }
}

/**
 * 从 AstrBot 的 data_v4.db 读人设全文。
 *
 * 不走 sqlite3 命令行（本机不一定有），改让 python 读 —— 插件 venv 里必然有 sqlite3 模块。
 * 只读打开（`mode=ro`），不碰业务库的写锁。
 */
/**
 * 读 sqlite 用的 python：**必须带 w**（pythonw.exe）。
 * Windows 上裸 `python` 的 PE Subsystem 是 3(Console)，spawn 出来会弹一个黑框
 * （标题就是 python.exe 完整路径），全屏游戏被强行最小化 —— 2026-10-29 使用者反馈。
 * venv 里的 pythonw.exe 完全能跑 `-c` 脚本、pip、sqlite，只是不申请控制台。
 */
function pyReadExe() {
  if (process.env.DOUYIN_PY) return process.env.DOUYIN_PY
  const home = process.env.DOUYIN_HOME || join(homedir(), '.dsh', 'douyin-duty')
  const v = join(home, '.venv', process.platform === 'win32' ? 'Scripts/pythonw.exe' : 'bin/python')
  if (existsSync(v)) return v
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function personaFromAstrBot(personaId = 'xiaojingyu') {
  if (!existsSync(ASTRBOT_DB)) return ''
  const py = pyReadExe()
  const code = [
    'import sqlite3,sys',
    `con=sqlite3.connect(r"file:${ASTRBOT_DB}?mode=ro",uri=True,timeout=10)`,
    "row=con.execute('SELECT system_prompt FROM personas WHERE persona_id=?',(sys.argv[1],)).fetchone()",
    'sys.stdout.write(row[0] if row and row[0] else "")',
  ].join('\n')
  try {
    return execFileSync(py, ['-c', code, personaId], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
  } catch {
    return ''
  }
}

/**
 * 从整份 QQ 群友人设里抽出「抖音私信也用得上」的部分。
 *
 * 🔴 2026-10-25 晚改：以前是按 4 条正则挑行、**最多 6 行、每行 ≤160 字**，
 *    结果 7175 字的人设被压成 200 来字，只剩「嘴硬心软 偶尔犯小呆」这种四字词。
 *    用户反馈「咋感觉还是这么蠢」——她手里就只剩这几句空话，当然答不出具体的。
 *
 *    现在改成「**减机制、不减人格**」：
 *      · 去掉的只是纯 QQ 群机制（拍一拍/禁漫/pixiv/空间/点歌/表情包/群管理/
 *        退群/红包/群聊黑话统计这类抖音私信没有的东西）
 *      · 性格、说话方式、黑话、应对态度、底线 —— 全部保留
 *    上限提到 9000 字（现役人设 7175 字，等于基本不裁）。
 *
 *    为什么敢给这么多：抖音这边每轮只发「一小段对话 + 一句话」，system 长一点
 *    换来的是她真的像那个人，而不是只会背四个字。workbuddy 本地代理 4000 上下文
 *    完全吃得下。
 */
function distillPersona(full) {
  if (!full) return ''
  /**
   * 只剔除「抖音私信里根本用不上」的内容：
   *   · 整行功能关键词（QQ 群机制：拍一拍/禁漫/pixiv/空间/点歌/表情包/群管理…）
   *   · QQ Agent 时代的工具名指令（send_message_to_user / web_search_deepseek /
   *     deepseek_fetch_web_page / my_persona / mention_user …）—— 抖音侧没有这些工具，
   *     留着只会让她想着「去调」，实际调不了，白白浪费时间还可能说出工具名。
   */
  const DROP = new RegExp(
    [
      '拍一拍', '禁漫', 'pixiv', '插画', '空间', '说说', '点歌', '放歌', '唱歌',
      '表情包', '群管理', '踢人', '改名片', '退群', '拉群', '红包', '支付宝',
      '直播', '粉丝牌', '投稿', '视频号', '番剧', '追番', '弹幕', '追更',
      '群友', '群聊', '本群', '这个群',
      '人设进化',
      // QQ Agent / AstrBot 专用工具名：抖音私信没有对应能力
      'send_message_to_user', 'web_search_deepseek', 'deepseek_fetch_web_page',
      'my_persona', 'mention_user', 'replyToMessageId', 'atUserId', 'send_poke',
    ].join('|'),
  )

  const out = []
  for (const raw of String(full).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    // 整行命中「抖音用不上」的直接丢（标题行也一起丢，避免留下孤零零的小标题）
    if (DROP.test(line)) continue
    out.push(line)
  }

  let text = out.join('\n')
  // 压缩连续空行，别让一堆空行白占 token
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  // 硬上限 9000 字：留出余量防止人设哪天膨胀到几万字把上下文挤爆
  if (text.length > 9000) {
    text = text.slice(0, 9000)
    const cut = text.lastIndexOf('\n')
    if (cut > 8000) text = text.slice(0, cut)
    text += '\n（后面还有，但抖音这边先只带到这儿）'
  }
  return text
}

/** 抖音私信场景专用规则（人设抽不出来时也能独立工作） */
/**
 * 评论区场景规则。
 *
 * 为什么另写一套而不是复用私信那套：评论区是**公开场合**，别人都看得见。
 * 私信里可以「咋了 上班被老板压榨了」，评论里这么回就显得太熟、不礼貌；
 * 而且评论会被更多人看到，说错话的代价高得多。
 */
const SCENE_RULES_COMMENT = `你在抖音评论区回复别人的 @。规则：
- 只回一句，12 字以内，口语，像随手在评论区打的一句
- 这是公开场合，别套近乎、别用「主人」这类称呼、别问对方私事
- 不用括号写动作神态，不解释自己是 AI，不复述对方原话
- 别人问什么就答什么；夸你就接一句，骂你就淡一点带过，别吵
- 不谈钱、不给链接、不要隐私、不提自己主人的事`

const SCENE_RULES = `你在抖音私信里跟人聊天。规则：
- 默认一句话，30 字以内，口语，像真人在手机上随手打的
- **上方是你们的聊天记录**：标着 assistant 的是你自己说过的，标着 user 的是对方说的。
  对方问「啥意思」「你刚说啥」「什么」这类，就是在问**你上一句**——先想清楚自己刚说了什么再答
  能判断出指哪句就**直接答内容**；只有真的判断不出，才问「你指哪句」
- **别答非所问**：对方问 A 你答 B，比说「我没懂」更糟
- 🔴 **遇到你不认识的词（人名、梗、缩写、生造词），不要回「不知道」「没听过」**，
  也不要问对方「那是啥」。直接用下面这个格式报出来，系统会替你去搜：
      [[SEARCH:那个词]]
  只报一个词、只报一次、括号里只有那个词本身，不要写别的内容。
  搜完你会拿到证据，再重新回答——**那时候要像本来就知道一样答，别说「我搜了」「我查了」**。
  例：
      对方：灭建国是谁@小鲸鱼
      你：[[SEARCH:灭建国]]
- 🔴🔴 **最常犯的错不是「不会」，是「以为会」**（2026-10-28 实测，务必看）：
  有人骂「你扎啤吧」，你照字面接了「你才扎啤，我这条鱼好得很」——**这是漏报，比答错更丢人**。
  凡出现下面任一情形，**先报 [[SEARCH]] 再答**：
    · 一个词按字面讲得通，但放在这句话里**讲不通、或者对不上语气**（骂人话照字面接 = 典型漏报）
    · 一串字母（yqp / yyds / xswl）或别人名字、外号、生造的两三字词
    · 你心里有一瞬间的「这是啥？」——**那一瞬间就是信号，别压过去**
  宁可多搜一次，也不要装懂。搜不到再说不知道，那不算丢人。
- 🔴 **绝不编造词的意思**。不认识就说搜，不要猜一个读音相近的东西糊过去
  （实测出过：把「扎啤的」扯到俄语歌「Микоян」上，对方当场就听出是瞎编）。
- **对方教了你一个词的用法时**（「XX 就是 YY」「那叫 XX」），记住它：
      [[MEME:那个词=一句话解释]]
  例：
      对方：那是灭霸他爸，他叫灭建国
      你：[[MEME:灭建国=灭霸他爸，网友给漫威全员起的土味中文名]] 好家伙，父子俩一个味儿
  这个标记会被系统吃掉、只留后面那句正常回复。**一次只学一个词**。
- 🔴 **对方发了视频/图文、你也看到了内容时：必须带一个具体细节**（谁做了什么、结局怎样、
  哪句话/哪个画面）。只回「看完了」「有点堵」「说不出话」= 等于没看，对方立刻知道你根本没看。
  30 字够装一个细节：宁可短到只有那个细节，也不要长到全是空泛感慨。
  ✗「看完了，心里有点堵」（零信息）
  ✗「根据真实事件改编的这个很感人」（念文案）
  ✗ 不要套用任何固定句式（比如「看到…我直接不行了」）——每条的细节都不同，句子也该不同
- 不用括号写动作神态，不用句号结尾，不用「亲」「呢~」这类客服腔
- 不解释自己是 AI，不复述对方的话，不总结，不列点
- 别人问什么就答什么；答不上来就说不知道，别编
- 不谈钱、不给链接、不要隐私、不吵架`

/**
 * 拼 system prompt。
 * `isOwner` 只影响一句称呼说明 —— 别的规则对谁都用同一套。
 *
 * ⚠️ 评论区场景（scene='comment'）**一律按「不是号主」处理称呼**：
 * 公开场合喊「主人」很怪，别人看着也不对劲。所以即使对方真是号主，
 * 评论里也只当普通网友。`sanitize()` 那边同理（调用方要同步传 isOwner=false）。
 */
function buildSystem(personaFull, isOwner, honorific, scene = 'dm') {
  const core = distillPersona(personaFull)
  const parts = [scene === 'comment' ? SCENE_RULES_COMMENT : SCENE_RULES]
  if (core) parts.push('\n你的性格底色：\n' + core)
  const addressAsOwner = isOwner && honorific && scene !== 'comment'
  if (addressAsOwner) {
    parts.push(`\n现在跟你说话的是你的${honorific}（账号本人），可以叫他「${honorific}」。`)
  } else {
    /**
     * ⭐ 陌生人别喊「主人」。
     *
     * 实测（2026-10-25）：只说一句「别用「主人」这类称呼」，模型对陌生人
     * 你好 → 回「主人好呀～」，靠 sanitize 事后剔成「好呀～」虽然救回来了，
     * 但那句话的味道已经歪了。这里改成**正面指令 + 反面禁令**一起给，
     * 实测「你好」→「你好呀 找我有事」不再带称呼。
     */
    parts.push(
      '\n现在跟你说话的是**普通网友，不是你主人**。' +
      '绝对不要叫他「主人」或任何亲密称呼，直接说话就行（比如「你好」「咋了」）。' +
      '你没见过这个人，语气保持有点距离感。',
    )
  }
  return parts.join('\n')
}

/**
 * 调模型说一句话。
 *
 * @param {object} o
 * @param {string} o.text      对方刚说的话
 * @param {Array}  o.history   之前的对话 [{from:'me'|'them', text}]（按时间正序）
 * @param {boolean} o.isOwner  对方是不是号主
 * @param {object|null} o.card 视频卡片 {item_id,title}
 * @param {object|null} o.video 已解析过的视频信息（`lib/video-card.mjs` 的 understandVideoCard 结果）
 *                             带 `scene` 就把「画面里在发生什么」告诉模型，它才有得聊；
 *                             没带就只当「对方发来一个视频」，别硬编内容。
 * @returns {Promise<{ok:boolean, text?:string, model?:string, ms?:number, error?:string}>}
 *          永不 throw —— 调用方靠 ok 判断要不要回落规则模板
 */
export async function sayWithModel(opts = {}) {
  const { text, history = [], isOwner = false, card = null, video = null, home = '', scene = 'dm', secUid = '' } = opts
  const cfg = readHomeCfg(home)
  const env = process.env

  // llmEnabled === false 时整条模型路径关掉，纯走 craft() 模板（留个后路：
  // 模型欠费/被封/说胡话时，使用者一键退回以前那套，不用改代码）
  if (cfg.llmEnabled === false || String(env.DOUYIN_LLM_OFF || '') === '1') {
    return { ok: false, error: 'disabled（llmEnabled=false，走规则模板）' }
  }

  const prov = providerFromAstrBot(cfg.llmProvider || env.DOUYIN_LLM_PROVIDER || '')
  const base = String(env.DOUYIN_LLM_BASE || cfg.llmBase || prov?.base || '').trim()
  const key = String(env.DOUYIN_LLM_KEY || cfg.llmKey || prov?.key || '').trim()
  const model = String(env.DOUYIN_LLM_MODEL || cfg.llmModel || prov?.model || '').trim()
  if (!base || !key || !model) {
    return { ok: false, error: 'no_provider（拿不到 base/key/model，回落规则模板）' }
  }

  const personaId = String(env.DOUYIN_LLM_PERSONA || cfg.llmPersona || 'xiaojingyu').trim()
  const honorific = String(env.DOUYIN_HONORIFIC || honorific_default()).trim() || '主人'
  const personaFull = personaFromAstrBot(personaId)
  const system = buildSystem(personaFull, isOwner, honorific, scene)

  // 只带最近 8 轮：抖音私信多是短句，带太多反而让模型去接很早以前的话头
  const msgs = [{ role: 'system', content: system }]
  for (const h of history.slice(-16)) {
    const role = h.from === 'me' ? 'assistant' : 'user'
    const c = String(h.text || '').trim()
    if (!c) continue
    // 连续同角色会触发部分网关 400，合并成一条
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content += '\n' + c
    else msgs.push({ role, content: c })
  }
  let userLine = String(text || '').trim()

  /**
   * ⭐ 长期记忆（2026-10-25 加）：从 AstrBot 的 LivingMemory 里捞相关的过去片段。
   *
   * 为什么要有：抖音这边以前只有「这个会话最近 16 条」，隔一天再聊就是白纸。
   * 而 QQ 那边攒了 237 条记忆（谁爱吃什么、聊过什么梗），人在两边是同一个人，
   * 记不住才是真的笨。
   *
   * 检索用的 query 就是对方这句话本身 —— 不拼额外上下文：
   * 拼了反而会把 BM25 拉到无关的常用字上（实测「主人 抖音 视频 上下文」这种
   * 长句 keyword 分全是 0，捞回 0 条）。卡片没文字时用标题兜底。
   *
   * 开关：config.json 的 `memoryEnabled: false` 或环境变量 `DOUYIN_MEMORY_OFF=1`。
   * 失败一律静默吞掉（recallForPrompt 内部已保证不 throw）——
   * 记忆是锦上添花，不能因为它挂了就让人没法说话。
   */
  let memoryBlock = ''
  const memOn = cfg.memoryEnabled !== false && String(env.DOUYIN_MEMORY_OFF || '') !== '1'
  if (memOn) {
    const q = String(text || '').trim() || String(card?.title || '').trim()
    if (q) {
      try {
        memoryBlock = await recallForPrompt(q, { home, enabled: true })
        /**
         * 打个可见的痕迹：没有这行日志，跨来源记忆是否命中就只能靠猜。
         * 只记条数与长度，不记正文 —— 日志会一直长着。
         */
        if (memoryBlock) {
          // lib 里没有 log 工具（日志由 tools/*.mjs 各自管），直接往 stdout 打一行
          // JSON —— 上层会把子进程 stdout 原样回显进 dm-auto-reply.log / group-reply.log。
          const n = (memoryBlock.match(/^- /gm) || []).length
          const cross = (memoryBlock.match(/【别处】/g) || []).length
          const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
          process.stdout.write(
            `[${stamp}] ${JSON.stringify({ tick: 'mem_hit', query: q.slice(0, 24), n, cross, chars: memoryBlock.length })}
`,
          )
        }
      } catch {
        memoryBlock = ''
      }
    }
  }

  if (card) {
    /**
     * 卡片本身没有文字，得告诉模型「这是一个视频」，否则它会去念话题标签。
     *
     * ⭐ 2026-10-25 加：如果调用方已经用视觉模型看过封面（`video.scene`），
     * 就把画面内容一起给 —— 这时候它才能真的「接着聊这个视频」，
     * 而不是只会说「收到」。拿不到画面时只报「有个视频」，绝不编内容。
     *
     * 🔴 2026-10-27 晚改（关键）：原来说「文案是作者自己写的概括，比封面那一帧更能代表
     *    内容；**接话时要贴着文案说，别只聊画面里那点东西**」—— 这条指令现在直接导致
     *    「她评价视频像在念标题」。使用者连续两轮反馈，实测抓到了：
     *      · 195 秒的《永恒的爱》被 180 秒时长闸挡掉，只拿到封面（一个人坐着）；
     *      · 于是她能用的就只有文案「根据真实事件改编」+ 话题标签；
     *      · prompt 又叮嘱她「贴着文案说」⇒ 输出必然飘在标题层。
     *    现在改成「画面 / 评论 与文案冲突时，以画面和评论为准」，并且
     *    明确告诉她「只看到封面」和「看到的是文案」有什么区别，别装作看过。
     *
     * ⭐ 新增评论块：调用方读到了高赞评论就一起给。评论是**观众看完之后的反应**，
     *    「结局是什么」「为什么这条会火」几乎全在评论里、文案一个字不提
     *    （实测那条：15531 赞的评论才说出"男主后来殉情了"）。
     */
    const title = String(card.title || '').replace(/[#＃][^\s#＃]+/g, '').replace(/\s+/g, ' ').trim()
    const vs = String(video?.scene || '').trim()
    const vd = String(video?.desc || '')
      .replace(/[#＃][^\s#＃]+/g, '')
      .replace(/@[^\s，,]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const vcmts = Array.isArray(video?.comments) ? video.comments.filter(Boolean).slice(0, 5) : []
    /**
     * 🔴 2026-11-10：开头那句不能一律叫「视频」。
     *
     * 对方直接发来一张图 / 一个动图时，card.kind 是 `image` / `gif`，
     * 这里仍然说「对方发来一个视频」，模型就会回「视频里那个…」——
     * 对方一看就知道她连自己发的是图还是视频都没分清。
     */
    const ck = String(card.kind || '')
    /**
     * 🔴 2026-11-10 第二刀：转发来的**图文作品**原来也一律叫「一个视频」。
     *
     * 实测抓到的现场：`card.kind` 对转发卡片是空的（`im-http.py` 那个分支只填
     * item_id/title/aweme_type/sec_uid），所以单看 kind 永远落到「视频」。
     * 而 `video.how_seen` 是 `images:6` 说明视觉那边**确实读的是图集**，
     * 这时候说「视频」她就又回「视频里…」—— 使用者报的就是「发了个图文」，
     * 开口还叫视频，等于第一句就露馅。所以 how_seen 优先于 kind。
     */
    const howNow = String(video?.how_seen || '')
    const noun = /^images:/i.test(howNow) ? '一条图文'
      : ck === 'image' ? '一张图片'
        : ck === 'gif' ? '一个动图'
          : '一个视频'
    const parts = [`（对方发来${noun}`]
    /**
     * 🔴 2026-11-03 改：70 → 200，画面 90 → 150。
     *
     * 使用者报「文案读不全，读一半就断了」。这是四道截断里**最后也最狠**的一道：
     * 前面 `describeVideo`（120→280）和 `video-frames`（60→150）放开之后，
     * 如果这里还卡 70，前面放宽全白做 —— 真正进她 prompt 的就是这 70 个字。
     *
     * 注意这里砍之前**先把 #话题 和 @作者 剥光**（那是正确做法：标签对理解
     * 内容没帮助，还特别抢注意力）。代价是兜头砍掉 70 会砍在正文正中。
     * 实测那条 187 字文案，剥完 tag 剩 111 字纯正文，70 字处断在
     * 「…我花了三个晚上调这个模型，每一帧都」，后面
     * 「是自己渲染的，蓝色那条鱼就是照着你们的头像做的…」整段丢。
     *
     * 🔴 2026-11-05 第四次改（也是最后一道）：200 → fitDesc（上限 2000）。
     *
     * 这是四道截断里最狠的一道 —— 前面三处放宽了，卡在这 200 就全白放，
     * 真正进她 prompt 的就是这 200 字。
     *
     * 原来 200 的理由是「抖音正文上限 55 汉字」，这个前提已经过期：
     * 长文/图文作品的正文能到一两千字。使用者贴的 @Dionysus 尼采长文
     * 900+ 字，200 字只能读到「翻出那本八块钱买的盗版《查…」，
     * 瓦格纳、莎乐美、1889 年都灵抱马痛哭、此后十一年没写字 —— 全在后面。
     *
     * 超上限时 fitDesc 会在自然断点收尾并加「（后面还有 N 字，这条没读完）」，
     * 她知道这是长文、知道自己只读了前半，不会把半句当全文。
     */
    if (vd) parts.push(`，文案写的是「${fitDesc(vd)}」`)
    /**
     * 🔴 2026-11-03 改：40 → 200，和上面 vd 那支对齐。
     *
     * 这条是「拿不到 video.desc，只能用 card.title」的兜底支路 —— 视频详情
     * 没查到、或者 `withVision:false` 时就会走这里。`title` 已经在上面
     * （`:406`）剥掉了 `#话题` 和多余空白，剩下的全是作者写的正文，
     * 卡 40 字等于让兜底路径比主路径少读 80% 的内容。
     *
     * 上游 `im-http.py` 的 card.title 已放到 300（2026-11-03 一起改的），
     * 这里不跟上就成了新的断点。
     *
     * 🔴 2026-11-05：200 → fitDesc（上限 2000），和主路径 vd 那支对齐。
     * 兜底路径不该比主路径少读 —— 使用者报「文案读不全」时，
     * 有一半就是走了这条兜底、然后被 200 砍的。
     */
    else if (title) parts.push(`，标题是「${fitDesc(title)}」`)
    /**
     * ⭐ 2026-11-05 新增：视频里「说的话」。
     *
     * 位置刻意放在文案之后、画面之前 —— 话是内容本身，画面是对内容的补充。
     * 口播型视频的文案常常只有「#日常 #vlog」几个字，这时候这段话是唯一的实质信息。
     *
     * 前置说明「用机器听下来的」很重要：转写会有错字、会漏掉语气，
     * 不告诉她来源她就会当成原文逐字引用，说出「视频里说『呃那个就是』」这种。
     */
    const vsp = String(video?.speech || '').trim()
    if (vsp) {
      parts.push(`，视频里说的话（机器听写的，可能有错字，别逐字当原文引用）：「${fitDesc(vsp)}」`)
    }
    // 视觉模型给的 scene 常常自带句号，先剥掉尾部标点，避免拼出「。。」
    const vsClean = vs.replace(/[。．.！!？?；;，,\s]+$/, '')
    /**
     * 🔴 2026-11-10：画面描述的字数上限，从「一刀 150」改成按来源分档。
     *
     * 事故：图文作品 6 张图，每张的观察都在 `scene` 里用换行拼起来，
     * 而这里 `slice(0, 150)` —— 只有第一张能进 prompt，后面五张全被砍掉，
     * 她拿着 1/6 的信息就作答。这是「发了个图文她没读明白」的第二半原因。
     *
     * 分档依据是 `how_seen`（`lib/video-card.mjs` 写的）：
     *   · `images:N` —— 图集，N 张各自的文字和画面，必须全给。上限 2400。
     *   · `frames:N` —— 整段抽帧，视觉模型本来就只写 150 字左右，给 600 余量够。
     *   · `cover` / `image` / `gif` —— 单张图，600 足够。
     * 超上限时 fitDesc 会在自然断点收尾并注明「后面还有 N 字」，
     * 她至少知道自己没读全，而不是把半段当全文。
     */
    const how = String(video?.how_seen || '')
    const sceneCap = /^images:/i.test(how) ? 2400 : /^frames:/i.test(how) ? 600 : 600
    if (vsClean) parts.push(`，画面是：${how === 'image' || how === 'gif' ? vsClean : fitDesc(vsClean, sceneCap)}`)
    /**
     * ⭐ 2026-11-10 新增：图集必须告诉她「一共有几张、你看清了前几张」。
     *
     * 以前只有 `cover` 会收到「你只看到封面这一帧」的提醒，`images:N` 一声不响 ——
     * 于是她把只看了 3 张（现在是 6 张）的图文当成看全了，回话说得理直气壮。
     * 两个数字分别来自 `video.images_seen` / `video.images_total`。
     */
    const seenN = Number(video?.images_seen) || 0
    const totalN = Number(video?.images_total) || 0
    if (/^images:/i.test(how) && totalN > seenN && seenN > 0) {
      parts.push(`（提醒：这条图文一共有 ${totalN} 张，你只看到了前 ${seenN} 张，后面还有 ${totalN - seenN} 张没看到，别当成全篇）`)
    }
    if (vcmts.length) parts.push(`，高赞评论里有人说：「${vcmts.join('」／「').slice(0, 220)}」`)
    if (!vs && !vd && !title && !vcmts.length && !vsp) parts.push('，你看不到内容')
    /**
     * 优先级说明必须写死，否则模型会退回「挑最好念的那份」——
     * 而最好念的永远是文案（作者已经替它总结好了）。
     */
    if (vs && (vd || vcmts.length)) {
      // ⚠️ 不要用 markdown 星号：这段是直接拼进 user message 的纯文本，
      //    星号会被模型当成"要原样复述的格式"（实测出现过回复里带 ** 的情况）。
      // ⚠️ scene 自己可能以「。」结尾，这里先剥掉再拼，否则出现「。。」
      parts.push('。这几项里，画面和评论比文案可靠：文案可能是标题党、也可能只是作者随手写的感想；真发生了什么、结局是什么，以画面和评论为准。')
    }
    if (vcmts.length) parts.push('评论说的是观众看完之后的反应和补充，别把它当成剧情原文照抄，是拿来理解内容的。')
    // ⭐ 2026-11-05：`!vs && !vcmts.length` 原来无条件说「你只看到文字」，
    // 但现在有可能听到了声音（vsp）—— 那就不是「只看到文字」，是在骗她。
    if (!vs && !vcmts.length && !vsp) parts.push('。你只看到文字，没看到画面也没看到评论，别猜视频里发生了什么。')
    else if (!vs && vsp && !vcmts.length) {
      parts.push('。你听到了它说的话，但没看到画面，别描述画面里有什么。')
    }
    if (vs && /^cover$/i.test(String(video?.how_seen || ''))) {
      // 只看了封面 ⇒ 必须知道自己只看到一帧，别把封面当成整条片子
      parts.push('（提醒：你只看到封面这一帧，整段视频没看到，回答时别把封面当成全片）')
    }
    userLine = parts.join('') + '）'
  }
  if (!userLine) return { ok: false, error: 'empty_input' }

  /**
   * 记忆片段拼在「对方这句话」**前面** —— 它是背景资料，不是对方说的话。
   * 拼在后面会让模型把记忆当成刚收到的内容去回应（实测会答非所问）。
   */
  if (memoryBlock) userLine = memoryBlock + '\n\n' + userLine

  /**
   * ⭐ 2026-10-27 加：把「我以前在这个人这儿看过哪些作品」拼进背景。
   *
   * 起因：使用者问「我给抖音的小鲸鱼发视频，QQ 的能学习到吗，能读到记忆库和
   * 上下文里吗」。查下来两边都不通 —— 而且更糟：连抖音这边的 `memory/dm-*.json`
   * 里都一条卡片都没有（卡片 text 为空被丢了），所以她**连自己看过什么都记不住**。
   *
   * 现在 `lib/memory.mjs` 的 `addVideoMemory` 会把看过的作品写进 `videos[]`，
   * 这里取最近 3 条拼成「我最近在这个人这儿看过…」。用途很具体：
   *   · 对方回一句「那个」「刚才那个」时，她知道指的是哪条
   *   · 对方隔天再提，她不至于装第一次见
   * ⚠️ 只在有 secUid 时才查（否则不知道查谁）；失败静默，绝不阻断。
   */
  if (secUid && home) {
    try {
      const vids = loadVideoMemory(home, secUid, { recent: 3 })
        .filter((v) => v && (v.scene || v.title))
      if (vids.length) {
        const lines = vids.map((v) => {
          const t = String(v.title || '').replace(/\s+/g, ' ').trim().slice(0, 40)
          const s = String(v.scene || '').replace(/\s+/g, ' ').trim().slice(0, 60)
          const day = String(v.at || '').slice(0, 10)
          const who = t ? `「${t}」` : ''
          return `· ${day} ${who}${s ? ' 画面：' + s : ''}`.trim()
        })
        userLine = '（我之前在这个人这儿看过的作品：\n' + lines.join('\n')
          + '\n—— 他要是说「那个」「你上次看的」就指这些，别问他是哪个）\n\n' + userLine
      }
    } catch { /* 记忆读不到就当没有 */ }
  }

  /**
   * ⭐ 2026-10-27 加：「不认识就去搜」，而且是**她自己**发现不认识。
   *
   * 使用者原话：「不要是要求去搜再去搜，而是不认识就去搜」。
   * 之前群里问「灭建国是谁」，她答「？谁啊，没听过」，被人教了两遍还是这句 ——
   * 因为她既没有查的能力，也没有查的动机。
   *
   * 机制分两层：
   *   ① **这里**：梗库里有过的词，直接把释义拼进背景（0 延迟，不花一次搜索）
   *   ② **下面 callOnce 循环里**：模型自己报 `[[SEARCH:词]]` → 搜一次、落库、带证据重答
   *
   * 为什么让模型自己报而不是纯规则：规则不可能判断「扎啤的」是骂人还是打错字。
   * `pickCandidates` 只当最后兜底，且只收三类强特征（拉丁缩写/引号/年代梗字）——
   * 白搜一次 2 秒，还会把无关结果写进梗库（实测「扎啤的」搜出教师节段子）。
   */
  const MEME_ON = cfg.memeEnabled !== false && String(env.DOUYIN_MEME_OFF || '') !== '1'
  let memeTip = ''      // 贴在用户原话**后面**的那一句（见 splitMemeNote 的注释）
  if (MEME_ON && home) {
    try {
      const known = findKnownMemes(home, String(text || ''))
      if (known.length) {
        const note = renderMemeNote(known)
        if (note) {
          const { head, tail } = splitMemeNote(note, known)
          userLine = head.replace(/^\n+/, '') + '\n\n' + userLine
          memeTip = tail
        }
      }
    } catch { /* 梗库读不到就当没有 */ }
  }

  /**
   * 🔴 2026-10-28 实测：这个提示**必须贴在用户原话之后**，不能贴前面。
   *
   * 同一句「你扎啤吧」，同一份提示，只是位置不同：
   *   贴前面（`（提醒：扎啤 是骂人的话）\n你扎啤吧`）→ 连测 3 次全部照字面回「你才扎啤」
   *   贴后面、且把注释放进引号外侧         → 连测 3 次全部答对（「你才杂皮」）
   * 差 20 个字的位置就差在「模型注意力落到哪」——它在长上下文里会更认真读
   * 紧挨着自己要输出的那一段。所以这里改成 `原文 + '\n' + tip`。
   */
  const withTip = (s) => (memeTip ? String(s) + '\n' + memeTip : String(s))
  if (msgs[msgs.length - 1]?.role === 'assistant') msgs.push({ role: 'user', content: withTip(userLine) })
  else if (msgs.length === 1) msgs.push({ role: 'user', content: withTip(userLine) })
  else msgs[msgs.length - 1].content += '\n' + withTip(userLine)

  /**
   * 🔴 2026-10-25 实测：模型偶尔会把**角色词**当正文吐出来。
   *
   * 实例：号主在评论区只打了个「@小鲸鱼」，模型回了 `？\n\nuser咋了` ——
   * 那个 `user` 是它把自己脑子里「用户说」的标签带出来了。
   * 这种东西发出去极其难看，所以在出口统一清一遍。
   */
  const stripRoleWords = (s) =>
    String(s || '')
      .replace(/(^|\n)\s*(user|assistant|system|human|ai|用户|助手)\s*[:：]\s*/gi, '$1')
      .replace(/\b(user|assistant|system)\b/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '')

  const t0 = Date.now()

  /**
   * 单次调用（抽成内部函数是为了「搜完再答一遍」要复用同一套 msgs）。
   * 返回 `{ok, raw}`；raw 是模型原话（还没剥 `[[SEARCH:…]]`）。
   */
  const callOnce = async (msgList) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Number(cfg.llmTimeoutMs || 25_000))
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: msgList,
          /**
           * 120 → 200：原来 120 token 大约只够 60~80 个中文字，再被 15 字规则一压，
           * 稍微需要说清楚一点的回答（解释一个梗、回答「我刚才说啥了」）就会被截断。
           * 200 够写 2~3 句，配合「默认一句话 30 字」的规则，短而不残缺。
           */
          max_tokens: Number(cfg.llmMaxTokens || 200),
          temperature: Number(opts.temperature || cfg.llmTemperature || 1.0),
        }),
        signal: ctrl.signal,
      })
      const body = await r.text()
      if (!r.ok) {
        // 把网关的真实原因带出去（欠费/限流/模型不存在 都靠这句话区分）
        return { ok: false, error: `http_${r.status}: ${body.slice(0, 160)}` }
      }
      let j
      try {
        j = JSON.parse(body)
      } catch {
        return { ok: false, error: 'bad_json: ' + body.slice(0, 120) }
      }
      const raw = String(j?.choices?.[0]?.message?.content || '').trim()
      return { ok: true, raw, usage: j.usage }
    } catch (e) {
      return { ok: false, error: `${e.name}: ${String(e.message || e).slice(0, 120)}` }
    } finally {
      clearTimeout(timer)
    }
  }


  let finalText = ''
  let lastUsage = null
  let out = ''
  let searched = 0
  const SEARCH_TAG = /\[\[\s*SEARCH\s*[:：]\s*([^\]\n]{1,24})\s*\]\]/i

  /**
   * ⭐ 「让她可以加入梗词」的另一半（使用者 m08895 原话）。
   *
   * 搜索是**她自己查别人**；这个标记是**别人教她**：
   *   「那是灭霸他爸，他叫灭建国」→ 她学一句 → 下次别人提「灭建国」她直接知道。
   *
   * 为什么让模型自己决定学什么：人在被纠正的时候才最知道自己缺什么。
   * 规则做不到这一点 —— 它不知道对方那句话是在教她，还是在骂她。
   */
  const MEME_TAG = /\[\[\s*MEME\s*[:：]\s*([^=\]|]{1,24})[=＝]([^\]\n]{1,120})\s*\]\]/i

  /**
   * 「我也不认识」的痕迹。模型没主动报 `[[SEARCH]]`、但答出了这类话时，
   * 说明它知道该查却没查 —— 这是兜底路径的触发条件。
   */
  const DUNNO = /(不认识|不知道|没听过|没听懂|没懂|不了解|没了解|这是什么梗|啥梗|什么梗|没听说过|查不到|搜不到)/

  for (let round = 0; round < 3; round++) {
    const got = await callOnce(msgs)
    if (!got.ok) {
      return { ok: false, error: got.error, ms: Date.now() - t0 }
    }
    lastUsage = got.usage || lastUsage
    out = stripRoleWords(got.raw)

    /**
     * 先把「教我的梗」收下来（不管这一轮还要不要搜都要收）：
     * 对方主动教的东西是这个场景里最优质的语料，丢了可惜。
     */
    if (MEME_ON && home) {
      const lm = out.match(MEME_TAG)
      if (lm) {
        const term = String(lm[1] || '').trim()
        const mean = String(lm[2] || '').replace(/\s+/g, ' ').trim()
        if (term && mean) {
          try { addMeme(home, { term, meaning: mean, source: 'model', evidence: String(text || '').slice(0, 120) }) } catch { /* 学不会不影响回话 */ }
        }
        // 标记必须吃掉 —— 它绝不能出现在发出去的消息里
        out = stripRoleWords(out.replace(MEME_TAG, '')).trim()
      }
    }

    const m = out.match(SEARCH_TAG)
    /** 这一轮要查的词：模型自己报的优先，其次兜底候选。 */
    let term = m ? String(m[1] || '').trim() : ''

    /**
     * ⭐ 兜底（2026-10-27 加，2026-10-28 放宽）：模型没报标记时，代码替它挑。
     *
     * 原来要求「输出里含不知道/没听过」才走 —— 实测这条路**漏光了主要的坑**：
     *   对方：你扎啤吧        → 她：你才扎啤，我这条鱼好得很      （照字面接，不报）
     *   对方：@小鲸鱼 你麻痹   → 她：你骂我干嘛                     （听懂了，不报）
     *   对方：就是个飞舞      → 她：？飞舞就飞舞呗，我尾巴还能甩   （照字面接，不报）
     * 这三种都是「误解」而不是「拒答」，DUNNO 一个都匹配不上，于是永远搜不到。
     *
     * 2026-10-28 的实测结论：**「不认识」这个判断不能交给模型**（prompt 里写了
     * 三级加粗的强制规则，她照样不报）。所以把兜底改成：只要原话里挑出了
     * **强特征候选词**、且梗库里没有，就去查一次 —— 不管她答成什么样。
     *
     * `pickCandidates` 本身收得很紧（拉丁缩写 / 引号内容 / 带年代梗字的 2-6 字词），
     * 实测「今天天气不错啊」`[]`、「@小鲸鱼 去学习梗,你不接入抖音了吗」`[]`，所以
     * 放宽到这里也不会把日常闲聊拖成每次 2 秒。`DUNNO` 只留作「她说不知道但候选为空」
     * 时的兜底判断，不再当准入条件。
     */
    if (!term && MEME_ON && home && searched < 2) {
      const raw = String(text || '')
      // 先走强特征（拉丁缩写 / 引号 / 年代梗构词字），那批最准
      const pick = pickCandidates(raw, { max: 2 })
      // 再补「短句实词」—— 「你扎啤吧」「你麻痹」「就是个飞舞」全靠这一条
      const shorts = pickShortTerms(raw, { max: 2 })
      const cands = [...pick, ...shorts]
        .filter((w, i, arr) => arr.indexOf(w) === i)
        .filter((w) => !lookupMeme(home, w))   // 库里已有的不用搜
      if (cands.length) term = cands[0]
    }

    if (!term || !MEME_ON || !home || searched >= 2) break

    searched += 1
    const learned = learnTerm(home, term, { top: 4, comments: true })
    // 搜不到就直说：把标记剥掉，让她按「不知道」正常回，别反复搜同一个词
    if (!learned.ok) {
      out = stripRoleWords(out.replace(SEARCH_TAG, '')).trim()
      if (out) break
      // 模型只输出了标记、什么都没说 → 给第二轮一次机会，明确告诉它搜不到
      msgs.push({ role: 'assistant', content: m ? m[0] : '（不知道这个词）' })
      msgs.push({
        role: 'user',
        content: `（系统：搜了「${term}」，抖音上也没有能用的解释。`
          + '那就照不知道来答——别硬编，也别再报 [[SEARCH]]。）',
      })
      continue
    }

    const blk = learned.via === 'web'
      ? buildWebEvidenceBlock(term, { answer: learned.answer })
      : learned.via === 'web-titles'
        ? buildWebEvidenceBlock(term, { titles: learned.titles })
        : buildEvidenceBlock(term, learned.items)
    msgs.push({ role: 'assistant', content: out })
    msgs.push({
      role: 'user',
      content: (learned.meaning ? `（系统：「${term}」查到的是——${learned.meaning}。\n` : '')
        + (blk ? blk.replace(/^\n+/, '') + '\n' : '')
        + (learned.weak
          // 只搜到标题、没有释义（`via:web-titles`）：别装作懂了，
          // 但确实能确定「这是一句网络黑话 / 这个人在说某个具体的东西」，
          // 就照这个语气接，不许编具体含义。
          ? `现在照这个，把刚才那句话重新答一遍。只弄清「${term}」是个什么性质的说法，`
            + '具体含义没查到就别编；一句话，别再报 [[SEARCH]]。）'
          : '现在照这个，把刚才那句话重新答一遍。一句话，别再报 [[SEARCH]]。）'),
    })
  }

  finalText = stripRoleWords(out.replace(SEARCH_TAG, '').replace(MEME_TAG, '')).trim()
  if (!finalText) return { ok: false, error: 'empty_completion', ms: Date.now() - t0 }
  return { ok: true, text: finalText, model, ms: Date.now() - t0, usage: lastUsage }
}

function honorific_default() {
  return '主人'
}
