/**
 * lib/meme.mjs —— 梗库（她不认识的词，搜过一次就记住）
 * ============================================================================
 * 为什么要有这一层：
 *   2026-10-27 群里有人问「灭建国是谁」，她回「？谁啊，没听过」，第二次被解释
 *   之后还是答「这真不知道」。使用者说「不要是要求去搜再去搜，而是不认识就去搜」。
 *
 *   光靠临时搜也不行：同一个梗每次都要搜 2 秒，而且搜完就忘。所以配一个本地库，
 *   搜到就写进来，下次同一个词直接命中，0 延迟。
 *
 * 存储：`<home>/memory/memes.json`
 *   {
 *     "updatedAt": "...",
 *     "items": {
 *       "灭建国": {
 *         "term": "灭建国",
 *         "meaning": "灭霸他爸（漫威二创梗，把灭霸家的中文名按年代感起成建国/援朝这一路）",
 *         "source": "dy-search",        // dy-search | manual | model
 *         "evidence": "灭霸 → 灭建国 浩克 → 浩志强 钢铁侠→ 刚卫国 ...",
 *         "hits": 3,
 *         "at": "2026-10-27T15:40:00.000Z"
 *       }
 *     }
 *   }
 *
 * 上限 `MAX_MEMES = 400`：一条约 200 字节，400 条约 80 KB，按 `hits` 低优先淘汰。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MAX_MEMES = 400
/** 一个词最多记几个别称（方言变体、谐音写法、打错的形式） */
const MAX_ALIASES = 8
const MAX_MEANING = 200
const MAX_EVIDENCE = 200

const nowIso = () => new Date().toISOString()

const memesFile = (home) => join(home, 'memory', 'memes.json')

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, v) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
  } catch { /* 目录已存在 */ }
  try { writeFileSync(file, JSON.stringify(v, null, 1), 'utf8'); return true } catch { return false }
}

