#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""web-search.py —— 查「这个词是什么意思」，专治黑话 / 梗 / 缩写。

为什么要有它（2026-10-28 实测结论）：

  抖音搜索擅长「事件 / 人物 / 作品」，**不擅长词义和黑话**。
  群里有人说「你扎啤吧」，抖音搜出来全是啤酒科普和「你就是想发这吊歌」，
  提炼出来的释义是错的 —— 脏数据一旦入库，下次她会拿它一本正经地答人。

  搜狗 wap 的 AI 摘要（元宝直出）拿到了这句，比十条搜索结果的摘要都强：
      「网络热梗"扎啤"并非指啤酒，而是西南方言"杂皮"（或"杂痞"）的谐音"空耳"。
        该词带有贬义和调侃色彩，用以代指品行不端或行为出丑的人。
        常见用法：弹幕或评论区刷"你扎啤吧"…多用来吐槽或调侃对方犯傻、操作下饭」

  分工：
      dy-search.py  → 查「发生了什么」「谁是谁」（视频 + 高赞评论）
      web-search.py → 查「这词啥意思」（AI 摘要 / 网页）

🔴 实测的坑（别再踩）：

  1. **百度 / 夸克都死在反爬**：`www.baidu.com/s`、`m.baidu.com/s` 都返回 1438 字节的
     「百度安全验证」页；`quark.sm.cn` 只回 1351 字节空壳。
  2. **搜狗 PC 版三次就封**：`www.sogou.com/web?query=` 返回 5455 字节的
     `antispider.min.js` 页。**wap 版（`wap.sogou.com/web/searchList.jsp`）能多撑几次**，
     连续 5~6 次后也封成 5103~5126 字节，之后静置 30 秒变 `HTTP 403`，
     带 cookie（先访问首页拿 SNUID/SUV/ABTEST/wuid）也没用。**是按 IP 限的。**
  3. wap 版的结果列表是 JS 渲染的空壳，但 **AI 摘要是服务端直出的**，
     所以优先抠 answer 块，别去解析 JS 里那坨 JSON。
  4. 追问后缀只加「是什么意思」。加「骂人」「梗」这种限定词反而把结果带偏 ——
     实测「扎啤 骂人 是什么意思」十条全是啤酒工艺文章。
  5. 头条搜索（`so.toutiao.com`）能拿到 1.8MB 但不拦，可对黑话完全无用：
     搜「扎啤」全是啤酒工艺与 `jar`/`draft` 的词源考据，**不知道它是骂人话**。
     bing 同理（`飞舞`→歌曲、`灭建国`→字典词条、`塔菲`→古塔文章）。
     所以 bing 只当兜底：它对「yyds」这种**英文缩写**还行。

因此本文件的三条设计：

  A. 搜狗 wap 的 AI 摘要优先，且**必须过质量闸**（见 answer_ok）——
     `yyds` 那次摘要只回了「马金鹿」两个字，那种脏摘要必须丢掉。
  B. 短时间内不重复打同一家（`_LAST_AT` 记时间戳，默认 20 秒一次），
     因为搜狗是**按 IP 限流**，连续打只会把自己封掉。
  C. 结果落盘缓存（`<home>/cache/websearch.json`，默认 3 天），
     查过的词不再打网。梗库本身就是第一层缓存，这是第二层。

用法：
    python web-search.py --q "扎啤"
    python web-search.py --q "yyds" --no-suffix
    python web-search.py --q "扎啤" --top 5

输出 JSON：
    {"ok":true,"query":"扎啤 是什么意思","engine":"sogou-wap",
     "answer":"<AI 摘要原文，没有则为空串>",
     "items":[{"title":"...","desc":"...","score":9}],
     "cached":false,"ms":782}

`score` 是本文件里的**梗解释倾向分**（见 score_item），越高越像在解释这个词。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA_MOBILE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
UA_DESKTOP = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

