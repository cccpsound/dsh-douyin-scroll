#!/usr/bin/env node
/**
 * tools/send-image.mjs —— 往抖音私聊 / 群聊发一张本地图片
 * ============================================================================
 * 为什么要单独写：抖音私信编辑器是 editor-kit 的 contenteditable，纯 `Input.insertText`
 * 只能打文字，打不进图。实测三条路都不行：
 *   ① 页面内构造 `ClipboardEvent('paste')` + DataTransfer → 事件能派发，编辑器不理。
 *   ② 点图标再按算出来的坐标点「发送（1）」→ modal 是后渲染的，坐标偏，
 *      点到 modal-body 而不是按钮，弹窗不关。
 *   ③ `btn.click()` 也不行 —— 它挂的是 pointerdown/pointerup。
 *
 * 唯一跑通的路（2026-10-28 实测）：
 *   `DOM.setFileInputFiles` 塞 `input.semi-upload-hidden-input`
 *     → 前端弹 `MsgInputSendFileModal`（预览：文件名 + 大小 + 取消/发送）
 *     → 等 `.MsgInputSendFileModalbtnSure` 出现且拿到坐标
 *     → **用真实鼠标坐标点它**
 *     → 回读「我发的条数 +1」核实
 *
 * ⚠️⚠️ 踩死的坑：注入 CDP 的表达式里**绝对不能出现字面 `$`**。
 *   即使只是 `k.indexOf('__reactFiber$')` 这种（没构成 `${}` 插值），
 *   `Runtime.evaluate` 也会在反序列化阶段报
 *   `Failed to deserialize params.expression - BINDINGS: string value expected at position 19`
 *   —— 一个 `$` 就能让整段表达式废掉。所以这里所有 `$` 一律用
 *   `const DOLLAR = String.fromCharCode(36)` 拼进去。
 *
 * 用法：
 *   node tools/send-image.mjs --to-id <sec_uid>   --file <本地图>
 *   node tools/send-image.mjs --conv-id <conv_id> --file <本地图>   # 群
 *   node tools/send-image.mjs --conv-id <id> --file <img> --dry     # 只预览不点发送
 *
 * 返回：{"ok":true,"sent":true,"file":"...","before":{boxes,imgs},"after":{boxes,imgs}}
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { openPage, killStrayPages, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}
const DRY = argv.includes('--dry')
const TOID = argOf('--to-id', '')
const CONVID = argOf('--conv-id', '')
const FILE = argOf('--file', '')

const out = (o) => {
  // 写 Buffer，避免 stdout 是管道时按 GBK 编码把 emoji 编崩
  process.stdout.write(Buffer.from(JSON.stringify(o) + '\n', 'utf8'))
  process.exit(o.ok ? 0 : 1)
}

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MY_UID = (() => {
  try {
    return String(JSON.parse(readFileSync(join(HOME, 'account.json'), 'utf8')).uid || '')
  } catch {
    return ''
  }
})()

if (!FILE) out({ ok: false, error: '缺少 --file' })
const ABS = resolve(FILE)
if (!existsSync(ABS)) out({ ok: false, error: 'file-not-found', file: ABS })
if (!TOID && !CONVID) out({ ok: false, error: '缺少 --to-id 或 --conv-id' })
const SIZE = statSync(ABS).size

/** CDP 表达式里不能用字面 $ ，见文件头 ⚠️ */
const DOLLAR = String.fromCharCode(36)

/**
 * 列出会话项。
 * id 的取法：`conversation` 对象里只有 toParticipantSecUserId + sortOrder，
 * 群这两者都空，真实会话 id 只在 `virtualItem.id` 上
 * （群 = 纯数字 conv_id，私聊 = 0:1:<peer_uid>:<my_uid>）。
 */
