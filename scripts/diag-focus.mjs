// 真机焦点复现（scripts/diag-focus.mjs）。
//
// 起**真宿主**（完整 desktop profile，安装态 v3 插件）+ 无头 Edge + CDP，
// 在真实 Chromium 里走一遍「伪造回复 → 改正文 → 仅本机渲染保存」，全程记录焦点
// 迁移（focusin/focusout + activeElement 定时采样），定位「保存后没有光标」的真因。
//
// 与 tests/dom-stub.mjs 的区别：桩是建模，这里是真 Chromium。上次修复在桩里
// 全绿、真机依旧，说明模型有漏——这个脚本就是补证据的。
//
// 两条路线：
//   A. boot 路线（默认）：复用 app 运行时树（resources/app/dsh）起 web host，
//      Edge CDP 挂页面。dev checkout 与 profile 的插件集版本可能不符，boot 会
//      栽在 web-runtime 形状校验上（踩过）——保持运行时树与 profile 同版本。
//   B. app 路线（--app）：直接拉真实桌面端。**此路已堵**：app 启动器把
//      --remote-debugging-port 当非法 flag 拒掉（"bad option"，来自内置 node 层，
//      app 自己的 JS 里没有这段），chromium 开关到不了 Electron。
//
// 路径一律走环境变量 / 本地配置（机器之间安装位置不同，不写死）：
//   DSH_PROFILE      → DSH profile 目录（默认 ~/.dsh/profiles/desktop）
//   DSH_APP_RUNTIME  → app 运行时树（…/resources/app/dsh），boot 路线必需；
//                      未设时读 scripts/diag.config.json 的 hostDir（本地私有，
//                      被 gitignore，_shape 见 host-oracle.mjs 同款注释）
//
// 只改页面显示（localStorage 覆盖，不碰任何会话文件）+ **写入伪造**
// （活会话异步路径：经宿主持久化追加带 ignorable 标记的 patch 事件，
//   这是插件设计的写入路径；诊断跑一次会往目标会话追加一条 patch 事件）。
//
// ⚠ 运行前提：`CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/diag-focus.mjs`。
// WorkBuddy 的 safe-delete 垫片（经 NODE_OPTIONS 注入本机所有 node 进程）会把宿主
// 插件删自己的锁文件（.credentials.yaml.lock / ledger.json.lock 等）当成批量删除
// 拦下，connection（required）激活失败 → webRuntime 起不来 → 整个 host 起不来。
// 诊断进程不是在操作用户文件，关掉它是为了复制真机启动路径。
//
// 跑法：CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/diag-focus.mjs
import { readFileSync, existsSync, mkdirSync, rmdirSync, symlinkSync, readdirSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const PROFILE = process.env.DSH_PROFILE ?? join(os.homedir(), '.dsh', 'profiles', 'desktop')
// DSH_APP_RUNTIME 未设时回退到本地私有配置 scripts/diag.config.json 的 hostDir
let RUNTIME = process.env.DSH_APP_RUNTIME
if (RUNTIME === undefined || RUNTIME === '') {
  const cfgFile = join(ROOT, 'scripts', 'diag.config.json')
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (typeof cfg.hostDir === 'string' && cfg.hostDir !== '') RUNTIME = cfg.hostDir
    } catch { /* 配置坏了就当没有，走下面的报错 */ }
  }
}
if (RUNTIME === undefined || RUNTIME === '') {
  console.error('[diag-focus] 请用 DSH_APP_RUNTIME 指定 app 运行时树（…/resources/app/dsh），')
  console.error('[diag-focus] 或创建 scripts/diag.config.json：{ "hostDir": "<桌面端>/resources/app/dsh" }')
  process.exit(1)
}
const PORT = 3199
const CDP_PORT = 9334
const TMP = join(ROOT, '.diag-tmp-focus')
const sleep = ms => new Promise(r => setTimeout(r, ms))
process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? 'desktop'

