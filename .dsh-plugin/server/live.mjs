// 在线写入与在线读取（v3 相对 v2 的全部增量）。
//
// v2 只能改**磁盘**上的会话记录，所以必须重启 DSH 才生效（宿主内存里还是旧内容，
// 重启后从磁盘重放才会读到新文本）。v3 直接写**活着的**会话对象：
//   · 读取：从 `session.surface.nodes` 按模型可见顺序取节点，用
//     `surface.deriveEventMessage()` 拿**投影后**的消息——与模型看到的完全一致；
//   · 写入：`session.append('reply-forge/patch', ...)` 追加一条纯日志事件，
//     由 projection 把目标消息改写掉。下一次请求立即生效，无需重启。
//
// 为什么不能直接对 assistant/message 做 surface replacement：
// 宿主要求 replace 事件用 sourceEventSeqs 覆盖全部被遮蔽节点，同时又硬性
// 禁止 assistant/message 携带 sourceEventSeqs——两条约束互斥，必然抛错。
// 详见 src/patch-event.mjs 文件头。
//
// 业务失败一律返回 `{ok:false, code}` 而不是抛：路由层要拿 code 做分支。

import { PATCH_EVENT_TYPE, buildPatchData, listBlocks, readBlock } from '../../src/patch-event.mjs'
import { APPEND_UNSAFE, WRITER_NOT_ROUTED, ensureIgnorableShim, verifySessionWriter } from './ignorable.mjs'

/** 失败码 → 给用户看的中文原因。 */
const REASON = {
  NO_SESSIONS_SERVICE: '宿主没有 sessions 服务，无法在线写入',
  SESSION_NOT_LIVE: '这个会话当前不在内存里（未打开或已关闭），只能走落盘写入',
  SHADOWED: '这条消息已被压缩摘要遮蔽，模型已经看不见它了，改它没有意义',
  NOT_ASSISTANT_MESSAGE: '目标 seq 不是助手消息',
  NO_CONTENT: '目标消息没有可编辑内容',
  NOT_EDITABLE_BLOCK: '目标块不是可编辑的正文/推理块',
  KIND_MISMATCH: '目标块的种类与请求不符（可能界面已过期）',
  STALE_TARGET: '内存里的正文与界面看到的不一致（界面已过期），已拒绝写入',
  APPEND_FAILED: '宿主拒绝追加伪造事件',
  APPEND_UNSAFE: '没法确认伪造事件落盘时会带上「可忽略」标记，在线写入会把会话写坏，已拒绝（可改用落盘写入）',
  WRITER_NOT_ROUTED: '宿主持久化没有在跟这个会话，在线写入不会落盘，已拒绝（可改用落盘写入）',
}

/** 构造失败结果。 */
function fail(code, extra = {}) {
  return { ok: false, code, error: REASON[code] ?? code, ...extra }
}

/** 取活会话对象；拿不到返回 undefined。 */
function liveSession(sessions, sessionId) {
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  let session
  try { session = sessions.get(sessionId) } catch { return undefined }
  if (session === undefined || session === null) return undefined
  if (session.surface === undefined || session.surface === null) return undefined
  return session
}

/** 本机是否具备在线能力（供 UI 决定默认按钮文案）。 */
export function liveCapable(sessions) {
  return sessions !== undefined && sessions !== null && typeof sessions.get === 'function'
}

/**
 * 会话当前是否活着（在宿主持久化后端的写路由里）。
 * 路由层用它提示「直接改磁盘有并发覆盖风险」——活着不等于被持久化，
 * 但要先挡「活着且被持久化」的那种。
 * @param {object} sessions 宿主 sessions 服务
 * @param {string} sessionId
 * @returns {boolean}
 */
export function sessionIsLive(sessions, sessionId) {
  return liveSession(sessions, sessionId) !== undefined
}

/**
 * 在线读取：模型当前能看见的助手块。
 * @param {object} sessions 宿主 sessions 服务
 * @param {string} sessionId
 * @returns {{ok: true, mode: 'live', sessionId: string, events: number, total: number,
 *            blocks: Array<{seq: number, blockIndex: number, kind: string, text: string}>,
 *            patched: Array<{seq: number, blockIndex: number}>} | {ok: false, code: string, error: string}}
 */
export function readLiveBlocks(sessions, sessionId) {
  const session = liveSession(sessions, sessionId)
  if (session === undefined) {
    const code = typeof sessions?.get === 'function' ? 'SESSION_NOT_LIVE' : 'NO_SESSIONS_SERVICE'
    return fail(code)
  }
  try {
    const nodes = session.surface.nodes
    const blocks = []
    const patched = []
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event === null || event === undefined) continue
      if (event.type !== 'assistant/message') continue
      const message = session.surface.deriveEventMessage(event)
      if (message === null || message === undefined) continue
      const base = event?.data?.message
      for (const block of listBlocks(message.content)) {
        // 与原始事件的同一块逐个比对：投影改写了哪块就记哪块。
        // 形状与落盘读（routes.mjs 的 patched）保持一致——{seq, blockIndex}，
        // 客户端拿到的契约不分在线/落盘。
        const origin = readBlock(base?.content ?? [], block.blockIndex)
        // rawText = **未投影**的原文。客户端拿它当覆盖表的规范键（内容寻址）：
        // 宿主 UI 不渲染投影，刷新后页面上是原文，只有锚在原文上的键才对得上
        // （2026-10-26 BUG-7：锚在「接管那一刻 DOM 文本」上，反复编辑后会锚到
        // 上一版伪造，刷新后键失配 → 覆盖失效 → 显示回原文）。
        blocks.push({
          seq,
          blockIndex: block.blockIndex,
          kind: block.kind,
          text: block.text,
          rawText: origin?.text ?? block.text,
        })
        if ((origin?.text ?? null) !== block.text) {
          patched.push({ seq, blockIndex: block.blockIndex })
        }
      }
    }
    return {
      ok: true,
      mode: 'live',
      sessionId,
      events: typeof session.seq === 'number' ? session.seq : nodes.length,
      total: blocks.length,
      blocks,
      patched,
    }
  } catch (error) {
    return fail('SESSION_NOT_LIVE', { detail: String((error && error.message) || error) })
  }
}

