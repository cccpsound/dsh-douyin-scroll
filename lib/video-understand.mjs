/**
 * 视频理解：给定 aweme_id，拿到「这视频在讲什么」。
 *
 * 为什么是「封面 + 文案」而不是「整段视频」：
 *   本机没有 ffmpeg（`shutil.which('ffmpeg')` 为 None），装不动；
 *   抖音的视频流是分片 m3u8 / 带签名的 mp4，抽帧要么下整段（几十 MB）要么自己解容器。
 *   而 cover 图就是**作者挑的那一帧**（通常是信息量最大的一帧），加上 desc 文案和
 *   统计数据，模型已经能说出「这是个什么视频、大概在讲什么」。
 *
 * 实测（2026-10-25，aweme 7699467792935931190）：
 *   封面 → 「一只黑色的小狗坐在水磨石地板上，旁边有一个装有食物的金属碗，
 *           左侧有一只手正拿着红色的零食喂它。」
 *   配上 desc「即便是不完美的小孩，你也一定能成为很棒的大人！」之后，
 *   能答出这是个讲成长的剧情短片，而不是「一只狗」。
 *
 * 拿不到就如实返回 unknown —— 绝不编。编错了对方一眼就看穿。
 */

import { fitDesc } from './desc.mjs'
import { createDecipheriv } from 'node:crypto'

/**
 * 抖音私信图床的解密。
 *
 * 背景（2026-11-10 实测）：私信里别人发的图片 / 动图，`resource_url` 里那几个
 * `origin_url_list / large_url_list / still_url_list` **不是图片**，是密文 ——
 * 直接 GET 回来的字节头是 `f2ec6d2a d8a543e9 …` 这种，跟 JPEG(ffd8ff) /
 * PNG(89504e) / GIF(474946) / WEBP(52494646) 全不沾边。
 *
 * 格式是 AES-256-GCM，三段拼接：
 *   nonce(12 字节) || ciphertext || tag(16 字节)
 * 密钥就藏在同一个 resource_url 里的 `skey`（64 位 hex ⇒ 32 字节）。
 *
 * 验证过的事实（不是猜的）：
 *   · 解密后的字节数 **严格等于** `resource_url.data_size`
 *     （下载 38426B = 12 + 38398 + 16，data_size 正是 38398）；
 *   · 解密出来是合法 JPEG（388x388）/ GIF（240x242，23 帧）/ WEBP（静帧）；
 *   · 拿解密后的图去喂视觉模型，正常出文字；喂密文则 502
 *     `upstream_error: Please start a new conversation, replace the image`。
 *
 * 也就是说：**不解密，视觉模型永远看不到任何私信图片。**
 * 这条链路以前完全没接上，是「她读不懂图」的物理层根因。
 *
 * @returns {Buffer|null} 解密成功返回明文，失败/密钥不对返回 null
 */
export function decryptDouyinImage(buf, skey) {
  const key = String(skey || '').trim()
  if (!Buffer.isBuffer(buf) || buf.length < 12 + 16 + 1) return null
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return null
  try {
    const k = Buffer.from(key, 'hex')
    const nonce = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const d = createDecipheriv('aes-256-gcm', k, nonce)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()])
  } catch {
    // 密钥不匹配 / 数据截断 —— GCM 的 auth tag 会拒。安静返回 null，不要抛。
    return null
  }
}

/** 从文件头判断图片格式。判不出返回 ''（调用方据此决定是不是密文） */
export function sniffImageMime(b) {
  if (!b || !b.length) return ''
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  return ''
}

/** 造 data URI。isGif 的动图取静帧时 mime 可能是 webp，按真实字节走 */
export function bufferToDataUri(b) {
  const mime = sniffImageMime(b)
  if (!mime) return ''
  return `data:${mime};base64,${b.toString('base64')}`
}

/** 抖音 web 端公共参数（照抄评论接口那套，实测同一份够用） */
const COMMON = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1424',
  screen_height: '805',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '156.0.0.0',
}

const qs = (o) =>
  Object.keys(o)
    .map((k) => k + '=' + encodeURIComponent(o[k]))
    .join('&')

