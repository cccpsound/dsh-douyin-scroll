#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/dy-search.py —— 抖音搜索（只读，不签名，不碰写接口）
================================================================================
用途：她不认识的梗 / 名字 / 缩写，去抖音搜一次，把「标题 + 高赞评论」拿回来
     作为证据，再决定怎么接话。

为什么走这个接口：`/aweme/v1/web/general/search/single/` 实测**不需要签名**
（和 `/aweme/v1/web/aweme/detail/` 不同，那个必须页面内 fetch 补 X-Bogus）。
直接 curl_cffi + cookie 就能拿 JSON，一次 1~2 秒。

实测（2026-10-27）：
    「灭建国」    → 9 条，第 2 条标题就是「灭霸的爸爸叫灭建国😂真是让人哭笑不得」
    「yqp 灭霸他爸」→ 10 条，前两条都是同一件事
    「Микоян」    → 9 条，全是俄语歌（说明这个词在本站没有梗义，别硬关联）

用法：
    python tools/dy-search.py --q "灭建国"            # 搜，输出 JSON
    python tools/dy-search.py --q "灭建国" --top 3    # 只要前 3 条
    python tools/dy-search.py --q "灭建国" --comments # 额外拉高赞评论（慢，每条 +0.9s）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from urllib.parse import quote  # noqa: E402

from curl_cffi import requests as creq  # noqa: E402

from _home import node_bin, home_str  # noqa: E402

HOME = home_str()
COOKIE_FILE = os.path.join(HOME, "douyin_cookie.txt")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC&downlink=10&effective_type=4g&round_trip_time=50")


def load_cookie():
    try:
        with open(COOKIE_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def walk_awemes(obj, bag):
    """递归找所有长成 aweme 的 dict（有 aweme_id + desc）。"""
    if isinstance(obj, list):
        for v in obj:
            walk_awemes(v, bag)
    elif isinstance(obj, dict):
        if "aweme_id" in obj and ("desc" in obj or "statistics" in obj):
            bag[obj["aweme_id"]] = obj
        else:
            for v in obj.values():
                walk_awemes(v, bag)


def stat(a, k):
    s = a.get("statistics") or {}
    try:
        return int(s.get(k) or 0)
    except Exception:
        return 0


def author_of(a):
    au = a.get("author") or {}
    return str(au.get("nickname") or "")[:40]


def tags_of(a):
    out = []
    for t in (a.get("text_extra") or []):
        if isinstance(t, dict):
            n = str(t.get("hashtag_name") or "").strip()
            if n:
                out.append(n)
    return out[:6]


def search(q, top=6):
    ck = load_cookie()
    if not ck:
        return {"ok": False, "error": "no_cookie（douyin_cookie.txt 是空的）", "query": q}
    s = creq.Session(impersonate="chrome124")
    s.headers.update({"User-Agent": UA, "Cookie": ck, "Referer": "https://www.douyin.com/"})
    path = ("/aweme/v1/web/general/search/single/?" + COMMON
            + "&keyword=" + quote(q)
            + "&search_channel=aweme_general&count=20&offset=0")
    try:
        r = s.get(BASE + path, timeout=25)
    except Exception as e:
        return {"ok": False, "error": "fetch: %s" % str(e)[:120], "query": q}
    if r.status_code != 200:
        return {"ok": False, "error": "http_%s" % r.status_code, "query": q}
    try:
        j = r.json()
    except Exception:
        return {"ok": False, "error": "bad_json", "query": q}

    bag = {}
    walk_awemes(j, bag)
    rows = []
    for aid, a in bag.items():
        desc = str(a.get("desc") or "").replace("\n", " ").strip()
        if not desc:
            continue
        rows.append({
            "aweme_id": str(aid),
            "desc": desc[:160],
            "author": author_of(a),
            "digg": stat(a, "digg_count"),
            "comment": stat(a, "comment_count"),
            "share": stat(a, "share_count"),
            "tags": tags_of(a),
        })
    # 高赞优先 —— 梗往往是最高赞那条把话说透的
    rows.sort(key=lambda x: -x["digg"])
    return {
        "ok": True,
        "query": q,
        "status_code": j.get("status_code"),
        "total": len(rows),
        "items": rows[:max(1, top)],
    }


def comments(aweme_id, n=8):
    """取高赞评论。直接调同目录的 comment-read-page.mjs（页面内 fetch + 自动签名）。"""
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, "comment-read-page.mjs")
    try:
        p = subprocess.run(
            [node_bin(), script, "--aweme", str(aweme_id), "--count", "20", "--pages", "1"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
        )
    except Exception as e:
        return []
    out = p.stdout or ""
    a, b = out.find("{"), out.rfind("}")
    if a < 0 or b <= a:
        return []
    try:
        j = json.loads(out[a:b + 1])
    except Exception:
        return []
    arr = j.get("comments") or j.get("items") or []
    rows = []
    for c in arr:
        t = str(c.get("text") or "").replace("\n", " ").strip()
        if len(t) < 4 or not any("\u4e00" <= ch <= "\u9fff" for ch in t):
            continue
        rows.append({"text": t[:80], "digg": int(c.get("digg") or c.get("digg_count") or 0)})
    rows.sort(key=lambda x: -x["digg"])
    return rows[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", required=True)
    ap.add_argument("--top", type=int, default=6)
    ap.add_argument("--comments", action="store_true")
    a = ap.parse_args()
    res = search(a.q, a.top)
    if res.get("ok") and a.comments and res["items"]:
        # 只给最高赞那条拉评论（最可能把梗解释清楚的就是它）
        res["items"][0]["top_comments"] = comments(res["items"][0]["aweme_id"], 6)
        res["comments_for"] = res["items"][0]["aweme_id"]
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
