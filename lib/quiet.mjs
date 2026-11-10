/**
 * lib/quiet.mjs —— 挑一个「不申请控制台」的 node 解释器
 * ============================================================================
 * 为什么要有它（2026-10-29 实测踩坑，别删这段注释）：
 *   Windows 上 `spawn(..., { windowsHide: true })` 压不住控制台窗口。
 *   只要 exe 的 PE Subsystem 是 3(Console)，而且当前进程没有控制台可继承，
 *   Win11 就会把它交给 Windows Terminal 托管 —— 屏幕上直接画出一个黑框，
 *   标题就是那个 exe 的完整路径。全屏游戏会被强行最小化。
 *   `CREATE_NO_WINDOW`、`ShowWindow: 0`、`windowsHide: true` 全都没用。
 *
 *   唯一的确定解：换成 PE Subsystem = 2(GUI) 的同一个程序副本 ——
 *   它压根不申请控制台，就不会有窗口；带管道时 stdio 照常工作
 *   （已实测：stdout / stderr / stdin / argv 全通）。
 *
 * 已知副本（E:\_bot\bin\）：
 *   nodew.exe             ← WinGet node-v24.20.0\node.exe，改 0x5C 处 3→2
 *   nodew-snowluma.exe    ← E:\_bot\snowluma\node.exe
 *   ollamaw.exe           ← E:\_bot\ollama\ollama.exe
 *
 * ⚠ 反过来：`python.exe`(3) → `pythonw.exe`(2) 是官方自带的，不需要造副本。
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BIN_DIR = 'E:\\_bot\\bin'

/** 逐个试，第一个存在的就是它；全没有返回空串（调用方退回 process.execPath）。 */
const firstExisting = (cands) => {
  for (const p of cands) {
    if (!p) continue
    try { if (existsSync(p)) return p } catch { /* 看下一个 */ }
  }
  return ''
}

/**
 * 无控制台的 node 副本路径。可用环境变量 `DOUYIN_NODEW` 覆盖（指到别的副本）。
 * 空串 = 本机没有副本，只能用 process.execPath（会弹窗但能跑）。
 */
export const NODEW = firstExisting([
  String(process.env.DOUYIN_NODEW || '').trim(),
  join(BIN_DIR, 'nodew.exe'),
])

/**
 * 该用哪个 exe 去跑 tools/*.mjs。
 * 有副本用副本；没有就退回 `process.execPath`（保留原行为，不制造新故障）。
 */
export const nodeRunner = () => NODEW || process.execPath

/**
 * 在 PATH 里找某个可执行文件的完整路径 —— 纯 JS 实现，不 spawn `where`。
 *
 * ⚠️ 为什么不能用 `spawnSync('where', ...)`：where.exe 自身也是 Console 子系统
 *    （已实测：无控制台父进程下 spawn 它必弹 Windows Terminal 窗口）。
 *    同理，`which`、`whereis` 这些 shell 工具全都有同样问题。
 *    查 PATH 这种事在 JS 里做成本极低，没有任何理由去起进程。
 *
 * @param {string} name 不带扩展名，如 'node' / 'dsh' / 'git'
 * @returns {string} 完整路径；找不到返回空串
 */
export const whichInPath = (name) => {
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try { if (existsSync(p)) return p } catch { /* 下一个 */ }
    }
    // 已经带扩展名的调用（比如传 'node.exe'）也支持
    const direct = join(dir, name)
    try { if (existsSync(direct) && /\.[A-Za-z0-9]+$/.test(name)) return direct } catch { /* 下一个 */ }
  }
  return ''
}