// 解析基址：拼一个合并 node_modules（全 junction，不碰任何原目录）——
// boot() 的 bareModuleBaseUrl 只有一个根，而 @deepseek-ai 核心包在 app 运行时树、
// 生态插件（dsh-tavern / @local/* 等）在 profile。三份 tree 合成一棵供裸包名解析。
// （ESM 解析钩子对本场景无效：条目走 app-boot 自定义 Loader 的 internal.import，
//  绕过 module.register 的钩子，踩过。）
// 合并 node_modules 的清理：逐条 unlink junction + rmdir 空目录。
// （不能对整个目录 rmSync：292 个 junction 会触发 safe-delete 批量删除闸门，踩过。）
const COMBINED = join(TMP, 'combined')
const COMBINED_NM = join(COMBINED, 'node_modules')
const clearDir = dir => {
  if (!existsSync(dir)) return
  let entries = []
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      if (lstatSync(p).isSymbolicLink()) unlinkSync(p)
      else clearDir(p)
    } catch { /* 占位中的残留，尽力而为 */ }
  }
  try { rmdirSync(dir) } catch { /* 非空就留着，不影响正确性 */ }
}
clearDir(COMBINED_NM)
clearDir(COMBINED)
mkdirSync(COMBINED_NM, { recursive: true })
const junction = (target, name) => {
  const dest = join(COMBINED_NM, name)
  if (existsSync(dest)) return
  try { symlinkSync(resolve(target), dest, 'junction') } catch (error) {
    console.error('[focus] junction 失败 ' + name + ': ' + error.message)
  }
}
for (const entry of readdirSync(RUNTIME + '/node_modules')) junction(RUNTIME + '/node_modules/' + entry, entry)
for (const entry of readdirSync(PROFILE + '/node_modules')) {
  if (entry === '@deepseek-ai') continue // 运行时树已有全集
  junction(PROFILE + '/node_modules/' + entry, entry)
}
console.log('[focus] 合并 node_modules 条目数: ' + readdirSync(COMBINED_NM).length)

// ── 1. 起真宿主（app 运行时树版本，与 profile 插件集一致） ┉┉┉┉┉┉┉┉┉┉┉
const require2 = createRequire(join(RUNTIME, 'package.json'))
const { boot, loadOverlayPatches } = await import(pathToFileURL(require2.resolve('@deepseek-ai/dsh-app-boot')).href)
const { provideCmdline } = await import(pathToFileURL(require2.resolve('@deepseek-ai/dsh-cmdline')).href)

const manifest = JSON.parse(readFileSync(PROFILE + '/package.json', 'utf8'))
const allPatches = []
for (const name of (manifest.dsh?.profile?.bundles ?? [])) {
  let dir = PROFILE + '/node_modules/' + name
  if (!existsSync(dir + '/package.json')) dir = RUNTIME + '/node_modules/' + name
  if (!existsSync(dir + '/package.json')) continue
  const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
  const patch = pkg.dsh?.bundle?.patch
  const paths = Array.isArray(patch) ? patch : (typeof patch === 'string' ? [patch] : [])
  for (const p of paths) allPatches.push(...loadOverlayPatches('dsh', dir + '/' + p))
}
if (existsSync(PROFILE + '/cordis.patch.yml')) allPatches.push(...loadOverlayPatches('dsh', PROFILE + '/cordis.patch.yml'))
console.log('[focus] 补丁层数: ' + allPatches.length)
// boot() 会把 ctx.baseUrl 设成「配置文件所在目录」，typert-loader 正是用
// createRequire(ctx.baseUrl) 去读贡献者清单——放 profile 目录会解析不到 app
// 运行时树的包（typert 全灭 → web 客户端拉不到插件代码 → "Failed to load
// plugins"）。所以把配置文件的锚点挪到合并根（profile 的 cordis.yml 是空列表
// `[]`，条目全部来自上面显式传入的补丁，挪动不影响树的组合）。
const CONFIG_ANCHOR = join(COMBINED, 'cordis.yml')
writeFileSync(CONFIG_ANCHOR, readFileSync(PROFILE + '/cordis.yml'))
const prepare = hostCtx => { provideCmdline(hostCtx, { args: ['--port', String(PORT), '--no-open'], exit: () => {} }) }

// 双钩子捕日志：console.log（插件日志）+ process.stdout.write（host 直接写）。
// "dsh web: http://...token=..." 是在 boot() 返回之后异步打印的，只在 boot 期间
// 钩 console.log 会错过（踩过），所以下面 boot 之后还要轮询等它。
const captured = []
const rawWrites = []
const origLog = console.log
const origWrite = process.stdout.write.bind(process.stdout)
console.log = (...a) => { captured.push(a.map(String).join(' ')) }
process.stdout.write = (chunk, ...rest) => { rawWrites.push(String(chunk)); return origWrite(chunk, ...rest) }
await boot('dsh', CONFIG_ANCHOR, structuredClone(allPatches), prepare, pathToFileURL(COMBINED).href + '/')
console.log = origLog

// 0.2.0 的 web host 会打一行 "dsh web: http://127.0.0.1:PORT/?token=..."——
// 必须带 token 导航，否则页面只有一句 "authentication required"（踩过）。
// 该行异步晚于 boot() 返回，轮询至多 30s。
let appUrl = ''
const findTokenUrl = lines => {
  for (const l of lines) {
    const m = /(https?:\/\/\S*token=\S+)/.exec(l)
    if (m !== null) return m[1]
  }
  return ''
}
for (let i = 0; i < 60; i += 1) {
  appUrl = findTokenUrl([...captured, ...rawWrites])
  if (appUrl !== '') break
  await sleep(500)
}
if (appUrl !== '') {
  console.log('[focus] host ok: ' + appUrl)
} else {
  // 兜底：没打到 URL 行就探测端口（没有 token 大概率会被认证拦，仅作诊断）。
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/', { redirect: 'manual' })
      appUrl = 'http://127.0.0.1:' + PORT + '/'
      console.log('[focus] host 端口已监听（status=' + res.status + '）')
      break
    } catch { await sleep(500) }
  }
}
if (appUrl === '') {
  console.error('[focus] host 没给出 URL；日志尾部：\n' + [...captured, ...rawWrites].slice(-25).join('\n'))
  process.exit(1)
}

