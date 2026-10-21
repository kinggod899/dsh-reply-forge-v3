// 待发送队列（inbox）编辑：改「还没发给模型」的消息。
//
// 这是全部写入能力里唯一「零代价」的一条：
//   - 在线 patch   → 追加自有事件，要 ignorable 标记兜底，且 KV 缓存作废；
//   - 落盘改写     → 要备份还原，运行中的宿主还不读盘；
//   - 仅本机渲染   → 模型看不见，纯障眼法；
//   - 改队列（本模块）→ 消息还没进日志，无新事件、不动已提交字节、
//     sessionId 不变、provider 缓存不受影响。
//
// 接口全部来自宿主 @deepseek-ai/dsh-api-session-controller，路径都经**桌面端
// 真机源码**（app.asar 内包，不是 E:/game/DSH 那份旧副本）核对：
//   1. 读：以 inbox 投影为权威源——
//      session.projections.faceOf('inbox').getSnapshot()
//        → { 'next-turn': [...], 'next-step': [...] }。
//      宿主聊天界面渲染 pending 气泡的就是这一份（dsh-client-ui-chat：
//      `const inbox = useProjection("inbox")` →
//      `inbox["next-step"].filter(m => m.source.kind === "user")` →
//      PendingSteeringBubble，无 data-submission-echo 标记）。
//      行形状 {id, content, source: {kind, rpcId?}}，itemId = message.id。
//   2. 在途检测：消息刚发出、宿主还没入队时，界面显示的是**本地回显**
//      （PendingSubmissionBubble，带 data-submission-echo），数据在
//      session.getSnapshot().pendingSubmissions（{requestId, placement,
//      time, text, attachments}）。回显在 inbox 投影出现同 rpcId 行时退役，
//      所以「投影空 + 回显匹配」= 消息在途，等它落库即可。
//      注意：真实宿主的 getSnapshot() **没有 queue 字段**（SessionQueueMirror
//      那一支是旧版才有），别按旧副本写代码。
//   3. 写：session.updateQueue(itemId, { kind: 'edit', content: [...] })。
//      宿主 handler 用 message.id 在 agent.inbox 的 next-turn/next-step 里
//      定位并 replace（index.js updateQueue handler）。
//
// 为什么必须双机制（2026-10-21 真机 bug 二次修复）：inbox 投影是宿主界面的
// 同源数据（useProjection("inbox")），权威；但消息从输入框发出到投影帧落库
// 之间有一个窗口，界面此期间显示本地回显（pendingSubmissions），投影还是空
// 的——用户在窗口里点「改待发送」只会读到空投影。所以除了读投影，还要认识
// 回显：投影空 + 回显文本匹配 = 消息在途，轮询等它落库，不能直接报错。
// （2026-10-20 第一版修错了方向：去读 getSnapshot().queue，而真实桌面端宿主
//  的 buildSnapshot 里根本没有 queue 字段——那份接口是从旧副本核对的。）
//
// ── 2026-10-21 三次修复：投影与点击时刻可能已经对不上 ─────────────────────
// 真机诊断（bubbleKind:host、inboxNextStep:1、projectionRows:0、echoCount:0）
// 逼出一个新认知：界面气泡只可能来自 next-step 里 source.kind === 'user' 的行
// （ui-chat 源码逐字如此），而点击时刻同一份投影里那一行却不满足这个条件——
// 两者不矛盾的唯一解释是**投影在气泡渲染之后又变了**：回合结束 claim 清空
// next-step，随后插件/预置注入的非 user 行补进来，React 还没重渲染，用户点了
// 旧气泡。所以定位与提示都要为此改写：
//   1. **接管时预取锚点**：气泡出现的瞬间（投影与渲染一致）按文本解析出
//      itemId；点击时先按 id 复核——行还在就直接开编辑器，不赌文本。
//   2. **kind 过滤不放松**：宿主 prompt 走的永远是 user 行，kind 不同的行都是
//      插件注入，不是用户待发送的消息，不给编辑（宽松回匹试过，会咬到注入行，
//      已撤）。
//   3. **诚实失败**：锚点失效、严格回匹不中、回显也没有，说明这条消息真的离开
//      了队列（已被 claim 发出）——按「队列空 / 有同文本的非用户行 / 有行但
//      都对不上」三种情况分别说明，并交叉验证对话里是否已有同文本的已发送
//      气泡，别让「读不到队列」这种误导性文案再出现。

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
 * 读本地发送回显（pendingSubmissions）。
 *
 * 回显是消息已从输入框发出、但宿主 inbox 投影里还没有对应行时的界面数据
 * （dsh-client-ui-chat 的 PendingSubmissionBubble）。形状由控制器
 * client.js 的 beginSubmission() 写入：
 *   { requestId, placement: 'steering'|'queued'|'transcript', time, text, attachments }
 * 只有 placement === 'steering' 的会渲染成 pending 气泡（界面条件与投影行一致）。
 *
 * @param {unknown} session ISession
 * @returns {Array<{ requestId: string, text: string, time: number }>}
 *          空数组 = 没有回显（不是错误）
 */
