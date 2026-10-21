// 首次安装 dsh-reply-forge-v3 到 dsh 桌面端 profile。
//
// 使用时机：关掉 DSH 后，双击仓库根的「安装插件.bat」，
// 或在任意终端执行：node scripts/install.mjs [--keep-v1]
//
// 它按顺序做六件事，失败即停并说明原因：
//  1. 检测 dsh 是否在运行（只警告不阻止）；
//  2. 建 node_modules/dsh-reply-forge-v3 → 本仓库 的 junction
//     （并清掉旧版 @local/dsh-reply-forge-v3 的链接与配置条目）；
//  3. package.json：写入 dependencies 并加入 dsh.profile.bundles；
//  4. pnpm-lock.yaml：手工登记 link 条目（**不跑 pnpm**）；
//  5. cordis.patch.yml：清掉两个插件可能残留的 disabled 条目；
//  6. 自检：链接 / lockfile / client.js / host half 四项。
//
// **只在真的要写某个文件时才给它做备份**，所以重复执行本脚本不会
// 在 profile 目录里堆垃圾。所有改动都是幂等的。
//
// 三代共用同一块 UI 位置（每条消息上的操作条），同时开会挂出多条操作条，
// 所以默认把更早的两代（v2 落盘版、v1 仅本机渲染版）从 bundles 里摘掉，
// 但**保留它们的依赖与 junction**，随时可以用它们自己的「启用插件.bat」开回。
// 想并存做对比：加 --keep-v2 / --keep-v1。
//
// 回滚：运行「关闭插件.bat」（停用 v3），或从 .bak-install-* 还原配置。

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import {
  paths, PKG_ID, PATCH_ID, PREVIOUS, LEGACY_PKG_IDS,
  warnIfRunning, backup, readJson, writeJson, ensureLink, removePatchEntry,
  ensureLockEntry, removeLockEntry, removeLink, verify,
} from './profile-lib.mjs'

const argv = process.argv.slice(2)
// 默认关掉更早的两代。
const keep = new Set(PREVIOUS.filter(x => argv.includes(x.flag)).map(x => x.pkgId))

const log = (...a) => console.log('[install]', ...a)
const fail = msg => { console.error('[install] 失败：' + msg); process.exit(1) }
const base = f => f.split(/[\\/]/).pop()

const p = paths()
log('profile：' + p.PROFILE)
log('仓库：  ' + p.REPO_ROOT)

warnIfRunning(log)

// ── 1. junction ────────────────────────────────────────────────────────────
log('步骤 1/4 建立链接')
const link = ensureLink(p.LINK, p.REPO_ROOT)
if (link.ok === false) fail('创建链接失败：' + link.reason)
log(link.created ? '  已链接 ' + p.LINK : '  已存在，跳过')

// 旧身份（@local scope）的 junction 必须清掉：留着会变成 node_modules 里
// 两份插件代码 → 宿主同时挂出两条操作条（三代共用同一块 UI 位置的老坑）。
for (const oldLink of p.LEGACY_LINKS) {
  const r = removeLink(oldLink)
  if (r.removed) log('  已移除旧身份链接 ' + oldLink)
}

// 已经是 npm 安装（node_modules 里是真实目录，不指向本仓库）→ 绝不覆盖成 link：
// 否则 profile 的 dependencies 会被改写成 "link:<仓库路径>"，npm 装的那份
// 下次 pnpm 解析时会被判成不一致。
let linkedToRepo = false
try { linkedToRepo = realpathSync(p.LINK) === realpathSync(p.REPO_ROOT) } catch { linkedToRepo = false }
if (linkedToRepo === false) {
  log('检测到 ' + PKG_ID + ' 已是 npm 安装（真实目录），不做链接覆盖。')
  log('如需改成仓库开发态，先卸载：dsh plugin --profile desktop remove ' + PKG_ID)
  process.exit(0)
}

// ── 2. package.json（先在内存里算出改动） ──────────────────────────────────
log('步骤 2/4 写入 package.json')
if (existsSync(p.PKG_JSON) === false) fail('未找到 ' + p.PKG_JSON)
const pkg = readJson(p.PKG_JSON)
if (pkg.dependencies === undefined || pkg.dependencies === null) pkg.dependencies = {}
const bundles = pkg?.dsh?.profile?.bundles
if (Array.isArray(bundles) === false) fail('package.json 缺少 dsh.profile.bundles 数组')

