/** dsh-reply-forge v3 浏览器 half：在会话消息上挂就地编辑入口，写入活会话或落盘记录。
 *
 * 保存有多个出口：
 *   - 「仅本机渲染」：只写 localStorage，改的是页面，模型看不见（v1 的能力）；
 *   - 「写入伪造」：在线写活会话（message projection，下一轮即生效），
 *     或落盘写会话记录（该会话下次载入时生效）。
 * 两者都不可逆（在线模式追加进日志，落盘模式有自动备份可还原）——
 * 运行中的宿主把会话持在内存里，改盘不会被它读到，所以哪条路生效必须
 * 在界面上说清楚。
 *
 * 与其它插件共存的四条纪律（承自 v1）：
 *  1. 只注入，不注册。不向任何共享槽位注册条目，UI 完全由 DOM 注入实现。
 *  2. 命名隔离。样式类 rf3-*、属性 data-rf3-*、存储键 dsh-reply-forge-v3:*。
 *  3. 幂等接管。每个消息节点带 data-rf3-taken 标记，宿主重渲染后自然重新接管。
 *  4. 不阻断。任何一步异常都就地吞掉并记日志，绝不让宿主渲染失败。
 *
 * 契约（官方 bundle 插件 client half）：export name / inject / apply。
 */

import { CSS } from './styles.mjs'
import { CONVERSATION_SELECTOR, TAKEN_ATTR, pickAssistantBlocks, conversationRoot } from './picker.mjs'
import { renderMarkdown } from './markdown.mjs'
import { classifyNaturalLanguage } from './classify.mjs'
import {
  currentSessionId, isPlaceholderSession, fingerprint, loadOverrides, setOverride,
  removeOverride, clearOverrides, loadPrefs, savePrefs,
} from './store.mjs'
import {
  loadRecord, cachedRecord, resetCache, matchBlocks, normalizeText, forgeRecord,
  recordNeedsRefresh, domSignatureOf,
} from './record.mjs'
import {
  readInbox, readInboxRows, resolvePendingItem,
  resolvePendingItemById, hasTextMatchRow, bubbleTextOf, submitQueueEdit, queueDiag,
  hasPendingEcho, collapseWhitespace,
} from './queue.mjs'

export const name = 'dsh-reply-forge-v3'

/**
 * 依赖服务：槽位系统（等待宿主就绪）+ sessions（读取待发送队列）。
 *
 * 加 'sessions' **不破坏「只注入，不注册」的纪律**：inject 是「声明要用哪个
 * 服务」，注册是「往共享槽位塞 UI 条目」。我们仍然不往任何 UI 槽位注册东西，
 * 只是在需要读 inbox 投影和调 updateQueue 时用这个服务，入口照旧全在 DOM 上。
 *
 * 另一个必须记住的约束：**ctx.<service> 只在 apply() 期可读**，slot 回调 /
 * 事件处理器里再读会抛。所以 apply 里立刻把服务对象存进模块级 ref（见
 * sessionsRef），handler 只碰那个变量。
 */
export const inject = ['slots', 'sessions']

/** apply() 注入的 sessions 服务（模块级函数拿不到 apply 的 ctx）。 */
let sessionsRef = null

/**
 * 待发送气泡 → 接管时预取的定位锚点。
 *
 * 气泡出现的瞬间，投影与宿主渲染是一致的（气泡就是从那批行渲染出来的），此时
 * 按文本解析出的 itemId 是**最可信的锚点**。点击时先按 id 复核：行还在就直接
 * 开编辑器，不必再赌文本回匹。WeakMap 保证气泡被宿主卸载后锚点自动消失。
 */
const pendingAnchors = new WeakMap()

const SCAN_DEBOUNCE_MS = 220
const EDIT_ATTR = 'data-rf3-edited'

// ── 落盘记录的自动重读（2026-10-15 真机 bug 的修复）──────────────────────
// 症状：伪造掉会话里第一条回复之后，后面新出现的每一条回复都提示
// 「未在会话记录中定位到这条回复（记录里有 N 条正文）」。
// 根因：记录缓存不会随会话增长而更新——宿主把新回复渲染进 DOM 后约 200ms
// 才落盘（dsh-session-persistence-jsonl 的 enqueueLive 是 setTimeout 批处理），
// 而缓存只在首次拉起/写入成功/用户点「重新读取」时失效。伪造第一条正好
// 触发一次强制重读，之后的新回复就永远拿着那份旧快照在比对。
// 修法：页面上出现的正文块比记录里多时，后台自动重读，读完重扫刷新定位。

/** 两次自动重读的最小间隔（毫秒）。防止流式输出期间把读记录打成高频请求。 */
const RECORD_REFRESH_MIN_GAP_MS = 800
/** 连续重读都拿不到新块就停手：记录确实只有这么少，或宿主迟迟不落盘。
 *  停手后用户仍可点「重新读取」手动重试。 */
const RECORD_REFRESH_MAX_TRIES = 4

/** 本插件自己注入的 UI 类名。取正文时必须跳过它们。 */
const OWN_UI_CLASSES = ['rf3-bar', 'rf3-editor', 'rf3-note', 'rf3-notes']

/** 已接管的节点 → 覆盖指纹，供撤销时定位。 */
const taken = new WeakMap()

/** 已接管的节点 → 与它正文完全相同的消息条数（>1 时编辑器给共享覆盖警示）。 */
const dupCount = new WeakMap()

/** 已接管的节点 → 落盘记录里的对应块（null = 没对上，落盘出口禁用）。 */
const blockMatch = new WeakMap()

/** 进行中的强制读记录请求：sessionId → Promise。并发触发时只发一次网络请求。 */
const recordInflight = new Map()

/**
 * 读落盘记录；force 时按 sessionId 去重。
 * 首屏拉起、编辑器补定位、「重新读取」按钮可能同时打到同一个会话，
 * 没必要为此发多份请求（记录可能很大，逐帧解压有成本）。
 *
 * `domSignature` 必须一路带到 `loadRecord`：只有真正发了请求的那一次才
 * 记下「当时页面长什么样」，过期判定才有基准。见 record.mjs 的
 * recordNeedsRefresh 注释。
 */
function readRecord(sessionId, options = {}) {
  if (options.force !== true) return loadRecord(sessionId, options)
  const hit = recordInflight.get(sessionId)
  if (hit !== undefined) return hit
  const pending = loadRecord(sessionId, { force: true, domSignature: options.domSignature })
    .finally(() => recordInflight.delete(sessionId))
  recordInflight.set(sessionId, pending)
  return pending
}

/**
 * apply() 注入的重扫调度器。编辑器是模块级函数，够不到 apply 的闭包；
 * 补定位成功后要触发一次扫描把操作条的「已定位」记号刷上。
 */
let scheduleScanRef = null

/**
 * apply() 注入的「记录过期就自动重读」。scan() 同样是模块级函数，
 * 而退避状态（上次重读时间、连续无果次数）在 apply 的闭包里更自然。
 */
let refreshRecordRef = null

/**
 * apply() 注入的「现取页面块签名」。openBlockEditor 也是模块级函数，
 * 它补定位/手动重读时要把签名一起带上，否则那份新快照没有比较基准，
 * 下一轮扫描会立刻把它判成过期（多余的一读）。
 */
let domSignatureNowRef = () => ''

/** 编辑态：同一时刻只允许一个编辑器打开。 */
let openEditor = null

function log(...args) {
  try { console.warn('[dsh-reply-forge-v3]', ...args) } catch { /* 忽略 */ }
}

/** 是否为本插件注入的 UI 节点。 */
function isOwnUi(el) {
  const cls = el.classList
  if (cls === undefined || cls === null) return false
  for (const name of OWN_UI_CLASSES) if (cls.contains(name)) return true
  return false
}

/**
 * 取节点内**不属于本插件 UI** 的文本（规范化空白）。
 *
 * 为什么不能直接用 textContent：接管后我们往块里塞了操作条与提示行，
 * 它们的文字会被算进「正文」，于是下一轮扫描算出的文本与磁盘对不上，
 * 精确匹配全部失效、退化成按顺序猜位置。这个坑在 v1 就存在（编辑框里
 * 会莫名多出「伪造回复」四个字），v2 里因为要拿它比对落盘记录，
 * 后果从「难看」升级成「定位错误」，所以必须从根上解决。
 */
function ownText(el) {
  const kids = el.children ?? []
  if (kids.length === 0) return String(el.textContent ?? '').replace(/\s+/g, ' ').trim()
  let out = ''
  for (const child of kids) {
    if (isOwnUi(child)) continue
    if (child.tagName === 'TEXTAREA' || child.tagName === 'BUTTON') continue
    out += ownText(child) + ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** 建一个按钮。 */
function makeButton(doc, label, title, onClick, extra = {}) {
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'rf3-btn'
  btn.textContent = label
  if (typeof title === 'string' && title !== '') btn.title = title
  for (const [k, v] of Object.entries(extra)) {
    if (v === true) btn.setAttribute(k, '')
    else if (v !== false && v !== null && v !== undefined) btn.setAttribute(k, String(v))
  }
  btn.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    try { onClick() } catch (error) { log('按钮回调失败', error) }
  })
  return btn
}

/** 宿主持话输入框：contenteditable 的 Lexical 宿主，带官方 data 属性。 */
const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

/** 最近一次焦点交还的结果（供调试命名空间与保存后的提示行读取）。 */
let lastFocusHandoff = null

/** 元素的简短描述（排查时认得出是谁）。 */
function describeEl(el) {
  if (el === null || el === undefined) return 'null(<body>)'
  const cls = typeof el.className === 'string' && el.className !== ''
    ? '.' + el.className.split(/\s+/).filter(Boolean).join('.')
    : ''
  return String(el.tagName) + cls
}

/**
 * 页面上所有宿主持话输入框候选。
 *
 * 不能想当然只有一个：宿主在同一文档里可能渲染多个带 `data-composer-input`
 * 的节点（隐藏副本 / portal / 任务面板）。`querySelector` 只认 document order
 * 第一个——真机上「焦点交还了还是打不了字」的一种成因就是焦点落在了一个
 * 不可见的副本上：`focus()` 确实成功了、提示行也报了成功，但用户眼前那个
 * 输入框根本没有光标。
 */
function composerCandidates(doc) {
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return []
  try {
    return [...doc.querySelectorAll(COMPOSER_INPUT_SELECTOR)]
  } catch {
    return []
  }
}

/** 候选是否可见（有实际盒子）。探测不到时按可见算，不冤枉它。 */
function composerVisible(el) {
  try {
    if (el.isConnected === false) return false
  } catch { /* 桩上没有 isConnected */ }
  if (typeof el.getClientRects === 'function') {
    try {
      const rects = el.getClientRects()
      if (rects !== null && rects !== undefined && rects.length === 0) return false
    } catch { /* 忽略 */ }
  }
  return true
}

/** 候选是否落在 inert 子树里（宿主 modal/遮罩张开时会这么标整个区域）。 */
function composerInert(el) {
  try { if (el.inert === true) return true } catch { /* 忽略 */ }
  try {
    if (typeof el.closest === 'function' && el.closest('[inert]') !== null) return true
  } catch { /* 忽略 */ }
  return false
}

/**
 * 挑一个最可能「用户眼前那个」输入框。
 * 优先级：可编辑 > 不在 inert 子树 > 可见；同级取 document order 第一个
 * （单输入框的普通页面行为不变）。
 * @returns {{el: HTMLElement|null, total: number}}
 */
function pickComposerTarget(doc) {
  const all = composerCandidates(doc)
  const editable = all.filter(el => {
    try { return el.isContentEditable === true } catch { return false }
  })
  const pool = editable.length > 0 ? editable : all
  let best = null
  let bestScore = -1
  for (const el of pool) {
    let score = 0
    if (composerInert(el) !== true) score += 2
    if (composerVisible(el) === true) score += 1
    if (score > bestScore) { best = el; bestScore = score }
  }
  return { el: best, total: all.length }
}

/**
 * selection 是否已经在输入框里。
 * @returns {boolean}
 */
function selectionInComposer(doc, el) {
  if (el === null || el === undefined) return false
  try {
    const view = (doc && typeof doc.defaultView === 'object' && doc.defaultView !== null)
      ? doc.defaultView
      : (typeof window === 'object' && window !== null ? window : null)
    if (view === null || typeof view.getSelection !== 'function') return false
    const sel = view.getSelection()
    if (sel === null || sel === undefined) return false
    const node = sel.anchorNode ?? sel.focusNode ?? null
    if (node === null) return false
    return node === el || (typeof el.contains === 'function' && el.contains(node) === true)
  } catch {
    return false
  }
}