export function readPendingEchoes(session) {
  try {
    if (session === null || typeof session !== 'object') return []
    if (typeof session.getSnapshot !== 'function') return []
    const snap = session.getSnapshot()
    const list = snap !== null && typeof snap === 'object' ? snap.pendingSubmissions : undefined
    if (!Array.isArray(list)) return []
    const out = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      if (item.placement !== 'steering') continue
      const requestId = typeof item.requestId === 'string' && item.requestId !== '' ? item.requestId : undefined
      const text = typeof item.text === 'string' ? item.text : ''
      if (requestId === undefined) continue
      out.push({ requestId, text, time: typeof item.time === 'number' ? item.time : 0 })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 在途判断（宽松版）：任一回显与气泡文本相当即算在途。
 *
 * 回显只回答「等不等」这一个问题——真正选哪一条由消息落库后
 * resolvePendingItem 对投影行做严格唯一匹配。两条相同文本的在途消息不该
 * 让等待提前失败（等它们都落库后由 resolvePendingItem 报歧义，那是诚实的
 * 错误），所以这里不比唯一性。
 *
 * @param {unknown} session ISession
 * @param {string} bubbleText 气泡可见文本
 * @returns {boolean}
 */
export function hasPendingEcho(session, bubbleText) {
  const raw = String(bubbleText ?? '')
  if (raw === '') return false
  const collapsed = collapseWhitespace(raw)
  return readPendingEchoes(session).some(e =>
    e.text === raw || (collapsed !== '' && collapseWhitespace(e.text) === collapsed))
}

/**
 * 读持久投影仓里的 inbox 投影——**界面同源的权威源**。
 *
 * faceOf 返回 identity-stable 的 face，**永远存在**（宿主导注释：absence is
 * an `undefined` snapshot, never a missing face），所以判空要落在 snapshot 上。
 *
 * **只收 next-step 里 source.kind === 'user' 的行**——与宿主界面渲染条件
 * 逐字对齐（ui-chat：`inbox["next-step"].filter(m => m.source.kind === "user")`）。
 * next-turn 排队消息不渲染气泡，用户点不到；把它收进来只会让同文本的等待项
 * 参与回匹、平白制造撞车。
 *
 * @param {unknown} session ISession
 * @returns {unknown[] | null} null = 读不到投影（不是空队列）
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
    return normalized.nextStep.filter(isPendingUserRow)
  } catch {
    // 投影读失败与「队列为空」是两回事，但都只能让上层提示稍后再试。
    return null
  }
}

/**
 * 读当前会话的待发送队列（inbox 投影，界面同源）。
 *
 * 只返回 `nextStep` 里 source.kind === 'user' 的行——即会渲染成 pending
 * 气泡的那一批；`next-turn` 用户看不见，不返回。
 *
 * @param {unknown} session ISession
 * @returns {unknown[] | null} null = 读不到投影（不是空队列）
 */
export function readInbox(session) {
  return readInboxProjection(session)
}

/**
 * 读 next-step 的**全部**行（不按 source.kind 过滤）。
 *
 * 存在的理由（2026-10-21 真机 bug 三修）：界面渲染 pending 气泡的条件是
 * `source.kind === 'user'`（ui-chat 逐字如此），但点击时刻读到的投影可能已经
 * 变了——回合结束 claim 会清空 next-step，随后插件/预注入的行又补进来。此时
 * 「按 kind 过滤」会把唯一可用的文本锚点一起滤掉。这一份不过滤的行给两个
 * 下游用：按 itemId 复核锚点、按文本做兜底回匹。
 *
 * @param {unknown} session ISession
 * @returns {unknown[] | null} null = 读不到投影（不是空队列）
 */
export function readInboxRows(session) {
  try {
    const projections = session === null || session === undefined ? undefined : session.projections
    const faceOf = projections === null || projections === undefined ? undefined : projections.faceOf
    if (typeof faceOf !== 'function') return null
    const face = faceOf(INBOX_KEY)
    if (face === null || face === undefined) return null
    if (typeof face.getSnapshot !== 'function') return null
    const normalized = normalizeInbox(face.getSnapshot())
    if (normalized === null) return null
    return normalized.nextStep
  } catch {
    return null
  }
}

/**
 * 读失败时的诊断快照（真机 bug 的排查设施）。
 *
 * 只读不写、全部 try 兜底；产物给 console 和控制台诊断行，用来回答「到底哪一级
 * 挂了」：session 拿没拿到、projections 在不在、inbox 投影是什么（键、行数、
 * seq）、本地回显有几条、点到的气泡是宿主气泡还是本地回显。
 *
 * 2026-10-21 起以 app.asar 内真实桌面端宿主为准：getSnapshot() 没有 queue
 * 字段，界面气泡的真源是 inbox 投影，在途消息只存在于 pendingSubmissions。
 *
 * @param {unknown} session resolveSession 的产物（可能是 null）
 * @param {{ sessionId?: unknown, bubbleKind?: string, bubbleTextHead?: string,
 *            anchor?: unknown, sentInTranscript?: boolean }} [extra]
 * @returns {Record<string, unknown>} 纯 JSON 可序列化对象
 */
export function queueDiag(session, extra = {}) {
  const out = {}
  try {
    if (extra.sessionId !== undefined) out.sessionId = String(extra.sessionId)
    if (extra.bubbleKind !== undefined) out.bubbleKind = extra.bubbleKind
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
        if (snap === undefined || snap === null) {
          out.inboxSnapshot = snap === undefined ? 'undefined' : 'null'
        } else if (typeof snap === 'object') {
          out.inboxSnapshot = Array.isArray(snap['next-step'])
            ? 'keys:' + Object.keys(snap).join(',')
            : 'object(no next-step array)'
          out.inboxNextStep = Array.isArray(snap['next-step']) ? snap['next-step'].length : 'absent'
          out.inboxNextTurn = Array.isArray(snap['next-turn']) ? snap['next-turn'].length : 'absent'
        } else {
          out.inboxSnapshot = typeof snap
        }
        if (typeof projections?.seqOf === 'function') {
          const seq = projections.seqOf(INBOX_KEY)
          out.inboxSeq = typeof seq === 'number' ? seq : String(seq)
        }
      } else {
        out.face = 'absent'
      }
    } catch (error) {
      out.inboxSnapshot = `throw:${String(error && error.message ? error.message : error)}`
    }
    try {
      const echoes = readPendingEchoes(session)
      out.echoCount = echoes.length
      out.echoTexts = echoes.map(e => `${String(e.time)}:${e.text.slice(0, 30)}`)
    } catch { out.echoCount = 'throw' }
    // next-step 每行的速写：点击时刻投影里到底有谁、kind 是什么。真机 bug 的
    // 分歧点全在这一层（inboxNextStep 有行而过滤后为 0 = 行的 kind 不是 user）。
    try {
      out.nextStepRows = describeInboxRows(readInboxRows(session))
    } catch { out.nextStepRows = 'throw' }
    try {
      const snap = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
      const subs = snap !== null && typeof snap === 'object' ? snap.pendingSubmissions : null
      if (Array.isArray(subs)) {
        const tally = { total: subs.length, steering: 0, queued: 0, transcript: 0, other: 0 }
        for (const s of subs) {
          const p = s === null || typeof s !== 'object' ? undefined : s.placement
          if (p === 'steering') tally.steering += 1
          else if (p === 'queued') tally.queued += 1
          else if (p === 'transcript') tally.transcript += 1
          else tally.other += 1
        }
        out.subPlacements = tally
      }
      const perr = snap !== null && typeof snap === 'object' ? snap.promptError : null
      if (perr !== null && perr !== undefined) {
        out.promptError = typeof perr === 'object' && typeof perr.error?.code === 'string'
          ? perr.error.code
          : 'present'
      }
    } catch { out.subPlacements = 'throw' }
    out.projectionRows = (readInboxProjection(session) ?? []).length
    // 调用方补充的定位线索：气泡文本头、锚点、对话里是否已有同文本的已发送气泡。
    if (extra.bubbleTextHead !== undefined) out.bubbleTextHead = String(extra.bubbleTextHead).slice(0, 40)
    if (extra.anchor !== undefined) out.anchor = extra.anchor
    if (extra.sentInTranscript !== undefined) out.sentInTranscript = extra.sentInTranscript === true
  } catch { /* 诊断自身绝不影响主流程 */ }
  return out
}

