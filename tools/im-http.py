#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/im-http.py —— 纯 HTTP 读私信（不碰浏览器，只读）
============================================================================
为什么要有它：
  浏览器路径（im-send.mjs --read）冷启动 ~10 秒、切会话 ~1.4 秒，
  而且"谁发的"要靠头像落点左右半边猜、时间戳恒为 0。
  抖音网页版自己的 IM 走 imapi.douyin.com 的 protobuf 接口，
  只认 Cookie（不需要 a_bogus、不需要起 Chrome）。
  实测一次请求拿到全部已建立会话 + 每会话最近 20 条消息，
  且每条带真实毫秒时间戳和发送者 uid。

🔴 只读红线：这个脚本没有任何发送代码。发私信只走 im-send.mjs（无头 Chrome）。
   selfcheck 4b-3 有断言盯着：这里出现发送调用就报红。

🔴 身份铁闸（2026-10-24 二版的核心原则：验不明就退出，绝不猜）：
   调用方给 --peer-sec-uid（sec_uid），本脚本**当场**用
   /aweme/v1/web/user/profile/other/?sec_user_id=… 把这个人反查成数字 uid，
   再和会话里的 peer_uid **严格相等**才算 matched（只认私聊 type=1）。
   反查失败 / 不相等 / 没提供 sec_uid ⇒ matched=null，调用方退回浏览器路径。
   ⚠️ 没有任何「只有一个会话就拿来用」之类的捷径 —— 一版在这里栽过
      「认错人」（peer_uid 是数字、toId 是 sec_uid 永远比不中，实际全靠
      单会话捷径在撑），那是 0.3.1 事故的同款根因，不再犯。

通道伪装：curl_cffi impersonate="chrome"（与 notice-read.py 同一套路），
   TLS/HTTP2 指纹对齐真实浏览器 —— 不拿裸脚本的指纹去戳 IM 接口
   （这个接口在看请求模式，密集探测会回 "too many requests"）。

用法:
  python tools/im-http.py --read --peer-sec-uid <sec_uid> [--limit 30]

输出：一行 JSON
  { ok, via:'http', ms, my_uid, conversation_count, conversations:[...],
    matched: { sec_uid, uid, nickname, conv_id, messages } | null,
    match_note: "没 matched 时的原因" }

已知边界（如实写，别装全）：
  · 只拿得到「已建立会话」（好友/聊过的）。陌生人消息在另一个接口
    （/v1/stranger/…，分页没破出来）—— 没做，别当它存在。
  · 拿不到时返回 ok:false 或 matched:null，调用方（index.js）退回浏览器路径。
  · 协议信封是对照抖音页面真实请求从零构造的，没有复制任何第三方常量
    （公开逆向项目信封里嵌着他们自己的会话 ID，抄进来是脏东西）。
