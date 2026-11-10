# -*- coding: utf-8 -*-
"""文案收长 —— 和 JS 侧 `lib/desc.mjs` 的 `fitDesc` 保持同一套规则。

为什么 Python 侧也要有（2026-11-05）：

    同一条文案在整条链路上被砍成好几个长度，JS 那边四个（300/280/150/200），
    Python 这边 `xj_douyin/main.py` 又有三个（591 的 280、1280 的 200、
    1553 的 280）。前几次修都只改了一处，剩下两处照样把长文切掉。

    所以两边用同一套规则：上限 2000，超了在自然断点收尾，
    并在尾巴注明「后面还有 N 字，这条没读完」。

    规则本身很短，值得复制一份而不是去跨语言调 —— 一个 mjs 一个 py 各自
    独立可跑，哪边坏了都不影响另一边。
"""

from __future__ import annotations

DESC_CAP = 2000

# 断点优先级：先句子，再分句。和 desc.mjs 的 _BREAKS 保持一致。
_BREAKS = ("。", "！", "？", "；", "…", "\n", ".", "!", "?", ";", "，", ",")


def fit_desc(text, cap: int = DESC_CAP, mark: bool = True) -> str:
    """按上限收长，尽量断在自然断点。

    Args:
        text: 原始文案，None 当空串。
        cap: 上限字数。
        mark: 是否加「后面还有 N 字」。视觉模型那种场合可以关掉。

    Returns:
        收长后的文案；不超上限时与输入逐字相同。
    """
    s = "" if text is None else str(text)
    limit = max(20, int(cap or DESC_CAP))
    if len(s) <= limit:
        return s

    # 往回找自然断点。只搜最后 30%，否则一条长文会一路退到第一个句号，
    # 等于只给了开头几百字。
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


def fit_desc_brief(text, cap: int = 400) -> str:
    """给视觉模型看的短版：首段 + 末段，长文的落点常在结尾。"""
    s = "" if text is None else str(text)
    limit = max(40, int(cap or 400))
    if len(s) <= limit:
        return s
    half = (limit - 8) // 2
    head = fit_desc(s, half, mark=False)
    tail = s[-half:]
    return f"{head}……（中间略）……{tail}"