/**
 * 保证输入框里有一个折叠光标。
 *
 * 程序化 `focus()` 之后 Chromium 一般会自建 selection，但 Lexical 宿主里
 * selection 落在别处（甚至没有 range）时键盘事件会被无视——现象正是
 * 「有焦点、能点、就是打不了字」。这里兜底：selection 不在输入框里就
 * 建一个光标放开头，不抢用户已有的选区。
 */
function ensureComposerSelection(doc, el) {
  if (el === null || el === undefined) return
  try { if (el.isContentEditable !== true) return } catch { return }
  if (selectionInComposer(doc, el) === true) return
  try {
    const view = (doc && typeof doc.defaultView === 'object' && doc.defaultView !== null)
      ? doc.defaultView
      : (typeof window === 'object' && window !== null ? window : null)
    if (view === null || typeof view.getSelection !== 'function') return
    const sel = view.getSelection()
    if (sel === null || sel === undefined) return
    if (typeof doc.createRange !== 'function') return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch { /* 光标兜底失败不影响主流程 */ }
}

/**
 * 把焦点还给宿主持话输入框。
 *
 * 宿主输入框没有稳定 id，但 `ComposerContentEditable` 永远带
 * `data-composer-input`（editable 与 inert 两种状态同一个节点）。inert
 * 状态（无会话/被锁/机审中）下这个 div 的 contentEditable 为 false，
 * **根本不可聚焦**，`focus()` 是无害的无操作——所以必须把「交还结果」
 * 如实记下来，不能假设成功。宿主自己的工具栏就是这么把焦点拉回输入框的
 * （`keepDraftFocus`），所以这条路是它支持的用法，不是私有 hack。
 *
 * 选目标用 pickComposerTarget（可能不止一个输入框节点），交还后兜底
 * 补一个光标（ensureComposerSelection）。
 *
 * @returns {{ok: boolean, editable: boolean, reason: string, detail: string}}
 */
function focusHostComposer(doc) {
  const { el, total } = pickComposerTarget(doc)
  if (el === null || typeof el.focus !== 'function') {
    lastFocusHandoff = { ok: false, editable: false, reason: 'no-input', candidates: total, detail: '页面里没有 ' + COMPOSER_INPUT_SELECTOR }
    return lastFocusHandoff
  }
  let called = false
  try { el.focus({ preventScroll: true }); called = true } catch {
    try { el.focus(); called = true } catch { called = false }
  }
  const landed = (doc.activeElement ?? null) === el
  let editable = false
  try { editable = el.isContentEditable === true } catch { /* 忽略 */ }
  if (landed === true) ensureComposerSelection(doc, el)
  lastFocusHandoff = {
    ok: landed,
    editable,
    candidates: total,
    reason: landed ? 'ok' : (editable ? (called ? 'focus-noop' : 'focus-threw') : 'not-editable'),
    detail: describeEl(el) + (total > 1 ? '（共 ' + total + ' 个输入框候选，取的是可见/可编辑的那个）' : ''),
  }
  return lastFocusHandoff
}

/**
 * 焦点守候：交还之后宿主仍可能把焦点弄丢（异步重渲染 / 状态翻转），真机上
 * 表现为「保存完输入框打不了字」。这里在随后 ~700ms 内盯着：焦点掉回
 * <body> 就重新交还；焦点落在别处（用户或宿主有意为之）或用户一操作
 * （keydown / pointerdown）立即收工。只在真正交还过之后调用，
 * 且守候窗口很短，不会跟用户抢焦点。
 */
function keepComposerFocus(doc) {
  try {
    let ticks = 0
    const stop = () => {
      try { doc.removeEventListener('keydown', onUser, true) } catch { /* 忽略 */ }
      try { doc.removeEventListener('pointerdown', onUser, true) } catch { /* 忽略 */ }
    }
    const onUser = () => stop()
    doc.addEventListener('keydown', onUser, true)
    doc.addEventListener('pointerdown', onUser, true)
    const tick = () => {
      ticks += 1
      if (ticks > 6) { stop(); return }
      const active = doc.activeElement ?? null
      if (active !== null && active !== doc.body) { stop(); return }
      const el = typeof doc.querySelector === 'function' ? doc.querySelector(COMPOSER_INPUT_SELECTOR) : null
      if (el === null) { stop(); return }
      try { el.focus({ preventScroll: true }) } catch { /* 忽略 */ }
      window.setTimeout(tick, 120)
    }
    window.setTimeout(tick, 120)
  } catch { /* 守候失败不影响主流程 */ }
}

/** 打字保险丝的当前处理器与定时器句柄（ disarm 用）。 */
let typingGuardHandler = null
let typingGuardExtras = null
let typingGuardTimer = null

function disarmTypingGuard() {
  try {
    if (typeof window !== 'undefined' && window !== null) {
      if (typingGuardHandler !== null) {
        try { window.removeEventListener('keydown', typingGuardHandler, true) } catch { /* 忽略 */ }
      }
      if (typingGuardExtras !== null) {
        try { window.removeEventListener('focusin', typingGuardExtras.onFocusIn, true) } catch { /* 忽略 */ }
        try { window.removeEventListener('pointerdown', typingGuardExtras.onPointer, true) } catch { /* 忽略 */ }
      }
      if (typingGuardTimer !== null) {
        try { window.clearTimeout(typingGuardTimer) } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
  typingGuardHandler = null
  typingGuardExtras = null
  typingGuardTimer = null
}

/** 按键目标是可编辑区吗（我们自己的编辑器 / 宿主任何输入控件）。 */
function isEditableTarget(target) {
  if (target === null || target === undefined) return false
  try {
    const tag = String(target.tagName ?? '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (target.isContentEditable === true) return true
    if (typeof target.closest === 'function') {
      if (target.closest('.rf3-editor') !== null) return true
      if (target.closest('[data-composer-input]') !== null) return true
    }
  } catch { /* 忽略 */ }
  return false
}

/**
 * 打字保险丝：交还焦点之后一段时间内，如果按键打不到任何可编辑元素
 * （焦点又被宿主异步弄丢了，守候窗口已经结束），当场把焦点拉回输入框。
 *
 * 为什么需要它：keepComposerFocus 只守 ~700ms，而宿主可能在扫描重读、
 * 状态翻转之后的任意时刻把焦点弄丢——真机现象就是「提示行说焦点交还了，
 * 但就是打不了字」。装在 window 的 capture 段：事件到目标之前就先处理，
 * 第一个键也不会白白吞掉（目标还是 body，字符本来哪里也不去）。
 *
 * 只動靜态「无处可去」的键：修饰键组合（快捷键，如 Alt+Shift+E）一律不碰；
 * 焦点落到任何别的可编辑元素（用户有意为之，哪怕是用键盘 Tab 过去的）、
 * 或者任何 pointerdown，都立即解除，绝不跟用户抢焦点。
 */
function armTypingGuard(doc) {
  disarmTypingGuard()
  try {
    if (typeof window === 'undefined' || window === null || typeof window.addEventListener !== 'function') return
    const pull = event => {
      if (event === null || event === undefined) return
      // 快捷键不是打字，绝不拦截
      if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return
      const target = event.target ?? null
      if (isEditableTarget(target) === true) { disarmTypingGuard(); return }
      const { el } = pickComposerTarget(doc)
      if (el === null || typeof el.focus !== 'function') return
      try { el.focus({ preventScroll: true }) } catch { try { el.focus() } catch { /* 忽略 */ } }
      ensureComposerSelection(doc, el)
    }
    // 用户把焦点放到别处（Tab / 宿主快捷键）→ 立即让位
    const onFocusIn = event => {
      const t = (event && event.target) ?? null
      if (t === null || t === undefined) return
      if (isEditableTarget(t) === true) {
        try { if (t.getAttribute && t.getAttribute('data-composer-input') === null) disarmTypingGuard() } catch { /* 忽略 */ }
      } else {
        disarmTypingGuard()
      }
    }
    const onPointer = () => disarmTypingGuard()
    typingGuardHandler = pull
    window.addEventListener('keydown', pull, true)
    window.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('pointerdown', onPointer, true)
    typingGuardExtras = { onFocusIn, onPointer }
    typingGuardTimer = window.setTimeout(disarmTypingGuard, 60000)
  } catch { /* 保险丝装上失败不影响主流程 */ }
}

/** 恢复这个块操作条的显示（openBlockEditor 期间会把它藏起来防压编辑器）。 */
function unhideBlockBar(block) {
  try {
    for (const child of (block.children ?? [])) {
      if (child.classList !== undefined && child.classList.contains('rf3-bar')) {
        child.style.display = ''
      }
    }
  } catch { /* 忽略 */ }
}

/** 关闭当前编辑器（有未保存改动时丢弃）。
 *
 *  焦点必须显式交还宿主输入框：编辑器是就地插在消息块里的 textarea，
 *  关掉时连节点一起被抹走。若此刻它正拿着焦点，焦点会掉到 <body>——
 *  真机表现是「写完伪造后下方输入框打不了字、没有光标，点一下 + 添加文件
 *  才能继续输入」（工具栏 mousedown 会把焦点拉回输入框，所以看起来像
 *  「添加文件才能好」）。
 *
 *  `refocus:false` 给「换上另一个编辑器」用：那边紧接着会 focus 新
 *  textarea，中途再去碰宿主输入框只会多一次无谓的焦点抖动。
 */
function closeEditor(options = {}) {
  if (openEditor === null) return
  const { wrap, poll } = openEditor
  // 轮询中的等待编辑器（queue-wait）必须在这里停掉，否则 closeEditor 之后
  // 定时器还在跑，会把已经关掉的 wrap 又填上内容。
  if (poll !== undefined && poll !== null) {
    try { clearInterval(poll) } catch { /* 忽略 */ }
  }
  const doc = openEditor.doc ?? wrap.ownerDocument ?? document
  const block = openEditor.block
  const active = doc.activeElement ?? null
  const hadFocus = active !== null && wrap.contains(active)
  openEditor = null
  if (hadFocus === true) {
    try { active.blur() } catch { /* 忽略 */ }
  }
  try { wrap.remove() } catch { /* 忽略 */ }
  if (block !== undefined && block !== null) unhideBlockBar(block)
  if (hadFocus === true && options.refocus !== false) {
    const handoff = focusHostComposer(doc)
    // 守候只在「以为交还出去了」或「交还失败但输入框可编辑」时有必要：
    // 前者防宿主异步把焦点又弄丢，后者给宿主状态翻转留一次机会。
    if (handoff.ok === true || handoff.editable === true) {
      keepComposerFocus(doc)
      armTypingGuard(doc)
    }
  }
}

/**
 * 关闭「这个块上」的编辑器，并按上面同样的规则交还焦点。
 *
 * 与 closeEditor 的分工有两点，都是被真机 bug 逼出来的：
 *  1. **先关再抹**。写入伪造 / 仅本机渲染 / 操作条上的「还原」都会就地重写
 *     消息块（applyOverride 连编辑器节点一起清掉）。若等抹完再判断「编辑器
 *     有没有焦点」，wrap 早已不在文档里，焦点也早就掉到 <body> 了——所以必须
 *     在抹块之前把焦点交出去。
 *  2. **只认这个块**。操作条上的「还原」在任何一个块上都能被点，不该顺手关掉
 *     用户正在另一个块里开着的编辑器。
 */
function closeEditorOnBlock(doc, block, options = {}) {
  if (openEditor === null || openEditor.block !== block) return
  const { wrap } = openEditor
  const active = doc.activeElement ?? null
  const inside = active !== null && wrap.contains(active)
  // **焦点本来在编辑器里、但关闭前掉了，也要交还**。真机 bug（2026-10-16 晚：
  // 第一轮修完「仅本机渲染」好了、「写入伪造」还是没光标）：点「写入伪造」后
  // 我们会 disable 两个按钮防止重复提交，而 Chromium 的规矩是**聚焦元素被
  // disable 时焦点立刻掉到 <body>**——等异步写完再来 closeEditorOnBlock 时
  // activeElement 已经是 body，只看「此刻在不在 wrap 里」会把交还整段跳过，
  // 焦点永远停在 body。「仅本机渲染」是同步路径、从不断开焦点，所以同样
  // 是保存，一条好一条坏。hadFocusAtClick 就是调用方在点击当场记下的
  // 「焦点原本在编辑器里」，用它把这条漏网的路径捞回来。
  const lostToBody = active === null || active === doc.body
  const hadFocus = inside === true
    || (lostToBody === true && options.hadFocusAtClick === true)
  openEditor = null
  if (inside === true) {
    try { active.blur() } catch { /* 忽略 */ }
  }
  try { wrap.remove() } catch { /* 忽略 */ }
  unhideBlockBar(block)
  if (hadFocus === true && options.refocus !== false) {
    const handoff = focusHostComposer(doc)
    if (handoff.ok === true || handoff.editable === true) {
      keepComposerFocus(doc)
      armTypingGuard(doc)
    }
  } else if (options.refocus !== false) {
    // 交还被跳过也要留痕，提示行不许对焦点状态沉默（吃过亏，见 recordFocusSkip）。
    recordFocusSkip(doc)
  }
}

/**
 * 拆除本插件注入的全部 UI（操作条、编辑器、定位上下文），
 * 但保留监听与覆盖数据 —— 供 setEnabled(false) 实时停用后重新启用。
 */
function stripInjectedUI() {
  closeEditor()
  for (const el of [...document.querySelectorAll('[' + TAKEN_ATTR + ']')]) {
    el.removeAttribute(TAKEN_ATTR)
    el.removeAttribute(EDIT_ATTR)
    if (el.classList !== undefined && el.classList.contains('rf3-host')) el.classList.remove('rf3-host')
    for (const own of [...el.querySelectorAll('.rf3-bar, .rf3-editor, .rf3-note')]) own.remove()
  }
  // 待发送气泡不是消息块，不带 TAKEN_ATTR，得单独拆：
  // 停用后残留一个「改待发送」按钮是会真点出东西来的。
  for (const el of [...document.querySelectorAll('[' + PENDING_TAKEN_ATTR + ']')]) {
    el.removeAttribute(PENDING_TAKEN_ATTR)
    if (el.classList !== undefined) el.classList.remove('rf3-pending')
    for (const own of [...el.querySelectorAll('[data-rf3-pending-btn], .rf3-pending-bar, .rf3-editor, .rf3-note')]) own.remove()
  }
}

/** 原文缓存：指纹 → 原文，供「还原」时重建。 */
const originals = new Map()

function rememberOriginal(fp, text) {
  if (typeof fp !== 'string') return
  if (!originals.has(fp)) originals.set(fp, text)
}

function fpOriginal(block, fp) {
  return originals.get(fp) ?? ownText(block)
}

/** 一条状态行（定位结果 / 写入结果）。 */
function makeNote(doc, kind, text) {
  const el = doc.createElement('div')
  el.className = 'rf3-note rf3-note-' + kind
  el.textContent = text
  return el
}

/**
 * 焦点交还结果的一行摘要，挂在保存后的状态行上。
 * 交还失败时把原因写明白——真机排查「保存后输入框打不了字」时，
 * 这一行就是第一手证据（no-input / not-editable / focus-noop）。
 */
function focusNoteSuffix() {
  const h = lastFocusHandoff
  if (h === null) return ''
  if (h.ok === true) {
    // 多个输入框候选时如实标注「择优」——真机排查「交还了却打不了字」时，
    // 这一行能直接区分「抓对了节点」和「抓错副本」两种情形。
    if (typeof h.candidates === 'number' && h.candidates > 1) {
      return ' · 焦点已交还输入框（页面有 ' + h.candidates + ' 个输入框候选，已择优）'
    }
    return ' · 焦点已交还输入框'
  }
  if (h.reason === 'focus-not-in-editor') return ' · ⚠ 焦点未交还：关闭编辑器时焦点已不在编辑器里'
  if (h.reason === 'no-input') return ' · ⚠ 焦点未交还：页面上没有输入框'
  if (h.reason === 'not-editable') return ' · ⚠ 焦点未交还：输入框暂不可编辑'
  return ' · ⚠ 焦点未交还：' + h.reason
}

/**
 * 关闭编辑器但没有交还焦点时，如实记录原因。
 *
 * 提示行不能对焦点状态保持沉默——第一轮修复就吃过这个亏：交还代码整段没跑，
 * 块上什么也不显示，用户只看到「没光标」，排查只能靠猜。
 */
function recordFocusSkip(doc) {
  const el = typeof doc.querySelector === 'function' ? doc.querySelector(COMPOSER_INPUT_SELECTOR) : null
  lastFocusHandoff = {
    ok: false,
    editable: el === null ? false : el.isContentEditable === true,
    reason: 'focus-not-in-editor',
    detail: '关闭编辑器时焦点已不在编辑器里',
  }
}

/**
 * 焦点排查探针（挂在 window.__dshReplyForgeV3.focus）。
 *
 * 真机排查「保存后输入框打不了字」的第一手证据源。字段一律放平并附
 * summary 一行摘要——DevTools 里 `JSON.stringify(__dshReplyForgeV3.focus())`
 * 一次复制就能拿全（对象折叠会把最关键的 reason 藏掉，踩过）。
 *
 * 附 `trace(ms)`：先调用拿到 Promise，再去操作界面，ms 后 resolve 出
 * 200ms 粒度的焦点轨迹（active/editable/selection/guard 四列）。
 */
function makeFocusProbe(doc) {
  const probe = () => {
    const { el: c, total } = pickComposerTarget(doc)
    const a = doc.activeElement ?? null
    const h = lastFocusHandoff
    const composerEditable = c === null
      ? null
      : (() => { try { return c.isContentEditable === true } catch { return null } })()
    const visible = c === null ? null : composerVisible(c)
    const selIn = selectionInComposer(doc, c)
    const guardArmed = typingGuardHandler !== null
    const out = {
      lastOk: h === null ? null : h.ok,
      lastReason: h === null ? null : h.reason,
      lastEditable: h === null ? null : h.editable,
      lastCandidates: h === null ? null : h.candidates,
      composerEditable,
      composerVisible: visible,
      composerTotal: total,
      active: describeEl(a),
      activeIsComposer: a === c,
      selectionInComposer: selIn,
      guardArmed,
    }
    out.summary = 'last.ok=' + out.lastOk + ' reason=' + out.lastReason
      + ' | composer.editable=' + out.composerEditable + ' visible=' + out.composerVisible
      + ' total=' + out.composerTotal
      + ' | active=' + out.active + ' selIn=' + out.selectionInComposer
      + ' | guard=' + (out.guardArmed ? 'armed' : 'off')
    // 旧字段名兼容（早期排查脚本/说明里引过）
    out.last = h
    out.composer = c === null ? null : {
      editable: composerEditable,
      attr: typeof c.getAttribute === 'function' ? c.getAttribute('contenteditable') : null,
      visible,
    }
    return out
  }
  probe.trace = (ms = 8000) => new Promise(resolve => {
    const samples = []
    const events = []
    const TRACED = ['keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste', 'focusin', 'focusout', 'blur']
    const listeners = []
    const record = type => event => {
      // 只记录，绝不 preventDefault/stopPropagation——取证工具不许改变行为
      const t = (event && event.target) !== undefined ? event.target : null
      let desc = 'null'
      if (t !== null && t !== undefined) {
        const cls = typeof t.className === 'string' && t.className !== ''
          ? '.' + t.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
          : ''
        desc = String(t.tagName ?? '?') + cls
      }
      const rec = { t: Date.now(), type, target: desc }
      if (typeof event.key === 'string') rec.key = event.key
      if (typeof event.data === 'string') rec.data = event.data.slice(0, 24)
      if (typeof event.defaultPrevented === 'boolean') rec.prevented = event.defaultPrevented
      events.push(rec)
    }
    for (const type of TRACED) {
      const fn = record(type)
      listeners.push([type, fn])
      try { window.addEventListener(type, fn, true) } catch { /* 忽略 */ }
    }
    const started = Date.now()
    const cleanup = () => {
      for (const [type, fn] of listeners) {
        try { window.removeEventListener(type, fn, true) } catch { /* 忽略 */ }
      }
    }
    const tick = () => {
      const s = probe()
      samples.push({
        t: Date.now() - started,
        active: s.active,
        activeIsComposer: s.activeIsComposer,
        editable: s.composerEditable,
        selIn: s.selectionInComposer,
        guard: s.guardArmed,
      })
      if (Date.now() - started >= ms) {
        cleanup()
        resolve({ samples, events })
        return
      }
      try { window.setTimeout(tick, 200) } catch { cleanup(); resolve({ samples, events }) }
    }
    tick()
  })
  return probe
}

/**
 * 把覆盖文本应用到节点：清空宿主渲染结果，换成本插件渲染的 Markdown。
 *
 * 注意它会**连操作条一起清掉**（block 的子节点被整体重置），调用方必须
 * 紧接着重新 attachBar，否则块会处于「已接管但没有操作条」的中间态——
 * 扫描器会把它当作需要重新接管，而那时的正文已被换成渲染结果，
 * 拿它去比对磁盘就会错位。
 */
function applyOverride(block, text, prefs, docOverride) {
  block.textContent = ''
  renderMarkdown(block, text, docOverride ?? block.ownerDocument)
  if (prefs.autoMark === true) block.setAttribute(EDIT_ATTR, '')
  else block.removeAttribute(EDIT_ATTR)
}

/**
 * 挂（或重建）操作条。幂等：已存在就清空重建，不产生第二条。
 *
 * 传 `getSessionId` 而不是 `sessionId` 值：宿主切会话时不改 URL，我们靠
 * DOM 属性发现切换，而操作条是**在旧节点上**挂的——若把 id 固定在闭包里，
 * 切换后点「伪造回复」就会去读/写上一个会话。每次用的时候现取才安全。
 * @returns {HTMLElement} 操作条节点
 */
function attachBar(block, doc, getSessionId, prefs, match) {
  let bar = null
  for (const child of (block.children ?? [])) {
    if (child.classList !== undefined && child.classList.contains('rf3-bar')) { bar = child; break }
  }
  if (bar === null) {
    bar = doc.createElement('div')
    bar.className = 'rf3-bar'
    block.append(bar)
  }
  bar.textContent = ''
  // 重建即恢复显示：编辑器开着时这个块的bar会被藏起来（防压住编辑器），
  // 关闭编辑器 → attachBar 重建 → 这里负责把它放回来。
  bar.style.display = ''

  const sessionId = getSessionId()
  const fp = taken.get(block)
  const forgeBtn = makeButton(doc, '伪造回复', '就地编辑这条 AI 回复', () => openBlockEditor(block, getSessionId, prefs, doc))
  if (match !== null && match !== undefined) forgeBtn.setAttribute('data-rf3-linked', '')
  bar.append(forgeBtn)
  const override = fp === undefined ? undefined : loadOverrides(sessionId)[fp]
  if (override !== undefined && typeof override.text === 'string') {
    bar.append(makeButton(doc, '还原', '删除本条本机覆盖', () => {
      removeOverride(sessionId, fp)
      block.removeAttribute(EDIT_ATTR)
      // 先交还焦点再抹块：编辑器可能正开在这个块上且拿着焦点，
      // 直接 applyOverride 会让焦点掉到 <body>（真机 bug 的成因）。
      closeEditorOnBlock(doc, block)
      applyOverride(block, fpOriginal(block, fp), prefs, doc)
      attachBar(block, doc, getSessionId, prefs, match)
    }, { 'data-active': true }))
  }
  return bar
}

/**
 * 待发送气泡的接管标记。
 *
 * 与 TAKEN_ATTR 分开：pending 气泡不是助手消息块，不该进 takeBlock 那条
 * 接管链（那边的计数、指纹、定位全是围绕落盘记录设计的）。
 */
const PENDING_TAKEN_ATTR = 'data-rf3-pending'

/** 宿主渲染 pending 气泡用的属性（dsh-client-ui-chat 的 UserStyleBubble）。 */
const PENDING_BUBBLE_ATTR = 'data-pending-steering'

/**
 * 取气泡文本时要剔除的节点：宿主时钟 + **本插件注入的一切 UI**。
 *
 * 后者是必须的：编辑按钮和编辑器卡片就挂在气泡容器里，不剔除的话按钮一挂上，
 * 按钮文字就成了「消息内容」的一部分，文本回匹从此永远失败。这与 ownText 用
 * isOwnUi 跳过自有 UI 是同一条纪律。
 */
const PENDING_TEXT_SKIP = '[data-clock], [data-rf3-pending-btn], .rf3-pending-bar, .rf3-editor, .rf3-note'

/**
 * 取当前会话的 ISession。
 *
 * 三个可能扑空的地方都按「读不到」处理，让上层提示稍后再试：
 *   1. sessionId 还是占位值（会话容器没挂出来）；
 *   2. sessionsRef 没被 apply 注入（apply 失败 / 测试环境）；
 *   3. binding 还没有 session（会话正在打开，投影还没就绪）。
 */
function resolveSession(sessions, sessionId) {
  if (isPlaceholderSession(sessionId)) return null
  if (sessions === null || sessions === undefined) return null
  if (typeof sessions.binding !== 'function') return null
  try {
    const binding = sessions.binding(sessionId)
    if (binding === null || binding === undefined) return null
    const session = binding.session
    return session === null || session === undefined ? null : session
  } catch {
    return null
  }
}

/**
 * 打开待发送消息编辑器：把气泡就地换成 textarea，保存走官方 updateQueue。
 *
 * 与 openBlockEditor 的区别很大，原因就一句话：**消息还没进日志**。所以没有
 * 两步确认、没有目标下拉、没有落盘出口、没有覆盖表——改它就是改「即将发生
 * 的请求」，不存在投影失配、缓存作废、自造事件那一串后果，自然也不需要
 * 为它们准备的防护。
 *
 * 定位放在打开时做：气泡文本 ↔ 队列行文本的回匹只有一次机会，用户开始打字
 * 之后气泡与队列的关系就说不清了（宿主动态刷新队列）。定位失败就不给
 * textarea，只说明原因——不给一个「保存了却不知道改的是哪条」的输入框。
 */
function openQueueEditor(bubble, sessions, docOverride) {
  closeEditor({ refocus: false })
  // 同 openBlockEditor：编辑器开着期间用户在 textarea 里打字是正经输入，
  // 不能被「拉回宿主输入框」的保险丝干扰。
  disarmTypingGuard()
  const doc = docOverride ?? bubble.ownerDocument ?? document
  const sessionId = currentSessionId(doc)
  // 点到的气泡是宿主气泡还是本地回显（消息在途时界面显示回显），诊断要能看出来。
  let bubbleKind = 'unknown'
  try {
    bubbleKind = bubble.hasAttribute('data-submission-echo') ? 'echo' : 'host'
  } catch { /* 合成节点没有 hasAttribute，忽略 */ }

  const wrap = doc.createElement('div')
  wrap.className = 'rf3-editor'

  const label = doc.createElement('div')
  label.className = 'rf3-hint'
  label.textContent = '编辑待发送消息'

  /** 定位或会话没就绪时：只留说明，不给输入框。附一行诊断（排查真机故障用）。 */
  const failOpen = (text, diag) => {
    wrap.textContent = ''
    wrap.append(label, makeNote(doc, 'warn', text))
    if (diag !== undefined) {
      let line = ''
      try { line = JSON.stringify(diag) } catch { line = String(diag) }
      const note = makeNote(doc, 'info', '诊断：' + line)
      note.setAttribute('data-rf3-queue-diag', '')
      wrap.append(note)
      try {
        console.error('[rf3] 待发送队列读取失败：' + text, diag)
        // 落一份到本地存储，真机上没开 devtools 也能事后取（diagnostics only）。
        const store = doc.defaultView?.localStorage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
        store?.setItem('dsh-reply-forge-v3:queueDiag', JSON.stringify({ at: Date.now(), error: text, diag }))
      } catch { /* 诊断渠道失败不影响提示 */ }
    }
    bubble.append(wrap)
    openEditor = { wrap, doc, kind: 'queue', anchor: bubble }
  }

  const session = resolveSession(sessions, sessionId)
  if (session === null) {
    failOpen('当前会话还没准备好，稍后再试', queueDiag(null, { sessionId, bubbleKind }))
    return
  }
  const bubbleText = bubbleTextOf(bubble, PENDING_TEXT_SKIP)
  const bubbleHead = bubbleText.slice(0, 40)

  // ① 强锚点：接管气泡时预取的 itemId 还在队列里就直接用，不赌文本。
  //    行已离开队列（回合结束被 claim）才会失败——那时下面的完整路径会给出
  //    「已经发出去了」的诚实结论。
  const anchor = pendingAnchors.get(bubble)
  if (anchor !== undefined) {
    const byId = resolvePendingItemById(readInboxRows(session), anchor.itemId)
    if (byId.ok === true) {
      buildQueueEditor(session, byId.itemId, byId.text, bubble, doc, wrap, label)
      return
    }
  }

  // ② 严格回匹：界面同源条件（next-step 且 source.kind === 'user'）。
  //    kind 不放松——宿主 prompt 走的永远是 user 行，kind 不同的行都是插件
  //    注入，不是用户待发送的消息。
  const inbox = readInbox(session)
  const resolved = resolvePendingItem(inbox, bubbleText)
  if (resolved.ok === true) {
    buildQueueEditor(session, resolved.itemId, resolved.text, bubble, doc, wrap, label)
    return
  }

  // ③ 在途等待：投影里没有这条，但消息可能刚从输入框发出——此期间界面显示本地
  //    回显（data-submission-echo），回显在 inbox 投影出现同 rpcId 行时退役。
  //    回显还在就等它落库，别急着报错（2026-10-21 真机 bug：用户在这个窗口里
  //    点「改待发送」，前两个版本都直接报「读不到」）。
  if (hasPendingEcho(session, bubbleText)) {
    waitForInboxLanding(session, bubbleText, bubble, doc, wrap, label, failOpen, sessionId, bubbleKind, bubbleHead, anchor)
    return
  }

  // ④ 诚实失败：按「为什么没匹上」分别说明，别再一句笼统的「无法定位」。
  //    队列空 / 有同文本但非用户行（插件注入）/ 有行但都对不上（用户点的那条
  //    已离开队列——回合结束 claim 后插件又补了行）。最后交叉验证对话里是否
  //    已有同文本的已发送气泡：有的话这条消息已经发出去了，队列编辑本就无能为力。
  const rows = readInboxRows(session)
  const sent = findSentBubble(doc, bubbleText)
  const specific = resolved.error.includes('附件') || resolved.error.includes('多个相同')
  const sameText = hasTextMatchRow(rows, bubbleText)
  let why
  if (rows === null) {
    why = '读不到待发送队列（投影读取失败），请稍后重试'
  } else if (rows.length === 0) {
    why = '待发送队列是空的——这条消息已经不在队列里了（可能已开始生成）'
  } else if (specific) {
    // 附件 / 同文本撞车是比「不在队列里」更具体的原因，原样透出。
    why = resolved.error
  } else if (sameText === true) {
    why = '队列里有同文本的消息，但它不是待发送的用户消息，无法定位'
  } else {
    why = `队列里有 ${rows.length} 条待发送消息，但都不是你点的这条（它可能已经发出去了）`
  }
  if (sent === true) {
    why += '；对话里已经能看到这条消息，说明它已经发送成功，待发送编辑只对还没发送的消息有效'
  }
  failOpen(why, queueDiag(session, {
    sessionId, bubbleKind, bubbleTextHead: bubbleHead,
    sentInTranscript: sent,
    anchor: anchor === undefined ? 'none' : { itemId: anchor.itemId },
  }))
}

/** 在途轮询的节奏：200ms 一次，最多等 6s（宿主入队通常在 1s 内）。 */
const INBOX_LANDING_POLL_MS = 200
const INBOX_LANDING_TIMEOUT_MS = 6000

/**
 * 消息在途时的等待：轮询 inbox 投影，等这条消息落库后原地换成编辑器。
 *
 * 停下来的条件有三个：落库成功（换编辑器）、超时（如实报错 + 诊断）、
 * wrap 被拔掉（用户按 Esc 或 closeEditor 抢先关掉——轮询回调自停）。
 *
 * @param {string} [bubbleHead] 气泡文本头（只进诊断）
 * @param {{ itemId: string } | undefined} [anchor] 接管时预取的锚点（只进诊断）
 */
function waitForInboxLanding(session, bubbleText, bubble, doc, wrap, label, failOpen, sessionId, bubbleKind, bubbleHead = '', anchor = undefined) {
  const diagExtra = {
    sessionId, bubbleKind, bubbleTextHead: bubbleHead,
    anchor: anchor === undefined ? 'none' : { itemId: anchor.itemId },
  }
  const note = makeNote(doc, 'info', '消息正在进入队列，请稍候…')
  wrap.append(label, note)
  bubble.append(wrap)
  openEditor = { wrap, doc, kind: 'queue-wait', anchor: bubble }
  const deadline = Date.now() + INBOX_LANDING_TIMEOUT_MS
  const timer = setInterval(() => {
    if (openEditor === null || openEditor.wrap !== wrap || wrap.isConnected === false) {
      clearInterval(timer)
      return
    }
    const resolved = resolvePendingItem(readInbox(session), bubbleText)
    if (resolved.ok === true) {
      clearInterval(timer)
      wrap.textContent = ''
      buildQueueEditor(session, resolved.itemId, resolved.text, bubble, doc, wrap, label)
      return
    }
    // 回显消失了但投影还是没有 = 消息没能入队（发送失败 / 已被宿主处理），
    // 不用等满超时。
    if (hasPendingEcho(session, bubbleText) !== true) {
      clearInterval(timer)
      openEditor = null
      failOpen(
        '这条消息没有进入待发送队列（可能发送失败或已被处理）。',
        queueDiag(session, diagExtra)
      )
      return
    }
    if (Date.now() >= deadline) {
      clearInterval(timer)
      openEditor = null
      failOpen(
        '这条消息一直没有进入待发送队列（可能已发出或被宿主拒绝）。若反复出现，请把下面的诊断信息反馈给插件作者。',
        queueDiag(session, diagExtra)
      )
    }
  }, INBOX_LANDING_POLL_MS)
  openEditor.poll = timer
}

/**
 * 构造队列编辑器本体（textarea + 保存/取消）。
 *
 * 不负责把 wrap 挂上气泡——两个调用方（直接定位成功 / 轮询落库后）各自挂，
 * 避免「轮询路径重复 append」。
 */
function buildQueueEditor(session, itemId, text, bubble, doc, wrap, label) {
  const area = doc.createElement('textarea')
  area.value = text
  area.spellcheck = false
  area.setAttribute('aria-label', '编辑待发送消息')
  // 点击保险与 openBlockEditor 同源：真机上宿主会在 mousedown 之后把焦点
  // 弄丢，导致「点进 textarea 不出光标」。只在确实丢了时补 focus，
  // 不抢用户用键盘刻意放在别处的焦点。
  const reassertAreaFocus = () => {
    try {
      const active = doc.activeElement ?? null
      if (active !== area && area.isConnected !== false) {
        if (typeof area.focus === 'function') area.focus()
      }
    } catch { /* 忽略 */ }
  }
  area.addEventListener('mouseup', reassertAreaFocus)
  area.addEventListener('click', reassertAreaFocus)

  const row = doc.createElement('div')
  row.className = 'rf3-row'

  const status = doc.createElement('span')
  status.className = 'rf3-hint'
  status.textContent = '消息还没发给模型 · Ctrl+Enter 保存 · Esc 取消'

  const saveBtn = makeButton(doc, '保存', '修改队列里这条待发送消息', () => submit())
  const cancelBtn = makeButton(doc, '取消', '放弃修改', () => closeEditor())
  row.append(status, saveBtn, cancelBtn)

  area.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    }
  })

  let saving = false
  const submit = async () => {
    if (saving === true) return
    const next = String(area.value ?? '')
    // 与服务端同一条判据（index.js 825 行：必须含非空白字符）。
    if (next.trim() === '') {
      status.textContent = '内容不能为空'
      return
    }
    saving = true
    saveBtn.disabled = true
    cancelBtn.disabled = true
    status.textContent = '保存中…'
    const failure = await submitQueueEdit(session, itemId, next)
    if (failure === null) {
      // inbox 投影会自己刷新气泡，这里不需要重扫；焦点交还由 closeEditor 负责。
      closeEditor()
      return
    }
    // 失败要能把按钮放回来：定位失效（itemId 过期）是失败里最常见的，
    // 用户改完文案重试一次往往就好了，不该被迫重开编辑器。
    saving = false
    saveBtn.disabled = false
    cancelBtn.disabled = false
    status.textContent = failure
    try { area.focus() } catch { /* 忽略 */ }
  }

  wrap.append(label, area, row)
  bubble.append(wrap)
  openEditor = { wrap, doc, kind: 'queue', anchor: bubble }
  try { area.focus() } catch { /* 忽略 */ }
}

/**
 * 给一个 pending 气泡挂编辑入口。幂等：已接管就跳过。
 *
 * 宿主每次刷新队列都会重渲染这些气泡，所以接管必须像 takeBlock 一样可重复
 * 执行——新节点没标记就接管，老节点有标记就跳过。
 *
 * 接管的同时**预取定位锚点**（见 pendingAnchors）：此刻投影与渲染一致，按文本
 * 解析出的 itemId 是点击时可复核的强锚点。
 */
function takePendingBubble(bubble, sessions, doc) {
  if (bubble.hasAttribute(PENDING_TAKEN_ATTR)) return
  bubble.setAttribute(PENDING_TAKEN_ATTR, '')
  // 位置上下文单独加 class，不直接样式化宿主的 data-pending-steering
  // （命名隔离纪律：我们的外观只由 rf3-* 类决定）。
  if (bubble.classList !== undefined) bubble.classList.add('rf3-pending')
  const bar = doc.createElement('div')
  bar.className = 'rf3-pending-bar'
  const btn = makeButton(doc, '改待发送', '修改这条还没发给模型的消息', () => {
    openQueueEditor(bubble, sessions, doc)
  })
  btn.setAttribute('data-rf3-pending-btn', '')
  bar.append(btn)
  bubble.append(bar)
  const anchor = prefetchPendingAnchor(bubble, sessions, doc)
  if (anchor !== null) pendingAnchors.set(bubble, anchor)
}

/**
 * 接管瞬间按气泡文本预取 itemId。
 *
 * 只读投影、全部兜底；失败（投影还没有这行、文本撞车、会话没就绪）就返回
 * null——点击时会走完整定位路径，预取只是优化，不是前提。
 *
 * @returns {{ itemId: string } | null}
 */
function prefetchPendingAnchor(bubble, sessions, doc) {
  try {
    const session = resolveSession(sessions, currentSessionId(doc))
    if (session === null) return null
    const text = bubbleTextOf(bubble, PENDING_TEXT_SKIP)
    const resolved = resolvePendingItem(readInbox(session), text)
    if (resolved.ok !== true) return null
    return { itemId: resolved.itemId }
  } catch {
    return null
  }
}

/**
 * 对话里是否已有同文本的**已发送**用户气泡。
 *
 * 用于「点击的待发送气泡已经不在队列里」时交叉验证：消息若已被回合 claim，
 * 它会以普通用户消息（无 data-pending-steering）出现在对话里。宿主用户行的
 * class 是 CSS module 哈希名（cJsG2q_userRow 之类，会随构建变），所以用
 * `[class*="userRow"]` 宽容匹配。
 *
 * @param {Document} doc
 * @param {string} text 气泡可见文本
 * @returns {boolean}
 */
function findSentBubble(doc, text) {
  try {
    const target = collapseWhitespace(text)
    if (target === '') return false
    const nodes = doc.querySelectorAll('[class*="userRow"]')
    for (const node of nodes) {
      if (typeof node.hasAttribute !== 'function') continue
      // pending 气泡（含自己点的这条）不算「已发送」。
      if (node.hasAttribute('data-pending-steering')) continue
      const seen = collapseWhitespace(bubbleTextOf(node, PENDING_TEXT_SKIP))
      if (seen !== '' && seen === target) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 扫描并接管页面上的待发送气泡。
 *
 * 蹭 scan 的现有节流，不另起调度器：宿主刷新队列和刷新消息流是同一批 React
 * 渲染，多一个 observer 只会更吵。没有 sessions 服务时整段跳过——旧宿主上
 * 这个入口根本不该出现。
 */
function takePendingBubbles(doc) {
  if (sessionsRef === null || sessionsRef === undefined) return
  if (doc === null || doc === undefined) return
  if (typeof doc.querySelectorAll !== 'function') return
  try {
    const bubbles = [...doc.querySelectorAll('[' + PENDING_BUBBLE_ATTR + ']')]
    for (const bubble of bubbles) {
      try {
        takePendingBubble(bubble, sessionsRef, doc)
      } catch (error) {
        log('接管待发送气泡失败', error)
      }
    }
  } catch { /* 忽略 */ }
}

/**
 * 打开编辑器：把一块消息就地换成 textarea，并提供两个保存出口。
 * 会话 id 在**打开这一刻**解析一次并固定：编辑器是模态的，开着的期间
 * 用户不会同时切会话。
 */
function openBlockEditor(block, getSessionId, prefs, docOverride) {
  closeEditor({ refocus: false })
  // 打字保险丝在编辑器开着期间必须解除：用户在 textarea 里打字是正经输入，
  // 且 select/按钮操作不该被「拉回输入框」干扰。
  disarmTypingGuard()
  // 两步确认的已确认指纹：内容/目标/写入方式任一变化即失效（见 saveRecord）。
  let confirmedForge = null
  // 点击「写入伪造」当场记下的「焦点原本在编辑器里」。点击会把焦点放到按钮上，
  // 紧接着的两个 disable 会让 Chromium 把焦点打到 <body>，等异步写完再来关
  // 编辑器时「焦点在不在 wrap 里」已经看不出来——用它把交还那一步捞回来。
  let hadFocusAtClick = false
  const sessionId = getSessionId()
  const doc = docOverride ?? block.ownerDocument ?? document
  // let 而不是 const：记录过期时下面会重读后补定位，结果要能就地更新。
  let match = blockMatch.get(block) ?? null
  // 用户是否从目标下拉里选了**别的**消息（不是页面上这一条）。
  // 选了就要关掉「仅本机渲染」——那条出口只能改本节点在页面上的样子。
  let pickedForeign = false

  // 初值取「当前显示的正文」：有本机覆盖就是覆盖内容，否则是块里非本插件 UI 的文本。
  const blockFp = taken.get(block)
  const applied = blockFp === undefined ? undefined : loadOverrides(sessionId)[blockFp]
  const original = (applied !== undefined && typeof applied.text === 'string')
    ? applied.text
    : ownText(block)

  const wrap = doc.createElement('div')
  wrap.className = 'rf3-editor'

  const label = doc.createElement('div')
  label.className = 'rf3-hint'
  label.textContent = '编辑 AI 回复'

  const area = doc.createElement('textarea')
  area.value = original
  area.spellcheck = false
  area.setAttribute('aria-label', '编辑 AI 回复')
  // 点击保险：真机上出现过「点进 textarea 不出光标」——宿主在 mousedown 之后
  // 把焦点弄丢了（焦点最终停在 <body>）。这里在 click/mouseup（宿主自己的
  // 处理器都跑完之后）检查一次：焦点不在 textarea 上就补 focus。
  // 只在「确实丢了」时动手，不抢用户用键盘刻意放在别处的焦点。
  const reassertAreaFocus = () => {
    try {
      const active = doc.activeElement ?? null
      if (active !== area && area.isConnected !== false) {
        if (typeof area.focus === 'function') area.focus()
      }
    } catch { /* 忽略 */ }
  }
  area.addEventListener('mouseup', reassertAreaFocus)
  area.addEventListener('click', reassertAreaFocus)

  const row = doc.createElement('div')
  row.className = 'rf3-row'

  const status = doc.createElement('span')
  status.className = 'rf3-hint'
  status.textContent = 'Ctrl+Enter 保存 · Esc 取消'

  const spacer = doc.createElement('span')
  spacer.className = 'rf3-spacer'

  // 状态行容器：定位结果与写入结果都往里追加。
  // 注意不能往「已经展开进 DOM 的数组」里 push —— 那样新节点根本不在文档里
  // （踩过：写入失败的提示永远不显示）。
  const notes = doc.createElement('div')
  notes.className = 'rf3-notes'

  const head = [label, notes]

  // 指纹重名警示：宿主不提供稳定消息 id，正文完全相同的两条消息会共享
  // 同一条本机覆盖。落盘出口不受影响（走 seq 寻址），必须分别说明。
  const dup = dupCount.get(block) ?? 1
  if (dup > 1) {
    notes.append(makeNote(doc, 'warn',
      '⚠ 本会话有 ' + dup + ' 条正文完全相同的消息。本机渲染覆盖由它们共享；'
      + '写入伪造只作用于当前这一条。'))
  }

  // ── 落盘定位状态 ────────────────────────────────────────────────────────
  // 定位不到就不给落盘出口：宁可少一个按钮，也不能猜个位置去写。
  // 失败原因要分开讲——「记录没读到」「记录是空的」「这条对不上」是三件
  // 完全不同的事，全都显示同一句话会让排查变成猜谜（踩过）。
  //
  // match 用 let：记录过期时下方会先重读再补定位，定位结果要能就地更新。
  const matchNote = doc.createElement('div')
  let relocating = false

  // 写入方式（v3.1）：用户显式选这次走哪条路。
  // v3 一开始是隐式 auto——宿主自己决定在线还是落盘。真机反馈是「我想自己
  // 控制」，而且两条路的前提（要不要重启、会不会动磁盘）差别太大，不该由
  // 插件替用户猜。默认仍是 auto。
  let prefer = 'auto'

  /** 「这次写入会怎么生效」的一句话说明（跟随写入方式下拉框）。 */
  const modeHint = (rec, mode) => {
    const isLive = rec !== null && rec.mode === 'live'
    if (mode === 'live') {
      return '⚡ 仅在线：写进活会话，下一轮对话立即生效（不用重启）。'
        + (isLive ? '' : ' ⚠ 这个会话当前不在内存里，这么选会写入失败。')
    }
    if (mode === 'disk') {
      return '💾 仅落盘：写入会话记录文件（自动备份），该会话下次载入时生效。'
        + (isLive ? ' ⚠ 这个会话在内存里，要等它被重新载入才对模型生效。' : '')
    }
    return isLive
      ? '⚡ 自动：这个会话在内存里 → 写活会话，下一轮对话立即生效（不用重启）。'
      : '💾 自动：这个会话不在内存里 → 落盘写入会话记录文件，该会话下次载入时生效。'
  }

  const renderMatch = () => {
    matchNote.textContent = ''
    if (match === null) {
      const rec = cachedRecord(sessionId)
      if (relocating === true) {
        matchNote.append(makeNote(doc, 'info', '⏳ 会话记录可能不是最新的，正在重新读取…'))
      } else if (isPlaceholderSession(sessionId)) {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 还没识别出当前会话（会话容器尚未就绪）。稍等片刻，或点「重新读取」。'))
      } else if (rec === null) {
        matchNote.append(makeNote(doc, 'warn', '⚠ 正在读取会话记录…稍后重开本编辑器。'))
      } else if (rec.error !== null) {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 读取会话记录失败：' + rec.error + '（点「重新读取」重试）'))
      } else if (rec.blocks.length === 0) {
        // 空清单分两种，别用同一句话糊过去：
        //  · 在线空 = 宿主还没把这条回复登记进活会话（新会话、流式输出中）；
        //    本插件会自动重读，通常一两秒内就好——不能吓唬用户去重启。
        //  · 落盘空 = 会话确实还没落盘（或压根没有助手正文）。
        matchNote.append(makeNote(doc, 'warn', rec.mode === 'live'
          ? '⏳ 宿主还没把这条回复登记进会话（新会话或还在输出中）。稍等一两秒，或点「重新读取」。'
          : '⚠ 会话记录里没有可定位的助手正文（这个会话可能还没落盘过）。'))
      } else {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 未在会话记录中定位到这条回复（记录里有 ' + rec.blocks.length + ' 条正文，'
          + '可能是含公式/表格/代码等渲染差异导致对不上）。'))
      }
    } else if (match.exact !== true) {
      matchNote.append(makeNote(doc, 'warn',
        '⚠ 与记录中的位置是按顺序推断的（seq=' + match.seq + '），未做内容比对。'
        + '写入前请确认正文无误。'))
    } else {
      matchNote.append(makeNote(doc, 'ok', '✓ 已定位到会话记录 seq=' + match.seq + '（块 ' + match.blockIndex + '）'))
    }
    // v3：把「这次写入会不会立即生效」摆在最显眼处——这是用户最关心的一件事，
    // 也是 v3 相对 v2 的全部价值所在。
    const modeRec = cachedRecord(sessionId)
    if (modeRec !== null && modeRec.error === null && match !== null) {
      matchNote.append(makeNote(doc, 'info', modeHint(modeRec, prefer)))
    }
    saveRecord.disabled = match === null
    renderTargets()
  }

  notes.append(matchNote)

  const cancel = makeButton(doc, '取消', '放弃改动', () => closeEditor())

  const refresh = makeButton(doc, '重新读取', '重新读取会话记录并重新定位', () => {
    closeEditor()
    readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
      .then(() => { if (scheduleScanRef !== null) scheduleScanRef() })
      .catch(error => log('重新读取失败', error))
  })

  const reset = makeButton(doc, '还原原文', '删除本条本机覆盖', () => {
    const fp = taken.get(block)
    if (typeof fp === 'string') {
      removeOverride(sessionId, fp)
      block.removeAttribute(EDIT_ATTR)
      closeEditorOnBlock(doc, block)
      applyOverride(block, fpOriginal(block, fp), prefs, doc)
      attachBar(block, doc, getSessionId, prefs, match)
    } else {
      closeEditor()
    }
  }, { 'data-danger': true })

  const saveLocal = makeButton(doc, '仅本机渲染', '只改本页显示，模型看不见（Ctrl+Enter）', () => {
    const next = area.value
    const fp = taken.get(block) ?? fingerprint(original)
    setOverride(sessionId, fp, next)
    // 先关编辑器交还焦点，再就地重写消息块。反过来做（先 applyOverride）
    // 会把正拿着焦点的 textarea 连块一起抹掉，焦点掉到 <body> ——
    // 真机上就是「保存完输入框打不了字、没有光标」。
    closeEditorOnBlock(doc, block)
    applyOverride(block, next, prefs, doc)
    attachBar(block, doc, getSessionId, prefs, match)
    block.append(makeNote(doc, 'ok', '本机渲染已保存' + focusNoteSuffix()))
  })

  const saveRecord = makeButton(doc, '写入伪造', '让模型采信改后的内容（在线立即生效，落盘则需会话重新载入）', () => {
    const next = area.value
    // 点击会把焦点放到本按钮上；紧接着的两个 disable 会让 Chromium 把焦点打到
    // <body>（聚焦元素被 disable 的既定行为），异步写完再来关编辑器时「焦点在
    // 不在 wrap 里」已经看不出来了。所以在点击当场（disable 之前）先记下
    // 「焦点原本在编辑器里」，让 closeEditorOnBlock 敢把焦点交还出去。
    hadFocusAtClick = wrap.contains(doc.activeElement)
    if (normalizeText(next) === normalizeText(original)) {
      status.textContent = '内容没有变化。'
      return
    }
    // 两步确认（页面内）：第一次点击只出确认行，第二次才真写。
    // 内容 / 目标 / 写入方式任一变化，确认即失效，要重新确认。
    // 不用 window.confirm：那是 OS 级原生模态框，真机上会把 app 窗口的键盘
    // 焦点弄丢——「焦点全绿却打不了字」的疑凶（2026-10-17 中午定位）。
    const fpNow = (match === null ? 'null' : match.seq + ':' + match.blockIndex)
      + '|' + prefer + '|' + normalizeText(next)
    if (confirmedForge !== fpNow) {
      confirmedForge = fpNow
      notes.append(makeNote(doc, 'warn', confirmWriteNote(next, match, prefer)))
      status.textContent = '请阅读上方确认信息，再次点击「写入伪造」执行写入'
      return
    }
    confirmedForge = null
    runForge()
  }, { 'data-rf3-primary': true })

  /**
   * 发起一次写入（可被陈旧自动重试复用）。
   *
   * STALE_TARGET 的真机成因（2026-10-17 下午，seq=15）：会话重启后磁盘记录与
   * 内存投影不一致（此前的在线伪造被落盘，投影盖过原文），而界面侧记录读到的是
   * 未过投影的原文 → expectText 对不上 → 被拒。服务端读路由现已同样过投影
   * （routes.mjs），一般不会再发生；这里仍保留**自动重试一次**兜底：
   * 强制重读记录 → 重新定位 → 用新 expectText 再写一次。失败就把两边文本
   * 都摆出来（actual/expected），不再让用户猜。
   */
  let forgeAttempt = 0
  const runForge = () => {
    if (match === null) {
      status.textContent = '定位不到这条回复，无法写入。'
      return
    }
    forgeAttempt += 1
    status.textContent = forgeAttempt > 1 ? '正在重试（第 ' + forgeAttempt + ' 次）…' : '正在写入…'
    saveRecord.disabled = true
    saveLocal.disabled = true
    forgeRecord({
      sessionId,
      seq: match.seq,
      blockIndex: match.blockIndex,
      // v3：块种类一起带上，思维链与正文走同一条路。
      kind: match.kind ?? 'text',
      newText: area.value,
      expectText: match.text,
      // 用户在「写入方式」里选的那条路：auto 由宿主先试在线、再落盘；
      // live / disk 是显式指定，宿主不替用户改主意（失败就如实报错）。
      prefer,
    }).then(res => {
      saveRecord.disabled = false
      saveLocal.disabled = pickedForeign
      if (res.ok !== true) {
        status.textContent = ''
        if (res.code === 'STALE_TARGET' && forgeAttempt === 1) {
          // 自动重试一次：重读记录 → 重新定位 → 再写
          notes.append(makeNote(doc, 'info',
            '⟳ 写入时发现记录已变化（' + staleDetail(res) + '），自动重新读取后重试…'))
          relocateThenRetry()
          return
        }
        notes.append(makeNote(doc, 'warn', '✖ ' + (res.error || '写入失败')
          + (res.code === 'STALE_TARGET'
            ? '（' + staleDetail(res) + '。点「重新读取」后重试）'
            : '')))
        return
      }
      // 写入成功后同步一份本机覆盖：界面立刻看到结果，且与记录一致。
      // 只在改的就是本节点时做——改的是别的消息（从下拉里选的）时，
      // 本节点不该跟着变。
      if (pickedForeign !== true) {
        const fp = taken.get(block) ?? fingerprint(original)
        setOverride(sessionId, fp, area.value)
        // 先关编辑器交还焦点，再就地重写消息块。反过来做的话，抹块时焦点
        // 还落在编辑器里，焦点会掉到 <body>——真机表现是「写完伪造后输入框
        // 打不了字、没有光标，点一下 + 添加文件才能继续输入」。
        closeEditorOnBlock(doc, block, { hadFocusAtClick })
        applyOverride(block, area.value, prefs, doc)
        attachBar(block, doc, getSessionId, prefs, match)
      } else {
        closeEditorOnBlock(doc, block, { hadFocusAtClick })
      }
      // 记录已变，缓存作废，重新读一遍让后续定位对得上。
      resetCache(sessionId)
      readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
        .then(() => { if (scheduleScanRef !== null) scheduleScanRef() })
        .catch(() => {})
      block.append(makeNote(doc, 'ok', doneNote(res) + focusNoteSuffix()))
    }).catch(error => {
      saveRecord.disabled = false
      saveLocal.disabled = pickedForeign
      status.textContent = '写入异常：' + String((error && error.message) || error)
    })
  }

  /** 陈旧失败时把「记录里实际是什么 / 界面以为是什么」摆出来。 */
  const staleDetail = res => {
    const actual = typeof res.actual === 'string' ? res.actual : null
    const expected = typeof res.expected === 'string' ? res.expected : null
    if (actual === null && expected === null) return '内容已被改动'
    const cut = t => String(t).replace(/\s+/g, ' ').slice(0, 40)
    return '记录里是「' + cut(actual ?? '') + '」，界面预期「' + cut(expected ?? '') + '」'
  }

  /** 陈旧自动重试：强制重读 → 重新定位 → 原样再写一次（只重试一次）。 */
  const relocatingRetry = { value: false }
  const relocateThenRetry = () => {
    if (relocatingRetry.value === true) return
    relocatingRetry.value = true
    status.textContent = '正在重新读取会话记录…'
    readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
      .then(() => {
        const rec = cachedRecord(sessionId)
        if (rec === null || rec.error !== null || Array.isArray(rec.blocks) === false) {
          notes.append(makeNote(doc, 'warn', '✖ 自动重试失败：会话记录读取不到。点「重新读取」后再试。'))
          status.textContent = ''
          return
        }
        // 重新定位：优先内容匹配（与扫描同口径），失败再用顺序推断。
        const live = pickAssistantBlocks(conversationRoot(doc), classifyNaturalLanguage, { includeTaken: true })
        const idx = live.indexOf(block)
        const fresh = idx === -1
          ? null
          : (matchBlocks(rec.blocks, live.map(ownText))[idx] ?? null)
        if (fresh === null) {
          notes.append(makeNote(doc, 'warn',
            '✖ 自动重试失败：重新读取后这条回复仍对不上记录。点「重新读取」打开新编辑器再试。'))
          status.textContent = ''
          return
        }
        match = fresh
        blockMatch.set(block, fresh)
        renderMatch()
        runForge()
      })
      .catch(error => {
        notes.append(makeNote(doc, 'warn', '✖ 自动重试失败：' + String((error && error.message) || error)))
        status.textContent = ''
      })
  }

  // ── 目标选择（v3）────────────────────────────────────────────────────────
  // 页面上拾取不到的块也能改。典型是**思维链**：它在宿主里是可折叠行，
  // 子元素只有 span/svg（没有块级子元素），picker 的 markdown 形状判定天然
  // 收不到它；被虚拟化折叠掉的历史回复同理。
  // 这里直接列出宿主给的「可编辑块清单」——它来自 seq+blockIndex 寻址，
  // 与 DOM 长什么样无关，所以思维链和折叠历史都能选到。
  let currentValue = match === null ? '' : match.seq + ':' + match.blockIndex

  const targetRow = doc.createElement('div')
  targetRow.className = 'rf3-targets'
  const targetSel = doc.createElement('select')
  targetSel.className = 'rf3-select'
  targetSel.setAttribute('aria-label', '选择要改的块')

  const renderTargets = () => {
    targetSel.textContent = ''
    const rec = cachedRecord(sessionId)
    const blocks = (rec !== null && rec.error === null && Array.isArray(rec.blocks)) ? rec.blocks : []
    const blank = doc.createElement('option')
    blank.value = ''
    blank.textContent = blocks.length === 0
      ? '（这个会话还没有可编辑块）'
      : ('跟随页面上的这条' + (match === null ? '（当前未定位到）' : ''))
    targetSel.append(blank)
    for (const b of blocks) {
      const value = b.seq + ':' + b.blockIndex
      const opt = doc.createElement('option')
      opt.value = value
      const preview = normalizeText(b.text).slice(0, 46)
      opt.textContent = (b.kind === 'reasoning' ? '【思维链】' : '【正文】')
        + ' seq=' + b.seq + ' 块' + b.blockIndex + ' · ' + preview + (b.text.length > 46 ? '…' : '')
      if (value === currentValue) opt.selected = true
      targetSel.append(opt)
    }
    targetSel.disabled = blocks.length === 0
  }

  targetSel.addEventListener('change', () => {
    // 目标换了，之前那个「再次点击确认」不再算数——重新确认。
    confirmedForge = null
    const value = String(targetSel.value ?? '')
    if (value === '') {
      // 回到「跟随页面上的这条」
      pickedForeign = false
      match = blockMatch.get(block) ?? null
      const fp = taken.get(block)
      const appliedLocal = fp === undefined ? undefined : loadOverrides(sessionId)[fp]
      area.value = (appliedLocal !== undefined && typeof appliedLocal.text === 'string')
        ? appliedLocal.text
        : ownText(block)
      saveLocal.disabled = false
    } else {
      const rec = cachedRecord(sessionId)
      const blocks = (rec !== null && rec.error === null && Array.isArray(rec.blocks)) ? rec.blocks : []
      const found = blocks.find(b => (b.seq + ':' + b.blockIndex) === value)
      if (found === undefined) return
      // 目标清单直接来自宿主（在线模式下就是模型可见的那一份），
      // 所以定位是确定的，exact: true。
      match = { seq: found.seq, blockIndex: found.blockIndex, kind: found.kind ?? 'text', text: found.text, exact: true }
      pickedForeign = true
      area.value = found.text
      // 本机渲染只能改本节点，改别的消息时这条出口没有意义。
      saveLocal.disabled = true
    }
    currentValue = match === null ? '' : match.seq + ':' + match.blockIndex
    renderMatch()
  })

  targetRow.append(targetSel)

  // ── 写入方式（v3.1）──────────────────────────────────────────────────────
  // 两条路的前提差别很大（要不要重启、动不动磁盘），交给用户显式选。
  // 默认 auto：会话在内存里就立即生效，不在就落盘——对多数人这是对的。
  const MODES = [
    ['auto', '自动（推荐）'],
    ['live', '仅在线（立即生效）'],
    ['disk', '仅落盘（重载后生效）'],
  ]
  const modeSel = doc.createElement('select')
  modeSel.className = 'rf3-mode'
  modeSel.setAttribute('aria-label', '写入方式')
  for (const [value, label] of MODES) {
    const opt = doc.createElement('option')
    opt.value = value
    opt.textContent = label
    if (value === prefer) opt.selected = true
    modeSel.append(opt)
  }
  modeSel.value = prefer
  modeSel.addEventListener('change', () => {
    // 写入方式换了，确认同样失效——两条路的前提不同，必须重新确认。
    confirmedForge = null
    const picked = String(modeSel.value ?? '')
    prefer = picked === 'live' || picked === 'disk' ? picked : 'auto'
    renderMatch()
  })
  targetRow.append(modeSel)

  row.append(status, spacer, refresh, reset, cancel, saveLocal, saveRecord)
  renderMatch()
  wrap.append(...head, targetRow, area, row)

  block.append(wrap)
  try { area.focus() } catch { /* 忽略 */ }

  // ── 记录可能比页面旧：先重读，再下结论 ──────────────────────────────────
  // 宿主把新回复渲染进 DOM 之后约 200ms 才落盘（dsh-session-persistence-jsonl
  // 的 enqueueLive 是 setTimeout 批处理），而记录缓存不会自己更新。此刻直接
  // 宣判「对不上」就是真机上那个 bug：伪造第一条之后，后面每条新回复都永久
  // 定位失败。所以记录明显比页面旧时，先重读一次，读完就地补定位。
  if (match === null) {
    try {
      const live = pickAssistantBlocks(conversationRoot(doc), classifyNaturalLanguage, { includeTaken: true })
      const idx = live.indexOf(block)
      if (idx !== -1) {
        const liveTexts = live.map(ownText)
        const rec = cachedRecord(sessionId)
        // 两种「记录明显比页面旧」：
        //  · 落盘记录非空但比页面少 → 宿主还没落盘；
        //  · 在线记录为空 → 宿主还没把这条回复登记进活会话（新会话/流式中）。
        //    v3.0 只认前一种，于是新会话永远停在「没有可定位的助手正文」。
        // 记录读失败是终态信息，重读也不会变，直接按原样提示（可点「重新读取」）。
        const stale = rec !== null && rec.error === null
          && ((rec.blocks.length > 0 && liveTexts.length > rec.blocks.length)
            || (rec.mode === 'live' && rec.blocks.length === 0))
        if (stale === true) {
          relocating = true
          renderMatch()
          readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
            .then(() => {
              const fresh = cachedRecord(sessionId)
              if (fresh === null || fresh.error !== null || fresh.blocks.length === 0) return
              const next = matchBlocks(fresh.blocks, liveTexts)[idx] ?? null
              if (next !== null) {
                match = next
                blockMatch.set(block, next)
              }
            })
            .catch(error => log('重新读取失败', error))
            .then(() => {
              relocating = false
              renderMatch()
              if (scheduleScanRef !== null) scheduleScanRef()
            })
        }
      }
    } catch (error) {
      log('补定位失败', error)
    }
  }

  area.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeEditor(); return }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      // Ctrl+Enter = 本机渲染（可逆、无风险）；落盘改写必须用鼠标点，
      // 免得手快把一个不可逆操作顺手做了。
      saveLocal.click()
    }
  })

  // 编辑器开着时把**这个块**的操作条藏起来：bar 是绝对定位 z-index:5，会压在
  // 编辑器的右上角（目标下拉那一带），真机上点不中的目标有一半是它盖的。
  // 关编辑器时 attachBar 重建会恢复显示。
  try {
    for (const child of (block.children ?? [])) {
      if (child.classList !== undefined && child.classList.contains('rf3-bar')) {
        child.style.display = 'none'
      }
    }
  } catch { /* 忽略 */ }

  openEditor = { wrap, block, doc }
}

