// inbox 队列编辑的单元测试（tests/queue.test.mjs）。
//
// 盯三件事：
//   1. **itemId 只能靠文本回匹**——宿主 DOM 上没有任何 id 类属性，所以定位
//      逻辑的正确性全靠这里兜。歧义（多条同文本）必须拒绝，不能像"取第一条"
//      那样赌。
//   2. 附件必须拒绝而非静默丢失。QueueAction.edit 只接受文本，改写带附件的
//      消息会把附件悄悄抹掉。
//   3. 错误码中文化必须对得上宿主源码 index.js:822-845，不能凭空编。
//
// 运行：node tests/queue.test.mjs
import assert from 'node:assert/strict'
import { mk } from './dom-stub.mjs'
import {
  normalizeInbox, readInbox, readInboxProjection, readInboxRows, queueDiag,
  contentText, bubbleTextOf, collapseWhitespace,
  resolvePendingItem, resolvePendingItemById, hasTextMatchRow, describeInboxRows,
  explainQueueError, updateQueueFailure, submitQueueEdit,
  readPendingEchoes, hasPendingEcho,
} from '../.dsh-plugin/client/queue.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一条 next-step 里的 user 行。 */
const userRow = (id, text, extra = {}) => ({
  id,
  content: [{ type: 'text', text }],
  source: { kind: 'user', ...(extra.rpcId === undefined ? {} : { rpcId: extra.rpcId }) },
})
/** 造一条带附件的行。 */
const fileRow = (id, text) => ({
  id,
  content: [{ type: 'text', text }, { type: 'file', file: { name: 'a.png' } }],
  source: { kind: 'user' },
})
const inboxOf = (...rows) => rows

// ── normalizeInbox ────────────────────────────────────────────────────────

test('归一：非对象 / null / undefined 一律 null', () => {
  assert.equal(normalizeInbox(null), null)
  assert.equal(normalizeInbox(undefined), null)
  assert.equal(normalizeInbox('x'), null)
  assert.equal(normalizeInbox(42), null)
})

test('归一：两个键缺失当空队列，不抛', () => {
  const out = normalizeInbox({})
  assert.deepEqual(out, { nextTurn: [], nextStep: [] })
})

test('归一：只给一个键也能用（另一条补空）', () => {
  const out = normalizeInbox({ 'next-step': [userRow('i1', '甲')] })
  assert.deepEqual(out.nextStep.length, 1)
  assert.deepEqual(out.nextTurn, [])
})

test('归一：键值不是数组时当空（网络编解码后的值不可全信）', () => {
  const out = normalizeInbox({ 'next-step': 'oops', 'next-turn': 7 })
  assert.deepEqual(out, { nextTurn: [], nextStep: [] })
})

// ── readInbox ─────────────────────────────────────────────────────────────

test('读取：正常投影只返回 next-step 的 user 行（next-turn 不渲染气泡）', () => {
  const session = {
    projections: {
      faceOf: key => ({
        getSnapshot: () => key === 'inbox'
          ? { 'next-turn': [userRow('t1', '排队')], 'next-step': [userRow('s1', '插入')] }
          : undefined,
      }),
    },
  }
  const inbox = readInbox(session)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].id, 's1')
})

test('读取：快照 undefined（键还没有值）→ null', () => {
  const session = { projections: { faceOf: () => ({ getSnapshot: () => undefined }) } }
  assert.equal(readInbox(session), null)
})

test('读取：faceOf 抛异常 → null（不是空队列，上层要能区分）', () => {
  const session = { projections: { faceOf: () => { throw new Error('boom') } } }
  assert.equal(readInbox(session), null)
})

test('读取：session / projections 缺失 → null', () => {
  assert.equal(readInbox(null), null)
  assert.equal(readInbox(undefined), null)
  assert.equal(readInbox({}), null)
  assert.equal(readInbox({ projections: null }), null)
})

test('读取：face 没有 getSnapshot → null', () => {
  const session = { projections: { faceOf: () => ({}) } }
  assert.equal(readInbox(session), null)
})

