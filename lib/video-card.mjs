/**
 * 让 dm-auto-reply / at-me-watch 在遇到视频卡片时，真的「看过」再回。
 *
 * 调用链：卡片消息（itemId）→ 页面内 fetch 详情拿封面 → 下载成 data URI
 *        → 视觉模型说一句画面内容 → 拼进给模型的 prompt。
 *
 * 为什么单独一层：
 *   1. `im-http.py` 只交出 `card.item_id`，它跑在 Python 里、拿不到 CDP；
 *   2. 详情接口必须页面内 fetch（签名），只有走 chrome 连接的脚本能做；
 *   3. 下载封面是 Node 的活（Python 那边 curl_cffi 也能干，但没必要多一处重复实现）。
 *
 * 拿不到就返回 `seen:false` + 具体原因，**绝不编造画面内容**。
 */
import { fetchAwemeDetail, fetchImageAsDataUri, describeVideo } from './video-understand.mjs'
import { videoToGrid, gridPrompt } from './video-frames.mjs'
import { transcribeVideo, sttAvailable } from './audio-stt.mjs'
import { readFileSync } from 'node:fs'

/**
 * 从缓存的全局配置里取视觉模型参数。
 * 沿用插件既有约定：一律从 AstrBot 的 cmd_config.json 读 provider，不另存一份 API key。
 */
const ASTRBOT_CFG = 'E:/_bot/astrbot/AstrBot-master/data/cmd_config.json'

function visionEndpoint() {
  const cfg = JSON.parse(readFileSync(ASTRBOT_CFG, 'utf8').replace(/^\uFEFF/, ''))
  const provs = cfg.provider || []
  const srcs = cfg.provider_sources || []
  // 优先 workbuddy 代理（免费、已实测支持图片）；没有就退到 aliyun
  const want = String(process.env.DOUYIN_VISION_PROVIDER || 'workbuddy-deepseek-v41-flash').trim()
  const p = provs.find((x) => x.id === want) || provs.find((x) => /workbuddy/i.test(String(x.id)))
  if (!p) return null
  const s = srcs.find((x) => x.id === p.provider_source_id)
  if (!s) return null
  const key = Array.isArray(s.key) ? s.key[0] : s.key
  return { base: String(s.api_base || ''), key: String(key || ''), model: String(p.model || '') }
}

/**
 * 让视觉模型描述一张图。
 *
 * `prompt` 传了就覆盖默认提示词 —— 整段视频的宫格图必须用自己的提示词
 * （要说明"这是同一视频按时间顺序的 N 帧、怎么读宫格、必须说出动作变化"），
 * 用默认那句「用一两句话（40 字以内）说这张图」会把 6 帧当成 1 张静态图，白瞎。
 *
 * @returns {Promise<{ok:boolean, text?:string, error?:string, ms:number}>}
 */
export async function describeImage(dataUri, { timeoutMs = 40_000, maxTokens = 120, prompt = '' } = {}) {
  const t0 = Date.now()
  const ep = visionEndpoint()
  if (!ep || !ep.base) return { ok: false, error: 'no_vision_provider', ms: 0 }
  const ask = prompt || '用一两句话（40 字以内）说这张图里在发生什么：谁、在做什么、场景。不要评价、不要加形容词堆砌，单纯描述看清楚的事实。'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(ep.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ep.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ep.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: ask },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const body = await r.text()
    if (!r.ok) return { ok: false, error: 'http_' + r.status + ':' + body.slice(0, 80), ms: Date.now() - t0 }
    const j = JSON.parse(body)
    const txt = String(j?.choices?.[0]?.message?.content || '').trim()
    if (!txt) return { ok: false, error: 'empty_reply', ms: Date.now() - t0 }
    return { ok: true, text: txt, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 }
  }
}

/**
 * ⭐ 2026-11-10 新增：图文作品里**第 i 张图**的提示词。
 *
 * 为什么不复用默认那句：默认那句只问「谁在做什么」，**明确禁止读字**
 * （"单纯描述看清楚的事实"）。而图文作品的正文常常就在图里 ——
 * 长图、手写笔记、聊天截图、ppt、书页。不读字等于没看。
 *
 * 措辞里刻意做了三件事：
 *   ① 先把图里的字**逐字抄下来**（模型抄字的准确率远高于"总结大意"）；
 *   ② 再说明这张图是什么（照片/截图/长图/拼图/纯文字）；
 *   ③ 明确它是 N 张里的第几张 —— 否则模型会把每张都当成独立作品，
 *      说不清「这是同一条图文里的第 2 张」。
 *
 * 上限放到 900 token：一张信息量大的长图，逐字抄 + 描述，400 token 不够。
 */
