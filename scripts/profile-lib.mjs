// dsh profile 静态配置操作库（install / enable / disable 三个脚本共用）。
//
// 为什么所有改动都只碰「静态配置」：dsh 桌面端在启动时读取 profile 的
// package.json 与 cordis.patch.yml 组装插件树；运行期间不再重读。因此
// 改这两个文件 + node_modules 链接就足够，**完全不需要 pnpm install**。
//
// 铁律：本目录下任何脚本都不得调用 pnpm。2026-10-14 的事故根因就是在
// dsh 运行时执行 pnpm install —— 它会重排 node_modules，把正在被宿主
// 加载的模块目录换掉，宿主随即崩在模块解析上。
//
// 零依赖、纯 ESM。

import { readFileSync, writeFileSync, existsSync, copyFileSync, symlinkSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * 本插件在 profile 里的身份（v3 专属，与 v1/v2 完全隔离）。
 *
 * 2026-10-22 起改用 npm 可发布的裸名 `dsh-reply-forge-v3`（原为 `@local/…`）。
 * 裸名的意义：宿主「插件管理器」与 `dsh plugin add` 都按 npm 包名解析，
 * `@local` 是本地 link 的占位 scope，npm 上不可用。本机旧安装由 install.mjs
 * 按 LEGACY_PKG_IDS 自动迁移，不需要手工清理。
 */
export const PKG_ID = 'dsh-reply-forge-v3'
export const PATCH_ID = 'dsh-reply-forge-v3'
export const LINK_NAME = 'dsh-reply-forge-v3'
/** 旧身份（曾以 @local scope 安装）——迁移时按此清理 junction/依赖/bundles/lockfile。 */
export const LEGACY_PKG_IDS = ['@local/dsh-reply-forge-v3']

/**
 * 更早的两代 —— 只在「安装/启用 v3 时顺带把它们从 bundles 摘掉」用到。
 *
 * 三代共用同一块 UI 位置（每条消息上的操作条），同时开会挂出多条操作条。
 * 所以默认只留 v3；依赖与 junction 都保留，随时可以一键开回。
 * v2 是纯落盘路径（要重启才生效），v3 已经把它包成兜底分支，没理由再并存。
 */
export const PREVIOUS = [
  { pkgId: '@local/dsh-reply-forge-v2', patchId: 'dsh-reply-forge-v2', flag: '--keep-v2' },
  { pkgId: '@local/dsh-reply-forge', patchId: 'dsh-reply-forge', flag: '--keep-v1' },
]
/** v1 的 id（兼容旧引用）。 */
export const V1_PKG_ID = '@local/dsh-reply-forge'
export const V1_PATCH_ID = 'dsh-reply-forge'

/** 解析全部相关路径。DSH_HOME / DSH_PROFILE_DIR 可覆盖。 */
export function paths() {
  const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  const PROFILE = process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', 'desktop')
  const NODE_MODULES = join(PROFILE, 'node_modules')
  const LOCAL_DIR = join(NODE_MODULES, '@local')
  // 仓库根：脚本位于 <repo>/scripts/
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    DSH_HOME,
    PROFILE,
    NODE_MODULES,
    LOCAL_DIR,
    REPO_ROOT,
    PKG_JSON: join(PROFILE, 'package.json'),
    PATCH_YML: join(PROFILE, 'cordis.patch.yml'),
    LOCK: join(PROFILE, 'pnpm-lock.yaml'),
    LINK: join(NODE_MODULES, LINK_NAME),
    /** 旧版 junction 位置（@local scope 下），迁移时清理。 */
    LEGACY_LINKS: LEGACY_PKG_IDS.map(id => join(NODE_MODULES, ...id.split('/'))),
    /** package.json / lockfile 里用的 link 目标（正斜杠，与 v1 写法一致）。 */
    LINK_TARGET: REPO_ROOT.split('\\').join('/'),
  }
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export function backup(file, tag) {
  if (existsSync(file) === false) return null
  const dest = file + '.bak-' + tag + '-' + stamp()
  copyFileSync(file, dest)
  return dest
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

/**
 * 检测 dsh 是否在运行 —— 三态，绝不静默 fail-open。
 *
 * `true` 运行中 / `false` 未运行 / `null` 检测失败（未知）。
 * `null` 时调用方必须**大声警告**：把「检测不了」当成「没运行」是这类
 * 工具最危险的默认值。
 *
 * 实现要点：tasklist 在中文 Windows 输出 CP936，用 utf16le 解会得到乱码
 * 匹配不上；这里按字节 `latin1` 解码（ASCII 段不受影响）。也不要用
 * `tasklist /FI ...` —— Git Bash 会把 `/FI` 当路径展开。
 */
export function detectDshRunning() {
  const DSH_EXE = 'DeepSeek Harness.exe'
  const r = spawnSync('tasklist', [], { encoding: 'buffer' })
  if (r.error !== undefined && r.error !== null) {
    return { running: null, detail: 'tasklist 启动失败（' + (r.error.message ?? r.error) + '）' }
  }
  if (r.status !== 0) return { running: null, detail: 'tasklist 退出码 ' + r.status }
  const raw = r.stdout ?? Buffer.alloc(0)
  if (raw.length === 0) return { running: null, detail: 'tasklist 无输出' }
  const hit = new RegExp(DSH_EXE.replace(/\./g, '\\.'), 'i').test(raw.toString('latin1'))
  return { running: hit, detail: '已扫描 tasklist 输出 ' + raw.length + ' 字节' }
}

/** 运行中检测的统一播报；返回是否应提示用户「改完要重启」。 */
export function warnIfRunning(log) {
  const { running, detail } = detectDshRunning()
  if (running === true) {
    log('警告：检测到 DSH 桌面端正在运行。')
    log('      本脚本只改启动时读取的静态配置，不会影响当前会话；')
    log('      但改动要**完全退出并重启 DSH** 后才生效。')
    return true
  }
  if (running === null) {
    log('警告：无法判断 DSH 是否在运行（' + detail + '）。')
    log('      为安全起见，请先完全退出 DSH 再执行本脚本。')
    return true
  }
  log('已确认 DSH 未在运行。')
  return false
}

/** 建立 <node_modules>/<name> → target 的目录 junction（Windows 下无需管理员权限）。 */
export function ensureLink(linkPath, target) {
  if (existsSync(join(linkPath, 'package.json'))) return { ok: true, created: false }
  if (existsSync(target) === false) return { ok: false, created: false, reason: '目标目录不存在：' + target }
  try {
    mkdirSync(dirname(linkPath), { recursive: true })
    // 残留一个坏链接时先清掉
    if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath, 'junction')
    return { ok: true, created: true }
  } catch (err) {
    return { ok: false, created: false, reason: String(err?.message ?? err) }
  }
}

export function removeLink(linkPath) {
  if (existsSync(linkPath) === false) return { ok: true, removed: false }
  try {
    const st = statSync(linkPath)
    rmSync(linkPath, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true })
    return { ok: true, removed: true }
  } catch (err) {
    return { ok: false, removed: false, reason: String(err?.message ?? err) }
  }
}

