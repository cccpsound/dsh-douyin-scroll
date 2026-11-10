#!/usr/bin/env node
/**
 * tools/comment-read-dom.mjs —— 从**评论区 DOM** 里读评论（绕开"按热度只翻 80 条"的接口盲区）
 * ============================================================================
 * 为什么要有这个：`api-comments.py` 走 `/comment/list/`，只翻 4 页 × 20 条 = 前 80 条，
 * 而且**按热度排序**。刚发的评论热度是 0，永远进不了前 80 ⇒
 * 「列表里没有」根本不能证明没发出去（2026-10-22 实测：连早上确认上榜的评论都读不到）。
 *
 * DOM 这条路不一样：页面评论区默认按**最新**渲染，往下滚就能翻到自己的评论。
 *
 * 用法:
 *   node tools/comment-read-dom.mjs --aweme <id>                  # 读前 N 条评论
 *   node tools/comment-read-dom.mjs --aweme <id> --mine           # 只找「我自己」发的
 *   node tools/comment-read-dom.mjs --aweme <id> --mine --scroll 6 # 往下滚 6 屏再找
 *   node tools/comment-read-dom.mjs --aweme <id> --grep 关键词
 *
 * 输出：一行 JSON {ok, aweme_id, total, mine_n, items:[{nick, text, mine}]}
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openPage, sleep } from '../lib/chrome.mjs'

/**
  * ⭐ "我"的抖音昵称 —— **不能写死**（写死的话，别人装了永远匹配不上自己的号）。
 *    顺序：环境变量 DOUYIN_ME_NICK → 插件家目录 account.json 里的 nick → 空
 *    account.json 是扫码登录/体检时自动记下来的（见 index.js /account）。
 *    拿不到就返回空串 ⇒ --mine 只按"记忆里我发过的正文"匹配，不瞎猜昵称。
 */
const ME = (() => {
  const fromEnv = String(process.env.DOUYIN_ME_NICK || '').trim()
  if (fromEnv) return fromEnv
  try {
    const home = process.env.DOUYIN_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'douyin-duty')
    const j = JSON.parse(readFileSync(join(home, 'account.json'), 'utf8'))
    return String(j.nick || '').trim()
  } catch { return '' }
})()

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const AWEME = String(argOf('--aweme', '')).trim()
const MINE = argv.includes('--mine')
const GREP = String(argOf('--grep', '')).trim()
const SCROLLS = Math.max(0, Math.min(Number(argOf('--scroll', '3')) || 0, 20))
const LIMIT = Math.max(1, Math.min(Number(argOf('--limit', '40')) || 40, 200))

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }

