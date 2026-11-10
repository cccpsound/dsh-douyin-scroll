#!/usr/bin/env node
/**
 * tools/video-oneshot.mjs —— 「挑一条视频 + 看一眼它讲什么」跑一轮就退出
 * ============================================================================
 * 给 AstrBot 侧的 xj_douyin 用（第 8/10 项迁移：主动发视频 + 刷推荐流）。
 *
 * 三步：
 *   ① `forward-pick.py --json --limit N` 拉候选（只读、不签名、不碰写接口）
 *   ② 读这条作品下的高赞评论（`comment-read-page.mjs`，页面内 fetch，绕过签名器）
 *   ③ 对排第一的那条 `understandVideoCard()` 抽帧看图 → 拿到 scene（画面里发生什么）
 *
 * 为什么要连评论一起拿（2026-10-28 用户要求「让她看视频和视频中的评论，还有文案」）：
 *   文案常常是标题党（`#挑战回家不摸狗`），画面只说明「发生了什么」，
 *   **为什么好笑 / 观众在笑哪一点，全在评论里**。缺了评论她只能描述画面，
 *   发出去像监控回放；有评论才像「刷到个好玩的，给你看」。
 *
 * 为什么拆成一次一进程：AstrBot 跑在事件循环里，浏览器连接不能跨进程持有；
 * 而且这条路一崩就会拖住整轮私信轮询，独立进程崩了只是这一轮没视频。
 *
 * 用法：
 *   node tools/video-oneshot.mjs                 # 取 5 条候选，看第一条
 *   node tools/video-oneshot.mjs --limit 8
 *   node tools/video-oneshot.mjs --no-vision     # 只看文案不看画面（快、省 token）
 *   node tools/video-oneshot.mjs --skip id1,id2  # 这些 aweme_id 已经发过，别重复挑
 *   node tools/video-oneshot.mjs --no-comments   # 不读评论（快 10 秒左右）
 *   node tools/video-oneshot.mjs --cmt 8         # 读几条评论（默认 6）
 *
 * 输出（单行 JSON）：
 *   {"ok":true,"picked":{aweme_id,desc,author,share_url,digg,comment,duration_s,
 *                        scene,how_seen,cmts:[{text,digg,nick}]},
 *    "candidates":N,"ms":1234}
 *   picked 为 null = 这轮没挑到（候选为空 / 全被 skip 掉了）
 * ============================================================================
 */
import { spawnSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { nodeRunner } from '../lib/quiet.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}
const LIMIT = Math.max(1, Math.min(Number(argOf('--limit', '5')) || 5, 12))
const NO_VISION = argv.includes('--no-vision')
const NO_COMMENTS = argv.includes('--no-comments')
const CMT_N = Math.max(1, Math.min(Number(argOf('--cmt', '6')) || 6, 12))
const SKIP = new Set(
  String(argOf('--skip', ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

const ROOT = join(import.meta.dirname, '..')
const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')

const out = (o) => {
  process.stdout.write(JSON.stringify(o) + '\n')
  process.exit(o.ok ? 0 : 1)
}

const t0 = Date.now()
const py = process.env.DOUYIN_PY || join(HOME, '.venv', 'Scripts', 'pythonw.exe')
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME }

const pickJson = (s) => {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

// ── ① 拉候选 ──────────────────────────────────────────────────────────
const r = spawnSync(py, [join(ROOT, 'tools', 'forward-pick.py'), '--json', '--limit', String(LIMIT)], {
  encoding: 'utf8',
  timeout: 180000,
  env,
  cwd: ROOT,
  windowsHide: true,
})
const j = pickJson(String(r.stdout || ''))
if (!j || !j.ok) {
  out({
    ok: false,
    error: (String(r.stderr || '') || String(r.stdout || '') || 'forward-pick-failed').slice(-260),
    ms: Date.now() - t0,
  })
}

const rows = (j.rows || []).filter((x) => x && x.aweme_id && !SKIP.has(String(x.aweme_id)))
if (!rows.length) out({ ok: true, picked: null, candidates: 0, note: '没有可挑的（候选空 / 全在 skip 里）', ms: Date.now() - t0 })

const c0 = rows[0]
const picked = {
  aweme_id: String(c0.aweme_id),
  desc: String(c0.desc || ''),
  author: String(c0.author || ''),
  share_url: String(c0.share_url || ''),
  digg: c0.digg || 0,
  comment: c0.comment || 0,
  duration_s: c0.duration_s || 0,
  is_image: !!c0.is_image,
  scene: '',
  how_seen: '',
  cmts: [],
}

// ── ② 读高赞评论 ──────────────────────────────────────────────────────
/**
 * 评论比文案可靠得多：
 *   `#火箭云 只能说太壮观了` 这种文案等于没说，评论里才知道「原来这不是火箭尾迹」
 *   「别人拍的，我觉得艺术成分很高」这种才是这条为什么火的真正原因。
 * 抓取走 comment-read-page.mjs（页面内 fetch + 页面自己签名），
 * 失败就当没有 —— 别让读评论把整轮拖死。
 */
if (!NO_COMMENTS) {
  try {
    const cr = spawnSync(
      nodeRunner(),
      [join(ROOT, 'tools', 'comment-read-page.mjs'), '--aweme', picked.aweme_id, '--count', '20', '--pages', '1'],
      { encoding: 'utf8', timeout: 60000, env, cwd: ROOT, windowsHide: true }
    )
    const cj = pickJson(String(cr.stdout || ''))
    const raw = (cj && (cj.comments || cj.items)) || []
    const rows2 = raw
      .map((c) => ({
        text: String(c.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80),
        digg: Number(c.digg || c.digg_count || 0) || 0,
        nick: String(c.nickname || c.nick || '')
          .trim()
          .slice(0, 16),
      }))
      // 纯表情 / 纯符号 / 太短的不算「有信息量」—— 它们能证明这视频好笑，
      // 但没法拿来理解内容，喂给模型只会占位置。
      .filter((c) => c.text.length >= 4 && /[一-鿿]/.test(c.text))
    rows2.sort((a, b) => b.digg - a.digg)
    // 同一条评论被置顶 + 热门重复列出时去个重
    const seen = new Set()
    picked.cmts = rows2.filter((c) => (seen.has(c.text) ? false : seen.add(c.text))).slice(0, CMT_N)
  } catch (e) {
    picked.comments_error = String((e && e.message) || e).slice(0, 100)
  }
}

// ── ③ 看一眼它讲什么 ──────────────────────────────────────────────────
if (!NO_VISION) {
  try {
    const { openPage } = await import('../lib/chrome.mjs')
    const { understandVideoCard } = await import('../lib/video-card.mjs')
    const conn = await openPage({ url: 'https://www.douyin.com/' })
    if (conn && conn.ev) {
      /**
       * ⚠️ 2026-11-05：45 秒 → 100 秒。
       *
       * 原来 45 秒只够「下视频 + 抽帧」（实测 34 秒片子约 12 秒）。
       * 现在同一条链路里还多了一步语音转写：ffmpeg 抽音轨 + SenseVoice 解码，
       * 实测 24 秒音频 2.0 秒、48 秒音频 2.5 秒，按 600 秒上限的视频估算
       * 约 20~40 秒。45 秒会先把转写掐掉一半，等于白接。
       *
       * 100 秒的取法：抽帧 12 秒 + 转写 40 秒 + 详情/评论 10 秒，再留 30 秒余量。
       * 超了仍然只靠文案（`v = null`），不会卡住整轮。
       */
      const v = await Promise.race([
        understandVideoCard(conn, picked.aweme_id),
        new Promise((z) => setTimeout(() => z(null), 100000)),
      ])
      if (v && v.ok) {
        picked.scene = String(v.scene || '')
        picked.how_seen = String(v.how_seen || '')
        // ⭐ 2026-11-05：视频里说的话（SenseVoice 转写）。
        // 之前只取 scene，转写结果在这一步被丢掉 —— 上层 `_video_prompt`
        // 就拿不到口播内容，口播型视频只剩几个话题标签可用。
        if (v.speech) picked.speech = String(v.speech)
      }
    }
  } catch (e) {
    // 看视频失败不影响「挑到了」这件事 —— 文案本身也够说一句
    picked.scene = ''
    picked.vision_error = String((e && e.message) || e).slice(0, 100)
  }
}

out({ ok: true, picked, candidates: rows.length, ms: Date.now() - t0 })
