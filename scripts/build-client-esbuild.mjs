// C 方案：用 esbuild 构建客户端（scripts/build-client-esbuild.mjs）。
//
// 与 `build-client.mjs`（自研 ESM→CJS 内联器）的关系：
//   · 二者产出的模块**行为等价**——2026-10-19 实测：esbuild 产物跑
//     `tests/client.test.mjs` 57/57 全过，导出的 { name, inject, apply } 与
//     现产物一致；
//   · 本脚本**默认不覆盖** `.dsh-plugin/client.js`，只把预览产物写到
//     `.dsh-plugin/client.esbuild.js` 并打印差异。要真正切换才加 `--write`。
//
// 为什么默认不覆盖：发布链（build-release.mjs → install.mjs → profile-lib.mjs）
// 有三处按固定路径校验产物，静默换构建器会让这些检查失去意义。切换应当是一次
// 显式决定，而不是一次手滑。
//
// 用法：
//   node scripts/build-client-esbuild.mjs            # 预览：写 client.esbuild.js
//   node scripts/build-client-esbuild.mjs --write    # 覆盖 client.js（之后必须重跑测试）
//   node scripts/build-client-esbuild.mjs --check    # 只算不写，报告体积差
//
// 依赖：优先用仓库内 node_modules/.bin/esbuild；没有则退回 `npx --yes esbuild`
// （首次会联网下载，之后走 npm 缓存）。构建期依赖，不进运行时产物。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, '.dsh-plugin', 'client', 'index.mjs')
const OUTPUT = join(ROOT, '.dsh-plugin', 'client.js')
const PREVIEW = join(ROOT, '.dsh-plugin', 'client.esbuild.js')
// 临时产物放在仓库内、且用**相对路径**传给 esbuild：Windows 上 cmd 的代码页
// 是 936，命令行里出现中文绝对路径会乱码（本项目 bat 房规踩过同款坑）。
// cwd 由 Node 设置，不受命令行编码影响。
const TMP_REL = '.dsh-plugin/.esbuild-tmp.cjs'
const TMP = join(ROOT, TMP_REL)
const ENTRY_REL = '.dsh-plugin/client/index.mjs'
const PLUGIN_ID = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

const write = process.argv.includes('--write')
const checkOnly = process.argv.includes('--check')

// ── 1. 调 esbuild 打 CJS bundle ────────────────────────────────────────────
const localBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
const useLocal = existsSync(localBin)
const bin = useLocal ? localBin : (process.platform === 'win32' ? 'npx.cmd' : 'npx')
const prefix = useLocal ? [] : ['--yes', 'esbuild']
// Node 20+ 在 Windows 上禁止直接 spawn .cmd/.bat（CVE-2024-27980），必须过 shell。
const useShell = process.platform === 'win32' && useLocal === false
execFileSync(bin, [
  ...prefix, ENTRY_REL,
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--legal-comments=none',
  '--outfile=' + TMP_REL,
], { cwd: ROOT, stdio: 'inherit', shell: useShell })

// ── 2. 包进宿主的 __ModuleLoader__ 契约（与 build-client.mjs 同构）─────────
// esbuild 的 CJS 产物末尾是 `module.exports = __toCommonJS(index_exports)`，
// 它**重新赋值** module.exports；factory 里 return 的是新对象，所以没问题。
// 但 `var exports = module.exports` 拿到的是旧空对象——esbuild 不会往里写，
// 故不冲突。若将来换 `--format=iife`，这段包装需要重写。
const body = readFileSync(TMP, 'utf8')
const code = 'window.__ModuleLoader__.load({\n'
  + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
  + '\tfactory: (require) => {\n'
  + '\t\tvar module = { exports: {} };\n'
  + '\t\tvar exports = module.exports;\n'
  + body.replace(/\n$/, '')
  + '\n\t\treturn module.exports;\n'
  + '\t}\n'
  + '});\n'

// ── 3. 自检：语法有效 + 三件套齐备（缺一等于插件没装）────────────────────
new Function('window', code)
const mods = {}
const win = { __ModuleLoader__: { load: ({ id, factory }) => { mods[id] = factory(() => { throw new Error('no require') }) } } }
new Function('window', code)(win)
const exported = mods[PLUGIN_ID] ?? {}
const missing = ['name', 'inject', 'apply'].filter(k => exported[k] === undefined)
if (missing.length > 0) {
  console.error('[build-esbuild] 自检失败：缺导出 ' + missing.join(', '))
  rmSync(TMP, { force: true })
  process.exit(1)
}

// ── 4. 落盘 / 预览 ────────────────────────────────────────────────────────
const bytes = Buffer.byteLength(code)
const currentBytes = existsSync(OUTPUT) ? statSync(OUTPUT).size : 0
const target = write ? OUTPUT : PREVIEW
if (!checkOnly) writeFileSync(target, code)
rmSync(TMP, { force: true })

console.log('[build-esbuild] 产物 ' + (bytes / 1024).toFixed(1) + ' KiB / '
  + code.split('\n').length + ' 行；现产物 ' + (currentBytes / 1024).toFixed(1) + ' KiB')
console.log('[build-esbuild] 导出：' + JSON.stringify(Object.keys(exported))
  + '  inject=' + JSON.stringify(exported.inject))
if (checkOnly) {
  console.log('[build-esbuild] --check：未写任何文件')
} else if (write) {
  console.log('[build-esbuild] 已覆盖 ' + OUTPUT)
  console.log('[build-esbuild] 下一步必做：node tests/client.test.mjs（57 项）+ node scripts/build-client.mjs --check')
} else {
  console.log('[build-esbuild] 预览已写 ' + PREVIEW + '（主产物未动）')
  console.log('[build-esbuild] 要切换：加 --write，然后重跑测试')
}