async function main() {
  const c = await openPage()
  const chromed = c.status
  const { send, ev } = c

  try {
    await send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
    await sleep(6500)

    // 点开评论面板（右侧栏那个「评论」）
    await ev(`(function(){
      var c=document.querySelector('[data-e2e="feed-comment-icon"]')||document.querySelector('[data-e2e="comment-icon"]');
      if(!c){var all=[].slice.call(document.querySelectorAll('span,div')).filter(function(e){return (e.innerText||'').trim()==='评论'});c=all[0]}
      if(c) c.click();
      return !!c;
    })()`)
    await sleep(3500)

    // 往下滚，让更多评论渲染出来。
    // ⭐ 滚对容器（2026-10-25 实测血泪教训）：抖音页面的滚动容器不是 window，
    //    而是 div.parent-route-container（实测 scrollTop:293 / scrollHeight:50037 / clientHeight:833）。
    //    窗口是固定高度不全高，滚 window 永远滚不动 ⇒ 评论根本没往下加载，扫几屏都是空的。
    //    所以这里直接拿那个容器改 scrollTop，不靠 mouseWheel 滚坐标。
    const scroller = await ev(`(function(){
      var sc = document.querySelector('.parent-route-container')
            || document.querySelector('.route-scroll-container')
            || document.scrollingElement || document.documentElement;
      return JSON.stringify({ found: !!document.querySelector('.parent-route-container'), top: sc.scrollTop, sh: sc.scrollHeight, ch: sc.clientHeight });
    })()`)
    for (let i = 0; i < SCROLLS; i++) {
      await ev(`(function(){
        var sc = document.querySelector('.parent-route-container')
              || document.querySelector('.route-scroll-container')
              || document.scrollingElement || document.documentElement;
        sc.scrollTop += 800;
        return sc.scrollTop;
      })()`)
      await sleep(900)
    }
    await sleep(800)

    /**
     * 从 DOM 里抓评论条目。
     * 结构：每条评论是一个 [data-e2e="comment-item"]（旧版）或者
     * 「头像 + 昵称 + 正文 + 时间·地区 + 点赞/分享/回复」这一坨。
     * 这里两种都试：先按 data-e2e 找，找不到就按昵称节点的父级兜。
     */
    const raw = await ev(`(function(){
      var items=[];
      var nodes=Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"]'));
      if(!nodes.length){
        // 兜底：找所有可能是"昵称"的短文本节点，往上找 3 层当一条评论
        var cands=[].slice.call(document.querySelectorAll('div')).filter(function(e){
          var t=(e.innerText||'').trim();
          return t && t.indexOf('\\n')>0 && t.length>8 && t.length<600;
        });
        nodes = cands.slice(0,400);
      }
      nodes.forEach(function(n){
        var t=(n.innerText||'').replace(/\\r/g,'');
        if(!t || t.length<6) return;
        var lines=t.split('\\n').map(function(s){return s.trim()}).filter(Boolean);
        if(!lines.length) return;
        var nick=lines[0];
        if(nick.length>24) return;
        // 正文 = 昵称后面、时间行前面那段
        var body=[];
        for(var i=1;i<lines.length;i++){
          if(/^(\\d+[秒分时天周月年]前|刚刚|昨天|前天)/.test(lines[i])) break;
          if(/^\\d+$/.test(lines[i])) break;
          if(lines[i]==='分享'||lines[i]==='回复') break;
          body.push(lines[i]);
        }
        if(!body.length) return;
        items.push({ nick: nick, text: body.join(' ').slice(0,300) });
      });
      // 去重（同昵称+同正文）
      var seen={},u=[];
      items.forEach(function(o){var k=o.nick+'|'+o.text; if(!seen[k]){seen[k]=1;u.push(o)}});
      return JSON.stringify(u);
    })()`)

    let items = []
    try { items = JSON.parse(raw) || [] } catch { items = [] }
    items = items.filter((o) => o && o.nick && o.text)
    // ⚠️ ME 可能是空串（没登录 / 拿不到 account.json）⇒ 不能拿 '' 去比对，否则全是 false
    //    这时 mine 一律 false，并在输出里说明"不知道自己是谁"
    items.forEach((o) => { o.mine = Boolean(ME) && o.nick === ME })

    let sel = items
    if (MINE) sel = items.filter((o) => o.mine)
    if (GREP) sel = sel.filter((o) => o.text.includes(GREP))

    return out({
      ok: true,
      aweme_id: AWEME,
      chrome: chromed,
      me_nick: ME || '(不知道 —— 先扫码登录，或设 DOUYIN_ME_NICK)',
      total_scraped: items.length,
      mine_n: items.filter((o) => o.mine).length,
      matched_n: sel.length,
      // 找到就带 cid 之外的证据；没找到也老实说"没扫到"，不等于没发出去
      note: sel.length ? undefined
        : `滚了 ${SCROLLS} 屏只扫到 ${items.length} 条评论，没扫到${MINE ? '自己的' : '匹配的'} —— **不等于没发出去**（评论可能还在审核，或滚得不够深，加 --scroll 再试）`,
      items: sel.slice(0, LIMIT),
    })
  } finally {
    c.close()
    await sleep(200)
  }
}

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }))
