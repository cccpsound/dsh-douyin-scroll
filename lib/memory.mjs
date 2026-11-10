/**
 * lib/memory.mjs —— 对话记忆（私信 / 评论区的上下文）
 * ============================================================================
 * 为什么要有：
 *   2026-10-22 用户要求「回消息 / 持续聊天，这些是要带记忆上下文的」。
 *   没有记忆的话，每次读私信都是"第一次见" —— 不知道上次聊到哪、他是什么人、
 *   什么事已经说过了，回的话就会重复、跑题、或者把人当陌生人。
 *
 * 🔴 三条设计约束：
 *   ① **只存本机**：`$DOUYIN_HOME/memory/` 下面，不上传任何地方。
 *      私信内容是最私密的东西之一，绝不能进仓库 / 日志 / 报告。
 *   ② **有上限**：每个人最多留 80 条、每条 200 字。不做无限增长。
 *   ③ **不编造**：没有记录就是没有。**绝不**用"记忆里似乎说过"来填空。
 *
 * 存储形状（`memory/dm-<sec_uid>.json`）：
 *   {
 *     who: { sec_uid, nick },
 *     updatedAt: "2026-10-22T...",
 *     rounds: 3,                       // 聊过几轮（每次 read/reply 算一次接触）
 *     facts: ["他在杭州", "养了只猫"],   // 长期事实（由模型判断后写入）
 *     messages: [                       // 按时间**旧→新**
 *       { at: "...", from: "me"|"them", text: "...", kind: "text"|"card" }
 *     ]
 *   }
 *
 * 评论区的记忆形状（`memory/comment-<aweme_id>.json`）类似，但按"视频"归档：
 *   { aweme_id, updatedAt, seen: ["cid1", ...], mine: [{cid,text,at}], notes: [] }
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 每个 peer 保留多少条消息。
 *
 * 2026-10-27 从 80 加到 300（使用者原话：「加到300」）。原因：实测 10-26 10:23
 * 到 10-27 13:20 就填满 79 条 —— 80 条只够一天半，再聊几句最早的就开始掉。
 * 300 条约等于一周，配合 memory-push.mjs 的按天摘要（推到 QQ LivingMemory
 * 永久保存）形成两级：近一周原文在本地、更早的压成摘要进 QQ 库。
 *
 * 体积代价可忽略：单条约 100 字节，300 条 ≈ 30 KB / 人。
 */
const MAX_MESSAGES = 300
const MAX_TEXT = 200
const MAX_FACTS = 20
/** 看过的作品最多留几条（独立于 messages 的 80 条额度） */
const MAX_VIDEOS = 20

/** 把 sec_uid / aweme_id 变成安全文件名（只留字母数字下划线和中划线） */
const safeKey = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'

const nowIso = () => new Date().toISOString()

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonSafe(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 1), 'utf8'); return true } catch { return false }
}

export function memoryDir(home) {
  const d = join(home, 'memory')
  try { mkdirSync(d, { recursive: true }) } catch { /* 建不了就退化成"没有记忆" */ }
  return d
}

/* ─────────────────────────── 私信记忆 ─────────────────────────── */

const dmFile = (home, secUid) => join(memoryDir(home), `dm-${safeKey(secUid)}.json`)

export function loadDmMemory(home, secUid) {
  if (!secUid) return null
  const j = readJsonSafe(dmFile(home, secUid), null)
  if (!j || typeof j !== 'object') return null
  return {
    who: j.who || { sec_uid: secUid, nick: '' },
    updatedAt: j.updatedAt || '',
    rounds: Number(j.rounds) || 0,
    facts: Array.isArray(j.facts) ? j.facts.filter((x) => typeof x === 'string').slice(0, MAX_FACTS) : [],
    messages: Array.isArray(j.messages) ? j.messages.filter((m) => m && m.text) : [],
  }
}

/**
 * 把一次读到的会话**合并**进记忆。
 * ⭐ 合并而不是覆盖：抖音只给我最近 60 条，整段覆盖会把更早的记忆冲掉。
 *    用 `from+text` 做去重键（没有稳定的消息 id 可用 —— 2026-10-22 查过，DOM 里没有）。
 *
 * @param {object} [o]
 * @param {string} [o.kind]  `'dm'`（默认）或 `'group'`。
 *   ⭐ 2026-10-27 加：使用者要求群聊「和私聊一样存」。
 *      存下来之后 `who.kind` 会带上这个值，`memory-push.mjs` 靠它决定
 *      推给 QQ 时写「我在抖音群里」还是「我和 X 在抖音上」。
 */
