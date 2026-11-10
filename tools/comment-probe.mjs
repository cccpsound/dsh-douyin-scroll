#!/usr/bin/env node
/**
 * tools/comment-probe.mjs —— 只读探针：查一条评论到底在哪个位置（level1 / 楼中楼 / 已删）
 * ============================================================================
 * 为什么需要它：
 *   `comment-api.mjs` 判楼根失败时会报 `need_root` 然后拒绝发送 —— 这是对的
 *   （瞎猜就会变成一条悄悄冒出来的顶层评论）。但它判不出来的原因有三种，
 *   处理方式完全不同：
 *     ① 这条评论**已经删了/审核中**  ⇒ 回不了，直接放弃，别再重试
 *     ② 它在某栋楼里，但顶层翻页没翻到 ⇒ 找出真正的楼根再回
 *     ③ 它自己就是楼根，只是没翻到    ⇒ root = 它自己
 *   所以需要一条只读探针，把「这条 cid 的 level / reply_id / 顶层列表里有没有」
 *   三件事一次查清，而且**不发任何东西**。
 *
 * 用法:
 *   node tools/comment-probe.mjs --aweme <id> --cid <cid> [--pages 4]
 *
 * 输出一行 JSON：
 *   { ok, cid, level, reply_id, found_in, note,
 *     in_top: bool, top_cid, top_text, has_replies, replies_total }
 */
import { openIsolatedTab, ensureChrome, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

const AWEME = String(argOf('--aweme', '')).trim()
const CID = String(argOf('--cid', '')).trim()
const PAGES = Math.max(1, Math.min(Number(argOf('--pages', '4')) || 4, 10))

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!CID) { out({ ok: false, error: '缺 --cid' }); process.exit(1) }

try {
  // 2026-11-10：自己开页，不借 `/chat`（借了再导航会把别人的 CDP 连接断掉）
  const { port: _cp } = await ensureChrome({ url: 'https://www.douyin.com/chat' })
  const c = await openIsolatedTab(_cp, 'https://www.douyin.com/')
  process.on('exit', () => { try { c.dispose && c.dispose() } catch { /* 已经关了 */ } })
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }

  /**
   * 🔴 这段在 `c.ev(...)` 的模板字符串里 ⇒ 注释里不能出现反引号（会提前闭合模板）。
   */
  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var TARGET = ${JSON.stringify(CID)};
    var PAGES = ${PAGES};
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
    var race = function(p, ms, tag){
      return Promise.race([p, new Promise(function(_, rej){
        setTimeout(function(){ rej(new Error('timeout:' + tag)) }, ms);
      })]);
    };
    async function get(rel){
      try {
        var r = await race(fetch(rel, { credentials:'include', headers:{ accept:'application/json' } }), 8000, 'head');
        var t = await race(r.text(), 8000, 'body');
        try { return JSON.parse(t) } catch(e) { return null }
      } catch(e) { return null }
    }
    var R = { ok:true, cid:TARGET, level:null, reply_id:'', found_in:'', note:'',
              in_top:false, top_cid:'', top_text:'', has_replies:false, replies_total:0 };

    // ① insert_ids 定向取（最可靠：服务端会把这条单独插进返回，审核中的也读得到）
    var probe = await get('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
      aweme_id: AWEME, count: '20', cursor: '0', item_type: '0', insert_ids: TARGET
    })));
    if (probe && probe.comments) {
      for (var i = 0; i < probe.comments.length; i++) {
        var pc = probe.comments[i];
        if (String(pc.cid) !== TARGET) continue;
        R.level = (pc.level === undefined ? null : Number(pc.level));
        R.reply_id = String(pc.reply_id || '');
        R.status = Number(pc.status) || 0;
        R.found_in = 'insert-ids';
        R.text = String(pc.text || '').slice(0, 80);
        break;
      }
    }
    if (!R.found_in) {
      R.status_code = (probe && probe.status_code !== undefined) ? Number(probe.status_code) : null;
    }

    // ② 翻顶层列表（自己的楼里前几条 reply_comment 也一起扫）
    var cursor = 0, pages = 0;
    while (pages < PAGES) {
      var j = await get('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
        aweme_id: AWEME, count: '20', cursor: String(cursor), item_type: '0'
      })));
      if (!j) break;
      var cs = j.comments || [];
      for (var x = 0; x < cs.length; x++) {
        var cm = cs[x];
        if (String(cm.cid) === TARGET) {
          R.in_top = true; R.top_cid = String(cm.cid);
          if (R.level === null) R.level = 1;
          R.found_in = R.found_in || 'top-list';
          break;
        }
        var rs = cm.reply_comment || [];
        for (var k = 0; k < rs.length; k++) {
          if (String(rs[k].cid) === TARGET) {
            R.in_top = true; R.top_cid = String(cm.cid);
            R.top_text = String(cm.text || '').slice(0, 60);
            if (R.level === null) R.level = 2;
            R.found_in = R.found_in || 'top-list-thread';
            break;
          }
        }
        if (R.top_cid) break;
      }
      if (R.top_cid) break;
      if (!j.has_more) break;
      var next = Number(j.cursor || 0);
      if (!next || next === cursor) break;
      cursor = next; pages++;
      await new Promise(function(r){ setTimeout(r, 700) });
    }

    // ③ 问接口「这条底下有没有楼中楼」—— 有 ⇒ 它自己是楼根
    var rj = await get('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
      item_id: AWEME, comment_id: TARGET, cursor: '0', count: '1', item_type: '0'
    })));
    if (rj) {
      R.replies_total = Number(rj.total || 0);
      R.has_replies = R.replies_total > 0;
    }

    // ④ 给结论：root 到底是什么
    if (R.level === 1 || R.in_top && R.level === 1) {
      R.root = TARGET; R.note = '它是顶层评论 ⇒ 楼根就是它自己';
    } else if (R.reply_id && R.reply_id !== '0') {
      R.root = R.reply_id; R.note = '它是楼中楼 ⇒ 楼根是 reply_id';
    } else if (R.top_cid) {
      R.root = R.top_cid; R.note = '在顶层列表的某栋楼里找到 ⇒ 楼根是那栋楼';
    } else if (R.has_replies) {
      R.root = TARGET; R.note = '它底下有楼中楼 ⇒ 它自己是楼根';
    } else {
      R.root = '';
      R.note = R.found_in
        ? '查到了它但判不出位置（无 reply_id / 不在任何楼里）'
        : '三条路都没查到它（多半已删 / 审核中 / 通知里的 cid 已失效）';
    }
    return JSON.stringify(R);
  })()`

  let r = null
  try { r = JSON.parse(await c.ev(js)) } catch { r = { ok: false, error: '探针没返回可解析结果' } }
  await c.dispose()
  await sleep(200)
  out(r)
} catch (e) {
  out({ ok: false, error: `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}` })
  process.exit(1)
}