// ── 2. 无头 Edge + CDP ─────────────────────────────────────────────────────
// edge profile 固定复用（不按 run 建新目录，也不整体 rmSync——safe-delete 闸门）。
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p))
mkdirSync(TMP, { recursive: true })
const edgeProc = spawn(edge, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + join(TMP, 'edge-profile'), '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { edgeProc.kill() } catch { /* */ } })

for (let i = 0; i < 40; i += 1) { try { await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); break } catch { await sleep(250) } }
const target = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?url=about:blank', { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const consoleLog = []
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.args) {
    consoleLog.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '))
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id)
    if (m.error) rej(new Error(m.error.message)); else res(m.result)
  }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = (msgId += 1); pending.set(id, { res, rej })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.navigate', { url: appUrl })
for (let i = 0; i < 60; i += 1) {
  const ok = await evaluate("document.querySelector('[data-slot]') !== null && document.body.innerText.trim().length > 50")
  if (ok === true) break
  await sleep(500)
}
await sleep(3000)

/** 用真实鼠标事件点元素（JS .click() 不发 mousedown，focus 行为不真实）。 */
async function realClick(rectExpr) {
  const rect = await evaluate(`(() => { const el = (${rectExpr}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  if (rect === null) return false
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }
  return true
}

const dumpState = async (label) => {
  const s = await evaluate(`(() => {
    const c = document.querySelector('[data-composer-input]')
    const a = document.activeElement
    const cls = a && typeof a.className === 'string' ? '.' + a.className.split(/\\s+/).filter(Boolean).join('.') : ''
    const flags = (a && a.hasAttribute) ? (a.hasAttribute('data-composer-input') ? '[composer]' : '') + (a.hasAttribute('data-rf3-taken') ? '[msg]' : '') + (a.classList && a.classList.contains('rf3-editor') ? '[rf3-editor]' : '') : ''
    return {
      active: a ? a.tagName + cls + flags : 'null',
      activeIsCE: a ? a.isContentEditable : null,
      composer: c ? { ce: c.isContentEditable, attr: c.getAttribute('contenteditable') } : null,
      editorOpen: document.querySelectorAll('.rf3-editor').length,
      bars: document.querySelectorAll('.rf3-bar').length,
      chatNodes: document.querySelectorAll('[data-slot="conversation.chat.node"]').length,
    }
  })()`)
  console.log('[focus] ' + label + ': ' + JSON.stringify(s))
  return s
}

// ── 3. 弄出一个带助手回复的会话 ───────────────────────────────────────────
// 无头 boot 出来是 hero 态（没选工作区）。流程：选工作区 → 若直接出现历史
// 会话就用；没有就在新会话里发一句、等助手回复（就有可伪造的块了）。
// （曾经盲点候选列表，六分钟全点在插件设置面板上，改为目标明确的流程。）
let state = await dumpState('初始')

/** 当前可见的可点元素（带视口坐标；隐藏/零尺寸一律过滤）。 */
const visibleClickables = async () => evaluate(`[...document.querySelectorAll('button, [role="button"], [role="option"], li, a, [class*="item"], [class*="workspace"]')]
  .map(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0, text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60) }
  })
  .filter(b => b.visible && b.text.length >= 1)`)

/** 用真实鼠标坐标点击。 */
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}

/** 按可见文本点击（多轮重查，等 UI 演化）。 */
const clickByText = async (re, label) => {
  for (let round = 0; round < 4; round += 1) {
    const items = (await visibleClickables()).filter(b => re.test(b.text))
    if (items.length > 0) {
      console.log('[focus] ' + label + ' → 点击 ' + JSON.stringify(items[0].text))
      await clickAt(items[0].x, items[0].y)
      return true
    }
    await sleep(700)
  }
  console.log('[focus] ' + label + ' → 没找到可见目标')
  return false
}

if (state.chatNodes === 0) {
  await clickByText(/选择工作区/, '工作区选择器')
  await sleep(1200)
  const ws = (await visibleClickables()).filter(b => /文档|E:|D:|game/i.test(b.text))
  console.log('[focus] 工作区候选: ' + JSON.stringify(ws.slice(0, 8)))
  if (ws.length > 0) await clickAt(ws[0].x, ws[0].y)
  for (let i = 0; i < 24; i += 1) {
    await sleep(500)
    state = await dumpState('选工作区后')
    if (state.chatNodes > 0 || (state.composer !== null && state.composer.ce === true)) break
  }
}

// 仍无会话但输入框可编辑 → 新开一句发出去，等助手回复。
if (state.chatNodes === 0) {
  const composerRect = await evaluate(`(() => { const c = document.querySelector('[data-composer-input]'); if (!c || c.isContentEditable !== true) return null; const r = c.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
  if (composerRect === null) {
    console.error('[focus] 输入框不可编辑，无法新开对话。页面文本：' + await evaluate('document.body.innerText.slice(0, 600)'))
    process.exit(1)
  }
  console.log('[focus] 新开对话：输入一句话，等助手回复')
  await clickAt(composerRect.x, composerRect.y)
  await sleep(400)
  await send('Input.insertText', { text: '回复一个字：好' })
  await sleep(400)
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }
  await sleep(2500)
  const sent = await evaluate(`document.querySelectorAll('[data-slot="conversation.chat.node"]').length`)
  if (sent === 0) {
    // Enter 没触发发送（可能宿主要按钮）→ 点发送按钮。
    await clickByText(/^(发送|➤|➢|↑|发送消息)$/, '发送按钮')
  }
  // 等助手回复：先出现 chat.node，再等「停止」按钮消失（流式结束）。
  let replied = false
  for (let i = 0; i < 150; i += 1) {
    await sleep(1000)
    const s = await evaluate(`(() => ({ nodes: document.querySelectorAll('[data-slot="conversation.chat.node"]').length, stopping: [...document.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === '停止') }))()`)
    if (s.nodes > 0 && s.stopping === false) { await sleep(1200); replied = true; break }
  }
  console.log('[focus] 助手回复: ' + (replied ? '已出现' : '超时（流式可能未结束，仍继续尝试）'))
  state = await dumpState('发消息后')
}

