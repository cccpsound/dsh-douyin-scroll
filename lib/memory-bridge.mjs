/**
 * lib/memory-bridge.mjs —— 从 AstrBot 的 LivingMemory 里捞长期记忆
 * ============================================================================
 * 背景（2026-10-25 使用者原话）：「她是不是还没有记忆库和上下文?」→「先修再补,然后用方案2」
 *
 * 抖音侧原本只有**短期上下文**（`dm-auto-reply.mjs` 的 `history`，16 条已回过的消息）。
 * 那就是「一觉睡醒全忘」—— 主人昨天在抖音上说过的事，今天再提她就当没听过。
 *
 * 方案 2 = 复用 AstrBot 侧已经建好的 LivingMemory：
 *   - 向量模型 bge-m3（本机 Ollama，127.0.0.1:11434，dim 1024）
 *   - 库里已有 237 条长期记忆（227 documents / 1019 memory_atoms / 1895 graph_nodes / 7922 edges）
 *   - QQ 群聊和私聊的对话都已经在里面了
 * 这样两边共用一套记忆，不用在抖音侧再养一个库。
 *
 * ── 为什么走 HTTP 而不是直连 sqlite ─────────────────────────
 * 检索不是 `SELECT ... LIKE`：它要先用 bge-m3 把 query 编码成 1024 维向量，
 * 再去 FAISS/图索引里做混合检索（文档路 + 图路 + RRF 融合）。
 * 这套逻辑全在 AstrBot 插件进程里，抖音侧是独立 Node 进程，复现不了。
 * 所以只能调它暴露的 Web API。
 *
 * ── 接口（2026-10-25 实测确认）────────────────────────────
 *   POST http://127.0.0.1:6185/api/plug/astrbot_plugin_livingmemory/page/recall/test
 *   Header: Authorization: Bearer <AstrBot 面板 token>
 *   Body:   { "query": "...", "k": 3 }        // 不传 session_id 即跨会话检索
 *   返回:   { "status":"ok", "data":{ "results":[{ memory_id, content, similarity_score, metadata{...} }] } }
 *
 * ⚠️ 路径坑：`register_web_api` 注册的路由**不是**挂在
 *    `/astrbot_plugin_livingmemory/page/...`，而是 `/api/plug/` 前缀下
 *    （见 `astrbot/dashboard/api/plugins.py:209 _match_registered_web_api`）。
 *    直接打前者会返回 `{"status":"error","message":"Method Not Allowed"}`。
 *
 * ── 设计原则：拿不到记忆绝不能拖累回复 ────────────────────
 * 这个模块**永不 throw**，超时/断网/token 过期一律返回 `{ok:false}`，
 * 调用方照常回复（只是少了那点上下文）。宁可少点记忆，不能因为记忆服务挂了就不说话。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** AstrBot 面板地址（端口可被环境变量覆盖，本机实测是 6185） */
const PANEL = String(process.env.ASTRBOT_PANEL || 'http://127.0.0.1:6185').replace(/\/+$/, '')

/** 插件 Web API 的确切前缀（`/api/plug/<plugin_name>/page`） */
const PAGE_API = `${PANEL}/api/plug/astrbot_plugin_livingmemory/page`

/**
 * 面板 token 的候选来源，按优先级：
 *   ① 环境变量 ASTRBOT_TOKEN（临时排查时最方便）
 *   ② `E:\_bot\_tk.txt` —— 长期维护的那个文件（由 `_reload_helper.py` 自签后写入，133 字符）
 *   ③ 家目录 config.json 的 astrbotToken
 *
 * 为什么要读文件而不是现场登录：现场登录要密码，密码轮换／日志滚动后
 * `Initial password:` 就抓不到了（以前 `_reload_helper.py` 踩过这个坑）。
 * 自签 JWT 也不合适在这里做 —— 那要读 cmd_config.json 的 jwt_secret 再算 HS256，
 * 为了查个记忆把 dashboard 密钥读进抖音插件进程，不值当。
 */
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
    } catch {
      /* 读不到就试下一个 */
    }
  }

  try {
    const cfgPath = join(home || join(homedir(), '.dsh', 'douyin-duty'), 'config.json')
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const t = String(cfg.astrbotToken || '').trim()
      if (t) return t
    }
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * 进程内缓存。
 *
 * 为什么必须缓存：`dm-auto-reply.mjs` 每 30 秒 tick 一次，而检索一次要跑
 * bge-m3 编码 + 双路召回 + RRF 融合（实测 200~400ms，冷的时候更久）。
 * 同一句话在几秒内被反复问（连发三条相同内容、或 at-me-watch 和 dm-auto 同时轮询）
 * 时不缓存就是纯浪费。
 *
 * key = query 原文，value = { at, items }；**不缓存失败结果**，
 * 否则服务一抖动就会连续 5 分钟拿不到记忆。
 */