// ── cordis.patch.yml ────────────────────────────────────────────────────────
// 只做「删掉以某个 id 命名的整条条目」这一件事：条目从 `- id: X` 起，
// 到下一个顶层 `- ` 行为止。不做 YAML 解析——保住注释与原始格式。

/** 该 patch 文件里是否存在以 id 命名的条目。 */
export function hasPatchEntry(raw, id) {
  return new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + escapeRe(id) + '[\'"]?\\s*$', 'm').test(raw)
}

/** 移除以 id 命名的条目，返回 { text, removed }。 */
export function removePatchEntry(raw, id) {
  const lines = raw.split(/\r?\n/)
  const head = new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + escapeRe(id) + '[\'"]?\\s*$')
  const kept = []
  let skipping = false
  let removed = 0
  for (const line of lines) {
    if (head.test(line)) { skipping = true; removed += 1; continue }
    if (skipping && /^\s*-\s+\S/.test(line)) skipping = false
    if (skipping === false) kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── pnpm-lock.yaml ─────────────────────────────────────────────────────────
// 手工登记一条 link: 依赖。**不跑 pnpm**。
//
// 为什么必须登记：lockfile 是 pnpm 的对账依据。若 package.json 里有而
// lockfile 里没有，将来任何一次 pnpm install 都会把这条 link 判为「多余」
// 并删掉，插件随之失效。手工补条目是最省事且完全无副作用的做法。

export function ensureLockEntry(lockPath, name, specifier) {
  if (existsSync(lockPath) === false) return { changed: false, reason: 'lockfile 不存在' }
  const raw = readFileSync(lockPath, 'utf8')
  if (raw.includes("'" + name + "':") || raw.includes('"' + name + '":')) {
    return { changed: false, reason: '已登记' }
  }
  const lines = raw.split('\n')
  const depIdx = lines.findIndex(l => l === '    dependencies:')
  if (depIdx < 0) return { changed: false, reason: '未找到 importer 的 dependencies 段' }
  let at = depIdx + 1
  while (at < lines.length) {
    const l = lines[at]
    if (/^ {4}\S/.test(l)) break              // 回到上一级缩进 → 段结束
    if (/^ {6}\S/.test(l) === false) { at += 1; continue }  // 8 空格续行
    const m = l.match(/^ {6}'?([^':]+)'?:$/)
    if (m !== null && m[1] > name) break      // 按字母序插入
    at += 1
  }
  lines.splice(at, 0,
    "      '" + name + "':",
    '        specifier: ' + specifier,
    '        version: ' + specifier,
  )
  return { changed: true, text: lines.join('\n') }
}

