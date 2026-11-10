/**
 * lib/chrome.mjs —— 插件里**唯一**的浏览器入口
 * ============================================================================
 * 为什么要有这个文件：
 *   2026-10-22 之前，9 个脚本各自写一份 `C:\Program Files\Google\Chrome\...` +
 *   各自的 `ensureChrome()` + 各自的 `new WebSocket(CDP)`。
 *   换台设备（Chrome 装在别的盘 / 只有 Edge）就全部静默失效。
 *
 * 这里统一做四件事：
 *   ① 找浏览器：DOUYIN_BROWSER → Chrome → Edge → Chromium（Windows / macOS / Linux 全试）
 *   ② 找端口：runtime.json 里记着就用它，否则从 9334 往上找空闲的（被占就换，别让用户改代码）
 *   ③ 起无头 Chrome（`--headless=new`，屏幕上无窗口），已起就复用
 *   ④ 连 CDP，给一个带 send/ev/close 的小客户端
 *
 * ⚠️ 规矩：`tools/` 下**任何**脚本都不许自己 `new WebSocket` 或写死 chrome.exe。
 * ============================================================================
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { profileDir, readRuntime, writeRuntime } from './paths.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────────── ① 找浏览器 ───────────────────────── */

const CANDIDATES = () => {
  const out = []
  const env = String(process.env.DOUYIN_BROWSER || '').trim()
  if (env) out.push(env)                                  // ① 用户显式指定，最高优先
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA, 'C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files', 'D:\\Program Files (x86)']
    for (const r of roots.filter(Boolean)) {
      out.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      out.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      out.push(join(r, 'Chromium', 'Application', 'chrome.exe'))
    }
    // 免安装版常见位置
    for (const r of roots.filter(Boolean)) out.push(join(r, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    out.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return out
}

/** 找得到就返回绝对路径，找不到返回 ''（不抛，让 doctor 去报） */
export function findBrowser() {
  for (const p of CANDIDATES()) {
    try { if (p && existsSync(p)) return p } catch { /* 继续找 */ }
  }
  return ''
}

/* ───────────────────────── ② 找端口 ───────────────────────── */

const portFree = (port) => new Promise((res) => {
  const s = createServer()
  s.once('error', () => res(false))
  s.once('listening', () => s.close(() => res(true)))
  s.listen(port, '127.0.0.1')
})

const cdpAlive = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false }
}

/**
 * 这个端口上的 Chrome 是不是**我们自己的**（同一个 user-data-dir）？
 *
 * 🔴 2026-10-28 血的教训：`pickPort` 原来只问「这个端口上有没有 CDP 在跑」，
 * 不问「跑的是不是我们那个 Chrome」。注释里写着「且是我们这个 profile」，
 * 但**代码里从来没有实现这个判断**。
 *
 * 后果：那天 `runtime.json` 的 cdpPort 被别的脚本改成了 9335，
 * 而 9335 上是**贴吧探针**的 Chrome（`E:\_bot\_tieba_probe\prof9335`）。
 * 于是 dm-auto-reply 连上一个没登录抖音的贴吧页面，`/chat` 会话列表
 * 永远 0 条 —— 连续 911 次 `list_fail`，私信一条都没回。
 *
 * 判据走 Chrome 进程命令行里的 `--user-data-dir`（Windows 上最可靠）。
 * 读不到就返回 `null`（"无法判断"），**不要当成不匹配** —— 读不到可能只是
 * PowerShell 慢或权限问题，误判会把本来正常的端口踢掉。
 */
const profileFromProcess = (port) => {
  if (process.platform !== 'win32') return null
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}(\\s|$)' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty CommandLine`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    })
    const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(String(out || ''))
    if (!m) return null
    return resolve(m[1] || m[2] || '')
  } catch { return null }
}

/**
 * 决定用哪个端口：
 *   ① 环境变量 IM_CDP_PORT 优先（调试时手动指定）
 *   ② runtime.json 里记着的端口，它上面有 CDP 在跑 **且 profile 对得上** ⇒ 复用
 *   ③ **扫 9334–9373，找 CDP 在跑且 profile 是我们的** ⇒ 复用并修正 runtime
 *      （2026-10-22 踩的坑：同一个 user-data-dir 不能起第二个 Chrome。
 *        如果只按"空闲端口"去挑，会挑到一个空端口然后起新实例 —— 新实例
 *        因为 profile 被占用直接退出，于是"60 秒连不上 CDP"。必须先找活着的。）
 *   ④ 都不行才找空闲端口起新的
 *
 * 🔴 ②③ 里的「profile 对得上」是 2026-10-28 补的，漏掉它会让整个插件
 *    安静地连到别人的浏览器上（详见 `profileFromProcess` 上方的注释）。
 */