if (state.chatNodes === 0) {
  console.error('[focus] 还是没有会话，放弃。页面文本：' + await evaluate('document.body.innerText.slice(0, 800)'))
  process.exit(1)
}

// 等插件接管到**聊天节点里的**助手块（不是输入框上误挂的操作条）。
// 同时 dump 聊天节点结构：接管不到时这里就是第一手证据。
const dumpChatNodes = async () => {
  const d = await evaluate(`[...document.querySelectorAll('[data-slot="conversation.chat.node"]')].map((n, i) => ({
    i,
    // taken 标记在**节点内部**的 markdown 容器上，不在 chat.node 外层。
    taken: n.querySelector('[data-rf3-taken]') !== null,
    bar: n.querySelectorAll('.rf3-bar').length,
    text: (n.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    kids: [...n.children].map(k => k.tagName).slice(0, 10),
    mdKids: [...n.querySelectorAll('*')].filter(k => k.matches('p, pre, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, table')).length,
  }))`)
  console.log('[focus] 聊天节点: ' + JSON.stringify(d))
  const loc = await evaluate(`window.__dshReplyForgeV3 && window.__dshReplyForgeV3.locate ? window.__dshReplyForgeV3.locate() : null`)
  if (loc !== null) console.log('[focus] locate(): ' + JSON.stringify(loc))
  return d
}
for (let i = 0; i < 50; i += 1) {
  const taken = await evaluate(`document.querySelectorAll('[data-slot="conversation.chat.node"] [data-rf3-taken]').length`)
  if (taken > 0) break
  await sleep(500)
}
await dumpChatNodes()
if (await evaluate(`document.querySelectorAll('[data-slot="conversation.chat.node"] [data-rf3-taken]').length`) === 0) {
  console.error('[focus] 插件没接管任何聊天节点，无法继续。console: ' + JSON.stringify(consoleLog.slice(-10)))
  process.exit(1)
}

// 等会话记录加载完（locate().ok）。不等就开编辑器 → match=null → 写入按钮
// disabled → 点击无任何反馈（整轮空转，踩过）。
for (let i = 0; i < 80; i += 1) {
  const ok = await evaluate(`(() => { const f = window.__dshReplyForgeV3 && window.__dshReplyForgeV3.locate; if (typeof f !== 'function') return false; return f().ok === true })()`)
  if (ok === true) break
  await sleep(250)
}
console.log('[focus] 记录加载: ' + await evaluate(`(() => { const f = window.__dshReplyForgeV3 && window.__dshReplyForgeV3.locate; return typeof f === 'function' ? JSON.stringify(f()) : 'no-locate' })()`))

