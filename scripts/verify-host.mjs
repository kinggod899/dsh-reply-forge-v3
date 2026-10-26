// DSH 升级自检（scripts/verify-host.mjs）——PLAN §9.2 ① 的落地。
//
// 动机：v3 的全部机制都架在宿主的契约面上（事件词汇表、projection 按类型精确
// 匹配、持久化闸门、v3→v4 迁移行为）。宿主升一次级，任何一条静默变化都会让
// 插件「看起来还在、其实失效」——v3→v4 迁移把 reply-forge/patch 改名成
// plugin:reply-forge/patch 就是这么发现的（PLAN §9.1）。所以宿主升级后必须
// 有一把「用宿主的尺子量宿主」的刷子，这就是本脚本。
//
// 分层（T0/T1/T2 全部只读，不起写；T3 委托的活体探针除外，见其自身说明）：
//   T0 宿主定位与版本基线：解析宿主安装（复用 tests/host-pkg.mjs 三级解析），
//      读 desktop-runtime.json 与关键包版本，与仓库内 host-baseline.json
//      （发布时钉住的 known-good）比对；不一致 → WARN。附带校验 app.asar
//      可按既有配方提取（JSON 头 + 数据区 + dsh 子树）——诊断工具自身的依赖。
//   T1 契约面（import 提取树的宿主包，不起进程）：导出面 / KNOWN 事件类型 /
//      registerMessageProjection / append 接受 surfaceOp / 未知类型直通 /
//      持久化闸门正负对照 / 读侧双类型接受 / 投影注册面；并**强制跑**宿主门控
//      测试套件（projection/persistence/ignorable/migration-rename）——
//      **缺宿主 = FAIL**（这正是 SKIP 机制在发行包与开发机之间的语义差）。
//   T2 boot 冒烟（--boot，复用 host-oracle 配方）：slim host 起得来、RPC 通、
//      会话读得到。
//   T3 活体 CDP（--live，委托 scripts/diag-focus.mjs）：真宿主 + 无头 Edge。
//
// 用法：
//   node scripts/verify-host.mjs                # T0 + T1
//   node scripts/verify-host.mjs --boot         # + T2
//   node scripts/verify-host.mjs --live         # + T3（会往活会话写一条 patch）
//   node scripts/verify-host.mjs --extract      # 先把 app.asar 提取到缓存目录
//   node scripts/verify-host.mjs --json         # 机器可读输出
//   npm run verify-host
// 退出码：有 FAIL → 1；仅 WARN → 0。
//
// 路径纪律：宿主安装位置因机器而异，一律走环境变量 / tests/host-pkg.mjs 的
// 三级解析 / 本地私有配置，**绝不写死本机路径**。

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, copyFileSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findHostPackage, toFileUrl, knownInstallRoots } from '../tests/host-pkg.mjs'
import { anchorRequire } from '../src/checkout.mjs'
import { PATCH_EVENT_TYPE, isPatchEventType, buildPatchData } from '../src/patch-event.mjs'
import { patchProjections } from '../.dsh-plugin/server/patch.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 纯逻辑（导出供 tests/verify-host.test.mjs 单测，不起宿主） ──────────

/** 读仓库内宿主基线；缺段/坏 JSON 一律抛（调用方转成 FAIL）。 */
export function loadBaseline(repoRoot) {
  const file = path.join(repoRoot, 'host-baseline.json')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`找不到 ${file}（基线文件必须随仓库分发）`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`host-baseline.json 不是合法 JSON：${String(error.message)}`)
  }
  for (const key of ['host', 'packages', 'contract', 'hostGatedTestSuites']) {
    if (parsed[key] === undefined) throw new Error(`host-baseline.json 缺少 "${key}" 段`)
  }
  return parsed
}

/**
 * 判定宿主「活会话」折叠时用的是注册表投影（`this.projections`，含插件注册的）
 * 还是冷读那份**硬编码**列表（`currentSessionMessageProjections`）。
 *
 * 为什么要这一项（2026-10-26 BUG-7 实证）：宿主的冷读路径
 * （`dsh-session-query` 折叠、`dsh-session-persistence-jsonl` 的 readStoredLog）
 * 用 `currentSessionMessageProjections = [imageOffloadProjection]`——插件投影进不去，
 * 所以「刷新后界面回原文」是宿主设计、插件无解。但**模型侧采信**靠的是活会话
 * （`SessionStore.prepare` → `this.projections`）。万一哪天宿主把活会话也换成
 * 硬编码列表，伪造就再也不会被下位模型看到，而且**不报错**——这条检查是报警器。
 *
 * 只做字符串判定（构造带 cordis ctx 的 SessionStore 成本过高）；结构变化时
 * 退回 WARN 交人工复核，不误报 FAIL。
 *
 * @param {string} src 宿主 dsh-session 的源码文本（lib/types/index.js + lib/index.js）
 * @returns {{level:'PASS'|'FAIL'|'WARN', detail:string}}
 */
