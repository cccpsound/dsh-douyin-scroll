/**
 * lib/memory-push.mjs —— 把抖音侧的对话 / 看过的视频**推进 AstrBot 的 LivingMemory**
 * ============================================================================
 * 背景（2026-10-27 使用者原话）：
 *   「如果我给抖音的小鲸鱼发视频,qq的能学习到吗,能读到记忆库和上下文里吗」
 *   → 实测答案是**不能**：
 *     · `livingmemory.db` 的 documents 905 条，session 前缀分布 qq-snowluma 724 /
 *       webchat 7 / 无 174 —— **douyin 0 条**。
 *     · 抖音侧 `memory/dm-<sec_uid>.json` 只有 80 条 text，`kind` 全是 text，
 *       卡片消息因为 `text` 为空在 `mergeDmMemory` 里被 `if (!text) continue` 丢掉，
 *       所以**看过的视频内容一个字都没落盘**。
 *   使用者选「A+B」= A 把抖音对话写进 QQ 记忆库 + B 把视频内容也变成记忆。
 *
 * ── 为什么走 HTTP import，不直连 livingmemory.db ────────────────
 * 记忆不是单纯 INSERT：它要写 documents + memory_atoms + graph_nodes/edges，
 * 还要用 bge-m3 生成向量进 FAISS。这些全在 AstrBot 插件进程里（详见 memory-bridge.mjs
 * 顶部注释），抖音侧是独立 Node 进程，复现不了。所以只用它暴露的官方 import 接口：
 *   POST {PANEL}/api/plug/astrbot_plugin_livingmemory/page/memories/import
 *   Body: { format:"json", content:"<JSON字符串>", dry_run:bool,
 *           duplicate_strategy:"skip"|"allow" }
 *   content 里是 { memories:[ { content, session_id, persona_id, importance, memory_type } ] }
 *   → { status:"ok", data:{ imported_count, skipped_duplicate_count, imported_ids } }
 * 去重由它自己算（content+session_id+persona_id 的哈希），所以**重复调用是安全的**。
 *
 * ⚠️ 内容必须自己压成「一段话」，不能一条消息一条记忆
 *    实测库里已有 905 条 documents 已经把库撑到 67MB。80 条私信逐条推进去 =
 *    库继续膨胀、召回时全是碎句。这里按**天**聚合：一天一条，最多 20 句摘录。
 *
 * ⚠️ 绝不阻塞 dm 回复
 *    和 memory-bridge 同一个原则：永不 throw，失败返回 {ok:false}，
 *    调用方照常干活。推记忆是锦上添花，不能因为它让私信回不出去。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PANEL = String(process.env.ASTRBOT_PANEL || 'http://127.0.0.1:6185').replace(/\/+$/, '')
const PAGE_API = `${PANEL}/api/plug/astrbot_plugin_livingmemory/page`

/** 一天最多摘几句（多了记忆条目会长到没法读） */
const MAX_LINES_PER_DAY = 20
/** 单条消息截断（中间的长段落对记忆没用，只留开头） */
const LINE_CHARS = 60
/** 一条记忆的总字数上限 */
const MAX_MEMO_CHARS = 900

const nowIso = () => new Date().toISOString()

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonSafe(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 1), 'utf8'); return true } catch { return false }
}

/** 面板 token：和 memory-bridge 一样的三处候选，顺序也一致 */
function readToken(home) {
  const env = String(process.env.ASTRBOT_TOKEN || '').trim()
  if (env) return env
  const cands = [
    'E:/_bot/_tk.txt',
    join(home || join(homedir(), '.dsh', 'douyin-duty'), '_tk.txt'),
  ]
  for (const p of cands) {
    try {
      if (!existsSync(p)) continue
      const t = readFileSync(p, 'utf8').trim()
      if (t) return t
    } catch { /* 读不到就试下一个 */ }
  }
  try {
    const cfgPath = join(home || join(homedir(), '.dsh', 'douyin-duty'), 'config.json')
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const t = String(cfg.astrbotToken || '').trim()
      if (t) return t
    }
  } catch { /* ignore */ }
  return ''
}

/** 推送游标：记录每个 sec_uid 已经推到哪一天，避免每天重复扫全量 */
const stateFile = (home) => join(home, 'memory-push.json')

export function loadPushState(home) {
  const j = readJsonSafe(stateFile(home), null)
  return j && typeof j === 'object' && j.peers && typeof j.peers === 'object'
    ? j
    : { peers: {}, updatedAt: '' }
}

function savePushState(home, st) {
  st.updatedAt = nowIso()
  writeJsonSafe(stateFile(home), st)
}

