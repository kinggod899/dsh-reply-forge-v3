// 宿主预言机（scripts/host-oracle.mjs）：验证「宿主自己的会话读取器」接受
// 我们改写过的会话文件——v2 目标 2/3 的关键实证。
//
// 做法：把 DSH_HOME 指向一个临时家目录（sessions/ 里放改写后的会话副本），
// 用宿主自己的 dsh 安装起一个 slim host（只保留 base + web-app 两层），
// 然后直连 RPC：
//   session/list  → 拿到 sessionId（证明宿主认这个会话，blank=false）
//   session/page  → 拿到宿主读出的历史事件（证明伪造正文被宿主读出）
// 让对照组（未改写副本）跑同一路径 → 必须 FAIL，证明预言机有区分度。
//
// 2026-10-15 实测配方（踩坑记录）：
//   * boot() 的 patches 是「叠加在 config 树上的 overlay」；把含 include: 的
//     bundle 层叠到已合成的 cordis.yml 上 → duplicate loader entry id: timer。
//     正确做法：以空 leaf 配置 boot，patch 层来自 loadProfileDirectory。
//   * 裸包名解析基 bareModuleBaseUrl 必须指向 dsh 安装目录（App 自带安装
//     里有开发 checkout 缺的包，如 @deepseek-ai/dsh-agent-preset）。
//   * ?token= 只对根路径 GET 有效，用它换签名 cookie，后续 API 走 cookie。
//   * session/projections 只回 baseline 投影（不含 turnOutline），
//     拿真实历史要用 session/page（throughSeq 不得越过宿主游标）。
//
// 用法：
//   node scripts/host-oracle.mjs --home <临时家目录> --expect "<改写后应出现的文本>"
//   node scripts/host-oracle.mjs --home <临时家目录> --expect "<原文>"   # 对照组
//   环境变量 ORACLE_DUMP=1 打印返回结构细节（排障用）
//
// 依赖：DSH_HOST_DIR / scripts/diag.config.json 的 hostDir / DSH_WORKSPACE。
//   hostDir   = DeepSeek Harness 桌面端自带的 dsh 安装目录
//              （<安装目录>/resources/app/dsh，其 node_modules 含全部 @deepseek-ai/*）
//   workspace = 真实会话所在的工作区（宿主按 cwd 算 slug；默认取当前目录）
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { requireCheckout } from '../src/checkout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---- 路径解析（环境变量优先，其次本地 diag.config.json，绝不写死） ----
let cfg = {}
if (existsSync(join(HERE, 'diag.config.json'))) {
  try { cfg = JSON.parse(readFileSync(join(HERE, 'diag.config.json'), 'utf8')) } catch { cfg = {} }
}
// ---- 宿主安装解析（App 自带 dsh，其 node_modules 含全部 @deepseek-ai/*） ----
// 真实桌面端 boot 时把 bareModuleBaseUrl 指向自己的安装目录，裸包名
// （如 @deepseek-ai/dsh-agent-preset，开发 checkout 里只有复数版）在那里解析。
const HOST_DIR = process.env.DSH_HOST_DIR ?? cfg.hostDir ?? ''
if (HOST_DIR === '') {
  console.error('缺少 dsh 安装目录。请设 DSH_HOST_DIR=<桌面端>/resources/app/dsh，')
  console.error('或创建 scripts/diag.config.json：{ "hostDir": "<桌面端>/resources/app/dsh" }')
  process.exit(1)
}
const require2 = requireCheckout(HOST_DIR)
const { boot, loadProfileDirectory } = await import(pathToFileURL(require2.resolve('@deepseek-ai/dsh-app-boot')).href)
const { provideCmdline } = await import(pathToFileURL(require2.resolve('@deepseek-ai/dsh-cmdline')).href)

const args = process.argv.slice(2)
const opt = {}
for (let i = 0; i < args.length; i += 1) {
  if (!args[i].startsWith('--')) continue
  opt[args[i].slice(2)] = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : true
}
const HOME = typeof opt.home === 'string' ? opt.home : ''
const EXPECT = typeof opt.expect === 'string' ? opt.expect : ''
if (HOME === '' || EXPECT === '') {
  console.error('用法: node scripts/host-oracle.mjs --home <家目录> --expect "<期望出现的文本>"')
  process.exit(1)
}

// 工作区 cwd：宿主按它算工作区 slug，要和目标会话的 slug 对得上
// （可用 DSH_WORKSPACE / cfg.workspace 覆盖；默认当前目录）
const WORKSPACE = process.env.DSH_WORKSPACE ?? cfg.workspace ?? process.cwd()
try { process.chdir(WORKSPACE) } catch { /* 失败也不致命，slug 可能不同 */ }