export function judgeLiveSessionProjectionSource(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    return { level: 'WARN', detail: '读不到 dsh-session 源码，无法静态核验活会话投影来源——请人工确认 SessionStore.prepare 仍传 this.projections' }
  }
  const calls = [...src.matchAll(/Session\.fromRestore\([^;]{0,400}/g)].map(m => m[0])
  if (calls.length === 0) {
    return { level: 'WARN', detail: '源码里没找到 Session.fromRestore 调用（结构可能已改），请人工确认活会话投影来源' }
  }
  const hardcoded = calls.filter(c => c.includes('currentSessionMessageProjections'))
  if (hardcoded.length > 0) {
    return {
      level: 'FAIL',
      detail: `活会话恢复改用了硬编码投影列表（currentSessionMessageProjections）——插件投影不再参与折叠，模型侧不再采信伪造。必须适配（见 CHANGELOG v3.4.2 / PLAN §9）`,
    }
  }
  const registered = calls.filter(c => c.includes('this.projections'))
  if (registered.length === 0) {
    return { level: 'WARN', detail: `Session.fromRestore 有 ${calls.length} 处调用但没看到 this.projections，请人工确认投影来源` }
  }
  return { level: 'PASS', detail: `活会话恢复用注册表投影（this.projections，${registered.length} 处），硬编码冷读列表未侵入` }
}

/** semver 三元组（认 x.y.z 前缀）；认不出返回 null。 */
function semverTuple(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value))
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 版本比对：相等 → match；否则 drift（附「宿主较基线新/旧」提示）。 */
export function compareVersion(actual, expected) {
  if (actual === expected) return { status: 'match', detail: String(actual) }
  const a = semverTuple(actual)
  const e = semverTuple(expected)
  let hint = ''
  if (a !== null && e !== null) {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== e[i]) { hint = a[i] > e[i] ? '（宿主较基线新）' : '（宿主较基线旧）'; break }
    }
  }
  return { status: 'drift', detail: `实际 ${actual ?? '（缺失）'} ≠ 基线 ${expected}${hint}` }
}

/**
 * 解析 asar 的 JSON 头：indexOf 定位 + 花括号配平（不依赖写死偏移）。
 * @returns {{jsonStart: number, jsonEnd: number, tree: object}}
 */
export function parseAsarHeader(buf) {
  const jsonStart = buf.indexOf('{"files"')
  if (jsonStart < 0) throw new Error('找不到 asar JSON 头（indexOf 落空）')
  let depth = 0
  let jsonEnd = -1
  let inStr = false
  let esc = false
  for (let i = jsonStart; i < buf.length; i += 1) {
    const c = buf[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === 0x5c) esc = true
      else if (c === 0x22) inStr = false
      continue
    }
    if (c === 0x22) inStr = true
    else if (c === 0x7b) depth += 1
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) { jsonEnd = i + 1; break }
    }
  }
  if (jsonEnd < 0) throw new Error('asar JSON 头花括号配平失败')
  const tree = JSON.parse(buf.toString('utf8', jsonStart, jsonEnd).replace(/\0+$/, ''))
  if (tree === null || typeof tree !== 'object' || tree.files === null || typeof tree.files !== 'object') {
    throw new Error('asar JSON 头缺少 files 树')
  }
  return { jsonStart, jsonEnd, tree }
}

/** 展开文件条目；prefix 给定时只留该前缀（asar 里目录不是条目，只有文件带 offset/size）。 */
export function collectAsarFiles(tree, prefix) {
  const files = []
  const walk = (dir, rel) => {
    for (const [name, entry] of Object.entries(dir)) {
      const childRel = rel === '' ? name : rel + '/' + name
      if (entry.files !== undefined) walk(entry.files, childRel)
      else if (entry.offset !== undefined && entry.size !== undefined) {
        files.push({ rel: childRel, offset: Number(entry.offset), size: Number(entry.size) })
      }
    }
  }
  walk(tree.files, '')
  return prefix === undefined ? files : files.filter(f => f.rel.startsWith(prefix))
}

/** 数据区起点：以「缓冲区尾差」为准（头内 uint32 只作近似参考，实测偏小 8）。 */
export function asarDataStart(buf, files) {
  const maxEnd = files.reduce((m, f) => Math.max(m, f.offset + f.size), 0)
  return buf.length - maxEnd
}

/** 把文件子树写出到 outRoot（rel 里的 / 按平台拼路径）。返回写出文件数。
 *  dataStart 可显式传入（提取子集时必须按**全集**算起点，见 doExtract）；
 *  缺省时按给定 files 自己算（单测/全集提取用）。 */
export function extractAsarFiles(buf, files, outRoot, dataStart) {
  const start = dataStart ?? asarDataStart(buf, files)
  if (start <= 0) throw new Error(`asar 数据区起点异常：${start}`)
  let n = 0
  for (const f of files) {
    const outPath = path.join(outRoot, ...f.rel.split('/'))
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, buf.subarray(start + f.offset, start + f.offset + f.size))
    n += 1
  }
  return n
}

/** 汇总检查结果 → 计数与退出码（有 FAIL 才 1；WARN 不影响退出码）。 */
export function summarize(results) {
  const count = status => results.filter(r => r.status === status).length
  const fail = count('FAIL')
  return { pass: count('PASS'), warn: count('WARN'), fail, exitCode: fail > 0 ? 1 : 0 }
}