export async function pickPort() {
  const forced = Number(process.env.IM_CDP_PORT || 0)
  if (forced) return forced

  const mine = resolve(profileDir())

  /** 端口活着 + 是我们的 profile ⇒ 返回 true。profile 判不出来时只信 runtime 里记的。 */
  const usable = async (p, trusted = false) => {
    if (!await cdpAlive(p)) return false
    const got = profileFromProcess(p)
    if (got) return got === mine
    return trusted  // 判不出来：只有 runtime 里记着的那个才敢信
  }

  const remembered = Number(readRuntime().cdpPort || 0)
  if (remembered && await usable(remembered, true)) return remembered

  // ③ 扫一遍：有没有已经活着的、且是我们 profile 的 CDP
  for (let p = 9334; p < 9334 + 40; p++) {
    if (p === remembered) continue
    if (await usable(p)) {
      writeRuntime({ cdpPort: p })
      return p
    }
  }

  // ④ 没有活的，找一个空闲端口起新的
  for (let p = 9334; p < 9334 + 40; p++) {
    if (await portFree(p)) return p
  }
  throw new Error('9334–9373 全被占用了，找不到空闲的调试端口')
}

/* ───────────────────────── ③ 起无头 Chrome ───────────────────────── */

/**
 * 保证有一个可用的无头 Chrome。
 * @returns {{port:number, status:'reused'|'launched', browser:string}}
 */
export async function ensureChrome({ url = 'https://www.douyin.com/' } = {}) {
  const port = await pickPort()
  if (await cdpAlive(port)) {
    writeRuntime({ cdpPort: port })
    return { port, status: 'reused', browser: readRuntime().browser || '' }
  }

  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      '找不到可用的浏览器。装一个 Chrome / Edge / Chromium 就行；'
      + '装在特殊位置的话，把完整路径写进环境变量 DOUYIN_BROWSER。',
    )
  }

  const profile = profileDir()
  mkdirSync(profile, { recursive: true })

  const p = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', '--lang=zh-CN',
    url,
  ], { detached: true, stdio: 'ignore' })
  p.unref()

  for (let i = 0; i < 60; i++) {
    if (await cdpAlive(port)) {
      writeRuntime({ cdpPort: port, browser })
      return { port, status: 'launched', browser }
    }
    await sleep(500)
  }
  throw new Error(`无头 Chrome 起来了但 ${port} 上连不上 CDP（60 秒超时）`)
}

/* ───────────────────────── ④ CDP 客户端 ───────────────────────── */

/**
 * 连上页面，返回 { send, ev, close, port }。
 * `ev(expr)` 在页面里求值并返回值 —— 大部分脚本只用得到这个。
 *
 * 🔴🔴 2026-10-29 —— 选页规则必须偏好 `/chat`，这是「群里不回话」的真根因。
 *
 * 原来只写 `list.find(含 douyin)`，取的永远排在列表第一个的页。而
 * `card-share.mjs` / `comment-api.mjs` / `comment-read-page.mjs` 会把**手上那个页**
 * 直接 `Page.navigate` 到 `/video/xxx`、`/note/xxx`，用完只 `ws.close()` 不导航回来。
 * 于是一天下来：那个唯一的 `/chat` 页被改成视频页 ⇒ 后面的 `group-send` 连上来
 * 找不到 `[data-e2e="conversation-item"]` ⇒ 点不开群 ⇒ `no-editor-after-open`。
 *
 * 实测（2026-10-29 17:10）：CDP 里堆了 13 个 page target（4 个 note + 3 个 video…），
 * 群里 12:30 / 12:41 / 13:50 / 14:20 / 15:21 五次全失败；把多余的页全关掉、
 * 只留一个 `/chat` 之后，同一条命令立刻 `{"ok":true,"sent":true,...}`。
 *
 * 所以：**优先挑 /chat**，没有 /chat 才退而求其次。
 */