/**
 * 写入成功后的结果说明。
 *
 * v3 的关键区别就在这里：宿主实际走了哪条路决定「要不要重启」。
 * 在线（live）写的是活会话对象，下一轮对话模型立刻看到新内容；
 * 落盘（disk）写的是磁盘记录，要等该会话被重新载入。这两句话必须分开说，
 * 否则用户永远不知道自己这次改动到底生效了没有。
 */
function doneNote(res) {
  if (res.mode === 'live') {
    return '✓ 已写入活会话 · 下一轮对话模型就看到改后的内容（不用重启）'
  }
  // 只有这三个 code 会被路由放行到落盘分支（routes.mjs 的 auto 白名单）；
  // 其余失败码（APPEND_UNSAFE 等）根本走不到这里，不配文案。
  const why = res.liveCode === 'SESSION_NOT_LIVE' ? '（该会话当前不在内存里）'
    : res.liveCode === 'NO_SESSIONS_SERVICE' ? '（拿不到宿主的 sessions 服务）'
      : res.liveCode === 'WRITER_NOT_ROUTED' ? '（这台宿主持久化没有这个会话的写句柄，已自动改为写会话记录）'
        : ''
  return '✓ 已写入会话记录' + why + ' · 该会话下次载入时生效'
    + (typeof res.backup === 'string' ? ' · 备份：' + res.backup : '')
}

