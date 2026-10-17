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
//   · 只能注册到自己自有的事件类型（`reply-forge/patch`）上。
//
// 兜底原则：**绝不抛错**。projection 抛错会让整个会话折叠失败（会话打不开），
// 代价远大于「这条 patch 不生效」。所以任何异常一律退化成「不覆盖」。

import { PATCH_EVENT_TYPE, applyPatch, validatePatchData } from '../../src/patch-event.mjs'

/**
 * patch 事件的消息投影。
 * @type {{type: string, project: (event: object, context: object) => Map<number, object>}}
 */
export const patchProjection = {
  type: PATCH_EVENT_TYPE,
  project(event, context) {
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
  },
}