const LIST_JS = `(function(){
  var OUT = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
  nodes.forEach(function(n){
    var ks = Object.keys(n);
    var fk = '';
    for (var i = 0; i < ks.length; i++) { if (ks[i].indexOf('__reactFiber') === 0) { fk = ks[i]; break } }
    if (!fk) return;
    var f = n[fk], d = 0, vid = '', sec = '';
    while (f && d < 26) {
      var p = f.memoizedProps;
      if (p && p.virtualItem && p.virtualItem.id && !vid) vid = String(p.virtualItem.id);
      if (p && p.conversation && p.conversation.toParticipantSecUserId && !sec) sec = String(p.conversation.toParticipantSecUserId);
      f = f.return; d++;
    }
    if (!vid) return;
    var r = n.getBoundingClientRect();
    OUT.push({
      id: vid, sec: sec,
      type: /^[0-9]+/ .test(vid) ? 2 : 1,
      text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      inView: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
    });
  });
  return JSON.stringify(OUT);
})()`

/**
 * 右栏消息快照。
 * ⚠️ 不能用「头像横向落点判 me/them」—— 那个只在私聊左右分栏成立，
 *    群聊的气泡排版不一样，实测会恒判 them ⇒ 发成功也报 sent:false（2026-10-28 踩过）。
 * 这里只数两样东西：总条数 + 带图的条数。发图只会让后两者之一变大。
 */
const SNAP_JS = `(function(){
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[class*="messageMessageBox"]'));
  var imgs = 0;
  nodes.forEach(function(n){
    if (n.querySelector('[class*="messageImage"], [class*="ImageMsg"], img[src*="douyinpic"]')) imgs++;
  });
  return JSON.stringify({ boxes: nodes.length, imgs: imgs });
})()`

/** 等上传预览 modal 的「发送」按钮，返回坐标 */
const SURE_JS = `(function(){
  var b = document.querySelector('.MsgInputSendFileModalbtnSure');
  if (!b) return '';
  var rc = b.getBoundingClientRect();
  if (rc.width < 10 || rc.height < 10) return '';
  return JSON.stringify({ x: Math.round(rc.left + rc.width / 2), y: Math.round(rc.top + rc.height / 2), label: (b.innerText || '').replace(/\\s+/g, '') });
})()`

const CAPTCHA_JS = `(function(){
  var t = document.body ? document.body.innerText : '';
  return /请依次点击|完成验证|拖动滑块/.test(t) ? '1' : '';
})()`

const click = async (c, x, y) => {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

const openConv = async (c, want) => {
  const list = JSON.parse(String(await c.ev(LIST_JS)) || '[]')
  const hit = want.isGroup
    ? list.find((x) => String(x.type) === '2' && String(x.id) === String(want.id))
    : list.find((x) => String(x.sec) === String(want.sec) || String(x.id) === String(want.sec))
  if (!hit) return { ok: false, error: 'conv-not-in-list', list: list.map((x) => x.id) }
  if (!hit.inView) return { ok: false, error: 'conv-offscreen' }
  await click(c, hit.x, hit.y)
  await sleep(2400)
  return { ok: true, hit }
}

const main = async () => {
  // 清掉堆积的视频/图文页，只留 /chat（否则可能连到视频页，找不到会话列表）
  try { await killStrayPages() } catch { /* 清不掉不影响主流程 */ }
  const c = await openPage({ url: 'https://www.douyin.com/chat' })
  if (!c || !c.send) out({ ok: false, error: 'no-page' })
  await sleep(2600)

  // 确保停在 /chat
  try {
    const cur = String(await c.ev('location.href'))
    if (!cur.includes('/chat')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
      await sleep(5000)
    }
  } catch { /* 读不到就往下试 */ }

  if (MY_UID && (await c.ev(CAPTCHA_JS))) out({ ok: false, error: 'captcha' })

  const want = CONVID ? { isGroup: true, id: String(CONVID) } : { isGroup: false, sec: String(TOID) }
  const og = await openConv(c, want)
  if (!og.ok) out({ ok: false, error: og.error, list: og.list })

  const before = JSON.parse(String(await c.ev(SNAP_JS)) || '{}')
  if (!CONVID) await resolvePeerConv()
  await primeBaseline()

  const doc = await c.send('DOM.getDocument', { depth: -1, pierce: true })
  const q = await c.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input.semi-upload-hidden-input',
  })
  // 2026-10-31：多个 /chat 页并存时，可能连到「刚打开、内容还没渲染」的那一个
  // → querySelector 拿不到 file input → 误报 no-file-input。这里等一下再试一次。
  if (!q || !q.nodeId) {
    await sleep(3500)
    const doc2 = await c.send('DOM.getDocument', { depth: -1, pierce: true })
    const q2 = await c.send('DOM.querySelector', {
      nodeId: doc2.root.nodeId,
      selector: 'input.semi-upload-hidden-input',
    })
    if (!q2 || !q2.nodeId) out({ ok: false, error: 'no-file-input', snapshot: before })
    Object.assign(q, q2)
  }
  if (!q || !q.nodeId) out({ ok: false, error: 'no-file-input', snapshot: before })

  await c.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [ABS] })

  let sure = null
  for (let i = 0; i < 24; i++) {
    await sleep(500)
    const r = await c.ev(SURE_JS)
    if (r) {
      try {
        sure = JSON.parse(String(r))
        break
      } catch {
        /* 还没渲染好 */
      }
    }
  }
  if (!sure) out({ ok: false, error: 'no-send-modal', snapshot: before })

  if (DRY) out({ ok: true, dry: true, file: ABS, size: SIZE, snapshot: before, sure: sure.label })

  await click(c, sure.x, sure.y)
  await sleep(2600)

  // ── 核实：DOM 判据不可靠（群聊里 messageMessageBox 数目不稳、图片可能复用节点），
  //    所以直接问服务端：im-http.py 读这个会话最近几条，看有没有一条 kind=image
  //    且时间晚于发图前。
  const verify = await verifyByHttp()
  out({
    ok: true,
    sent: verify.sent,
    file: ABS,
    size: SIZE,
    before: before,
    after: verify.snapshot,
    http: verify.detail,
    target: CONVID ? { kind: 'group', id: CONVID } : { kind: 'private', sec_uid: TOID },
  })
}