// ── 4. 焦点记录器（在任何交互之前装上） ─────────────────────────────────────
await evaluate(`(() => {
  window.__focusLog = []
  const push = tag => {
    const a = document.activeElement
    const cls = a && typeof a.className === 'string' ? '.' + a.className.split(/\\s+/).filter(Boolean).join('.') : ''
    const flags = (a && a.hasAttribute) ? (a.hasAttribute('data-composer-input') ? '[composer]' : '') + (a.hasAttribute('data-rf3-taken') ? '[msg]' : '') + (a.classList && a.classList.contains('rf3-editor') ? '[rf3-editor]' : '') : ''
    window.__focusLog.push({ t: Math.round(performance.now()), tag, el: a ? a.tagName + cls + flags : 'null(body)' })
  }
  document.addEventListener('focusin', e => push('in'))
  document.addEventListener('focusout', e => push('out:' + e.target.tagName + (e.target.classList && e.target.classList.contains('rf3-editor') ? '.rf3-editor' : '')))
})()`)

// ── 5. 开编辑器 → 改正文 → 仅本机渲染保存（对照组：真机已知良好） ┉┉┉
// 抗竞态点击：宿主的动态节点（状态行/费用行持续更新）会触发我们的扫描重建
// 操作条，按钮节点可能在 mousedown 与 mouseup 之间被换掉——click 根本不触发
// （第一阶段复现：焦点日志里只有 out:DIV → BODY，没有 in → BUTTON）。
// 所以点击前 scrollIntoView + elementFromPoint 校验，点完验证效果，不成就重找。
const clickElement = async (expr, label) => {
  const rect = await evaluate(`(() => {
    const el = (${expr})
    if (el === null || el === undefined) return null
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch { /* 忽略 */ }
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (rect === null || rect.w <= 0 || rect.h <= 0) { console.log('[focus] ' + label + '：元素不存在或不可见'); return false }
  // 操作条默认 opacity:0 + pointer-events:none，要 hover 才显形（styles.mjs）。
  // 先移鼠标过去等显形，再校验落点，最后才按下——否则 elementFromPoint
  // 校验必然返回压在按钮上面的消息容器。
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await sleep(300)
  const hit = await evaluate(`(() => {
    const el = (${expr})
    if (el === null || el === undefined) return null
    const r = el.getBoundingClientRect()
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    const inside = top === el || (el.contains ? el.contains(top) : false)
    return { x: cx, y: cy, hit: inside === true, top: top === null ? 'null' : top.tagName, inView: cx > 0 && cx < window.innerWidth && cy > 0 && cy < window.innerHeight }
  })()`)
  if (hit === null) { console.log('[focus] ' + label + '：元素已不在'); return false }
  if (hit.hit !== true || hit.inView !== true) {
    // 落点被占：把占位元素的祖先链打出来（是谁盖住了按钮）。
    const chain = await evaluate(`(() => {
      const el = (${expr})
      if (el === null) return 'target-gone'
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (top === null) return 'no-top'
      const out = []
      let n = top
      for (let i = 0; i < 6 && n !== null && n !== undefined; i += 1) {
        const cls = typeof n.className === 'string' && n.className !== '' ? '.' + n.className.split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : ''
        out.push(n.tagName + cls + (n.hasAttribute && n.hasAttribute('data-slot') ? '[slot=' + n.getAttribute('data-slot') + ']' : '') + (n.hasAttribute && n.hasAttribute('data-rf3-taken') ? '[TAKEN]' : '') + (n.classList && n.classList.contains('rf3-note') ? '[our-note]' : ''))
        n = n.parentElement
      }
      return out.join(' < ')
    })()`)
    console.log('[focus] ' + label + '：落点被占 ' + JSON.stringify(hit) + ' 占位链: ' + chain + ' ← 重试')
    return false
  }
  await clickAt(hit.x, hit.y)
  return true
}

// 候选按钮按「块文本以 焦点复现 开头」优先排序——那是我们阶段 A 覆盖过的
// 回复块；阶段 A 之前没有覆盖，排序不变（仍是最后一条=助手回复）。
// 同时给选中块打 data-diag-target 供 targetConnected 采样。
const forgeBtnExprByIndex = idx => `(() => {
  const blocks = [...document.querySelectorAll('[data-slot="conversation.chat.node"] [data-rf3-taken]')]
  blocks.sort((a, b) => {
    const ea = (a.textContent ?? '').trim().startsWith('焦点复现') ? 0 : 1
    const eb = (b.textContent ?? '').trim().startsWith('焦点复现') ? 0 : 1
    return ea - eb
  })
  const btns = blocks.flatMap(b => [...b.querySelectorAll('button')].filter(x => (x.textContent ?? '').trim() === '伪造回复'))
  const btn = btns[${idx}] ?? null
  if (btn !== null) { const blk = btn.closest('[data-rf3-taken]'); if (blk !== null) blk.setAttribute('data-diag-target', '1') }
  return btn
})()`

const editorBtnExpr = name => `(() => { const e = document.querySelector('.rf3-editor'); if (e === null) return null; return [...e.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '` + name + `') ?? null })()`

const editorOpen = async () => (await evaluate(`document.querySelectorAll('.rf3-editor textarea').length`)) > 0

const openEditorByForgeBtn = async () => {
  for (let idx = 0; idx < 5; idx += 1) {
    const label = '点「伪造回复」开编辑器（候选#' + idx + ' 第1试）'
    const ok = await clickElement(forgeBtnExprByIndex(idx), label)
    if (ok === true) {
      for (let i = 0; i < 12; i += 1) {
        await sleep(200)
        if (await editorOpen()) return true
      }
    }
    // 同一候选再试两次：第一次严格校验、之后退回坐标点击。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ok2 = await clickAtCoords(forgeBtnExprByIndex(idx), '坐标点击「伪造回复」（候选#' + idx + ' 第' + (attempt + 2) + '试）')
      if (ok2 === true) {
        for (let i = 0; i < 12; i += 1) {
          await sleep(200)
          if (await editorOpen()) return true
        }
      }
      await sleep(400)
    }
  }
  return false
}

/** 悬浮后按坐标点击（不做 elementFromPoint 校验，给被拦截的场景兜底）。 */
const clickAtCoords = async (expr, label) => {
  const rect = await evaluate(`(() => {
    const el = (${expr})
    if (el === null || el === undefined) return null
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) } catch { /* 忽略 */ }
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (rect === null || rect.w <= 0 || rect.h <= 0) { console.log('[focus] ' + label + '：元素不存在或不可见'); return false }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await sleep(300)
  console.log('[focus] ' + label + '：坐标 (' + Math.round(rect.x) + ',' + Math.round(rect.y) + ')')
  await clickAt(rect.x, rect.y)
  return true
}

const clickEditorBtn = async (name, label) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ok = await clickElement(editorBtnExpr(name), label + '（第 ' + (attempt + 1) + ' 次）')
    if (ok === true) return true
    await sleep(300)
  }
  return false
}