"""
import json
import os
import sys
import subprocess
import time
from datetime import datetime, timezone

# Windows 控制台默认 GBK：消息文本里有 emoji（🍜 等）会 UnicodeEncodeError。
# 宿主跑会设 PYTHONUTF8=1，这里再把 stdout 兜一道，命令行直跑也不炸。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str, node_bin  # noqa: E402

# 文案收长和 JS 侧 `lib/desc.mjs`、Python 侧 `xj_douyin/desc_text.py` 同一套规则。
# 🔴 为什么最上游也要用它（2026-11-08）：2026-11-05 那次把四道截断统一到 2000，
#   但只改了 `lib/` 和 `xj_douyin/main.py`，漏了这里 —— 而这里才是链路起点：
#   卡片文案（text / content_title / comment）在这一步就被切 200~300，下游无
#   论放宽到多少都补不回来。使用者报「文案正文还是没看全」，根因就在这几处硬切。
#
# ⚠️ 兜底不能省：这个脚本是私信读取的唯一入口，缺了 desc_text.py（单独拷走、
#   打包漏装）不能让整条读链路崩掉 —— 退化成「按 2000 字硬切」，只丢断点美化，
#   不丢内容。所以 import 失败时自己定义一个等价实现，而不是抛 ImportError。
try:
    from desc_text import fit_desc  # noqa: E402
except ImportError:  # pragma: no cover - 只在文件缺失时走到
    _BREAKS = ("。", "！", "？", "；", "…", "\n", ".", "!", "?", ";", "，", ",")

    def fit_desc(text, cap: int = 2000, mark: bool = True) -> str:  # type: ignore[misc]
        """`desc_text.fit_desc` 的兜底版：同样上限、同样断点规则。"""
        s = "" if text is None else str(text)
        limit = max(20, int(cap or 2000))
        if len(s) <= limit:
            return s
        floor = int(limit * 0.7)
        cut = -1
        for br in _BREAKS:
            i = s.rfind(br, 0, limit)
            if i >= floor and i > cut:
                cut = i
        head = s[: cut + 1] if cut > 0 else s[:limit]
        if not mark:
            return head.strip()
        rest = len(s) - len(head)
        if rest <= 0:
            return head.strip()
        return f"{head.strip()}（后面还有 {rest} 字，这条没读完）"

try:
    from curl_cffi import requests as creq
except ImportError:
    print(json.dumps({"ok": False, "error": "缺 curl_cffi —— 设置页点「装主依赖」装一下"},
                     ensure_ascii=False, indent=1))
    sys.exit(1)

HOME = home_str()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
IM_HOST = "https://imapi.douyin.com"
WWW = "https://www.douyin.com"
COMMON = "device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"

argv = sys.argv[1:]


def arg_of(k, d=""):
    i = argv.index(k) if k in argv else -1
    return argv[i + 1] if i >= 0 and i + 1 < len(argv) else d


READ = "--read" in argv
PEER_SEC = arg_of("--peer-sec-uid", "")
# ⭐ 2026-10-27 群聊支持（只读）：
#    --list-groups        列出已建立会话里的**群聊**（type=2），给出群名和 conv_id
#    --conv-id <id>       按 conv_id 直读指定会话（群或私聊都行），**跳过人身份铁闸**
#
#    🔴 为什么必须单开一个入口、而不是放宽 --peer-sec-uid 的匹配：
#       群聊的 peer_uid 是**群 id**，不在人的 sec_uid / uid 体系里。
#       把群塞进「按人反查 → uid 严格相等」那条链，等于放弃身份核验
#       （0.3.1 认错人事故的同款根因）。
#       所以这里**不做任何身份推断**：调用方必须自己给出 conv_id，
#       工具只负责「把那个会话原样读出来」，绝不按昵称/序号猜。
LIST_GROUPS = "--list-groups" in argv
CONV_ID_ARG = arg_of("--conv-id", "").strip()
try:
    LIMIT = max(1, min(int(arg_of("--limit", "30") or 30), 60))
except ValueError:
    LIMIT = 30


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))
    sys.exit(0 if obj.get("ok") else 1)


if not (READ or LIST_GROUPS or CONV_ID_ARG):
    out({"ok": False,
         "error": "这是个只读工具：需要 --read / --list-groups / --conv-id <id> 之一"})

# ───────────────────────── protobuf 编解码（最小实现，够用就好） ─────────────────────────
# ⭐ Python int 天然任意精度：19 位的 short_id / 毫秒时间戳都不会被截断
#    （Node 版在这上面栽过 32 位移位的坑，Python 没这个问题）。


def ev(n):
    o = bytearray()
    v = int(n)
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            o.append(b | 0x80)
        else:
            o.append(b)
            return bytes(o)


def enc_v(fn, n):
    return ev((fn << 3) | 0) + ev(n)


def enc_ld(fn, d):
    b = d if isinstance(d, bytes) else str(d).encode("utf-8")
    return ev((fn << 3) | 2) + ev(len(b)) + b


def enc_empty(fn):
    return ev((fn << 3) | 2) + ev(0)


def rv(b, i):
    shift = 0
    result = 0
    while True:
        x = b[i]  # 越界 = 坏字节，调用处兜住
        i += 1
        result |= (x & 0x7F) << shift
        if not (x & 0x80):
            return result, i
        shift += 7


def parse(b):
    """宽容解析：坏字节直接停，不抛（响应里允许有我们不认识的字段）。"""
    m = {}
    i = 0
    n = len(b)
    while i < n:
        try:
            tag, i = rv(b, i)
        except IndexError:
            break
        fn = tag >> 3
        wt = tag & 7
        if not fn:
            break
        try:
            if wt == 0:
                val, i = rv(b, i)
            elif wt == 1:
                val = b[i:i + 8]
                i += 8
            elif wt == 5:
                val = b[i:i + 4]
                i += 4
            elif wt == 2:
                ln, i = rv(b, i)
                val = b[i:i + ln]
                i += ln
            else:
                break
        except IndexError:
            break
        m.setdefault(fn, []).append(val)
    return m


def g1(m, k, d=None):
    v = m.get(k)
    return v[0] if v else d


def as_str(v):
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return "" if v is None else str(v)


# ───────────────────────── 请求信封（从零构造） ─────────────────────────
# 结构是对照抖音页面真实请求逐字节比出来的；字段含义见内联注释。
# ⚠️ 不复制任何第三方 base64 常量（别人的信封里嵌着他们自己的会话 ID）。
_SEQ = [10000 + int(time.time() * 1000) % 89]


def build_envelope(cmd, body):
    _SEQ[0] += 1

    def kv(k, v):
        return enc_ld(15, enc_ld(1, k) + enc_ld(2, v))

    return b"".join([
        enc_v(1, cmd),                 # 命令号
        enc_v(2, _SEQ[0]),             # 序列号
        enc_ld(3, "0.1.8"),            # 协议版本（页面同款）
        enc_empty(4),
        enc_v(5, 3),
        enc_v(6, 1),
        enc_ld(7, "0d50935:feat/pc-im-group"),  # 前端构建标识（页面同款）
        enc_ld(8, body),               # 内层请求体（裸 protobuf）
        enc_ld(9, "0"),
        enc_ld(11, "douyin_pc"),
        enc_ld(14, "360000"),
        kv("session_aid", "6383"),
        kv("session_did", "0"),
        kv("app_name", "douyin_pc"),
        kv("priority_region", "cn"),
        kv("user_agent", UA),
        kv("cookie_enabled", "true"),
        kv("browser_language", "zh-CN"),
        kv("browser_platform", "Win32"),
        kv("browser_name", "Mozilla"),
        kv("browser_version", "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
        kv("browser_online", "true"),
        kv("screen_width", "800"),
        kv("screen_height", "600"),
        kv("timezone_name", "Asia/Shanghai"),
        kv("deviceId", "0"),
        kv("is-retry", "0"),
        enc_v(18, 1),
        enc_ld(21, "douyin_web"),
        enc_ld(22, "web_sdk"),
    ])


def iso(ms):
    """毫秒 → ISO（UTC）。时间戳是这条路相对浏览器路径的核心优势，不许丢。"""
    if not ms or ms <= 0:
        return ""
    dt = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % (ms % 1000)



def fill_sec_uids(s, convs, my_uid):
    """
    给每个私聊会话补上对方的 sec_uid。

    为什么必须补：`im-send.mjs` 判断「点开的会话是不是要发的那个人」只认
    `toParticipantSecUserId`（`MS4wLjABAAAA…` 那串），传数字 uid 进去它会报
    「点开的会话对端不是要发的那个人，已中止」—— 私聊就永远发不出去。
    真实现场 2026-10-28 22:16/22:19，两条私聊全卡在这里。

    ⭐ 数据从哪来：protobuf 里的私聊会话**只有 peer_uid，没有 sec_uid**；
    `im/user/info?uid=` 这类接口返回 `{}`（实测），`profile/other` 只吃 sec_uid。
    唯一现成的对照表是 `im-send.mjs --list` —— 它从 DOM 的 React fiber 里读
    `toParticipantSecUserId`，同时给 `uid` 和 `sec_uid`。实测输出：
        {"ok":true,"count":5,"people":[{"uid":"3787172659337272",
          "sec_uid":"MS4wLjABAAAA…","nick":"CCCPsound","kind":"person",...}]}
    群里那几条 `uid` 是空串，正好天然跳过。

    刻意**不做**旧 dm-auto-reply 那套「用消息预览文本对齐」—— 那是在没有 uid
    可用时的兜底，容易串位；这里 uid 直接可比，严格相等才认，比不出来就留空。
    代价是每次 read 多一次 `--list`（约 2~4 秒，要开浏览器）。所以：
      · 只在**确实有私聊会话缺 sec_uid** 时才跑；
      · 结果落盘缓存到 HOME/secuid-map.json，下次直接读，失败才重跑。
    """
    need = [c for c in convs
            if c.get("type") == 1 and c.get("peer_uid") and not c.get("sec_uid")]
    if not need:
        return

    cache_path = os.path.join(HOME, "secuid-map.json")
    mapping = {}
    try:
        with open(cache_path, encoding="utf-8") as f:
            mapping = {str(k): str(v) for k, v in (json.load(f) or {}).items()}
    except Exception:
        mapping = {}

    # 缓存里缺人就去问 im-send --list
    if any(str(c["peer_uid"]) not in mapping for c in need):
        try:
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            env = dict(os.environ)
            env["DOUYIN_DUTY_HOME"] = HOME
            pr = subprocess.run(
                [node_bin(), os.path.join(root, "tools", "im-send.mjs"), "--list"],
                capture_output=True, timeout=150, env=env, cwd=HOME,
            )
            txt = pr.stdout.decode("utf-8", "replace")
            lo, hi = txt.find("{"), txt.rfind("}")
            if lo >= 0 and hi > lo:
                lj = json.loads(txt[lo:hi + 1])
                for p in lj.get("people") or []:
                    u, sec = str(p.get("uid") or ""), str(p.get("sec_uid") or "")
                    if u and sec:
                        mapping[u] = sec
                try:
                    tmp = cache_path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(mapping, f, ensure_ascii=False)
                    os.replace(tmp, cache_path)
                except Exception:
                    pass
        except Exception:
            pass

    for c in need:
        sec = mapping.get(str(c["peer_uid"]))
        if sec:
            c["sec_uid"] = sec


def peer_uid_of(conv_id, my_uid):
    """从会话 id（"0:<type>:<uidA>:<uidB>"）里解出对端数字 uid（去掉自己那个）。"""
    parts = str(conv_id or "").split(":")
    uids = [p for p in parts if p.isdigit() and len(p) >= 8]
    other = next((u for u in uids if u != my_uid), None)
    return other or (uids[-1] if uids else "")


def read_cookie():
    try:
        raw = open(os.path.join(HOME, "douyin_cookie.txt"), encoding="utf-8").read().strip()
    except OSError:
        return ""
    if raw.startswith("{"):
        try:
            return "; ".join("%s=%s" % (c["name"], c["value"])
                             for c in json.loads(raw).get("cookies", []))
        except Exception:
            return ""
    return " ".join(raw.split())


def main():
    t0 = time.time()

    cookie = read_cookie()
    if "sessionid=" not in cookie:
        out({"ok": False, "error": "Cookie 里没有 sessionid（还没登录）",
             "hint": "先在设置页扫码登录或粘贴 Cookie"})

    with creq.Session(impersonate="chrome") as s:
        s.headers.update({
            "User-Agent": UA, "Cookie": cookie,
            "Referer": WWW + "/", "Origin": WWW,
        })

        # ① 我是谁（数字 uid）——判「谁发的」要用；顺带验 Cookie 活没活
        try:
            me = s.get(WWW + "/aweme/v1/web/user/profile/self/?" + COMMON, timeout=12).json()
        except Exception as e:
            out({"ok": False, "error": "查登录态失败: " + str(e)[:120]})
        my_uid = str((me.get("user") or {}).get("uid") or "")
        if not my_uid or me.get("status_code") not in (0, None):
            out({"ok": False, "error": "Cookie 失效或登录态异常",
                 "status_code": me.get("status_code")})

        # ② 拉全部已建立会话（cmd 2043）
        try:
            resp = s.post(IM_HOST + "/v1/message/get_message_by_init",
                          data=build_envelope(2043, enc_ld(2043, b"")),
                          headers={"Content-Type": "application/x-protobuf",
                                   "Accept": "application/x-protobuf"},
                          timeout=12)
        except Exception as e:
            out({"ok": False, "error": "IM 请求失败: " + str(e)[:120], "my_uid": my_uid})
        if resp.status_code != 200:
            out({"ok": False, "error": "IM 接口 HTTP %s" % resp.status_code, "my_uid": my_uid})

        ms = int((time.time() - t0) * 1000)
        env = parse(resp.content)
        status = as_str(g1(env, 4))
        if status != "OK":
            # 例如 "too many requests" —— 如实报，让调用方退回浏览器路径
            out({"ok": False, "error": "IM 接口返回: " + (status or "(空)"),
                 "status": status, "my_uid": my_uid, "ms": ms})

        wrap = parse(g1(env, 6) or b"")
        sub = parse(g1(wrap, 2043) or b"")
        convs = []
        for blob in sub.get(1) or []:
            if not isinstance(blob, bytes):
                continue
            conv = parse(blob)
            core = parse(g1(conv, 1) or b"")
            conv_id = as_str(g1(core, 1))
            messages = []
            for m in conv.get(2) or []:
                if not isinstance(m, bytes):
                    continue
                f = parse(m)
                sender = as_str(g1(f, 7))            # field7 = 发送者 uid
                content_raw = as_str(g1(f, 8))       # field8 = 正文 JSON
                at_ms = int(g1(f, 10) or 0)          # field10 = 毫秒时间戳
                # ⭐ 2026-11-03：field9 是 key-value 属性块，以前完全没读。
                #    实测 84 条消息里 f9 出现 84 次、每次十几到二十几个键，
                #    里面有 `s:mentioned_users`（群里 @ 了谁）、
                #    `s:visible`、`a:last_msg_id`（会话里最后一条的 id）、
                #    `s:refer`（**不是引用**，恒为 3，是同步协议标记）。
                #    现在只挑「对判断对话结构有用」的少数几个带出去，
                #    不整包塞 —— 那会把每条消息撑到 3KB。
                _kv9 = {}
                for _item in (f.get(9) or []):
                    if not isinstance(_item, bytes):
                        continue
                    try:
                        _d = parse(_item)
                        _k = as_str(g1(_d, 1))
                        _v = as_str(g1(_d, 2))
                        if _k:
                            _kv9[_k] = _v
                    except Exception:
                        continue
                text, kind = "", "text"
                card = None
                # ⭐ 2026-10-25 晚：以前只在 aweType==800 时才解析 card，而且
                #    `if not text and not card: continue` 会把「没有 text 的其它类型消息」
                #    整条静默丢掉 —— 实测 52 条私信里就有 2 条 aweType=0 的富卡片
                #    （带 awemeType/content_name/content_thumb，text 为空）被吞。
                #    表情包、引用回复也走这个分支，所以必须「认不出类型也要留下证据」。
                #    ⇒ 现在：能拿到 text 就填；拿不到就按已知形态给个可读占位，
                #      并把原始 JSON 塞进 raw 供上层判断（不再静默丢弃）。
                # 🔴 2026-11-08：原来这里是 `raw_keep = content_raw[:1500]` —— 那是
                #   第七处硬切，而且最阴的一处：**它切的是 JSON 字符串本身**，
                #   于是 raw 变成残缺 JSON，下游 `json.loads(raw)` 直接抛异常。
                #   实测一条 623 字文案的真实 raw 有 1491+ 字符，正好卡在 1500 边界，
                #   报 `Unterminated string starting at char 1490`。
                #   后果不是「文案短了一点」而是「整条 raw 解析失败」：
                #   `xj_douyin/logic.parse_mentions()` 的 `except: return []`
                #   会让这条长文案里的 @ 全部丢失（`"infoType":1` 在 1500 之后）。
                #   ⇒ 不切 JSON：原文多长就存多长。这条只在调试/解析时用，
                #     不是每条消息都会塞进提示词，多占的那点内存换「解析不坏」划算。
                raw_keep = content_raw
                try:
                    j = json.loads(content_raw)
                    # aweType 实测语义（2026-10-25，52 条私信）：
                    #   700 = 普通文本（带 richTextInfos）
                    #   703 = 普通文本（带 instruction_type/item_type_local/is_card/msgHint，
                    #         看起来是客户端发的老版本格式，内容仍走 text）
                    #   501 = 表情包（emoji_type=favorite_emoji 或 stickers[]）
                    #   800 = 视频卡片（itemId/cover_url/cover_width）
                    #     0 = 杂项：{tips:...} 系统提示 / awemeType 富卡片 / 带 mention_users 的普通文本
                    _aw = int(j.get("aweType") or 0)
                    text = str(j.get("text") or j.get("content_title") or "").strip()
                    kind = "card" if _aw == 800 else "text"
                    if kind == "card":
                        _cover = (j.get("cover_url") or {}).get("url_list") or []
                        card = {
                            "item_id": str(j.get("itemId") or ""),
                            # 🔴 2026-11-03 改：200 → 300。
                            #   这是链路最上游：卡片文案在这里就定死了，
                            #   下游 `describeVideo`（280）/ `persona-llm`（200）
                            #   无论放宽到多少都拿不到这 200 字以后的内容。
                            # 🔴 2026-11-08：text[:300] → fit_desc(text)。
                            #   这是链路最上游：卡片文案在这里就定死了，
                            #   下游 `describeVideo` / `persona-llm` 无论放宽到多少
                            #   都拿不到这 300 字以后的内容。2026-11-05 统一四道
                            #   截断时漏了这一处（只改了 lib/ 和 xj_douyin/）。
                            "title": fit_desc(text),
                            "author_uid": str(j.get("uid") or ""),
                            "cover": _cover[0] if _cover else "",
                            "w": int(j.get("cover_width") or 0),
                            "h": int(j.get("cover_height") or 0),
                        }
                    # 🔴 2026-10-30 修的真 bug（用户报「还是看不到视频」的根因）：
                    #   私聊/群里转发的视频，**aweType 不是 800，是 0**，靠 `awemeType`
                    #   区分。实测那条（「瑞幸你是会玩梗的！…」）：
                    #     aweType=0  awemeType=68  itemId=7690562279117638565
                    #     content_title=文案  cover_url/cover_width/cover_height 都在
                    #   原来的分支只在 `_aw == 800` 时建 card，于是这种消息：
                    #     · kind 落到 "text"（因为 aweType=0 不走 card 分支）
                    #     · card 保持 None
                    #     · 正文只有 content_title 那句文案
                    #   ⇒ `_card_aweme()` 拿不到 itemId ⇒ `look-video.mjs` 从来没被调过。
                    #   她的回答一直是「看不了视频哦，只能看到封面和文案」—— 不是模型
                    #   不肯看，是**这条消息里根本没有把 id 交出去**。
                    #
                    #   判据：有 itemId 且是纯数字（作品 id 都是 19 位数字），
                    #   并且 awemeType 存在（图集/视频/长视频都带它）⇒ 就是卡片。
                    #   不按 aweType 判：实测转发视频 aweType 恒 0，不能依赖它。
                    if not card:
                        _iid = str(j.get("itemId") or "").strip()
                        _atype = j.get("awemeType")
                        if _iid.isdigit() and len(_iid) >= 15 and _atype is not None:
                            _cover = (j.get("cover_url") or {}).get("url_list") or []
                            kind = "card"
                            card = {
                                "item_id": _iid,
                                # 🔴 2026-11-08：text[:300] → fit_desc(text)。
                                #   与上面 `aweType==800` 分支同一处毛病 ——
                                #   转发视频（aweType=0 / awemeType=68 这种）走这条，
                                #   文案同样在这里被砍，下游补不回来。
                                "title": fit_desc(text),
                                "author_uid": str(j.get("uid") or ""),
                                "cover": _cover[0] if _cover else "",
                                "w": int(j.get("cover_width") or 0),
                                "h": int(j.get("cover_height") or 0),
                                "aweme_type": int(_atype),
                                "sec_uid": str(j.get("secUID") or "")[:200],
                            }
                    # —— 以下都是「非纯文本」形态的兜底识别 ——
                    # ⭐ 表情包（2026-10-25 实测两种真实形态）：
                    #   ① aweType=501 + emoji_type="favorite_emoji" + url.url_list[]
                    #      （收藏表情，带 display_name / hint_content，可能还有 stickers[]）
                    #   ② {"stickers":[{"id":...,"static_url":{"url_list":[...]},"animate_url":...}]}
                    #   以前这两种都没 text ⇒ 被整条吞掉，她根本"看"不到你发表情包。
                    if not text and (int(j.get("aweType") or 0) == 501 or j.get("stickers")):
                        kind = "emoji"
                        _u = ""
                        _nm = str(j.get("display_name") or j.get("hint_content") or "").strip()
                        _urls = ((j.get("url") or {}).get("url_list") or [])
                        if _urls:
                            _u = str(_urls[0])
                        _st = j.get("stickers") or []
                        if not _u and _st:
                            _s0 = _st[0] if isinstance(_st[0], dict) else {}
                            _u = str(((_s0.get("static_url") or {}).get("url_list") or [""])[0])
                            if not _nm:
                                _nm = str(_s0.get("display_name") or "").strip()
                        text = "[表情]" + ((" " + _nm) if _nm else "")
                        card = {"kind": "emoji", "url": _u[:500], "name": _nm[:40],
                                "w": int(j.get("width") or 0), "h": int(j.get("height") or 0),
                                "from": str(j.get("emoji_from") or "")[:20]}
                        if _st:
                            card["sticker_id"] = str((_st[0] or {}).get("id") or "")[:24]
                    # ⭐ 2026-10-28：普通图片（aweType=2702）。
                    #    实测发图后读回来是 {"aweType":2702,"md5":"...","from_gallery":1,
                    #    "cover_width":2364,"cover_height":1773,
                    #    "resource_url":{"large_url_list":[...],"medium_url_list":[...],
                    #                    "origin_url_list":[...],"thumb_url_list":[...],
                    #                    "data_size":78680,"md5":"..."}}
                    #    以前没有分支认它 ⇒ text 为空 ⇒ kind 落到 unknown、正文变「[未知消息]」，
                    #    于是她根本"看"不到图，记忆里也全是 [未知消息]。
                    #    ⭐ 2026-10-31 补：GIF 动图进来是 aweType=2703（字段结构与 2702 相同，
                    #    只是 url 列表换成 still_url_list + origin_url_list），以前落到 unknown。
                    if not text and int(j.get("aweType") or 0) in (2702, 2703):
                        _at2703 = int(j.get("aweType") or 0) == 2703
                        kind = "gif" if _at2703 else "image"
                        _ru = j.get("resource_url") or {}
                        _u = ""
                        # GIF(2703) 没有 large/thumb 列表，只有 still_url_list + origin_url_list
                        # 🔴 2026-11-10 修正：非 GIF 改成 **origin 优先**。
                        #    原来首选 large_url_list，实测长边只有 388px（原图 1052x1324 的
                        #    缩略版），图里的正文/小字全糊。origin_url_list 才是原图。
                        _keys = ("still_url_list", "origin_url_list", "large_url_list",
                                 "medium_url_list", "thumb_url_list") if _at2703 else \
                                ("origin_url_list", "large_url_list", "medium_url_list", "thumb_url_list")
                        for _kk in _keys:
                            _lst = _ru.get(_kk) or []
                            if _lst:
                                _u = str(_lst[0])
                                break
                        text = "[动图]" if _at2703 else "[图片]"
                        # 🔴 2026-11-10：抖音私信图床给的是**加密流**。
                        #    直接 GET 拿到的不是 JPEG/PNG，是密文（文件头 f2ec6d2a… 这种）。
                        #    格式是 AES-256-GCM：`nonce(12) || ciphertext || tag(16)`，
                        #    密钥就是 resource_url.skey（64 位 hex ⇒ 32 字节）。
                        #    实测解密后字节数与 resource_url.data_size 完全相等，
                        #    且解密出来是合法 JPEG/GIF/WEBP —— 这就是真图。
                        #    不把 skey 一起带出去，JS 侧只能把密文当图片塞给视觉模型，
                        #    结果是 502 upstream_error「replace the image」。
                        card = {"kind": kind, "url": _u[:500],
                                "w": int(j.get("cover_width") or 0),
                                "h": int(j.get("cover_height") or 0),
                                "size": int(_ru.get("data_size") or 0),
                                "md5": str(_ru.get("md5") or j.get("md5") or "")[:40]}
                        _skey = str(_ru.get("skey") or "").strip()
                        if _skey:
                            card["skey"] = _skey[:80]
                        # GIF 的原图（动图本体）另给一份：card.url 是静帧，只能看一帧
                        if _at2703:
                            _og = (_ru.get("origin_url_list") or [])
                            if _og:
                                card["origin_url"] = str(_og[0])[:500]
                    # 引用回复：抖音把被引用的那条放在 reply/quote/ref 字段里
                    # ⚠️ 2026-10-25 实测 52 条私信里一条引用都没有，所以下面这组键名
                    #    仍然是「候选」，没被真实数据验过。真遇到引用消息时，
                    #    看 `raw` 里哪个键装的是被引用那条，把键名补进来即可。
                    _ref = None
                    for _k3 in ("reply", "quote", "ref_msg", "reference", "replyComment",
                                "reply_comment", "quote_msg", "refer", "ref_message",
                                "reply_to", "replyTo", "quote_info",
                                # ⭐ 2026-11-03 补：这两个是**实测真实存在**的键名。
                                #    `ref_msg_info` 出现在图片/动图消息的 f8 里
                                #    （实测值 `{"comment": ""}` —— 空的，但键是真的）；
                                #    `message_reply_display_type` 是客户端标记「这条是回复」，
                                #    实测全是 0（不是回复）。真出现非空的 ref_msg_info
                                #    或非 0 的 display_type 时，下面才能解出引用。
                                "ref_msg_info", "refMsgInfo",
                                "message_reply_display_type", "reply_info"):
                        _v3 = j.get(_k3)
                        if isinstance(_v3, dict) and _v3:
                            # 空壳 `{"comment": ""}` 不算 —— 那只是客户端把字段占位带出来
                            if any(str(x or "").strip() for x in _v3.values()):
                                _ref = _v3
                                break
                        if isinstance(_v3, str) and _v3.startswith("{"):
                            try:
                                _v3 = json.loads(_v3)
                            except Exception:
                                _v3 = None
                            if isinstance(_v3, dict) and any(
                                    str(x or "").strip() for x in _v3.values()):
                                _ref = _v3
                                break
                    if _ref:
                        if not text:
                            text = "[引用了消息]"
                        card = card or {"kind": "quote"}
                        card["quote"] = {
                            # 🔴 2026-11-08：[:200] → fit_desc。引用消息里夹的视频卡片
                            #   文案同样被砍 200，下游看到的是截断版。
                            "text": fit_desc(str(_ref.get("text") or _ref.get("content_title") or "")),
                            "sender": str(_ref.get("uid") or _ref.get("sender") or "")[:32],
                            "cid": str(_ref.get("cid") or _ref.get("itemId") or "")[:40],
                        }
                    # 抖音的富文本里装 @某人 / 话题 / 引用片段（实测这批 raw 里 richTextInfos
                    # 都是空数组，但字段一定存在 ⇒ 真出现内容时按下面解）
                    _rt = j.get("richTextInfos")
                    if isinstance(_rt, list) and _rt:
                        _ats, _topics = [], []
                        for _e in _rt:
                            if not isinstance(_e, dict):
                                continue
                            _t = int(_e.get("type") or 0)
                            _s = str(_e.get("text") or "").strip()
                            if _t in (1, 2) and _s:
                                _ats.append(_s)
                            elif _t in (3, 4) and _s:
                                _topics.append(_s)
                        if _ats or _topics:
                            card = card or {"kind": "richtext"}
                            if _ats:
                                card["at"] = _ats[:6]
                            if _topics:
                                card["topics"] = _topics[:6]
                    # @ 名单（结构简单，直接留名字）
                    _mu = j.get("mention_users")
                    if isinstance(_mu, list) and _mu:
                        _names = []
                        for _e in _mu:
                            if isinstance(_e, dict):
                                _nm2 = str(_e.get("nickname") or _e.get("nick_name") or "").strip()
                                if _nm2:
                                    _names.append(_nm2)
                            elif isinstance(_e, str) and _e.strip():
                                _names.append(_e.strip())
                        if _names:
                            card = card or {"kind": "mention"}
                            card["mention"] = _names[:6]
                    # ⭐ 2026-10-27 群聊系统消息（aweType=100140）：
                    #    实测只有群聊会推，形如
                    #    {"aweType":100140,"active_users":[{uid,sec_uid,nickname}],
                    #     "passive_users":[...],"locale_resources":[{"lang":"zh-Hans",
                    #     "text":"{0}邀请你加入了群聊"}]}
                    #    以前一律落到「[未知消息]」，群聊读出来一片空白。
                    #    模板里的 {0}/{1} 按 active_users → passive_users 顺序代入。
                    #    ⚠️ 只做「模板代入」，不猜模板里没写的东西。
                    if not text and int(j.get("aweType") or 0) == 100140:
                        kind = "system"
                        _tpl = ""
                        for _lr in (j.get("locale_resources") or []):
                            if isinstance(_lr, dict) and _lr.get("lang") == "zh-Hans" \
                                    and _lr.get("text"):
                                _tpl = str(_lr["text"])
                                break
                        if not _tpl:
                            for _lr in (j.get("locale_resources") or []):
                                if isinstance(_lr, dict) and _lr.get("text"):
                                    _tpl = str(_lr["text"])
                                    break
                        _args = []
                        for _grp in ("active_users", "passive_users"):
                            for _u in (j.get(_grp) or []):
                                if isinstance(_u, dict):
                                    _args.append(str(_u.get("nickname")
                                                     or _u.get("uid") or ""))
                        for _i, _a in enumerate(_args):
                            _tpl = _tpl.replace("{%d}" % _i, _a)
                        text = _tpl.strip() or "[群系统消息]"
                        if _args:
                            card = card or {"kind": "group_system", "users": _args[:6]}
                    # 纯系统提示（{"tips":"你们已互相关注对方","aweType":0}）：
                    # 不是内容，标成 system 让下游别拿它当一句人话去回。
                    if not text and j.get("tips"):
                        kind = "system"
                        text = str(j.get("tips") or "")[:120]
                    # ⭐ 2026-10-31：评论区截图分享（aweType=10500）。
                    #    实测 raw：aweme_title(#灭霸日常#漫威) + comment(这扫码梗到底是谁发明的…)
                    #    + comment_user_name(🌈真正的鳗) + comment_id + cover_url。
                    #    以前 text 为空 ⇒ unknown ⇒「[未知消息]」，她看到的就是一片空白。
                    if not text and int(j.get("aweType") or 0) == 10500:
                        kind = "comment_share"
                        _title = str(j.get("aweme_title") or "")[:120]
                        # 🔴 2026-11-08：[:300] → fit_desc。评论分享这条消息的正文
                        #   完全靠 _cmt 撑着（text 里只拼它），长评论（有人贴长段）
                        #   在这里被砍，她就只读到半句。
                        _cmt = fit_desc(j.get("comment") or "")
                        _who = str(j.get("comment_user_name") or "")[:40]
                        _cu = j.get("cover_url") or {}
                        _curl = ((_cu.get("url_list") or [""])[0]) if isinstance(_cu, dict) else ""
                        body = ""
                        if _title:
                            body += f"作品《{_title}》"
                        if _cmt:
                            body += (" 的评论区里，"
                                     if body else "评论区里，")
                            body += (f"{_who}：" if _who else "") + _cmt
                        text = ("[评论分享] " + body) if body else "[评论分享]"
                        card = {"kind": "comment_share", "url": str(_curl)[:500],
                                "aweme_title": _title, "comment": _cmt,
                                "comment_user": _who,
                                "comment_id": str(j.get("comment_id") or ""),
                                "aweme_author_id": str(j.get("aweme_author_id") or ""),
                                "w": int((_cu.get("width") if isinstance(_cu, dict) else 0) or 0),
                                "h": int((_cu.get("height") if isinstance(_cu, dict) else 0) or 0)}
                    # ⭐ 2026-10-31：火焰/火花等互动卡片（aweType=110408 一类）。
                    #    实测 raw 是 im_dynamic_patch 包一层 Lynx 模板 JSON，没有任何正文，
                    #    里面 enter_from=flame_egg_redpack_card。这类是互动玩法，不是聊天内容。
                    if not text and int(j.get("aweType") or 0) == 110408:
                        kind = "interact"
                        text = "[互动卡片] 火焰/火花互动"
                        card = {"kind": "interact", "scene": "flame"}
                    # 带 awemeType 的富卡片（aweType=0 但其实是卡片，实测 2 条）
                    if not text and j.get("awemeType") is not None:
                        kind = "card"
                        card = {
                            "item_id": str(j.get("itemId") or ""),
                            # 🔴 2026-11-08：[200] → fit_desc。带 awemeType 的富卡片
                            #   （aweType=0 但其实是卡片）文案也在这里被砍。
                            "title": fit_desc(str(j.get("content_name") or j.get("content_title") or "")),
                            "author_uid": str(j.get("uid") or ""),
                            "cover": ((j.get("content_thumb") or {}).get("url_list") or [""])[0],
                            "w": int(((j.get("content_thumb") or {}).get("width")) or 0),
                            "h": int(((j.get("content_thumb") or {}).get("height")) or 0),
                        }
                        text = card["title"] or "[卡片]"
                except Exception as _pe:
                    # ⚠️⚠️ 2026-10-25 晚修的真 bug（找了一整晚）：
                    #    这里以前无条件写 `text = content_raw[:120]`，会把上面已经
                    #    正确解析出来的 text（以及 emoji 分支设的 "[表情]"）**整个覆盖**
                    #    成原始 JSON 原文。症状极具迷惑性：
                    #      · kind 是对的（"text" / "emoji" / "card"）
                    #      · card 是对的（有 url / item_id）
                    #      · 唯独 text 是 `{"aweType":700,...,"text":"你好呀"}`
                    #    ⇒ 模型收到的永远是 JSON 字符串，她当然"看不懂"你说什么。
                    #    ⇒ 现在只在真没拿到 text 时才兜底，且把异常原因塞进 raw 便于排查。
                    if not text:
                        text = content_raw[:120]
                    # 🔴 2026-11-08：(raw_keep or "")[:1200] —— 这里原来会把
                    #   已经完整的 JSON 再切 1200 字。虽然只在 parse_error 分支
                    #   走到（raw 本来就没救了），但同一个毛病不该留两次：
                    #   切 JSON 字符串得到的是坏数据，不是「短一点的数据」。
                    raw_keep = (raw_keep or "") + " | parse_error:" + str(_pe)[:120]
                if not text and not card:
                    # ⭐ 2026-10-27 群聊的「服务端通知」：实测群里有 3 条
                    #    f8={"} + f6=1001 + f9 里 a:biz=aweme_im_group_chat_notice。
                    #    f9 是 repeated 的 key/value 属性块（KeyValue: 1=key 2=value），
                    #    里面还常带 s:invisible=<uid,uid,...>（这条只对谁可见）。
                    #    ⇒ 这类**没有正文**，是建群时的伴随通知（成员变化/会话创建）。
                    #    以前一律占位成「[未知消息]」，读群时一片噪音。
                    #    标成 kind=notice 并给个可读说明，让下游一眼能跳过。
                    _attrs = {}
                    for _kv in (f.get(9) or []):
                        if isinstance(_kv, bytes):
                            try:
                                _p = parse(_kv)
                                _k = as_str(g1(_p, 1))
                                _v = as_str(g1(_p, 2))
                                if _k:
                                    _attrs[_k] = _v
                            except Exception:
                                pass
                    _biz = _attrs.get("a:biz", "")
                    if _biz == "aweme_im_group_chat_notice":
                        kind = "notice"
                        text = "[群通知]"
                        card = {"kind": "group_notice", "biz": _biz}
                        if _attrs.get("s:invisible"):
                            card["invisible_to"] = _attrs["s:invisible"].split(",")[:8]
                        # 🔴 2026-11-08：(raw_keep or "")[:900] —— 同上，别切原始 JSON。
                        #    群通知这条本身没有正文，追加 attrs 只是给排查看的。
                        raw_keep = (raw_keep or "") + " | attrs:" + json.dumps(
                            {k: v for k, v in _attrs.items()
                             if k in ("a:biz", "s:invisible", "a:access")},
                            ensure_ascii=False)[:300]
                    else:
                        # 真的什么都没有：留个占位而不是整条吞掉（宁可多给一条 [未知] 也别让上下文断档）
                        text = "[未知消息]"
                        kind = "unknown"
                # ⭐ 排序不信线序（协议顺序实测过不稳定），直接按时间戳排旧→新
                _m = {
                    "_ts": at_ms,
                    "from": "me" if sender == my_uid else "them",
                    # 🔴 2026-11-08：text[:300] → fit_desc(text)。
                    #   这一条是「消息本体」，视频卡片的 kind 也走这里，
                    #   所以它同时是 `_card_aweme` 之外唯一能取到文案的字段。
                    #   2026-11-03 从 200 放宽到 300、2026-11-05 统一四道截断时
                    #   都没动它 —— 但长文案（图文作品、口播长文）照样在这里被砍，
                    #   下游无论怎么放宽都补不回来。
                    "text": fit_desc(text),
                    "at": iso(at_ms),
                    "kind": kind,
                }
                # ⭐ 2026-10-27：把发送者 uid 也带出去。
                #    群聊里说话的有七八个人，只标 them 分不清谁是谁 ——
                #    group-reply 存记忆时需要至少一个稳定标识（这里是数字 uid）。
                #    昵称解析要额外一次请求，这里不做，留给上层按需反查。
                if sender:
                    _m["sender"] = str(sender)[:32]
                if card:
                    _m["card"] = card
                # 认不出形态的原始 JSON 也带上（截断），上层要用就有
                _m["raw"] = raw_keep
                # ⭐ 2026-11-03：从 field9 挑出来的少数几个结构性标记。
                #    只带「上层判断对话关系时可能用到」的键，其余一律丢：
                #      s:mentioned_users  群聊里这条 @ 了谁（逗号分隔的 uid）
                #      s:visible          这条对谁可见（定向消息）
                #      a:last_msg_id      会话里最后一条消息的 id
                #      s:chat_tag         private / social_group / stranger
                #      s:is_stranger_message  陌生人消息的发送者 uid
                #    这些都验证过是真实值，不是协议噪音。
                _keep_kv = {}
                for _k9 in ("s:mentioned_users", "s:visible", "a:last_msg_id",
                            "s:chat_tag", "s:is_stranger_message",
                            "s:refer", "a:share_item_id"):
                    _v9 = _kv9.get(_k9)
                    if _v9 not in (None, ""):
                        _keep_kv[_k9] = str(_v9)[:40]
                if _keep_kv:
                    _m["meta"] = _keep_kv
                messages.append(_m)
            messages.sort(key=lambda x: x["_ts"] or 0)
            for m in messages:
                m.pop("_ts", None)
            # ⭐ 2026-10-27：群聊的名字在 core.f50.5（GroupInfo.name），私聊没有这一层。
            #    实测群「不能出去玩」conv_id=7650565280728384037：
            #      core.f50 = {1:群id, 2:群id, 3:2(类型), 5:"不能出去玩",
            #                  12:群主uid, 13:群主sec_uid, 17:创建者uid, 18:创建时间}
            #    f50.11 是 repeated 的 key/value 属性块（成员上限 30、群类型等），不进摘要。
            gname = ""
            _g = g1(core, 50)
            if _g:
                try:
                    gname = as_str(g1(parse(_g), 5)) or ""
                except Exception:
                    gname = ""
            convs.append({
                "conv_id": conv_id,
                "short_id": as_str(g1(core, 2)),   # ⭐ 19 位数字：必须当字符串透传
                "type": int(g1(core, 3) or 0),     # 1=私聊 2=群聊（群聊不参与按人匹配）
                "name": gname,                     # 群名（私聊为空串）
                "ticket": as_str(g1(core, 4)),
                "peer_uid": peer_uid_of(conv_id, my_uid),
                # sec_uid 在 protobuf 里不一定有，先留空，下面统一补（见 fill_sec_uids）
                "sec_uid": "",
                "message_count": len(messages),
                "messages": messages[-LIMIT:],
            })

        # ③ 身份核验：与会话 peer_uid **严格相等**才算数
        #
        # 🔴 2026-10-25 修：以前**只认 sec_uid**，硬走 user/profile/other 反查数字 uid。
        #    于是把「抖音号」(79494726915) 或数字 uid 当 sec_uid 传进来时，
        #    反查必然失败 ⇒ match_note「sec_uid 反查失败」⇒ chatWatch 231 次检查一次都没读到消息
        #    （面板看着"开着"，实际从没成功过）。
        #    ⇒ 现在认三种输入：
        #      · 纯数字            → 直接当 uid，跳过反查
        #      · MS4wLjABAAAA…    → sec_uid，反查
        #      · 其它（抖音号等）  → 反查失败就**再退一步**：拿会话里的 nickname 比一次
        #    最后一步仍只做「相等才认」，不按序号/顺序猜人。
        matched = None
        match_note = ""

        # ③ 群聊：--list-groups 只列群，不读人；--conv-id 直读指定会话
        #
        # 🔴 这里**不做身份推断**：群聊的 peer_uid 是群 id，跟人的 sec_uid/uid 不是一个体系。
        #    调用方给了 conv_id 就照读那个会话，没给就什么都不猜。
        if LIST_GROUPS:
            groups = [{
                "conv_id": c["conv_id"],
                "name": c["name"] or "(无名群)",
                "type": c["type"],
                "message_count": c["message_count"],
                "last_at": (c["messages"][-1]["at"] if c["messages"] else ""),
                "last_text": (c["messages"][-1]["text"] if c["messages"] else ""),
            } for c in convs if c["type"] == 2]
            groups.sort(key=lambda g: g["last_at"] or "", reverse=True)
            out({
                "ok": True, "via": "http",
                "ms": int((time.time() - t0) * 1000),
                "my_uid": my_uid, "status": status,
                "conversation_count": len(convs),
                "group_count": len(groups),
                "groups": groups,
                "hint": ("读某个群：--conv-id <conv_id>。"
                         "群聊只读，发送侧（im-send.mjs）不支持群，别混用。"),
            })

        if CONV_ID_ARG:
            hit = next((c for c in convs if c["conv_id"] == CONV_ID_ARG), None)
            if not hit:
                out({"ok": False,
                     "error": "没有这个 conv_id 的已建立会话: " + CONV_ID_ARG,
                     "my_uid": my_uid,
                     "note": "只覆盖「已建立会话」；陌生人和没聊过的群不在这里",
                     "known": [{"conv_id": c["conv_id"], "type": c["type"],
                                "name": c["name"]} for c in convs]})
            msgs = hit["messages"][-LIMIT:]
            out({
                "ok": True, "via": "http",
                "ms": int((time.time() - t0) * 1000),
                "my_uid": my_uid, "status": status,
                "matched_by": "conv_id 精确相等（调用方显式指定，未做身份推断）",
                "matched": {
                    "conv_id": hit["conv_id"],
                    "short_id": hit["short_id"],
                    "type": hit["type"],           # 1=私聊 2=群聊
                    "is_group": hit["type"] == 2,
                    "name": hit["name"],
                    "peer_uid": hit["peer_uid"],
                    "message_count": hit["message_count"],
                    "messages": msgs,
                },
            })


        if not PEER_SEC:
            match_note = "未提供 --peer-sec-uid（本工具不按昵称/序号猜人）"
        else:
            wanted_uid = ""
            nickname = ""
            raw = PEER_SEC.strip()
            # ⭐ 2026-10-25 实测：抖音号（如 79494726915，11 位）也是纯数字，
            #    光看 isdigit() 会把它当数字 uid 用 ⇒ 永远匹配不上会话里的 16 位 peer_uid，
            #    报「这个人不在已建立会话里」，肉眼极难发现。
            #    ⇒ 纯数字 + 长度 >= 15 才认作 uid（实测 peer_uid 都是 16 位）；
            #      更短的一律按「抖音号」走反查/报错，不静默当 uid。
            if raw.isdigit() and len(raw) >= 15:
                # 已经是数字 uid：不用反查（反查接口只吃 sec_uid）
                wanted_uid = raw
                nickname = ""
            else:
                try:
                    p = s.get(WWW + "/aweme/v1/web/user/profile/other/?" + COMMON
                              + "&sec_user_id=" + raw, timeout=12).json()
                    wanted_uid = str((p.get("user") or {}).get("uid") or "")
                    nickname = str((p.get("user") or {}).get("nickname") or "")
                except Exception:
                    pass
            if not wanted_uid:
                # 反查不到（大概率传的是抖音号而不是 sec_uid）⇒ 直接报清楚，不猜人
                # 这个人在不在会话里，靠 peer_uid 比，不靠昵称/序号。
                conv_peers = [c.get("peer_uid") for c in convs if c["type"] == 1]
                match_note = (
                    "拿不到这个人的数字 uid（传进来的不是 sec_uid，"
                    "可能是抖音号或昵称）——不猜，退浏览器。"
                    "已知可用的数字 uid 有：" + ", ".join(str(x) for x in conv_peers if x)
                )
            if wanted_uid:
                hit = next((c for c in convs
                            if c["type"] == 1 and c["peer_uid"] == wanted_uid), None)
                if hit:
                    matched = {
                        "sec_uid": raw, "uid": wanted_uid, "nickname": nickname,
                        "conv_id": hit["conv_id"], "messages": hit["messages"],
                    }
                elif not match_note:
                    match_note = "这个人不在已建立会话里（陌生人消息走别的接口，本工具不覆盖）"

        try:
            fill_sec_uids(s, convs, my_uid)
        except Exception:
            pass

        result = {
            "ok": True, "via": "http",
            "ms": int((time.time() - t0) * 1000),
            "my_uid": my_uid, "status": status,
            "conversation_count": len(convs),
            "conversations": convs,
            "matched": matched,
        }
        if not matched:
            result["match_note"] = match_note
        out(result)


if __name__ == "__main__":
    main()