/** 用 im-http.py 回读核实：最近 6 条里有没有新的 image */
const verifyByHttp = async () => {
  const py = process.env.DOUYIN_PY || join(HOME, '.venv', 'Scripts', 'pythonw.exe')
  const tool = join(ROOT, 'tools', 'im-http.py')
  if (!existsSync(tool) || !existsSync(py)) {
    return { sent: false, snapshot: null, detail: 'no-im-http' }
  }
  const args = TOOL_ARGS()
  let lastFail = 'no-try'
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(2500)
    const r = spawnSync(py, [tool, ...args, '--limit', '6'], {
      encoding: 'utf8',
      timeout: 40000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME },
      cwd: ROOT,
      windowsHide: true,
    })
    const raw = String((r && r.stdout) || '')
    const a = raw.indexOf('{')
    const b = raw.lastIndexOf('}')
    if (a < 0 || b <= a) {
      lastFail = 'bad-output'
      continue
    }
    let j = null
    try {
      j = JSON.parse(raw.slice(a, b + 1))
    } catch {
      lastFail = 'bad-json'
      continue
    }
    const msgs = ((j.matched || {}).messages) || []
    const imgs = msgs.filter((m) => ['image', 'gif'].includes(String(m.kind)))
    const newest = msgs.length ? String(msgs[msgs.length - 1].at || '') : ''
    const snapshot = { n: msgs.length, imgs: imgs.length, newest: newest }
    // 🔴 判定改成「比时间戳」，不再比 image 数量：
    //    窗口固定只有 6 条，图一密集，新图会把旧图挤出窗口 → image 条数饱和不变，
    //    用 imgs.length > BASELINE_IMGS 会永远判 false（2026-10-31 实测多次误报）。
    //    只要窗口里存在一张 md5 等于本地文件、且时间晚于发图前最新一条，就是发出去了。
    //    还要先按时间过滤：同一张图以前发过、旧消息还在窗口里时，光比 md5 会命中旧那条。
    const fresh = imgs.filter((m) => String(m.at || '') > BASELINE_AT)
    const hit =
      fresh.find((m) => WANT_MD5 && String((m.card || {}).md5 || '') === WANT_MD5) || fresh[0]
    if (hit) {
      return {
        sent: true,
        snapshot: snapshot,
        detail: {
          via: 'im-http',
          imgAt: String(hit.at || ''),
          md5: String((hit.card || {}).md5 || ''),
          size: (hit.card || {}).size,
          by: WANT_MD5 && String((hit.card || {}).md5 || '') === WANT_MD5 ? 'md5' : 'time',
        },
      }
    }
    lastFail = 'no-new-image'
    }
  return { sent: false, snapshot: null, detail: { via: 'im-http', why: lastFail } }
}