SUFFIX = " 是什么意思"
MAX_ANSWER_CHARS = 400
MIN_ANSWER_CHARS = 40          # 短于这个的摘要不用（实测「yyds」只回「马金鹿」）
MIN_GAP_SEC = 20.0             # 同一次进程内两次网络请求的最小间隔（搜狗按 IP 限流）
CACHE_TTL = 3 * 86400
CACHE_KEEP = 300               # 缓存最多留多少个词

# 降权：这些词出现说明这条在讲**字面义 / 商品 / 作品**，不是在解释梗
_NOT_MEME = re.compile(
    r"(百科|做法|区别|价格|多少钱|功效|热量|歌词|歌曲|专辑|歌手|演唱|"
    r"电影|电视剧|综艺|小说|下载|购买|批发|加盟|招商|配方|酿造|过滤|杀菌|"
    r"制作方法|家常|好吃|营养|词源|音译|翻译|英文|拼音)"
)

# 加权：这些词出现说明**这条就是在解释这个词怎么用**
_IS_MEME = re.compile(r"(梗|什么意思|啥意思|骂人|脏话|黑话|网络用语|流行语|谐音|缩写|代指|称呼|空耳)")

_TAIL = re.compile(r"(详情|更多|展开|阅读更多|查看全文|内容由AI生成|仅供参考)\s*$")

# 上一次真正打网的时间戳（进程内）
_LAST_AT = [0.0]


def _clean(x: str) -> str:
    x = re.sub(r"<[^>]+>", "", x or "")
    for a, b in (("&ensp;", " "), ("&nbsp;", " "), ("&quot;", '"'), ("&amp;", "&"),
                 ("&lt;", "<"), ("&gt;", ">")):
        x = x.replace(a, b)
    x = re.sub(r"&#\d+;", " ", x)
    x = re.sub(r"\s+", " ", x)
    return _TAIL.sub("", x).strip()


def _throttle(gap: float = MIN_GAP_SEC) -> None:
    """两次请求之间至少隔 gap 秒。超频只会把自己封掉。"""
    dt = time.time() - _LAST_AT[0]
    if dt < gap:
        time.sleep(gap - dt)
    _LAST_AT[0] = time.time()


def _get(url: str, mobile: bool = True, timeout: float = 18.0) -> str:
    ua = UA_MOBILE if mobile else UA_DESKTOP
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as r:
        raw = r.read()
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def score_item(title: str, desc: str) -> int:
    """这条结果有多大可能是在**解释这个词**。

    实测校准（2026-10-28，查「扎啤」）：
        「"扎啤"是什么梗?兄弟,你是扎啤吧~」          → 9   ← 要的就是这条
        「扎啤 - 搜狗百科（经过微孔膜过滤的啤酒）」    → -3  ← 字面义
        「扎啤是精酿吗,扎啤是什么 和啤酒有什么区别」  → -1  ← 讲商品
    """
    t = f"{title} {desc}"
    sc = 0
    if _IS_MEME.search(t):
        sc += 3
    if re.search(r"(是什么梗|什么意思|啥意思|怎么来的|由来|出处)", title):
        sc += 4
    if _NOT_MEME.search(t):
        sc -= 3
    if len(re.findall(r"[“\"「][^”\"」]{2,20}[”\"」]", desc)) >= 2:
        sc += 2
    if 20 <= len(desc) <= 200:
        sc += 1
    return sc


def extract_answer(body: str) -> str:
    """抠搜狗的 AI 摘要（元宝直出），这是最接近「直接回答」的一块。

    结构（wap 版）：
        <div class="answer__answerWrap_xxxx">
          …<div class="markdown__contentBlock_xxxx markdown__finish_xxxx">
            <div>网络热梗“扎啤”并非指啤酒，而是…</div>…
    """
    m = re.search(
        r'class="[^"]*markdown__contentBlock[^"]*"[^>]*>(.*?)</div>\s*</div>',
        body, flags=re.S,
    )
    if not m:
        return ""
    txt = _clean(m.group(1))
    txt = re.sub(r"内容由AI生成.*$", "", txt).strip()
    txt = re.sub(r"你可能还想了解.*$", "", txt).strip()
    # 摘要里常混着上标数字（引用角标），去掉免得出戏
    txt = re.sub(r"(?<=[\u4e00-\u9fff”\"）])\d{1,2}(?=[。，、；！？\s]|$)", "", txt)
    return txt[:MAX_ANSWER_CHARS]