// ── readInboxRows（不过滤 kind 的原始 next-step 行，2026-10-21 三修）────────

test('原始行：不过滤 kind，next-step 全部行都返回（含插件注入行）', () => {
  const session = {
    projections: {
      faceOf: key => ({
        getSnapshot: () => key === 'inbox'
          ? {
              'next-turn': [userRow('t1', '排队')],
              'next-step': [userRow('s1', '用户消息'), { id: 'p1', content: [{ type: 'text', text: '注入' }], source: { kind: 'preset' } }],
            }
          : undefined,
      }),
    },
  }
  const rows = readInboxRows(session)
  assert.equal(rows.length, 2, 'next-step 全部行都在')
  assert.equal(rows[0].id, 's1')
  assert.equal(rows[1].source.kind, 'preset')
  // 与 readInbox 的分工：一个给锚点/诊断，一个给严格回匹。
  assert.equal(readInbox(session).length, 1)
})

test('原始行：投影读不到 → null（与 readInbox 同判据）', () => {
  assert.equal(readInboxRows(null), null)
  assert.equal(readInboxRows({}), null)
  const session = { projections: { faceOf: () => ({ getSnapshot: () => undefined }) } }
  assert.equal(readInboxRows(session), null)
})

// ── faceOf 绑定调用回归（2026-10-21 真机 bug 四修根因）────────────────────

test('回归：faceOf 是按宿主形状的 class 方法（内部用 this），裸调用必抛', () => {
  // 之前所有桩都用箭头函数写 faceOf（不碰 this），unbound 调用在桩里能跑、
  // 在真机上必抛 TypeError —— 两个版本的「投影读到 0 行」全是它造成的，
  // 而诊断卡（绑定调用）一直能读到，才出现 inboxNextStep:1 / projectionRows:0
  // 的灵异矛盾。桩从此必须长成宿主 class 的形状。
  class HostProjectionStore {
    constructor(value) { this.value = value }
    channel(key) {
      if (key !== 'inbox') throw new Error('unknown projection key: ' + key)
      return { face: { getSnapshot: () => this.value } }
    }
    faceOf(key) { return this.channel(key).face }  // ← 用 this，裸调用即抛
  }
  const value = { 'next-turn': [], 'next-step': [userRow('s1', '甲')] }
  const session = { projections: new HostProjectionStore(value) }
  // 修复后的绑定调用必须读得到。
  assert.equal(readInbox(session).length, 1)
  assert.equal(readInboxRows(session).length, 1)
  // 反证：桩确实是 this 相关的（箭头函数桩可测不出这条回归）。
  const stolen = session.projections.faceOf
  assert.throws(() => stolen('inbox'))
  // 绑定调用对 seqOf 同样成立（诊断一直在用绑定形式，本来就是对的）。
  const withSeq = {
    projections: Object.assign(new HostProjectionStore(value), {
      seqOf(key) { return key === 'inbox' ? 228 : undefined },
    }),
  }
  assert.equal(queueDiag(withSeq).inboxNextStep, 1)
})

// ── 本地发送回显（消息在途，2026-10-21 真机 bug 的在途检测）───────────────

/** 造一条 pendingSubmissions 回显（宿主 beginSubmission 的形状）。 */
const echoRow = (requestId, text, extra = {}) => ({
  requestId,
  placement: extra.placement ?? 'steering',
  time: extra.time ?? 1000,
  text,
  attachments: extra.attachments ?? [],
})

test('回显：只收 steering（queued/transcript 不渲染气泡）', () => {
  const session = {
    getSnapshot: () => ({
      pendingSubmissions: [
        echoRow('r1', '插入', { placement: 'steering' }),
        echoRow('r2', '排队', { placement: 'queued' }),
        echoRow('r3', '直发', { placement: 'transcript' }),
      ],
    }),
  }
  const echoes = readPendingEchoes(session)
  assert.deepEqual(echoes.map(e => e.requestId), ['r1'])
  assert.equal(echoes[0].text, '插入')
})

