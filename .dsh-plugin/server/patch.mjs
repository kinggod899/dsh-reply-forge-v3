// 宿主侧 message projection（v3 的生效机制）。
//
// 宿主在折叠会话时，对每个事件先查 `projections` 里有没有同类型的定义；
// 命中就调用 `project(event, context)`，用返回的 Map<seq, message> 覆盖
// 「该 seq 的模型可见消息」。`image/offload` 用的就是这条正门。
//
// 关键约束（读宿主 dsh-session 源码确认，非猜测）：
//   · projection 按**事件类型**注册，且同一类型只能注册一个；
//   · 因此**不能**注册到 `assistant/message` 上——那会让 assistant 事件
//     走 `{kind:'project'}` 分支直接 return，永远进不了 surface.nodes，
//     把压缩/遮蔽关系整条打断；
//   · 只能注册到自己自有的事件类型上。
//
// 双类型注册（2026-10-23，PLAN §9.1）：宿主 0.2.1 的 v3→v4 迁移会把
// `reply-forge/patch` 改名成 `plugin:reply-forge/patch` 写盘，而 projection
// 是按事件类型精确匹配的——只注册旧类型的话，迁移后文件里的 patch 全部
// 匹配不上，伪造内容静默退回原文。所以两个类型各注册一个投影，
// project 函数完全共享。
//
// 兜底原则：**绝不抛错**。projection 抛错会让整个会话折叠失败（会话打不开），
// 代价远大于「这条 patch 不生效」。所以任何异常一律退化成「不覆盖」。

import { PATCH_EVENT_TYPES, applyPatch, validatePatchData } from '../../src/patch-event.mjs'

/**
 * patch 投影的生效函数（模块级共享：两种类型的投影引用同一个函数，
 * 行为不可能在两份注册之间漂移）。
 * @param {object} event patch 事件
 * @param {object} context 宿主折叠上下文（nodes / events / baseSeq / messages）
 * @returns {Map<number, object>} seq → 投影后消息
 */
function projectPatch(event, context) {
  const out = new Map()
  let data
  try {
    data = validatePatchData(event?.data)
  } catch {
    return out
  }
  const nodes = new Set(Array.isArray(context?.nodes) ? context.nodes : [])
  const events = Array.isArray(context?.events) ? context.events : []
  const baseSeq = typeof context?.baseSeq === 'number' ? context.baseSeq : 0
  const messages = context?.messages

  for (const target of data.targets) {
    // 目标必须仍是 surface 上的当前节点。被压缩遮蔽过就跳过——模型本来
    // 也看不见它了，改不改都不影响后续对话。
    if (nodes.has(target.seq) === false) continue
    const source = events[target.seq - baseSeq]
    if (source === null || typeof source !== 'object') continue
    if (source.type !== 'assistant/message') continue
    // 基准取「当前已投影的消息」：多条 patch 才能叠加（patch1 改块 0、
    // patch2 改块 1 时两者都保留）。全量回放时事件按 seq 顺序折叠，
    // 累积顺序与在线一致。
    const previous = messages !== undefined && typeof messages.get === 'function' ? messages.get(target.seq) : undefined
    const base = previous ?? source?.data?.message
    try {
      const { message } = applyPatch(base, [target])
      out.set(target.seq, message)
    } catch {
      // 单条失败不牵连其余 target
    }
  }
  return out
}

/**
 * 造一个 patch 事件的消息投影。
 * @param {string} type 要注册的事件类型（必须是 PATCH_EVENT_TYPES 之一）
 * @returns {{type: string, project: (event: object, context: object) => Map<number, object>}}
 */
function patchProjectionFor(type) {
  return { type, project: projectPatch }
}

/**
 * 本插件全部 patch 投影（迁移改名前后两种事件类型各一个）。
 * apply() 里逐个注册；宿主对同一类型只允许一个定义，重复注册会抛，
 * 调用方需各自 try 兜住（热重载场景）。
 * @type {Array<{type: string, project: (event: object, context: object) => Map<number, object>}>}
 */
export const patchProjections = [...PATCH_EVENT_TYPES].map(patchProjectionFor)

/**
 * 旧类型（`reply-forge/patch`）的单投影导出。
 * 保留给直接引用单数的调用方（测试、兼容）；新代码请用 patchProjections。
 */
export const patchProjection = patchProjections[0]