export function mergeDmMemory(home, secUid, nick, msgs, { kind = 'dm' } = {}) {
  if (!secUid || !Array.isArray(msgs)) return null
  const prev = loadDmMemory(home, secUid) || { who: { sec_uid: secUid, nick: '' }, rounds: 0, facts: [], messages: [] }
  const seen = new Set(prev.messages.map((m) => `${m.from}|${String(m.text).slice(0, 60)}`))
  const merged = [...prev.messages]
  let added = 0
  for (const m of msgs) {
    /**
     * ⚠️ 2026-10-27：卡片消息不能因为 text 为空就丢。
     *
     * 实测 memory/dm-<sec_uid>.json 里 80 条全是 kind:text，一条 card 都没有 ——
     * 因为分享卡片的 `text` 是空的，`if (!text) continue` 直接把它扔了。
     * 后果是「他发过一个作品」这件事在记忆里完全不存在，第二天提起就装不认识。
     * 现在给一个可读占位，至少能记住"在什么时间收到过一个分享"。
     */
    const isCard = Number(m.awe) === 800
    const rawText = String(m.text || '').trim()
    const text = rawText || (isCard ? '[分享了一个作品]' : '')
    if (!text) continue
    const key = `${m.from}|${text.slice(0, 60)}`
    if (seen.has(key)) continue
    seen.add(key)
    /**
     * ⭐ 2026-10-28：优先用上游给的真实时间戳，别再一律写 nowIso()。
     *
     * 原来无论读到的消息什么时候发的，`at` 全写成"我这一刻写盘的钟点" ——
     * 后果有两个，都是实测踩到的：
     *   ① `dm-auto-reply` 里判断「对方这条回过没有」用的是
     *      `st.repliedAt[`${rd.key}|${m.at}`]`（键是**抖音原始时间戳**），
     *      而记忆里的 at 是写入时刻，永远对不上 ⇒ 所有 `them` 的历史都被
     *      当成"还没回"过滤掉，上下文只剩自己说的话。
     *   ② `dmContext` 的 recent 失去了真实先后，摘要里时间全挤成一秒。
     * `im-http.py` 给的 `at` 是 `2026-10-28T02:10:06.102Z` 这种可解析格式，直接用。
     * 解析不了（或没给）才退回 nowIso。
     */
    const atRaw = String(m.at || '').trim()
    const atMs = atRaw ? Date.parse(atRaw) : NaN
    merged.push({
      at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : nowIso(),
      from: m.from === 'me' ? 'me' : (m.from === 'them' ? 'them' : 'unknown'),
      text: text.slice(0, MAX_TEXT),
      // ⚠️ 2026-10-22 修正：抖音的 `aweType` 在**普通文字消息**上也有值（实测是 700），
      //    只有分享卡片是 800 ⇒ 不能拿"有没有 awe"判卡片，得看具体值。
      //
      // ⭐ 2026-10-27：`im-http.py` 还会给 system / notice / unknown 这些形态，
      //    以前一律压成 'text' 存下来 ⇒ 摘要里混进「XX邀请你加入了群聊」「[群通知]」，
      //    20 行的额度被系统消息吃掉。原样保留上游 kind，让摘要有能力筛掉。
      kind: (['system', 'notice', 'unknown'].includes(String(m.kind || '')))
        ? String(m.kind)
        : (Number(m.awe) === 800 ? 'card' : 'text'),
      /**
       * ⭐ 2026-10-27：带上发送者。
       *
       * 群里说话的有七八个人，只标 `from: them` 分不清谁是谁 —— 摘要里会出现
       * 一排「群名：xxx」，读起来像群名在自己跟自己说话。
       * `im-http.py` 现在会把发送者 uid 透出来（`_m["sender"]`），这里原样存。
       * 私聊用不上（只有两个人），但存着无害。
       */
      ...(m.sender ? { sender: String(m.sender).slice(0, 32) } : {}),
    })
    added++
  }
  // 只留最近 N 条
  const trimmed = merged.slice(-MAX_MESSAGES)
  /**
   * ⚠️ 2026-10-27：`videos[]` 必须**原样带回去**。
   *
   * `loadDmMemory` 的返回形状里没有 videos（它是给 prompt 用的精简形状），
   * 直接拿它重组 out 就会把「看过哪些作品」整段抹掉 —— 每合并一条消息
   * 就丢一次视频记忆。所以这里重读原始 JSON 取 videos。
   */
  const rawPrev = readJsonSafe(dmFile(home, secUid), null) || {}
  const out = {
    who: { sec_uid: secUid, nick: nick || prev.who?.nick || '', kind: kind || prev.who?.kind || 'dm' },
    updatedAt: nowIso(),
    rounds: (Number(prev.rounds) || 0) + (added ? 1 : 0),
    facts: prev.facts.slice(0, MAX_FACTS),
    messages: trimmed,
    ...(Array.isArray(rawPrev.videos) && rawPrev.videos.length ? { videos: rawPrev.videos.slice(-MAX_VIDEOS) } : {}),
  }
  writeJsonSafe(dmFile(home, secUid), out)
  return { ...out, added, total: trimmed.length }
}