/** 私聊传 sec_uid 时，从 im-http --read 里找出对方的 peer_uid，拼成 conv_id */
let PSEUDO_CONV = ''
const resolvePeerConv = async () => {
  if (!TOID || /^[0-9]+$/.test(String(TOID))) return
  const py = process.env.DOUYIN_PY || join(HOME, '.venv', 'Scripts', 'pythonw.exe')
  const tool = join(ROOT, 'tools', 'im-http.py')
  if (!existsSync(tool) || !existsSync(py)) return
  // ⭐ 用 --peer-sec-uid 定向反查：im-http 会当场用这个 sec_uid 去核对，
  //    并且返回的 matched 里直接带 conv_id（形如 0:1:<peer_uid>:<my_uid>）。
  const r = spawnSync(py, [tool, '--read', '--limit', '8', '--peer-sec-uid', String(TOID)], {
    encoding: 'utf8',
    timeout: 40000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME },
    cwd: ROOT,
    windowsHide: true,
  })
  const raw = String((r && r.stdout) || '')
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return
  try {
    const j = JSON.parse(raw.slice(a, b + 1))
    const m = j.matched
    if (m && m.conv_id) PSEUDO_CONV = String(m.conv_id)
  } catch {
    /* 反查不到就算了，verify 会报 no-new-image 并带上 why */
  }
}

/** 发图前先取一次基线（最近 6 条里最新一条的时间戳 + 有几张 image），供 verifyByHttp 比较 */
let BASELINE_IMGS = -1
let BASELINE_AT = ''
/** 本地文件的 md5：抖音发图成功后会把它原样记在消息里，能用来精确核实 */
let WANT_MD5 = ''
const primeBaseline = async () => {
  // 先算本地文件 md5
  try {
    WANT_MD5 = String(createHash('md5').update(readFileSync(ABS)).digest('hex'))
  } catch {
    WANT_MD5 = ''
  }
  const py = process.env.DOUYIN_PY || join(HOME, '.venv', 'Scripts', 'pythonw.exe')
  const tool = join(ROOT, 'tools', 'im-http.py')
  if (!existsSync(tool) || !existsSync(py)) return
  const r = spawnSync(py, [tool, ...TOOL_ARGS(), '--limit', '6'], {
    encoding: 'utf8',
    timeout: 40000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME },
    cwd: ROOT,
    windowsHide: true,
  })
  const raw = String((r && r.stdout) || '')
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a < 0 || b <= a) return
  try {
    const j = JSON.parse(raw.slice(a, b + 1))
    const msgs = ((j.matched || {}).messages) || []
    BASELINE_IMGS = msgs.filter((m) => String(m.kind) === 'image').length
    BASELINE_AT = msgs.length ? String(msgs[msgs.length - 1].at || '') : ''
  } catch {
    /* 基线拿不到就按空时间戳走，verify 里任何一条 image 都算命中 */
  }
}

/**
 * 回读时 --conv-id 要什么：
 *   群   → 就是 CONVID
 *   私聊 → `0:1:<peer_uid>:<my_uid>`（im-http 的 conv_id 格式就是这个）。
 *          --to-id 传进来的可能是 sec_uid（MS4w…）也可能是纯数字 uid，
 *          后者直接拼得出来；前者要靠 im-http 的 --read 里 peer_uid 反查。
 */
const TOOL_ARGS = () => {
  if (CONVID) return ['--conv-id', String(CONVID)]
  if (/^[0-9]+$/.test(String(TOID)) && MY_UID) return ['--conv-id', `0:1:${TOID}:${MY_UID}`]
  return ['--conv-id', String(PSEUDO_CONV || '')]
}

main().catch((e) => out({ ok: false, error: String((e && e.message) || e).slice(0, 300) }))
