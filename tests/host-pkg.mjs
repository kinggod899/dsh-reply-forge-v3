// 定位宿主 `@deepseek-ai/*` 包（供集成测试用）。
//
// 集成测试要在**真宿主实现**上验证机制（投影、事件词汇表闸门），所以得找到
// 宿主装在哪。机器之间路径不同，因此按「显式环境变量 → 逐级向上找 → 已知安装
// 位置」三级探测；都找不到就 SKIP，不把测试判失败——发行包解开在没有 DSH 的
// 机器上跑时不该红。
//
// 环境变量按包名区分：
//   DSH_SESSION_PKG          → @deepseek-ai/dsh-session
//   DSH_PKG_<NAME>           → 通用（NAME 是包名末段的大写下划线形式，
//                              例：DSH_PKG_SESSION_PERSISTENCE）

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 包名末段 → 环境变量名。`dsh-session-persistence` → `DSH_PKG_SESSION_PERSISTENCE`。 */
function envNameFor(pkg) {
  return 'DSH_PKG_' + pkg.replace(/^dsh-/, '').replace(/-/g, '_').toUpperCase()
}

/** 显式指定（最高优先级）：可以是包目录，也可以是 lib/index.js 本身。 */
function fromEnv(pkg) {
  const names = [envNameFor(pkg), pkg === 'dsh-session' ? 'DSH_SESSION_PKG' : '']
  for (const name of names) {
    if (name === '') continue
    const raw = process.env[name]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const p = path.resolve(raw.trim())
    if (existsSync(p) && statSync(p).isDirectory()) {
      const direct = path.join(p, 'lib', 'index.js')
      if (existsSync(direct)) return direct
      continue
    }
    if (existsSync(p)) return p
  }
  return null
}

/** 从起点逐级向上找 node_modules/@deepseek-ai/<pkg>。 */
function fromAncestors(start, rel) {
  let dir = path.resolve(start)
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, rel)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 本机私有补充根（`tests/host-paths.local.json`，被 *.local.json 规则忽略）。
 *  自己机器上的非标安装位置写这里，**绝不写进仓库**。
 *  形状：{ "roots": ["<DSH安装目录>", ...] } */
function localRoots(here) {
  const p = path.join(here, 'host-paths.local.json')
  if (existsSync(p) === false) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(parsed?.roots) ? parsed.roots.filter(r => typeof r === 'string' && r !== '') : []
  } catch { return [] }
}

/** 已知的 DSH 安装根（Electron 应用布局：<root>/resources/app/dsh/...）。
 *  只列**标准安装位置**；非标安装用 DSH_APP_ROOT / host-paths.local.json 指定
 *  （绝不把某台机器的路径写死进仓库）。
 *  说明：DSH 目前官方只发 win-x64 安装包，后两条 macOS/Linux 路径是**预留**
 *  ——官方出跨平台版时测试能直接接上，现在命中不了也无害。 */
function knownRoots(here) {
  const home = os.homedir()
  const roots = [
    process.env.DSH_APP_ROOT,
    ...localRoots(here),
    path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeekHarness'),
    path.join(home, 'AppData', 'Local', 'DeepSeekHarness'),
    path.join(home, 'AppData', 'Roaming', 'DeepSeekHarness'),
    '/Applications/DeepSeekHarness.app/Contents/Resources',
    '/opt/DeepSeekHarness/resources',
  ]
  return roots.filter(r => typeof r === 'string' && r !== '')
}

/** 在 root 下做深度受限的 DFS，找 resources/app/dsh/node_modules/... 这类布局。 */
function scan(root, rel, maxDepth = 5) {
  const direct = [
    path.join(root, 'resources', 'app', 'dsh', rel),
    path.join(root, 'app', 'dsh', rel),
    path.join(root, 'dsh', rel),
    path.join(root, rel),
  ]
  for (const candidate of direct) if (existsSync(candidate)) return candidate
  if (maxDepth <= 0) return null
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const found = scan(path.join(root, entry.name), rel, maxDepth - 1)
    if (found !== null) return found
  }
  return null
}

/**
 * 解析任意宿主包的入口。
 * @param {string} pkg `@deepseek-ai/` 之后的包名，例：'dsh-session-persistence'
 * @returns {string | null} `lib/index.js` 的绝对路径，找不到返回 null
 */
export function findHostPackage(pkg) {
  const rel = path.join('node_modules', '@deepseek-ai', pkg, 'lib', 'index.js')
  const env = fromEnv(pkg)
  if (env !== null) return env
  const up = fromAncestors(process.cwd(), rel)
  if (up !== null) return up
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const root of knownRoots(here)) {
    if (existsSync(root) === false) continue
    const found = scan(root, rel)
    if (found !== null) return found
  }
  return null
}

/**
 * 解析宿主 `@deepseek-ai/dsh-session` 包入口。
 * @returns {string | null} `lib/index.js` 的绝对路径，找不到返回 null
 */
export function findHostSessionPackage() {
  return findHostPackage('dsh-session')
}

/** 转成 ESM 能 import 的 file:// URL（Windows 下裸绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）。 */
export function toFileUrl(p) {
  return new URL('file://' + (p.startsWith('/') ? '' : '/') + p.replace(/\\/g, '/')).href
}
