// 一键启用 dsh-reply-forge-v3（在已安装的前提下）。
//
// 使用时机：任何时候。双击仓库根的「启用插件.bat」，
// 或在任意终端执行：node scripts/enable.mjs
//
// 与「安装插件.bat」的区别：本脚本不建链接、不写 lockfile，只做两件
// 启动时读取的静态配置改动 —— 把插件加回 bundles、清掉它的 disabled 条目。
//
// 注意：三代共用同一块 UI 位置（每条消息上的操作条），同时开会挂出多条。
// 本脚本默认把更早的两代（v2 落盘版、v1 仅本机渲染版）从 bundles 摘掉，
// 但保留它们的依赖与链接。想并存做对比：加 --keep-v2 / --keep-v1。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  paths, PKG_ID, PATCH_ID, PREVIOUS,
  warnIfRunning, backup, readJson, writeJson, removePatchEntry, verify,
} from './profile-lib.mjs'

const argv = process.argv.slice(2)
const keep = new Set(PREVIOUS.filter(x => argv.includes(x.flag)).map(x => x.pkgId))

const log = (...a) => console.log('[enable]', ...a)
const fail = msg => { console.error('[enable] 失败：' + msg); process.exit(1) }

const p = paths()
warnIfRunning(log)

// package.json：dependencies 必须已在位（否则说明没装过）
const pkgPath = p.PKG_JSON
if (existsSync(pkgPath) === false) fail('未找到 ' + pkgPath)
const pkg = readJson(pkgPath)
const bundles = pkg?.dsh?.profile?.bundles
if (Array.isArray(bundles) === false) fail('package.json 缺少 dsh.profile.bundles 数组')
if (typeof pkg?.dependencies?.[PKG_ID] !== 'string') {
  fail('dependencies 缺少 ' + PKG_ID + '：请先运行「安装插件.bat」')
}

let changed = false
if (bundles.includes(PKG_ID) === false) { bundles.push(PKG_ID); changed = true; log('bundles 已加入 ' + PKG_ID) }
else log('bundles 已包含 ' + PKG_ID + '，跳过')

for (const prev of PREVIOUS) {
  if (keep.has(prev.pkgId)) continue
  const at = bundles.indexOf(prev.pkgId)
  if (at === -1) continue
  bundles.splice(at, 1)
  changed = true
  log('已从 bundles 摘掉 ' + prev.pkgId)
}
if (changed) {
  const b = backup(pkgPath, 'enable')
  writeJson(pkgPath, pkg)
  log('package.json 已更新（备份 ' + b + '）')
}

// cordis.patch.yml：清掉两个插件的 disabled 条目
if (existsSync(p.PATCH_YML)) {
  let raw = readFileSync(p.PATCH_YML, 'utf8')
  const r2 = removePatchEntry(raw, PATCH_ID)
  if (r2.removed > 0) { raw = r2.text; log('已移除 ' + r2.removed + ' 条 ' + PATCH_ID + ' disabled 条目') }
  for (const prev of PREVIOUS) {
    if (keep.has(prev.pkgId)) continue
    const r = removePatchEntry(raw, prev.patchId)
    if (r.removed > 0) { raw = r.text; log('已移除 ' + r.removed + ' 条 ' + prev.patchId + ' disabled 条目') }
  }
  writeFileSync(p.PATCH_YML, raw)
}

log('自检')
const bad = verify(p, log)
console.log('')
if (bad > 0) fail('有 ' + bad + ' 项未就位：请先完全退出 DSH，再运行「安装插件.bat」')
console.log('启用就绪。请完全退出并重启 DSH 桌面端加载插件。')
console.log('若启动异常，运行「关闭插件.bat」一键回滚。')