export async function connectPage(port) {
  const usePort = Number(port) || (await pickPort())
  const list = await (await fetch(`http://127.0.0.1:${usePort}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page')
  const page = pages.find((t) => String(t.url).includes('douyin.com/chat'))
    || pages.find((t) => t.type === 'page' && String(t.url).includes('douyin'))
    || pages[0]
  if (!page) throw new Error('没有可用的 page target（Chrome 起来了吗？）')
  return await connectWs(page.webSocketDebuggerUrl, usePort)
}

/**
 * 清掉**不是** /chat 的抖音页面。
 *
 * 为什么要它：`card-share` / `comment-*` 每次都会把页导航到视频页，完了不回来。
 * 一天跑几十轮就堆成一坨，既占内存，又让 `connectPage` 有概率挑到视频页。
 * 留着唯一一个 `/chat` 就够所有收发脚本用。
 *
 * @returns {Promise<number>} 关掉了几个
 */
export async function killStrayPages(port) {
  const usePort = Number(port) || (await pickPort())
  let list = []
  try {
    list = await (await fetch(`http://127.0.0.1:${usePort}/json/list`)).json()
  } catch {
    return 0
  }
  const pages = list.filter((t) => t.type === 'page')
  const keep = pages.find((t) => String(t.url).includes('douyin.com/chat')) || pages[0]
  let n = 0
  for (const p of pages) {
    if (keep && p.id === keep.id) continue
    try {
      await fetch(`http://127.0.0.1:${usePort}/json/close/${p.id}`)
      n++
    } catch { /* 关不掉不影响 */ }
  }
  return n
}

/** 连一个具体的 devtools WebSocket 地址，返回 { send, ev, close, port }。 */
async function connectWs(wsUrl, usePort) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pend = new Map()
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('连不上 CDP WebSocket')), { once: true })
  })
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data) } catch { return }
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id); pend.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  })
  /**
   * 🔴 2026-10-31 修：**必须接 ws 的 close/error，否则悬空 promise 会让 Node 静默退出**。
   *
   * 实测事故（card-share.mjs 发视频卡片）：
   *   `killStrayPages()` 会把除 `/chat` 外的页关掉；如果这时我们正连着的 Target
   *   也被关、或者页面导航把 Target 换掉，ws 就断了。而 `send()` 的 90 秒 timer
   *   被 `unref()` 了 —— 它不参与事件循环计数。于是：
   *     ① pend 里的 res/rej 永远没人调（没人接 close 事件）；
   *     ② 唯一的 timer 又被 unref；
   *     ③ Node 判定「没有在等的活儿」→ 立刻退出，
   *    exit code = 13（unsettled top-level await），只打一行
   *   `Warning: Detected unsettled top-level await at .../card-share.mjs:94`，
   *   业务侧完全看不出发生了什么。这就是「视频卡片偶发发不出去」的真身。
   *
   * 处置：断线时把所有挂起的调成 reject（带明确 error），并记住 `` 状态，
   * 之后任何 send 立刻失败而不是静默挂死。
   */
  let closed = false
  const flushPend = (why) => {
    if (closed) return
    closed = true
    for (const [, { rej }] of pend) {
      try { rej(new Error(why)) } catch { /* 已经 settle 过 */ }
    }
    pend.clear()
  }
  ws.addEventListener('close', () => flushPend('CDP WebSocket 已断开（Target 被关或页面被替换）'))
  ws.addEventListener('error', () => flushPend('CDP WebSocket 出错'))
  /**
   * ⭐ 2026-10-25 修：**`send()` 必须带超时**。
   *
   * 原来这里是个裸 Promise —— CDP 那边不回（页面里的 fetch 卡在风控挑战、
   * 或者 `awaitPromise:true` 的 promise 永不 resolve），`pend` 里的 res/rej
   * 就永远挂着，整个工具无限等。
   * 实测：`comment-api.mjs` 卡满 240 秒才被外层 kill，日志只留
   * `{"error":"unknown"}`（因为子进程被杀了、没产出可解析的 JSON）。
   *
   * 默认 90 秒：比所有已知慢路径（翻 8 页 × 700ms + 一次 reply 探测）都宽，
   * 又不至于让一次卡死拖住整轮盯梢。
   */
  const SEND_TIMEOUT_MS = Number(process.env.IM_CDP_TIMEOUT_MS || 90_000)
  const send = (method, params = {}, timeoutMs = SEND_TIMEOUT_MS) => new Promise((res, rej) => {
    // ws 已断：立刻失败，别把调用方挂死（见上面 flushPend 的注释）
    if (closed) { rej(new Error('CDP WebSocket 已断开，无法发送 ' + method)); return }
    const mid = ++id
    /**
     * 计时器一定要在一有结果时 clear。
     *
     * 🔴 2026-10-31 更正：**不能 unref()**。
     *   原来这里 `timer.unref?.()` 是为了「没活儿干时 Node 能退出」，
     *   但代价是：如果 ws 断了而 pend 没被清（旧代码没接 close），
     *   唯一的 timer 又不计入事件循环 ⇒ Node 直接以 exit 13 静默退出，
     *   既不报超时也不报错。现在 close 事件会 flushPend，保留 unref 也安全；
     *   但仍然去掉 unref —— 超时本身就该把进程留住，好让调用方收到明确的
     *   「CDP 超时」而不是一个什么都没有的 code 13。
     */
    const timer = setTimeout(() => {
      pend.delete(mid)
      rej(new Error(`CDP ${method} 超时（${timeoutMs}ms 没回）—— 页面可能卡在风控/加载中`))
    }, timeoutMs)
    pend.set(mid, {
      res: (v) => { clearTimeout(timer); res(v) },
      rej: (e) => { clearTimeout(timer); rej(e) },
    })
    try { ws.send(JSON.stringify({ id: mid, method, params })) } catch (e) {
      clearTimeout(timer)
      pend.delete(mid)
      rej(e)
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 240))
    return r.result?.value
  }

  return {
    send, ev, port: usePort,
    close: () => { try { ws.close() } catch { /* 已经关了 */ } },
  }
}

