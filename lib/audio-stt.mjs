/**
 * 音频转写：视频里「说的话」→ 文字。
 *
 * ## 为什么现在才有（2026-11-05）
 *
 * `lib/video-understand.mjs` 头部的注释一直写着「本机没有 ffmpeg，装不动」，
 * 于是整条链路只拿「抽帧 + 文案 + 评论」，**视频里说的话一个字都没拿**。
 *
 * 那个前提早就不成立了：ffmpeg 在 `~/.dsh/douyin-duty/bin/ffmpeg.exe`，
 * sherpa_onnx + SenseVoice 模型在 AstrBot 那边也齐了。
 *
 * 使用者最先报的是「看不了完整视频文案」，查下来主因是 desc 被按字数硬切
 * （已另修，见 lib/desc.mjs）。但修完那处还剩一个洞：**口播型视频的 desc
 * 常常只有「#日常 #vlog」几个字**，光靠抽帧和评论拼不出它在讲什么，
 * 这时候唯一的线索就是它说了什么。
 *
 * ## 为什么用 AstrBot 的 python 而不是 douyin 的 venv
 *
 * 实测（2026-11-05）：
 *   · `douyin-duty/.venv` 里没有 sherpa_onnx，而且**装不进去** ——
 *     那个 venv 的 python 自己 `tempfile.gettempdir()` 就抛
 *     `FileNotFoundError: No usable temporary directory found`，
 *     pip 连解包都动不了（和 ffmpeg 写文件被拒是同一类限制）。
 *   · AstrBot 的 venv（`E:/_bot/astrbot/venv/Scripts/python.exe`）里
 *     sherpa_onnx 2.0.0 + numpy 都在，tempdir 正常，SenseVoice 模型也挂在它目录下。
 *
 * 所以这里挑「有 AstrBot venv 就用它，没有就跳过」，而不是硬塞进 douyin 的 venv。
 * 找不到就静默返回 `{ok:false}` —— 转写是**增强**，不是主链路，缺了不能让她不能看图。
 *
 * ## 为什么全程走管道
 *
 * 这个 ffmpeg 在沙箱里**写文件会被拒**（`Permission denied`），
 * 但吐 stdout 完全正常（`lib/video-frames.mjs` 抽帧用 `-f image2pipe` 绕的是同一个坑）。
 * 所以整条链路：ffmpeg `-f wav pipe:1` → python 读 stdin → 打印 JSON，一个临时文件都不落。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { findFfmpeg } from './video-frames.mjs'

/** 转写脚本（和本文件同仓库，tools/ 下） */
const STT_SCRIPT = join(import.meta.dirname, '..', 'tools', 'audio-stt.py')

/** SenseVoice 模型。和 AstrBot 的 provider 配置指向同一份。 */
const MODEL = 'E:/_bot/astrbot/AstrBot-master/data/models/sensevoice/model.int8.onnx'
const TOKENS = 'E:/_bot/astrbot/AstrBot-master/data/models/sensevoice/tokens.txt'

/**
 * 找能跑 sherpa_onnx 的 python。
 *
 * 顺序：环境变量 → AstrBot venv（实测唯一装好 sherpa 的那个）→ 放弃。
 * **刻意不用裸 `python`**：Windows 上它弹控制台黑框（2026-10-29 使用者反馈
 * 全屏游戏被强行最小化），而且系统 python 也不一定有 sherpa。
 */
function findSttPython() {
  if (process.env.DOUYIN_STT_PY) {
    return existsSync(process.env.DOUYIN_STT_PY) ? process.env.DOUYIN_STT_PY : null
  }
  const cands = [
    'E:/_bot/astrbot/venv/Scripts/pythonw.exe',
    'E:/_bot/astrbot/venv/Scripts/python.exe',
    join(homedir(), '_bot', 'astrbot', 'venv', 'Scripts', 'pythonw.exe'),
  ]
  for (const p of cands) {
    if (existsSync(p)) return p
  }
  return null
}