/**
 * next-step 行的安全速写（读属性全程兜底，单行坏掉不影响其它行）。
 *
 * 回答「点击时刻投影里这一行是什么」：id、source.kind、文本头。kind 读不出来
 * （getter 抛异常之类）记 'throw'，与 'absent' 区分——前者说明值结构异常，
 * 后者说明这行本来就没有 source。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @returns {Array<{i: number, id: string, kind: string, len: number, head: string}> | string}
 */
export function describeInboxRows(rows) {
  if (rows === null) return 'unreadable'
  if (!Array.isArray(rows)) return 'not-array'
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const entry = { i, id: '?', kind: '?', len: 0, head: '' }
    try {
      const id = rowId(row)
      entry.id = id ?? '(no-id)'
    } catch { entry.id = 'throw' }
    try {
      const source = row.source
      if (source === null || source === undefined) entry.kind = 'absent'
      else if (typeof source !== 'object') entry.kind = typeof source
      else entry.kind = typeof source.kind === 'string' ? source.kind : String(source.kind)
    } catch { entry.kind = 'throw' }
    try {
      const parts = contentText(rowContent(row))
      entry.len = parts.text.length
      entry.head = parts.text.slice(0, 30)
    } catch { entry.head = 'throw' }
    out.push(entry)
  }
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
 * @param {unknown[] | null} inbox readInbox 的产物（next-step 的 user 行）
 * @param {string} bubbleText 气泡可见文本
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
export function resolvePendingItem(inbox, bubbleText) {
  return matchPendingRow(inbox, bubbleText)
}