/** 把一天的消息压成一段话。空返回 = 这天没有可用内容 */
export function digestDay(nick, day, msgs, { kind = 'dm', names = {} } = {}) {
  const lines = []
  for (const m of msgs) {
    const t = String(m.text || '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    /**
     * 丢掉系统/通知类噪音。
     *
     * 实测群里每天都有「CCCPsound邀请你加入了群聊」「[群通知]」这种，
     * 它们在摘要里占行数却零信息量 —— 而 MAX_LINES_PER_DAY 只有 20 行，
     * 一晚上几条系统消息就能把真对话挤掉。
     */
    const k = String(m.kind || '')
    if (k === 'system' || k === 'notice' || k === 'unknown') continue
    /**
     * ⚠️ 历史遗留：2026-10-27 14:46 那次 `sayWithModel` 返回对象没取 `.text`，
     * 真往群里发过一条 `[object Object]`。它现在还在记忆里，进摘要会污染上下文。
     * 这不是「过滤正常消息」，只清这一个已知的错误产物。
     */
    if (t === '[object Object]') continue
    /**
     * 群聊里说话的不止一个人，得按 sender 分开标。
     *
     * `names` 是 `{uid: 昵称}` 的映射（有就用昵称，没有就退成 uid 末 4 位）。
     * 拿不到 sender 就还是退回「对方」—— 但至少不会把所有人都叫成群名。
     */
    let who
    if (m.from === 'me') {
      who = '我'
    } else if (kind === 'group') {
      const su = String(m.sender || '')
      who = (su && names[su]) || (su ? '群友' + su.slice(-4) : '群友')
    } else {
      who = nick || '对方'
    }
    lines.push(`${who}：${t.slice(0, LINE_CHARS)}`)
    if (lines.length >= MAX_LINES_PER_DAY) break
  }
  if (!lines.length) return ''
  /**
   * ⭐ 2026-10-27：群聊和私信要用不同的抬头。
   *
   * 使用者要求群聊「和私聊一样存」，但存进去如果还写「我和 X 在抖音上聊了」，
   * QQ 那边读到会以为是私聊 —— 群里有七八个人说话，说成一对一就错了。
   */
  const head = kind === 'group'
    ? `【抖音群聊】${day} 我在抖音群「${nick || '某个群'}」里聊了 ${msgs.length} 句：`
    : `【抖音私信】${day} 我和 ${nick || '对方'} 在抖音上聊了 ${msgs.length} 句：`
  return (head + '\n' + lines.join('\n')).slice(0, MAX_MEMO_CHARS)
}

/**
 * 把某个人（或全部人）的抖音私信推到 LivingMemory。
 *
 * @param {string} home  $DOUYIN_HOME（douyin-duty 目录）
 * @param {object} [o]
 * @param {string} [o.secUid]   只推这个人；不给就扫 memory/ 下所有 dm-*.json
 * @param {boolean} [o.force]   true = 忽略游标，重推所有天（靠服务端去重兜底）
 * @param {boolean} [o.dry]     true = 只算不推
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:boolean, dry?:boolean, peers?:number, memos?:number,
 *                    imported?:number, skipped?:number, detail?:Array, error?:string}>}
 */
export async function pushDmToLivingMemory(home, { secUid = '', force = false, dry = false, timeoutMs = 20_000 } = {}) {
  if (String(process.env.DOUYIN_MEMORY_PUSH_OFF || '') === '1') {
    return { ok: false, error: 'disabled（DOUYIN_MEMORY_PUSH_OFF=1）' }
  }
  const token = readToken(home)
  if (!token) return { ok: false, error: 'no_token（找不到 AstrBot 面板 token）' }

  const memDir = join(home, 'memory')
  let files = []
  try {
    const { readdirSync } = await import('node:fs')
    files = readdirSync(memDir).filter((f) => /^dm-.*\.json$/.test(f))
  } catch {
    return { ok: false, error: 'no_memory_dir' }
  }
  if (!files.length) return { ok: true, peers: 0, memos: 0, import_list: [] }

  const st = loadPushState(home)
  const memories = []
  const detail = []

  for (const f of files) {
    const j = readJsonSafe(join(memDir, f), null)
    if (!j || !Array.isArray(j.messages)) continue
    const who = j.who || {}
    const su = String(who.sec_uid || '')
    const nick = String(who.nick || '')
    const wkind = String(who.kind || '') === 'group' ? 'group' : 'dm'
    if (secUid && su !== secUid) continue

    // 按天分桶（messages 的 at 是 ISO 时间，取前 10 位就是日期）
    const byDay = new Map()
    for (const m of j.messages) {
      const day = String(m.at || '').slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(m)
    }

    const pushedDays = Array.isArray(st.peers[su]?.days) ? st.peers[su].days : []
    const pushedSet = new Set(force ? [] : pushedDays)
    let added = 0
    for (const [day, msgs] of [...byDay.entries()].sort()) {
      if (pushedSet.has(day)) continue
      const memo = digestDay(nick, day, msgs, { kind: wkind })
      if (!memo) continue
      memories.push({
        content: memo,
        // session_id 前缀 `douyin-dm:` 让库里一眼能认出这是抖音来的；
        // 群聊用 `douyin-group:`，xj_crossmem 的 FOREIGN_PREFIXES 是 ("douyin-",) 前缀匹配，两边都认。
        session_id: wkind === 'group' ? `douyin-group:${su || f}` : `douyin-dm:${su || f}`,
        persona_id: 'xiaojingyu',
        // 私聊比群聊更私人一点，但也别设太高 —— 库里 0.55 是常见档
        importance: wkind === 'group' ? 0.48 : 0.55,
        memory_type: 'GENERAL',
      })
      added++
      detail.push({ secUid: su, nick, day, chars: memo.length })
      if (!st.peers[su]) st.peers[su] = { nick, days: [] }
      if (!force) st.peers[su].days.push(day)
      st.peers[su].nick = nick || st.peers[su].nick || ''
    }
    if (added) detail.push({ secUid: su, nick, days: added })
  }

  if (!memories.length) {
    return { ok: true, peers: files.length, memos: 0, imported: 0, skipped: 0, detail }
  }
  if (dry) return { ok: true, dry: true, peers: files.length, memos: memories.length, detail }

  const body = JSON.stringify({
    format: 'json',
    dry_run: false,
    duplicate_strategy: 'skip',
    content: JSON.stringify({ memories }),
  })

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(3000, Number(timeoutMs) || 20_000))
    const r = await fetch(`${PAGE_API}/memories/import`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const text = await r.text()
    let j
    try { j = JSON.parse(text) } catch { return { ok: false, error: 'bad_json: ' + text.slice(0, 120) } }
    if (j?.status !== 'ok') {
      return { ok: false, error: `api_${j?.status || 'unknown'}: ${String(j?.message || '').slice(0, 120)}` }
    }
    const d = j.data || {}
    // 只有真成功才推进游标：失败（服务没起 / token 过期）下次还要重推
    savePushState(home, st)
    return {
      ok: true,
      peers: files.length,
      memos: memories.length,
      imported: Number(d.imported_count) || 0,
      skipped: Number(d.skipped_duplicate_count) || 0,
      failed: Number(d.failed_count) || 0,
      ids: Array.isArray(d.imported_ids) ? d.imported_ids.slice(0, 20) : [],
      detail,
    }
  } catch (e) {
    return { ok: false, error: `${e.name}: ${String(e.message || e).slice(0, 120)}` }
  }
}

