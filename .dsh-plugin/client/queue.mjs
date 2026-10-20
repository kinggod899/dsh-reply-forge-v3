// 待发送队列（inbox）编辑：改「还没发给模型」的消息。
//
// 这是全部写入能力里唯一「零代价」的一条：
//   - 在线 patch   → 追加自有事件，要 ignorable 标记兜底，且 KV 缓存作废；
//   - 落盘改写     → 要备份还原，运行中的宿主还不读盘；
//   - 仅本机渲染   → 模型看不见，纯障眼法；
//   - 改队列（本模块）→ 消息还没进日志，无新事件、不动已提交字节、
//     sessionId 不变、provider 缓存不受影响。
//
// 接口全部来自宿主 @deepseek-ai/dsh-api-session-controller，三条路径都经
// 真机源码核对过，不是照 README 抄：
//   1. 读：**两个源**，UI 真源优先——
//      a. session.getSnapshot().queue（SessionQueueMirror，瞬态队列镜像）。
//         宿主聊天界面渲染 pending 气泡的就是这一份
//         （dsh-client-ui-chat：`const inbox = useSession(s => s.queue)`，
//         再按 placement === 'steering' 过滤）。行形状
//         {id, placement, rpcId?, content, preview, text}，其中
//         placement: 'steering' = 气泡可见的插入消息，'queued' = next-turn
//         排队（不渲染气泡），'context' = 上下文注入（不是用户消息）。
//      b. session.projections.faceOf('inbox').getSnapshot()（持久投影仓）。
//         行形状 {id, content, source: {kind, rpcId?}}，source.kind ===
//         'user' 的 next-step 行同样就是气泡那条。
//      两个源都拿不到才判「读不到」；任一有数据就合并（按 id 去重，镜像优先）。
//   2. 定位：气泡 DOM 上**没有任何 id 类属性**（只有 data-pending-steering /
//      data-submission-echo 两个布尔），所以 itemId 只能靠文本回匹。这是宿主
//      的限制，不是我们偷懒。
//   3. 写：session.updateQueue(itemId, { kind: 'edit', content: [...] })。
//      宿主 handler 用 message.id 在 agent.inbox 里定位（index.js:828-842），
//      两个源的 row.id 恰好都是 message.id，所以传给哪个源的 id 都成立。
//
// 为什么必须双源（2026-10-20 真机 bug）：投影仓的 'inbox' 行只靠控制流基线
// seed 或 projection 帧推送，真机上出现过「气泡明明在，projections 的 'inbox'
// 键却是 undefined」——入口一点就报「读不到待发送队列」。镜像那份由 queue
// 帧驱动（replaceControl / handleControlFrame），与界面同源同刷新，
// getSnapshot() 前还会 ensureFresh() 同步重建，所以拿它当第一源。

/** inbox 投影键。 */
export const INBOX_KEY = 'inbox'

/**
 * 只处理这一种行。
 *
 * UI 侧（dsh-client-ui-chat）渲染 pending 气泡的条件是
 * `pending: submission.placement === 'steering'`，而 'steering' 恰好对应
 * inbox['next-step'] 里 source.kind === 'user' 的行。`next-turn`（'queued'）
 * 根本不渲染气泡，用户看不见，所以也不用管。
 */
export const PENDING_SOURCE_KIND = 'user'

/**
 * 把 inbox 投影快照归一成两份队列数组。
 *
 * 快照本身 optional（zod schema 里 `'inbox': z.object({...}).optional()`），
 * 且宿主自己的 queueItems() 直接访问 `agent.inbox.nextTurn`——那意味着结构
 * 正常时两个键必有，但 client 侧读到的是经网络编解码的值，仍要按「缺失即空」
 * 处理，绝不假设。
 *
 * @param {unknown} snapshot faceOf('inbox').getSnapshot() 的返回值
 * @returns {{ nextTurn: unknown[], nextStep: unknown[] } | null} null = 读不到投影
 */
export function normalizeInbox(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const value = snapshot
  const nextTurn = Array.isArray(value['next-turn']) ? value['next-turn'] : []
  const nextStep = Array.isArray(value['next-step']) ? value['next-step'] : []
  return { nextTurn, nextStep }
}

