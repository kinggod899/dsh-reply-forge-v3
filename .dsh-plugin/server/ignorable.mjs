// 「可忽略」标记（ignorable）——v3.1 的 P0 修复，也是 v3 唯一会「写坏会话」的地方。
//
// ── 问题 ────────────────────────────────────────────────────────────────
// 宿主读会话时有一道 **fail-closed** 闸门（@deepseek-ai/dsh-session-persistence
// 的 validateStoredEvents）：
//
//   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
//     throw ... refusing to interpret the log — it was likely written by a newer harness
//
// 我们的 reply-forge/patch 对宿主就是「不认识的类型」。没有 ignorable 标记时，
// 日志一旦被写入，**下一次打开这个会话就整条被拒**——会话打不开。
// 真机上已实证中招（见 README「关掉插件会不会把会话弄坏」）。
//
// ── 为什么不能在源头解决 ────────────────────────────────────────────────
// 1. `Session.append(type, data, ...opts)` 只认 opts[0] 的 surfaceOp /
//    sourceEventSeqs，事件字节由 `snapshotJsonValue(data)` 得出——**没有第二个
//    写门**，插件无法给自己事件的顶层加字段；
// 2. 另一条路是把类型登记进 KNOWN_SESSION_EVENT_TYPES，但那是**生成本**
//    （scripts/gen-persistence-catalog.ts），而且实测插件侧连
//    `import '@deepseek-ai/dsh-session'` 都解析不到宿主那份实例，注册词汇表
//    这条路走不通。
//
// ── 所以只能在下游补 ───────────────────────────────────────────────────
// 每个会话在持久化后端里恰好有一个写句柄，两个写入路径
// （`handle.append(batch)` 与 `session/event` → `tracker.writers.get(id).enqueueLive`）
// 都收敛到同一个方法：`handle.persistContiguous(batch)`。
// 在那一步给批次里**我们自己的**事件补 ignorable:true 即可。
//
// 安全性：batch 到达 persistContiguous 时已经过 `materializeAppendBatch`
// 深拷贝（两条路径都调了），改它不会碰到宿主内存里那份 deepFreeze 的事件，
// 也不会改变会话日志的语义（seq / type / data 一字不动，只多一个宿主自己
// 在 decode 里明确允许的 `ignorable` 字段——见 dsh-session-format-v1-to-v2
// 的 EVENT_OPTIONAL 与 decodeEvent 的「ignorable 必须是 true」校验）。
//
// ── 装不上怎么办 ───────────────────────────────────────────────────────
// **拒绝在线写入**（live.mjs 返回 APPEND_UNSAFE）。宁可退回落盘（v2 路径，
// 只改现有 assistant/message 的正文、不产生未知类型事件），也绝不把用户的
// 会话写坏——那比「功能不可用」严重得多。
//
// ── 为什么要按会话核验（2026-10-16 P0 复盘新增）────────────────────────
// 初版只证明「钩子点挂上了」（tracker.adopt / writers.set 被包住），**不证明**
// 目标会话的写句柄真的存在、真的是我们包的那个函数。宿主后端升级换个结构、
// 句柄被换掉、或者这个会话根本没走持久化路由（sessions.create() 直接发布的
// 会话不落盘），全局 ok:true 都会造成两种坏结果：
//   · 当真包住了却拒写——过度保守，只是难用；
//   · 以为包住了其实没有——**写坏用户会话**，不可接受。
// 所以写前必须逐会话核验（verifySessionWriter），并且区分两种失败：
//   · WRITER_NOT_ROUTED：这个会话在内存里，但后端没有它的写句柄——
//     宿主导持久化根本没在跟它，在线 append 是静默丢失（不落盘、也不坏）。
//     这种情况回落盘是安全的（没有并发写者），auto 模式放行。
//   · APPEND_UNSAFE：有写句柄但没法确认标记一定补上（包装丢了/结构不符）。
//     一律拒绝，auto 模式也**不**回落盘——会话还活着，直接改盘有并发覆盖
//     风险。用户须先关闭会话或退出 DSH，再显式选择落盘。
//
// 为什么在这里而不在 src/ 下：这是**宿主适配**（依赖宿主的 tracker 结构），
// src/ 是纯逻辑层，不该认识宿主。所以宿主侧适配全部收在本文件。

import { PATCH_EVENT_TYPE } from '../../src/patch-event.mjs'

/** 本插件写进会话日志的事件类型。只有这些会被补标记。 */
const OWN_EVENT_TYPES = new Set([PATCH_EVENT_TYPE])

/** 失败码：装不上 shim 时，在线写入必须被拒（而不是写坏会话）。 */
export const APPEND_UNSAFE = 'APPEND_UNSAFE'