function imagePostPrompt(idx, total) {
  const which = total > 1 ? `这是同一条图文作品里的第 ${idx} 张（一共 ${total} 张）。` : ''
  return [
    which + '请仔细看这张图，按下面顺序说，不要跳步：',
    '① 把图里能看清的文字**尽量逐字抄下来**（标题、正文、字幕、对话气泡、水印、按钮、数字都算）。',
    '   文字是这张图最重要的内容，抄的时候不要总结、不要改写成通顺的句子。',
    '② 再说这张图是什么形态：照片 / 手机截图 / 聊天记录 / 长图 / 拼图 / 纯文字卡片 / 表格。',
    '③ 最后用一两句话说清画面里在发生什么（谁、在哪、在做什么）。',
    '抄不出文字就说「图里没有可读的文字」，绝对不要编。总长度 200 字以内，文字多可以更长。',
  ].join('\n')
}

/**
 * 视频「只看到封面」时的提示词。
 *
 * 老代码这里走的是默认那句（40 字、不读字）。封面同样会带字幕/标题/水印，
 * 而只看到封面时她唯一的信息源就是这一帧 —— 更该把字读出来。
 */
function coverPrompt() {
  return [
    '这是短视频的封面这一帧。请说清：',
    '① 画面里的文字（标题、字幕、水印、贴纸上的字），能看清就逐字抄下来；',
    '② 画面里是谁、在做什么、什么场景；',
    '③ 这是封面，不是整段视频 —— 只说这一帧里看得见的东西，不要推测前后发生了什么。',
    '120 字以内。',
  ].join('\n')
}

/** 进程内缓存（同一个 item_id 一次运行里只解析一次，别重复下载 + 重复调模型） */
const CACHE = new Map()

/**
 * 解析一个视频卡片：这视频是什么。
 *
 * @param {{ev:Function}} conn      chrome.mjs 的连接对象（没有就跳过，返回 conn_missing）
 * @param {string} itemId           卡片里的 itemId
 * @returns {Promise<{ok:boolean, seen:boolean, desc?:string, scene?:string,
 *                    detail?:object, error?:string, cached?:boolean}>}
 *   `desc`  是「给模型看的视频说明」（文案 + 时长 + 作者 + 数据 + 话题）
 *   `scene` 是「画面里在发生什么」（视觉模型说的那一两句）
 */
