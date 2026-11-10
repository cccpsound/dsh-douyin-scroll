# -*- coding: utf-8 -*-
"""
把 api-comments.py 从「dy-signer 签名 + httpx」换成「页面内 fetch」。

为什么换（2026-10-25）：
  原链路 api-comments.py → sign(rel) → dy-signer.mjs → 自己拼签名 → httpx.get。
  dy-signer.mjs 需要 `$DOUYIN_HOME/signer/sdk/` 下 7 个 js + jsdom，本机一个都没有
  ⇒ 一跑就 KeyError: 'signedUrl'，读评论整个功能是死的。
  而同仓库的 comment-api.mjs 一直是好的 —— 它站在 douyin.com 页面上用页面自己的
  fetch，签名由 webmssdk 自动补齐。读评论走同一条路即可，签名器彻底绕开。

保留 api-comments.py 这个入口和它的输出格式（下游可能有人在用），只是内部换实现。
保留的东西：参数（第一个 argv = aweme id）、逐条打印格式、最后「合计 N 条」。
丢掉的东西：sign()、SIGNER、JWT/cookie 拼 header、httpx（不再需要）。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, node_bin  # noqa: E402

HOME = home_str()
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = node_bin()
READER = os.path.join(PLUGIN, "tools", "comment-read-page.mjs")


def read_page(aweme: str, count: int = 20, pages: int = 4) -> dict:
    """调 comment-read-page.mjs，返回它那一段 JSON。"""
    env = dict(os.environ, DOUYIN_HOME=HOME)
    try:
        p = subprocess.run(
            [NODE, READER, "--aweme", aweme, "--count", str(count), "--pages", str(pages)],
            capture_output=True, cwd=PLUGIN, env=env, timeout=240,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "comment-read-page.mjs 超时（240 秒）"}
    out = p.stdout.decode("utf-8", "replace")
    i = out.find("{")
    if i < 0:
        tail = (out + p.stderr.decode("utf-8", "replace"))[-400:]
        return {"ok": False, "error": "没拿到 JSON: " + tail}
    try:
        return json.loads(out[i:out.rfind("}") + 1])
    except Exception as e:
        return {"ok": False, "error": "解析失败: %s | %s" % (e, out[-200:])}


def main() -> int:
    aweme = sys.argv[1] if len(sys.argv) > 1 else "7698980229549139835"
    # 兼容老调用：第二个参数以前是页码循环数，这里当补翻页数用
    try:
        pages_arg = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    except ValueError:
        pages_arg = 4

    r = read_page(aweme, count=20, pages=max(1, min(20, pages_arg)))
    if not r.get("ok"):
        print(json.dumps({"ok": False, "err": r.get("error")}, ensure_ascii=False))
        return 1

    cs = r.get("comments") or []
    print("status_code=%s  pages=%s  评论=%d  my_uid=%s"
          % (r.get("status_code"), r.get("pages_fetched"), len(cs), r.get("my_uid") or "(未知)"))
    for c in cs:
        txt = (c.get("text") or "").replace("\n", " ")
        print("  cid=%s  %s  [%s]  赞%s  %s" % (
            c.get("cid"), c.get("nick"), txt[:100], c.get("digg"), c.get("create_time")))
        for rr in (c.get("replies") or [])[:6]:
            print("      └ reply cid=%s %s [%s]  %s" % (
                rr.get("cid"), rr.get("nick"),
                (rr.get("text") or "").replace("\n", " ")[:90], rr.get("create_time")))
    print("合计 %d 条" % len(cs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