const CACHE = new Map()
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 60

function cacheGet(key) {
  const c = CACHE.get(key)
  if (!c) return null
  if (Date.now() - c.at > CACHE_TTL_MS) {
    CACHE.delete(key)
    return null
  }
  return c.items
}

function cachePut(key, items) {
  if (CACHE.size >= CACHE_MAX) {
    // 简单的 FIFO 淘汰 —— 够用了，不值得为这个引入 LRU 实现
    const first = CACHE.keys().next().value
    if (first !== undefined) CACHE.delete(first)
  }
  CACHE.set(key, { at: Date.now(), items })
}

export function clearMemoryCache() {
  CACHE.clear()
}

/**
 * 检索长期记忆。
 *
 * @param {string} query        检索语句（一般传对方刚说的那句话）
 * @param {object} [o]
 * @param {number} [o.k=20]     要几条**候选**（不是要几条结果）。
 *    ⭐ 别改回 3：门槛是两道（本侧 0.5 / 别处 0.30），候选只要 3 条时
 *    「今天吃什么了」只捞到 2 条、还漏掉真正对的那条（0.504 那条排在候选 9 位之后）。
 *    取 20 让真正相关的能进候选池，再在本地按门槛筛。
 * @param {string} [o.home]     家目录（找 token 用）
 * @param {number} [o.timeoutMs=6000]
 * @param {number} [o.minScore=0.58] 向量相似度下限。**判据是 `document_vector_score` 不是 `similarity_score`**，
 *                               理由见下面 `SCORE_FIELD` 那段注释（2026-10-25 实测标定）
 * @returns {Promise<{ok:boolean, items?:Array<{id:number, text:string, score:number, session:string}>, error?:string, ms?:number}>}
 *          永不 throw
 */
/**
 * ⭐ 用哪个分数当判据 —— 2026-10-25 实测标定，别改错。
 *
 * 接口返回里有一堆分数，全都试过，结论如下：
 *
 *   ① `similarity_score`（顶层）—— **不能用**
 *      它是 RRF 融合后的排名归一化分：每轮第一名都归一到 1.000，第二名 0.965。
 *      实测纯乱码 query「abc xyz 无关内容测试」也拿到 sim=1.000、rrf=0.977。
 *      拿它做阈值等于没阈值 —— 任何 query 都能"高相关"地捞回 3 条。
 *
 *   ② `metadata.document_vector_score` —— **不能单独用**
 *      bge-m3 在中文上的余弦分布特别窄（实测全落在 0.38~0.66），
 *      而且**相关性跟分数几乎不单调**：
 *        「哈吉米」真命中了（内容就是讲哈吉米）  → 0.470
 *        「你好」完全无关（捞回一堆闲聊）        → 0.550  ← 比真命中还高
 *      用绝对阈值必然误杀。试过 0.58，把「哈吉米」「ZMZS013」这类真命中全砍了。
 *
 *   ③ `metadata.document_keyword_score`（BM25）—— **✅ 用这个**
 *      干净得离谱，真命中 ≥0.8、噪声一律 0.000：
 *        query         真命中那条 dk     噪声条 dk
 *        哈吉米            1.000            0.000
 *        奶龙              0.833            0.000
 *        意面              1.000            0.000
 *        意面 好吃吗        0.964            0.000
 *        周记              1.000             —
 *        完全无关词汇zzzq    —              全 0.000
 *      判据：**dk >= 0.5 才算命中**；向量分只做次要排序，不参与过滤。
 *
 *   ④ 有些结果 `metadata` 里压根没有分数（`dv=- dk=-`）——
 *      实测全是那条「主人电脑屏幕上的画面：…」的万能记忆，每轮都被召回。
 *      一律丢弃。
 *
 *   ⑤ 还有重复：查「周记」时同一条 memory 被召回 4 遍（字段完全一样）。
 *      按 `memory_id` 去重。
 *
 * 为什么阈值不设更低（0.3）：BM25 对中文短句很容易误命中常用字。
 * 宁可少给一条记忆，也别让它在抖音上突然聊起 QQ 群里的熟人。
 */

/** 关键词分字段：真正的相关性判据 */
const KW_FIELD = 'document_keyword_score'
/** 向量分字段：只用于同分时的排序 */
const VEC_FIELD = 'document_vector_score'
/** 关键词命中下限（同一侧：抖音自己的记忆） */
const KW_MIN = 0.5

