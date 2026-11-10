#!/usr/bin/env node
/**
 * tools/comment-read-page.mjs —— 读某条作品下的评论（**在无头页面的上下文里 fetch**）
 * ============================================================================
 * 为什么要有这个文件（2026-10-25 新加）：
 *   原来的读评论链路是 api-comments.py → dy-signer.mjs → 自己拼签名 → httpx.get。
 *   但 dy-signer.mjs 需要 `$DOUYIN_HOME/signer/sdk/` 下 7 个 js 文件 + jsdom，
 *   本机一个都没有 ⇒ 一跑就 KeyError: 'signedUrl'，读评论整个功能是死的。
 *
 *   而同一个仓库里的 comment-api.mjs 一直好好的 —— 因为它是**站在 douyin.com 页面上
 *   用页面自己的 fetch**，签名由页面里的 webmssdk 自动补齐，根本不用我们签。
 *   ⇒ 读评论完全可以走同一条路，把签名器彻底绕开。
 *
 * 和 comment-read-dom.mjs 的分工：
 *   · comment-read-dom.mjs —— 滚 DOM 抓（能拿 UI 上的全部字段，但慢、受虚拟化影响，
 *     一次只能翻到几十条）
 *   · 本文件 —— 直接打接口（快、能翻很多页、字段全），只在必要时才用 DOM
 *   两条互为备份：接口挂了用 DOM，DOM 抓不全用接口。
 *
 * 用法:
 *   node tools/comment-read-page.mjs --aweme <id>                       # 顶层评论，默认 20 条
 *   node tools/comment-read-page.mjs --aweme <id> --count 50 --pages 3  # 翻 3 页共约 60 条
 *   node tools/comment-read-page.mjs --aweme <id> --mine                # 只看「我」发的
 *   node tools/comment-read-page.mjs --aweme <id> --grep CCCPsound      # 按昵称/正文筛
 *   node tools/comment-read-page.mjs --aweme <id> --cid <cid>           # 只看某条楼里的回复
 *   node tools/comment-read-page.mjs --aweme <id> --ids <cid,cid,...>  # 按 cid 精确回读（含审核中的）
 *
 * 输出一行 JSON：{ ok, aweme_id, total, mine_n, matched_n, comments:[...], chrome }
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openIsolatedTab, ensureChrome, sleep } from '../lib/chrome.mjs'
import { homeDir } from '../lib/paths.mjs'

/**
 * 我自己的 uid 从哪来：
 *   页面里的 window.__INIT_PROPS__ 常常拿不到（抖音改成懒加载了），
 *   但 `$DOUYIN_HOME/account.json` 里一定有 —— 那是登录时写下的。
 *   --mine 靠它判定，比按昵称匹配可靠得多（昵称能改、能重名）。
 */
function myUidFromAccount() {
  try {
    const j = JSON.parse(readFileSync(join(homeDir({ create: false }), 'account.json'), 'utf8'))
    return String(j.uid || '')
  } catch { return '' }
}

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEME = String(argOf('--aweme', '')).trim()
const MINE = argv.includes('--mine')
const GREP = String(argOf('--grep', '')).trim()

/**
 * 默认值为什么要按用法分（2026-10-25 血泪教训）：
 *
 *   抖音顶层评论接口**按热度排序**。新评论 0 赞，落在很后面。
 *   实测某视频 870 条评论：自己发的 6 条在第 60~70 页之后（count=20 时）。
 *     --count 20 --pages 1  → 只读到 20 条    → mine_n 恒为 0，报「没发出去」
 *     --count 50 --pages 20 → 读到 870 条全量 → mine_n 6，找到了
 *   于是「评论明明挂在评论区里」被一路误报成失败，使用者截图一看就在最上面。
 *
 *   ⇒ 「找人」用法（--mine / --grep）必须扫全量；单纯浏览才用小值。
 */
const COUNT_ARG = argOf('--count', '')
const COUNT = COUNT_ARG !== ''
  ? Math.max(1, Math.min(50, Number(COUNT_ARG) || 0))
  : (MINE || GREP ? 50 : 20)
const PAGES_ARG = argOf('--pages', '')
const PAGES = PAGES_ARG !== ''
  ? Math.max(1, Math.min(200, Number(PAGES_ARG) || 0))
  : (MINE || GREP ? 20 : 1)
const CID = String(argOf('--cid', '')).trim()
/**
 * --ids：按 cid 精确回读。逗号分隔。
 * 存在的唯一理由：抖音的评论审核（status=7）不出现在普通列表里，
 * 不发 insert_ids 就永远验不出来「到底发没发成功」—— 会误判成失败。
 */
const IDS = String(argOf('--ids', '')).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20)

function die(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }, null, 1))
  process.exit(1)
}

if (!AWEME) die('用法: comment-read-page.mjs --aweme <id> [--count 20] [--pages 1] [--mine] [--grep kw] [--cid cid]')