/**
 * 解析宿主门控测试套件的输出（自建收集器格式：`  PASS  <name>` / `  FAIL  <name>` /
 * `  SKIP  <原因>`；兼容 node:test 的 TAP ok/not ok）。
 * @returns {{pass: number, fail: number, skipped: boolean}}
 */
export function parseSuiteOutput(text) {
  let pass = 0
  let fail = 0
  let skipped = false
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s{2}PASS\s{2}/.test(line)) pass += 1
    else if (/^\s{2}FAIL\s{2}/.test(line)) fail += 1
    else if (/^\s{2}SKIP\s{2}/.test(line)) skipped = true
    else if (/^ok \d+/.test(line)) pass += 1
    else if (/^not ok \d+/.test(line)) fail += 1
  }
  return { pass, fail, skipped }
}

// ── 结果收集与输出 ─────────────────────────────────────────────────────

/** @type {Array<{layer: string, name: string, status: 'PASS'|'WARN'|'FAIL', detail: string}>} */
const results = []
let quiet = false

function check(layer, name, status, detail) {
  results.push({ layer, name, status, detail })
  if (quiet === false) {
    const tag = status === 'PASS' ? '[PASS]' : status === 'WARN' ? '[WARN]' : '[FAIL]'
    console.log(`  ${tag} ${name}${detail === '' ? '' : '：' + detail}`)
  }
}

function header(title) {
  if (quiet === false) console.log('\n' + title)
}

function parseArgs(argv) {
  const opts = { boot: false, live: false, extract: false, json: false, help: false, port: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--boot') opts.boot = true
    else if (a === '--live') opts.live = true
    else if (a === '--extract') opts.extract = true
    else if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--port') {
      const n = Number(argv[i + 1])
      if (Number.isInteger(n) && n > 0) { opts.port = n; i += 1 }
    }
  }
  return opts
}

const HELP = `DSH 升级自检（宿主契约面漂移检测）。宿主升级后必跑。

用法: node scripts/verify-host.mjs [选项]

  (无参数)     T0 宿主定位与版本基线 + T1 契约面（含强制跑宿主门控测试套件）
  --boot       + T2 boot 冒烟（slim host 起得来、RPC 通、会话读得到）
  --live       + T3 活体 CDP（委托 scripts/diag-focus.mjs；会往活会话写一条 patch）
  --extract    先把 app.asar 的 dsh 子树提取到缓存目录（DSH_HOST_CACHE 或系统
               临时目录），供「只有原始安装、没有提取树」的机器跑 T0/T1
  --json       机器可读输出（人和 CI 各取所需）
  --port <n>   T2 首选端口（默认 3087；实际端口以宿主捕获到的 URL 为准）

退出码: 有 FAIL → 1；仅 WARN → 0。WARN 的典型情形 = 宿主版本漂移（升级了但
尚未适配），按输出决定是否更新 host-baseline.json 或改代码。`

// ── T0 宿主定位与版本基线 ──────────────────────────────────────────────

/** 从已知安装根里找 app.asar（Electron 布局：<root>/resources/app.asar）。 */
function findAsar() {
  for (const root of knownInstallRoots()) {
    for (const rel of [path.join('resources', 'app.asar'), 'app.asar']) {
      const candidate = path.join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 解析已提取的宿主树：从 dsh-session 入口向上找含 desktop-runtime.json 的目录
 * （= 运行时目录，其父即提取根）；找不到就退化为「含 node_modules/@deepseek-ai
 * 的目录」（dev checkout 布局，没有 desktop-runtime.json）。
 * @returns {{runtimeDir: string, extractRoot: string, hasRuntimeJson: boolean} | null}
 */
function resolveHostTree() {
  const entry = findHostPackage('dsh-session')
  if (entry === null) return null
  let dir = path.dirname(entry)
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'desktop-runtime.json'))) {
      return { runtimeDir: dir, extractRoot: path.dirname(dir), hasRuntimeJson: true }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  dir = path.dirname(entry)
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'node_modules', '@deepseek-ai'))) {
      return { runtimeDir: dir, extractRoot: path.dirname(dir), hasRuntimeJson: false }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 读 package.json 的 version 字段；读不到返回 null。 */
function packageVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** 递归拷贝目录（file + dir + symlink；不引三方依赖，node 18 无稳定 cpSync）。 */
function copyTree(src, dest) {
  let n = 0
  const entries = readdirSync(src, { withFileTypes: true })
  mkdirSync(dest, { recursive: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      n += copyTree(from, to)
    } else if (entry.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(from), to)
        n += 1
      } catch { /* 单条失败不致命，后续校验会暴露 */ }
    } else {
      copyFileSync(from, to)
      n += 1
    }
  }
  return n
}

/** 目录字节数（只用于汇报）。 */
function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

