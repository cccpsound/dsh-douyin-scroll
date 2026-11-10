/**
 * 往指定的抖音群里发一条纯文本 —— 从 group-reply.mjs 里抽出来的「只管发」版本。
 *
 * 为什么单独一个文件而不复用 im-send.mjs：
 *   im-send.mjs 是按 **sec_uid** 找人的（`list.filter(c => c.sec_uid === whoId)`），
 *   而群在 React fiber 里 `toParticipantSecUserId` 是空串（群不是"某个人"），
 *   所以它永远找不到群。群的路径必须是「先在会话列表里按 shortId 找到那个群 →
 *   点开 → 在右栏输入框发」，DOM 走法完全不同。
 *
 * 用法：
 *   node tools/group-send.mjs --conv-id 7506752097300283967 --text "在的"
 *   node tools/group-send.mjs --conv-id ... --text "…" --dry     # 不真发，只验证能不能点开
 *
 * 输出：一行 JSON
 *   {"ok":true,"sent":true,"conv_id":"...","mine_before":5,"mine_after":6}
 *   {"ok":false,"error":"group-not-in-list","list":[...]}
 */

import { openPage, openFreshTab, killStrayPages, sleep } from '../lib/chrome.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const argOf = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? '') : d
}

const CONV_ID = String(argOf('--conv-id', '') || '').trim()
const TEXT = String(argOf('--text', '') || '')
const DRY = argv.includes('--dry')

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const runtimeFile = join(HOME, 'runtime.json')

const out = (o) => {
  console.log(JSON.stringify(o))
  process.exit(o.ok === false ? 1 : 0)
}

const readJson = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return d
  }
}

const listConversations = (ev) => ev(`(function(){
  var out=[];
  Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]')).forEach(function(n){
    var fk=Object.keys(n).find(function(k){return k.indexOf('__reactFiber$')===0});
    if(!fk) return;
    var f=n[fk],d=0,conv=null,vid='';
    while(f&&d<16){
      var p=f.memoizedProps;
      if(p&&p.virtualItem&&p.virtualItem.id){vid=String(p.virtualItem.id);break}
      f=f.return;d++;
    }
    // ⚠️ conversation 对象里只有 toParticipantSecUserId + sortOrder，
    //    群聊两者都空/无意义 ⇒ 按 conversation 判「是不是群」永远判不出来。
    //    真实会话 id 只有 virtualItem.id：群=纯数字 conv_id，私聊=0:1:<peer_uid>:<my_uid>。
    if(!vid) return;
    var r=n.getBoundingClientRect();
    var isGroup = /^[0-9]+$/.test(vid);
    out.push({
      shortId: vid,
      convId: vid,
      type: isGroup ? 2 : 1,
      sec: String((conv&&conv.toParticipantSecUserId)||''),
      text: (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60),
      inView: r.left>=0 && r.top>=0 && r.right<=window.innerWidth && r.bottom<=window.innerHeight,
      x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)
    });
  });
  return JSON.stringify(out);
})()`)

/**
 * 读右栏消息，判「谁发的」靠**头像横向落点**：
 *   头像中心 < 列表中线 ⇒ 对方；> 中线 ⇒ 我。
 * 为什么不看 `message.isMyMessage`：实测这个字段恒为 true（群聊私聊都一样），
 * 拿它判会把对方的话全当自己说的。
 */
const readMessages = async (ev) => {
  const raw = await ev(`(function(){
    var listNode=document.querySelector('[class*="messageMessageList"]')||document.querySelector('[class*="componentsRightPanel"]')||document.body;
    var lb=listNode.getBoundingClientRect(), mid=lb.left+lb.width/2;
    var nodes=Array.prototype.slice.call(document.querySelectorAll('[class*="messageMessageBox"]'));
    var out=[], seen=new WeakSet();
    nodes.forEach(function(n){
      var fk=Object.keys(n).find(function(k){return k.indexOf('__reactFiber$')===0});
      if(!fk) return;
      var f=n[fk],d=0,found=null;
      while(f&&d<24){var p=f.memoizedProps;
        if(p&&p.message&&typeof p.message==='object'&&p.message.parsedContent){found=p.message;break}
        f=f.return;d++}
      if(!found||seen.has(found))return; seen.add(found);
      var r=n.getBoundingClientRect(),side='';
      var im=Array.prototype.slice.call(n.querySelectorAll('img')).filter(function(img){
        var b=img.getBoundingClientRect();
        if(b.width<28||b.width>48)return false;
        if(Math.abs(b.width-b.height)>6)return false;
        var cy=b.top+b.height/2;
        return cy>=r.top-2&&cy<=r.bottom+2;
      })[0];
      if(im){var ib=im.getBoundingClientRect();side=((ib.left+ib.width/2)<mid)?'them':'me'}
      var pc=found.parsedContent||{};
      out.push({
        own: side,
        text: String(pc.text||pc.content_title||'').replace(/\\s+/g,' ').trim(),
        awe: Number(pc.aweType||0),
        item: pc.itemId ? String(pc.itemId) : ''
      });
    });
    return JSON.stringify(out);
  })()`)
  let list = []
  try {
    list = JSON.parse(raw) || []
  } catch {
    return []
  }
  let carry = ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

const captcha = async (ev) =>
  await ev(`(function(){
  var out=[];
  document.querySelectorAll('iframe').forEach(function(f){
    var s=String(f.src||'');
    if(!/verifycenter|captcha|nocaptcha|rmc\\.bytedance/i.test(s)) return;
    var r=f.getBoundingClientRect();
    if(r.width<40||r.height<40) return;
    out.push({src:s.slice(0,90),w:Math.round(r.width),h:Math.round(r.height)});
  });
  return JSON.stringify(out);
})()`)

const openGroup = async (c, convId) => {
  const ev = c.ev
  for (let i = 0; i < 25; i++) {
    const n = Number(await ev(`document.querySelectorAll('[data-e2e="conversation-item"]').length`)) || 0
    if (n > 0) break
    await sleep(600)
  }
  const list = JSON.parse((await listConversations(ev)) || '[]')
  // 群 id 是纯数字；同时认 conv_id 与 shortId 两种写法，省得调用方猜
  const g = list.find(
    (x) => String(x.type) === '2' && (String(x.convId) === String(convId) || String(x.shortId) === String(convId)),
  )
  if (!g) return { ok: false, error: 'group-not-in-list', list: list.map((x) => x.convId) }
  if (!g.inView) return { ok: false, error: 'group-offscreen' }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y, button: 'none', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)
  for (let i = 0; i < 10; i++) {
    const has = await ev(`(function(){
      var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
      return eds.some(function(e){var r=e.getBoundingClientRect();return r.width>80&&r.height>10});
    })()`)
    if (has) return { ok: true, group: g }
    await sleep(800)
  }
  return { ok: false, error: 'no-editor-after-open' }
}