test('回显：没有 getSnapshot / 字段不是数组 → 空数组（不是错误）', () => {
  assert.deepEqual(readPendingEchoes({}), [])
  assert.deepEqual(readPendingEchoes({ getSnapshot: () => ({}) }), [])
  assert.deepEqual(readPendingEchoes({ getSnapshot: () => ({ pendingSubmissions: 'nope' }) }), [])
  assert.deepEqual(readPendingEchoes(null), [])
  assert.deepEqual(readPendingEchoes({ getSnapshot: () => { throw new Error('boom') } }), [])
})

test('回显：requestId 不是非空字符串 → 丢弃', () => {
  const session = {
    getSnapshot: () => ({
      pendingSubmissions: [
        echoRow('', '空id'),
        echoRow(42, '数字id'),
        echoRow('ok', '好的'),
      ],
    }),
  }
  assert.deepEqual(readPendingEchoes(session).map(e => e.requestId), ['ok'])
})

test('在途判断：精确 / 折叠空白都算在途；两条相同文本也照样等（不学严格匹配）', () => {
  const session = {
    getSnapshot: () => ({
      pendingSubmissions: [echoRow('r1', '帮我改这段'), echoRow('r2', '帮我\n改  这段')],
    }),
  }
  assert.equal(hasPendingEcho(session, '帮我改这段'), true)
  assert.equal(hasPendingEcho(session, '帮我 改 这段'), true, '折叠空白后命中 r2')
  assert.equal(hasPendingEcho(session, '不存在'), false)
  assert.equal(hasPendingEcho(session, ''), false)
  assert.equal(hasPendingEcho({}, '任何文本'), false)
})

test('在途：投影空 + 回显在 = 消息在途（等它落库，不报错）', () => {
  const session = {
    getSnapshot: () => ({ pendingSubmissions: [echoRow('r1', '先思考一下')] }),
    projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [], 'next-step': [] }) }) },
  }
  const inbox = readInbox(session)
  assert.deepEqual(inbox, [], '投影可读且空 = 空队列，不是读不到')
  assert.equal(hasPendingEcho(session, '先思考一下'), true)
})

test('在途：投影有行时走投影（回显只是兜底信号）', () => {
  const session = {
    getSnapshot: () => ({ pendingSubmissions: [echoRow('r1', '先思考一下')] }),
    projections: {
      faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [], 'next-step': [userRow('s1', '先思考一下')] }) }),
    },
  }
  const inbox = readInbox(session)
  const resolved = resolvePendingItem(inbox, '先思考一下')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.itemId, 's1')
})

test('回显：真实桌面端宿主快照没有 queue 字段（旧副本坑，别回退）', () => {
  const session = {
    getSnapshot: () => ({ pendingSubmissions: [], running: true, openState: 'open' }),
    projections: { faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [], 'next-step': [] }) }) },
  }
  assert.deepEqual(readInbox(session), [])
  assert.ok(readPendingEchoes(session).length === 0)
})

test('诊断：queueDiag 产出纯 JSON、不抛，含关键字段', () => {
  const session = {
    getSnapshot: () => ({
      pendingSubmissions: [echoRow('r1', '甲')],
    }),
    projections: {
      rows: new Map([['inbox', {}]]),
      seqOf: () => 42,
      faceOf: () => ({
        getSnapshot: () => ({ 'next-turn': [], 'next-step': [userRow('s1', '甲')] }),
      }),
    },
  }
  const diag = queueDiag(session, { sessionId: 'sess-1', bubbleKind: 'echo' })
  assert.equal(typeof diag.hasSession, 'boolean')
  assert.equal(diag.hasSession, true)
  assert.equal(diag.hasGetSnapshot, true)
  assert.deepEqual(diag.projectionKeys, ['inbox'])
  assert.equal(diag.inboxNextStep, 1)
  assert.equal(diag.inboxNextTurn, 0)
  assert.equal(diag.inboxSeq, 42)
  assert.equal(diag.echoCount, 1)
  assert.equal(diag.projectionRows, 1)
  assert.equal(diag.sessionId, 'sess-1')
  assert.equal(diag.bubbleKind, 'echo')
  assert.doesNotThrow(() => JSON.stringify(diag))
  assert.deepEqual(queueDiag(null), { hasSession: false })
  assert.doesNotThrow(() => queueDiag({}))
})