/**
 * 在**页面内**用 fetch 拿视频详情。
 *
 * 为什么必须在页面里：`/aweme/v1/web/aweme/detail/` 带签名校验（`X-Bogus`/`a_bogus`），
 * Node 侧直连会拿到空 body 或 200 + `status_code: 8`。页面上由 webmssdk 自动补齐。
 *
 * @param {{ev:Function}} conn  chrome.mjs 的连接对象
 * @param {string} awemeId
 * @returns {Promise<{ok:boolean, detail?:object, error?:string}>}
 */
export async function fetchAwemeDetail(conn, awemeId) {
  const id = String(awemeId || '').trim()
  if (!/^\d{6,}$/.test(id)) return { ok: false, error: 'bad_aweme_id' }

  const code = `
  (async () => {
    try {
      const url = '/aweme/v1/web/aweme/detail/?' + ${JSON.stringify(qs(COMMON))} + '&aweme_id=' + encodeURIComponent('${id}')
      const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch (e) {
        return JSON.stringify({ ok: false, error: 'bad_json', len: t.length, head: t.slice(0, 120) })
      }
      if (j.status_code !== 0) {
        return JSON.stringify({ ok: false, error: 'status_' + j.status_code })
      }
      const a = j.aweme_detail || (j.aweme_details && j.aweme_details[0])
      if (!a) {
        // 🔴 2026-11-08：把抖音自己给的原因带出去。
        //
        // 以前一律返回 no_detail，上层只能说「没看到画面」—— 她于是要么
        // 装看不见、要么顺着文案编。但接口其实写得很清楚：
        //
        //   filter_detail: {
        //     aweme_id: "7704749661110764518",
        //     detail_msg: "因作品权限或已被删除，无法观看，去看看其他作品吧",
        //     filter_reason: "status_self_see",
        //   }
        //
        // status_self_see = 作者设成了仅自己可见 / 已删。
        // 这跟「我们被风控了」完全是两件事，必须分开告诉她 ——
        // 前者是她可以老实说的「这条没了」，后者是「我这边暂时读不了」。
        //
        // ⚠️ 这段在模板字符串里，注释中禁止出现反引号。
        const fd = j.filter_detail || {}
        return JSON.stringify({
          ok: false,
          error: 'no_detail',
          filter_msg: String(fd.detail_msg || ''),
          filter_reason: String(fd.filter_reason || ''),
        })
      }
      const pick = (o) => o && o.url_list && o.url_list.length ? o.url_list[0] : ''
      // ⭐ 2026-10-27 新增：图文作品（aweme_type=68 / media_type=2）没有 video 字段，
      //    图片全在 a.images[] 里，每项是 {uri, url_list[], width, height, ...}。
      //    以前只取 a.video.origin_cover ⇒ 图文作品的 cover 永远是空 ⇒ 视觉模型看不到任何东西。
      //    实测（2026-10-27，搜索"图文"取 18 条样本）：aweme_type=68 且 media_type=2，
      //    images[0].url_list 有 3 个候选直链，取第一个可下（76KB webp，带 Referer 不 403）。
      const imgs = (a.images && a.images.length)
        ? a.images.slice(0, 9).map(function (im) {
            return {
              url: pick(im),
              w: (im && im.width) || 0,
              h: (im && im.height) || 0,
            }
          }).filter(function (x) { return x.url })
        : []
      const isImagePost = imgs.length > 0
      return JSON.stringify({
        ok: true,
        detail: {
          aweme_id: String(a.aweme_id || ''),
          desc: String(a.desc || ''),
          create_time: a.create_time || 0,
          duration_ms: (a.video && a.video.duration) || 0,
          author: (a.author && a.author.nickname) || '',
          author_uid: (a.author && String(a.author.uid)) || '',
          music: (a.music && a.music.title) || '',
          tags: (a.text_extra || []).map(function (x) { return x.hashtag_name }).filter(Boolean).slice(0, 6),
          stats: {
            digg: (a.statistics && a.statistics.digg_count) || 0,
            comment: (a.statistics && a.statistics.comment_count) || 0,
            share: (a.statistics && a.statistics.share_count) || 0,
          },
          // 图文作品：cover = 第一张图（视觉模型照常用）；视频：还是 origin_cover
          cover: isImagePost
            ? imgs[0].url
            : (pick(a.video && a.video.origin_cover) || pick(a.video && a.video.cover)),
          images: imgs,
          /**
           * ⭐ 2026-11-10 新增：这条图文**一共有几张**。
           *
           * images 在上面被 slice(0,9) 截过，所以它的 length 不等于总数 ——
           * 少了这个字段，上层没法说「一共 N 张、你只看了前 K 张」，
           * 她就会把只看了 3 张的图文当成看全了。
           * 拿不到 a.images 时退回 imgs.length（此时两者相同，不影响判断）。
           */
          images_total: Array.isArray(a.images) && a.images.length ? a.images.length : imgs.length,
          is_image_post: isImagePost,
          // aweme_type: 0=视频 / 68=图集（抖音现行）；media_type: 4=视频 / 2=图集
          aweme_type: (a.aweme_type === undefined ? 0 : a.aweme_type),
          media_type: (a.media_type === undefined ? 0 : a.media_type),
          has_play: Boolean(pick(a.video && a.video.play_addr)),
          // ⭐ 2026-10-27 新增：整段视频抽帧要用的播放直链。
          //    抖音详情接口给的是**标准 mp4**（不是 m3u8 分片），video.bit_rate[] 有十几档，
          //    每档 {gear_name, bit_rate, play_addr:{url_list[], width, height}}。
          //    实测 17 秒视频最低档 540_6_1 只有 334kbps / 691886 字节 / 248ms 下完，
          //    34 秒视频 1.80MB / 345ms —— 对"看懂剧情"来说这个清晰度完全够。
          //    取最低档是为了省流量和时间，不是省画质：抽帧之后还会 scale 到 540 宽再拼宫格。
          play_low: pick((a.video && a.video.bit_rate && a.video.bit_rate.length
            ? a.video.bit_rate[a.video.bit_rate.length - 1].play_addr
            : null)),
          play_gears: (a.video && a.video.bit_rate && a.video.bit_rate.length)
            ? a.video.bit_rate.map(function (b) {
                return {
                  gear: b.gear_name || '',
                  br: b.bit_rate || 0,
                  url: pick(b.play_addr),
                  w: (b.play_addr && b.play_addr.width) || 0,
                  h: (b.play_addr && b.play_addr.height) || 0,
                }
              }).filter(function (x) { return x.url })
            : [],
        },
      })
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e).slice(0, 120) })
    }
  })()
  `
  try {
    const raw = await conn.ev(code)
    return JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) }
  }
}