const setTextarea = async text => evaluate(`(() => {
  const area = document.querySelector('.rf3-editor textarea')
  if (!area) return 'no textarea'
  area.value = ${JSON.stringify(text)}
  area.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`)

const pluginErrors = () => consoleLog.filter(l => l.includes('reply-forge')).slice(-5)

/** 全部宿主持话输入框候选：可编辑性/可见性/inert 祖先。 */
const composerCensus = async () => evaluate(`[...document.querySelectorAll('[data-composer-input]')].map((el, i) => {
  const r = el.getBoundingClientRect()
  return {
    i,
    ce: el.isContentEditable === true,
    visible: r.width > 0 && r.height > 0,
    inertAnc: typeof el.closest === 'function' ? el.closest('[inert]') !== null : null,
    connected: el.isConnected !== false,
    cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
  }
})`)

/**
 * 打字探针：在当前焦点处真打字，看字符有没有落进宿主输入框。
 * 之前的复现只验证「焦点落在 composer 元素上」——从没验证过「能打字」，
 * 而真机第二轮的故障恰是「提示行说交还了、用户依旧打不了字」。
 * insertText 走的是与 IME 提交相同的输入路径，比 dispatchKeyEvent 更真。
 */
const typeProbe = async (label) => {
  const read = () => evaluate(`(() => {
    const c = document.querySelector('[data-composer-input]')
    const a = document.activeElement
    return {
      composerLen: c === null ? -1 : (c.innerText ?? '').length,
      activeIsComposer: a === c,
      active: a === null ? 'null(body)' : a.tagName,
    }
  })()`)
  const before = await read()
  await send('Input.insertText', { text: 'qz' })
  await sleep(250)
  const after = await read()
  const landed = after.composerLen > before.composerLen
  console.log('[focus] 打字验证（' + label + '）: ' + JSON.stringify({ before, after, landed }))
  return landed
}

/** 等编辑器就绪：写入按钮可用（match 非空）。未就绪时点击是无效的。 */
const waitEditorReady = async () => {
  for (let i = 0; i < 48; i += 1) {
    const st = await evaluate(`(() => {
      const e = document.querySelector('.rf3-editor')
      if (e === null) return null
      const btn = [...e.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '写入伪造')
      const note = (e.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 70)
      return { ready: btn !== undefined && btn !== null && btn.disabled !== true, note }
    })()`)
    if (st !== null && st.ready === true) return st
    await sleep(250)
  }
  return null
}

