/**
 * 抖音群聊自动回复 —— 与 dm-auto-reply.mjs（私聊）完全独立的一条链路。
 *
 * 为什么单独写而不改 dm-auto-reply.mjs：
 *   ① 那个脚本的取会话逻辑写死 `type === 1`（私聊），改成兼容群会把现有稳定的私聊链路
 *      一起改坏 —— 群聊的「谁在跟我说话」判据、去重键、发送校验全都不一样。
 *   ② 群的发送要「先点开群」再发，私聊是「先找人」再发，两套 DOM 路径。
 *   ③ 出问题时能单独关掉（--off），不影响私聊。
 *
 * 规则（使用者 2026-10-27 定）：
 *   · 只在被 @ 或被点名时回（默认）
 *   · 另外 10% 概率主动回别人的视频/消息（--chance 可调）
 *   · 群里发的视频也抽帧看
 *   · 所有群都监控
 *   · 不设冷却、不设每日上限
 *
 * 用法：
 *   node tools/group-reply.mjs                    # 跑一轮
 *   node tools/group-reply.mjs --dry              # 只说不上
 *   node tools/group-reply.mjs --chance 0.1       # 随机回的概率
 *   node tools/group-reply.mjs --no-frames        # 群里的视频不抽帧
 */

import { openPage, sleep } from '../lib/chrome.mjs'
import { understandVideoCard } from '../lib/video-card.mjs'
import { sayWithModel } from '../lib/persona-llm.mjs'
import { addVideoMemory, mergeDmMemory, noteSent, dmContext } from '../lib/memory.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }

const DRY = argv.includes('--dry')
const OFF = argv.includes('--off')
const WANT_FRAMES = !argv.includes('--no-frames')
/** 非 @ 消息的回复概率（使用者要 10%） */
const CHANCE = Math.max(0, Math.min(1, Number(argOf('--chance', '0.1')) || 0))
/**
 * 跑 python 用哪个 exe。
 * ⚠ Windows 上裸 `python` 的 PE Subsystem = 3(Console)，spawn 出来会弹一个黑框
 * （标题就是 python.exe 的完整路径），全屏游戏会被强行最小化 —— 2026-10-29 使用者反馈。
 * venv 里的 pythonw.exe(Subsystem=2) 功能完全一样，只是不申请控制台。
 * 惰性求值：HOME 在下面才定义，所以这里不能提前算。
 */
const pyExe = () => {
  const explicit = argOf('--python', '')
  if (explicit) return explicit
  const v = join(HOME, '.venv', process.platform === 'win32' ? 'Scripts/pythonw.exe' : 'bin/python')
  if (existsSync(v)) return v
  return process.platform === 'win32' ? 'python' : 'python3'
}
const MAX_PER_RUN = Math.max(1, Math.min(Number(argOf('--max', '20')) || 20, 100))
/**
 * 同一条消息的「内容键」在多长时间内算同一条。
 * 3 小时：够覆盖「同一批消息被反复读到」（实测 at 会漂 2 小时 10 分），
 * 又不至于把隔了几小时真的又说一遍的话永远吞掉。
 */
const SAME_WINDOW_MS = 3 * 3600 * 1000

const HOME = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
const stateDir = HOME
const stateFile = join(stateDir, 'group-reply.json')
const logFile = join(stateDir, 'group-reply.log')
const runtimeFile = join(stateDir, 'runtime.json')

const out = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok === false ? 1 : 0) }
const log = (o) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...o })
  try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进就算了 */ }
  console.log(line)
}

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const saveJson = (p, v) => {
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(v, null, 1), 'utf8')
  } catch { /* ignore */ }
}

const st = readJson(stateFile, { replied: {}, day: '', count: 0, groups: {} })

// ── 抖音自己的 uid（判 @ 要用） ──────────────────────────────────────

function myUid () {
  try {
    const a = readJson(join(stateDir, 'account.json'), {})
    return String(a.uid || a.user_id || a.sec_uid || '')
  } catch { return '' }
}

const MY_UID = myUid()

// ── 读群聊（走 im-http.py 的 --list-groups / --conv-id） ─────────────