/**
 * 读会话快照里的瞬态队列镜像（SessionQueueMirror）。
 *
 * 这是**界面上看得见的那一份**：宿主聊天界面渲染 pending 气泡的数据源就是
 * `useSession(s => s.queue)`（dsh-client-ui-chat），本模块与界面同源，
 * 不存在「气泡在、队列空」的错位。
 *
 * 行形状（client.js SessionQueueMirror.replace）：
 *   { id, messageId, placement, rpcId?, content, preview, text }
 * placement 三种：'steering'（气泡可见的插入消息，即 next-step 的 user 行）、
 * 'queued'（next-turn 排队，不渲染气泡）、'context'（上下文注入，非用户消息）。
 *
 * @param {unknown} session ISession
 * @returns {Array<{ slot: 'next-turn' | 'next-step', row: object }> | null}
 *          null = 读不到快照（不是空队列）
 */
export function readQueueMirror(session) {
  try {
    if (session === null || typeof session !== 'object') return null
    if (typeof session.getSnapshot !== 'function') return null
    const snap = session.getSnapshot()
    const queue = snap !== null && typeof snap === 'object' ? snap.queue : undefined
    if (!Array.isArray(queue)) return null
    const rows = []
    for (const item of queue) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
      if (id === undefined) continue
      const content = Array.isArray(item.content) ? item.content : []
      // 归一成与投影行一致的内部形状，resolvePendingItem 不用关心来源。
      const row = { id, content, source: { kind: PENDING_SOURCE_KIND } }
      if (item.placement === 'steering') rows.push({ slot: 'next-step', row })
      else if (item.placement === 'queued') rows.push({ slot: 'next-turn', row })
      // placement === 'context'：上下文注入行，不是用户发的，跳过。
    }
    return rows
  } catch {
    return null
  }
}

/**
 * 读持久投影仓里的 inbox 投影。
 *
 * faceOf 返回 identity-stable 的 face，**永远存在**（宿主导注释：absence is
 * an `undefined` snapshot, never a missing face），所以判空要落在 snapshot 上。
 *
 * 真机上这个源可能整键缺失（控制流基线 seed 时该会话的 agent loop 还没注册
 * inbox 投影，此后又没有新的投影帧），表现就是「气泡在、投影 undefined」——
 * 所以它只能是第二源，不能单独依赖。见 readQueueMirror 的说明。
 *
 * @param {unknown} session ISession
 * @returns {Array<{ slot: 'next-turn' | 'next-step', row: object }> | null}
 *          null = 读不到投影（不是空队列）
 */
export function readInboxProjection(session) {
  try {
    const projections = session === null || session === undefined ? undefined : session.projections
    const faceOf = projections === null || projections === undefined ? undefined : projections.faceOf
    if (typeof faceOf !== 'function') return null
    const face = faceOf(INBOX_KEY)
    if (face === null || face === undefined) return null
    if (typeof face.getSnapshot !== 'function') return null
    const normalized = normalizeInbox(face.getSnapshot())
    if (normalized === null) return null
    const rows = []
    for (const row of normalized.nextTurn) {
      if (isPendingUserRow(row)) rows.push({ slot: 'next-turn', row })
    }
    for (const row of normalized.nextStep) {
      if (isPendingUserRow(row)) rows.push({ slot: 'next-step', row })
    }
    return rows
  } catch {
    // 投影读失败与「队列为空」是两回事，但都只能让上层提示稍后再试。
    return null
  }
}

/**
 * 读当前会话的待发送队列：镜像源优先，投影源兜底，按 id 去重合并。
 *
 * 两个源都读不到才返回 null（上层提示「读不到队列」）；任一可读就合并——
 * 包括「可读但为空」（上层提示「定位不到」，与「读不到」是两种故障）。
 *
 * @param {unknown} session ISession
 * @returns {{ nextTurn: unknown[], nextStep: unknown[] } | null}
 */