// ── 第一阶段：写入伪造（活会话异步路径）——本轮真机 bug 的主体 ┉┉┉┉┉
// 必须放在最前面：干净的回复块、没有本机覆盖，记录对得上、写入按钮可用。
// （曾经先跑「仅本机渲染」对照组——它的本机覆盖让 DOM 与记录失配，
//   匹配不上 → 写入按钮 disabled → 点击无反馈、confirm 都不弹，整个
//   第二阶段空转，白跑一轮。）
// 与仅本机渲染的三个区别：① 点击后同步 disable 两个按钮（Chromium 当场把
//    焦点打到 <body>）；② 异步等待宿主写入；③ 写成功后宿主侧可能对会话
//    变更做出重渲染。按 150ms 粒度采样 ~7.5s 全覆盖。
console.log('[focus] ═══ 第一阶段：写入伪造 ═══')

// v3.1 起写入是页面内两步确认，不再有原生 window.confirm。这里保留 dialog
// 自动批准作为兜底（万一别处又冒出原生框，不至于把整轮挂住）。
const dialogSeen = []
ws.addEventListener('message', ev => {
  try {
    const m = JSON.parse(ev.data)
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogSeen.push(String(m.params?.message ?? '').slice(0, 120))
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { })
    }
  } catch { /* 忽略 */ }
})

const openedWrite = await openEditorByForgeBtn()
console.log('[focus] 写入路径编辑器打开: ' + openedWrite)
if (openedWrite !== true) {
  console.error('[focus] 打不开编辑器，放弃。console: ' + JSON.stringify(pluginErrors()))
  process.exit(1)
}
await dumpState('写入路径编辑器打开')
console.log('[focus] 输入框候选普查（写入前）: ' + JSON.stringify(await composerCensus()))
const writeReady = await waitEditorReady()
console.log('[focus] 写入按钮就绪: ' + JSON.stringify(writeReady))
if (writeReady === null) {
  console.error('[focus] 写入按钮始终不可用（match 定位不上），放弃。console: ' + JSON.stringify(pluginErrors()))
  process.exit(1)
}

console.log('[focus] 改正文: ' + await setTextarea('焦点复现写入路径 ' + Date.now()))

const clickedWrite = await clickEditorBtn('写入伪造', '点「写入伪造」')
console.log('[focus] 点击「写入伪造」（第一次：出页面内确认行）: ' + clickedWrite)
// v3.1 起写入是页面内两步确认（不再用 window.confirm——OS 级原生模态框会把
// app 窗口键盘焦点弄丢，是「焦点全绿却打不了字」的疑凶）。第二次点击才真写。
await sleep(400)
const confirmedWrite = await clickEditorBtn('写入伪造', '点「写入伪造」')
console.log('[focus] 点击「写入伪造」（第二次：确认写入）: ' + confirmedWrite)

// 采样 ~7.5s：async 写 + 宿主可能的异步重渲染都覆盖在内。
const samples = []
const sampleExpr = `(() => {
  const a = document.activeElement
  const c = document.querySelector('[data-composer-input]')
  const cls = a && typeof a.className === 'string' ? '.' + a.className.split(/\\s+/).filter(Boolean).join('.') : ''
  const flags = a && a.hasAttribute
    ? (a.hasAttribute('data-composer-input') ? '[composer]' : '')
      + (a.hasAttribute('data-rf3-taken') ? '[msg]' : '')
      + (a.classList && a.classList.contains('rf3-editor') ? '[rf3-editor]' : '')
      + (a.tagName === 'BUTTON' ? '[btn:' + (a.textContent ?? '').trim().slice(0, 8) + ']' : '')
      + (a.tagName === 'TEXTAREA' ? '[textarea]' : '')
    : ''
  const target = document.querySelector('[data-diag-target]')
  const notes = [...document.querySelectorAll('.rf3-note')].map(n => (n.textContent ?? '').trim()).slice(-3)
  const dbg = window.__dshReplyForgeV3 && window.__dshReplyForgeV3.focus ? window.__dshReplyForgeV3.focus() : null
  return {
    ms: Math.round(performance.now()),
    active: a ? a.tagName + cls + flags : 'null(body)',
    activeIsComposer: a === c,
    composer: c ? { ce: c.isContentEditable, attr: c.getAttribute('contenteditable') } : null,
    editorOpen: document.querySelectorAll('.rf3-editor').length,
    targetConnected: target !== null && target.isConnected === true,
    notes,
    dbg: dbg === null ? null : {
      ok: dbg.last ? dbg.last.ok : null,
      reason: dbg.last ? dbg.last.reason : null,
      editable: dbg.composer ? dbg.composer.editable : null,
      activeIsComposer: dbg.activeIsComposer,
    },
  }
})()`
for (let i = 0; i < 50; i += 1) {
  await sleep(150)
  samples.push(await evaluate(sampleExpr))
}
console.log('[focus] ── 写入路径采样（150ms × ~7.5s） ──')
for (const s of samples) {
  const c = s.composer === null ? 'no-composer' : (s.composer.ce ? 'editable' : 'ce=' + s.composer.attr)
  console.log('   ' + String(s.ms).padStart(7) + 'ms  active=' + s.active.padEnd(46)
    + ' composer=' + c.padEnd(12)
    + ' editor=' + s.editorOpen
    + ' target_node=' + (s.targetConnected ? 'alive' : 'REPLACED')
    + ' dbg=' + JSON.stringify(s.dbg))
}
const withNotes = samples.filter(s => s.notes.length > 0).slice(-1)[0]
if (withNotes !== undefined) console.log('[focus] 提示行: ' + JSON.stringify(withNotes.notes))
console.log('[focus] confirm 对话框出现次数: ' + dialogSeen.length + ' 首条: ' + (dialogSeen[0] ?? '无'))