let pkgChanged = false
for (const legacy of LEGACY_PKG_IDS) {
  if (legacy in pkg.dependencies) {
    delete pkg.dependencies[legacy]
    pkgChanged = true
    log('  已从 dependencies 移除旧身份 ' + legacy)
  }
  const at = bundles.indexOf(legacy)
  if (at !== -1) {
    bundles.splice(at, 1)
    pkgChanged = true
    log('  已从 bundles 移除旧身份 ' + legacy)
  }
}
if (pkg.dependencies[PKG_ID] !== 'link:' + p.LINK_TARGET) {
  pkg.dependencies[PKG_ID] = 'link:' + p.LINK_TARGET
  pkgChanged = true
  log('  dependencies 已写入 ' + PKG_ID)
}
if (bundles.includes(PKG_ID) === false) {
  bundles.push(PKG_ID)
  pkgChanged = true
  log('  bundles 已加入 ' + PKG_ID)
}
for (const prev of PREVIOUS) {
  if (keep.has(prev.pkgId)) continue
  const at = bundles.indexOf(prev.pkgId)
  if (at === -1) continue
  bundles.splice(at, 1)
  pkgChanged = true
  log('  已从 bundles 摘掉 ' + prev.pkgId + '，依赖与链接保留，可一键开回')
}
if (pkgChanged) {
  const b = backup(p.PKG_JSON, 'install')
  writeJson(p.PKG_JSON, pkg)
  log('  已写入（备份 ' + base(b) + '）')
} else {
  log('  已是最新，跳过')
}

// ── 3. lockfile ────────────────────────────────────────────────────────────
log('步骤 3/4 登记 lockfile（不执行 pnpm）')
const lock = ensureLockEntry(p.LOCK, PKG_ID, 'link:' + p.LINK_TARGET)
if (lock.changed) {
  const b = backup(p.LOCK, 'install')
  writeFileSync(p.LOCK, lock.text)
  log('  已手工登记 ' + PKG_ID + '（备份 ' + base(b) + '）')
} else {
  log('  ' + lock.reason)
}
// 旧身份的 lockfile 条目同样要删：留着会让 pnpm 认为 @local 那条仍然需要，
// 下次 install 时重建一份指向本仓库的第二份链接。
for (const legacy of LEGACY_PKG_IDS) {
  const r = removeLockEntry(p.LOCK, legacy)
  if (r.changed) {
    const b = backup(p.LOCK, 'install')
    writeFileSync(p.LOCK, r.text)
    log('  已从 lockfile 移除旧身份 ' + legacy + '（备份 ' + base(b) + '）')
  }
}

// ── 4. cordis.patch.yml ────────────────────────────────────────────────────
log('步骤 4/4 清理 cordis.patch.yml 的 disabled 条目')
if (existsSync(p.PATCH_YML)) {
  const raw = readFileSync(p.PATCH_YML, 'utf8')
  let next = raw
  const r2 = removePatchEntry(next, PATCH_ID)
  if (r2.removed > 0) { next = r2.text; log('  已移除 ' + r2.removed + ' 条 ' + PATCH_ID) }
  for (const prev of PREVIOUS) {
    if (keep.has(prev.pkgId)) continue
    const r = removePatchEntry(next, prev.patchId)
    if (r.removed > 0) { next = r.text; log('  已移除 ' + r.removed + ' 条 ' + prev.patchId + ' 的 disabled 条目') }
  }
  if (next !== raw) {
    const b = backup(p.PATCH_YML, 'install')
    writeFileSync(p.PATCH_YML, next)
    log('  已写入（备份 ' + base(b) + '）')
  } else {
    log('  无需改动')
  }
} else {
  log('  未找到 cordis.patch.yml，跳过')
}

// ── 自检 ───────────────────────────────────────────────────────────────────
log('自检')
const bad = verify(p, log)
console.log('')
if (bad > 0) fail('有 ' + bad + ' 项未就位，请检查上面的输出；可从 .bak-install-* 还原配置')
console.log('安装就绪。请完全退出 DSH 后重新启动，插件才会加载。')
console.log('若启动异常，运行「关闭插件.bat」一键回滚。')