/**
 * 从 lockfile 里删掉一条 link 依赖（迁移旧包名用）。
 *
 * key 的三种写法都要认：`'@scope/name':` / `"@scope/name":` / `name:`（裸名
 * pnpm 通常不加引号）。命中后连同其 8 空格续行（specifier / version）一起删。
 */
export function removeLockEntry(lockPath, name) {
  if (existsSync(lockPath) === false) return { changed: false, reason: 'lockfile 不存在' }
  const raw = readFileSync(lockPath, 'utf8')
  const lines = raw.split('\n')
  const forms = new Set([
    "      '" + name + "':",
    '      "' + name + '":',
    '      ' + name + ':',
  ])
  const kept = []
  let removed = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (forms.has(lines[i]) === false) { kept.push(lines[i]); continue }
    removed += 1
    while (i + 1 < lines.length && /^ {8}\S/.test(lines[i + 1])) i += 1
  }
  if (removed === 0) return { changed: false, reason: '未登记' }
  return { changed: true, text: kept.join('\n'), removed }
}

// ── 安装后自检 ──────────────────────────────────────────────────────────────

export function verify(p, log) {
  const checks = []
  checks.push([PKG_ID + ' junction 就位', existsSync(join(p.LINK, 'package.json'))])
  let lockOk = false
  try { lockOk = readFileSync(p.LOCK, 'utf8').includes("'" + PKG_ID + "':") } catch { /* 忽略 */ }
  checks.push(['lockfile 已登记', lockOk])
  let clientOk = false
  try {
    const pkg = readJson(join(p.LINK, 'package.json'))
    const rel = pkg?.exports?.['./client']
    clientOk = typeof rel === 'string' && existsSync(join(p.LINK, rel.replace('./', '').split('/').join('\\')))
  } catch { /* 忽略 */ }
  checks.push(['client.js 产物可解析', clientOk])
  let nodeOk = false
  try { nodeOk = existsSync(join(p.LINK, '.dsh-plugin', 'index.mjs')) } catch { /* 忽略 */ }
  checks.push(['host half（.dsh-plugin/index.mjs）存在', nodeOk])
  let bad = 0
  for (const [label, ok] of checks) {
    log('    ' + (ok ? '[OK]   ' : '[缺失] ') + label)
    if (ok === false) bad += 1
  }
  return bad
}