/**
 * ⭐ 跨来源（QQ 那边攒的记忆）的关键词下限，比同侧低一档。
 *
 * 为什么要分两档（2026-10-28 实测标定，别合并成一个常数）：
 *   同一条记忆「Микоян 不吃早饭，吃饭时间不定」，
 *   query「你还记得我说过我爱吃什么」→ kw=0.683（能过 0.5）
 *   query「今天吃什么了」            → kw=0.131（被 0.5 挡死）
 *   而它恰恰就是「今天吃什么了」最该想起来的那条。
 *
 * 实测「今天吃什么了」拉到 20 条时 QQ 记忆的 kw 分布：
 *   0.504 / 0.437 / 0.421 / 0.340 / 0.287 / 0.249 / 0.244 / 0.235 / 0.205 …
 *   前四条全是真·吃饭记录（土豆丝、前一天吃了什么、一曲思君赋当天没吃东西、
 *   晚上九点提醒他吃饭），从第五条开始才是同字不同义的杂项。
 * 所以跨来源取 0.30：够到真记录，挡掉「吃」字乱命中的杂项。
 *
 * 为什么不干脆两边都用 0.30：同侧记忆是抖音自己刚聊过的，降低门槛会让她
 * 在私信里反复捡起自己上一条说过的内容（正是「老是发之前发过的」那种观感）。
 */
const KW_MIN_CROSS = 0.30

/** 哪些 session 前缀算「另一个平台攒的记忆」 */
const CROSS_PREFIXES = ['qq-', 'wechat-', 'telegram-']

/** 结果里带上来源，好在 prompt 里点明这是哪边的事 */
function sourceOf(sessionId) {
  const s = String(sessionId || '')
  for (const p of CROSS_PREFIXES) if (s.startsWith(p)) return 'other'
  if (s.startsWith('douyin-')) return 'douyin'
  return ''
}

/**
 * 这类 query 不值得检索 —— 语气词／寒暄，BM25 会拿常用字乱命中。
 *
 * ⚠️ 别用「长度够不够」当判据（踩过）：最初写 `q.length < 4`，
 * 结果「哈吉米」「奶龙」「周记」这些**最该检索的实体词**（2~3 字）全被拒了，
 * 反而「abc xyz 无关内容测试」这种长串放行。改成黑名单。
 */
const NOISE_QUERIES = new Set([
  '在吗', '在么', '在不在', '你好', '您好', 'hi', 'hello', '哈喽', '哈啰',
  '嗯', '嗯嗯', '哦', '哦哦', '啊', '啊啊', '好的', '好', '行', '可',
  '?', '？', '??', '？？', '。。。', '...', '123', '1', '666',
])

export async function recallMemory(query, { k = 20, home = '', timeoutMs = 8000 } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim()
  const bare = q.replace(/[\s\p{P}\p{S}]/gu, '')
  // 纯标点／纯语气词／太短的寒暄不值得查（见 NOISE_QUERIES 注释）
  if (!bare || NOISE_QUERIES.has(q.toLowerCase()) || NOISE_QUERIES.has(bare.toLowerCase())) {
    return { ok: false, error: 'query_noise' }
  }

  const ck = `${k}|${q}`
  const hit = cacheGet(ck)
  if (hit) return { ok: true, items: hit, cached: true }

  const token = readToken(home)
  if (!token) return { ok: false, error: 'no_token' }

  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 6000))
    const r = await fetch(`${PAGE_API}/recall/test`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: q, k: Math.max(1, Math.min(50, Number(k) || 3)) }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const body = await r.text()
    if (!r.ok) {
      return { ok: false, error: `http_${r.status}: ${body.slice(0, 140)}`, ms: Date.now() - t0 }
    }
    let j
    try {
      j = JSON.parse(body)
    } catch {
      return { ok: false, error: 'bad_json: ' + body.slice(0, 120), ms: Date.now() - t0 }
    }
    if (j?.status !== 'ok') {
      return { ok: false, error: `api_${j?.status || 'unknown'}: ${String(j?.message || '').slice(0, 120)}`, ms: Date.now() - t0 }
    }
    const raw = Array.isArray(j?.data?.results) ? j.data.results : []
    const seen = new Set() // 见上面 ⑤：同一条 memory 会被召回多次
    const items = []
    for (const it of raw) {
      const md = it?.metadata && typeof it.metadata === 'object' ? it.metadata : {}
      const kw = Number(md[KW_FIELD])
      // 见上面 ③④：没有关键词分、或关键词没命中 ⇒ 当噪声丢掉。
      // 门槛按来源分两档：别处攒的记忆松一点（见 KW_MIN_CROSS 那段实测）
      const sid = String(md.session_id || '')
      const src = sourceOf(sid)
      const floor = src === 'other' ? KW_MIN_CROSS : KW_MIN
      if (!Number.isFinite(kw) || kw < floor) continue
      const id = Number(it?.memory_id) || 0
      if (id && seen.has(id)) continue
      const vec = Number(md[VEC_FIELD])
      const text = String(it?.content || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (id) seen.add(id)
      /**
       * 文本层也要去重：实测查「周记」时 4 条结果的 memory_id 各不相同、
       * 内容和分数却一字不差 —— 说明**库里本身就存在重复记忆**（同一段对话被
       * 分多次写进去），光按 id 去重挡不住。
       */
      const tkey = text.slice(0, 80)
      if (seen.has(tkey)) continue
      seen.add(tkey)
      items.push({
        id,
        text,
        score: kw,
        vec: Number.isFinite(vec) ? vec : 0,
        session: sid,
        source: src,
      })
    }
    // 同分时：本侧优先 → 向量分高的优先（kw 是主判据，vec 只做 tie-break）
    items.sort(
      (a, b) =>
        b.score - a.score ||
        (a.source === 'other') - (b.source === 'other') ||
        b.vec - a.vec,
    )
    cachePut(ck, items)
    return { ok: true, items, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: `${e.name}: ${String(e.message || e).slice(0, 120)}`, ms: Date.now() - t0 }
  }
}

