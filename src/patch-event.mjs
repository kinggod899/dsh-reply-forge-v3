// 在线伪造的纯数据层（v3 核心）。
//
// 为什么需要这一层：宿主把「模型能看见什么」这件事收在会话的 surface 折叠里，
// 而对 `assistant/message` 直接做 surface replacement 是**结构上不可能**的——
//   · `assertSourceEventReferences` 要求 replace 事件的 sourceEventSeqs
//     覆盖每一个被遮蔽的节点；
//   · 同一函数又对 `assistant/message` 硬性禁止携带 sourceEventSeqs。
// 两条约束合起来，`assistant/message` + `{op:'replace'}` 必然抛
// `sourceEventSeqs must include every shadowed surface node`。
//
// 宿主为此留的正门是 **message projection**：一个按事件类型注册的纯函数，
// 在折叠时把「某个 seq 的模型可见消息」替换成任意值。所以 v3 的做法是：
//   1. 追加一个自有的、非 surface 的事件 `reply-forge/patch`（纯日志记录，
//      不进 surface，不影响压缩/遮蔽关系）；
//   2. 注册同类型的 projection，把目标 seq 的消息按 patch 内容改写。
// 宿主对「仓库外插件的事件类型」的设计就是这条路径：未知类型不带 surfaceOp
// 时既不报错也不进 surface；`ignorable` 只是持久化读取侧的兼容标记。
//
// 本文件是零依赖纯函数，宿主侧（projection / 路由）与测试共用同一份实现，
// 避免「校验逻辑在两边漂移」——这正是本项目反复踩到的 bug 类型。

/** 本插件自有的会话事件类型。 */
export const PATCH_EVENT_TYPE = 'reply-forge/patch'

/** patch 数据版本。形状变化时递增，旧版数据一律拒绝解释。 */
export const PATCH_VERSION = 1

/** 可编辑的块种类 → 会话记录里的 block.type。 */
const KIND_TO_BLOCK_TYPE = {
  text: ['text'],
  reasoning: ['reasoning', 'thinking'],
}

/** 会话记录 block.type → 对外的块种类。 */
function kindOfBlockType(type) {
  if (type === 'text') return 'text'
  if (type === 'reasoning' || type === 'thinking') return 'reasoning'
  return null
}

/** 非负安全整数判定（与宿主 isEventSeq 同构）。 */
function isIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * 读一个内容块的可编辑视图。
 * @param {unknown} content 消息的 content 数组
 * @param {number} blockIndex content 数组下标（含推理块，与 session-log 一致）
 * @returns {{kind: string, text: string} | null} 不可编辑时返回 null
 */
export function readBlock(content, blockIndex) {
  if (Array.isArray(content) === false) return null
  if (isIndex(blockIndex) === false) return null
  const block = content[blockIndex]
  if (block === null || typeof block !== 'object') return null
  const kind = kindOfBlockType(block.type)
  if (kind === null) return null
  if (typeof block.text !== 'string') return null
  return { kind, text: block.text }
}

/**
 * 列出消息里所有可编辑块。
 * @param {unknown} content
 * @returns {Array<{blockIndex: number, kind: string, text: string}>}
 */
export function listBlocks(content) {
  if (Array.isArray(content) === false) return []
  const out = []
  content.forEach((block, i) => {
    const view = readBlock(content, i)
    if (view !== null) out.push({ blockIndex: i, kind: view.kind, text: view.text })
  })
  return out
}

/**
 * 构造一条 patch 事件的数据体。
 * @param {Array<{seq: number, blockIndex: number, kind: string, text: string}>} targets
 * @returns {{version: number, targets: Array}}
 */
export function buildPatchData(targets) {
  const data = {
    version: PATCH_VERSION,
    targets: targets.map(t => ({ seq: t.seq, blockIndex: t.blockIndex, kind: t.kind, text: t.text })),
  }
  validatePatchData(data)
  return data
}

/**
 * 从事件日志里收集全部 patch 事件，按 (seq, blockIndex) 归并出
 * 「当前生效的投影文本」。后写的 patch 覆盖先写的（与投影叠加规则一致）。
 *
 * 落盘读取必须过这一步：会话文件里可能已经有本插件的在线伪造（被宿主持久化
 * 落盘的 patch 事件），不应用它们的话「磁盘读到的原文」与「模型实际看到的
 * 投影后文本」不一致——写入时的陈旧校验拿旧文本当基准，会被在线路径的
 * STALE_TARGET 拒掉（真机 2026-10-17：seq=15 的块就是这么被拒的）。
 *
 * 容坏：单条 patch 数据不合法就跳过（validatePatchData 会抛），不牵连其余。
 *
 * @param {object[]} events readSessionEvents 的产物
 * @returns {Map<number, Map<number, string>>} seq → blockIndex → 投影后文本
 */