/**
 * 单独推一条「看过某个视频」的记忆（视频内容量小、即时性高，不按天聚合）。
 *
 * 为什么要单独一条：B 的另一半是把视频写进本地 facts（`lib/memory.mjs` 的
 * addVideoMemory），那只在抖音侧可见。QQ 侧要知道「她在抖音上看过什么」，
 * 必须也进 LivingMemory —— 否则使用者问「你昨天在抖音看的那个片子」，
 * QQ 的小鲸鱼依然一脸茫然。
 *
 * @param {string} home
 * @param {object} o
 * @param {string} o.secUid 对方 sec_uid（用于 session_id 归类）
 * @param {string} o.nick
 * @param {string} o.itemId 作品 id
 * @param {string} [o.title] 文案 / 标题
 * @param {string} [o.scene] 抽帧看到的画面
 * @param {string[]} [o.comments] 高赞评论（取前 2 条）
 */
export async function pushVideoMemo(home, { secUid = '', nick = '', itemId = '', title = '', scene = '', comments = [], timeoutMs = 20_000 } = {}) {
  if (String(process.env.DOUYIN_MEMORY_PUSH_OFF || '') === '1') return { ok: false, error: 'disabled' }
  if (!itemId) return { ok: false, error: 'no_item_id' }
  const token = readToken(home)
  if (!token) return { ok: false, error: 'no_token' }

  const bits = [`【抖音视频】${nick || '对方'} 发来一条抖音作品（id ${itemId}）`]
  const t = String(title || '').replace(/\s+/g, ' ').trim()
  if (t) bits.push(`文案：「${t.slice(0, 100)}」`)
  const s = String(scene || '').replace(/\s+/g, ' ').trim()
  if (s) bits.push(`我看了画面：${s.slice(0, 200)}`)
  const cs = (Array.isArray(comments) ? comments : []).filter(Boolean).slice(0, 2)
  if (cs.length) bits.push(`高赞评论：${cs.map((c) => '「' + String(c).slice(0, 60) + '」').join('、')}`)
  const content = bits.join('\n').slice(0, MAX_MEMO_CHARS)

  const body = JSON.stringify({
    format: 'json',
    dry_run: false,
    duplicate_strategy: 'skip',
    content: JSON.stringify({
      memories: [{
        content,
        session_id: `douyin-video:${secUid || 'unknown'}`,
        persona_id: 'xiaojingyu',
        importance: 0.6,
        memory_type: 'GENERAL',
      }],
    }),
  })

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(3000, Number(timeoutMs) || 20_000))
    const r = await fetch(`${PAGE_API}/memories/import`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const text = await r.text()
    let j
    try { j = JSON.parse(text) } catch { return { ok: false, error: 'bad_json: ' + text.slice(0, 120) } }
    if (j?.status !== 'ok') return { ok: false, error: `api_${j?.status || 'unknown'}` }
    const d = j.data || {}
    return {
      ok: true,
      imported: Number(d.imported_count) || 0,
      skipped: Number(d.skipped_duplicate_count) || 0,
      chars: content.length,
    }
  } catch (e) {
    return { ok: false, error: `${e.name}: ${String(e.message || e).slice(0, 120)}` }
  }
}

export { PANEL, PAGE_API, MAX_MEMO_CHARS }
