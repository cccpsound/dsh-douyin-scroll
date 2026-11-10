/**
 * lib/memelearn.mjs —— 遇到不认识的词，自己去抖音搜一次，学会就存进梗库
 * ============================================================================
 * 起因（使用者原话，2026-10-27）：
 *   「不要是要求去搜再去搜，而是不认识就去搜」
 *   「顺便给抖音的那个接入梗库 让她可以加入梗词和读取梗库」
 *
 * 现场证据（群里实录）：
 *   dwc：灭建国是谁@小鲸鱼     → 她：？谁啊，没听过
 *   dwc：那是灭霸他爸，你个扎啤的这都不知道 → 她：？谁啊，没听过（同一句发了两遍）
 *   有人：去学习梗,你不接入抖音了吗,去抖音搜 → 她：我搜不了抖音啊，别为难我
 *
 * 所以这条链路要成立三件事：
 *   ① 她**自己发现**不认识（靠模型自报 `[[SEARCH:词]]`，规则只做兜底）
 *   ② 搜到的东西**落库**（lib/meme.mjs），下次同一个词 0 延迟命中
 *   ③ 搜完**再答一遍**，答的时候用证据、但绝不提「我搜了一下」
 *
 * 这里只做 ②③ 的「搜 + 提炼」；①放在 lib/persona-llm.mjs 里，因为它需要
 * 拼进模型对话，属于 prompt 层。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { addMeme, lookupMeme, normTerm } from './meme.mjs'

const ROOT = join(import.meta.dirname, '..')
const TAGS = /[#＃][^\s#＃]+/g

/** 插件自带的 venv 优先（curl_cffi 只装在那里）。 */
function pyExe(home) {
  const v = join(home || join(homedir(), '.dsh', 'douyin-duty'), '.venv',
    process.platform === 'win32' ? 'Scripts/pythonw.exe' : 'bin/python')
  if (existsSync(v)) return v
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 剥掉话题标签和 @，压空白。 */
function plain(s, max = 160) {
  return String(s || '')
    .replace(TAGS, '')
    .replace(/@[^\s，,。]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 跑一次抖音搜索。永不 throw。
 * @returns {{ok:boolean, items:Array, error?:string}}
 */
export function dySearch(home, term, { top = 4, comments = true, timeout = 25_000 } = {}) {
  const q = String(term || '').trim()
  if (!q) return { ok: false, items: [], error: 'empty_term' }
  const args = [join(ROOT, 'tools', 'dy-search.py'), '--q', q, '--top', String(top)]
  if (comments) args.push('--comments')
  let r
  try {
    r = spawnSync(pyExe(home), args, {
      encoding: 'utf8', timeout,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_HOME: home || '' },
      cwd: home && existsSync(home) ? home : ROOT,
      windowsHide: true,
    })
  } catch (e) {
    return { ok: false, items: [], error: 'spawn: ' + String(e?.message || e).slice(0, 100) }
  }
  const out = String(r?.stdout || '')
  const a = out.indexOf('{')
  const b = out.lastIndexOf('}')
  if (a < 0 || b <= a) {
    return { ok: false, items: [], error: 'no_json: ' + String(r?.stderr || '').slice(0, 100) }
  }
  try {
    const j = JSON.parse(out.slice(a, b + 1))
    if (!j.ok) return { ok: false, items: [], error: String(j.error || 'search_failed') }
    return { ok: true, items: Array.isArray(j.items) ? j.items : [], total: j.total || 0 }
  } catch {
    return { ok: false, items: [], error: 'bad_json' }
  }
}

/**
 * 从搜索结果里提炼「这个词是什么意思」。
 *
 * 不调模型：一次搜索 2 秒、再调模型又是 2 秒，而这一层的目标只是
 * 「下次能想起来」，粗糙但准确的原句比精炼但可能编造的释义更安全。
 * 真需要理解的时候，`buildEvidenceBlock` 会把原文也一起给模型看。
 *
 * 🔴 相关性硬闸（2026-10-27 实测踩过）：
 *   搜索是有**误召回**的。「扎啤的」搜出来第一条是「你就是想发这吊歌」，
 *   评论是「手机掉床缝听了一晚上」——跟「扎啤的」毫无关系；
 *   「yqp」搜出来是教师节段子。把这种结果当释义存进库，比不存更糟：
 *   下次她会拿一个错答案一本正经地答人。
 *   所以：**标题或评论里必须真的出现这个词（归一化后子串匹配），否则不入库。**
 *
 * @returns {{meaning:string, evidence:string}|null}
 */
export function distill(term, items) {
  const want = normTerm(term)
  const rows = (Array.isArray(items) ? items : []).filter((x) => x && x.desc)
  if (!rows.length || !want) return null

  /** 这条结果是否真的在说这个词。 */
  const relOf = (x) => {
    const bag = [x.desc, ...(Array.isArray(x.top_comments) ? x.top_comments.map((c) => c.text) : [])]
      .join(' ')
    return normTerm(bag).includes(want)
  }

  const hitRows = rows.filter(relOf)
  // 只有一条擦边命中时信息量太低，容易是巧合
  if (hitRows.length < 2) return null

  /**
   * ⚠️ `cores` 必须是**标题自己就含这个词**的那些。
   *
   * 原来写的是 `hitRows.map((x) => plain(x.desc, 90))` —— 只要这条 item 的
   * desc + 评论合起来含 want 就算命中，于是 desc 本身无关的也会进来。
   * 实测「哈基米」搜出的三条标题是：
   *   「哈基米居然能衍生出这么多首歌，全听过的可以把手机扔了」
   *   「哈基米有啥烦恼呀，就只是想扒拉点东西 王八：你清高」
   *   「为什么对我哈气」                    ← 标题里根本没有这个词
   * 第三条能进来，是因为它的**评论区**在刷「哈基米」。这种标题喂给模型
   * 只会误导（她得猜「哈气」和「哈基米」什么关系）。
   */
  const cores = hitRows
    .map((x) => plain(x.desc, 90))
    .filter((c) => c && normTerm(c).includes(want))
  const cmts = []
  for (const x of hitRows) {
    for (const c of (Array.isArray(x.top_comments) ? x.top_comments : [])) {
      const t = plain(c.text, 90)
      // 评论本身也得跟这个词有关，否则是路人的无关发言
      if (t && t.length >= 5 && normTerm(t).includes(want)) cmts.push(t)
    }
  }

  /**
   * 挑「信息量最大」的那条评论：评论比标题有用得多
   * （标题常常只有「XX是谁」，评论里才有「他爸叫XX」「这是整套改名梗」）。
   * 打分：含解释性词 + 长度适中 + 多个顿号/箭头（列举型往往是知识点）。
   */
  const scored = cmts.map((t) => {
    let sc = 0
    if (/叫|就是|意思是|指的是|原名|全名|梗/.test(t)) sc += 3
    if (t.length >= 20 && t.length <= 80) sc += 2
    if ((t.match(/[、→\-—]/g) || []).length >= 2) sc += 2
    /**
     * ⭐ 直接定义 > 列举（2026-10-27 实测）。
     *
     * 「灭建国」搜出来两条高分评论：
     *   A: 「灭霸的爸爸叫灭建国」            ← 这就是答案
     *   B: 「灭霸 → 灭建国 浩克 → 浩志强 …」  ← 名单，反映「整套改名」但没回答是谁
     * 只按长度+箭头打分时 B 得 7、A 得 3，于是释义存成了名单，
     * 下次她拿一串人名去答「灭建国是谁」。
     * 所以给「叫/就是/是 + 这个词本身」这种**直接定义句式**额外 +5，
     * 让 A 拿到 8 压过 B 的 7。名单仍留在 evidence 里给模型看。
     */
    const tight = t.replace(/\s+/g, '')
    if (new RegExp('(?:叫|就是|是|指的是|全名)' + want).test(tight)) sc += 5
    return { t, sc }
  }).sort((x, y) => y.sc - x.sc)

  /**
   * 门槛必须够硬：sc >= 3 意味着**必须含解释性词**（叫/就是/意思是…）。
   *
   * 实测踩过：只要求 `sc > 0` 时，「灭霸」搜出来的最佳评论是
   * 「看了几期我发现灭霸是真老实人，复仇者真是私了老封了」——它确实在说灭霸，
   * 也确实有点长度（+2 分），但对「灭霸是谁」毫无解释力。存进去以后
   * 她就会拿这句当答案去答人，比不认识更糟。
   */
  const best = (scored.length && scored[0].sc >= 3) ? scored[0].t : ''

  /**
   * 标题常常只是提问（「灭建国是谁」），本身没有解释力，但含解释词的可以留。
   */
  const head = cores.find((c) => /叫|就是|意思是|指的是|原来|其实/.test(c)) || ''

  /**
   * 🔴 「出现」不等于「解释」（2026-10-28 实测，这条很重要）。
   *
   * 「扎啤」搜抖音，hitRows 凑够了 2 条、标题也含「扎啤」，于是被判合格，
   * 存下来的释义是「『你就是想发这吊歌.』」——那是有人在评论区骂人，
   * 跟「扎啤」这个词毫无关系。抖音里搜任何骂人词都能捞到一堆文案，
   * 只要带了这三个字就过闸，所以必须再加一道：**得像个释义**。
   *
   * 释义的样子：`X就是…` / `X的意思是…` / `X指的是…` / `X是…的谐音` /
   * `X叫…` / `…叫X` / 句子里带「梗/黑话/骂人/缩写/代指」。
   * 一条都没有 ⇒ 抖音这条路认输，返回 null 让 learnTerm 去走网页搜索。
   */
  const looksLikeDef = (t) => {
    const tight = String(t || '').replace(/\s+/g, '')
    if (!tight) return false
    if (new RegExp('(?:' + want + '\\s*(?:就是|就是|的意思是|意思就是|意思是|指的是|指|是|叫|叫做|简称|俗称|的全名|原名))').test(tight)) return true
    if (new RegExp('(?:叫|就是|意思是|指的是|全名是|原名)' + want).test(tight)) return true
    if (/(梗|黑话|网络用语|流行语|谐音|缩写|代指|骂人|脏话|空耳)/.test(tight)) return true
    return false
  }
  const headOk = head && looksLikeDef(head) ? head : ''
  const bestOk = best && looksLikeDef(best) ? best : ''

  /**
   * ⚠️ 两个都不像释义 ⇒ **不入库**。
   *
   * 曾写过「抖音上常看到『标题』这类说法（没搜到明确解释）」这种兜底 ——
   * 那是零信息，占库位还会让下次误以为「已经会了」。
   * 不入库不影响当场回答：`buildEvidenceBlock` 照样把原文给模型看。
   *
   * 🔴 2026-10-28 修：原来是直接 `return null`，结果「哈基米」这种词
   * 抖音明明有 18 条结果（最高赞 120 万）、`hitRows` 也够，却因为没人
   * 写「哈基米就是…」被判 null，`learnTerm` 只好退到搜狗 —— 而搜狗对
   * 这类词给的是完全不相干的标题。**「搜到了大量相关内容」本身就是有效
   * 信息**，不该被丢掉。
   *
   * 所以现在返回一个 `weak` 结果：不入库（避免污染梗库），但把标题和
   * 评论原话带出去，让调用方拼进 prompt 当线索。这比什么都没有强得多 ——
   * 模型看到「哈基米居然能衍生出这么多首歌」「#哈基米 #哈基米音乐 #曼波」
   * 就能判断这是首网络神曲的名字，不需要一句教科书式定义。
   */
  if (!headOk && !bestOk) {
    const titles = cores.slice(0, 3)
    const sample = cmts.slice(0, 3)
    if (!titles.length && !sample.length) return null
    return { meaning: '', evidence: '', weak: true, titles, comments: sample }
  }

  let meaning = ''
  if (headOk) meaning += `抖音上说的「${headOk}」`
  if (bestOk) meaning += (meaning ? '；评论里说「' : '抖音的评论里说「') + bestOk + '」'
  meaning = meaning.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!meaning) return null

  const ev = [cores.slice(0, 2).join(' / '), cmts.slice(0, 3).join(' / ')]
    .filter(Boolean).join(' ｜ ').slice(0, 200)

  return { meaning, evidence: ev }
}

/**
 * 跑一次网页搜索（tools/web-search.py）。永不 throw。
 *
 * 为什么要有这条路（2026-10-27 群里实录）：
 *   有人骂「你扎啤吧」，她去抖音搜，搜出来的是「你就是想发这吊歌」——
 *   **抖音擅长「发生了什么」「谁是谁」，不擅长词义和黑话**。
 *   换搜狗之后拿到了「西南方言"杂皮"的谐音，带贬义，指品行不端或行为出丑的人」，
 *   这才叫查到了。分工写死在两个脚本头部注释里。
 *
 * @returns {{ok:boolean, answer?:string, items?:Array, error?:string}}
 */
export function webSearch(home, term, { top = 5, timeout = 30_000 } = {}) {
  const q = String(term || '').trim()
  if (!q) return { ok: false, answer: '', items: [], error: 'empty_term' }
  let r
  try {
    r = spawnSync(pyExe(home), [join(ROOT, 'tools', 'web-search.py'), '--q', q, '--top', String(top)], {
      encoding: 'utf8', timeout,
      env: {
        ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        DOUYIN_DUTY_HOME: home || '',
      },
      cwd: home && existsSync(home) ? home : ROOT,
      windowsHide: true,
    })
  } catch (e) {
    return { ok: false, answer: '', items: [], error: 'spawn: ' + String(e?.message || e).slice(0, 100) }
  }
  const out = String(r?.stdout || '')
  const a = out.indexOf('{')
  const b = out.lastIndexOf('}')
  if (a < 0 || b <= a) {
    return { ok: false, answer: '', items: [], error: 'no_json: ' + String(r?.stderr || '').slice(0, 100) }
  }
  try {
    const j = JSON.parse(out.slice(a, b + 1))
    if (!j.ok) return { ok: false, answer: '', items: [], error: String(j.error || 'search_failed').slice(0, 120) }
    return {
      ok: true,
      answer: String(j.answer || '').trim(),
      items: Array.isArray(j.items) ? j.items : [],
      engine: j.engine || '',
      cached: !!j.cached,
    }
  } catch {
    return { ok: false, answer: '', items: [], error: 'bad_json' }
  }
}

/**
 * 学一个词：查库 → 抖音搜 → 提炼 → 落库；抖音不成再走网页。
 *
 * 为什么抖音排前面：它给的是**这个圈子怎么说这个词**（评论原话），
 * 对「灭建国」「塔菲」这类人名词条最准。网页搜索只有对**通用黑话**
 * （扎啤 / yyds / 飞舞）才更强，所以放在第二道。
 *
 * @returns {{ok:boolean, cached?:boolean, via?:string, term?:string, meaning?:string, items?:Array, answer?:string, error?:string}}
 */
export function learnTerm(home, term, opts = {}) {
  const raw = String(term || '').trim().slice(0, 24)
  const key = normTerm(raw)
  if (!key) return { ok: false, error: 'empty_term' }

  const hit = lookupMeme(home, raw)
  if (hit) return { ok: true, cached: true, via: 'library', term: hit.term, meaning: hit.meaning, items: [] }
  if (opts.noSearch) return { ok: false, error: 'not_in_library' }

  // ① 抖音：擅长人物 / 事件 / 圈内说法
  const res = dySearch(home, raw, opts)
  if (res.ok) {
    const d = distill(raw, res.items)
    if (d && d.weak) {
      /**
       * 抖音有大量相关内容、但没人写「X 就是…」。
       * 不入库，把标题/评论原话带出去当线索（见 distill 里的长注释）。
       */
      return {
        ok: true, cached: false, weak: true, via: 'douyin-titles',
        term: raw, meaning: '', items: [], answer: '',
        titles: d.titles || [], comments: d.comments || [],
      }
    }
    if (d) {
      addMeme(home, { term: raw, meaning: d.meaning, source: 'dy-search', evidence: d.evidence })
      return { ok: true, cached: false, via: 'douyin', term: raw, meaning: d.meaning, items: res.items }
    }
  }
  const dyErr = res.ok ? 'no_result' : (res.error || 'search_failed')

  // ② 网页：擅长通用黑话的词义（搜狗的 AI 摘要是现成的一句话解释）
  if (opts.web === false) return { ok: false, error: dyErr, items: res.items || [] }
  const w = webSearch(home, raw, opts)
  if (!w.ok) {
    return { ok: false, error: `${dyErr} / web:${w.error || 'failed'}`, items: res.items || [] }
  }
  if (w.answer) {
    const meaning = w.answer.replace(/\s+/g, ' ').trim().slice(0, 200)
    addMeme(home, { term: raw, meaning, source: 'web', evidence: w.answer.slice(0, 200) })
    return { ok: true, cached: false, via: 'web', term: raw, meaning, items: [], answer: w.answer }
  }
  // 网页只拿到条目（没有摘要）：挑分高的当线索，但**不入库、也不算学会** ——
  // 「yyds什么意思？00后行话已经霸占网络平台了」这种标题不是释义，存了会误导；
  // 但它确实指明了「这是一句网络黑话」，给模型当线索比什么都没有强。
  // 所以标 `weak:true`，由调用方决定「要不要拿这些标题再答一遍」。
  const titles = (w.items || []).filter((x) => x && x.title).map((x) => x.title)
  if (titles.length) {
    return { ok: true, cached: false, weak: true, via: 'web-titles', term: raw, meaning: '', items: [], answer: '', titles }
  }
  return { ok: false, error: `${dyErr} / web:no_result`, items: res.items || [] }
}

/**
 * 把搜到的原文拼成给模型看的一段。
 *
 * 刻意不给「结论」，只给原文：模型看到「灭霸 → 灭建国 浩克 → 浩志强…」
 * 自己就能推出这是整套改名梗，比给它一句二手总结更准。
 * 同时明确禁止它说「我搜了一下」——她要装得像本来就知道。
 */
export function buildEvidenceBlock(term, items, { maxTitles = 3, maxComments = 3 } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((x) => x && x.desc)
  if (!rows.length) return ''
  const titles = rows.slice(0, maxTitles).map((x) => plain(x.desc, 70)).filter(Boolean)
  const cmts = []
  for (const x of rows) {
    for (const c of (Array.isArray(x.top_comments) ? x.top_comments : [])) {
      const t = plain(c.text, 70)
      if (t && t.length >= 5 && !cmts.includes(t)) cmts.push(t)
      if (cmts.length >= maxComments) break
    }
    if (cmts.length >= maxComments) break
  }
  return assembleEvidence(term, { titles, cmts }, '抖音')
}

/**
 * 网页搜索那一路的证据块。
 *
 * 网页搜到的东西形态不一样：搜狗直接给一段**已经写好的解释**，
 * 这时就没有「标题 / 评论」之分，把那段原话给模型就行。
 * `titles` 是只有搜索结果条目、没有摘要时的降级形态（别当释义，只当线索）。
 */
export function buildWebEvidenceBlock(term, { answer = '', titles = [] } = {}) {
  const titles2 = (Array.isArray(titles) ? titles : []).slice(0, 3).map((t) => plain(t, 60)).filter(Boolean)
  const ans = String(answer || '').replace(/\s+/g, ' ').trim().slice(0, 320)
  if (!ans && !titles2.length) return ''
  return assembleEvidence(term, { answer: ans, titles: titles2 }, '网上')
}

/** 两路共用的拼装 + 同一套禁令（别念出处、别复述、像本来就知道）。 */
function assembleEvidence(term, { titles = [], cmts = [], answer = '' }, where) {
  const lines = []
  if (answer) lines.push('· ' + answer)
  if (titles.length) lines.push('· 相关网页标题：' + titles.map((t) => `「${t}」`).join('、'))
  if (cmts.length) lines.push('· 高赞评论：' + cmts.map((t) => `「${t}」`).join('、'))
  if (!lines.length) return ''
  return '\n\n（你刚才不认识「' + String(term).slice(0, 24) + '」，刚在' + where + '搜到的原文：\n'
    + lines.join('\n')
    + '\n—— 照这些理解它是什么，然后正常回刚才那句话。'
    + '别说「我搜了一下」「我查了」「刚查的」，像本来就知道一样说。别念证据、别复述标题。）'
}