export function readInbox(session) {
  const mirror = readQueueMirror(session)
  const projection = readInboxProjection(session)
  if (mirror === null && projection === null) return null
  const seen = new Set()
  const nextTurn = []
  const nextStep = []
  for (const { slot, row } of [...(mirror ?? []), ...(projection ?? [])]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    if (slot === 'next-turn') nextTurn.push(row)
    else nextStep.push(row)
  }
  return { nextTurn, nextStep }
}

/**
 * 读失败时的诊断快照（2026-10-20 真机 bug 的排查设施）。
 *
 * 只读不写、全部 try 兜底；产物给 console 和控制台诊断行，用来回答「到底哪一级
 * 挂了」：session 拿没拿到、projections 在不在、投影仓有哪些键、inbox 键值是
 * 什么、快照队列有幾行、两个源各读出幾条。
 *
 * @param {unknown} session resolveSession 的产物（可能是 null）
 * @returns {Record<string, unknown>} 纯 JSON 可序列化对象
 */
export function queueDiag(session) {
  const out = {}
  try {
    out.hasSession = session !== null && typeof session === 'object'
    if (!out.hasSession) return out
    out.ctor = typeof session.constructor?.name === 'string' ? session.constructor.name : '?'
    out.hasGetSnapshot = typeof session.getSnapshot === 'function'
    const projections = session.projections
    out.projections = projections === null || projections === undefined ? 'absent' : typeof projections
    out.faceOf = projections === null || projections === undefined ? 'absent' : typeof projections.faceOf
    try {
      const rows = projections?.rows
      out.projectionKeys = rows instanceof Map ? [...rows.keys()] : 'no-rows'
    } catch { out.projectionKeys = 'throw' }
    try {
      if (typeof projections?.faceOf === 'function') {
        const face = projections.faceOf(INBOX_KEY)
        out.face = face === null || face === undefined ? 'absent' : typeof face
        const snap = typeof face?.getSnapshot === 'function' ? face.getSnapshot() : undefined
        out.inboxSnapshot = snap === undefined ? 'undefined' : snap === null ? 'null' : typeof snap
      } else {
        out.face = 'absent'
      }
    } catch (error) {
      out.inboxSnapshot = `throw:${String(error && error.message ? error.message : error)}`
    }
    try {
      if (typeof session.getSnapshot === 'function') {
        const snap = session.getSnapshot()
        out.snapshotQueue = Array.isArray(snap?.queue)
          ? snap.queue.map(item => (item && typeof item.placement === 'string' ? item.placement : '?')).join(',')
          : 'not-array'
      }
    } catch { out.snapshotQueue = 'throw' }
    out.mirrorRows = (readQueueMirror(session) ?? []).length
    out.projectionRows = (readInboxProjection(session) ?? []).length
  } catch { /* 诊断自身绝不影响主流程 */ }
  return out
}

/** 取一行是否为「用户发的、显示成 pending 气泡」的 steering 行。 */
function isPendingUserRow(row) {
  if (row === null || typeof row !== 'object') return false
  const source = row.source
  if (source === null || typeof source !== 'object') return false
  return source.kind === PENDING_SOURCE_KIND
}

/** 行 id 必须是可用字符串，否则 updateQueue 无从下手。 */
function rowId(row) {
  const id = row === null || row === undefined ? undefined : row.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 取一行的 content 数组（缺失按空数组，容错）。
 * @returns {unknown[]}
 */
export function rowContent(row) {
  if (row === null || typeof row !== 'object') return []
  const content = row.content
  return Array.isArray(content) ? content : []
}

/**
 * content blocks → 纯文本。
 *
 * `textOnly` 表示这一行**只有文本块**。QueueAction.edit 只接受文本内容
 * （宿主导览原话：Non-empty text-only replacement content），带附件时改写会
 * 静默丢附件 —— 我们宁可拒绝编辑，不做静默丢失。
 *
 * @param {unknown[]} blocks
 * @returns {{ text: string, textOnly: boolean }}
 */
export function contentText(blocks) {
  let text = ''
  let textOnly = true
  if (!Array.isArray(blocks)) return { text, textOnly }
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') { textOnly = false; continue }
    const type = block.type
    if (type === 'text') {
      const value = block.text
      if (typeof value === 'string') { text += value; continue }
    }
    // 非文本块（image / file / …）→ 标记，但仍继续拼文本以便提示用。
    textOnly = false
  }
  return { text, textOnly }
}