/** 失败码：会话在内存里，但宿主持久化没有它的写句柄（没在跟这个会话）。 */
export const WRITER_NOT_ROUTED = 'WRITER_NOT_ROUTED'

/** 宿主持久化服务的名字（dsh-session-persistence 的 Service 定义）。 */
const SERVICE_NAME = 'sessionPersistence'

/**
 * 包装标记：只有带这个属性的函数才是「我们包的 persistContiguous」。
 * 用 Symbol 而不是字符串，避免与宿主将来的自有字段撞名。
 * 句柄被换掉、或宿主升级后替换了原型方法，这个标记自然消失——核验随之失败，
 * 正是 fail-closed 要的效果。
 */
const SHIM_BRAND = Symbol('dsh-reply-forge-v3/ignorable-shim')

/** 真写句柄必须具备的成员（照 dsh-session-persistence-jsonl 的 JsonlSessionHandle）。 */
const HANDLE_REQUIRED_MEMBERS = ['persistContiguous', 'enqueueLive', 'drainLive']

/** 真 tracker 必须具备的成员（照 JsonlBackendTracker）。 */
const TRACKER_REQUIRED_MEMBERS = ['adopt', 'claimWrite', 'flushAll']

/**
 * 给一个事件批次里「本插件自己的、尚未标记」的事件补上 `ignorable: true`。
 *
 * 语义严格收敛：只认自己的类型；已经标记的原样返回；别人的事件一字不动；
 * 没有任何改动时返回**原数组**（避免制造无谓的对象）。
 *
 * @param {object[]} batch 事件批次（persistContiguous 的入参，已是深拷贝）
 * @returns {object[]} 补过标记的批次（无改动时是同一个数组）
 */
export function stampIgnorable(batch) {
  if (Array.isArray(batch) === false || batch.length === 0) return batch
  let changed = false
  const out = batch.map(event => {
    if (event === null || typeof event !== 'object') return event
    if (OWN_EVENT_TYPES.has(event.type) === false) return event
    if (event.ignorable === true) return event
    changed = true
    return { ...event, ignorable: true }
  })
  return changed ? out : batch
}

/** 已包过的句柄。用 WeakSet 保证幂等：重复安装不会叠成两层包装。 */
const patched = new WeakSet()

/**
 * 给一个持久化**写**句柄装上 shim（幂等）。
 * 只包写句柄：读句柄的 persistContiguous 对读操作必抛 SessionReadOnlyError，
 * 而且读句柄压根不进 writers（adopt 只登记 write），包它没有意义。
 * @param {object} handle JsonlSessionHandle
 * @returns {boolean} 这次是否真的装上了
 */
function patchHandle(handle) {
  if (handle === null || handle === undefined || typeof handle !== 'object') return false
  if (patched.has(handle)) return false
  if (handle.access !== 'write') return false
  if (typeof handle.persistContiguous !== 'function') return false
  const original = handle.persistContiguous
  try {
    // 原型方法 → 实例自有属性覆盖。persistContiguous 内部用 this，
    // 所以必须 call(this, ...) 把接收者原样带过去。
    const wrapper = function (batch) {
      return original.call(this, stampIgnorable(batch))
    }
    // 供 verifySessionWriter 识别「当前这个函数就是我们包的」。
    Object.defineProperty(wrapper, SHIM_BRAND, { value: true, enumerable: false })
    handle.persistContiguous = wrapper
  } catch {
    return false
  }
  patched.add(handle)
  return true
}

/** apply() 时的 ctx，留给按需重试（宿主服务可能比本插件晚加载）。 */
let shimCtx = null

/** 安装时锁定的后端与 tracker 实例。核验只认这一对（被换掉就重新装）。 */
let shimBackend = null
let shimTracker = null

/** 当前状态。`ok:true` 才允许在线写入。 */
let shim = { ok: false, reason: '插件尚未初始化（apply 未执行）', handles: 0, hooks: [] }

/**
 * 忘掉已安装状态与 ctx（下一次 ensureIgnorableShim 会重新探测）。
 *
 * 用途有三：测试里要分别验「装上」与「装不上」两条路；插件热重载时重新对准
 * 新的宿主服务实例（apply 会重新给 ctx）；以及核验发现后端实例被换掉时自愈。
 * **注意**：不清空 `patched` WeakSet——已经包过的句柄保持包装是正确行为
 * （它仍然有效），重复包会叠层。
 */
export function resetIgnorableShim() {
  shimCtx = null
  shimBackend = null
  shimTracker = null
  shim = { ok: false, reason: '已重置，尚未重新安装', handles: 0, hooks: [] }
  return shim
}

