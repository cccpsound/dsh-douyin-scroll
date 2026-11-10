#!/usr/bin/env node
/**
 * tools/learn-cli.mjs —— 把一个词「学会」，给外部进程（QQ 侧 AstrBot）调用。
 *
 * 为什么不在 Python 里重写一遍搜索：抖音搜索要 curl_cffi + cookie、
 * 搜狗摘要要提取 `markdown__contentBlock`、提炼还要过相关性闸 ——
 * 这套东西已经在这份代码里调稳了（`learnTerm`），重写一遍必然跑偏。
 * Python 侧只需要知道「这词学会了没、意思是什么」，所以这里只暴露一个
 * JSON 进 JSON 出的壳。
 *
 * 用法：
 *   node tools/learn-cli.mjs 扎啤
 *   node tools/learn-cli.mjs 灭建国 --no-search     # 只查库，不联网
 *   node tools/learn-cli.mjs 塔菲 --no-web          # 只查抖音，不查网页
 *   node tools/learn-cli.mjs 某某 --home D:/other   # 指定梗库位置
 *
 * 输出（stdout 一行 JSON）：
 *   { ok, cached, via, term, meaning, items, answer, titles, error, ms }
 *   via: library（库里已有）| douyin（抖音搜到）| web（搜狗摘要）
 *        | web-titles（只拿到标题，weak=true，不入库）
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { learnTerm } from '../lib/memelearn.mjs'

const argv = process.argv.slice(2)
const opts = { web: true, noSearch: false }
const rest = []
let home = process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--no-search') opts.noSearch = true
  else if (a === '--no-web') opts.web = false
  else if (a === '--home' && argv[i + 1]) home = argv[++i]
  else if (a === '--timeout' && argv[i + 1]) opts.timeout = Number(argv[++i])
  else if (!a.startsWith('--')) rest.push(a)
}

const term = String(rest[0] || '').trim()
const t0 = Date.now()
let out
if (!term) {
  out = { ok: false, error: 'empty_term' }
} else {
  try {
    out = learnTerm(home, term, opts)
  } catch (e) {
    // 这一层永不抛：上层是按 stdout 解析的，抛出去那边只会看到空字符串
    out = { ok: false, error: 'throw: ' + String(e?.message || e).slice(0, 160) }
  }
}
out = { ...out, ms: Date.now() - t0 }
process.stdout.write(JSON.stringify(out))