/**
 * 写入前的确认文案（页面内两步确认的第一步展示用）。
 *
 * 这里**不再**写死「必须重启」——v3 多数情况下是在线写入、立即生效。
 * 只把两条路径各自的前提讲清楚，并把用户这次选的写入方式原样复述一遍，
 * 让用户自己判断当前这次属于哪种。
 *
 * 为什么不用 window.confirm：Electron 里它是 **OS 级原生模态框**，真机上
 * 会把 app 窗口的键盘焦点弄丢（Windows 上尤甚）——表现正是「DOM 焦点/
 * selection 全绿却打不了字」（鼠标还能用、按键进不来）。改为编辑器内的
 * 确认行 + 再次点击确认，UI 层面的「不可逆操作二次确认」一点没少。
 */
function confirmWriteNote(newText, match, prefer = 'auto') {
  const preview = String(newText).replace(/\s+/g, ' ').slice(0, 120)
  const kindLabel = match?.kind === 'reasoning' ? '思维链' : '正文'
  const route = prefer === 'live'
    ? '写入方式：仅在线（写活会话，立即生效、不用重启；会话不在内存里会失败）。'
    : prefer === 'disk'
      ? '写入方式：仅落盘（写会话记录文件，该会话下次载入时生效）。'
      : '写入方式：自动（会话在内存里 → 立即生效、不用重启；不在 → 写会话记录，下次载入时生效）。'
  return '确认写入伪造？目标：' + kindLabel + '（seq=' + match.seq + '，块 ' + match.blockIndex + '）'
    + '｜新内容：' + preview + (newText.length > 120 ? '…' : '')
    + '｜' + route
    + '｜改的是「模型看到的对话」，不可逆（有自动备份可还原）。'
    + '确认无误请再次点击「写入伪造」。'
}

