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
  normalizeInbox, readInbox, readQueueMirror, readInboxProjection, queueDiag,
  contentText, bubbleTextOf, collapseWhitespace,
  resolvePendingItem, explainQueueError, updateQueueFailure, submitQueueEdit,
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
const inboxOf = (...rows) => ({ nextTurn: [], nextStep: rows })

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

test('读取：正常投影能拿到的两份队列', () => {
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
  assert.equal(inbox.nextTurn.length, 1)
  assert.equal(inbox.nextStep.length, 1)
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

// ── 瞬态队列镜像（UI 真源，2026-10-20 真机 bug 的第一源）───────────────────

/** 造一条镜像行（宿主 SessionQueueMirror.replace 的形状）。 */
const mirrorRow = (id, placement, blocks) => ({ id, placement, content: blocks, text: null })

test('镜像：steering 行进 next-step，queued 行进 next-turn，context 行跳过', () => {
  const session = {
    getSnapshot: () => ({
      queue: [
        mirrorRow('s1', 'steering', [{ type: 'text', text: '插入' }]),
        mirrorRow('t1', 'queued', [{ type: 'text', text: '排队' }]),
        mirrorRow('c1', 'context', [{ type: 'text', text: '注入' }]),
        mirrorRow('bad', 'weird', [{ type: 'text', text: '未知placement' }]),
      ],
    }),
  }
  const mirror = readQueueMirror(session)
  assert.deepEqual(mirror.map(r => [r.slot, r.row.id]), [['next-step', 's1'], ['next-turn', 't1']])
  assert.equal(mirror.find(r => r.row.id === 'c1'), undefined, 'context 注入行不是用户消息')
})

test('镜像：没有 getSnapshot / 快照 queue 不是数组 → null（读不到，不是空）', () => {
  assert.equal(readQueueMirror({}), null)
  assert.equal(readQueueMirror({ getSnapshot: () => ({}) }), null)
  assert.equal(readQueueMirror({ getSnapshot: () => ({ queue: 'nope' }) }), null)
  assert.equal(readQueueMirror(null), null)
  assert.equal(readQueueMirror({ getSnapshot: () => { throw new Error('boom') } }), null)
})

test('镜像：id 不是非空字符串的行丢弃（updateQueue 无从下手）', () => {
  const session = {
    getSnapshot: () => ({
      queue: [
        mirrorRow('', 'steering', [{ type: 'text', text: '空id' }]),
        mirrorRow(42, 'steering', [{ type: 'text', text: '数字id' }]),
        mirrorRow('ok', 'steering', [{ type: 'text', text: '好的' }]),
      ],
    }),
  }
  assert.deepEqual(readQueueMirror(session).map(r => r.row.id), ['ok'])
})

test('合并：投影整键缺失（真机 bug）但镜像有数据 → 照常能读', () => {
  const session = {
    getSnapshot: () => ({ queue: [mirrorRow('s1', 'steering', [{ type: 'text', text: '先思考一下' }])] }),
    projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
  }
  const inbox = readInbox(session)
  assert.equal(inbox.nextStep.length, 1)
  assert.equal(inbox.nextStep[0].id, 's1')
})

test('合并：镜像空、投影有行 → 落到投影源', () => {
  const session = {
    getSnapshot: () => ({ queue: [] }),
    projections: {
      faceOf: () => ({ getSnapshot: () => ({ 'next-turn': [], 'next-step': [userRow('s1', '插入')] }) }),
    },
  }
  const inbox = readInbox(session)
  assert.equal(inbox.nextStep.length, 1)
  assert.equal(inbox.nextStep[0].id, 's1')
})

test('合并：两个源同一 id → 去重，镜像行优先', () => {
  const session = {
    getSnapshot: () => ({ queue: [mirrorRow('s1', 'steering', [{ type: 'text', text: '镜像版' }])] }),
    projections: {
      faceOf: () => ({
        getSnapshot: () => ({ 'next-turn': [], 'next-step': [userRow('s1', '投影版')] }),
      }),
    },
  }
  const inbox = readInbox(session)
  assert.equal(inbox.nextStep.length, 1)
  assert.equal(inbox.nextStep[0].content[0].text, '镜像版')
})

test('合并：两个源都读不到 → null（与「可读但为空」区分开）', () => {
  assert.deepEqual(readInbox({ getSnapshot: () => ({ queue: [] }), projections: null }), {
    nextTurn: [], nextStep: [],
  }, '镜像可读且空 + 投影缺失 = 空队列，不是读不到')
  assert.equal(readInbox({}), null)
})

test('诊断：queueDiag 产出纯 JSON、不抛，含关键字段', () => {
  const session = {
    getSnapshot: () => ({ queue: [mirrorRow('s1', 'steering', [{ type: 'text', text: '甲' }])] }),
    projections: { rows: new Map([['inbox', {}]]), faceOf: () => ({ getSnapshot: () => undefined }) },
  }
  const diag = queueDiag(session)
  assert.equal(typeof diag.hasSession, 'boolean')
  assert.equal(diag.hasSession, true)
  assert.equal(diag.hasGetSnapshot, true)
  assert.deepEqual(diag.projectionKeys, ['inbox'])
  assert.equal(diag.inboxSnapshot, 'undefined')
  assert.equal(diag.snapshotQueue, 'steering')
  assert.equal(diag.mirrorRows, 1)
  assert.equal(diag.projectionRows, 0)
  assert.doesNotThrow(() => JSON.stringify(diag))
  assert.deepEqual(queueDiag(null), { hasSession: false })
  assert.doesNotThrow(() => queueDiag({}))
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