def answer_ok(term: str, answer: str) -> bool:
    """摘要能不能用。两条硬闸：

      ① 够长 —— 「yyds」那次只回「马金鹿」两个字，那是搜狗降级的垃圾
      ② 沾边 —— 要么提到了这个词本身，要么带「梗/骂人/谐音…」这类解释性词

    实测：`扎啤` 的摘要 200+ 字且含「热梗」「谐音」→ 过；
          `yyds` 的「马金鹿」→ 3 个字，不过。
    """
    a = (answer or "").strip()
    if len(a) < MIN_ANSWER_CHARS:
        return False
    key = re.sub(r"\s+", "", term or "")
    if key and key in re.sub(r"\s+", "", a):
        return True
    return bool(_IS_MEME.search(a))


def search_sogou_wap(q: str, top: int = 8, timeout: float = 18.0) -> dict:
    """搜狗 wap 版。返回 {answer, items}，被封时抛异常由上层兜。"""
    _throttle()
    url = "https://wap.sogou.com/web/searchList.jsp?keyword=" + urllib.parse.quote(q)
    body = _get(url, mobile=True, timeout=timeout)
    if "antispider" in body or len(body) < 20000:
        raise RuntimeError(f"blocked_or_short(len={len(body)})")

    items = []
    for m in re.finditer(r'<a[^>]+href="[^"]*"[^>]*>(.{4,120}?)</a>', body, flags=re.S):
        title = _clean(m.group(1))
        if not title or len(title) < 4:
            continue
        if re.search(r"(搜狗|登录|反馈|首页|下一页|相关搜索|广告)", title):
            continue
        items.append({"title": title[:120], "desc": "", "score": score_item(title, "")})
    seen, uniq = set(), []
    for it in items:
        if it["title"] in seen:
            continue
        seen.add(it["title"])
        uniq.append(it)
    uniq.sort(key=lambda x: -x["score"])
    return {"answer": extract_answer(body), "items": uniq[: max(1, top)], "engine": "sogou-wap"}


def search_bing(q: str, top: int = 8, timeout: float = 18.0) -> dict:
    """兜底：bing 中文。对英文缩写（yyds / yyds 意思）能用，对中文新词基本无用。"""
    _throttle(MIN_GAP_SEC / 2)
    url = "https://cn.bing.com/search?q=" + urllib.parse.quote(q)
    body = _get(url, mobile=False, timeout=timeout)
    blocks = re.findall(r'<li class="b_algo".*?</li>', body, flags=re.S)
    items = []
    for b in blocks:
        mt = re.search(r"<h2[^>]*>.*?<a[^>]*>(.*?)</a>", b, flags=re.S)
        md = re.search(r"<p[^>]*>(.*?)</p>", b, flags=re.S)
        title = _clean(mt.group(1) if mt else "")
        desc = _clean(md.group(1) if md else "")
        if not title and not desc:
            continue
        items.append({"title": title[:120], "desc": desc[:240], "score": score_item(title, desc)})
    items.sort(key=lambda x: -x["score"])
    return {"answer": "", "items": items[: max(1, top)], "engine": "bing"}


# ── 缓存 ───────────────────────────────────────────────────────────
def _home() -> str:
    return os.environ.get("DOUYIN_DUTY_HOME") or os.path.join(os.path.expanduser("~"), ".dsh", "douyin-duty")


def _cache_path() -> str:
    return os.path.join(_home(), "cache", "websearch.json")