/** 两个定位结果是否等价（只比寻址字段，不比正文省内存）。 */
function sameMatch(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  return a.seq === b.seq && a.blockIndex === b.blockIndex && a.exact === b.exact
}

/**
 * 接管一个消息节点：挂操作条 + 应用已有覆盖。
 */
function takeBlock(block, getSessionId, overrides, prefs, docOverride, dup = 1, match = null) {
  // 文档对象由扫描器显式传入：ownerDocument 在合成节点上可能缺失，
  // 隐式全局 document 在打包后的模块作用域里也未必可见。
  const doc = docOverride ?? block.ownerDocument ?? document

  // 已接管：**定位结果必须刷新**。会话记录是异步后到的（首屏扫描往往还没
  // 拉到），若不刷新，块会永远停留在接管那一刻的 match=null 上——
  // 表现就是「每条回复都定位不到，落盘出口全程禁用」。踩过。
  if (block.hasAttribute(TAKEN_ATTR)) {
    if (sameMatch(blockMatch.get(block) ?? null, match ?? null)) return
    blockMatch.set(block, match)
    attachBar(block, doc, getSessionId, prefs, match)
    return
  }

  const original = ownText(block)
  const fp = fingerprint(original)
  rememberOriginal(fp, original)
  taken.set(block, fp)
  dupCount.set(block, dup)
  blockMatch.set(block, match)
  block.setAttribute(TAKEN_ATTR, '')

  // 定位上下文：无条件添加——读 computed style 再判断既慢（流式重渲染时
  // 每个节点一次样式计算）又不可靠（祖先已定位时 position 未必是 static），
  // 而 .rf3-host 的 position:relative 对宿主布局无影响。
  block.classList.add('rf3-host')

  attachBar(block, doc, getSessionId, prefs, match)
  const override = overrides[fp]
  if (override !== undefined && typeof override.text === 'string') {
    applyOverride(block, override.text, prefs, doc)
    attachBar(block, doc, getSessionId, prefs, match)
  }
}