async function sendText(c, text) {
  const cap = JSON.parse((await captcha(c.ev)) || '[]')
  if (cap.length) return { ok: false, error: 'captcha', captcha: cap }

  const pos = JSON.parse(
    await c.ev(`(function(){
    var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
    for(var i=0;i<eds.length;i++){var e=eds[i];var r=e.getBoundingClientRect();
      if(r.width>80&&r.height>10)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}
    return '{}';
  })()`)
  )
  if (!pos.x) return { ok: false, error: 'no-input-box' }

  const before = await readMessages(c.ev)
  const beforeMine = before.filter((m) => m.from === 'me').length

  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(350)
  await c.send('Input.insertText', { text })
  await sleep(700)

  const typed = await c.ev(`(function(){
    var e=document.querySelector('[contenteditable="true"], textarea');
    return e?String(e.innerText||e.value||'').replace(/[\\u200b\\r]/g,''):'';
  })()`)
  if (!String(typed).trim()) return { ok: false, error: 'text-not-entered' }

  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(2400)

  const after = await readMessages(c.ev)
  const afterMine = after.filter((m) => m.from === 'me').length
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const ok = afterMine > beforeMine || after.some((m) => m.from === 'me' && norm(m.text).includes(norm(text).slice(0, 12)))
  return { ok, sent: ok, mine_before: beforeMine, mine_after: afterMine }
}

async function main() {
  if (!CONV_ID) out({ ok: false, error: 'need --conv-id' })
  if (!DRY && !TEXT.trim()) out({ ok: false, error: 'need --text' })

  const doc = readJson(runtimeFile, {})
  const port = Number(doc.cdpPort || 9334)

  // 先把堆积的 video/note 页清掉，只留 /chat —— 见 lib/chrome.mjs 里 killStrayPages 的说明
  try { await killStrayPages(port) } catch { /* 清不掉不影响主流程 */ }

  let c = await openPage({ url: 'https://www.douyin.com/chat' })
  if (!c || !c.send) out({ ok: false, error: 'no-chrome-page', port })

  // 确保停在 /chat：别让上一个脚本留下的视频页把我们带沟里
  try {
    const cur = String(await c.ev('location.href'))
    if (!cur.includes('/chat')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
      await sleep(5000)
    }
  } catch { /* 读不到 location 就直接往下试 */ }

  let og = await openGroup(c, CONV_ID)

  /**
   * ⭐ 右栏僵死自愈（2026-10-29 加，跟 im-send.mjs 里那套对齐）。
   *
   * 抖音 /chat 用久了 IM 连接会挂：左侧会话列表还在、右侧面板永远转圈，
   * 点开群也等不到输入框 —— 表现就是 `no-editor-after-open`。
   * Page.reload 救不回来，只有**开一个全新标签页**才能拿到新的 IM websocket。
   *
   * 原来这里没有这一段，所以一旦僵死就永久失败（今天 13:50 / 14:20 / 15:21
   * 三次都是这个），而私聊走 im-send.mjs 有自愈所以看着正常。
   */
  if (!og.ok && og.error === 'no-editor-after-open') {
    const before = c
    const fresh = await openFreshTab(c.port)
    const og2 = await openGroup(fresh, CONV_ID)
    before.close()
    c = fresh
    og = og2
  }

  if (!og.ok) out({ ok: false, conv_id: CONV_ID, ...og })
  if (DRY) out({ ok: true, dry: true, conv_id: CONV_ID, group: og.group })

  const r = await sendText(c, TEXT)
  c.close()
  out({ ok: r.ok, conv_id: CONV_ID, text: TEXT.slice(0, 60), ...r })
}

main().catch((e) => out({ ok: false, error: String((e && e.message) || e).slice(0, 200) }))