test('诊断：三修新增字段——行的速写、回显分布、promptError、锚点', () => {
  const session = {
    getSnapshot: () => ({
      pendingSubmissions: [echoRow('r1', '甲'), echoRow('r2', '乙', { placement: 'queued' })],
      promptError: { op: 'send', error: { code: 'agent-busy', message: 'busy' } },
    }),
    projections: {
      rows: new Map(),
      seqOf: () => 7,
      faceOf: () => ({
        getSnapshot: () => ({
          'next-turn': [],
          'next-step': [
            userRow('s1', '甲'),
            { id: 'p1', content: [{ type: 'text', text: '注入' }], source: { kind: 'preset' } },
          ],
        }),
      }),
    },
  }
  const diag = queueDiag(session, {
    sessionId: 'sess-2', bubbleKind: 'host', bubbleTextHead: '甲',
    anchor: { itemId: 's1' }, sentInTranscript: true,
  })
  // next-step 每行的速写：真机分歧点（有行但过滤后为 0）就靠它看出来。
  assert.equal(diag.nextStepRows.length, 2)
  assert.equal(diag.nextStepRows[0].kind, 'user')
  assert.equal(diag.nextStepRows[1].kind, 'preset')
  assert.equal(diag.nextStepRows[1].head, '注入')
  // 回显按 placement 分布：queued 不渲染气泡，但要能在诊断里看见。
  assert.deepEqual(diag.subPlacements, { total: 2, steering: 1, queued: 1, transcript: 0, other: 0 })
  assert.equal(diag.promptError, 'agent-busy')
  assert.deepEqual(diag.anchor, { itemId: 's1' })
  assert.equal(diag.sentInTranscript, true)
  assert.equal(diag.bubbleTextHead, '甲')
  assert.doesNotThrow(() => JSON.stringify(diag))
})

// ── contentText ───────────────────────────────────────────────────────────

test('文本：多个 text 块按序拼接', () => {
  const out = contentText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }])
  assert.equal(out.text, '甲乙')
  assert.equal(out.textOnly, true)
})

test('文本：含非文本块 → textOnly 为 false', () => {
  const out = contentText([{ type: 'text', text: '甲' }, { type: 'image', image: {} }])
  assert.equal(out.text, '甲')
  assert.equal(out.textOnly, false)
})

test('文本：空数组 → 空文本且算 textOnly（编辑成空由服务端拒绝，不在这里）', () => {
  assert.deepEqual(contentText([]), { text: '', textOnly: true })
})

test('文本：content 不是数组 → 当空（行结构不可全信）', () => {
  assert.deepEqual(contentText(null), { text: '', textOnly: true })
})

// ── bubbleTextOf / collapseWhitespace ─────────────────────────────────────

test('气泡文本：时钟节点必须剔除，否则匹配永远差一截', () => {
  const row = mk('div')
  const body = mk('div')
  body._text = '帮我改这段'
  const clock = mk('span')
  clock.setAttribute('data-clock', '')
  clock._text = '22:18'
  row.append(body, clock)
  assert.equal(bubbleTextOf(row), '帮我改这段')
})

test('气泡文本：嵌套结构与多段文本都能取到', () => {
  const row = mk('div')
  const a = mk('p', '', '第一段')
  const b = mk('p', '', '第二段')
  row.append(a, b)
  assert.equal(bubbleTextOf(row), '第一段第二段')
})