/** 一轮扫描：接管当前所有助手消息块，并刷新落盘定位。 */
function scan(getSessionId, prefs, docOverride) {
  // 全局开关：停用时不提供任何编辑入口（setEnabled(false) 的实时效果）。
  if (prefs.enabled === false) return
  const doc = docOverride ?? document
  const root = conversationRoot(doc)
  if (root === null) return
  const sessionId = getSessionId()
  const overrides = loadOverrides(sessionId)
  // 只接管纯自然语言块，工具调用/结构化动作不提供编辑入口。
  //
  // 必须 includeTaken：已接管的块也要枚举回来。不是为了重挂操作条
  // （takeBlock 会早退），而是为了**刷新落盘定位**——会话记录是异步
  // 后到的，首屏扫描时块已经以 match=null 接管完；若此后扫描把已接管块
  // 全跳过，定位就永远停在 null，表现是「每条回复都定位不到、落盘出口
  // 全程禁用」。踩过。
  const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })

  // 指纹重数统计：先数重再接管，编辑器里对重名者给出警示。
  const texts = blocks.map(ownText)
  const fps = new Map()
  const counts = new Map()
  for (const block of blocks) {
    const fp = fingerprint(ownText(block))
    fps.set(block, fp)
    counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }

  // 落盘定位：把页面上这一批块与磁盘块配对。记录没拉到就全部按「未定位」处理，
  // 落盘出口禁用——不猜位置。
  const rec = cachedRecord(sessionId)
  const matches = (rec !== null && rec.error === null && rec.blocks.length > 0)
    ? matchBlocks(rec.blocks, texts)
    : blocks.map(() => null)

  blocks.forEach((block, i) => {
    try {
      takeBlock(block, getSessionId, overrides, prefs, doc, counts.get(fps.get(block)) ?? 1, matches[i] ?? null)
    } catch (error) {
      log('接管消息块失败', error)
    }
  })

  // 待发送气泡：与上面的助手块是两条互不相交的接管链（气泡是用户消息，
  // 且只在回合进行中以 steering 形式出现）。没有 sessions 服务就整段跳过。
  takePendingBubbles(doc)

  // 页面比记录新（新回复刚渲染进 DOM，宿主还没落盘 / 缓存是旧快照）→
  // 后台重读一次，读完会再进来自旋一轮把定位补上。见文件头部说明。
  // refreshRecordRef 由 apply() 注入（scan 是模块级函数，拿不到闭包状态）。
  if (refreshRecordRef !== null) {
    try { refreshRecordRef(sessionId, texts) } catch (error) { log('重读会话记录失败', error) }
  }
}

