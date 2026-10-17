// 在线写入/读取层测试（tests/live.test.mjs）。
//
// 这里用假会话对象测**校验与分支**（失败码、陈旧保护、遮蔽拒绝、append 形状），
// 机制本身（投影是否真的改变模型所见）由 projection.test.mjs 在真宿主上验。
// 两层分开：这一层不需要 DSH 就能跑，回归成本最低。
//
// 运行：node tests/live.test.mjs
import assert from 'node:assert/strict'
import { forgeLive, liveCapable, readLiveBlocks } from '../.dsh-plugin/server/live.mjs'
import { PATCH_EVENT_TYPE } from '../src/patch-event.mjs'
import { installIgnorableShim, resetIgnorableShim } from '../.dsh-plugin/server/ignorable.mjs'

// 普通在线写入用例模拟宿主真实可安装的持久化句柄钩子；「装不上必须拒写」
// 的 P0 分支独立覆盖在 tests/ignorable.test.mjs。
// 形状照抄真 JsonlBackendTracker / JsonlSessionHandle（含 verifySessionWriter
// 核验所需的成员），保证「测试放行」与「真机放行」是同一道闸门。
const fakeBackend = {
  tracker: {
    openHandles: new Set(),
    writers: new Map(),
    claimWrite() {},
    flushAll() { return Promise.resolve() },
    adopt(handle) {
      this.openHandles.add(handle)
      if (handle.access === 'write') this.writers.set(handle.id, handle)
      return handle
    },
  },
}
/** 给 sid-1 造一个合格写句柄（写入前核验要过它）。 */
function fakeWriter(id = 'sid-1') {
  return {
    id,
    access: 'write',
    storage: { persistBatch() { return Promise.resolve() } },
    enqueueLive() {},
    drainLive() { return Promise.resolve() },
    persistContiguous() { return Promise.resolve() },
  }
}
fakeBackend.tracker.writers.set('sid-1', fakeWriter())
resetIgnorableShim()
installIgnorableShim({ reflect: { get: name => name === 'sessionPersistence' ? fakeBackend : undefined } })

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一个假会话：nodes/events/append 都可观测。 */
function fakeSession({ nodes = [10, 11], events = {}, projected = {} } = {}) {
  const appended = []
  return {
    appended,
    seq: 12,
    surface: {
      nodes,
      deriveEventMessage: ev => projected[ev.seq] ?? ev.data.message,
    },
    eventAt: seq => events[seq],
    append(type, data) {
      const ev = { type, seq: 100 + appended.length, data }
      appended.push(ev)
      return ev
    },
  }
}

/** 造一条助手消息事件。 */
function assistantEvent(seq, content) {
  return { seq, type: 'assistant/message', data: { message: { id: 'm-' + seq, role: 'assistant', source: { kind: 'model' }, content } } }
}

/** 标准内容：推理块 + 正文块 + 工具调用块 */
const CONTENT = [
  { type: 'reasoning', text: '推理原文', signature: 'S' },
  { type: 'text', text: '正文原文' },
  { type: 'tool-call', id: 'c1', name: 'read' },
]

/** 组装一个 sessions 服务。 */
function sessionsOf(session) {
  return { get: id => (id === 'sid-1' ? session : undefined) }
}

test('没有 sessions 服务 → NO_SESSIONS_SERVICE，且 liveCapable=false', () => {
  assert.equal(liveCapable(undefined), false)
  assert.equal(forgeLive(undefined, { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: 'x' }).code, 'NO_SESSIONS_SERVICE')
  assert.equal(readLiveBlocks(undefined, 'sid-1').code, 'NO_SESSIONS_SERVICE')
})

test('会话不在内存里 → SESSION_NOT_LIVE', () => {
  const sessions = { get: () => undefined }
  assert.equal(liveCapable(sessions), true)
  assert.equal(forgeLive(sessions, { sessionId: 'nope', seq: 10, blockIndex: 1, kind: 'text', newText: 'x' }).code, 'SESSION_NOT_LIVE')
  assert.equal(readLiveBlocks(sessions, 'nope').code, 'SESSION_NOT_LIVE')
})

test('正常在线写入：append 一条 patch 事件，不带 surfaceOp/sourceEventSeqs', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: '伪造正文', expectText: '正文原文' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.mode, 'live')
  assert.deepEqual(r.target, { seq: 10, blockIndex: 1, kind: 'text' })
  assert.equal(session.appended.length, 1)
  const ev = session.appended[0]
  assert.equal(ev.type, PATCH_EVENT_TYPE)
  assert.equal(ev.surfaceOp, undefined, '未知类型带 surfaceOp 会被宿主抛')
  assert.equal(ev.sourceEventSeqs, undefined, '未知类型带 sourceEventSeqs 会被宿主抛')
  assert.deepEqual(ev.data, { version: 1, targets: [{ seq: 10, blockIndex: 1, kind: 'text', text: '伪造正文' }] })
})

