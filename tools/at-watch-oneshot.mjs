#!/usr/bin/env node
/**
 * tools/at-watch-oneshot.mjs —— 「跑一轮 @ 检查，把待回的列出来，然后立刻退出」
 * ============================================================================
 * 为什么要这个：AstrBot 的 xj_douyin 平台要接管评论区，但它跑在事件循环里，
 * 不能像以前那样挂一个 `at-me-watch.mjs --every 120` 常驻进程（两套状态会打架）。
 *
 * 所以把 at-me-watch.mjs 拆成两半：
 *   · **取 + 判重**（本文件）—— 复用 at-me-watch.mjs 的 `--dry` 输出，
 *     它会打出 `{"ok":true,"dry":true,"to":...,"text":...,"cid":...}` 这样的草稿行，
 *     但 **dry 不写 state**（见 at-me-watch.mjs 里那段注释），所以状态不会脏。
 *   · **生成 + 发送**（AstrBot 侧）—— 文字交给 AstrBot 的人设/梗库/记忆去说，
 *     发回走 comment-api.mjs。
 *
 * 用法：
 *   node tools/at-watch-oneshot.mjs                  # 只看这一轮有哪些要回
 *   node tools/at-watch-oneshot.mjs --max 5          # 一轮最多取几条
 *   node tools/at-watch-oneshot.mjs --no-video       # 不抽帧看视频（快，省 token）
 *
 * 输出（单行 JSON）：
 *   {"ok":true,"items":[{cid,aweme,to,isOwner,content,draft,seen}],
 *    "rateLimited":false,"ms":1234}
 *   items 为空 = 这一轮没有新的要回。
 * ============================================================================
 */
import { spawnSync } from 'child_process'
import { join } from 'path'
import { nodeRunner } from '../lib/quiet.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}
const MAX = Math.max(1, Math.min(Number(argOf('--max', '6')) || 6, 20))
const VIDEO_OFF = argv.includes('--no-video')
const ROOT = join(import.meta.dirname, '..')
const TOOL = join(ROOT, 'tools', 'at-me-watch.mjs')

const out = (o) => {
  process.stdout.write(JSON.stringify(o) + '\n')
  process.exit(o.ok ? 0 : 1)
}

const t0 = Date.now()
const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
if (VIDEO_OFF) env.DOUYIN_VIDEO_OFF = '1'
// 只跑一轮就退 —— 见 at-me-watch.mjs 里 ONCE 那段注释
env.DOUYIN_AT_ONCE = '1'

// at-me-watch 的 --dry 会走完整条「取通知 → 判重 → 想一句 → 打印草稿」，
// 但**不写 state**，正是我们要的：判重由它在内部完成，我们只收草稿。
const r = spawnSync(
  nodeRunner(),
  [TOOL, '--dry', '--max', String(MAX), '--max-tries', '1'],
  { encoding: 'utf8', timeout: 240000, env, cwd: ROOT, windowsHide: true }
)

const stdout = String(r.stdout || '')
const stderr = String(r.stderr || '')
const lines = stdout
  .split(String.fromCharCode(10))
  .map((s) => s.trim())
  .filter((s) => s.startsWith('{'))

const items = []
let rateLimited = false
let note = ''
for (const ln of lines) {
  let j = null
  try {
    j = JSON.parse(ln)
  } catch {
    continue
  }
  if (j.rate_limited) {
    rateLimited = true
    continue
  }
  if (j.tick === 'video_seen' || j.tick === 'video_fail' || j.tick === 'video_timeout') continue
  if (j.dry && j.cid) {
    items.push({
      cid: String(j.cid),
      aweme: String(j.aweme || ''),
      root: String(j.root || ''),
      to: String(j.to || ''),
      isOwner: !!j.is_owner,
      // 评论者的数字 uid —— AstrBot 侧用它拼 umo（douyin:FriendMessage:<uid>），
      // 让评论区这一问一答落进这个人的会话里，记忆和人设才接得上。
      uid: String(j.uid || ''),
      draft: String(j.text || ''),
      content: String(j.content || ''),
      // 🔴 2026-10-29 补：把「她看过这条视频」的证据带出去。
      // at-me-watch 里 understandVideoCard 抽帧看了 10~25 秒，原来只写进
      // tick:'video_seen' 日志，而这里恰好跳过 video_seen ⇒ 传不到 AstrBot 侧，
      // _reply_comment 只能瞎回。现在跟着 item 一起走。
      scene: String(j.scene || ''),
      vidDesc: String(j.vid_desc || ''),
      howSeen: String(j.how || ''),
    })
    continue
  }
  if (j.note && !j.dry) note = String(j.note).slice(0, 120)
}

if (r.status !== 0 && !items.length) {
  out({
    ok: false,
    error: (stderr || stdout || 'at-watch-failed').slice(-300),
    status: r.status,
    ms: Date.now() - t0,
  })
}

out({
  ok: true,
  items,
  count: items.length,
  rateLimited,
  note,
  ms: Date.now() - t0,
})