/**
 * 在线写入：追加一条 patch 事件，立即改变模型可见内容。
 * @param {object} sessions 宿主 sessions 服务
 * @param {{sessionId: string, seq: number, blockIndex: number, kind: string,
 *          newText: string, expectText?: string}} req
 * @returns {{ok: true, mode: 'live', sessionId: string, eventSeq: number,
 *            target: {seq: number, blockIndex: number, kind: string}} | {ok: false, code: string, error: string}}
 */
export function forgeLive(sessions, req) {
  const session = liveSession(sessions, req?.sessionId)
  if (session === undefined) {
    const code = typeof sessions?.get === 'function' ? 'SESSION_NOT_LIVE' : 'NO_SESSIONS_SERVICE'
    return fail(code)
  }
  if (typeof req.newText !== 'string') return fail('NOT_EDITABLE_BLOCK', { detail: 'newText required' })

  // 1. 目标必须仍是 surface 上的当前节点（否则已被压缩遮蔽）
  let nodes
  try { nodes = session.surface.nodes } catch (error) { return fail('SESSION_NOT_LIVE', { detail: String(error?.message ?? error) }) }
  if (Array.isArray(nodes) === false || nodes.includes(req.seq) === false) return fail('SHADOWED', { seq: req.seq })

  // 2. 目标必须是助手消息，且块可编辑
  const event = session.eventAt(req.seq)
  if (event === null || event === undefined) return fail('SHADOWED', { seq: req.seq })
  if (event.type !== 'assistant/message') return fail('NOT_ASSISTANT_MESSAGE', { actual: event.type })
  const content = event?.data?.message?.content
  if (Array.isArray(content) === false) return fail('NO_CONTENT')
  const view = readBlock(content, req.blockIndex)
  if (view === null) return fail('NOT_EDITABLE_BLOCK', { blockIndex: req.blockIndex })
  if (typeof req.kind === 'string' && req.kind !== '' && req.kind !== view.kind) {
    return fail('KIND_MISMATCH', { expected: req.kind, actual: view.kind })
  }

  // 3. 陈旧校验：界面看到的那份文本必须与当前生效文本逐字节一致。
  //    注意基准取的是**投影后**的文本——用户看到的就是它，比对它才不会误判。
  const current = currentTextOf(session, event, req.blockIndex)
  if (typeof req.expectText === 'string' && current !== null && current !== req.expectText) {
    return fail('STALE_TARGET', { actual: current, expected: req.expectText })
  }

  // 4. P0 安全闸门：patch 事件对宿主是**未知类型**，落盘时必须带
  //    `ignorable: true`，否则宿主下次读这个会话时会 fail-closed 拒绝整条
  //    日志（会话打不开）。标记由 ignorable.mjs 在持久化写句柄上补。
  //    这里做**每会话核验**：只证明「钩子挂上了」不够——必须确认这个会话的
  //    写句柄真的存在、且当前生效的 persistContiguous 确实被我们包着。
  //    核不过就拒绝写入，绝不把用户的会话写坏。详见 ignorable.mjs 文件头。
  const shim = ensureIgnorableShim()
  if (shim.ok !== true) return fail(APPEND_UNSAFE, { detail: shim.reason })
  const writer = verifySessionWriter(req.sessionId)
  if (writer.ok !== true) return fail(writer.code, { detail: writer.reason })

  // 5. 追加 patch 事件。不带 surfaceOp/sourceEventSeqs：
  //    本插件的事件类型对宿主是未知类型，带 surfaceOp 会被 surfaceOpOf 抛。
  let data
  try {
    data = buildPatchData([{ seq: req.seq, blockIndex: req.blockIndex, kind: view.kind, text: req.newText }])
  } catch (error) {
    return fail('NOT_EDITABLE_BLOCK', { detail: String(error?.message ?? error) })
  }
  let appended
  try {
    appended = session.append(PATCH_EVENT_TYPE, data)
  } catch (error) {
    return fail('APPEND_FAILED', { detail: String(error?.message ?? error) })
  }
  return {
    ok: true,
    mode: 'live',
    sessionId: req.sessionId,
    eventSeq: typeof appended?.seq === 'number' ? appended.seq : null,
    // 写前已逐会话核验：该会话的写句柄存在且 persistContiguous 确为本插件
    // 包装（brand + WeakSet 双重校验）。这是「标记会补上」的**写入侧**凭据；
    // 持久化本身由宿主异步完成，失败只会丢事件（缓冲区保留、下轮重试），
    // 不会写出缺标记的坏行。供 UI/排错用。
    ignorableStamped: true,
    writerVerified: true,
    target: { seq: req.seq, blockIndex: req.blockIndex, kind: view.kind },
  }
}

/** 取某条助手消息某块当前生效的文本（投影后）。取不到返回 null。 */
function currentTextOf(session, event, blockIndex) {
  try {
    const message = session.surface.deriveEventMessage(event)
    const view = readBlock(message?.content, blockIndex)
    return view === null ? null : view.text
  } catch {
    return null
  }
}