/** --extract：把 app.asar 的 dsh 子树提取到缓存目录，返回提取根。 */
function doExtract(asar) {
  const cache = process.env.DSH_HOST_CACHE ?? path.join(tmpdir(), 'dsh-reply-forge-host-extract')
  const buf = readFileSync(asar)
  const { tree } = parseAsarHeader(buf)
  const all = collectAsarFiles(tree)
  // 数据区起点必须按**全集**算：只提子集时子集 maxEnd 可能小于全集，起点
  // 算大会让所有提取内容整体错位（踩过：desktop-runtime.json 提出来是别的
  // 文件的字节）。前缀覆盖整个 node_modules（不只 @deepseek-ai scope）：
  // 宿主包有第三方依赖（dsh-session-persistence-jsonl 就 import p-limit），
  // 只提 scope 会让契约面 import 直接 ERR_MODULE_NOT_FOUND。
  const dataStart = asarDataStart(buf, all)
  const prefixes = ['dsh/node_modules/', 'dsh/desktop-runtime.json', 'dsh/package.json']
  const files = all.filter(f => prefixes.some(p => f.rel.startsWith(p)))
  if (files.length === 0) throw new Error('asar 树里没有 dsh/node_modules 子树')
  const n = extractAsarFiles(buf, files, cache, dataStart)
  let bytes = files.reduce((m, f) => m + f.size, 0)
  // 叠加 app.asar.unpacked：标记 unpacked:true 的条目（原生模块、大块头文件，
  // 如 libreoffice-kit.exe、dsh-session-log-export 的 node_modules）不住在
  // 打包 archive 里，只提 asar 会得到一棵缺依赖的树（persistence 套件
  // 就是这么挂的：ERR_MODULE_NOT_FOUND / landed=null）。
  let m = 0
  const unpacked = path.join(path.dirname(asar), 'app.asar.unpacked')
  if (existsSync(unpacked)) {
    m = copyTree(path.join(unpacked, 'dsh'), path.join(cache, 'dsh'))
    bytes += dirSize(path.join(unpacked, 'dsh'))
  }
  check('T0', '--extract 提取', 'PASS', `${n} 个打包文件 + ${m} 个 unpacked 文件 / 共 ${(bytes / 1048576).toFixed(1)} MB → ${cache}（源：${asar}）`)
  return cache
}

/** app.asar 结构校验（诊断工具自身的依赖：提取配方还能用）。 */
function checkAsarStructure(asar) {
  const L = 'T0'
  let buf
  try {
    buf = readFileSync(asar)
  } catch (error) {
    check(L, 'app.asar 结构', 'FAIL', `读不到：${String(error.message)}`)
    return
  }
  try {
    const { jsonStart, tree } = parseAsarHeader(buf)
    const files = collectAsarFiles(tree)
    const dataStart = asarDataStart(buf, files)
    const probe = 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'
    if (dataStart <= 0 || dataStart < jsonStart) {
      check(L, 'app.asar 结构', 'FAIL', `数据区起点异常（${dataStart}）`)
      return
    }
    if (files.some(f => f.rel === probe) === false) {
      check(L, 'app.asar 结构', 'FAIL', '头可解析，但树里没有 dsh/node_modules/@deepseek-ai/dsh-session（布局变了？）')
      return
    }
    check(L, 'app.asar 结构', 'PASS', `${asar}：头 [${jsonStart}, ${jsonStart + 16}) 可配平，${files.length} 个文件，数据区起点 ${dataStart}，dsh 子树在（可按既有配方提取）`)
  } catch (error) {
    check(L, 'app.asar 结构', 'FAIL', String(error.message))
  }
}

async function layerT0(baseline, ctx, opts) {
  const L = 'T0'
  const asar = findAsar()
  if (opts.extract) {
    if (asar === null) {
      check(L, '--extract 提取', 'FAIL', '找不到 app.asar（设 DSH_APP_ROOT / tests/host-paths.local.json 指向安装根）')
    } else {
      try {
        const cache = doExtract(asar)
        process.env.DSH_APP_ROOT = cache // 让随后的解析与子进程都走新提取树
      } catch (error) {
        check(L, '--extract 提取', 'FAIL', String(error.message))
      }
    }
  }

  const tree = resolveHostTree()
  if (tree === null) {
    if (asar !== null) {
      checkAsarStructure(asar)
      check(L, '宿主解析', 'FAIL', '只找到 app.asar、没有提取树。跑 node scripts/verify-host.mjs --extract，或设 DSH_APP_ROOT 指向提取树')
    } else {
      check(L, '宿主解析', 'FAIL', '找不到宿主安装。设 DSH_APP_ROOT / DSH_SESSION_PKG，或在 tests/host-paths.local.json 的 roots 里加安装目录')
    }
    return ctx
  }
  ctx.runtimeDir = tree.runtimeDir
  ctx.extractRoot = tree.extractRoot
  ctx.fromExtract = opts.extract === true
  check(L, '宿主解析', 'PASS', `${tree.runtimeDir}（提取根 ${tree.extractRoot}${tree.hasRuntimeJson ? '' : '，无 desktop-runtime.json——退化布局'}）`)
  if (asar !== null) checkAsarStructure(asar)

  if (tree.hasRuntimeJson) {
    let rt = null
    try {
      rt = JSON.parse(readFileSync(path.join(tree.runtimeDir, 'desktop-runtime.json'), 'utf8'))
    } catch (error) {
      check(L, 'desktop-runtime.json', 'WARN', `解析失败：${String(error.message).slice(0, 120)}`)
    }
    if (rt !== null) {
      const rel = rt?.release ?? {}
      for (const [field, label] of [['version', '宿主版本'], ['hostProtocolVersion', 'hostProtocolVersion'], ['nodeVersion', 'node 版本']]) {
        const actual = rel[field] === undefined ? null : String(rel[field])
        const c = compareVersion(actual, String(baseline.host[field]))
        check(L, `desktop-runtime ${label}`, c.status === 'match' ? 'PASS' : 'WARN', c.detail)
      }
    }
  } else {
    check(L, 'desktop-runtime.json', 'WARN', '读不到（dev checkout 布局？），版本基线只比包级')
  }

  for (const [name, expected] of Object.entries(baseline.packages)) {
    const short = name.replace('@deepseek-ai/', '')
    const actual = packageVersion(path.join(tree.runtimeDir, 'node_modules', '@deepseek-ai', short))
    if (actual === null) {
      check(L, `包 ${short}`, 'FAIL', 'package.json 读不到（基线依赖的包不在了？）')
      continue
    }
    const c = compareVersion(actual, expected)
    check(L, `包 ${short}`, c.status === 'match' ? 'PASS' : 'WARN', c.detail)
  }
  return ctx
}