test('气泡文本：注入的按钮文字必须能剔除（否则按钮一挂上定位就永远失败）', () => {
  const row = mk('div')
  const body = mk('div', 'bubble')
  body._text = '帮我改这段'
  row.append(body)
  const btn = mk('button')
  btn.setAttribute('data-rf3-pending-btn', '')
  btn._text = '改待发送'
  row.append(btn)
  // 只剔时钟 → 按钮文字会污染消息内容（回归：这正是踩过的坑）。
  assert.equal(bubbleTextOf(row, '[data-clock]'), '帮我改这段改待发送')
  // 连同自有 UI 一起剔 → 干净。
  assert.equal(bubbleTextOf(row, '[data-clock], [data-rf3-pending-btn]'), '帮我改这段')
})

test('气泡文本：null / 无 querySelectorAll 的桩不抛', () => {
  assert.equal(bubbleTextOf(null), '')
  assert.equal(bubbleTextOf(undefined), '')
})

test('折叠空白：连续空白归一成一个空格', () => {
  assert.equal(collapseWhitespace(' 甲\n\n  乙  '), '甲 乙')
})

// ── resolvePendingItem ────────────────────────────────────────────────────

test('定位：唯一精确匹配 → 拿到 itemId', () => {
  const out = resolvePendingItem(inboxOf(userRow('i1', '帮我改这段')), '帮我改这段')
  assert.equal(out.ok, true)
  assert.equal(out.itemId, 'i1')
  assert.equal(out.text, '帮我改这段')
})

test('定位：只认 source.kind === user，上下文注入行要跳过', () => {
  const injected = { id: 'c1', content: [{ type: 'text', text: '帮我改这段' }], source: { kind: 'context' } }
  const out = resolvePendingItem(inboxOf(injected), '帮我改这段')
  assert.equal(out.ok, false)
})

test('定位：markdown 渲染抹掉换行后，折叠空白仍能匹配', () => {
  const row = userRow('i1', '第一行\n第二行')
  const out = resolvePendingItem(inboxOf(row), '第一行 第二行')
  assert.equal(out.ok, true)
  assert.equal(out.itemId, 'i1')
})

test('定位：精确匹配优先于模糊匹配', () => {
  const rows = [
    userRow('i1', '甲  乙'),       // 折叠后 = '甲 乙'
    userRow('i2', '甲 乙'),        // 精确等于气泡
  ]
  const out = resolvePendingItem(inboxOf(...rows), '甲 乙')
  assert.equal(out.ok, true)
  assert.equal(out.itemId, 'i2')
})

test('定位：两条一字不差的相同文本 → 拒绝，不取第一条', () => {
  const rows = [userRow('i1', '同一句'), userRow('i2', '同一句')]
  const out = resolvePendingItem(inboxOf(...rows), '同一句')
  assert.equal(out.ok, false)
  assert.match(out.error, /多个相同/)
})

test('定位：折叠后撞车同样拒绝', () => {
  // 两条原文都不是气泡原文（精确 0 条），但折叠后都等于 '同一 句'（折叠 2 条）→ 歧义。
  const rows = [userRow('i1', '同一\n句'), userRow('i2', '同一  句')]
  const out = resolvePendingItem(inboxOf(...rows), '同一 句')
  assert.equal(out.ok, false)
  assert.match(out.error, /多个相同/)
})

test('定位：恰好一条模糊匹配（其余都不同）→ 成功', () => {
  const rows = [userRow('i1', '别的句子'), userRow('i2', '同一  句')]
  const out = resolvePendingItem(inboxOf(...rows), '同一 句')
  assert.equal(out.ok, true)
  assert.equal(out.itemId, 'i2')
})

test('定位：带附件的行 → 拒绝，不静默丢附件', () => {
  const out = resolvePendingItem(inboxOf(fileRow('i1', '看图')), '看图')
  assert.equal(out.ok, false)
  assert.match(out.error, /附件/)
})

test('定位：队列里没有 → 明确说无法定位', () => {
  const out = resolvePendingItem(inboxOf(userRow('i1', '别的话')), '我要的')
  assert.equal(out.ok, false)
  assert.match(out.error, /无法定位|已经变化/)
})

test('定位：气泡空文本不匹配任何行', () => {
  const out = resolvePendingItem(inboxOf(userRow('i1', '')), '')
  assert.equal(out.ok, false)
})