def _cache_load() -> dict:
    try:
        with open(_cache_path(), "r", encoding="utf-8") as f:
            j = json.load(f)
        return j if isinstance(j, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _cache_get(term: str) -> dict | None:
    db = _cache_load()
    e = db.get(re.sub(r"\s+", "", term or ""))
    if not isinstance(e, dict):
        return None
    if time.time() - float(e.get("at") or 0) > CACHE_TTL:
        return None
    return e.get("res")


def _cache_put(term: str, res: dict) -> None:
    if not res or not res.get("ok"):
        return
    db = _cache_load()
    db[re.sub(r"\s+", "", term or "")] = {"at": time.time(), "res": res}
    if len(db) > CACHE_KEEP:
        for k in sorted(db, key=lambda x: float((db[x] or {}).get("at") or 0))[: len(db) - CACHE_KEEP]:
            db.pop(k, None)
    p = _cache_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(db, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001
        pass


def search(q: str, top: int = 8, no_suffix: bool = False, timeout: float = 18.0,
           use_cache: bool = True) -> dict:
    """查一个词的意思。永不抛异常，失败返回 {ok:false, error}。"""
    term = str(q or "").strip()[:40]
    if not term:
        return {"ok": False, "error": "empty_query", "answer": "", "items": []}

    if use_cache:
        hit = _cache_get(term)
        if hit:
            out = dict(hit)
            out["cached"] = True
            return out

    query = term if no_suffix else term + SUFFIX
    errs = []

    # 1) 搜狗 wap：唯一能吐「梗释义」的源，优先
    try:
        got = search_sogou_wap(query, top=top, timeout=timeout)
        ans = got.get("answer") or ""
        if answer_ok(term, ans):
            res = {"ok": True, "query": query, "engine": got["engine"], "answer": ans,
                   "total": len(got["items"]), "items": got["items"]}
            _cache_put(term, res)
            return res
        if ans and not answer_ok(term, ans):
            errs.append(f"sogou-wap:answer_rejected({ans[:20]!r})")
        else:
            errs.append("sogou-wap:no_answer")
        # 摘要不合格时，如果结果里有很像梗解释的条目，也能用
        good = [it for it in got["items"] if it["score"] >= 7]
        if good:
            res = {"ok": True, "query": query, "engine": got["engine"], "answer": "",
                   "total": len(got["items"]), "items": good[:top]}
            _cache_put(term, res)
            return res
    except Exception as e:  # noqa: BLE001
        errs.append(f"sogou-wap:{type(e).__name__}:{str(e)[:60]}")

    # 2) bing 兜底：只收「很像在解释这个词」的条目，其它一律不要
    try:
        got = search_bing(query, top=top, timeout=timeout)
        good = [it for it in got["items"] if it["score"] >= 7]
        if good:
            res = {"ok": True, "query": query, "engine": got["engine"], "answer": "",
                   "total": len(got["items"]), "items": good[:top]}
            _cache_put(term, res)
            return res
        errs.append(f"bing:all_below_bar({len(got['items'])})")
    except Exception as e:  # noqa: BLE001
        errs.append(f"bing:{type(e).__name__}:{str(e)[:60]}")

    return {"ok": False, "query": query, "answer": "", "items": [],
            "error": " | ".join(errs)[:240]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="通用搜索引擎查词义 / 黑话")
    ap.add_argument("--q", required=True, help="要查的词")
    ap.add_argument("--top", type=int, default=8, help="最多返回几条（默认 8）")
    ap.add_argument("--no-suffix", action="store_true", help="不加「是什么意思」后缀")
    ap.add_argument("--timeout", type=float, default=18.0)
    ap.add_argument("--no-cache", action="store_true", help="不读写缓存")
    a = ap.parse_args(argv)

    t0 = time.time()
    res = search(a.q, top=a.top, no_suffix=a.no_suffix, timeout=a.timeout, use_cache=not a.no_cache)
    res.setdefault("cached", False)
    res["ms"] = int((time.time() - t0) * 1000)
    sys.stdout.write(json.dumps(res, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