/**
 * 按 itemId 直接定位（强锚点复核）。
 *
 * 接管气泡时当场按文本解析出的 itemId 存在这里；点击时用它复核——行还在队列里
 * 就直接开编辑器，不用再赌文本。行已离开队列（回合结束被 claim）时返回失败，
 * 由上层走完整路径并给出「已经发出去了」的诚实提示。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @param {string} itemId 接管时记下的行 id
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
export function resolvePendingItemById(rows, itemId) {
  if (rows === null) return { ok: false, error: '读不到待发送队列，请稍后重试' }
  if (typeof itemId !== 'string' || itemId === '') return { ok: false, error: '锚点无效' }
  for (const row of rows) {
    if (rowId(row) !== itemId) continue
    const parts = contentText(rowContent(row))
    if (!parts.textOnly) return { ok: false, error: '这条待发送消息含附件，暂不支持编辑' }
    return { ok: true, itemId, text: parts.text, textOnly: true }
  }
  return { ok: false, error: '这条消息已经不在队列里了（可能已发出）' }
}

/**
 * next-step 里是否存在与气泡文本相同的行（kind 不设限）。
 *
 * 只回答「是文本对不上，还是行被 kind 过滤掉了」这一个问题，给失败文案指路：
 * 有同文本行而不能编辑 = 那行不是用户消息（注入行）；完全没有同文本行 =
 * 用户点的那条真的离开了队列（回合结束被 claim 后插件又补了行）。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @param {string} bubbleText 气泡可见文本
 * @returns {boolean}
 */
export function hasTextMatchRow(rows, bubbleText) {
  if (rows === null || !Array.isArray(rows)) return false
  const raw = String(bubbleText ?? '')
  const collapsed = collapseWhitespace(raw)
  if (raw === '') return false
  for (const row of rows) {
    const text = contentText(rowContent(row)).text
    if (text === '') continue
    if (text === raw || collapseWhitespace(text) === collapsed) return true
  }
  return false
}

/**
 * 两级文本匹配 + 唯一性约束，只认 source.kind === 'user' 的行（与界面渲染
 * 条件逐字对齐——宿主 prompt 走的永远是 user 行，kind 不同的行都是插件注入，
 * 不是用户待发送的消息，不给编辑）。
 *
 * @param {unknown[] | null} inbox readInbox 的产物
 * @param {string} bubbleText 气泡可见文本
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
function matchPendingRow(inbox, bubbleText) {
  if (inbox === null) return { ok: false, error: '读不到待发送队列，请稍后重试' }
  const raw = String(bubbleText ?? '')
  const collapsed = collapseWhitespace(raw)

  // tier 0：精确匹配。
  let exact = []
  // tier 1：折叠空白后匹配。
  let fuzzy = []
  for (const row of inbox) {
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