/**
 * 插件入口：注入样式、启动扫描与会话级操作。
 * @param ctx - client 根上下文（提供 slots 服务）。
 */
export function apply(ctx) {
  // 幂等守卫：重复执行（HMR / loader 重跑）不重复注入。
  if (document.querySelector('style[data-dsh-reply-forge-v3]') !== null) return

  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-dsh-reply-forge-v3', '')
  styleEl.setAttribute('data-plugin', 'dsh-reply-forge-v3')
  styleEl.textContent = CSS
  document.head.append(styleEl)

  // sessions 服务必须在 apply 期取：宿主只在 apply() 的 ctx 上暴露服务，
  // slot 回调 / 事件处理器里再读 ctx.<service> 会抛。存进 ref 供 handler 用。
  // 宿主没给这个服务（旧版本）时留 null，队列编辑入口不出现，其余功能不受影响。
  const sessions = ctx === null || ctx === undefined ? null : (ctx.sessions ?? null)
  sessionsRef = sessions

  let prefs = loadPrefs()
  let sessionId = currentSessionId(document)
  /** 会话 id 取「用的时候现读」，不要把它固定进闭包（见 attachBar 注释）。 */
  const getSessionId = () => sessionId

  // 落盘记录自动重读的状态（见文件头部 RECORD_REFRESH_* 的说明）。
  let recordRefreshMisses = 0
  let lastRecordRefreshAt = 0

  /** 扫描节流：流式输出期间宿主高频重渲染，按帧合并。 */
  let timer = null
  const scheduleScan = () => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      try { runScan() } catch (error) { log('扫描失败', error) }
    }, SCAN_DEBOUNCE_MS)
  }
  // 供模块级的 openBlockEditor 用（补定位成功后要重扫一次刷操作条记号）。
  scheduleScanRef = scheduleScan

  /**
   * 页面上的正文块比记录里多 → 记录过期了，后台重读一次，读完重扫。
   *
   * 不重读的后果就是真机上那个 bug：伪造第一条之后，后面每条新回复都拿着
   * 旧快照比对，永久提示「记录里有 N 条正文，对不上」。
   *
   * 双重退避：时间间隔 + 连续无果次数。页面再次增长（签名变化）会解除退避
   * ——用户继续聊天就该继续尝试，不能被一次「读不到」永久堵死。
   */
  let lastDomSignature = ''
  const refreshRecordIfStale = (sid, domTexts) => {
    if (isPlaceholderSession(sid)) return
    const signature = domSignatureOf(domTexts)
    // 页面变了（新回复进来 / 流式正文变长 / 历史折叠）→ 重新给自动重读计机会
    if (signature !== lastDomSignature) {
      lastDomSignature = signature
      recordRefreshMisses = 0
    }
    if (recordRefreshMisses >= RECORD_REFRESH_MAX_TRIES) return
    if (Date.now() - lastRecordRefreshAt < RECORD_REFRESH_MIN_GAP_MS) return
    const rec = cachedRecord(sid)
    if (recordNeedsRefresh(rec, domTexts.length, signature) !== true) return
    const before = rec === null ? -1 : rec.blocks.length
    lastRecordRefreshAt = Date.now()
    // 签名必须带上：它就是这次快照的「页面基准」，下次比较才有意义。
    readRecord(sid, { force: true, domSignature: signature })
      .then(next => {
        // 读到的块数没变 → 记一次无果；变了 → 复位（会话在正常增长）。
        recordRefreshMisses = next.blocks.length === before ? recordRefreshMisses + 1 : 0
        scheduleScan()
      })
      .catch(() => { recordRefreshMisses += 1 })
  }
  // 供模块级的 scan() 用：页面比记录新时自动重读（scan 拿不到 apply 的闭包）。
  refreshRecordRef = refreshRecordIfStale

  /** 当前页面的块签名。会话切换时用——那时 scan 还没跑，只能现取。 */
  const domSignatureNow = () => {
    const root = conversationRoot(document)
    if (root === null) return ''
    try {
      return domSignatureOf(
        pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true }).map(ownText),
      )
    } catch { return '' }
  }

  // 供模块级的 openBlockEditor 用：补定位/手动重读时带上的签名基准。
  domSignatureNowRef = domSignatureNow

  /** 拉一次落盘记录，拿到后重扫以便刷新定位。 */
  const syncRecord = () => {
    // 还没识别出会话时不发请求：路由必然 404，只会刷一屏没用的噪音。
    if (isPlaceholderSession(sessionId)) return
    readRecord(sessionId, { domSignature: domSignatureNow() })
      .then(() => scheduleScan())
      .catch(error => log('读取会话记录失败', error))
  }

  /**
   * 每轮扫描都重算会话 id。
   *
   * 为什么不能只在 popstate/hashchange 上挂：dsh 是单页应用，切换会话
   * **不触发任何 URL 事件**（实测 @deepseek-ai/dsh-client-ui-conversation
   * 的 client.js 里 location/history 一次都没出现）。会话 id 只体现在
   * DOM 属性 `data-conversation-session` 上。首屏同理——容器挂载前拿到
   * 的是占位值，挂载后才变成真值，所以必须每轮都重算。
   */
  const runScan = () => {
    const next = currentSessionId(document)
    if (next !== sessionId) {
      // 会话真的变了（首屏就绪 / 切到别的会话）：关掉编辑态、重新拉记录。
      if (isPlaceholderSession(sessionId) === false) closeEditor()
      sessionId = next
      // 换会话后自动重读的退避计数归零：新会话的增长是独立计量的。
      // 签名也要清——上一个会话的页面签名对新会话毫无意义。
      recordRefreshMisses = 0
      lastDomSignature = ''
      syncRecord()
    }
    scan(getSessionId, prefs, document)
  }

  window.addEventListener('popstate', scheduleScan)
  window.addEventListener('hashchange', scheduleScan)

  // 宿主 DOM 变化驱动接管：会话区子树内的节点增删（新消息、流式定稿、
  // 标签切换重渲染）都会触发。作用域限定在会话锚点内，避免观察整棵树。
  let observedRoot = null
  let observer = null
  const attachObserver = () => {
    const root = document.querySelector(CONVERSATION_SELECTOR)
    if (root === observedRoot) return
    if (observer !== null) { observer.disconnect(); observer = null }
    observedRoot = root
    if (root === null) return
    observer = new MutationObserver(() => scheduleScan())
    observer.observe(root, { childList: true, subtree: true })
    // 锚点刚出现时立刻扫一次：此刻会话里往往已经有历史消息，
    // 而 MutationObserver 只对「之后的」变动触发，不补这一刀就会漏掉首屏。
    scheduleScan()
  }

  // 锚点重连的常驻心跳。**永不 clearInterval**——
  //
  // 旧代码「找到锚点就 clearInterval」是真机 bug「插件经常整页失效、
  // 只有重启 DSH 才好」的直接根因：宿主 reconcile（HMR teardown 半途、
  // 版本切换、turn 折叠重挂会话容器）会把 [data-slot="main.conversation"]
  // 锚点整体换掉或短暂摘掉，旧 observer 挂到脱离文档的节点上后再也不会
  // 触发，而 bootstrap interval 早已自停 → 没有任何路径重连 observer
  // → scan 停摆、按钮全没。重启之所以能好：重启走 entries.start() 全新
  // fiber，interval 重开、锚点重挂。
  //
  // attachObserver 内部有 `root === observedRoot` 早退，常驻成本就是
  // 每秒一次 querySelector，可忽略。真机复现会话：
  // session-25eecb09-67c5-41e6-b5a5-8259dd11c898（2026-10-19/20 反复出现）。
  const BOOTSTRAP_INTERVAL_MS = 1000
  const bootstrap = window.setInterval(() => {
    attachObserver()
  }, BOOTSTRAP_INTERVAL_MS)
  attachObserver()

  // 窗口唤醒兜底：浏览器会挂起后台 tab 的定时器与 MutationObserver 回调，
  // 挂起期间锚点可能已被替换。切窗口 / 最小级还原时主动重挂重扫，
  // 不等下一个 DOM 变动来触发。
  const onWake = () => { attachObserver(); scheduleScan() }
  const onWakeVisibility = () => {
    if (document.visibilityState === 'visible') onWake()
  }
  window.addEventListener('focus', onWake)
  document.addEventListener('visibilitychange', onWakeVisibility)
  syncRecord()

  // 快捷键：Alt+Shift+E 编辑当前视图最后一条 AI 回复
  const onKey = event => {
    if (event.altKey !== true || event.shiftKey !== true) return
    if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'e') return
    const root = conversationRoot(document)
    // includeTaken：快捷键是枚举用途。默认的扫描语义会跳过已接管的块，
    // 于是「所有块都接管完之后按快捷键毫无反应」——静默失效，最难查的那种。
    const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })
    const last = blocks[blocks.length - 1]
    if (last === undefined) return
    event.preventDefault()
    openBlockEditor(last, getSessionId, prefs, document)
  }
  window.addEventListener('keydown', onKey)

  ctx.effect(() => () => {
    window.clearInterval(bootstrap)
    if (timer !== null) window.clearTimeout(timer)
    if (observer !== null) observer.disconnect()
    window.removeEventListener('popstate', scheduleScan)
    window.removeEventListener('hashchange', scheduleScan)
    window.removeEventListener('focus', onWake)
    document.removeEventListener('visibilitychange', onWakeVisibility)
    window.removeEventListener('keydown', onKey)
    stripInjectedUI()
    // 放在 stripInjectedUI 之后：它内部的 closeEditor 也可能再装上保险丝，
    // 拆除必须保证最终是解除状态，否则停用后还留一个全局 keydown 监听。
    disarmTypingGuard()
    styleEl.remove()
  }, 'dsh-reply-forge-v3: teardown')

  // 调试命名空间：不注册任何宿主槽位，只在 window 上暴露，供手动排查。
  // v3 起改名为 __dshReplyForgeV3：v2 插件也定义 __dshReplyForgeV2，
  // 两个插件同时装（--keep-v2）时同名会互相覆盖，排查时根本分不清是谁。
  try {
    window.__dshReplyForgeV3 = {
      version: '3.1.0',
      sessionId() { return sessionId },
      /** 直接从 DOM 现读一次（排查「id 认错了」时对比用）。 */
      domSessionId() { return currentSessionId(document) },
      clearAll() {
        clearOverrides(sessionId)
        log('已清空当前会话的本机覆盖')
      },
      /**
       * 强制重算会话 id + 重读落盘记录（定位不上的时候用）。
       * 会顺带修掉「id 还是首屏占位值」这种状态。
       */
      refresh() {
        sessionId = currentSessionId(document)
        resetCache(sessionId)
        if (isPlaceholderSession(sessionId)) {
          return Promise.resolve({ ok: false, sessionId, error: '未识别出当前会话（DOM 里没有 data-conversation-session）' })
        }
        return loadRecord(sessionId, { force: true, domSignature: domSignatureNow() }).then(rec => {
          scheduleScan()
          return { ok: rec.error === null, sessionId, mode: rec.mode, blocks: rec.blocks.length, error: rec.error }
        })
      },
      /** 当前页面上各块的落盘定位情况，用于排查「为什么写不了」。 */
      locate() {
        const root = conversationRoot(document)
        // includeTaken：枚举用途，已接管的块也要算进来（否则全接管完就是空列表）。
        const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })
        const texts = blocks.map(ownText)
        const rec = cachedRecord(sessionId)
        const head = {
          sessionId, domSessionId: currentSessionId(document), domBlocks: blocks.length,
          domSignature: domSignatureOf(texts),
        }
        if (rec === null) return { ...head, ok: false, error: '记录未加载' }
        if (rec.error !== null) return { ...head, ok: false, error: rec.error }
        const matches = matchBlocks(rec.blocks, texts)
        return {
          ...head,
          ok: true,
          mode: rec.mode,
          recordSignature: rec.domSignature,
          diskBlocks: rec.blocks.length,
          matched: matches.filter(m => m !== null).length,
          exact: matches.filter(m => m !== null && m.exact === true).length,
          // 页面与记录不一致 → 记录过期，正在自动重读（排查「新回复定位不上」时看这里）
          stale: recordNeedsRefresh(rec, blocks.length, domSignatureOf(texts)),
          rows: matches.map((m, i) => ({
            domIndex: i,
            preview: ownText(blocks[i]).slice(0, 40),
            seq: m === null ? null : m.seq,
            blockIndex: m === null ? null : m.blockIndex,
            exact: m === null ? null : m.exact,
          })),
        }
      },
      setEnabled(value) {
        prefs = { ...prefs, enabled: value === true }
        savePrefs(prefs)
        // 实时生效：停用立即拆除已注入的 UI；启用则触发一次扫描补挂。
        if (prefs.enabled) scheduleScan()
        else stripInjectedUI()
      },
      /**
       * 焦点排查：最近一次交还结果 + 此刻宿主持话输入框的真实状态。
       * 真机「保存后输入框打不了字」时，先看这里：
       *   - last.ok=false 且 editable=false → 输入框当时不可聚焦（宿主状态）；
       *   - last.ok=true 但 activeIsComposer=false → 焦点被别的东西拿走了；
       *   - composerTotal>1 → 页面上有多个输入框节点，看一眼 chosenVisible。
       *
       * 字段一律放平 + summary 一行摘要：真机上用户从 DevTools 里复制
       * `JSON.stringify(__dshReplyForgeV3.focus())` 就能拿到全量证据
       * （折叠的 {…} 会把最关键的 reason 藏掉，踩过）。
       */
      focus: makeFocusProbe(document),
    }
  } catch {
    // window 不可写时忽略
  }
}