export async function understandVideoCard(conn, itemId, { withVision = true } = {}) {
  const id = String(itemId || '').trim()
  if (!/^\d{6,}$/.test(id)) return { ok: false, seen: false, error: 'bad_item_id' }
  if (CACHE.has(id)) return { ...CACHE.get(id), cached: true }
  if (!conn || typeof conn.ev !== 'function') return { ok: false, seen: false, error: 'conn_missing' }

  const det = await fetchAwemeDetail(conn, id)
  if (!det.ok || !det.detail) {
    const out = { ok: false, seen: false, error: det.error || 'detail_failed' }
    // 🔴 2026-11-08：抖音自己给的原因要透传出去。
    // `no_detail` 有两种完全不同的情况，混成一句话她就只能瞎编：
    //   · filter_reason = status_self_see → 作品被作者设私密/删了（老实说「这条没了」）
    //   · 其它 → 我们这边读不到（被风控 / 接口变了）
    if (det.filter_msg) out.filter_msg = String(det.filter_msg)
    if (det.filter_reason) out.filter_reason = String(det.filter_reason)
    // 失败也缓存 3 分钟太久，干脆不缓存，下次还能试
    return out
  }
  const detail = det.detail
  const desc = describeVideo(detail)

  let scene = ''
  let visionErr = ''
  let howSeen = ''
  /** 图文作品实际看清楚的张数（用来说明「一共 N 张、只看了前 K 张」） */
  let imagesSeen = 0

  // ⭐ 2026-10-27 整段视频抽帧（新）：视频作品优先走"抽 N 帧拼宫格"，
  //    因为封面只是**作者挑的那一帧**，凡是有过程的视频全瞎。
  //    实测同一条 34 秒「i love deepseek」：
  //      封面 → 「一只橙白相间的猫在室内白色桌架旁低头站立」（压根不是同一条片子的画面）
  //      抽帧 → 「戴眼镜的男子先抚摸蓝发小女孩的头，看她写下 I love deepseek；
  //              随后女孩在夜市、小吃摊边跟随他，最后双手将画有她笑脸的卡片举起」
  //    洋葱猫那条封面也给不出「眼角带泪、表情委屈」。
  //    ⇒ 视频作品：先试抽帧；抽帧不可用（没 ffmpeg / 视频太大太长 / 下载失败）才回落到封面。
  //    图文作品（aweme_type=68）本来就没有视频流，直接走下面的 images[] 分支。
  if (withVision && !detail.is_image_post) {
    const srcUrl = detail.play_low || (Array.isArray(detail.play_gears) && detail.play_gears.length
      ? detail.play_gears[detail.play_gears.length - 1].url
      : '')
    if (srcUrl) {
      const g = await videoToGrid(srcUrl, detail.duration_ms)
      if (g.ok && g.dataUri) {
        const v = await describeImage(g.dataUri, {
          /**
           * 240 → 420（2026-11-01）。
           *
           * 提示词从「80 字描述动作」改成「150 字 + 可以报人名」之后，240 token
           * 会在句子中间截断（中文 1 字约 1.5 token，150 字要 220+，
           * 加上模型有时多写几句就爆了）。截断的后果比说少更糟 ——
           * 会得到半句「画面中是一位穿中山装的男子，他」这种。
           * 420 只是上限，模型不会真写满。
           */
          maxTokens: 420,
          prompt: gridPrompt(g.frames, g.cols, g.rows, { durationMs: detail.duration_ms, desc: detail.desc }),
        })
        if (v.ok && v.text) {
          scene = v.text
          howSeen = `frames:${g.frames}(${g.cols}x${g.rows})`
        } else {
          visionErr = v.error || 'vision_failed'
        }
      } else {
        // 抽帧失败不当作错误刷屏，记下原因然后回落封面
        visionErr = 'grid_skip:' + (g.error || 'unknown')
      }
    }
  }

  // 回落 / 图文分支：图集最多看 6 张（图文作品）/ 3 张（视频兜底封面只取 1 张）
  if (!scene) {
    /**
     * 🔴 2026-11-10：`slice(0,3)` 是识图不全的第一道闸。
     *
     * 图文作品实测常见 6~9 张，前 3 张往往只是开场，重点在中间和后段
     * （长图叙事、多图对比、最后一张给结论）。只取 3 张 = 只读了开头，
     * 她却以为自己看完了 —— 这正是「发了个图文她没读明白」的一半原因。
     * `detail.images` 本身在 `video-understand.mjs` 已截到 9，这里放到 6 是
     * 兼顾「看得全」和「一次 Promise.all 的并发与耗时」。
     */
    const imgUrls = Array.isArray(detail.images) && detail.images.length
      ? detail.images.slice(0, 6).map((x) => x.url).filter(Boolean)
      : (detail.cover ? [detail.cover] : [])

    if (withVision && imgUrls.length) {
      /**
       * 🔴 2026-11-08：这个分支原来是**逐张串行** ——
       *
       *       for (const u of imgUrls) {
       *         const img = await fetchImageAsDataUri(u)   // 15 秒上限
       *         const v = await describeImage(...)          // 40 秒上限
       *       }
       *
       *    实测代价：一条图文作品（8 张，取前 3 张）跑完要 **145~175 秒**。
       *    3 × (下载 + 视觉) 最坏 165 秒，而 `videoLookBudget` 当时配的是 75
       *    ⇒ 脚本 75 秒就被 kill 成 `look-timeout`，画面一个字都拿不到。
       *    日志里 36 次「没看到画面」全是这个（另一层是 _sweep_pages 抢页面）。
       *
       *    这三张之间没有任何依赖（不同 URL、不同请求），没有理由排队。
       *    改并发后耗时从「3 × 单张」降到「max(单张)」。
       *
       *    为什么用 Promise.all 拿数组而不是边完成边 push：`scenes` 的顺序
       *    必须跟图集顺序一致（第一张通常是封面 / 最关键那张），
       *    Promise.all 保序，push 不保序。
       *
       * 另外保留 2026-11-03 那条修法：`describeImage` 必须显式传 `maxTokens: 420`。
       * 它的默认值是 120，会在句中截断 —— 抽帧那条路早就传了，封面这条漏过一年多。
       * 什么时候会走到这里：抽帧不可用（没 ffmpeg / 视频太大太长 / 下载失败 /
       * 图集作品）。实测日志里 `grid_skip:` 并不罕见，不是边角路径。
       */
      /**
       * 🔴 2026-11-10 修（识图核心）：图文作品原来是「每张图都用默认那句
       *   『用一两句话（40 字以内）说这张图里在发生什么』」。
       *
       * 事故：使用者发了一条图文作品，她回得驴唇不对马嘴。查下来这条链路给了她
       * 三张图、每张 40 字，而这 40 字只描述「谁在做什么」，**图里的字一个都不读**。
       * 图文作品的正文常常就是图里的文字（长图、截图、笔记、聊天记录），
       * 40 字的画面描述等于什么都没看到。
       *
       * 所以图集分支单独给一个 prompt：先逐字读文字，再描述画面。
       * 上限也从 3 张放到 6 张 —— 图文作品动辄 6~9 张，只看前 3 张会把后半段
       * （通常才是重点）整个丢掉。并发不变（同一批 Promise.all），
       * 耗时仍是「单张」而不是「张数 × 单张」。
       */
      const total = Array.isArray(detail.images) && detail.images.length ? detail.images.length : imgUrls.length
      const useN = Math.min(imgUrls.length, detail.is_image_post ? 6 : 3)
      const settled = await Promise.all(
        imgUrls.slice(0, useN).map(async (u, i) => {
          const img = await fetchImageAsDataUri(u)
          if (!img.ok) return { ok: false, error: img.error || 'cover_failed' }
          return await describeImage(img.dataUri, {
            maxTokens: detail.is_image_post ? 900 : 420,
            prompt: detail.is_image_post ? imagePostPrompt(i + 1, total) : coverPrompt(),
          })
        })
      )
      const scenes = []
      for (const v of settled) {
        if (v.ok && v.text) scenes.push(v.text)
        else visionErr = v.error || 'vision_failed'
      }
      // 用换行拼：每张图各自一段，模型不会把三张的内容糊成一段
      scene = scenes.join('\n')
      if (scene) howSeen = detail.is_image_post ? `images:${scenes.length}` : 'cover'
      if (detail.is_image_post) imagesSeen = scenes.length
    } else if (!imgUrls.length) {
      if (!visionErr) visionErr = 'no_cover'
    }
  }

  /**
   * ⭐ 2026-11-05 新增：转写视频里「说的话」。
   *
   * 为什么现在才有：`video-understand.mjs` 头部的注释一直写着「本机没有 ffmpeg，
   * 装不动」，所以整条链路只取了抽帧 + 文案 + 评论三样，**声音一个字都没拿**。
   * 那个前提早就不成立了（ffmpeg / sherpa_onnx / SenseVoice 三样都齐）。
   *
   * 为什么需要：口播型视频的 desc 常常只有「#日常 #vlog」几个字，光靠抽帧和
   * 评论拼不出它在讲什么 —— 唯一的线索就是它说了什么。使用者报「看不了完整
   * 视频文案」时，desc 截断是主因（已另修），这是紧跟着的第二层。
   *
   * 放在抽帧之后：抽帧那条分支已经算出 `srcUrl`，复用同一个直链，
   * 不用再解析一次详情。也放在 `withVision` 之内 —— 不要画面时也不需要听声音。
   *
   * 失败一律静默（`speech_error` 记原因）：转写是增强项，
   * 缺了不能让她连图都看不了。
   */
  let speech = ''
  let speechErr = ''
  if (withVision && !detail.is_image_post) {
    const sUrl = detail.play_low || (Array.isArray(detail.play_gears) && detail.play_gears.length
      ? detail.play_gears[detail.play_gears.length - 1].url
      : '')
    if (sUrl && sttAvailable()) {
      try {
        const t = await transcribeVideo(sUrl, { timeoutMs: 120_000 })
        if (t.ok && t.text && !t.empty) speech = t.text
        else if (!t.ok) speechErr = t.error || 'stt_failed'
      } catch (e) {
        speechErr = String((e && e.message) || e).slice(0, 120)
      }
    }
  }

  const out = {
    ok: true,
    // ⭐ 2026-11-05：原来只认 scene（画面）。但现在可能只听到声音、画面没抽出来
    // （抽帧失败 / 只看了封面），那也算「看过了」—— 光有 speech 也算，
    // 否则上层会以为她什么都没拿到，白白浪费一段转写。
    seen: Boolean(scene || speech),
    desc,
    scene,
    /**
     * ⭐ 2026-11-10 新增：图文作品的「一共几张 / 看清楚了前几张」。
     *
     * 以前只有 `how_seen: images:3`，上层拿到这个字符串没法判断「3 是全部还是前 3」。
     * 结果是她把只看了 3 张的图文当成看全了，回话说得理直气壮。
     * 现在把两个数字分开带出去，`lib/persona-llm.mjs` 会据此补一句
     * 「这条图文一共有 N 张，你只看到前 K 张」。
     */
    ...(imagesSeen ? { images_seen: imagesSeen } : {}),
    ...(Number(detail.images_total) > 0 ? { images_total: Number(detail.images_total) } : {}),
    // speech: 视频里说的话（转写）。空串 = 没转出来 / 这条没人说话 / 转写不可用。
    ...(speech ? { speech } : {}),
    ...(speechErr ? { speech_error: speechErr } : {}),
    detail,
    // how_seen: frames:N(colsxrows) = 整段抽帧 / images:N = 图集看了 N 张 / cover = 只看了封面
    ...(howSeen ? { how_seen: howSeen } : {}),
    ...(visionErr ? { vision_error: visionErr } : {}),
  }
  CACHE.set(id, out)
  // 只留最近 50 个，防止长跑把内存吃掉
  if (CACHE.size > 50) CACHE.delete(CACHE.keys().next().value)
  return out
}

/** 测试 / 手工排查用 */
export function clearVideoCache() {
  CACHE.clear()
}