/** 折叠连续空白：markdown 渲染会把换行/缩进抹掉，DOM 文本与原文只在这一层可比。 */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 提取 pending 气泡的可见文本。
 *
 * 必须剔除两类节点，否则文本永远对不上：
 *   1. `[data-clock]`：宿主持有的时间戳，不是消息内容；
 *   2. **本插件注入的 UI**：编辑按钮/编辑器是挂在气泡容器里的，它们的文字
 *     会被算进气泡文本——按钮一旦挂上，定位就永远失败（踩过）。
 * 第 2 类由调用方通过 skipSelector 传入（queue.mjs 不关心 rf3-* 前缀）。
 *
 * @param {Element} row
 * @param {string} [skipSelector] 要剔除的节点选择器，逗号列表
 * @returns {string}
 */
export function bubbleTextOf(row, skipSelector = '[data-clock]') {
  try {
    if (row === null || row === undefined) return ''
    if (typeof row.cloneNode !== 'function') return ''
    const clone = row.cloneNode(true)
    if (clone === null || clone === undefined) return ''
    if (typeof clone.querySelectorAll !== 'function') return ''
    const skip = typeof skipSelector === 'string' && skipSelector !== '' ? skipSelector : '[data-clock]'
    for (const node of clone.querySelectorAll(skip)) node.remove()
    const text = clone.textContent
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * 把气泡文本回匹到队列行，拿出 itemId。
 *
 * 两级匹配 + **歧义拒绝**：
 *   tier 0  气泡文本与行文本完全相同；
 *   tier 1  折叠空白后相同（吃掉 markdown 渲染造成的换行差异）。
 * 先扫 tier 0：恰好一条就用，**多于一条直接拒绝**（文本撞车时改哪条都是赌）；
 * tier 0 无果再扫 tier 1，同样要求唯一。
 *
 * 之所以比对面保守：对面在多个相同文本匹配时取出现顺序第一条。队列里两条一字
 * 不差的待发送消息虽然少见，但改错一条的代价是用户的消息被悄悄换掉，而这里是
 * 纯文本回匹、没有任何强锚点可依，宁可提示「定位不准」也不能猜。
 *
 * @param {{ nextTurn: unknown[], nextStep: unknown[] } | null} inbox normalizeInbox 的产物
 * @param {string} bubbleText 气泡可见文本
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
export function resolvePendingItem(inbox, bubbleText) {
  if (inbox === null) return { ok: false, error: '读不到待发送队列，请稍后重试' }
  const raw = String(bubbleText ?? '')
  const collapsed = collapseWhitespace(raw)

  // tier 0：精确匹配。
  let exact = []
  // tier 1：折叠空白后匹配。
  let fuzzy = []
  for (const row of inbox.nextStep) {
    if (!isPendingUserRow(row)) continue
    const parts = contentText(rowContent(row))
    if (parts.text === raw && raw !== '') exact.push({ row, parts })
    else if (parts.text !== '' && collapseWhitespace(parts.text) === collapsed) fuzzy.push({ row, parts })
  }

  const picked = pickUnique(exact) ?? pickUnique(fuzzy)
  if (picked === undefined) {
    if (exact.length > 1 || fuzzy.length > 1) {
      return { ok: false, error: '队列里有多个相同的待发送消息，无法定位，请在队列变化后重试' }
    }
    return { ok: false, error: '消息还在发送或已经变化，无法定位，请稍后重试' }
  }
  if (!picked.parts.textOnly) {
    return { ok: false, error: '这条待发送消息含附件，暂不支持编辑' }
  }
  const itemId = rowId(picked.row)
  if (itemId === undefined) {
    return { ok: false, error: '无法定位这条待发送消息，请稍后重试' }
  }
  return { ok: true, itemId, text: picked.parts.text, textOnly: true }
}

/**
 * 候选集合里恰好一条才返回，否则 undefined。
 * 空文本行不参与（空串会和任何空气泡误配）。
 */
function pickUnique(candidates) {
  if (candidates.length !== 1) return undefined
  const only = candidates[0]
  if (only.parts.text === '') return undefined
  return only
}

// ── 写入：session.updateQueue ────────────────────────────────────────────

/**
 * updateQueue 的业务错误码 → 中文。
 *
 * 码表不是抄来的，逐个在宿主源码里核对过，全部出自
 * `@deepseek-ai/dsh-api-session-controller/lib/index.js` 的 updateQueue
 * handler（822-845 行）：
 *   - session/attachment-invalid：content 里含非 text 块（824 行）
 *   - gateway/bad-request：空或纯空白文本（825 行）
 *   - session/queue-item-not-found：会话没有活 agent，或 item 已不在队列（828/842 行）
 *   - session/steer-unavailable：kind 为 steer 但目标不是 next-turn 或回合没在跑（845 行）
 * steer 这条我们暂时不产（见下方说明），列出来只为别把它误译成别的意思。
 *
 * @param {string} [code]
 * @returns {string | undefined} undefined = 未知码，交给调用方用原始 message
 */
export function explainQueueError(code) {
  switch (code) {
    case 'session/queue-item-not-found':
      return '这条消息已经不在队列里了（可能已发出）'
    case 'session/attachment-invalid':
      return '修改失败：队列编辑只能保存纯文本，附件会丢失'
    case 'gateway/bad-request':
      return '内容不能为空'
    case 'session/steer-unavailable':
      return '当前回合已经不能接受这条消息了'
    default:
      return undefined
  }
}

/**
 * RemoteResult → 失败原因文本。
 *
 * 形状按 `{ ok, value }` / `{ ok, error: { code, message } }` 解，两种都容忍：
 * 码认识就用中文，不认识的退回宿主原文（那通常已经是可读的业务说明）。
 *
 * @param {unknown} result session.updateQueue 的返回值
 * @returns {string | null} null = 成功了
 */
export function updateQueueFailure(result) {
  if (result === null || result === undefined) return '保存失败，请稍后重试'
  if (typeof result !== 'object') return '保存失败，请稍后重试'
  const res = result
  if (res.ok === true) return null
  const error = res.error
  if (error === null || typeof error !== 'object') {
    // 抛到 invoke 的那一半：没有 RemoteResult 形状就当异常处理。
    return '保存失败，请稍后重试'
  }
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' ? error.message : ''
  return explainQueueError(code) ?? (message !== '' ? message : '保存失败，请稍后重试')
}

/**
 * 调官方 updateQueue 改一条待发送消息的文本。
 *
 * 我们**只发 kind: 'edit' 且纯文本**。handler 明确拒绝任何非 text 块，附件场景
 * 由 resolvePendingItem 在上游就挡掉了，不会走到这里被服务端拒。
 *
 * steer / remove 不做：handler 要求 steer 的目标必须是 next-turn 且回合在跑
 * （index.js 845 行），而带 data-pending-steering 气泡的恰好是 next-step
 * （placement 'steering'）——两者不重叠，要做 steer 得另找 UI 锚点，那是独立
 * 一件事，不塞进这个模块。
 *
 * @param {{ updateQueue?: Function }} session ISession
 * @param {string} itemId resolvePendingItem 给出的行 id
 * @param {string} text 新文本
 * @returns {Promise<string | null>} null = 成功；否则为可读失败原因
 */
export async function submitQueueEdit(session, itemId, text) {
  try {
    if (session === null || session === undefined) return '当前会话还没准备好，稍后再试'
    if (typeof session.updateQueue !== 'function') return '当前宿主版本不支持编辑待发送消息'
    const result = await session.updateQueue(itemId, {
      kind: 'edit',
      content: [{ type: 'text', text }],
    })
    return updateQueueFailure(result)
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : ''
    return message !== '' ? message : '保存失败，请稍后重试'
  }
}