// ── T1 契约面（import 提取树的宿主包，不起进程） ────────────────────────

async function layerT1(baseline, ctx) {
  const L = 'T1'
  const sessionPkg = findHostPackage('dsh-session')
  const persistPkg = findHostPackage('dsh-session-persistence')
  if (sessionPkg === null || persistPkg === null) {
    check(L, '契约面', 'FAIL', '宿主包解析失败（T0 应已定位）。T1 直接 import 宿主包，缺宿主 = FAIL——这正是 verify-host 与发行包测试的语义差')
    return
  }

  const session = await import(toFileUrl(sessionPkg))
  const persistence = await import(toFileUrl(persistPkg))

  // a. dsh-session 导出面
  const need = ['Session', 'SessionId', 'SessionLogOffset', 'SessionStore', 'KNOWN_SESSION_EVENT_TYPES', 'appendPluginRecord', 'pluginRecordOf']
  const missing = need.filter(n => session[n] === undefined)
  check(L, 'dsh-session 导出面', missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? `必需导出齐全（${need.length} 项）` : '缺失：' + missing.join(', '))

  // b. KNOWN_SESSION_EVENT_TYPES 仍含关键类型
  const known = session.KNOWN_SESSION_EVENT_TYPES
  const wantTypes = baseline.contract.knownEventTypesInclude
  const lack = wantTypes.filter(t => !(known instanceof Set && known.has(t)))
  check(L, 'KNOWN_SESSION_EVENT_TYPES', lack.length === 0 ? 'PASS' : 'FAIL',
    lack.length === 0 ? `Set（${known instanceof Set ? known.size : '?'} 项）含 ${wantTypes.join(' / ')}` : `不含 ${lack.join(', ')}`)

  // c. SessionStore.registerMessageProjection（投影注册的唯一正门）
  const hasReg = typeof session.SessionStore?.prototype?.registerMessageProjection === 'function'
  const wantReg = baseline.contract.sessionStoreHasRegisterMessageProjection === true
  check(L, 'SessionStore.registerMessageProjection', hasReg === wantReg ? 'PASS' : 'FAIL',
    hasReg ? '原型方法在（同一类型只允许一个定义——双类型各注册一个正是按这条设计）' : '方法不见了（投影注册路径断了）')

  // d. plugin 记录专路（存在 → 提示评估迁移；当前不走这条路）
  const hasPluginApi = typeof session.appendPluginRecord === 'function' && typeof session.pluginRecordOf === 'function'
  const wantPluginApi = baseline.contract.pluginRecordApiPresent === true
  check(L, 'plugin 记录 API（appendPluginRecord/pluginRecordOf）', hasPluginApi === wantPluginApi ? 'PASS' : 'WARN',
    hasPluginApi ? '已导出；宿主文档限 packages/experimental 调用，当前不走——留作评估' : '未导出（与基线一致）')

  // e. 功能：Session.append 接受第三参 surfaceOp（遮蔽类写法的前提）
  try {
    const s = session.Session.create(session.SessionId('session-verify-host-t1'), [], undefined, session.SessionLogOffset(0), [])
    s.append('system/message', {
      turn: 0, step: 0,
      message: { id: 'm-sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] },
    }, { surfaceOp: 'append' })
    const a = s.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: {
        id: 'm-a1', role: 'assistant', source: { kind: 'model', provider: 'probe', model: 'probe' },
        content: [
          { type: 'reasoning', text: '推理', signature: 'SIG' },
          { type: 'text', text: '正文' },
        ],
      },
    }, { surfaceOp: 'append' })
    const ok = Number.isInteger(a?.seq)
    check(L, 'Session.append 接受 surfaceOp 选项', ok ? 'PASS' : 'FAIL', ok ? `assistant/message 落到 seq=${a.seq}` : 'append 没返回合法 seq')
  } catch (error) {
    check(L, 'Session.append 接受 surfaceOp 选项', 'FAIL', String(error.message).split('\n')[0])
  }

  // f. 功能：未知类型事件 append 直通（live.mjs 的 session.append(type, data) 同款形状）
  try {
    const s = session.Session.create(session.SessionId('session-verify-host-t1b'), [], undefined, session.SessionLogOffset(0), [])
    const p = s.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: 0, blockIndex: 0, kind: 'text', text: 'x' }]))
    check(L, '未知类型事件 append 直通', Number.isInteger(p?.seq) ? 'PASS' : 'FAIL',
      Number.isInteger(p?.seq) ? `${PATCH_EVENT_TYPE} 无选项 append 落到 seq=${p.seq}（在线写依赖这条）` : 'append 没返回合法 seq')
  } catch (error) {
    check(L, '未知类型事件 append 直通', 'FAIL', String(error.message).split('\n')[0])
  }

  // g/h. 持久化闸门正负对照（fail-closed 的肉身：无 ignorable 必拒、有则放行）
  const META = { id: 'session-verify-host-t1' }
  const LOC = { kind: 'jsonl', path: 'verify-host-probe.v4.jsonl.zstd' }
  const base = {
    type: PATCH_EVENT_TYPE, seq: 0, time: 2,
    data: buildPatchData([{ seq: 0, blockIndex: 0, kind: 'text', text: 'x' }]),
  }
  let rejected = false
  let rejectMsg = ''
  try {
    persistence.validateStoredEvents(META, [base], LOC)
  } catch (error) {
    rejected = true
    rejectMsg = String(error.message).slice(0, 120)
  }
  const wantReject = baseline.contract.persistenceRejectsUnknownEventWithoutIgnorable === true
  check(L, '持久化闸门负面对照（无 ignorable → 拒读）', rejected === wantReject ? 'PASS' : 'FAIL',
    rejected ? `按预期拒绝：${rejectMsg}` : '没拒——闸门松了，缺 ignorable 的旧日志会被当成损坏')

  let accepted = false
  try {
    persistence.validateStoredEvents(META, [{ ...base, ignorable: true }], LOC)
    accepted = true
  } catch (error) {
    rejectMsg = String(error.message).slice(0, 120)
  }
  check(L, '持久化闸门正面对照（ignorable:true → 放行）', accepted ? 'PASS' : 'FAIL',
    accepted ? '带 ignorable 放行（shim 的存在理由）' : '被拒了：' + rejectMsg)

  // i. 读侧双类型接受（v3→v4 迁移改名的对策；基线钉住前缀）
  const prefix = baseline.contract.migrationRenamesOpaqueToPrefix
  const migrated = prefix + baseline.contract.patchEventType
  const lackTypes = [baseline.contract.patchEventType, migrated].filter(t => isPatchEventType(t) === false)
  check(L, '读侧双类型接受', lackTypes.length === 0 ? 'PASS' : 'FAIL',
    lackTypes.length === 0 ? `${baseline.contract.patchEventType} 与 ${migrated} 都认` : '不认：' + lackTypes.join(', '))

  // j. 投影注册面（两种类型各一个、project 共享——行为不漂移）
  const types = patchProjections.map(p => p.type)
  const shapeOk = types.length === 2
    && types.includes(baseline.contract.patchEventType)
    && types.includes(migrated)
    && patchProjections[0].project === patchProjections[1].project
  check(L, '投影注册面', shapeOk ? 'PASS' : 'FAIL',
    shapeOk ? `两个投影（${types.join(' + ')}），project 为同一函数` : `形状不对：${JSON.stringify(types)}`)

  // k. 核心采信底座：活会话折叠必须用注册表投影（this.projections）
  // 冷读路径用硬编码列表是宿主设计（刷新后界面回原文，插件无解）；但活会话
  // 若也被换成硬编码列表，模型侧就再也不采信伪造了——必须报警。
  let liveSrc = ''
  // findHostPackage 返回的是 `lib/index.js` 的**文件**路径，包根要往上退两级。
  const sessionPkgDir = path.dirname(path.dirname(sessionPkg))
  for (const rel of ['lib/types/index.js', 'lib/index.js']) {
    const file = path.join(sessionPkgDir, rel)
    if (existsSync(file) === false) continue
    try { liveSrc += readFileSync(file, 'utf8') } catch { /* 换下一个 */ }
  }
  const liveVerdict = judgeLiveSessionProjectionSource(liveSrc)
  check(L, '活会话投影来源（核心采信底座）', liveVerdict.level, liveVerdict.detail)

  // l. 强制跑宿主门控测试套件（缺宿主 = FAIL，不是 SKIP）
  // 子进程环境：--extract 跑的要显式指向新提取树；其余情况原样继承
  // （父进程能解析到，子进程用同一套三级解析同样能解析到）。
  const childEnv = { ...process.env }
  if (ctx.fromExtract === true && typeof ctx.extractRoot === 'string' && ctx.extractRoot !== '') {
    childEnv.DSH_APP_ROOT = ctx.extractRoot
  }
  for (const name of baseline.hostGatedTestSuites) {
    const file = path.join('tests', name + '.test.mjs')
    const res = spawnSync(process.execPath, [file], { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 })
    if (res.error !== undefined) {
      check(L, `套件 ${name}`, 'FAIL', `拉起失败：${String(res.error.message)}`)
      continue
    }
    const parsed = parseSuiteOutput(`${res.stdout ?? ''}${res.stderr ?? ''}`)
    const tail = `${res.stdout ?? ''}`.split(/\r?\n/).filter(l => l.trim() !== '').slice(-2).join(' / ').slice(0, 160)
    if (res.status !== 0) {
      check(L, `套件 ${name}`, 'FAIL', `退出码 ${res.status}（${parsed.pass} 过 / ${parsed.fail} 败）${tail === '' ? '' : '：' + tail}`)
    } else if (parsed.skipped) {
      check(L, `套件 ${name}`, 'FAIL', '宿主缺失被 SKIP——verify-host 语义：缺宿主 = FAIL')
    } else if (parsed.fail > 0) {
      check(L, `套件 ${name}`, 'FAIL', `${parsed.fail} 项失败${tail === '' ? '' : '：' + tail}`)
    } else if (parsed.pass === 0) {
      check(L, `套件 ${name}`, 'FAIL', '一项都没跑（输出异常？）')
    } else {
      check(L, `套件 ${name}`, 'PASS', `${parsed.pass} 项通过`)
    }
  }
}

