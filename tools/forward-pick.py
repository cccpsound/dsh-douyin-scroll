#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/forward-pick.py —— 刷一轮：拉候选 → 打分 → 生成「转发给我」的清单
============================================================================
只读、**不签名**、不碰写接口。判断依据全部来自 JSON 字段：
desc / tags / author / create_time / duration / digg·comment·collect·share / 高赞评论。
不看画面、不做 ASR/OCR、不读视频。

用法:
  python tools/forward-pick.py            # 拉 feed 3 页 + 热榜，出清单
  python tools/forward-pick.py --dump     # 额外打印原始结构，排错用
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402
import time
from datetime import datetime, timezone, timedelta
from urllib.parse import quote  # noqa: E402  图文搜索要拼关键词，中文必须转义

from curl_cffi import requests as creq

# ⚠️ 2026-10-21 实测：Windows 上 stdout 默认 GBK，遇到标题里的 𝓋 / emoji 这类字符
#    直接 UnicodeEncodeError 崩掉（这一轮就是崩在最后打印清单那一步）。
#    插件是 spawnSync 抓管道的，崩了就等于「取候选失败」—— 一律强制 utf-8，编不出的替换掉。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOME = home_str()
COOKIE_FILE = os.path.join(HOME, "douyin_cookie.txt")
OUT_JSON = os.path.join(HOME, "forward-pick.json")
OUT_MD = os.path.join(HOME, "out", "forward-" + datetime.now().strftime("%Y%m%d-%H%M") + ".md")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
BASE = "https://www.douyin.com"
COMMON = ("device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
          "&version_code=190500&version_name=19.5.0&cookie_enabled=true"
          "&screen_width=1920&screen_height=1080&browser_language=zh-CN"
          "&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0"
          "&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10"
          "&platform=PC&downlink=10&effective_type=4g&round_trip_time=50")

CST = timezone(timedelta(hours=8))


