#!/usr/bin/env node
/**
 * tools/card-share.mjs —— 用抖音自己的「分享给朋友」把视频以**卡片**发给好友
 * ============================================================================
 * 为什么必须这么做：分享卡片（aweType 800 / MessageItemShareAweme）是前端把结构化
 * 消息交给服务端生成的，纯文本 + URL 永远做不出卡片；而且文本链接在抖音里点不开。
 *
 * 链路（全在无头 Chrome 里，屏幕上无窗口）：
 *   视频页 → 鼠标轨迹 hover 分享图标 → 面板展开 →
 *   找「<昵称>」那一行的「分享」按钮 → 点击 → 卡片发出
 *
 * ⚠️ 分享图标没有 onClick，是 onMouseEnter/onFocus 的 hover 弹窗，
 *    所以必须用**真实鼠标轨迹**移过去，`el.click()` 打不开（踩过）。
 *
 * 用法:
 *   node tools/card-share.mjs <aweme_id> <好友昵称>
 *   node tools/card-share.mjs <aweme_id> <好友昵称> --dry    # 只展开面板打印结构
 */
import { openIsolatedTab, ensureChrome, sleep } from '../lib/chrome.mjs'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const PEEK = argv.includes('--peek')
const TOID = argOf('--to-id', '')
// 位置参数：跳过 `--to-id` 后面那个值
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--to-id'))
const AID = pos[0] || ''
const WHO = pos[1] || ''
// 🔴 2026-10-31：原来的 console.log 在 stdout 是管道时按系统代码页(GBK)编码，
//    分享面板里只要出现一个 emoji（如「村村存丶 🪳」的 U+1FAB3）就抛
//    UnicodeEncodeError，整段 JSON 打不出来、上层只看到空串。
//    改成写 Buffer，彻底绕开编码转换。
const out = (o) => {
  process.stdout.write(Buffer.from(JSON.stringify(o, null, 1) + '\n', 'utf8'))
  process.exitCode = o.ok ? 0 : 1
}

/**
 * 用 im-http.py 回读核实「卡片真的发到服务端了」。
 * 判据：最近 6 条里出现 kind=card 且 card.item_id == aweme_id。
 * 窗口只有 6 条，所以点完立刻查；查不到再重试 3 次（每次间隔 2.5 秒）。
 */
// 本次点击发送的时刻（模块级：verifyCardByHttp 要用它排除以前发过的同一条视频）
let SENT_AT = ''

const verifyCardByHttp = async (awemeId) => {  const py = process.env.DOUYIN_PY || join(HOME, '.venv', 'Scripts', 'pythonw.exe')
  const tool = join(ROOT, 'tools', 'im-http.py')
  if (!existsSync(tool) || !existsSync(py)) return { sent: false, why: 'no-im-http' }
  // conv_id：私聊 = 0:1:<peer_uid>:<my_uid>。TOID 是 sec_uid 时先反查 peer_uid。
  let convId = process.env.DOUYIN_CONV_ID || ''
  if (!convId && TOID) {
    const r0 = spawnSync(py, [tool, '--read', '--limit', '8', '--peer-sec-uid', String(TOID)], {
      encoding: 'utf8', timeout: 40000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME },
      cwd: ROOT, windowsHide: true,
    })
    const raw0 = String(r0.stdout || '')
    const a0 = raw0.indexOf('{'), b0 = raw0.lastIndexOf('}')
    if (a0 >= 0 && b0 > a0) {
      try { convId = String((JSON.parse(raw0.slice(a0, b0 + 1)).matched || {}).conv_id || '') } catch { /* 忽略 */ }
    }
  }
  if (!convId) return { sent: false, why: 'no-conv-id' }

  let lastFail = 'card-not-found'
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(2500)
    const r = spawnSync(py, [tool, '--conv-id', convId, '--limit', '6'], {
      encoding: 'utf8', timeout: 40000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DOUYIN_DUTY_HOME: HOME },
      cwd: ROOT, windowsHide: true,
    })
    const raw = String(r.stdout || '')
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}')
    if (a < 0 || b <= a) { lastFail = 'bad-output'; continue }
    let j = null
    try { j = JSON.parse(raw.slice(a, b + 1)) } catch { lastFail = 'bad-json'; continue }
    const msgs = ((j.matched || {}).messages) || []
    // 🔴 同一个视频以前也发过，光比 item_id 会命中旧那条（实测返回的是 30 分钟前的）。
    //    必须先按「本次开始发送的时间」筛一遍，再在里面找。留 90 秒余量防时钟偏差。
    const sinceMs = Date.parse(SENT_AT) - 90000
    const fresh = msgs.filter((m) => {
      const t = Date.parse(String(m.at || ''))
      return Number.isFinite(t) && t >= sinceMs
    })
    const hit = fresh.filter((m) => String(m.kind) === 'card')
      .find((m) => String((m.card || {}).item_id || '') === String(awemeId))
    if (hit) {
      return { sent: true, via: 'im-http', at: String(hit.at || ''), item_id: String((hit.card || {}).item_id || ''), conv_id: convId }
    }
    lastFail = 'card-not-found'
  }
  return { sent: false, why: lastFail, conv_id: convId }
}