// ── T2 boot 冒烟（--boot，复用 scripts/host-oracle.mjs 配方） ───────────
// 配方要点（2026-10-15 踩坑记录，详见 host-oracle.mjs 头注）：
//   · boot() 的 patches 是「叠加在 config 树上的 overlay」；以空 leaf 配置 boot，
//     patch 层来自 loadProfileDirectory，只保留 base + web-app 两层；
//   · bareModuleBaseUrl 必须指向 dsh 安装目录（App 自带安装里有开发 checkout 缺的包）；
//   · ?token= 只对根路径 GET 有效，用它换签名 cookie，后续 API 走 cookie；
//   · 端口以宿主捕获到的 web URL 为准（实测 --port 参数可能不被采纳）。

async function layerT2(ctx, opts) {
  const L = 'T2'
  const hostDir = process.env.DSH_HOST_DIR ?? ctx.runtimeDir
  if (typeof hostDir !== 'string' || hostDir === '' || existsSync(hostDir) === false) {
    check(L, 'boot 冒烟', 'FAIL', '定位不到 dsh 安装目录（T0 未解析到宿主，或设 DSH_HOST_DIR）')
    return ctx
  }
  const req = anchorRequire(hostDir)
  if (req === null) {
    check(L, 'boot 冒烟', 'FAIL', `${hostDir} 里找不到锚点文件（package.json 等）`)
    return ctx
  }
  const profile = process.env.DSH_PROFILE ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')
  if (existsSync(profile) === false) {
    check(L, 'boot 冒烟', 'FAIL', `找不到 profile 目录：${profile}（设 DSH_PROFILE 指定）`)
    return ctx
  }

  let boot, loadProfileDirectory, provideCmdline
  try {
    ({ boot, loadProfileDirectory } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href))
    ;({ provideCmdline } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-cmdline')).href))
  } catch (error) {
    check(L, 'boot 冒烟', 'FAIL', `导入 app-boot/cmdline 失败：${String(error.message).split('\n')[0]}`)
    return ctx
  }

  try {
    const profileLayers = loadProfileDirectory('dsh', profile, path.join(hostDir, 'package.json'))
    const KEEP = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const kept = profileLayers.layers.filter(l => KEEP.has(l.packageName))
    if (kept.length === 0) {
      check(L, 'boot 冒烟', 'FAIL', 'profile 里没找到 base/web-app 层')
      return ctx
    }
    const allPatches = [...kept.flatMap(l => l.patches), ...profileLayers.patches]
    // 无头用不到 Electron 原生目录选择器，禁掉以免 assertEntriesActivated 抛错
    allPatches.push({ id: 'directory-picker', disabled: true })
    const leaf = path.join(mkdtempSync(path.join(tmpdir(), 'verify-host-leaf-')), 'cordis.yml')
    writeFileSync(leaf, '[]\n')

    const captured = []
    const origLog = console.log
    console.log = (...a) => { captured.push(a.map(String).join(' ')) }
    const prepare = hostCtx => { provideCmdline(hostCtx, { args: ['--port', String(opts.port || 3087), '--no-open'], exit: () => {} }) }
    // bareModuleBaseUrl = dsh 安装目录：裸包名在那里解析（与真实桌面端一致）
    await boot('dsh', leaf, structuredClone(allPatches), prepare, pathToFileURL(hostDir).href + '/')
    console.log = origLog

    const webLine = captured.find(l => l.includes('token='))
    const urlMatch = webLine === undefined ? null : /https?:\/\/\S+/.exec(webLine)
    if (urlMatch === null) {
      check(L, 'boot 冒烟', 'FAIL', 'host 起来了但没捕获到 web URL')
      return ctx
    }
    const origin = new URL(urlMatch[0]).origin
    ctx.bootedInProcess = true // host 在进程内，结束后必须显式 exit
    check(L, 'slim host boot', 'PASS', `web URL 已捕获（${origin}）`)

    const token = /token=([A-Za-z0-9._-]+)/.exec(webLine)?.[1] ?? ''
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    let cookie = ''
    for (let i = 0; i < 30 && cookie === ''; i += 1) {
      try {
        const res = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
        if (setCookies.length > 0) cookie = setCookies.map(c => c.split(';')[0]).join('; ')
      } catch { /* 未就绪，重试 */ }
      if (cookie === '') await sleep(500)
    }
    if (cookie === '') {
      check(L, 'cookie 换取', 'FAIL', '30 次重试仍未拿到签名 cookie')
      return ctx
    }
    check(L, 'cookie 换取', 'PASS', '签名 cookie 已获取')

    const rpc = async (method, args) => {
      const res = await fetch(origin + '/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
      })
      const text = await res.text()
      let parsed
      try { parsed = JSON.parse(text) } catch { throw new Error(`status=${res.status} 非 JSON：${text.slice(0, 120)}`) }
      if (parsed?.result?.ok !== true) {
        // 取结构化 message：整包 slice 会把尾部的 "past cursor N" 切掉，游标就学不到
        throw new Error(`RPC ${method} 失败：${parsed?.result?.error?.message ?? text.slice(0, 300)}`)
      }
      return parsed.result.value
    }

    let list = null
    let lastErr = ''
    for (let i = 0; i < 30 && list === null; i += 1) {
      try { list = await rpc('session/list', { _request: {} }) } catch (error) { lastErr = String(error).slice(0, 200); await sleep(500) }
    }
    if (list === null) {
      check(L, 'RPC session/list', 'FAIL', lastErr)
      return ctx
    }
    const items = Array.isArray(list?.items) ? list.items : []
    check(L, 'RPC session/list', 'PASS', `宿主列出 ${items.length} 个会话`)
    if (items.length === 0) {
      check(L, '会话可读', 'WARN', '没有会话可读（boot + RPC 已通；想验读取往 DSH_HOME 放个会话副本）')
      return ctx
    }

    const sessionId = items[0].sessionId
    let page = null
    let cut = Number.MAX_SAFE_INTEGER
    for (let i = 0; i < 20 && page === null; i += 1) {
      try {
        page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: cut, maxMessages: 400 } })
      } catch (error) {
        lastErr = String(error).slice(0, 200)
        const m = /past cursor (\d+)/.exec(lastErr)
        if (m !== null) cut = Number(m[1])
        await sleep(200)
      }
    }
    if (page === null) {
      check(L, '会话可读', 'WARN', `session/page 失败（${lastErr}）`)
      return ctx
    }
    check(L, '会话可读', 'PASS', `会话 ${sessionId} 读到 ${(page.records ?? []).length} 条历史记录`)
  } catch (error) {
    check(L, 'boot 冒烟', 'FAIL', String(error.message).split('\n')[0])
  }
  return ctx
}