/** 记一条自己发出去的消息（发完立刻进记忆，不用等下次读） */
export function noteSent(home, secUid, nick, text, kind = 'text', { scope = 'dm' } = {}) {
  if (!secUid || !text) return null
  return mergeDmMemory(home, secUid, nick, [{ from: 'me', text, awe: kind === 'card' ? 800 : 0 }], { kind: scope })
}

/** 往记忆里加"长期事实"（模型判断值得记的：住哪、养什么、在意什么） */
export function addFacts(home, secUid, facts) {
  if (!secUid || !Array.isArray(facts) || !facts.length) return null
  const prev = loadDmMemory(home, secUid)
  if (!prev) return null
  const set = new Set(prev.facts)
  for (const f of facts) {
    const s = String(f || '').trim()
    if (s) set.add(s.slice(0, 80))
  }
  prev.facts = [...set].slice(0, MAX_FACTS)
  prev.updatedAt = nowIso()
  /**
   * ⚠️ 2026-10-27 修：`loadDmMemory` 返回的是精简形状，**没有 videos、who 里也没 kind**。
   * 直接写回去会把「看过哪些作品」和「这是私聊还是群」一起抹掉。
   * 所以重读原始 JSON 把这两项粘回去。
   */
  const rawPrev = readJsonSafe(dmFile(home, secUid), null) || {}
  const out = { ...prev, who: { ...(rawPrev.who || {}), ...prev.who } }
  if (Array.isArray(rawPrev.videos) && rawPrev.videos.length) out.videos = rawPrev.videos.slice(-MAX_VIDEOS)
  writeJsonSafe(dmFile(home, secUid), out)
  return out
}

/* ─────────────────────── 看过的作品（视频记忆） ─────────────────────── */

/**
 * 记下「我看过这个人发的这条作品」。
 *
 * 🔴 2026-10-27 加（使用者原话：「如果我给抖音的小鲸鱼发视频,qq的能学习到吗,
 *    能读到记忆库和上下文里吗」）：
 *    以前她抽帧看懂的 `scene` **只活在那一轮 prompt 里** —— 回完这条消息，
 *    画面描述就随 process 内存一起没了。实测 `memory/dm-*.json` 里 80 条
 *    `kind` 全是 `text`，一条卡片都没有，所以「他昨天发过一个片子」这件事
 *    第二天完全不记得。
 *
 * 存到 dm 记忆文件的 `videos[]`（独立数组，不占 messages 的 80 条额度）：
 *   { at, item_id, title, scene, comments: [...], how_seen }
 *
 * 同一条作品重复看（对方反复发 / 我重试）按 item_id 覆盖，不重复堆。
 */
