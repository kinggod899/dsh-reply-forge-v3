// 一键关闭 dsh-reply-forge-v3。崩溃后无法进 UI 时，直接双击运行或在终端执行：
//   node scripts/disable.mjs            # 停用（保留链接与依赖，可秒开回来）
//   node scripts/disable.mjs --purge    # 彻底卸载（连依赖、链接、lockfile 条目一起删）
//
// 默认只做「停用」：把插件从 bundles 摘掉、清掉它的 disabled 条目。
// 链接和 lockfile 条目**保留**，所以再次启用不需要任何安装动作。
//
// 两种模式都不碰覆盖数据（localStorage 里的 dsh-reply-forge-v3:* 键），
// 也不碰其它插件。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  paths, PKG_ID, PATCH_ID,
  warnIfRunning, backup, readJson, writeJson, removePatchEntry, removeLink,
} from './profile-lib.mjs'

const purge = process.argv.slice(2).includes('--purge')
const log = (...a) => console.log('[disable]', ...a)

const p = paths()
warnIfRunning(log)

// 1. package.json
if (existsSync(p.PKG_JSON)) {
  const pkg = readJson(p.PKG_JSON)
  let changed = false
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const next = bundles.filter(b => b !== PKG_ID)
    if (next.length !== bundles.length) { pkg.dsh.profile.bundles = next; changed = true; log('已从 bundles 摘掉 ' + PKG_ID) }
  }
  if (purge && pkg.dependencies !== undefined && pkg.dependencies !== null && PKG_ID in pkg.dependencies) {
    delete pkg.dependencies[PKG_ID]
    changed = true
    log('已从 dependencies 删除 ' + PKG_ID)
  }
  if (changed) {
    const b = backup(p.PKG_JSON, 'disable')
    writeJson(p.PKG_JSON, pkg)
    log('package.json 已更新（备份 ' + b + '）')
  } else {
    log('package.json 无需改动')
  }
}

// 2. cordis.patch.yml
if (existsSync(p.PATCH_YML)) {
  const raw = readFileSync(p.PATCH_YML, 'utf8')
  const r = removePatchEntry(raw, PATCH_ID)
  if (r.removed > 0) {
    const b = backup(p.PATCH_YML, 'disable')
    writeFileSync(p.PATCH_YML, r.text)
    log('cordis.patch.yml 已移除 ' + r.removed + ' 条（备份 ' + b + '）')
  } else {
    log('cordis.patch.yml 无本插件条目，跳过')
  }
}

// 3. lockfile 条目（仅 --purge）
if (purge && existsSync(p.LOCK)) {
  const raw = readFileSync(p.LOCK, 'utf8')
  const lines = raw.split('\n')
  const key = "      '" + PKG_ID + "':"
  const at = lines.indexOf(key)
  if (at >= 0) {
    let end = at + 1
    while (end < lines.length && /^ {8}/.test(lines[end])) end += 1
    lines.splice(at, end - at)
    const b = backup(p.LOCK, 'disable')
    writeFileSync(p.LOCK, lines.join('\n'))
    log('pnpm-lock.yaml 已移除条目（备份 ' + b + '）')
  } else {
    log('pnpm-lock.yaml 无本插件条目，跳过')
  }
}

// 4. junction（仅 --purge）
if (purge) {
  const r = removeLink(p.LINK)
  log(r.ok ? (r.removed ? '已删除链接 ' + p.LINK : '链接不存在，跳过') : '删除链接失败：' + r.reason)
} else {
  log('保留链接与 lockfile 条目（再次启用无需安装）')
}

log('完成。请完全退出并重启 DSH 桌面端。')