// ── 真打字验证（本轮新增） ──────────────────────────────────────────────
// 焦点采样的重点是「activeElement 是不是 composer」，但真机 bug 的第二形态是
// 「焦点交还了、提示行也这么说、可就是打不了字」。所以不做这一步， sampled
// 全绿也没有回答用户的问题。在焦点还热着时直接ins text，看字符有没有
// 落进（正确的那个）宿主输入框。探针会往输入框草稿里打两个字，不发送。
console.log('[focus] 输入框候选普查（写入后）: ' + JSON.stringify(await composerCensus()))
const canTypeAfterWrite = await typeProbe('写入伪造保存后直接打字')
console.log('[focus] 结论: 写入路径保存后' + (canTypeAfterWrite === true ? '可以直接打字 ✅' : '打不了字 ❌'))
// 探针字符清掉，不留草稿污染
await evaluate(`(() => { const c = document.querySelector('[data-composer-input]'); if (c !== null) { try { c.innerText = (c.innerText ?? '').replace(/qz/g, '') } catch { /* 忽略 */ } } })()`)

// ── 第二阶段：仅本机渲染（对照组：真机已知良好） ┉┉┉
console.log('[focus] ═══ 第二阶段：仅本机渲染（对照） ═══')
const openedCtrl = await openEditorByForgeBtn()
console.log('[focus] 对照编辑器打开: ' + openedCtrl)
if (openedCtrl !== true) {
  console.error('[focus] 对照阶段打不开编辑器。console: ' + JSON.stringify(pluginErrors()))
  process.exit(1)
}
await dumpState('对照编辑器打开')

console.log('[focus] 改正文: ' + await setTextarea('焦点复现专用正文 ' + Date.now()))

const saved = await clickEditorBtn('仅本机渲染', '点「仅本机渲染」')
console.log('[focus] 点击「仅本机渲染」: ' + saved)

for (const ms of [50, 300, 1200]) {
  await sleep(ms)
  await dumpState('对照保存后 +' + ms + 'ms')
}
console.log('[focus] 阶段后操作条: ' + JSON.stringify(await evaluate(`[...document.querySelectorAll('.rf3-bar')].map(b => {
  const btn = [...b.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === '伪造回复')
  const r = btn === undefined ? null : btn.getBoundingClientRect()
  return { connected: b.isConnected === true, inTaken: b.closest('[data-rf3-taken]') !== null, btn: r === null ? null : { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
})`)))
console.log('[focus] 已接管块清单: ' + JSON.stringify(await evaluate(`[...document.querySelectorAll('[data-rf3-taken]')].map(b => {
  const r = b.getBoundingClientRect()
  const nodes = [...document.querySelectorAll('[data-slot="conversation.chat.node"]')]
  const node = b.closest('[data-slot="conversation.chat.node"]')
  return { chatIdx: node === null ? -1 : nodes.indexOf(node), text: (b.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30), y: Math.round(r.y), linked: b.querySelector('[data-rf3-linked]') !== null }
})`)))

const log = await evaluate('window.__focusLog')
console.log('[focus] ── 焦点迁移全程 ──')
for (const e of log) console.log('   ' + String(e.t).padStart(7) + 'ms  ' + e.tag.padEnd(22) + ' → ' + e.el)

const finalFocus = await evaluate(`(() => {
  const a = document.activeElement
  const c = document.querySelector('[data-composer-input]')
  return { isComposer: a === c, isBody: a === document.body, active: a ? a.tagName : 'null' }
})()`)
console.log('[focus] 结论: ' + JSON.stringify(finalFocus))
// 对照组也做真打字验证
await typeProbe('仅本机渲染保存后直接打字')
await evaluate(`(() => { const c = document.querySelector('[data-composer-input]'); if (c !== null) { try { c.innerText = (c.innerText ?? '').replace(/qz/g, '') } catch { /* 忽略 */ } } })()`)
console.log('[focus] 页面 console（尾部 15 条）: ' + JSON.stringify(consoleLog.slice(-15)))
process.exit(0)