/**
 * ⭐ 在一个**全新标签页**里打开 url，并连上它；顺手关掉旧的同站标签页。
 *
 * 为什么需要（2026-10-25 实测踩坑）：
 *   抖音 /chat 用久了 IM 连接会僵死 —— 左侧会话列表还在，右侧面板**永远转圈**
 *   （body 里挂着 0×0 display:none 的 rc-verifycenter/rmc-nocaptcha 隐藏风控 iframe），
 *   点开会话也永远等不到输入框。此时 Page.reload 也救不回来。
 *   唯一有效的办法是**开一个新标签页**（全新 IM websocket），会话立刻正常加载。
 *
 *   实测：旧页右栏 spinner + ce=0；新页点会话后 ce=1、历史消息全在。
 */
export async function openFreshTab(port, url = 'https://www.douyin.com/chat') {
  const usePort = Number(port) || (await pickPort())
  let oldIds = []
  try {
    const before = await (await fetch(`http://127.0.0.1:${usePort}/json/list`)).json()
    oldIds = before.filter((t) => t.type === 'page' && String(t.url).includes('douyin')).map((t) => t.id)
  } catch { /* 列表拿不到就别清旧页，能开新页就行 */ }

  // /json/new 必须 PUT（Chrome 111+ 拒绝 GET）
  const res = await (await fetch(`http://127.0.0.1:${usePort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  if (!res || !res.webSocketDebuggerUrl) throw new Error('开新标签页失败（/json/new 没返回 ws 地址）')

  const conn = await connectWs(res.webSocketDebuggerUrl, usePort)

  // 新页连上了，旧页就没必要留着（不关会越积越多，且它们还占着僵死的 IM 连接）
  for (const id of oldIds) {
    try { await fetch(`http://127.0.0.1:${usePort}/json/close/${id}`) } catch { /* 关不掉不影响 */ }
  }
  return { ...conn, status: 'fresh-tab', browser: readRuntime().browser || '', newTargetId: res.id }
}

/**
 * ⭐ 在一个**新标签页**里打开 url，**一个已有标签页都不动**，并连上它。
 *
 * 和 `openFreshTab` 的区别（很重要，别混用）：
 *   · `openFreshTab` 连上之后会把旧的同站标签页全关掉 —— 它假设调用方要「重置」这个站
 *   · 这个一个都不关 —— 调用方是在别人的循环里插一脚（比如 dm-auto-reply 每 30 秒
 *     要读一次 /chat），把主循环正在用的那个页关掉就等于把它的饭碗砸了
 *
 * 返回值多一个 `dispose()`：关掉自己这一页（只关自己的），必须用完就调。
 */
export async function openIsolatedTab(port, url = 'about:blank') {
  const usePort = Number(port) || (await pickPort())
  const res = await (await fetch(`http://127.0.0.1:${usePort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  if (!res || !res.webSocketDebuggerUrl) throw new Error('开新标签页失败（/json/new 没返回 ws 地址）')
  const conn = await connectWs(res.webSocketDebuggerUrl, usePort)
  const targetId = res.id
  return {
    ...conn,
    status: 'isolated-tab',
    newTargetId: targetId,
    dispose: async () => {
      try { conn.close() } catch { /* 已经关了 */ }
      try { await fetch(`http://127.0.0.1:${usePort}/json/close/${targetId}`) } catch { /* 关不掉就留着，不影响功能 */ }
    },
  }
}

/** 一步到位：确保 Chrome + 连上页面。脚本里最常用这个。 */
export async function openPage(opts = {}) {
  const { port, status, browser } = await ensureChrome(opts)
  const page = await connectPage(port)
  return { ...page, status, browser }
}

/* ───────────────────────── 体检（给 doctor 用） ───────────────────────── */

export async function chromeDoctor() {
  const browser = findBrowser()
  const remembered = Number(readRuntime().cdpPort || 0)
  const alive = remembered ? await cdpAlive(remembered) : false
  const port = alive ? remembered : await pickPort().catch(() => 0)
  return {
    browser: browser || '',
    browser_found: Boolean(browser),
    cdp_port: port,
    cdp_alive: alive,
    profile: profileDir(),
    env_override: String(process.env.DOUYIN_BROWSER || ''),
  }
}

export { homedir }