def load_cookie():
    with open(COOKIE_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


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


def fmts(n):
    if n >= 100000000:
        return "%.1f亿" % (n / 100000000.0)
    if n >= 10000:
        return "%.1f万" % (n / 10000.0)
    return str(n)


def get(s, path, quiet=True):
    try:
        r = s.get(BASE + path, timeout=25)
        time.sleep(1.2)
        if r.status_code != 200:
            if not quiet:
                print("  ! %s -> HTTP %s" % (path.split("?")[0], r.status_code), file=sys.stderr)
            return None
        return r.json()
    except Exception as e:
        if not quiet:
            print("  ! %s -> %s" % (path.split("?")[0], e), file=sys.stderr)
        return None


def load_collector():
    """
    ⭐ 读设置页那两个旋钮（`collector.json`，由 index.js 的 syncCollectorCfg 写）。
    以前这里完全没读它 ⇒ 设置页「文案太短 / 评论少」两个旋钮是死的（改了不起作用）。
    """
    p = os.path.join(HOME, "collector.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f) or {}
    except Exception:
        j = {}
    return {
        "minDescLen": int(j.get("minDescLen") or 0),
        "minComments": int(j.get("minComments") or 0),
    }


def load_keywords():
    """
    ⭐ 2026-10-27 加：读 `config.json` 里的 `keywords`，给图文搜索源用。

    为什么图文非得靠关键词：推荐流里一条图文都没有（实测 3 页 20 条全是 aweme_type=0），
    图文的唯一入口是搜索。而裸搜「图文」拿到的大半是壁纸号、背景图号 —— 跟使用者的
    兴趣（猫 / 旅行 / 搞笑 / ai）完全无关。拿她自己的关键词去搜，图文才接得上她的偏好。

    读不到就返回空列表，`main()` 里会退化成只搜裸「图文」，不至于整路挂掉。
    """
    p = os.path.join(HOME, "config.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            j = json.load(f) or {}
    except Exception:
        return []
    kws = j.get("keywords")
    if not isinstance(kws, list):
        return []
    return [str(k).strip() for k in kws if str(k or "").strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--limit", type=int, default=10, help="最多取前几条（默认 10）")
    # ⭐ 2026-10-28：给 AstrBot 侧（xj_douyin）用 —— 只吐一行 JSON，方便机器读。
    #    原来只有人看的文本 + 落盘 md，调用方得靠正则抠，脆。
    ap.add_argument("--json", action="store_true", help="只输出一行 JSON（给程序读）")
    args = ap.parse_args()

    limits = load_collector()
    CFG_KEYWORDS = load_keywords()
    # ⭐ 硬筛计数：报告里要能说清"因为什么跳过了几条"，不能只给个最终条数
    dropped = {"no_desc": 0, "too_short_video": 0, "short_and_quiet": 0}

    cookie = load_cookie()
    bag = {}
    meta = []

    with creq.Session(impersonate="chrome") as s:
        s.headers.update({
            "User-Agent": UA, "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": BASE + "/", "Origin": BASE,
        })

        # 1) 推荐流 3 页
        for i in range(1, 4):
            j = get(s, "/aweme/v1/web/tab/feed/?%s&count=20&refresh_index=%d" % (COMMON, i))
            if j:
                before = len(bag)
                walk_awemes(j, bag)
                meta.append({"src": "feed#%d" % i, "new": len(bag) - before, "status": j.get("status_code")})
                if args.dump and i == 1:
                    print("[feed#1 top-level keys] %s" % sorted(j.keys()), file=sys.stderr)

        # 2) 热榜
        j = get(s, "/aweme/v1/web/hot/search/list/?%s&detail_list=1" % COMMON)
        if j:
            before = len(bag)
            walk_awemes(j, bag)
            meta.append({"src": "hot-search", "new": len(bag) - before, "status": j.get("status_code")})

        # 3) ⭐ 图文搜索源（2026-10-27 加）
        #
        # 为什么单开这一路：推荐流 `tab/feed` 三页 20 条全是 (aweme_type=0, media_type=4, images=0)，
        # **一条图文都没有**。实测要拿图文只能走搜索接口 `/general/search/single/`，
        # 关键词「图文」的 19 条结果全掉 aweme_type=68（图片集）。
        #
        # 用 keywords 里每个词都搜一遍「词 + 图文」，再加一路裸「图文」兜底：
        # 无目的地只搜「图文」会拿到一堆壁纸号，配上使用者的关键词才有意义
        # （她要的是「猫的图文」「旅行图文」，不是「随便什么图文」）。
        #
        # 接口形状：data[] 每项有 aweme_info；walk_awemes 因为是递归找
        # (aweme_id + desc) 的 dict，所以直接吐整个 j 就行，不用先拆 data。
        # 图文的 duration 是 None ⇒ 下面 `if dur and dur < 12000` 自然放过，不会被当短视频丢掉。
        img_queries = []
        # 2026-10-27 实测：裸搜「图文」拿到的 18 条里大半是壁纸号 / 背景图号 / 梗图合集
        # （「41张背景图」「VOGUE红毯」这种），跟使用者的兴趣完全无关。
        # 而「猫咪 图文」搜出来的是真实猫图（评论区在认猫、聊猫），质量高得多。
        # 所以优先用关键词，裸「图文」只兜底一次。
        for kw in (CFG_KEYWORDS or []):
            kw = str(kw or "").strip()
            if kw:
                img_queries.append(kw + " 图文")
        img_queries.append("图文")          # 兜底，保证这一路永远有东西可拿
        img_queries = img_queries[:5]       # 最多 5 次请求，别把这一路搞得比推荐流还重

        img_new = 0
        for q in img_queries:
            j = get(s, "/aweme/v1/web/general/search/single/?%s&keyword=%s"
                       "&search_channel=aweme_general&count=20&offset=0"
                    % (COMMON, quote(q)))
            if not j:
                continue
            before = len(bag)
            walk_awemes(j, bag)
            img_new += len(bag) - before
            meta.append({"src": "img-search:%s" % q, "new": len(bag) - before, "status": j.get("status_code")})
        meta.append({"src": "img-search-total", "new": img_new, "queries": len(img_queries)})

    now = time.time()
    rows = []
    for aid, a in bag.items():
        desc = (a.get("desc") or "").strip()
        if not desc:
            dropped["no_desc"] += 1
            continue
        dur = a.get("duration") or (a.get("video") or {}).get("duration") or 0
        if dur and dur < 12000:          # <12s 多数是模板/广告
            dropped["too_short_video"] += 1
            continue
        d, c, col, sh = stat(a, "digg_count"), stat(a, "comment_count"), stat(a, "collect_count"), stat(a, "share_count")
        # ⭐ 设置页那两个旋钮：文案太短**且**评论少 ⇒ 丢（单条不满足只降权不丢）
        if limits["minDescLen"] and len(desc) < limits["minDescLen"] and c < limits["minComments"]:
            dropped["short_and_quiet"] += 1
            continue
        ct = a.get("create_time") or 0
        age_h = (now - ct) / 3600.0 if ct else 999
        inter = d + c * 2 + col * 3 + sh * 2
        # 评论/点赞比：越高越"有话说"；太高的往往是争议/标题党
        ratio = (c / d) if d else 0
        score = inter
        if 0.02 <= ratio <= 0.25:
            score *= 1.25
        if age_h <= 72:
            score *= 1.15
        si = a.get("share_info") or {}
        official = si.get("share_url") or a.get("share_url") or ""
        # ⭐ 图文标记：aweme_type=68 / media_type=2 / images[] 非空
        #    2026-10-27 实测这三条同时成立；用 images 长度最稳（搜索接口里 aweme_type 偶尔缺）
        imgs = a.get("images") or []
        is_img = bool(imgs) or a.get("aweme_type") == 68 or a.get("media_type") == 2
        rows.append({
            "aweme_id": aid,
            "desc": desc,
            "author": (a.get("author") or {}).get("nickname") or "",
            "sec_uid": (a.get("author") or {}).get("sec_uid") or "",
            "duration_s": round(dur / 1000.0, 1) if dur else None,
            "digg": d, "comment": c, "collect": col, "share": sh,
            "comment_ratio": round(ratio, 4),
            "age_h": round(age_h, 1),
            "score": int(score),
            # ⭐ 图文相关（给下游 understandVideoCard 判断走 images 分支用）
            "is_image": is_img,
            "images_n": len(imgs),
            # ⭐ 官方分享链接（接口直接给的，带 share_sign）——不要自己拼 aweme_id
            "share_url": official or ("https://www.iesdouyin.com/share/video/%s/" % aid),
            # 抖音口令（"复制此链接，打开Dou音搜索"那串）
            "share_desc": (si.get("share_link_desc") or "").replace("%s", official).strip(),
            # 网页地址（能在浏览器打开，但不是分享链接）
            "web_url": "%s/video/%s" % (BASE, aid),
        })

    rows.sort(key=lambda r: -r["score"])
    """
    ⭐ 2026-10-27 加：**给图文留固定名额**。

    实测原因：纯按 score（互动加权）排序，图文永远排不上来。
    这批候选里视频前 10 名最低 159 万互动，而图文里赞过百万的都少见 ——
    图文的赞/藏/转天然比不过爆款视频，一起排就是全被挤掉，
    那「加一路图文源」等于白加（采集到了 71 条，一条都进不了清单）。

    做法（**槽位构造法**，不是排序、也不是替换）：
      1. 留几个固定槽位给图文，槽位定在**中段**（第 2、第 6 名），不放开头；
      2. 其余名额按 score 从高到低用视频填；
      3. 图文也从高到低填进槽位。

    为什么不放开头：一晚上最多挑 3 条，前 3 名全是图集就全发图了，比例失真。
    为什么不用"插进去再重排"：重排会把图文又压回底部（第一版就栽在这）。
    为什么不用"替换最末位"：替换后整条列表前移，图文会漂到不知道哪去（第二版栽在这）。
    """
    limit_n = max(1, args.limit)
    img_pool = [r for r in rows if r.get("is_image")]      # 已按 score 降序
    vid_pool = [r for r in rows if not r.get("is_image")]
    # 图文明细：10 条留 2 条，更短的清单只留 1 条
    want_img = min(2, len(img_pool), max(1, limit_n // 4))
    if want_img <= 0:
        top = rows[:limit_n]
    else:
        # 槽位：第 2、第 6（0-based 1 和 5），超出清单长度的丢掉
        slots = [s for s in (1, 5) if s < limit_n][:want_img]
        top = [None] * limit_n
        for s, r in zip(slots, img_pool[:len(slots)]):
            top[s] = r
        vi = 0
        placed_ids = {r["aweme_id"] for r in top if r is not None}
        for i in range(limit_n):
            if top[i] is not None:
                continue
            while vi < len(vid_pool) and vid_pool[vi]["aweme_id"] in placed_ids:
                vi += 1
            if vi < len(vid_pool):
                top[i] = vid_pool[vi]
                placed_ids.add(vid_pool[vi]["aweme_id"])
                vi += 1
        top = [r for r in top if r is not None]
    n_img = sum(1 for r in top if r.get("is_image"))

    if args.json:
        print(json.dumps({
            "ok": True,
            "meta": meta,
            "dropped": dropped,
            "thresholds": limits,
            "rows": top,
        }, ensure_ascii=False))
        os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
        with open(OUT_JSON, "w", encoding="utf-8") as f:
            json.dump({"meta": meta, "rows": top, "dropped": dropped, "thresholds": limits},
                      f, ensure_ascii=False, indent=1)
        return

    print("采集：%s" % json.dumps(meta, ensure_ascii=False))
    print("硬筛跳过：%s（阈值 文案≥%d 字 / 评论≥%d）" % (
        json.dumps(dropped, ensure_ascii=False), limits["minDescLen"], limits["minComments"]))
    print("去重后候选 %d 条（其中图文 %d 条），取前 %d（含图文 %d）" % (
        len(rows), len(img_pool), len(top), n_img))
    for i, r in enumerate(top, 1):
        tag = " [图文%d图]" % r["images_n"] if r.get("is_image") else ""
        print("%2d. [%s]%s %s" % (i, fmts(r["digg"]), tag, r["desc"][:46]))
        print("    %s · %s · 赞%s 评%s 藏%s 转%s · %s" % (
            r["author"],
            ("%ss" % r["duration_s"]) if r["duration_s"] else "时长未知",
            fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"]), fmts(r["share"]),
            ("%.0f小时前" % r["age_h"]) if r["age_h"] < 900 else "时间未知"))
        print("    %s" % r["share_url"])

    os.makedirs(os.path.dirname(OUT_MD), exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "rows": top, "dropped": dropped, "thresholds": limits}, f, ensure_ascii=False, indent=1)
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("# 转发清单 %s\n\n" % datetime.now(CST).strftime("%Y-%m-%d %H:%M"))
        for i, r in enumerate(top, 1):
            f.write("### %s\n" % r["aweme_id"])
            f.write("- %s\n" % r["desc"])
            f.write("- %s · %ss · 赞%s 评%s 藏%s\n" % (r["author"], r["duration_s"], fmts(r["digg"]), fmts(r["comment"]), fmts(r["collect"])))
            f.write("- %s\n\n" % r["share_url"])
    print("\n清单 -> %s" % OUT_MD)


if __name__ == "__main__":
    main()
