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
import time
from datetime import datetime, timezone

# Windows 控制台默认 GBK：消息文本里有 emoji（🍜 等）会 UnicodeEncodeError。
# 宿主跑会设 PYTHONUTF8=1，这里再把 stdout 兜一道，命令行直跑也不炸。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _home import home_str  # noqa: E402

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
try:
    LIMIT = max(1, min(int(arg_of("--limit", "30") or 30), 60))
except ValueError:
    LIMIT = 30


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))
    sys.exit(0 if obj.get("ok") else 1)


if not READ:
    out({"ok": False, "error": "只支持 --read（这是个只读工具）"})

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


_PROBE = []
_PROBE_OUT = []


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


def _probe_main():
    import json as _j
    print(_j.dumps(_PROBE_OUT, ensure_ascii=False, indent=1))


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
                text, kind = "", "text"
                card = None
                try:
                    j = json.loads(content_raw)
                    text = str(j.get("text") or j.get("content_title") or "").strip()
                    kind = "card" if int(j.get("aweType") or 0) == 800 else "text"
                    # ⭐ 2026-10-25：card 的 itemId 以前直接被丢掉，导致下游只看到一串
                    #    标题+话题标签，回不出有内容的话（对方发个视频过来，她只能干瞪眼）。
                    #    这里补上 itemId / 封面 / 尺寸，够下游判断「这是个视频卡片」并具体回应。
                    if kind == "card":
                        _cover = (j.get("cover_url") or {}).get("url_list") or []
                        card = {
                            "item_id": str(j.get("itemId") or ""),
                            "title": text[:200],
                            "author_uid": str(j.get("uid") or ""),
                            "cover": _cover[0] if _cover else "",
                            "w": int(j.get("cover_width") or 0),
                            "h": int(j.get("cover_height") or 0),
                        }
                except Exception:
                    text = content_raw[:120]
                if not text and not card:
                    continue
                # ⭐ 排序不信线序（协议顺序实测过不稳定），直接按时间戳排旧→新
                _m = {
                    "_ts": at_ms,
                    "from": "me" if sender == my_uid else "them",
                    "text": text[:200],
                    "at": iso(at_ms),
                    "kind": kind,
                }
                if card:
                    _m["card"] = card
                try:
                    _dump = {"fn": {}, "content_raw": content_raw}
                    for _k, _v in f.items():
                        if isinstance(_v, bytes):
                            try:
                                _dump["fn"][_k] = "B:" + _v.decode("utf-8")[:400]
                            except Exception:
                                _dump["fn"][_k] = "B(hex):" + _v.hex()[:200]
                        elif isinstance(_v, list):
                            try:
                                _dump["fn"][_k] = ["B:" + (x.decode("utf-8")[:80] if isinstance(x, bytes) else str(x)) for x in _v]
                            except Exception:
                                _dump["fn"][_k] = "[list]"
                        else:
                            _dump["fn"][_k] = _v
                    _PROBE.append(_dump)
                except Exception as _e:
                    _PROBE.append({"err": str(_e)})
                messages.append(_m)
            messages.sort(key=lambda x: x["_ts"] or 0)
            for m in messages:
                m.pop("_ts", None)
            _PROBE_OUT.append({"conv_id": conv_id, "probe": _PROBE})
            convs.append({
                "conv_id": conv_id,
                "short_id": as_str(g1(core, 2)),   # ⭐ 19 位数字：必须当字符串透传
                "type": int(g1(core, 3) or 0),     # 1=私聊 2=群聊（群聊不参与按人匹配）
                "ticket": as_str(g1(core, 4)),
                "peer_uid": peer_uid_of(conv_id, my_uid),
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

        result = {
            "ok": True, "via": "http",
            "ms": int((time.time() - t0) * 1000),
            "my_uid": my_uid, "status": status,
            "conversation_count": len(convs),
            "conversations": convs,
            "matched": matched,
            "probe": _PROBE_OUT,
        }
        if not matched:
            result["match_note"] = match_note
        out(result)


if __name__ == "__main__":
    main()