export function addVideoMemory(home, secUid, { itemId = '', title = '', scene = '', comments = [], howSeen = '' } = {}) {
  if (!secUid || !itemId) return null
  const prev = loadDmMemory(home, secUid)
  if (!prev) return null
  const file = dmFile(home, secUid)
  const raw = readJsonSafe(file, null) || {}
  const list = Array.isArray(raw.videos) ? raw.videos : []
  const id = String(itemId)
  const rec = {
    at: nowIso(),
    item_id: id,
    title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    scene: String(scene || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    comments: (Array.isArray(comments) ? comments : []).filter(Boolean).slice(0, 3)
      .map((c) => String(c).replace(/\s+/g, ' ').trim().slice(0, 80)),
    how_seen: String(howSeen || '').slice(0, 40),
  }
  const kept = list.filter((v) => String(v?.item_id || '') !== id)
  kept.push(rec)
  raw.videos = kept.slice(-MAX_VIDEOS)
  raw.updatedAt = nowIso()
  writeJsonSafe(file, raw)
  return { ok: true, item_id: id, total: raw.videos.length }
}

/** 取出最近看过的 N 条作品（给 prompt 用） */
export function loadVideoMemory(home, secUid, { recent = 5 } = {}) {
  if (!secUid) return []
  const raw = readJsonSafe(dmFile(home, secUid), null)
  const list = Array.isArray(raw?.videos) ? raw.videos : []
  return list.slice(-recent)
}

/** 给模型看的上下文摘要（**只给最近几条 + 事实**，别把 80 条全塞进去烧 token） */
export function dmContext(home, secUid, { recent = 12 } = {}) {
  const m = loadDmMemory(home, secUid)
  if (!m || !m.messages.length) return null
  return {
    who: m.who,
    rounds: m.rounds,
    last_talk_at: m.updatedAt,
    facts: m.facts,
    recent: m.messages.slice(-recent),
    total_remembered: m.messages.length,
    videos: loadVideoMemory(home, secUid, { recent: 5 }),
  }
}

/** 只读 `who.kind`（'dm' | 'group'）。读不到就当私聊 —— 老文件没这个字段。 */
export function memoryKind(home, secUid) {
  const j = readJsonSafe(dmFile(home, secUid), null)
  const k = String(j?.who?.kind || '')
  return k === 'group' ? 'group' : 'dm'
}

/* ─────────────────────────── 评论区记忆 ─────────────────────────── */

const cmFile = (home, awemeId) => join(memoryDir(home), `comment-${safeKey(awemeId)}.json`)

export function loadCommentMemory(home, awemeId) {
  if (!awemeId) return null
  const j = readJsonSafe(cmFile(home, awemeId), null)
  if (!j || typeof j !== 'object') return null
  return {
    aweme_id: String(j.aweme_id || awemeId),
    updatedAt: j.updatedAt || '',
    seen: Array.isArray(j.seen) ? j.seen : [],
    mine: Array.isArray(j.mine) ? j.mine : [],
    notes: Array.isArray(j.notes) ? j.notes : [],
  }
}

/** 记下自己在某条视频下发过的评论（真 @ 走的 UI 拿不到 cid，只能按正文记） */
export function noteMyComment(home, awemeId, { cid = '', text = '', mention = '' }) {
  if (!awemeId || !text) return null
  const prev = loadCommentMemory(home, awemeId) || { aweme_id: String(awemeId), seen: [], mine: [], notes: [] }
  prev.mine.push({ at: nowIso(), cid: String(cid || ''), text: String(text).slice(0, MAX_TEXT), mention: String(mention || '') })
  prev.mine = prev.mine.slice(-40)
  prev.updatedAt = nowIso()
  writeJsonSafe(cmFile(home, awemeId), prev)
  return prev
}

/** 记下"这条评论我处理过了"（避免同一个 @ 反复回） */
export function markSeen(home, awemeId, cids) {
  if (!awemeId || !Array.isArray(cids) || !cids.length) return null
  const prev = loadCommentMemory(home, awemeId) || { aweme_id: String(awemeId), seen: [], mine: [], notes: [] }
  const set = new Set(prev.seen)
  for (const c of cids) if (c) set.add(String(c))
  prev.seen = [...set].slice(-300)
  prev.updatedAt = nowIso()
  writeJsonSafe(cmFile(home, awemeId), prev)
  return prev
}

/* ─────────────────────────── 维护 ─────────────────────────── */

/** 看看记忆占了多少地方（面板上显示用） */
export function memoryStats(home) {
  const d = memoryDir(home)
  const out = { dir: d, dm: 0, comment: 0, bytes: 0 }
  try {
    for (const f of readdirSync(d)) {
      if (!/\.json$/.test(f)) continue
      if (f.startsWith('dm-')) out.dm++
      else if (f.startsWith('comment-')) out.comment++
      try { out.bytes += readFileSync(join(d, f)).length } catch { /* 读不到就跳过 */ }
    }
  } catch { /* 没有就没有 */ }
  return out
}

/** 删掉某人的记忆（用户要"忘掉他"时用） */
export function forgetDm(home, secUid) {
  try {
    const f = dmFile(home, secUid)
    if (existsSync(f)) rmSync(f)
    return { ok: true, forgotten: secUid }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

/** 清空所有记忆（谨慎；只有用户明确要求才调） */
export function forgetAll(home) {
  const d = memoryDir(home)
  let n = 0
  try {
    for (const f of readdirSync(d)) {
      if (!/\.json$/.test(f)) continue
      try { rmSync(join(d, f)); n++ } catch { /* 单个删不掉就跳过 */ }
    }
  } catch { /* 目录都没有 */ }
  return { ok: true, removed: n }
}