/** 转写能不能用。给上层决定要不要多花那几秒。 */
export function sttAvailable() {
  return Boolean(findFfmpeg() && findSttPython() && existsSync(MODEL) && existsSync(STT_SCRIPT))
}

/**
 * 从视频流抽音频并转写成文字。
 *
 * @param {string} videoUrl 抖音视频直链（带 Referer 才给下）
 * @param {{maxSec?:number, timeoutMs?:number}} opt
 * @returns {Promise<{ok:boolean, text?:string, duration_s?:number, chars?:number, empty?:boolean, ms?:number, error?:string}>}
 */
export async function transcribeVideo(videoUrl, opt = {}) {
  const t0 = Date.now()
  if (!videoUrl) return { ok: false, error: 'empty_url' }

  const ff = findFfmpeg()
  if (!ff) return { ok: false, error: 'no_ffmpeg' }
  const py = findSttPython()
  if (!py) return { ok: false, error: 'no_stt_python' }
  if (!existsSync(MODEL)) return { ok: false, error: 'no_model' }
  if (!existsSync(STT_SCRIPT)) return { ok: false, error: 'no_script' }

  const maxSec = Math.max(30, Number(opt.maxSec) || 600)
  const timeoutMs = Math.max(15_000, Number(opt.timeoutMs) || 120_000)

  // ① ffmpeg 从 URL 直接抽音频 → wav 到 stdout。
  //    不先下整段 mp4：走 URL 输入时 ffmpeg 只读需要的那部分，
  //    对「只想听声音」来说比下 48MB 再解快得多。
  const isHttp = /^https?:/i.test(videoUrl)
  const netArgs = isHttp
    ? [
        /**
         * 抖音 CDN 校验 Referer，不带会 403。
         *
         * ⚠️ 这里**必须**用 `-referer` / `-user_agent`，不能用 `-headers`。
         *    实测（2026-11-05，ffmpeg N-92722 / 2018 版）：`-headers` 在
         *    `-h full` 里虽然列出来了，但它带 `E` 标记（输出选项）；
         *    放在输入前直接报 `Option headers not found.` —— 白折腾一轮。
         *    `-referer` / `-user_agent` 是 `D` 标记的输入选项，才是这条路的正解。
         *
         * ⚠️ 而且这两个只对 http/https 有效：`ffmpeg -referer x -i file.wav`
         *    同样报 `Option referer not found.`。所以按协议加，不能无条件拼。
         */
        '-referer', 'https://www.douyin.com/',
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
      ]
    : []

  const wav = await new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...netArgs,
      '-t', String(maxSec),
      '-i', videoUrl,
      '-vn', // 不要视频流
      '-ar', '16000', // SenseVoice 固定 16k
      '-ac', '1',
      '-f', 'wav', 'pipe:1',
    ]
    execFile(
      ff,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message || '').slice(-200)
          return resolve({ ok: false, error: 'ffmpeg_failed: ' + tail })
        }
        if (!stdout || !stdout.length) return resolve({ ok: false, error: 'empty_audio' })
        resolve({ ok: true, buf: stdout })
      }
    )
  })
  if (!wav.ok) return { ...wav, ms: Date.now() - t0 }

  // ② python 读 wav → 转写 → 打印 JSON。
  const out = await new Promise((resolve) => {
    const child = execFile(
      py,
      [STT_SCRIPT, '--format', 'json', '--model', MODEL, '--tokens', TOKENS],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          return resolve({ ok: false, error: 'stt_failed: ' + String(stderr || err.message).slice(-200) })
        }
        const line = String(stdout || '').trim().split('\n').pop() || ''
        try {
          resolve(JSON.parse(line))
        } catch {
          resolve({ ok: false, error: 'bad_stt_json: ' + line.slice(0, 120) })
        }
      }
    )
    // wav 从 stdin 灌进去（不落盘）
    child.stdin.on('error', () => {}) // EPIPE 之类不要炸
    child.stdin.end(wav.buf)
  })

  if (!out.ok) return { ...out, ms: Date.now() - t0 }
  return { ...out, ms: Date.now() - t0 }
}
