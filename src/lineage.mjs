// 版本血统的纯推导层（v3.4「历史版本 / 还原到此版」的数据基础）。
//
// 设计第一原则：**不新增任何事件字段、不改写路径、不动投影折叠**。
// 血统的全部信息本来就躺在日志里——
//   · patch 是独立事件，原始 `assistant/message` 一个字节都没动（append-only），
//     原稿随时可从原始事件读回（「卸插件 → 投影缺席 → 伪造退回原文」正是这么
//     发生的，只是那是全局开关，且要重启）；
//   · 每条 patch 事件的 target 记录了「改成什么」，投影折叠规则是
//     「后者覆盖前者」，所以按事件顺序把所有 patch 的 target.text 排起来，
//     就是一条完整的版本链：[原稿, patch1 后的文本, patch2 后的文本, …]。
// 因此本模块只做**推导**，零依赖、无 I/O、只在用户点开「历史版本」时被调用
// 一次——不碰任何热路径（投影、写入、扫描都不经过它）。
//
// 与 ctxedit（dsh-ctxedit）的 `source.replacedBy` 血统相比，我们的链更硬：
// 它的「还原原样」依赖改写时写下的指针（0.5.1 之前没写，至今无法还原）；
// 我们的原稿在原始事件里天然存在，从第一代伪造起就可回溯。

import { isPatchEventType, readBlock, validatePatchData } from './patch-event.mjs'

/**
 * 从原始事件里读一个块的可编辑视图。
 *
 * 只认 `assistant/message`：patch 事件投影的目标本来就是它（见
 * server/patch.mjs 的 projection），血统的「第 0 版」必须与投影基准同源。
 * seq 在日志里唯一，取第一条命中的事件；它的块读不出来（被压缩改写、
 * 块不存在、不是可编辑种类）就返回 null，由调用方转成业务失败码。
 *
 * @param {object[]} events readSessionEvents 的产物
 * @param {number} seq 事件 seq
 * @param {number} blockIndex content 数组下标
 * @returns {{kind: string, text: string} | null}
 */
export function originalBlockOf(events, seq, blockIndex) {
  if (Array.isArray(events) === false) return null
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type !== 'assistant/message') continue
    if (ev.seq !== seq) continue
    return readBlock(ev?.data?.message?.content, blockIndex)
  }
  return null
}

/**
 * 推导一个块的版本栈。
 *
 * 栈的形状（与投影折叠规则逐字对应）：
 *   index 0        = 原稿（原始 assistant/message 事件的块文本）
 *   index 1..N     = 第 i 条命中该块的 patch 事件的 target.text（按事件顺序）
 *   currentIndex   = 最后一版（投影最终生效的那一版）
 *
 * 容坏与投影层保持一致：单条 patch 数据不合法（validatePatchData 抛）就跳过，
 * 不牵连其余；种类不符的 patch 跳过（宿主写入时就会拒，防御性保留）。
 * 双类型接受（isPatchEventType）：v3→v4 迁移改名后的
 * `plugin:reply-forge/patch` 同样是有效 patch 事件——漏掉它，升级过宿主的
 * 用户版本链会在迁移那一刻静默断头（只剩原稿）。
 *
 * 连续重复塌缩：同一文本紧接着再 patch 一次是空操作（投影结果不变），
 * 不占一个版本位——否则「还原到此版」列表里会出现两版一字不差的条目。
 * 非连续的重复（A→B→A）保留：那是用户刻意改回去的，是两个动作。
 *
 * @param {object[]} events readSessionEvents 的产物
 * @param {number} seq
 * @param {number} blockIndex
 * @param {string} [kind] 调用方期望的种类；不给则按原始块的种类
 * @returns {{ok: true, kind: string, versions: Array<{index:number,source:'original'|'patch',text:string,eventSeq:number|null}>, currentIndex: number}
 *          | {ok: false, reason: 'original-not-found' | 'kind-mismatch'}}
 */
export function versionStackOf(events, seq, blockIndex, kind = undefined) {
  const original = originalBlockOf(events, seq, blockIndex)
  if (original === null) return { ok: false, reason: 'original-not-found' }
  if (kind !== undefined && kind !== null && original.kind !== kind) {
    return { ok: false, reason: 'kind-mismatch' }
  }
  const versions = [{ index: 0, source: 'original', text: original.text, eventSeq: null }]
  if (Array.isArray(events) === true) {
    for (const ev of events) {
      if (ev === null || typeof ev !== 'object') continue
      if (isPatchEventType(ev.type) === false) continue
      let data
      try { data = validatePatchData(ev.data) } catch { continue }
      for (const target of data.targets) {
        if (target.seq !== seq) continue
        if (target.blockIndex !== blockIndex) continue
        if (target.kind !== original.kind) continue
        const prev = versions[versions.length - 1]
        if (prev.text === target.text) continue
        versions.push({
          index: versions.length,
          source: 'patch',
          text: target.text,
          eventSeq: typeof ev.seq === 'number' ? ev.seq : null,
        })
      }
    }
  }
  return { ok: true, kind: original.kind, versions, currentIndex: versions.length - 1 }
}