/**
 * 下载图片转成 data URI（给模型内联用）。
 *
 * 为什么要自己下：抖音的封面 url 带 `x-signature` 和 `x-expires`，
 * 直接把 URL 交给模型端（多数网关**不会**替你取图，它们要求 data URI 或公网可达地址）。
 * 实测 workbuddy 代理直接把 https 地址塞进 image_url 会 500。
 *
 * 上限 3MB：一张封面 30~200KB，3MB 足够，也避免把网关打爆。
 */
export async function fetchImageAsDataUri(url, { maxBytes = 3 * 1024 * 1024, timeoutMs = 15_000, skey = '' } = {}) {
  if (!url) return { ok: false, error: 'empty_url' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // 抖音图床对 Referer 敏感，少了会 403
        Referer: 'https://www.douyin.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        // 图床有时直接按 Accept 决定给原图还是给 webp/avif 变体；
        // 不写会拿到 `Content-Type: application/octet-stream` 的加密流
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    clearTimeout(timer)
    if (!r.ok) return { ok: false, error: 'http_' + r.status }
    const buf0 = Buffer.from(await r.arrayBuffer())
    if (!buf0.length) return { ok: false, error: 'empty_body' }
    if (buf0.length > maxBytes) return { ok: false, error: 'too_large', bytes: buf0.length }

    /**
     * 🔴 2026-11-10：这里原来是「文件头判格式，判不出就当 jpeg」——
     * 而抖音私信图床回来的本来就是密文，于是密文被贴上 `data:image/jpeg`
     * 送进视觉模型，上游 502。判不出格式时必须先尝试用 skey 解密，
     * 解不出来就老实报 `encrypted_no_key`，绝不把密文当图片。
     */
    let mime = sniffImageMime(buf0)
    let buf = buf0
    let decrypted = false
    if (!mime && skey) {
      const dec = decryptDouyinImage(buf0, skey)
      if (dec && dec.length) {
        mime = sniffImageMime(dec)
        if (mime) { buf = dec; decrypted = true }
      }
    }
    if (!mime) {
      const ct = String(r.headers.get('content-type') || '')
      if (ct.startsWith('image/') && !skey) mime = ct.split(';')[0]
      // 有 skey 但还是判不出来 ⇒ 是密文且密钥不对，别硬塞
      if (!mime) return { ok: false, error: skey ? 'decrypt_failed' : 'not_an_image', bytes: buf0.length, head: buf0.subarray(0, 8).toString('hex') }
    }
    return {
      ok: true,
      dataUri: `data:${mime};base64,${buf.toString('base64')}`,
      bytes: buf.length,
      mime,
      ...(decrypted ? { decrypted: true, raw_bytes: buf0.length } : {}),
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) }
  }
}