/**
 * 安装状态（供 live.mjs 判断能不能在线写）。
 * @returns {{ok:boolean, reason:string, handles:number, hooks:string[]}}
 */
export function ignorableShimState() {
  return shim
}

/**
 * 按需安装/重试安装。写路由每次都会调（内部就是几次 Map 查找，可忽略）。
 *
 * ok 已为 true 时会顺手核一遍「安装时锁定的后端还在不在」——宿主持久化
 * 服务被替换（插件热重载等）时旧 tracker 已经死了，必须重装到新实例上，
 * 否则核验过的句柄属于一个不再接收事件的僵尸后端。
 * 自愈只重置后端相关状态，**保留 shimCtx**（重置的语义是测试用的全清）。
 * @returns {{ok:boolean, reason:string, handles:number, hooks:string[]}}
 */
export function ensureIgnorableShim() {
  if (shim.ok === true) {
    const current = resolveBackend()
    if (current === shimBackend) return shim
    // 后端被换掉了：忘掉旧 tracker，重装到新实例（ctx 要留着，否则重装时
    // 解析不到新服务）
    const ctx = shimCtx
    resetIgnorableShim()
    shimCtx = ctx
  }
  return tryInstall()
}

/**
 * 在 apply() 里调用一次（记下 ctx 并立即尝试）。宿主服务晚到也不会卡死：
 * 写路由会通过 ensureIgnorableShim 再试。
 * @param {object} ctx 插件上下文
 * @returns {{ok:boolean, reason:string, handles:number, hooks:string[]}}
 */
export function installIgnorableShim(ctx) {
  if (ctx !== null && ctx !== undefined) shimCtx = ctx
  if (shim.ok === true) return shim
  return tryInstall()
}

/** 结构像不像真的 JsonlBackendTracker（宿主升级改结构时fail-closed，不硬来）。 */
function looksLikeTracker(tracker) {
  if (tracker === null || tracker === undefined || typeof tracker !== 'object') return false
  if (tracker.writers instanceof Map === false) return false
  for (const name of TRACKER_REQUIRED_MEMBERS) {
    if (typeof tracker[name] !== 'function') return false
  }
  return true
}

/** 真装一次。失败只记原因，不抛（绝不影响插件加载）。 */
function tryInstall() {
  const backend = resolveBackend()
  if (backend === null) {
    shim = { ok: false, reason: '拿不到宿主的会话持久化服务（ctx.reflect 不可用，或该服务尚未加载）', handles: 0, hooks: [] }
    return shim
  }
  const tracker = backend.tracker
  if (looksLikeTracker(tracker) === false) {
    shim = { ok: false, reason: '宿主持久化后端的结构不认识（没有 tracker.writers 这个 Map，或 tracker 形状已变）', handles: 0, hooks: [] }
    return shim
  }
  const writers = tracker.writers

  const hooks = []

  // ① 已经在用（本插件加载前就打开）的写句柄
  let handles = 0
  try {
    for (const handle of writers.values()) if (patchHandle(handle)) handles += 1
  } catch { /* 遍历失败不影响后续钩子 */ }

  // ② 之后新开的写句柄：adopt 是句柄进入 writers 的唯一构造入口
  try {
    if (typeof tracker.adopt === 'function') {
      const originalAdopt = tracker.adopt
      tracker.adopt = function (handle) {
        const result = originalAdopt.call(this, handle)
        patchHandle(result ?? handle)
        return result
      }
      hooks.push('tracker.adopt')
    }
  } catch { /* 拿不到就靠 ③ */ }

  // ③ 兜底：万一还有别处直接往 writers 里塞句柄
  try {
    const originalSet = writers.set
    writers.set = function (key, value) {
      patchHandle(value)
      return originalSet.call(this, key, value)
    }
    hooks.push('writers.set')
  } catch { /* 兜底也装不上就只剩 ① ② */ }

  if (hooks.length === 0) {
    // ① 的确可能给当前已经打开的句柄补了包装，但这**不能**证明之后新开会话
    // 的句柄也会被处理。在线能力只有在 future writer hook 上才算安全；否则
    // 全局 shim 报 ok=true 会让新会话继续写出缺 ignorable 的坏事件。
    shim = {
      ok: false,
      reason: handles > 0
        ? '只包住了已打开的写句柄，但挂不上新句柄拦截点；为避免新会话写坏，在线写入已禁用'
        : '宿主上装不上任何挂钩点（tracker 结构可能已变）',
      handles,
      hooks: [],
    }
    return shim
  }
  shim = { ok: true, reason: '', handles, hooks }
  shimBackend = backend
  shimTracker = tracker
  return shim
}

