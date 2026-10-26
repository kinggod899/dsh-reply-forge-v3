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

/**
 * 本插件自有的会话事件类型。
 *
 * 双类型接受的由来（2026-10-23 宿主漂移实证，PLAN §9.1）：
 * 宿主 0.2.1（hostProtocolVersion=4）在读 **v3 世代**会话文件时会触发
 * `dsh-session-format-v3-to-v4` 迁移，其中 `namespaceV3OpaqueEvent` 把
 * 「未知类型 + `ignorable: true`」的事件改名为 `plugin:<原类型>` 并**写盘**
 * （staging 临时文件 + 摘要校验 + 原子替换）。于是 0.2.0 时期写下的
 * `reply-forge/patch` 在升级后变成 `plugin:reply-forge/patch`——读侧只认
 * 旧类型的话，投影（按类型注册匹配）、血统推导、陈旧校验基准全部静默失配
 * （伪造内容退回原文且不报错）。
 *
 * 策略：**读侧双类型接受，写侧不变**。live append 写的仍是旧类型——迁移改名
 * 只发生在「读 v3 世代文件」这一条路径上，两种类型在各自宿主世代都是合法
 * 可读的（旧类型靠我们自己的 `ignorable: true` 过 fail-closed 闸门，新类型
 * 是 v4 的 plugin 记录文法）。
 */
export const PATCH_EVENT_TYPE = 'reply-forge/patch'

/** v3→v4 迁移改名后的类型（宿主 0.2.1+ 读旧文件时由迁移写入）。 */
export const PATCH_EVENT_TYPE_PLUGIN = 'plugin:reply-forge/patch'

/** 本插件 patch 事件的全部合法类型（改名前后各一）。 */
export const PATCH_EVENT_TYPES = new Set([PATCH_EVENT_TYPE, PATCH_EVENT_TYPE_PLUGIN])

/** 判定一个事件类型是否是本插件的 patch 事件（迁移改名前后都算）。 */
export function isPatchEventType(type) {
  return PATCH_EVENT_TYPES.has(type)
}

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
 * 双类型接受：v3→v4 迁移会把 `reply-forge/patch` 改名成
 * `plugin:reply-forge/patch` 写盘（见文件头），所以这里按 isPatchEventType
 * 判定而不是死认旧类型——否则升级过宿主的用户，投影基准静默退回原文。
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
    if (isPatchEventType(ev.type) === false) continue
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
  /** 被改写的推理块下标（用来连带清理 replay 元数据里的签名）。 */
  const reasoningRewritten = []
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
      reasoningRewritten.push(blockIndex)
    }
    next[blockIndex] = patched
  }
  const applied = latest.size - skipped.length
  const out = { ...message, content: next }
  // 签名还有第二个住处：`source.replayState.blocks[i].signature`。
  // provider 序列化历史时（dsh-llm-deepseek 的 readReplay → assistant()）会把
  // 它**原样回填**到 thinking 块上——只删块上的 signature 的话，伪造正文会
  // 带着「对原文的签名」发出去，签名校验型 provider（Anthropic 系）会拒掉整条
  // 请求，表现为「伪造明明写进去了，下位模型却不采信」。这里一并剥掉。
  // 缺失 signature 是合法的（validateReplay 只在「有 signature 但类型不对」时
  // 判失败），所以删掉只会让该块退化成无签名，不会让整段 replay 降级。
  const stripped = stripReplaySignatures(message?.source, reasoningRewritten)
  if (stripped !== null) out.source = stripped
  return { message: out, applied, skipped }
}

/**
 * 剥掉 `source.replayState.blocks[i]` 上的签名，返回**新** source（不改原对象：
 * 宿主的消息是 deepFreeze 的，就地改会抛）。
 *
 * 只在确实有签名可剥时才构造新对象；否则返回 null，让调用方保留原 source
 * （少一次无意义的浅拷贝，也避免给 deepFreeze 的引用做无谓替换）。
 *
 * @param {object|undefined} source 消息的 source 元数据
 * @param {number[]} blockIndexes 被改写的推理块下标
 * @returns {object|null} 新 source；无需改动时 null
 */
function stripReplaySignatures(source, blockIndexes) {
  if (blockIndexes.length === 0) return null
  if (source === null || typeof source !== 'object') return null
  const replay = source.replayState
  if (replay === null || typeof replay !== 'object') return null
  if (Array.isArray(replay.blocks) === false) return null
  let changed = false
  const blocks = replay.blocks.map((block, index) => {
    if (blockIndexes.includes(index) === false) return block
    if (block === null || typeof block !== 'object') return block
    if (!('signature' in block)) return block
    changed = true
    const copy = { ...block }
    delete copy.signature
    return copy
  })
  if (changed === false) return null
  return { ...source, replayState: { ...replay, blocks } }
}