test('定位：读不到投影与「队列为空」错误文案不同', () => {
  const out = resolvePendingItem(null, '甲')
  assert.equal(out.ok, false)
  assert.match(out.error, /读不到/)
})

test('定位：行 id 不是字符串 → 拒绝', () => {
  const bad = { id: 42, content: [{ type: 'text', text: '甲' }], source: { kind: 'user' } }
  const out = resolvePendingItem(inboxOf(bad), '甲')
  assert.equal(out.ok, false)
  assert.match(out.error, /无法定位/)
})

// ── 强锚点：resolvePendingItemById（接管时预取，点击时按 id 复核）──────────

test('锚点：id 命中 → 直接定位，预填行的当前文本', () => {
  const rows = [userRow('s1', '现在的文本'), userRow('s2', '别的')]
  const res = resolvePendingItemById(rows, 's1')
  assert.deepEqual(res, { ok: true, itemId: 's1', text: '现在的文本', textOnly: true })
})

test('锚点：id 不在队列里 → 明确说已经不在队列（回合结束被 claim）', () => {
  const res = resolvePendingItemById([userRow('s2', '别的')], 's1')
  assert.equal(res.ok, false)
  assert.match(res.error, /已经不在队列里/)
})

test('锚点：行带附件 → 拒绝，不静默丢附件', () => {
  const res = resolvePendingItemById([fileRow('s1', '看图')], 's1')
  assert.equal(res.ok, false)
  assert.match(res.error, /附件/)
})

test('锚点：rows 为 null / itemId 不是字符串 → 拒绝', () => {
  assert.equal(resolvePendingItemById(null, 's1').ok, false)
  assert.equal(resolvePendingItemById([userRow('s1', '甲')], 7).ok, false)
  assert.equal(resolvePendingItemById([userRow('s1', '甲')], '').ok, false)
})

// ── hasTextMatchRow（失败文案指路：文本对不上还是 kind 被滤掉）──────────────

test('同文本行：kind 不设限，注入行也算命中（只为区分失败原因）', () => {
  const rows = [{ id: 'c1', content: [{ type: 'text', text: '注入的内容' }], source: { kind: 'context' } }]
  assert.equal(hasTextMatchRow(rows, '注入的内容'), true)
})

test('同文本行：折叠空白后相等也算', () => {
  const rows = [userRow('s1', '甲 乙')]
  assert.equal(hasTextMatchRow(rows, '甲  乙'), true)
})

test('同文本行：没有命中 / 空文本 / null → false', () => {
  assert.equal(hasTextMatchRow([userRow('s1', '别的')], '甲'), false)
  assert.equal(hasTextMatchRow([userRow('s1', '甲')], ''), false)
  assert.equal(hasTextMatchRow(null, '甲'), false)
})

// ── describeInboxRows（诊断：点击时刻投影里到底有谁）────────────────────────

test('诊断速写：列出每行的 id / kind / 文本头，单行坏掉不影响其它行', () => {
  const rows = [
    userRow('s1', '用户消息'),
    { id: 'p1', content: [{ type: 'text', text: '预置跟进' }], source: { kind: 'preset' } },
    { id: 'bad', content: [{ type: 'text', text: 'x' }], get source() { throw new Error('boom') } },
    { id: 'nosrc', content: [{ type: 'text', text: 'y' }] },
  ]
  const out = describeInboxRows(rows)
  assert.equal(out.length, 4)
  assert.equal(out[0].id, 's1')
  assert.equal(out[0].kind, 'user')
  assert.equal(out[1].kind, 'preset')
  assert.equal(out[1].head, '预置跟进')
  assert.equal(out[2].kind, 'throw', '读 source 抛异常要能看出来')
  assert.equal(out[3].kind, 'absent')
})

test('诊断速写：null → unreadable（与空数组区分开）', () => {
  assert.equal(describeInboxRows(null), 'unreadable')
  assert.deepEqual(describeInboxRows([]), [])
})