/**
 * 把检索结果压成给模型看的一小段话。
 *
 * 为什么要压：一次检索回来 3 条、每条可能几百字（那是模型的对话摘要，
 * 不是给人读的备忘）。整段塞进 prompt 会让私信回话变成「根据我的记忆……」，
 * 完全不像人。这里截到每条约 90 字、总共不超过 3 条，
 * 并且明确告诉模型「这些是你之前聊过的、可能相关的片段，不一定对得上现在」——
 * 否则它会把记忆当成事实硬套。
 *
 * @returns {string} 拼好的段落；没有可用记忆时返回空串（调用方直接不拼）
 */
export function formatMemoryForPrompt(items, { maxItems = 3, perItemChars = 90 } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, Math.max(0, maxItems))
  if (!list.length) return ''
  const lines = []
  let hasCross = false
  for (const it of list) {
    const t = String(it?.text || '').replace(/\s+/g, ' ').trim().slice(0, perItemChars)
    if (!t) continue
    // 跨来源的单独打标：让他知道这是「另一边」聊过的，别在抖音上问「你什么时候说的」
    if (it?.source === 'other') {
      hasCross = true
      lines.push('- 【别处】' + t)
    } else {
      lines.push('- ' + t)
    }
  }
  if (!lines.length) return ''
  /**
   * 跨来源那条必须点明「是别人说的」，不然会串人：
   * QQ 上攒的是 Микоян、一曲思君赋、柠檬acid 这些人的事，
   * 抖音私信这边对着的是几百个陌生人 —— 拿 A 的吃饭记录去接 B 的话就是胡说。
   * 所以判据写成「记忆里提到的那个名字，跟眼前这个人对得上才用」。
   */
  const head = hasCross
    ? '（下面这些是你之前跟人聊过的片段，可能相关也可能对不上现在。标了【别处】的是**在另一个平台上、跟别人**聊过的事，' +
      '只有当里面提到的那个名字正是眼前这个人时才能拿来接话；名字对不上就当没看见，' +
      '别追问「你哪时候说的」「在哪说的」，也绝对不要说「根据我的记忆」这类话）'
    : '（下面这些是你之前跟人聊过的片段，可能相关也可能对不上现在。' +
      '能接上就自然接一句，接不上就当没看见，绝对不要说「根据我的记忆」这类话）'
  return '\n\n' + head + '\n' + lines.join('\n')
}

/**
 * 一步到位：检索 + 格式化。
 * 调用方只需要 `const mem = await recallForPrompt(text)`，拿空串就是没检索到。
 *
 * @param {string} query
 * @param {object} [o] 透传给 recallMemory，另加 `enabled`（false 时直接返回空串）
 * @returns {Promise<string>}
 */
export async function recallForPrompt(query, { enabled = true, ...o } = {}) {
  if (!enabled) return ''
  if (String(process.env.DOUYIN_MEMORY_OFF || '') === '1') return ''
  const r = await recallMemory(query, o)
  if (!r.ok) return ''
  return formatMemoryForPrompt(r.items, { maxItems: o.maxItems || 4, perItemChars: o.perItemChars || 90 })
}