// ── T3 活体 CDP（--live，委托 scripts/diag-focus.mjs） ─────────────────
// 活体探针本身很重（起真宿主 + 无头 Edge，且按设计会往一个活会话追加一条
// patch 事件），所以只在 --live 时跑，退出码原样上报。

function layerT3() {
  const L = 'T3'
  const script = path.join(REPO_ROOT, 'scripts', 'diag-focus.mjs')
  if (existsSync(script) === false) {
    check(L, '活体 CDP', 'FAIL', '找不到 scripts/diag-focus.mjs')
    return
  }
  console.log('  … 委托 scripts/diag-focus.mjs（起真宿主 + 无头 Edge + CDP；会往活会话写一条 patch 事件）…')
  const res = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    // safe-delete 垫片会把宿主插件删自己的锁文件当批量删除拦下 → host 起不来
    env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' },
    stdio: 'inherit',
  })
  if (res.error !== undefined) {
    check(L, '活体 CDP', 'FAIL', `拉起失败：${String(res.error.message)}`)
    return
  }
  check(L, '活体 CDP', res.status === 0 ? 'PASS' : 'FAIL', `diag-focus 退出码 ${res.status}`)
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  quiet = opts.json

  let baseline
  try {
    baseline = loadBaseline(REPO_ROOT)
  } catch (error) {
    console.error('[verify-host] ' + String(error.message))
    return 1
  }

  const ctx = { runtimeDir: null, extractRoot: null, fromExtract: false, bootedInProcess: false }
  header('══ T0 宿主定位与版本基线 ══')
  await layerT0(baseline, ctx, opts)
  header('══ T1 契约面（import 宿主包，不起进程） ══')
  await layerT1(baseline, ctx)
  if (opts.boot) {
    header('══ T2 boot 冒烟（slim host + RPC） ══')
    await layerT2(ctx, opts)
  }
  if (opts.live) {
    header('══ T3 活体 CDP（委托 diag-focus） ══')
    layerT3()
  }

  const summary = summarize(results)
  if (opts.json) {
    console.log(JSON.stringify({ results, summary }, null, 2))
  } else {
    console.log(`\n汇总：PASS ${summary.pass} / WARN ${summary.warn} / FAIL ${summary.fail} → 退出码 ${summary.exitCode}`)
    if (summary.fail > 0) console.log('有 FAIL：宿主契约面与插件假设不一致，先看上面逐项明细再决定适配。')
    else if (summary.warn > 0) console.log('仅 WARN（典型 = 宿主版本漂移）：功能面当前仍成立；确认无碍后可更新 host-baseline.json 登记新 known-good。')
  }
  if (ctx.bootedInProcess) process.exit(summary.exitCode) // host 在进程内，不显式退会挂住
  return summary.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error('[verify-host] 运行失败：' + String(error?.stack ?? error))
    process.exitCode = 1
  })
}
