#!/usr/bin/env node
/**
 * tools/meme-cli.mjs —— 梗库的手动入口（给人用，也给 QQ 侧调用）。
 *
 * 为什么要有它：梗库主要靠她自己搜 / 模型自报 / 群里有人教，
 * 但这三种都会漏 —— 有些词是群里的私梗，网上根本没解释；有些她学歪了要改。
 * 所以留一个能直接读写库的口子。
 *
 *   node tools/meme-cli.mjs ls
 *   node tools/meme-cli.mjs get 扎啤
 *   node tools/meme-cli.mjs add 扎啤 "骂人话，西南方言，说人是混混" --alias 杂皮 --alias 杂痞
 *   node tools/meme-cli.mjs del 扎啤
 *   node tools/meme-cli.mjs alias 扎啤 杂皮 咋皮
 *
 * 默认写 `<HOME>/memory/memes.json`；`--home` 可指定别的位置。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, renameSync } from 'node:fs'
import { loadMemes, lookupMeme, addMeme, normTerm } from '../lib/meme.mjs'

const argv = process.argv.slice(2)
const cwd = process.cwd()
const HOME = (() => {
  const i = argv.indexOf('--home')
  if (i >= 0 && argv[i + 1]) { const v = argv[i + 1]; argv.splice(i, 2); return v }
  return process.env.DOUYIN_DUTY_HOME || join(homedir(), '.dsh', 'douyin-duty')
})()

const cmd = String(argv[0] || 'ls').toLowerCase()
const args = []
const aliases = []
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--alias' || argv[i] === '-a') { if (argv[i + 1]) aliases.push(argv[++i]) }
  else args.push(argv[i])
}

const out = (o) => console.log(JSON.stringify(o, null, 1))

if (cmd === 'ls' || cmd === 'list') {
  const db = loadMemes(HOME)
  const rows = Object.values(db.items).map((v) => ({
    term: v.term, meaning: v.meaning, hits: v.hits, source: v.source,
    aliases: v.aliases || [], at: v.at,
  }))
  rows.sort((a, b) => (b.hits || 0) - (a.hits || 0))
  out({ ok: true, total: rows.length, file: join(HOME, 'memory', 'memes.json'), items: rows })
} else if (cmd === 'get') {
  const m = lookupMeme(HOME, args[0] || '')
  out(m ? { ok: true, item: m } : { ok: false, error: '库里没有这个词' })
} else if (cmd === 'add' || cmd === 'set') {
  const r = addMeme(HOME, { term: args[0], meaning: args.slice(1).join(' '), source: 'manual', aliases })
  out(r)
} else if (cmd === 'del' || cmd === 'rm') {
  const db = loadMemes(HOME)
  const k = normTerm(args[0] || '')
  if (!db.items[k]) out({ ok: false, error: '库里没有这个词' })
  else {
    delete db.items[k]
    db.updatedAt = new Date().toISOString()
    const file = join(HOME, 'memory', 'memes.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8')
    renameSync(tmp, file)
    out({ ok: true, deleted: args[0], total: Object.keys(db.items).length })
  }
} else if (cmd === 'alias') {
  const term = args[0]
  const m = lookupMeme(HOME, term)
  if (!m) { out({ ok: false, error: '库里没有这个词，先 add' }) }
  else {
    const r = addMeme(HOME, { term: m.term, meaning: m.meaning, source: m.source, evidence: m.evidence, aliases: args.slice(1) })
    out(r)
  }
} else {
  out({ ok: false, error: `未知命令 ${cmd}；可用 ls/get/add/del/alias` })
}
