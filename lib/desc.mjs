/**
 * 文案（desc）的收长逻辑 —— 全仓库共用一份。
 *
 * 为什么单独一个文件（2026-11-05）：
 *
 *   使用者贴了一条尼采长文的抖音（@Dionysus「那个抱着马哭的人」，实测 1580 字），
 *   问「为什么还是看不了完整文案」。查下来同一段文案在四道截断上被砍成四个
 *   长度，最大只有 280：
 *
 *     · tools/look-video.mjs:241        slice(0, 300)
 *     · lib/video-understand.mjs:214    slice(0, 280)
 *     · lib/video-frames.mjs:395        slice(0, 150)   ← 只给视觉模型
 *     · lib/persona-llm.mjs:435         slice(0, 200)   ← 最终喂给她
 *
 *   前三次修（120→280、60→150、70→200）都在「调大数字」，但每次改一处漏三处，
 *   而且理由本身就错了 —— 那几处注释写着「抖音正文上限 55 个汉字，280 字留了
 *   余量」。长文文案是抖音的一等公民（图文/长文作品动辄一两千字），
 *   55 汉字这个前提早就过期了。所以不是数字不够大，是**思路不对**：
 *   按字数硬切，遇到长文永远只能读到开头。
 *
 * 现在的做法：
 *
 *   1. **上限提到 2000 字**，四道共用 `DESC_CAP`，不再各写一个数字。
 *   2. **软截断**：不硬切在字数上，在上限之内往回找最近的自然断点
 *      （句号 / 问号 / 感叹号 / 省略号 / 换行），宁可少读十几个字，
 *      也不让一句话断在半截。
 *   3. **明说还有多少没读**：超长时尾巴加「（后面还有 N 字，这条没读完）」。
 *      她知道这是长文、知道自己只读了前半 —— 这比读到半句话却以为是全文安全得多。
 *   4. **短文案零改动**：不超过上限时原样返回，一个字符都不动。
 *
 * 成本：1580 字文案约多 1600 token，比抽帧和读评论都便宜。
 */

/** 文案统一上限。四道截断都用这一个值。 */
export const DESC_CAP = 2000

/** 自然断点优先级：先按句子，再按分句，最后按空格。 */
const _BREAKS = ['。', '！', '？', '；', '…', '\n', '.', '!', '?', ';', '，', ',']

/**
 * 按上限收长，尽量断在自然断点。
 *
 * @param {any} text 原始文案
 * @param {number} cap 上限字数，默认 DESC_CAP
 * @param {{mark?: boolean}} opt mark=false 不加「还有 N 字」（给视觉模型那种不需要的场合）
 * @returns {string} 收长后的文案；不超上限时与输入逐字相同
 */
export function fitDesc(text, cap = DESC_CAP, opt = {}) {
  const s = String(text == null ? '' : text)
  const limit = Math.max(20, Number(cap) || DESC_CAP)
  if (s.length <= limit) return s

  // 往回找自然断点。搜索范围限制在最后 30%，否则一条 2000 字的长文
  // 会一路退到第一个句号，等于只给了开头几百字。
  const floor = Math.floor(limit * 0.7)
  let cut = -1
  for (const br of _BREAKS) {
    const i = s.lastIndexOf(br, limit - 1)
    if (i >= floor && i > cut) cut = i
  }
  // 都找不到（比如整段没有标点的长句），才退回硬切。
  const head = cut > 0 ? s.slice(0, cut + 1) : s.slice(0, limit)

  if (opt.mark === false) return head.trim()
  const rest = s.length - head.length
  if (rest <= 0) return head.trim()
  return head.trim() + `（后面还有 ${rest} 字，这条没读完）`
}

/**
 * 给视觉模型看的短版：它不需要读全文，但也不能只给一句。
 * 保留首段 + 末段，比单纯砍前半有用 —— 长文的重点常在结尾（这条尼采就是
 * 最后「他抱住的，是那个被所有人抛弃的自己」才落到点上）。
 *
 * @param {any} text
 * @param {number} cap
 * @returns {string}
 */
export function fitDescBrief(text, cap = 400) {
  const s = String(text == null ? '' : text)
  const limit = Math.max(40, Number(cap) || 400)
  if (s.length <= limit) return s

  const half = Math.floor((limit - 8) / 2)
  const head = fitDesc(s, half, { mark: false })
  const tail = s.slice(-half)
  return `${head}……（中间略）……${tail}`
}