/** 归一化：去空白、去引号、全角转半角、小写（英文缩写大小写不敏感）。 */
export function normTerm(s) {
  return String(s || '')
    .replace(/[\s"'“”‘’「」『』（）()【】\[\]，,。.、:：;；!！?？~～]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .slice(0, 24)
}

/** 读整个库。读不到就当空库 —— 梗库坏了不能影响回话。 */
export function loadMemes(home) {
  const j = readJson(memesFile(home), null)
  if (!j || typeof j !== 'object' || !j.items || typeof j.items !== 'object') {
    return { updatedAt: '', items: {} }
  }
  return j
}

/** 查一个词。命中会把 `hits` +1（用于淘汰排序），不命中返回 null。 */
export function lookupMeme(home, term) {
  const key = normTerm(term)
  if (!key) return null
  const db = loadMemes(home)
  const hit = db.items[key]
  if (!hit) return null
  hit.hits = (Number(hit.hits) || 0) + 1
  writeJson(memesFile(home), db)
  return hit
}

/**
 * 写一条梗。
 *
 * @param {object} o
 * @param {string} o.term     梗本身（保留原文，索引用 normTerm）
 * @param {string} o.meaning  一句话解释（这是给模型看的，要具体）
 * @param {string} [o.source] 'dy-search' | 'manual' | 'model'
 * @param {string} [o.evidence] 证据（搜索结果里的原句 / 评论）
 * @returns {{ok:boolean, term?:string, replaced?:boolean, total?:number}}
 */
export function addMeme(home, { term = '', meaning = '', source = 'manual', evidence = '', aliases = [] } = {}) {
  const raw = String(term || '').trim().slice(0, 24)
  const key = normTerm(raw)
  const mean = String(meaning || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MEANING)
  if (!key || !mean) return { ok: false, error: 'term/meaning 不能为空' }

  const db = loadMemes(home)
  const prev = db.items[key]
  const replaced = Boolean(prev)
  // C 层：别称。传进来的 + 上次留的都留，去重、只收长度 >= 2 的
  const al = Array.from(new Set(
    [...(Array.isArray(aliases) ? aliases : []), ...(Array.isArray(prev?.aliases) ? prev.aliases : [])]
      .map((x) => String(x || '').trim().slice(0, 24))
      .filter((x) => normTerm(x).length >= 2 && normTerm(x) !== key)
  )).slice(0, MAX_ALIASES)
  db.items[key] = {
    term: raw || prev?.term || '',
    meaning: mean,
    source: String(source || 'manual').slice(0, 16),
    evidence: String(evidence || prev?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE),
    hits: Number(prev?.hits) || 0,
    at: nowIso(),
    ...(al.length ? { aliases: al } : {}),
  }

  // 超上限：按 hits 升序、同 hits 按时间旧的先丢
  const keys = Object.keys(db.items)
  if (keys.length > MAX_MEMES) {
    keys.sort((a, b) => {
      const ha = Number(db.items[a].hits) || 0
      const hb = Number(db.items[b].hits) || 0
      if (ha !== hb) return ha - hb
      return String(db.items[a].at || '').localeCompare(String(db.items[b].at || ''))
    })
    for (const k of keys.slice(0, keys.length - MAX_MEMES)) delete db.items[k]
  }

  db.updatedAt = nowIso()
  writeJson(memesFile(home), db)
  return { ok: true, term: raw, replaced, total: Object.keys(db.items).length }
}

/**
 * 从一段话里挑「可能是梗」的候选。
 *
 * 只做**候选筛查**，判定交给模型 —— 规则不可能判断「扎啤的」「灭建国」这种
 * 到底是生造词还是打错字。规则的价值是**把每次要问模型的候选压到 3 个以内**，
 * 不然每句话都要问一遍太贵。
 *
 * 命中规则（任一）：
 *   ① 2~6 个连续拉丁字母（yqp / yyds / nbcs）—— 缩写是梗的高发区
 *   ② 引号/书名号里的 2~12 字
 *   ③ 已被 @ 的名字
 *   ④ 2~5 个汉字，且**不在常用词表**里（用「看起来像专名」的弱规则：
 *      含「建/灭/霸/神/仙/魔/妖/帝/王/爷/哥/姐/佬/仔/酱」这类构词字，
 *      或三个字以上且不含任何虚词）
 */
/**
 * 在一段话里找**梗库里已经有的词**（精确命中）。
 *
 * 这是最可靠的一条路径：库里存了什么，就在文本里找什么，没有猜测。
 * 用它替代模糊的「猜哪个词像梗」—— 猜错的代价是要么白搜、要么漏搜。
 */
export function findKnownMemes(home, text) {
  const s = normTerm(text)
  if (!s) return []
  const db = loadMemes(home)
  const hits = []
  for (const [k, v] of Object.entries(db.items)) {
    if (!k || k.length < 2) continue
    if (s.includes(k)) { hits.push(v); continue }
    /**
     * C 层：按**别称**命中。
     *
     * 例：库里 `扎啤` 的 aliases 里写着 `杂皮`、`杂痞`，那么「你就是个杂皮」也能命中
     * 扎啤那条。这条的价值在于 —— 群友不会总和她说同一个写法，同一个意思有七八种
     * 打错、谐音、方言变体，靠精确匹配会一直漏。
     *
     * 只认长度 >= 2 的别称（单字别称误伤太狠，比如「鱼」能命中半边天）。
     */
    const al = Array.isArray(v.aliases) ? v.aliases : []
    if (al.some((a) => { const n = normTerm(a); return n.length >= 2 && s.includes(n) })) hits.push(v)
  }
  // 长词优先（「灭建国他爸」里应该先命中「灭建国」而不是更短的）
  hits.sort((a, b) => normTerm(b.term).length - normTerm(a.term).length)
  if (hits.length) {
    let touched = false
    for (const h of hits) {
      const k = normTerm(h.term)
      if (db.items[k]) { db.items[k].hits = (Number(db.items[k].hits) || 0) + 1; touched = true }
    }
    if (touched) { db.updatedAt = nowIso(); writeJson(memesFile(home), db) }
  }
  return hits
}

/**
 * 从一段话里挑「可能是梗」的候选 —— **只作为兜底**。
 *
 * 主力是模型自己报（它读到不认识的词会输出 `[[SEARCH:词]]`，见 lib/persona-llm.mjs）。
 * 这个函数只在模型没报、但话里明显有个怪词时补一刀。
 *
 * 因此规则刻意收得很紧：宁可漏，不可乱搜（白搜一次要 2 秒，还会污染梗库）。
 * 只收三类：拉丁缩写、引号/书名号里的、含年代梗/题材构词字的汉字词。
 */
const STOP = new Set([
  '什么', '怎么', '为什么', '这个', '那个', '我们', '你们', '他们', '现在', '时候',
  '可以', '知道', '不知', '不是', '就是', '还是', '真的', '一下', '一起', '这样',
  '那样', '因为', '所以', '但是', '如果', '然后', '已经', '自己', '别人', '东西',
])

const SEP = /[的是谁吗啊吧呢个你我他她它那这在有不就都也还会要能去来说道看想着过被把给让和对很太又再只已经请嘛哦噢呀哈]/

/** 这些字出现在词里，几乎可以肯定是生造/年代梗，值得搜。 */
const FANCY = /[灭霸神仙魔妖帝王爷哥姐佬仔酱建国援朝卫国建军]/

export function pickCandidates(text, { max = 2 } = {}) {
  const s = String(text || '')
  const out = []
  const seen = new Set()
  const push = (w) => {
    const t = String(w || '').trim()
    if (!t) return
    const k = normTerm(t)
    if (!k || k.length < 2 || seen.has(k) || STOP.has(t)) return
    if (/小鲸鱼/.test(t)) return          // 自己的名字不是梗
    seen.add(k)
    out.push(t)
  }

  // ① 拉丁缩写（yqp / yyds / nbcs）
  for (const m of s.matchAll(/(?<![A-Za-z])[A-Za-z]{2,6}(?![A-Za-z])/g)) push(m[0])
  // ② 引号/书名号里的
  for (const m of s.matchAll(/[「『"“]([^」』"”]{2,12})[」』"”]/g)) push(m[1])
  // ③ 含构词字的汉字词（先按虚词切段，避免「灭建国是谁」整段被吞）
  for (const seg of s.split(SEP)) {
    const w = String(seg || '').replace(/[^\u4e00-\u9fff]/g, '')
    if (w.length < 2 || w.length > 6) continue
    if (STOP.has(w)) continue
    if (FANCY.test(w)) push(w)
  }

  return out.slice(0, max)
}

/**
 * 短句实词兜底 —— 专治「你扎啤吧」这类**两三个字的骂人话 / 黑话**。
 *
 * 为什么 `pickCandidates` 抓不到它们（2026-10-28 实测）：
 *   `pickCandidates('你扎啤吧')` → `[]`
 *   `pickCandidates('@小鲸鱼 你麻痹')` → `[]`
 *   `pickCandidates('就是个飞舞@小鲸鱼')` → `[]`
 * 因为规则③要求词里含「灭/霸/神/仙/帝/王/爷…」这类年代梗构词字，
 * 而「扎啤 / 麻痹 / 飞舞」一个字都不含。那套字表是照着「灭建国」写的，
 * 覆盖不到**口语里骂人的那批词**——恰恰是群里最常出现、最该查的一批。
 *
 * 所以补一条：**很短的话（≤12 个汉字）里，剩下的实词段本身就是候选**。
 * 短句里几乎没有「正常长词」，虚词切完剩下的 2~4 字基本就是那个怪词：
 *   「你扎啤吧」   → 切出 扎啤      ✅
 *   「你麻痹」     → 切出 麻痹      ✅
 *   「就是个飞舞」 → 切出 飞舞      ✅
 *
 * 噪音的代价是白搜一次（2 秒），漏搜的代价是**装懂答错人**。
 * 这个不对称是使用者定的：「不要是要求去搜再去搜，而是不认识就去搜」。
 *
 * ⚠️ 但噪音必须压到低（否则每句闲聊都搜一次，还会污染梗库）。两道过滤：
 *   ① `DAILY` —— 日常句的常见组合（今天天气 / 咋了找 / 条鱼好得…）
 *   ② **常见字比例闸** —— 候选词里如果全是超高频字（的/好/得/天/气…），
 *      那它不是黑话，是拼接出来的普通短语。
 *
 * @returns {string[]} 按「越像怪词越靠前」排好
 */
const DAILY = /^(今天|明天|昨天|天气|时间|早上|中午|晚上|下午|现在|刚才|咋了|怎么|什么|为啥|好的|行吧|可以|没事|谢谢|哈哈|呵呵|真的|确实|知道|不知|感觉|觉得|好像|应该|可能|已经|还是|就是|不是|这样|那样|一起|自己|别人|东西|事情|问题|地方|时候|吃饭|睡觉|上班|下班|上课|回家|出门|多少钱|多少|几个|哪个|哪里|干嘛|干啥|咋办|要不要|能不能|会不会|有没有|是不是|对不对|好不好)/

/** 超高频字：一个词里全是这些字，基本是日常短语而不是黑话。 */
const COMMON_CHARS = new Set(('的一是不了在人有我他这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会' +
  '家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同' +
  '日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文' +
  '几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海' +
  '受听表德少克代员许稜先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入' +
  '笑内英军候民岁往何度山觉路带万男边风解叫任金快原满呀呢吧啊嘛哦噢嗯哈呵嘿唉哎喂喔咯啦嘞').split(''))

function looksDaily(w) {
  if (DAILY.test(w)) return true
  const chars = [...w]
  const common = chars.filter((c) => COMMON_CHARS.has(c)).length
  // 全是最常见字 ⇒ 日常短语；留一个口子：含 FANCY 构词字的仍算候选
  if (!FANCY.test(w) && common === chars.length) return true
  return false
}

export function pickShortTerms(text, { max = 2, maxHan = 12 } = {}) {
  const s = String(text || '').replace(/@[^\s，,。]+/g, ' ')
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length
  if (!han || han > maxHan) return []

  const scored = []
  for (const seg of s.split(SEP)) {
    const w = String(seg || '').replace(/[^\u4e00-\u9fff]/g, '')
    if (w.length < 2 || w.length > 4) continue
    if (STOP.has(w)) continue
    if (/小鲸鱼/.test(w)) continue
    if (looksDaily(w)) continue
    let sc = 0
    if (FANCY.test(w)) sc += 3
    if (w.length >= 3) sc += 1          // 三字实词更少见
    // 含生僻字的更像黑话（「扎啤」「麻痹」「飞舞」里的字都不在超高频表里）
    const rare = [...w].filter((c) => !COMMON_CHARS.has(c)).length
    sc += Math.min(2, rare)
    scored.push({ w, sc })
  }
  scored.sort((a, b) => b.sc - a.sc)
  const out = []
  const seen = new Set()
  for (const { w } of scored) {
    const k = normTerm(w)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(w)
    if (out.length >= max) break
  }
  return out
}

/**
 * 把梗库拼成 prompt 片段。没有可用的就返回 ''。
 *
 * 🔴 2026-10-28 实测：**释义不能整段塞，而且要「前后各说一次」**。
 *
 * 搜狗对「扎啤」给了一段 300 字解释，整段拼进去之后，模型对着「你扎啤吧」
 * 照旧回「你才扎啤呢，我这条鱼清醒得很」——长文反而让它只看见「啤酒」。
 * 压成一句后仍然不行（还是照字面接）。最后是**手动把同一段塞两遍**才成功：
 *   → 「你才杂皮呢 我尾巴拍你一下」
 * 说明这个模型对「只在前面提一次的背景」注意力不够，必须**贴着用户那句话再提醒一次**。
 *
 * 所以输出两段：前面给释义，后面给一句极短的复述（只留「词 = 核心义」），
 * 由调用方拼成 `note + 原文 + tail` 的形状（见 `splitMemeNote`）。
 */
export function renderMemeNote(memes, { max = 6 } = {}) {
  const rows = (Array.isArray(memes) ? memes : []).filter((m) => m && m.meaning)
  if (!rows.length) return ''
  /**
   * 🔴 2026-10-28 实测：这里**不能写任何指令性的话**。
   *
   * 上一版在这拼了一段 200 字的「🔴 读懂意思再回……把骂人的话当成啤酒/飞舞/麻痹
   * 去接 = 当场显蠢」，还顺手把「啤酒」「飞舞」「麻痹」当成反例写进了 prompt。
   * 结果实测三连全错：「你才扎啤，我这条鱼好得很」×3。
   *
   * 原因很清楚 ——
   *   ① 两个互相竞争的信号：这段说「别按字面」，却又在 prompt 里塞了「啤酒」这个词，
   *      模型读到的是「扎啤≈啤酒」这个更强的关系；
   *   ② 200 字的元信息在长上下文里被当成注释扫过去，权重极低。
   *
   * 所以这里改成**只陈述事实、不下指令**：库里有这个词、它是这么解的。
   * 「要怎么用它」全部交给 `splitMemeNote` 那个短后贴（那才是实测有效的形态）。
   */
  const lines = rows.slice(0, max).map((m) => `- ${m.term}：${condenseMeaning(m.meaning)}`)
  return '\n\n（你以前查过这些词，记的是：\n' + lines.join('\n') + '）'
}

/**
 * 把 `renderMemeNote` 的结果拆成「前垫」和「后贴」两块。
 *
 * 🔴 2026-10-28 实测（这条是整件事的关键）：
 *
 * 同一句「你扎啤吧」，喂不同长度的提示，结果完全不同：
 *   ✗ 300 字搜狗原文（含「谐音空耳」「常见用法」「AI生成仅供参考」）
 *       → 「你才扎啤呢，我这条鱼清醒得很」      ← 只看见「啤酒」
 *   ✗ 114 字压缩版（带「读懂意思再回」「当场显蠢」这套指令）
 *       → 「你才扎啤！」                        ← 还是照字面
 *   ✅ 「「扎啤」在群里是骂人话，指的是人不行，不是啤酒」
 *       → 「骂人别用我不认识的词啊 我这条鱼泡在水里好好的」  ← 通了
 *
 * 结论：**模型吃不下长背景，只吃短直白的「这词=什么性质」**。
 * 所以后贴那块不再复述释义原文，只给「性质判断」：
 *   骂人 / 夸人 / 称呼 / 作品名 / 梗 —— 这五类足以让它决定怎么接。
 *
 * 顺带：`「扎啤」` 里的中文书名号会让某些 provider 的模板解析出问题
 * （实测两次返回 undefined），所以这里去掉引号，直接写词。
 */
const KIND_RULES = [
  { re: /(骂人|脏话|贬义|侮辱|讽刺|嘲|讥|看不起|不行|无能|废物|杂皮|杂痞|傻|蠢|丑)/, tag: '是骂人的话，意思是说对方不行' },
  { re: /(夸|赞|厉害|优秀|牛|棒|强)/, tag: '是夸人的话' },
  { re: /(谐音|空耳)/, tag: '是谐音梗，实际意思是骂人或调侃' },
  { re: /(称呼|外号|绰号|代指|指的是某)/, tag: '是一个称呼 / 外号' },
  { re: /(名|作品|电影|剧|歌|游戏|主播|角色)/, tag: '是一个作品或人物的名字' },
]

/** 「这词是什么性质」，一句话，≤20 字。 */
export function kindOf(meaning) {
  const s = String(meaning || '')
  for (const r of KIND_RULES) if (r.re.test(s)) return r.tag
  return '是个网络用语，不是字面意思'
}

/**
 * 「这词的字面意思是什么」—— 只用来拼「不是 X」那半句。
 *
 * 为什么需要：实测发现模型对黑话有很强的**字面先验**（扎啤→啤酒、飞舞→飞舞、
 * 麻痹→麻木），只告诉它「这是骂人的」有 2/3 概率仍照字面接话。必须明写
 * 「不是啤酒」才能切断那条联想。
 *
 * 做法简单粗暴但够用：从释义原文里找「并非指 X」「不是 X」抽出来；抽不到就
 * 用一个覆盖面很广的兜底词。宁可说「不是字面那个意思」也不要留空。
 */
export function literalOf(term) {
  const t = String(term || '').trim()
  return t ? `字面那个${t}` : '字面意思'
}

export function splitMemeNote(note, memes, { max = 3 } = {}) {
  const head = String(note || '')
  const rows = (Array.isArray(memes) ? memes : []).filter((m) => m && m.meaning)
  if (!rows.length) return { head, tail: '' }
  const pairs = rows.slice(0, max).map((m) => `${m.term} ${kindOf(m.meaning)}`)
  /**
   * 🔴 2026-10-28 实测：**不能带括号、不能带等号**。
   *
   * 同一句「你扎啤吧」，后贴三种写法：
   *   ✗ `你扎啤吧（扎啤=骂人话，说人不行，不是啤酒）`  → 「你才扎啤，我这条鱼好得很」 照字面
   *   ✗ `你扎啤吧（不是啤酒，是骂人）`                    → 同上
   *   ✓ `你扎啤吧 这儿扎啤是骂人的`                       → 「就是句骂人的话呗 我又不往心里去」
   *
   * 加了括号 / 等号，模型就当它是**元信息**、扫一眼不算正文；写成纯中文断句，
   * 它才当内容读。所以这里一律用空格接、不用任何括号符号。
   *
   * 另外还差最后一步：只写「是骂人的」模型仍有 2/3 概率照字面回，必须**明写否定**
   * ——「不是啤酒」。那个否定词才是切断字面联想的开关（对比上面第一条和第三条）。
   */
  const pairs2 = rows.slice(0, max).map((m) => {
    if (kindOf(m.meaning) === '是骂人的话，意思是说对方不行') return `${m.term}是骂人的`
    return `${m.term}不是字面意思`
  })
  const tail = '　' + pairs2.join('，') + ''
  return { head, tail }
}

/**
 * 把一段释义压成「第一句」。
 *
 * 实测样本（搜狗对「扎啤」）：
 *   原文 300 字 → 压成「网络热梗"扎啤"并非指啤酒，而是西南方言"杂皮"（或"杂痞"）的谐音"空耳"」
 * 这一句已经够用了：知道它是谐音、不是啤酒，就知道对方在骂人。
 * 后面的「常见用法 / 整活反话 / AI生成仅供参考」对回话毫无帮助，只会稀释注意力。
 */
export function condenseMeaning(meaning, maxChars = 60) {
  let s = String(meaning || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // 先剥掉明显是壳的尾巴
  s = s.replace(/AI生成.{0,10}$/, '').replace(/仅供参考.{0,10}$/, '').trim()
  // 取第一句（句号/分号/感叹号都算断句，顿号不算）
  const first = s.split(/[。；;！!]/)[0].trim()
  s = first || s
  if (s.length > maxChars) s = s.slice(0, maxChars).replace(/[，,、]$/, '') + '…'
  return s
}