test('目标 seq 不在 surface 上 → SHADOWED（已被压缩遮蔽）', () => {
  const session = fakeSession({ events: { 99: assistantEvent(99, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 99, blockIndex: 1, kind: 'text', newText: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SHADOWED')
  assert.equal(session.appended.length, 0, '被拒时不得追加任何事件')
})

test('目标不是助手消息 → NOT_ASSISTANT_MESSAGE', () => {
  const session = fakeSession({ events: { 10: { seq: 10, type: 'user/message', data: { message: { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }] } } } } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'text', newText: 'x' })
  assert.equal(r.code, 'NOT_ASSISTANT_MESSAGE')
  assert.equal(r.actual, 'user/message')
})

test('目标块是工具调用 → NOT_EDITABLE_BLOCK', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 2, kind: 'text', newText: 'x' })
  assert.equal(r.code, 'NOT_EDITABLE_BLOCK')
})

test('块种类不符 → KIND_MISMATCH（界面过期的一种表现）', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'reasoning', newText: 'x' })
  assert.equal(r.code, 'KIND_MISMATCH')
  assert.equal(r.expected, 'reasoning')
  assert.equal(r.actual, 'text')
})

test('expectText 不符 → STALE_TARGET 且回带真实文本，不追加事件', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: 'x', expectText: '界面以为的旧文本' })
  assert.equal(r.code, 'STALE_TARGET')
  assert.equal(r.actual, '正文原文')
  assert.equal(r.expected, '界面以为的旧文本')
  assert.equal(session.appended.length, 0)
})

test('陈旧基准取「投影后」的文本：已伪造过的块按伪造后的值比对', () => {
  const base = assistantEvent(10, CONTENT)
  const forged = { ...base.data.message, content: [{ ...CONTENT[0] }, { ...CONTENT[1], text: '已伪造' }, CONTENT[2]] }
  const session = fakeSession({ events: { 10: base }, projected: { 10: forged } })
  // 拿伪造后的文本去比 → 通过
  assert.equal(forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: '第二版', expectText: '已伪造' }).ok, true)
  // 拿原始文本去比 → 拒绝（界面没刷新就会是这个结果）
  assert.equal(forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: 'x', expectText: '正文原文' }).code, 'STALE_TARGET')
})

test('改推理块：kind=reasoning 通过校验并写入', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'reasoning', newText: '伪造推理', expectText: '推理原文' })
  assert.equal(r.ok, true)
  assert.equal(session.appended[0].data.targets[0].kind, 'reasoning')
})

test('append 抛错 → APPEND_FAILED（不把异常漏给路由）', () => {
  const session = fakeSession({ events: { 10: assistantEvent(10, CONTENT) } })
  session.append = () => { throw new Error('宿主拒绝') }
  const r = forgeLive(sessionsOf(session), { sessionId: 'sid-1', seq: 10, blockIndex: 1, kind: 'text', newText: 'x' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'APPEND_FAILED')
  assert.match(r.detail, /宿主拒绝/)
})

test('在线读取：只列助手消息的可编辑块，带 kind 与 seq', () => {
  const session = fakeSession({ nodes: [10, 11], events: { 10: assistantEvent(10, CONTENT), 11: { seq: 11, type: 'user/message', data: { message: { id: 'u', role: 'user', content: [{ type: 'text', text: '用户' }] } } } } })
  const r = readLiveBlocks(sessionsOf(session), 'sid-1')
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'live')
  assert.deepEqual(r.blocks.map(b => [b.seq, b.blockIndex, b.kind]), [[10, 0, 'reasoning'], [10, 1, 'text']])
  assert.deepEqual(r.patched, [], '未伪造时 patched 为空')
})

test('在线读取：投影后与原始不同 → 该块进 patched（块级，与落盘读同形状）', () => {
  const base = assistantEvent(10, CONTENT)
  const forged = { ...base.data.message, content: [{ ...CONTENT[0] }, { ...CONTENT[1], text: '已伪造' }, CONTENT[2]] }
  const session = fakeSession({ nodes: [10], events: { 10: base }, projected: { 10: forged } })
  const r = readLiveBlocks(sessionsOf(session), 'sid-1')
  assert.deepEqual(r.patched, [{ seq: 10, blockIndex: 1 }])
  assert.equal(r.blocks.find(b => b.kind === 'text').text, '已伪造', '读的必须是投影后的文本')
})

test('在线读取：surface 读炸了 → 退化成 SESSION_NOT_LIVE（不抛给路由）', () => {
  const session = fakeSession()
  Object.defineProperty(session.surface, 'nodes', { get() { throw new Error('projection 被卸载') } })
  const r = readLiveBlocks(sessionsOf(session), 'sid-1')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_NOT_LIVE')
  assert.match(r.detail, /projection 被卸载/)
})

// ── 运行 ──────────────────────────────────────────────────────────────
let pass = 0
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); pass += 1 }
  catch (error) {
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error && error.message).split('\n').slice(0, 4).join('\n        '))
  }
}
console.log('\n' + (pass === tests.length ? `全部通过（${pass}）` : `失败 ${tests.length - pass} / ${tests.length}`))
process.exit(pass === tests.length ? 0 : 1)