function runPy (script, args, timeout) {
  const r = spawnSync(pyExe(), [script, ...args], { encoding: 'utf8', timeout, windowsHide: true })
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

function pickJson (s) {
  const t = String(s || '')
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i < 0 || j <= i) return null
  try { return JSON.parse(t.slice(i, j + 1)) } catch { return null }
}

const IM_HTTP = join(HERE, 'im-http.py')

function listGroups () {
  const r = runPy(IM_HTTP, ['--list-groups'], 120_000)
  const j = pickJson(r.stdout)
  if (!j || !j.ok) return { ok: false, error: j?.error || r.stderr.slice(0, 200) || 'list-groups 失败' }
  return { ok: true, groups: j.groups || [], my_uid: String(j.my_uid || '') }
}

function readGroup (convId) {
  const r = runPy(IM_HTTP, ['--conv-id', String(convId)], 120_000)
  const j = pickJson(r.stdout)
  if (!j || !j.ok) return { ok: false, error: j?.error || r.stderr.slice(0, 200) || 'read 失败' }
  return { ok: true, matched: j.matched || {} }
}

/**
 * 这条消息是不是在叫我。
 *
 * 判据（按可靠度排序）：
 *   ① raw.richTextInfos[].info.uid === 我的 uid  ⇒ 明确 @ 了（`infoType: 1` 就是 @ 段）
 *   ② 正文里出现「小鲸鱼」                  ⇒ 点名
 * 两条都不占就是「别人在聊天」，交给 CHANCE 掷骰子。
 */
function isCallingMe (m) {
  const text = String(m.text || '')
  if (/@?小鲸鱼/.test(text)) return { hit: true, how: 'name' }
  const raw = String(m.raw || '')
  if (MY_UID && raw.includes('"infoType":1') && raw.includes(MY_UID)) return { hit: true, how: 'at' }
  return { hit: false }
}

// ── 点开群 + 发送 ────────────────────────────────────────────────────

const listConversations = (ev) => ev(`(function(){
  var out=[];
  Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]')).forEach(function(n){
    var fk=Object.keys(n).find(function(k){return k.indexOf('__reactFiber$')===0});
    if(!fk) return;
    var f=n[fk],d=0,conv=null;
    while(f&&d<14){var p=f.memoizedProps;if(p&&p.conversation){conv=p.conversation;break}f=f.return;d++}
    if(!conv) return;
    var r=n.getBoundingClientRect();
    out.push({
      shortId: String(conv.shortId||''),
      type: Number(conv.conversationType||conv.type||0),
      sec: String(conv.toParticipantSecUserId||''),
      text: (n.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60),
      inView: r.left>=0 && r.top>=0 && r.right<=window.innerWidth && r.bottom<=window.innerHeight,
      x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)
    });
  });
  return JSON.stringify(out);
})()`)

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
  try { list = JSON.parse(raw) || [] } catch { return [] }
  let carry = ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