// ── explainQueueError ─────────────────────────────────────────────────────

test('错误码：四个已在宿主源码核对的码各有中文', () => {
  assert.match(explainQueueError('session/queue-item-not-found'), /不在队列/)
  assert.match(explainQueueError('session/attachment-invalid'), /附件/)
  assert.match(explainQueueError('gateway/bad-request'), /不能为空/)
  assert.match(explainQueueError('session/steer-unavailable'), /不能接受/)
})

test('错误码：未知码返回 undefined，让调用方退回宿主原文', () => {
  assert.equal(explainQueueError('session/not-found'), undefined)
  assert.equal(explainQueueError(undefined), undefined)
})

// ── updateQueueFailure ────────────────────────────────────────────────────

test('结果：ok 为 true → 无失败', () => {
  assert.equal(updateQueueFailure({ ok: true, value: { accepted: true } }), null)
})

test('结果：认识的错误码 → 中文', () => {
  const out = updateQueueFailure({ ok: false, error: { code: 'session/queue-item-not-found', message: 'x' } })
  assert.match(out, /不在队列/)
})

test('结果：未知码但有 message → 用宿主原文', () => {
  const out = updateQueueFailure({ ok: false, error: { code: 'weird/unknown', message: '宿主说人话' } })
  assert.equal(out, '宿主说人话')
})

test('结果：error 不是对象 → 兜底文案', () => {
  assert.match(updateQueueFailure({ ok: false, error: null }), /保存失败/)
  assert.match(updateQueueFailure(null), /保存失败/)
  assert.match(updateQueueFailure('nope'), /保存失败/)
})

// ── submitQueueEdit ───────────────────────────────────────────────────────

test('提交：宿主没有 updateQueue → 明说不支持，不崩', async () => {
  assert.match(await submitQueueEdit({}, 'i1', '甲'), /不支持/)
  assert.match(await submitQueueEdit(null, 'i1', '甲'), /还没准备好/)
})

test('提交：成功 → null', async () => {
  let seen = null
  const session = {
    updateQueue: async (itemId, action) => {
      seen = { itemId, action }
      return { ok: true, value: { accepted: true } }
    },
  }
  assert.equal(await submitQueueEdit(session, 'i1', '新内容'), null)
  assert.equal(seen.itemId, 'i1')
  assert.deepEqual(seen.action, { kind: 'edit', content: [{ type: 'text', text: '新内容' }] })
})

test('提交：只发 kind edit 且纯文本块（服务端会拒非 text）', async () => {
  let kinds = null
  const session = { updateQueue: async (id, action) => { kinds = action; return { ok: true } } }
  await submitQueueEdit(session, 'i1', '甲')
  assert.equal(kinds.kind, 'edit')
  assert.ok(kinds.content.every(b => b.type === 'text'))
})

test('提交：业务失败 → 中文原因', async () => {
  const session = {
    updateQueue: async () => ({ ok: false, error: { code: 'session/queue-item-not-found', message: 'gone' } }),
  }
  assert.match(await submitQueueEdit(session, 'i1', '甲'), /不在队列/)
})

test('提交：同步抛异常 → 取其 message', async () => {
  const session = { updateQueue: () => { throw new Error('掉线了') } }
  assert.equal(await submitQueueEdit(session, 'i1', '甲'), '掉线了')
})

test('提交：promise 拒绝 → 取其 message', async () => {
  const session = { updateQueue: async () => { throw new Error('网关超时') } }
  assert.equal(await submitQueueEdit(session, 'i1', '甲'), '网关超时')
})

test('提交：抛的不是 Error → 兜底文案', async () => {
  const session = { updateQueue: () => { throw '字符串异常' } }
  assert.match(await submitQueueEdit(session, 'i1', '甲'), /保存失败/)
})

// 执行
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error?.message ?? error).split('\n')[0])
  }
}
console.log(failed === 0 ? '\n全部通过（' + tests.length + '）' : '\n失败 ' + failed + ' / ' + tests.length)
process.exit(failed === 0 ? 0 : 1)