/**
 * 把视频信息压缩成一句「给模型看的话」。
 *
 * 只给能用得上的：文案、时长、作者、数据表现、话题。
 * 不塞原始 JSON —— 模型会被一堆字段名带跑偏。
 */
export function describeVideo(detail) {
  if (!detail) return ''
  const bits = []
  const desc = String(detail.desc || '').trim()
  /**
   * 🔴 2026-11-05 第五次改：不再按字数切，改用共用的 fitDesc（上限 2000 + 软截断）。
   *
   * 前四次（120→280 等）都在调大数字，但理由写错了：「抖音正文上限 55 个汉字，
   * 280 留了余量」。长文文案是抖音一等公民 —— 使用者贴的 @Dionysus 尼采长文
   * 实测 900+ 字，280 只能读到「翻出那本八块钱买的盗版《查…」，
   * 瓦格纳、莎乐美、都灵抱马全在后面全被砍掉，她还以为自己读的是全文。
   *
   * 现在超上限会在自然断点收尾并注明「后面还有 N 字」，她知道这是长文、
   * 知道自己只读了前半。
   */
  if (desc) bits.push(fitDesc(desc))
  // ⭐ 2026-10-27：图文作品必须点明「这是 N 张图」，否则模型会按视频的口吻回
  //    （"我看到视频里…"），对方一看就知道没真看。
  if (detail.is_image_post) {
    /**
     * 🔴 2026-11-10：张数要用 `images_total`（真实总数），不是 `images.length`。
     * `images` 在抓取时已被 slice(0,9)，用它报数会把「12 张」说成「9 张」，
     * 于是她以为图文就看这么多，后面被截掉的张数永远不会出现在她脑子里。
     */
    const n = Number(detail.images_total) || (Array.isArray(detail.images) ? detail.images.length : 0)
    bits.push(`图文作品（${n} 张图，不是视频）`)
  }
  const sec = Math.round((detail.duration_ms || 0) / 1000)
  if (sec > 0) bits.push(`${Math.floor(sec / 60)}分${sec % 60}秒` || '')
  if (detail.author) bits.push('@' + detail.author)
  const s = detail.stats || {}
  if (s.digg >= 10000) bits.push(`${(s.digg / 10000).toFixed(1)}万赞`)
  else if (s.digg > 0) bits.push(`${s.digg}赞`)
  if (s.comment >= 1000) bits.push(`${Math.round(s.comment / 1000)}千评论`)
  if (detail.tags && detail.tags.length) bits.push(detail.tags.slice(0, 3).map((t) => '#' + t).join(' '))
  return bits.filter(Boolean).join('，')
}
