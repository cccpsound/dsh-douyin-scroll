# -*- coding: utf-8 -*-
"""视频语音转写 —— 把视频里「说的话」变成文字。

## 为什么需要这个（2026-11-05）

`lib/video-understand.mjs` 的文件头一直写着：

    「本机没有 ffmpeg（shutil.which('ffmpeg') 为 None），装不动」

所以整条链路只取了「封面/抽帧 + 文案(desc) + 评论」三样，**视频里说的话一个字都没拿**。
使用者报「抖音还是看不了完整视频文案」时，先查的是文案截断（那条确实是主因，
已另修），但紧接着就会撞上这个洞：口播型视频的 desc 常常只有「#日常 #vlog」几个字，
光靠抽帧和评论拼不出它在讲什么。

那个前提早就过期了：ffmpeg 在 `~/.dsh/douyin-duty/bin/ffmpeg.exe`，
`sherpa_onnx` 2.0.0 已装，SenseVoice 模型在 `data/models/sensevoice/`。
三样齐了，只是没人把它们接起来。

## 用法（设计成子进程，读 stdin / 写 stdout）

    ffmpeg ... -f wav pipe:1 | python audio-stt.py --format json

全程不落盘。这不是洁癖 —— 实测这个 ffmpeg 在沙箱里**写文件会被拒**
（`Permission denied`），而管道完全正常（见 `lib/video-frames.mjs` 的 runFfmpeg 注释，
那边抽帧早就用 `-f image2pipe` 绕开了同一个坑）。

## 为什么长音频要切片

SenseVoice 是整段编码的模型，一次喂 10 分钟会：
  · 内存飙升（实测 5 分钟 16k 单声道约 19MB float，可以接受，但注意不是无限的）
  · 超长时识别质量下降，还容易在中间截断
按 30 秒切、每片独立解码、最后拼起来，代价很小（模型是常驻的），稳得多。

## 只输出「说了什么」，不做说话人分离

不猜是谁在说。口播视频里那基本就是作者本人，标了反而可能标错。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import wave

# SenseVoice 的采样率，固定 16k 单声道。
SAMPLE_RATE = 16000

# 每片时长。30 秒是实测的平衡点：短于 20 秒切片过多、每片都要跑一次，
# 长于 60 秒单片的推理时间开始明显拉长且容易在句中断开。
CHUNK_SEC = 30.0

# 视频最长转写多少秒。超过就不转了 —— 抖音这边 videoToGrid 的上限是 600 秒，
# 600 秒全转大约需要 20-40 秒 CPU 时间，会把「看一眼」的预算顶掉。
MAX_SEC = 600.0

# 静音/纯音乐时 SenseVoice 会吐出这类短幻觉（实测正弦音和纯静音都返回「我。」）。
# 只由这些字/标点组成、且总长很短的，一律当「没人说话」。
_HALLUCINATIONS = {
    "我", "我。", "嗯", "嗯。", "啊", "啊。", "哦", "哦。", "呃", "呃。",
    "。", "，", "、", "？", "！", "……", "谢谢", "谢谢。", "字幕", "字幕由",
    "请不吝点赞", "订阅", "转发", "打赏", "支持明镜与点点栏目",
}


def _is_empty_speech(text: str) -> bool:
    """判断转写结果是不是「其实没人说话」。

    为什么需要这个：SenseVoice 对非语音输入不是返回空串，而是返回短的
    高频幻觉词。实测 3 秒正弦音和 3 秒纯静音都得到「我。」。如果不滤掉，
    上层会把这两个字当成「视频里说的话」写进 prompt，比没有更糟。
    """
    t = (text or "").strip()
    if not t:
        return True
    if t in _HALLUCINATIONS:
        return True
    # 去掉标点后只剩一两个字，也当幻觉。
    core = "".join(ch for ch in t if ch not in "。，、？！…—~·,.?! ")
    return len(core) <= 2

DEFAULT_MODEL = (
    r"E:/_bot/astrbot/AstrBot-master/data/models/sensevoice/model.int8.onnx"
)
DEFAULT_TOKENS = (
    r"E:/_bot/astrbot/AstrBot-master/data/models/sensevoice/tokens.txt"
)


def _read_wav(stream_in) -> tuple[bytes, int, int]:
    """从 stdin 读一个完整 wav，返回 (raw_pcm, sample_rate, n_channels)。

    用 wave 模块而不是自己解析 —— ffmpeg 吐的是标准 44 字节头的 wav。
    """
    buf = stream_in.read()
    if not buf:
        raise ValueError("stdin 是空的")
    with wave.open(io.BytesIO(buf), "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate(), w.getnchannels()


def _to_mono_f32(raw: bytes, channels: int):
    """16bit PCM → float32 单声道。ffmpeg 已经给 -ac 1，这里是兜底。"""
    import numpy as np

    x = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x


def transcribe(
    samples,
    sample_rate: int,
    *,
    model: str = DEFAULT_MODEL,
    tokens: str = DEFAULT_TOKENS,
    num_threads: int = 2,
    language: str = "zh",
) -> str:
    """把整段波形转成文字。长音频按 CHUNK_SEC 切片。"""
    import sherpa_onnx

    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=num_threads,
        use_itn=True,
        language=language,
    )

    step = int(CHUNK_SEC * sample_rate)
    total = len(samples)
    if total <= step:
        chunks = [samples]
    else:
        chunks = [samples[i : i + step] for i in range(0, total, step)]

    parts: list[str] = []
    for ch in chunks:
        if len(ch) < sample_rate * 0.2:  # 短于 0.2 秒的尾巴丢掉
            continue
        s = rec.create_stream()
        s.accept_waveform(sample_rate=sample_rate, waveform=ch)
        rec.decode_stream(s)
        t = (s.result.text or "").strip()
        if t:
            parts.append(t)

    return "".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="视频语音转写（读 stdin 的 wav）")
    ap.add_argument("--format", choices=["text", "json"], default="json")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--tokens", default=DEFAULT_TOKENS)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--language", default="zh")
    ap.add_argument("--max-sec", type=float, default=MAX_SEC)
    args = ap.parse_args(argv)

    def _fail(msg: str) -> int:
        if args.format == "json":
            print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
        else:
            print("", end="")
        return 0  # 刻意返回 0：转写失败不该让上层整条链路失败

    if not os.path.isfile(args.model):
        return _fail(f"model_not_found: {args.model}")
    if not os.path.isfile(args.tokens):
        return _fail(f"tokens_not_found: {args.tokens}")

    try:
        raw, sr, ch = _read_wav(sys.stdin.buffer)
    except Exception as e:
        return _fail(f"read_wav_failed: {e}")

    dur = len(raw) / max(1, sr * ch)
    if args.max_sec and dur > args.max_sec:
        return _fail(f"too_long: {dur:.0f}s > {args.max_sec:.0f}s")

    try:
        import numpy as np  # noqa: F401  (确认依赖在，缺了下面会抛)
        x = _to_mono_f32(raw, ch)
        text = transcribe(
            x,
            sr,
            model=args.model,
            tokens=args.tokens,
            num_threads=args.threads,
            language=args.language,
        )
    except Exception as e:
        return _fail(f"stt_failed: {type(e).__name__}: {e}")

    if args.format == "json":
        print(
            json.dumps(
                {
                    "ok": True,
                    "text": "" if _is_empty_speech(text) else text,
                    "duration_s": round(dur, 1),
                    "chars": 0 if _is_empty_speech(text) else len(text),
                    # 静音/纯音乐时 SenseVoice 会吐短的幻觉词（实测正弦音和纯静音都
                    # 返回「我。」），那种一律当「没人说话」，别把幻觉喂给模型。
                    "empty": _is_empty_speech(text),
                },
                ensure_ascii=False,
            )
        )
    else:
        print("" if _is_empty_speech(text) else text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