/** 有没有验证码挡着（群聊和私聊共用同一套判定） */
const captcha = async (ev) => await ev(`(function(){
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
  const list = JSON.parse(await listConversations(ev) || '[]')
  const g = list.find((x) => String(x.type) === '2' && String(x.shortId) === String(convId))
  if (!g) return { ok: false, error: 'group-not-in-list', list: list.map((x) => x.shortId) }
  if (!g.inView) return { ok: false, error: 'group-offscreen' }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g.x, y: g.y, button: 'none', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)
  // 确认右栏真的切过去了：输入框出现
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

async function sendText (c, text) {
  const cap = JSON.parse(await captcha(c.ev) || '[]')
  if (cap.length) return { ok: false, error: 'captcha', captcha: cap }

  const pos = JSON.parse(await c.ev(`(function(){
    var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
    for(var i=0;i<eds.length;i++){var e=eds[i];var r=e.getBoundingClientRect();
      if(r.width>80&&r.height>10)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}
    return '{}';
  })()`))
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

  // 回读核实：我发的条数要 +1
  const after = await readMessages(c.ev)
  const afterMine = after.filter((m) => m.from === 'me').length
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const ok = afterMine > beforeMine || after.some((m) => m.from === 'me' && norm(m.text).includes(norm(text).slice(0, 12)))
  return { ok, sent: ok, mine_before: beforeMine, mine_after: afterMine }
}

// ── 主流程 ──────────────────────────────────────────────────────────

if (OFF) out({ ok: true, off: true })

/**
 * `--every N`（秒，>=60）⇒ 常驻循环；不给就跑一轮退出。
 * 常驻是给 index.js 的 groupEnsure 用的：它 spawn 一次，由这个循环自己按节拍跑，
 * 这样不用 DSH 每轮重新起进程（起进程要重新连 CDP、重新等会话列表，很慢）。
 */
const EVERY = Math.max(0, Number(argOf('--every', '0')) || 0)

async function oneRound () {
  const doc = readJson(runtimeFile, {})
  const PORT = Number(doc.cdpPort || 9334)

  const lg = listGroups()
  if (!lg.ok) return { ok: false, error: 'list-groups: ' + lg.error }
  if (!lg.groups.length) return { ok: true, done: true, groups: 0, replied: 0, note: '没有群' }

  const c = await openPage({ url: 'https://www.douyin.com/chat' })
  if (!c || !c.send) return { ok: false, error: 'no-chrome-page' }

  let replied = 0
  let scanned = 0
  const details = []

  for (const g of lg.groups) {
    if (replied >= MAX_PER_RUN) break
    const convId = String(g.conv_id)
    const rd = readGroup(convId)
    if (!rd.ok) { details.push({ conv: convId, name: g.name, error: rd.error }); continue }
    const msgs = rd.matched.messages || []
    scanned += msgs.length

    /**
     * ⭐ 2026-10-27：群聊也存记忆（使用者原话：「可以和私聊一样存」）。
     *
     * key 用 `group:<conv_id>` —— `memory.mjs` 的 `safeKey` 会把冒号去掉，
     * 落成 `memory/dm-group<conv_id>.json`，和私聊的 `dm-<sec_uid>.json` 并列。
     * 好处是 `pushDmToLivingMemory` 扫 `dm-*.json` 时会一起带上，
     * 靠 `who.kind === 'group'` 决定抬头写「我在抖音群里」而不是「我和 X 在抖音上」。
     *
     * ⚠️ 必须在挑消息**之前**存：`rd.matched.messages` 这次读到的可能比上次多，
     *    先合并再取上下文，这一轮就能用到「上一轮她说过什么」。
     */
    const memKey = 'group:' + convId
    try { mergeDmMemory(HOME, memKey, g.name, msgs, { kind: 'group' }) } catch { /* 记忆失败不阻断回话 */ }

    // 上一轮之前说过的话（跨轮次，不只是这一轮读到的 20 条）
    const ctx = (() => { try { return dmContext(HOME, memKey, { recent: 12 }) } catch { return null } })()

    /**
     * 挑要回的那条。
     * 只往前看最后 8 条（更早的已经聊过去了，突然插话很怪）。
     * 我自己最后说的话之后才处理 —— 否则会对着自己刚说完的话再回一遍。
     */
    const tail = msgs.slice(-8)
    const lastMineIdx = tail.map((m) => m.from).lastIndexOf('me')
    const candidates = lastMineIdx >= 0 ? tail.slice(lastMineIdx + 1) : tail
    const theirs = candidates.filter((m) => m.from === 'them' && (m.kind === 'text' || m.card))

    let target = null
    let why = ''
    for (const m of theirs) {
      const call = isCallingMe(m)
      if (call.hit) { target = m; why = 'called:' + call.how; break }
    }
    if (!target && theirs.length) {
      // 没被叫：按 CHANCE 掷一次骰子（每轮每个群只掷一次，不是每条消息都掷）
      if (Math.random() < CHANCE) {
        const pick = theirs[theirs.length - 1]
        if (pick.text || pick.card) { target = pick; why = 'chance' }
      }
    }
    if (!target) { details.push({ conv: convId, name: g.name, skip: 'no-target', theirs: theirs.length }); continue }

    // ── 去重 ────────────────────────────────────────────────────────
    /**
     * 🔴 2026-10-28 修：原来只用 `convId|at|text40` 当键，at 一变键就变 —— 同一条消息
     * 会被当成新消息再回一遍。
     *
     * 实测证据（`im-http.py --conv-id 7650565280728384037 --limit 20` 连读两次，间隔 4 秒）：
     *   「@小鲸鱼 扎啤」 第 1 次 at=2026-10-28T02:10:06.102Z → 第 2 次 04:20:42.950Z
     *   「[未知消息]」   第 1 次 at=2026-10-28T03:02:59.008Z → 第 2 次 04:21:04.130Z
     *   20 条里 18 条稳、2 条变（差 2 小时 10 分）—— 原因是 `im-http.py` 的 at 来自
     *   protobuf field10，部分消息这个字段缺失/回退成「最近活跃时间」，不保证稳定。
     *
     * ⇒ 双层判据：
     *   ① 精确键（带 at）：命中且 ok ⇒ 铁定回过，跳过
     *   ② 内容键（conv|sender|text40）：SAME_WINDOW 内出现过 ⇒ 跳过
     *      窗口取 3 小时 —— 足够覆盖「同一批消息被反复读到」，又不至于把真的
     *      隔了几小时才重复说一遍的话永远吞掉。
     */
    const textKey = String(target.text || '').slice(0, 40)
    const key = `${convId}|${target.at || ''}|${textKey}`
    const ckey = `${convId}|${target.sender || target.from || ''}|${textKey}`
    const prev = st.replied[key]
    if (prev?.ok) { details.push({ conv: convId, name: g.name, skip: 'already', why }); continue }
    const seenAt = Number((st.seen || {})[ckey] || 0)
    if (seenAt && Date.now() - seenAt < SAME_WINDOW_MS) {
      // ⚠️ 这里**不能**往 st.replied 写 ok:true —— replied 的语义是「真的回过了」，
      //    把「跳过」记进去会让这个漂移后的精确键永久命中 already（实测第三轮撞过）。
      details.push({ conv: convId, name: g.name, skip: 'same-as-earlier', why, ago: Math.round((Date.now() - seenAt) / 60000) })
      continue
    }

    // 视频/图文要看内容
    let video = null
    if (target.card && target.card.kind !== 'emoji') {
      const itemId = String(target.card.item_id || target.card.itemId || target.item || '')
      if (itemId) {
        try {
          const conn = { send: c.send, ev: c.ev }
          const r = await Promise.race([understandVideoCard(conn, itemId, { withVision: WANT_FRAMES }), sleep(30_000).then(() => null)])
          if (r) video = r
        } catch { /* 看不了就当没有 */ }
      }
    }

    if (DRY) {
      details.push({ conv: convId, name: g.name, dry: true, why, text: target.text, video: video ? { seen: video.seen, how: video.how_seen } : null })
      continue
    }

    // 生成回复
    //
    // ⚠️ sayWithModel 返回的是对象 `{ok, text, model, ms}`，不是字符串。
    //    第一版直接当字符串用，`String(obj)` 变成 `"[object Object]"` 真发出去了 ——
    //    所以这里必须取 `.text`，并且拿 `.ok` 判断成功与否。
    /**
     * ⚠️ `history` 的元素必须写成 `{from:'me'|'them', text}`。
     *
     * `lib/persona-llm.mjs:290` 是 `for (const h of history.slice(-16))` +
     * `const role = h.from === 'me' ? 'assistant' : 'user'` + `String(h.text || '')`。
     * 第一版我在这里传的是 `{role, content}`（OpenAI 形状），两个字段名都对不上
     * ⇒ `h.from` 是 undefined、`h.text` 是空 ⇒ 每条都被 `if (!c) continue` 跳过，
     * **群聊历史被静默整段丢掉**，她只看得到当前这一句。
     *
     * 来源优先用跨轮记忆（`ctx.recent`，能覆盖上一轮之前），退回落这一轮读到的。
     */
    const histSrc = (ctx?.recent?.length ? ctx.recent : msgs).slice(-16)
    const history = histSrc
      .filter((m) => m && m.text && (m.from === 'me' || m.from === 'them'))
      .map((m) => ({ from: m.from, text: String(m.text) }))

    const home = HOME
    let say = ''
    try {
      const r = await sayWithModel({
        text: String(target.text || (video?.desc) || '（发了内容）'),
        history,
        isOwner: false,
        card: target.card || null,
        video,
        home,
        scene: 'group',
        // 群里的「看过哪些作品」也记在 group 这个 key 下，所以要传 memKey
        secUid: memKey,
      })
      if (!r || !r.ok) {
        details.push({ conv: convId, name: g.name, skip: 'model', error: r?.error || 'no-result' })
        continue
      }
      say = String(r.text || '').trim()
    } catch (e) {
      details.push({ conv: convId, name: g.name, error: 'say: ' + String(e?.message || e) })
      continue
    }
    say = String(say || '').trim()
    if (!say) { details.push({ conv: convId, name: g.name, skip: 'silent', why }); continue }
    if (say.length > 100) say = say.slice(0, 100)

    // 发
    const opened = await openGroup(c, convId)
    if (!opened.ok) {
      st.replied[key] = { at: new Date().toISOString(), ok: false, error: opened.error, text: say }
      details.push({ conv: convId, name: g.name, error: 'open: ' + opened.error })
      continue
    }
    const sent = await sendText(c, say)
    st.replied[key] = { at: new Date().toISOString(), ok: Boolean(sent.ok), text: say, why, error: sent.error || '' }
    // 内容键也记一份：下次同一条消息的 at 漂了，靠它认出来（见上面去重注释）
    if (sent.ok) {
      st.seen = st.seen || {}
      st.seenText = st.seenText || {}
      st.seen[ckey] = Date.now()
      st.seenText[ckey] = say
    }
    if (sent.ok) replied++
    details.push({ conv: convId, name: g.name, why, sent: sent.ok, text: say, error: sent.error || '' })

    // 自己刚发的这句立刻进记忆（不用等下一轮读回来，那时可能已经被刷走了）
    if (sent.ok) {
      try { noteSent(HOME, memKey, g.name, say, 'text', { scope: 'group' }) } catch { /* ignore */ }
    }

    // 看过的作品也记在 group key 下
    if (video && (video.seen || video.scene)) {
      try { addVideoMemory(home, memKey, { itemId: String(target.item || ''), title: video.desc || '', scene: video.scene || '', comments: video.comments || [], howSeen: video.how_seen || '' }) } catch { /* ignore */ }
    }

    await sleep(1200)
  }

  // 只保留最近 500 条去重记录
  const keys = Object.keys(st.replied)
  if (keys.length > 500) {
    const sorted = keys.map((k) => [k, st.replied[k]]).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
    st.replied = Object.fromEntries(sorted.slice(0, 500))
  }
  // 内容键同样清一清：只留 SAME_WINDOW 内的，外加总量上限，别让状态文件无限长
  if (st.seen && typeof st.seen === 'object') {
    const now = Date.now()
    const keep = Object.entries(st.seen)
      .filter(([, ts]) => now - Number(ts || 0) < SAME_WINDOW_MS)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 500)
    st.seen = Object.fromEntries(keep)
    st.seenText = st.seenText || {}
    for (const k of Object.keys(st.seenText)) if (!(k in st.seen)) delete st.seenText[k]
  }
  st.day = new Date().toISOString().slice(0, 10)
  saveJson(stateFile, st)

  return { ok: true, done: true, groups: lg.groups.length, scanned, replied, dry: DRY, chance: CHANCE, details }
}

if (EVERY >= 60) {
  log({ tick: 'boot', every: EVERY, chance: CHANCE, frames: WANT_FRAMES })
  let stop = false
  process.on('SIGINT', () => { stop = true })
  process.on('SIGTERM', () => { stop = true })
  while (!stop) {
    const t0 = Date.now()
    try {
      const r = await oneRound()
      log({ tick: 'round', ...r })
    } catch (e) {
      log({ tick: 'round_throw', error: String(e?.message || e).slice(0, 200) })
    }
    const spent = Date.now() - t0
    const wait = Math.max(5_000, EVERY * 1000 - spent)
    await sleep(wait)
  }
  out({ ok: true, stopped: true })
} else {
  out(await oneRound())
}