if (!AID || !WHO) { out({ ok: false, error: '用法: card-share.mjs <aweme_id> <好友昵称>' }); process.exit(1) }

/**
 * 🔴🔴 2026-11-10 大修：**发卡片必须开自己的标签页，不许占用 `/chat`**。
 *
 * 原来这里用 `openPage()` → 拿到的是那个唯一的 `/chat` 页 → 紧接着
 * `Page.navigate` 把它换成 `/video/<id>`。这一步会**替换掉 CDP Target**，
 * 于是：
 *   · `xj_douyin` 每 5 秒起的 `look-video.mjs` 子进程正好连着这个页 ⇒ ws 当场断；
 *   · `dm-auto-reply` 缓存的 `_conn` 也一样，之后每一轮都抛
 *     `CDP WebSocket 已断开，无法发送 Runtime.evaluate`，而且（旧代码）永不重连。
 * 日志实证：2026-11-10 07:51→08:27 连续 7 次 `video_fail` 全断在这上面，
 * 现象是「能读字但再也看不见画面」；`card-share` 成功后紧跟一片 `send_fail`。
 *
 * 现在改成 `openIsolatedTab`：新开一个自己的页，跑完 `dispose()` 关掉，
 * `/chat` 一秒都不碰。`openIsolatedTab` 就是为「在别人的循环里插一脚」写的
 * （见 `lib/chrome.mjs` 里它的注释），这里正是那个场景。
 */