try {
  /**
   * 🔴 2026-11-10：不借 `/chat` 页，自己开一个。
   * 这个脚本要把页面导航到 `/video/<id>` 才能读评论区 —— 导航会替换 CDP Target，
   * 正在用 `/chat` 的 `look-video` / `dm-auto-reply` 会当场 ws 断连，之后成片
   * `video_fail: CDP WebSocket 已断开`。老版本靠「用完导航回 /chat」补救，
   * 但断已经发生了。自己开页、用完 dispose，两边都干净。
   */
  const { port: _cp } = await ensureChrome({ url: 'https://www.douyin.com/chat' })
  const c = await openIsolatedTab(_cp, `https://www.douyin.com/video/${AWEME}`)
  const chromed = c.status
  // 页是自己的了，跑完直接 dispose，不需要「还回去」
  process.on('exit', () => { try { c.dispose && c.dispose() } catch { /* 已经关了 */ } })

  /* 必须站在 douyin.com 上：相对路径 fetch 才带得上 cookie，页面签名器才挂在 window 上 */
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
    await sleep(6000)
  }

  /**
   * 整个翻页 + 筛选都在页面里做完再一次性返回。
   * 为什么不一段段 ev() 取：每跨一次 CDP 都要序列化，100 条评论能多花好几秒；
   * 而且分页游标必须连续，跨调用容易被别的操作插进来。
   */
  /* 自己的 uid 优先用 account.json 里的（页面 __INIT_PROPS__ 常常是懒加载、拿不到） */
  const MY_UID = myUidFromAccount()

  const expr = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var COUNT = ${COUNT};
    var PAGES = ${PAGES};
    var CID   = ${JSON.stringify(CID)};
    var IDS   = ${JSON.stringify(IDS)};
    var MYUID = ${JSON.stringify(MY_UID)};
    var COMMON = {
      device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
      pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
      cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
      browser_language:'zh-CN', browser_platform:'Win32',
      browser_name:'Chrome', browser_version:'141.0.0.0',
      engine_name:'Blink', engine_version:'141.0.0.0',
      os_name:'Windows', os_version:'10', platform:'PC'
    };
    function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
    async function get(rel){
      var r = await fetch(rel, { credentials:'include', headers:{ accept:'application/json' } });
      var t = await r.text();
      try { return JSON.parse(t) } catch(e) { return { __parse_error: t.slice(0,200) } }
    }
    /* 我自己的 uid：account.json 已传入；页面里只是兜底，两处都拿不到就不筛 */
    var myUid = MYUID || '';
    if (!myUid) {
      try {
        var st = window.__INIT_PROPS__ || {};
        myUid = String((st.userInfo && (st.userInfo.uid || st.userInfo.userId)) || '');
      } catch(e) {}
    }

    var out = [], cursor = 0, pages = 0, hasMore = true, raw0 = null;
    var MAXPAGES = IDS.length ? 1 : PAGES;   /* 定向回读只打一次 */
    while (pages < MAXPAGES && hasMore) {
      var rel = CID
        ? '/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
            item_id: AWEME, comment_id: CID, count: String(COUNT), cursor: String(cursor), item_type: '0'
          }))
        : '/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
            aweme_id: AWEME, count: String(COUNT), cursor: String(cursor), item_type: '0'
          }));
      var j = await get(rel);
      if (!j) break;
      if (pages === 0) raw0 = j;
      var cs = j.comments || [];
      for (var i = 0; i < cs.length; i++) {
        var x = cs[i];
        out.push({
          cid: String(x.cid || ''),
          text: String(x.text || '').replace(/\\n/g, ' '),
          nick: String((x.user && x.user.nickname) || ''),
          uid: String((x.user && x.user.uid) || ''),
          sec_uid: String((x.user && x.user.sec_uid) || ''),
          digg: Number(x.digg_count) || 0,
          reply_n: Number(x.reply_comment_total) || (x.reply_comment ? x.reply_comment.length : 0) || 0,
          reply_id: String(x.reply_id || ''),
          root: String(x.root_comment_id || x.reply_id || ''),
          level: Number(x.level) || 0,
          is_author: Boolean(x.is_author),
          /* status=7 是「审核中」：能读到但不对别人展示。0/不返回才是已放出 */
          status: Number(x.status) || 0,
          create_time: Number(x.create_time) || 0,
          /* 楼里前几条顺手带出来 —— 判「有没有人回我」时经常要用 */
          replies: (x.reply_comment || []).slice(0, 5).map(function(r){
            return { cid: String(r.cid||''), nick: String((r.user&&r.user.nickname)||''),
                     uid: String((r.user&&r.user.uid)||''), text: String(r.text||'').replace(/\\n/g,' '),
                     reply_id: String(r.reply_id||''), create_time: Number(r.create_time)||0 };
          }),
        });
      }
      hasMore = Boolean(j.has_more);
      var nc = Number(j.cursor);
      if (!isFinite(nc) || nc === cursor) break;   /* 游标没动就别再打，防死循环 */
      cursor = nc;
      pages++;
      if (!cs.length) break;
    }

    /**
     * ⚠️ insert_ids 是「**插入**」不是「过滤」：带上它，服务端会把那几条塞进返回，
     *    但**整页其他评论照样一起回来**（实测要 1 个 cid 回了 15 条）。
     *    ⇒ 这里必须自己按 cid 精确筛掉，否则 --ids 就退化成「读一页」，
     *      调用方会以为那 15 条都是自己发的。
     */
    if (IDS.length) {
      out = out.filter(function (x) { return IDS.indexOf(x.cid) >= 0 });
    }

    return JSON.stringify({
      ok: true,
      aweme_id: AWEME,
      scope: IDS.length ? 'by-ids' : (CID ? 'reply-of-' + CID : 'top-level'),
      ids_requested: IDS.length ? IDS : undefined,
      pages_fetched: pages,
      status_code: raw0 ? raw0.status_code : null,
      status_msg: raw0 ? (raw0.status_msg || '') : '',
      my_uid: myUid,
      comments: out,
    });
  })()`

  const raw = await c.ev(expr)
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    die('页面返回的不是 JSON：' + String(raw).slice(0, 300))
  }
  if (!data || !data.ok) die('页面里没拿到评论：' + JSON.stringify(data).slice(0, 300))

  let list = data.comments || []
  const total = list.length

  /* --mine：优先按 my_uid 判；uid 拿不到就退回「按 --grep 或配置里的昵称」 */
  if (MINE) {
    if (data.my_uid) list = list.filter((x) => x.uid === data.my_uid)
    else list = []   /* 拿不到自己的 uid 就返回空，并让下面提醒 —— 绝不假装筛过 */
  }
  if (GREP) {
    const g = GREP.toLowerCase()
    list = list.filter((x) => (x.nick || '').toLowerCase().includes(g) || (x.text || '').toLowerCase().includes(g))
  }

  /**
   * status 语义 —— 2026-10-25 用真实账号实测校正（之前理解错了，导致一连串假失败）
   *
   * 实测场景：某视频 869 条顶层评论，本人（昵称「小鲸鱼」）发的 6 条全在列表里，
   * 但 status 分布是 `{1: 863, 3: 5, 2: 1}` —— **别人的评论一律 1，自己新发的才是 3/2**。
   * 同时使用者截图显示「这狗一看就是被惯坏的…刚刚」明明就挂在评论区最顶上（status=3）。
   *
   * 结论：
   *   · status=1 → 常规评论（绝大多数）
   *   · status=3 → **我也是正常显示**，只是被标成「新提交」
   *   · status=2 → 同上，另一种新提交标记
   *   · status=7 → 这条才是真的「审核中」（本机没实拍到，但仓库注释与接口文档一致）
   *   ⇒ **不能用 status 判「发没发出去」**。cid 能按 insert_ids 读回来 = 服务端确实收下了；
   *      status 只是附加标记，单独报给调用方自己看。
   *
   * 之前写「只有 status=1 才算 published」是错的：把 3/2 当成失败，
   * 于是「评论好好地在评论区里」被报成「没发出去」。别再退回去。
   */
  const STATUS_PENDING = new Set([7])   // 只有 7 是「审核中、对别人不展示」
  const isPending = (x) => STATUS_PENDING.has(Number(x.status))
  const pending_n = list.filter((x) => isPending(x)).length
  const out = {
    ok: true,
    aweme_id: data.aweme_id,
    scope: data.scope,
    pages_fetched: data.pages_fetched,
    status_code: data.status_code,
    total,
    mine_n: MINE ? list.length : undefined,
    matched_n: GREP || MINE ? list.length : undefined,
    my_uid: data.my_uid || '(拿不到)',
    pending_n,
    chrome: chromed,
    comments: list,
  }
  if (pending_n) {
    const codes = [...new Set(list.filter((x) => isPending(x)).map((x) => Number(x.status)))].join('/')
    out.warning =
      `其中 ${pending_n} 条 status=${codes}（审核中），接口能按 cid 读到，但评论区列表里暂时刷不到。`
      + '这不是失败，是抖音还在审；过一阵再读。'
  }
  if (MINE && !data.my_uid) {
    out.warning = '拿不到自己的 uid，--mine 无法判定，结果为空。改用 --grep <你的昵称>。'
  }
  if (data.status_msg) out.status_msg = data.status_msg

  console.log(JSON.stringify(out, null, 1))
  // 页是自己开的，直接 dispose 关掉；`/chat` 从头到尾没被碰过，无需「还回去」
  try { if (c.dispose) await c.dispose(); else c.close() } catch { /* 关不掉不影响结果 */ }
} catch (e) {
  die(String(e?.message ?? e).slice(0, 400))
}