export function projectedTextsOf(events) {
  const out = new Map()
  if (Array.isArray(events) === false) return out
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type !== PATCH_EVENT_TYPE) continue
    let data
    try { data = validatePatchData(ev.data) } catch { continue }
    for (const target of data.targets) {
      let byBlock = out.get(target.seq)
      if (byBlock === undefined) { byBlock = new Map(); out.set(target.seq, byBlock) }
      byBlock.set(target.blockIndex, target.text)
    }
  }
  return out
}

/**
 * 校验 patch 数据体。任一不符即抛（projection 里抛错会被宿主当折叠失败处理，
 * 所以这里必须严格——宁可整条 patch 不生效，也不要写出半截的可见消息）。
 * @param {unknown} data
 * @returns {{version: number, targets: Array}} 通过校验的原值
 */
export function validatePatchData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(PATCH_EVENT_TYPE + ': data must be an object')
  }
  if (data.version !== PATCH_VERSION) {
    throw new Error(PATCH_EVENT_TYPE + ': unsupported version ' + String(data.version))
  }
  if (Array.isArray(data.targets) === false || data.targets.length === 0) {
    throw new Error(PATCH_EVENT_TYPE + ': targets must be a nonempty array')
  }
  for (const target of data.targets) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(PATCH_EVENT_TYPE + ': each target must be an object')
    }
    if (isIndex(target.seq) === false) {
      throw new Error(PATCH_EVENT_TYPE + ': target seq must be a non-negative safe integer')
    }
    if (isIndex(target.blockIndex) === false) {
      throw new Error(PATCH_EVENT_TYPE + ': target blockIndex must be a non-negative safe integer')
    }
    if (KIND_TO_BLOCK_TYPE[target.kind] === undefined) {
      throw new Error(PATCH_EVENT_TYPE + ': target kind must be text or reasoning')
    }
    if (typeof target.text !== 'string') {
      throw new Error(PATCH_EVENT_TYPE + ': target text must be a string')
    }
  }
  return data
}

/**
 * 把一条 patch 的 targets 应用到消息上，返回新消息。
 *
 * 基准消息取「当前已投影的消息」而不是原始事件，这样多条 patch 能叠加：
 * patch1 改块 0、patch2 改块 1 时，后者的投影以 patch1 的结果为基准，
 * 两个改动同时保留。同名 target 重复 patch 时后者覆盖前者（幂等）。
 *
 * @param {object} message 基准消息（已深冻结，不要就地改）
 * @param {Array} targets 已通过 validatePatchData 的 targets
 * @returns {{message: object, applied: number, skipped: Array}}
 */
export function applyPatch(message, targets) {
  const content = message?.content
  if (Array.isArray(content) === false) {
    throw new Error(PATCH_EVENT_TYPE + ': target message has no content array')
  }
  // 同名 target 后写覆盖先写：先按 blockIndex 归并，只留最后一个。
  const latest = new Map()
  for (const target of targets) latest.set(target.blockIndex, target)

  const skipped = []
  const next = content.slice()
  for (const [blockIndex, target] of latest) {
    const view = readBlock(content, blockIndex)
    if (view === null) {
      // 块不存在、或不是 text/reasoning——被压缩/被改写过的会话里会发生。
      // 不抛：其余 target 照常生效，单条失效不牵连整条 patch。
      skipped.push({ blockIndex, reason: 'not-editable-block' })
      continue
    }
    if (target.kind !== view.kind) {
      skipped.push({ blockIndex, reason: 'kind-mismatch' })
      continue
    }
    const patched = { ...content[blockIndex], text: target.text }
    // 改推理块必须同时剥掉签名：签名是对**原文**做的，正文一改就与签名不符，
    // 部分 provider 会据此拒掉整条请求。离线路径（stripSignaturesInEvent）
    // 走的是同一条规则，这里保持一致。
    if (target.kind === 'reasoning') {
      delete patched.signature
      delete patched.thinkingSignature
    }
    next[blockIndex] = patched
  }
  const applied = latest.size - skipped.length
  return { message: { ...message, content: next }, applied, skipped }
}