/**
 * 写前核验：**这个会话**的持久化写句柄存在、且当前生效的 persistContiguous
 * 确实被我们包着。缺任何一项都拒绝在线写入。
 *
 * 两种失败要给不同 code（routes 的 auto 回落依据它）：
 *   · WRITER_NOT_ROUTED —— writers 里没有这个会话：宿主没在持久化它，
 *     在线 append 不会落盘（静默丢失）。回落盘安全（没有并发写者）。
 *   · APPEND_UNSAFE —— 有句柄但包不住/认不出，或后端结构已经变了。
 *     一律拒绝，不回落盘（会话活着，直接改盘有并发覆盖风险）。
 *
 * @param {string} sessionId 目标会话 id
 * @returns {{ok:true, sessionId:string} | {ok:false, code:string, reason:string}}
 */
export function verifySessionWriter(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, code: APPEND_UNSAFE, reason: 'sessionId 不合法，无法核验写句柄' }
  }
  const state = ensureIgnorableShim()
  if (state.ok !== true) {
    return { ok: false, code: APPEND_UNSAFE, reason: state.reason }
  }
  const tracker = shimTracker
  // ensureIgnorableShim 里已经锁定了 tracker；这里再确认它没被换成别的。
  if (looksLikeTracker(tracker) === false || tracker !== resolveBackend()?.tracker) {
    return { ok: false, code: APPEND_UNSAFE, reason: '宿主持久化后端实例在安装后发生了变化，拒绝在线写入' }
  }
  const handle = tracker.writers.get(sessionId)
  if (handle === undefined) {
    return {
      ok: false,
      code: WRITER_NOT_ROUTED,
      reason: '宿主持久化后端没有这个会话的写句柄（该会话不走持久化路由），在线写入不会落盘',
    }
  }
  if (handle === null || typeof handle !== 'object') {
    return {
      ok: false,
      code: APPEND_UNSAFE,
      reason: '该会话的写句柄正在构造中或已失效（writers 里的值是 null），拒绝在线写入',
    }
  }
  if (patched.has(handle) === false) {
    return {
      ok: false,
      code: APPEND_UNSAFE,
      reason: '该会话的写句柄不是本插件包装的那个实例（可能是安装前打开、或宿主换过实现），拒绝在线写入',
    }
  }
  if (typeof handle.persistContiguous !== 'function'
    || handle.persistContiguous[SHIM_BRAND] !== true) {
    return {
      ok: false,
      code: APPEND_UNSAFE,
      reason: '该会话写句柄上的 persistContiguous 不是本插件的包装（宿主可能已替换），拒绝在线写入',
    }
  }
  if (handle.access !== 'write' || handle.id !== sessionId) {
    return {
      ok: false,
      code: APPEND_UNSAFE,
      reason: '写句柄与目标会话不匹配（access/id 对不上），拒绝在线写入',
    }
  }
  for (const name of HANDLE_REQUIRED_MEMBERS) {
    if (typeof handle[name] !== 'function') {
      return {
        ok: false,
        code: APPEND_UNSAFE,
        reason: `写句柄缺少 ${name}，结构不像受支持的 JSONL 实现，拒绝在线写入`,
      }
    }
  }
  if (handle.storage === null || handle.storage === undefined
    || typeof handle.storage !== 'object'
    || typeof handle.storage.persistBatch !== 'function') {
    return {
      ok: false,
      code: APPEND_UNSAFE,
      reason: '写句柄的 storage 不是受支持的 JSONL 实现，拒绝在线写入',
    }
  }
  return { ok: true, sessionId }
}

/**
 * 解析宿主 sessions 持久化服务。
 *
 * 用 `ctx.reflect.get(name, false)`（**非严格**模式）而不是 `ctx.sessionPersistence`：
 * 直接读属性要求服务由**自己的祖先 fiber** 提供，而持久化后端是本插件的
 * 兄弟插件——属性访问会抛「cannot get property without inject」。
 * reflect 的非严格模式对未提供的服务返回 undefined，不抛，正好当探测器用。
 *
 * @returns {object|null}
 */
function resolveBackend() {
  const ctx = shimCtx
  if (ctx === null || ctx === undefined) return null
  const reflect = ctx.reflect
  if (reflect !== null && reflect !== undefined && typeof reflect.get === 'function') {
    for (const strict of [false, true]) {
      try {
        const value = reflect.get(SERVICE_NAME, strict)
        if (value !== null && value !== undefined) return value
      } catch { /* 换下一种读法 */ }
    }
  }
  // 最后再试一次普通属性访问（万一宿主给本插件注入了该服务）。
  try {
    const value = ctx[SERVICE_NAME]
    if (value !== null && value !== undefined) return value
  } catch { /* 没有就没有 */ }
  return null
}
