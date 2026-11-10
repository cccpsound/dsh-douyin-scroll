/**
 * 探针：用页面内 fetch 拿视频详情，看能提取到什么信息。
 * 复用插件自己的 chrome 连接（不新开浏览器）。
 */
import { connectPage, pickPort } from '../lib/chrome.mjs'

const AWEME = process.argv[2] || '7699467792935931190'

const port = await pickPort()
const c = await connectPage(port)
console.log('CDP port:', port)

// 先确保在一个 douyin 页面上（fetch 要同源）
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const douyin = pages.find((p) => p.type === 'page' && /douyin\.com/.test(p.url || ''))
console.log('当前页面:', douyin?.url || '(无 douyin 页面)')

const code = `
(async () => {
  const qs = (o) => Object.keys(o).map(k => k + '=' + encodeURIComponent(o[k])).join('&')
  const COMMON = {
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
    pc_client_type: '1', version_code: '190500', version_name: '19.5.0',
    cookie_enabled: 'true', screen_width: '1424', screen_height: '805',
    browser_language: 'zh-CN', browser_platform: 'Win32',
    browser_name: 'Chrome', browser_version: '156.0.0.0',
  }
  const out = { tried: [] }
  const url = '/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, COMMON, { aweme_id: '${AWEME}' }))
  try {
    const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
    const t = await r.text()
    out.tried.push({ url, http: r.status, len: t.length })
    let j = null
    try { j = JSON.parse(t) } catch (e) { out.parse_error = String(e) }
    if (j) {
      out.status_code = j.status_code
      const a = j.aweme_detail || (j.aweme_details && j.aweme_details[0])
      if (a) {
        out.desc = a.desc
        out.create_time = a.create_time
        out.author = a.author && { nick: a.author.nickname, uid: a.author.uid }
        out.stats = a.statistics && {
          digg: a.statistics.digg_count, comment: a.statistics.comment_count,
          share: a.statistics.share_count, play: a.statistics.play_count,
        }
        out.duration_ms = a.video && a.video.duration
        out.has_play_addr = Boolean(a.video && a.video.play_addr && a.video.play_addr.url_list && a.video.play_addr.url_list.length)
        out.play_url_sample = a.video && a.video.play_addr && a.video.play_addr.url_list && a.video.play_addr.url_list[0]
          ? String(a.video.play_addr.url_list[0]).slice(0, 100) : null
        out.cover = a.video && a.video.cover && a.video.cover.url_list && a.video.cover.url_list[0] || null
        out.origin_cover = a.video && a.video.origin_cover && a.video.origin_cover.url_list && a.video.origin_cover.url_list[0] || null
        // 视频自带字幕？
        out.has_caption = Boolean(a.video && (a.video.caption_info || a.video.cla_info))
        out.music = a.music && { title: a.music.title, author: a.music.author }
        // 文案里的话题标签
        out.text_extra = (a.text_extra || []).map(x => x.hashtag_name).filter(Boolean)
      } else {
        out.no_aweme_detail = Object.keys(j).slice(0, 12)
      }
    }
  } catch (e) {
    out.fetch_error = String(e).slice(0, 200)
  }
  return JSON.stringify(out)
})()
`

const raw = await c.ev(code)
console.log(JSON.stringify(JSON.parse(raw), null, 2))
c.close()