// ---- 起 slim host（只测宿主读取器） ----
// 实测结论（2026-10-15）：
//   1) boot(bin, configPath, patches) 的 patches 是「叠加在 config 树上的 overlay」。
//      profile/cordis.yml 是 App 每次启动重写的合成结果，若再把含 include: 的
//      bundle 层叠上去 → duplicate loader entry id: timer。
//   2) 裸包名解析基（bareModuleBaseUrl）= dsh 安装目录；只有那里有 App 独有的
//      包（如 @deepseek-ai/dsh-agent-preset，开发 checkout 只有复数版）。
//   3) 因此：用宿主自己的 loadProfileDirectory 取层，只保留 @deepseek-ai/* 的
//      base + web-app 两层（会话读取器全在这里），以空 leaf 配置 boot。
//      用户第三方 bundle（tavern/dshmarket…）与「读会话」无关，不引入。
const PROFILE = process.env.DSH_PROFILE ?? cfg.profile ?? join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'profiles', 'desktop')
const profile = loadProfileDirectory('dsh', PROFILE, join(HOST_DIR, 'package.json'))
const KEEP = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
const keptLayers = profile.layers.filter(l => KEEP.has(l.packageName))
if (keptLayers.length === 0) { console.error('[oracle] 未在 profile 中找到 base/web-app 层'); process.exit(1) }
const allPatches = [...keptLayers.flatMap(l => l.patches), ...profile.patches]
// 无头测试用不到 Electron 原生目录选择器，禁掉以免 assertEntriesActivated 抛错。
allPatches.push({ id: 'directory-picker', disabled: true })
const LEAF = join(mkdtempSync(join(tmpdir(), 'oracle-leaf-')), 'cordis.yml')
writeFileSync(LEAF, '[]\n')

const captured = []
const origLog = console.log
console.log = (...a) => { captured.push(a.map(String).join(' ')) }
const prepare = hostCtx => { provideCmdline(hostCtx, { args: ['--port', '3080', '--no-open'], exit: () => {} }) }
// bareModuleBaseUrl = 宿主安装目录：裸包名在那里解析（与真实桌面端一致）。
const bareBase = pathToFileURL(HOST_DIR).href + '/'
await boot('dsh', LEAF, structuredClone(allPatches), prepare, bareBase)
console.log = origLog
const webLine = captured.find(l => l.includes('token='))
if (webLine === undefined) { console.error('[oracle] 未捕获到 web URL'); process.exit(1) }
const token = /token=([A-Za-z0-9._-]+)/.exec(webLine)?.[1] ?? ''
console.log('[oracle] host ok, DSH_HOME=' + process.env.DSH_HOME)

// ---- 鉴权：?token= 只对根路径 GET 有效，用它换签名 cookie；后续 API 走 cookie ----
const BASE = 'http://127.0.0.1:3080'
let cookie = ''
for (let i = 0; i < 30 && cookie === ''; i += 1) {
  try {
    const res = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (setCookies.length > 0) cookie = setCookies.map(c => c.split(';')[0]).join('; ')
  } catch { /* 未就绪，重试 */ }
  if (cookie === '') await new Promise(r => setTimeout(r, 500))
}
if (cookie === '') { console.error('[oracle] 未能换取会话 cookie'); process.exit(1) }
console.log('[oracle] 已获取会话 cookie')

// ---- 等 host 就绪后直连 RPC（带 cookie） ----
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rpc = async (method, args) => {
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`status=${res.status} 非 JSON 响应: ${text.slice(0, 200)}`) }
  if (parsed?.result?.ok !== true) throw new Error(`RPC ${method} 失败: ${text.slice(0, 300)}`)
  return parsed.result.value
}

let list = null
let lastErr = ''
for (let i = 0; i < 30 && list === null; i += 1) {
  try { list = await rpc('session/list', { _request: {} }) } catch (e) { lastErr = String(e).slice(0, 300); await sleep(500) }
}
if (list === null) { console.error('[oracle] session/list 调用失败\n  ' + lastErr); process.exit(1) }

const items = list.items ?? []
console.log(`[oracle] 宿主列出 ${items.length} 个会话`)
if (items.length === 0) { console.error('[oracle] 宿主没看到任何会话（DSH_HOME 或工作区 slug 不对？）'); process.exit(1) }
const sessionId = items[0].sessionId
console.log(`[oracle] 目标会话 ${sessionId}（blank=${items[0].blank} running=${items[0].running}）`)

// session/page 返回宿主的会话历史记录（SessionEventEntry：原始事件），
// 伪造正文就在其中的 assistant/message 事件里。throughSeq 必须 <= 宿主游标；
// 首次用极大值试探，宿主会回「past cursor N」——那个 N 就是它读完日志的游标。
let page = null
let cut = Number.MAX_SAFE_INTEGER
for (let i = 0; i < 20 && page === null; i += 1) {
  try {
    page = await rpc('session/page', { request: {
      address: { kind: 'session', sessionId },
      throughSeq: cut,
      maxMessages: 400,
    } })
  } catch (e) {
    lastErr = String(e).slice(0, 300)
    const m = /past cursor (\d+)/.exec(lastErr)
    if (m !== null) { cut = Number(m[1]); console.log(`[oracle] 宿主报告的会话游标 = ${cut}`) }
    await sleep(200)
  }
}
if (page === null) { console.error('[oracle] session/page 调用失败\n  ' + lastErr); process.exit(1) }

const records = page.records ?? []
console.log(`[oracle] 宿主返回 ${records.length} 条历史记录（hasMore=${page.hasMore}）`)
if (process.env.ORACLE_DUMP === '1') {
  const first = records[0]
  console.log('[oracle] record0 keys=' + JSON.stringify(Object.keys(first ?? {})))
  console.log('[oracle] record0=' + JSON.stringify(first).slice(0, 600))
}
let found = false
for (const r of records) {
  const s = JSON.stringify(r)
  if (s.includes(EXPECT)) {
    found = true
    const ev = r?.event ?? {}
    console.log(`[oracle] 命中 type=${ev.type} seq=${ev.seq}：${s.slice(0, 100)}`)
  }
}
console.log(found ? '[oracle] PASS：宿主读出的历史记录里出现了期望文本' : '[oracle] FAIL：期望文本未出现')
process.exit(found ? 0 : 2)