const { port: _cp } = await ensureChrome({ url: 'https://www.douyin.com/chat' })
const _c = await openIsolatedTab(_cp, 'about:blank')
const chromed = _c.status
const { send, ev } = _c
// 不走 /chat 了，就没有「原本停在哪」要记：自己的页直接 dispose
const _origUrl = ''
const mv = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
const click = async (x, y) => {
  await mv(x, y); await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

try {
  await send('Page.navigate', { url: `https://www.douyin.com/video/${AID}` })
  await sleep(7000)

  /**
   * 🔴🔴 2026-10-29 —— 这一段的教训（花了几个小时才认清，别再改回去）
   *
   * ① 入口**必须是 `video-share-icon-container`**，不能是 `video-player-share`。
   *    实测页面上两个都存在（视频页），但只有前者能出真卡片：
   *      · 用 `video-share-icon-container` → 点「分享」→ 私信 `aweType:800` ✅ 真卡片
   *      · 用 `video-player-share`         → 点「分享」→ 私信 `aweType:0`   ❌ 只有标题纯文本，
   *        而且面板**不收起**、还照样弹「分享成功」toast，证据链完全看不出来。
   *    我一度以为 `video-share-icon-container` 被前端删了、就把它换成后者，
   *    结果每次「发送成功」其实都在发纯文本。
   *
   * ② **图文（`/note/xxx`）页没有 `video-share-icon-container`**，只有 `video-player-share`。
   *    也就是说图文作品**发不出真卡片**（走那条路只会得到纯文本）。
   *    ⇒ 这种情况直接报错，让调用方去发文字链接，别假装发成功。
   *
   * ③ 原来那套 hover + `click(b.x,b.y)` 的鼠标轨迹**是对的**，别改成
   *    「鼠标停在别处、直接对坐标发 mousePressed」（那样拿到的也是纯文本）。
   */
  const pos = JSON.parse(await ev(`(function(){
    var ic=document.querySelector('[data-e2e="video-share-icon-container"]');
    if(!ic) return JSON.stringify({err:'no-icon', isNote: location.pathname.indexOf('/note/')===0});
    var r=ic.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  })()`))
  if (!pos.x) {
    out({
      ok: false,
      error: pos.isNote
        ? '这是图文作品（/note/），它没有分享图标容器，发不出真卡片；请改发文字链接'
        : '找不到分享图标（视频页没加载好）',
      isNote: !!pos.isNote,
    })
    process.exit(1)
  }

  // 真实轨迹 hover（必须；el.click() 打不开）
  await mv(20, 20); await sleep(250)
  for (let i = 1; i <= 8; i++) {
    await mv(Math.round(20 + (pos.x - 20) * i / 8), Math.round(20 + (pos.y - 20) * i / 8))
    await sleep(70)
  }
  await mv(pos.x, pos.y)
  await sleep(2000)

  const panel = await ev(`(function(){
    var sc=document.querySelector('[data-e2e="video-share-container"]');
    return sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,400) : '';
  })()`)
  if (!panel) { out({ ok: false, error: '分享面板没展开' }); process.exit(1) }

  // --peek：把面板里每一行连同它 fiber 里的 id 都打出来（排查重名用）
  if (PEEK) {
    const rows = await ev(`(function(){
      var sc = document.querySelector('[data-e2e="video-share-container"]');
      if (!sc) return '[]';
      var out = [];
      sc.querySelectorAll('div').forEach(function(e){
        var t = (e.innerText||'').replace(/\\s+/g,' ').trim();
        if (!t || t.length > 40 || t === '分享') return;
        var fk = Object.keys(e).find(function(k){ return k.indexOf('__reactFiber$')===0 });
        var ids = [];
        if (fk) {
          var f = e[fk], d = 0;
          while (f && d < 12) {
            var p = f.memoizedProps;
            if (p && typeof p === 'object') {
              for (var k in p) {
                if (typeof p[k] === 'string' && /^(MS4wLjABAA|11-)\\S{6,}$/.test(p[k])) ids.push(k + '=' + p[k]);
                else if (p[k] && typeof p[k] === 'object' && p[k].sec_uid) ids.push('obj.sec_uid=' + p[k].sec_uid);
                else if (p[k] && typeof p[k] === 'object' && p[k].uid) ids.push('obj.uid=' + p[k].uid);
              }
            }
            f = f.return; d++;
          }
        }
        var uniq = []; ids.forEach(function(x){ if (uniq.indexOf(x)<0) uniq.push(x) });
        if (uniq.length) out.push({ text: t.slice(0,30), ids: uniq.slice(0,4) });
      });
      var seen={},u=[]; out.forEach(function(o){var k=o.text; if(!seen[k]){seen[k]=1;u.push(o);}});
      return JSON.stringify(u.slice(0,12));
    })()`)
    out({ ok: true, peek: true, panel, rows: JSON.parse(rows || '[]') })
    _c.close(); process.exit(0)
  }

  // 找「WHO」那一行：同时拿到 昵称 + **sec_uid** + 「分享」按钮坐标 —— 昵称会重名，sec_uid 不会
  const found = await ev(`(function(){
    var who = ${JSON.stringify(WHO)};
    var sc = document.querySelector('[data-e2e="video-share-container"]');
    if(!sc) return JSON.stringify({err:'no-panel'});
    function secOf(node){
      var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$')===0 });
      if(!fk) return '';
      var f = node[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && typeof p === 'object') {
          for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid); }
        }
        f = f.return; d++;
      }
      return '';
    }
    var nodes = Array.prototype.slice.call(sc.querySelectorAll('div,span,p')).filter(function(e){
      return (e.innerText||'').trim() === who;
    }).sort(function(a,b){ return a.getBoundingClientRect().width - b.getBoundingClientRect().width });
    if(!nodes.length) return JSON.stringify({err:'no-name', text:(sc.innerText||'').replace(/\\s+/g,' ').slice(0,160)});
    var out = [];
    nodes.forEach(function(nameNode){
      var row = nameNode;
      for (var i=0;i<6 && row;i++){
        var btns = Array.prototype.slice.call(row.querySelectorAll('div,span,button')).filter(function(e){
          return (e.innerText||'').trim()==='分享';
        });
        if (btns.length){
          var b = btns[0], r = b.getBoundingClientRect();
          if (r.width>16 && r.height>12){
            out.push({ nick: who, sec_uid: secOf(row) || secOf(nameNode),
              btn: {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)} });
          }
          break;
        }
        row = row.parentElement;
      }
    });
    var seen={}, uniq=[];
    out.forEach(function(o){ var k=o.sec_uid||(o.btn.x+','+o.btn.y); if(!seen[k]){seen[k]=1;uniq.push(o)} });
    return JSON.stringify({candidates: uniq});
  })()`)

  let f = {}
  try { f = JSON.parse(found) } catch { f = { err: 'bad-json' } }
  if (f.err) { out({ ok: false, error: '找不到该好友那一行', detail: f, panel }); process.exit(1) }

  let cands = f.candidates || []
  if (TOID) {
    cands = cands.filter((c) => c.sec_uid === TOID)
    if (!cands.length) { out({ ok: false, error: `分享面板里没有 sec_uid=${TOID} 这个人（面板只列最近分享过的人）`, panel }); process.exit(1) }
  }
  if (cands.length > 1) {
    out({
      ok: false,
      error: '分享面板里有多个同名的人，不敢猜（猜错就是把视频发给陌生人）',
      nick: WHO,
      candidates: cands.map((c) => ({ sec_uid: c.sec_uid })),
      hint: '请改用 --to-id <sec_uid> 指定',
    })
    process.exit(1)
  }
  const b = cands[0].btn
  const target = { nick: WHO, sec_uid: cands[0].sec_uid || TOID || '' }
  if (DRY) { out({ ok: true, dry: true, panel, btn: b, target, chrome: chromed, matched_by: TOID ? 'sec_uid' : 'nickname(唯一)' }); _c.close(); process.exit(0) }

  // 记下「这次点击发送的时刻」，verifyCardByHttp 用它排除以前发过的同一条视频
  SENT_AT = new Date().toISOString()
  await click(b.x, b.y)
  await sleep(2500)

  const after = await ev(`(function(){
    var sc=document.querySelector('[data-e2e="video-share-container"]');
    return JSON.stringify({
      panelStillOpen: sc ? sc.getBoundingClientRect().height > 10 : false,
      panelText: sc ? (sc.innerText||'').replace(/\\s+/g,' ').slice(0,200) : '',
      toast: (document.body.innerText||'').indexOf('已发送')>=0 || (document.body.innerText||'').indexOf('发送成功')>=0
    });
  })()`)

  /**
   * 🔴 2026-10-31 修：**必须回读服务端，别信 toast**。
   *
   * 2026-10-29 那条注释（:56-57）已经写明：用错入口时面板不收起、还照样弹
   * 「分享成功」toast，光看页面完全分不出来。今天实测又踩了同款 —— 页面一切
   * 正常，但服务端根本没有这张卡片。
   *
   * 所以：点完之后用 im-http.py 读最近几条，确认出现一条 kind=card 且
   * item_id == 本次 aweme_id 的消息。读不到就明确报失败，不再谎报 sent:true。
   */
  const verify = await verifyCardByHttp(AID)
  // 注意：模块顶层不能用 `return`（会 Illegal return statement），也不能 process.exit
  //      —— 那会跳过 finally 里的「导航回 /chat」，后续 group-send 就找不到会话列表。
  if (!verify.sent) {
    out({ ok: false, sent: false, error: 'card-not-found', why: verify.why, aweme_id: AID, to: WHO, panel, btn: b, chrome: chromed, after: JSON.parse(after), http: verify })
  } else {
    out({ ok: true, sent: true, aweme_id: AID, to: WHO, panel, btn: b, chrome: chromed, after: JSON.parse(after), http: verify })
  }
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
} finally {
  /**
   * ⭐ 2026-11-10：改成 `dispose()` —— 自己开的页自己关掉。
   *
   * 老逻辑（2026-10-29 那版）是「借 /chat → 导航去视频页 → 收尾导航回 /chat」，
   * 它解决的是「/chat 页被换成视频页，group-send 找不到会话列表」。
   * 但代价太大：`Page.navigate` 会替换 CDP Target，**所有正连着这个页的 ws
   * 当场断掉**，包括 `xj_douyin` 每 5 秒起的 `look-video` 子进程和
   * `dm-auto-reply` 缓存的 `_conn`。断一次就够它瞎一整天。
   *
   * 现在整个 `/chat` 页都不碰了：新开标签页 → 用完 dispose，两个问题一起没了。
   */
  try {
    if (typeof _c.dispose === 'function') await _c.dispose()
    else _c.close()
  } catch { /* 关不掉不影响发送结果 */ }
}
process.exit(process.exitCode || 0)
