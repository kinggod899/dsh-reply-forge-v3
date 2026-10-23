// 投影机制集成测试（tests/projection.test.mjs）——v3 的立身之本。
//
// 前面几个测试用的是自己写的假宿主；这一份跑在**真的** `@deepseek-ai/dsh-session`
// 上，证明三件事：
//   1. 追加自有事件 + 注册 projection，确实能改写**模型可见**的消息；
//   2. 全量回放（等价于重启 DSH）后伪造仍在；
//   3. 插件缺席（projection 没注册）时伪造静默失效、**不抛错**——不会把会话
//      弄成打不开的状态。
// 顺带把「为什么不能直接 replace assistant/message」这条宿主约束钉成回归：
// 那条路在本机宿主上必抛，将来宿主放宽了我们也不该悄悄走回去。
//
// 找不到宿主包时 SKIP（不判失败）：发行包解开在没有 DSH 的机器上跑要能过。
//
// 运行：node tests/projection.test.mjs
//       DSH_SESSION_PKG=/path/to/dsh-session node tests/projection.test.mjs
import assert from 'node:assert/strict'
import { findHostSessionPackage, toFileUrl } from './host-pkg.mjs'
import { PATCH_EVENT_TYPE, PATCH_EVENT_TYPE_PLUGIN, buildPatchData } from '../src/patch-event.mjs'
import { patchProjection, patchProjections } from '../.dsh-plugin/server/patch.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const pkg = findHostSessionPackage()
if (pkg === null) {
  console.log('  SKIP  找不到宿主 @deepseek-ai/dsh-session 包，跳过集成测试')
  console.log('        （设 DSH_SESSION_PKG 指向包目录可强制启用）\n')
  console.log('全部通过（0 项执行，已跳过）')
  process.exit(0)
}
console.log('  宿主包：' + pkg + '\n')
const { Session, SessionId, SessionLogOffset } = await import(toFileUrl(pkg))

const MODEL = { kind: 'model', provider: 'probe', model: 'probe' }
const SYS = { kind: 'system-prompt' }

/** 造一个只含一条助手消息的会话。 */
function makeSession(projections = [patchProjection]) {
  const s = Session.create(SessionId('session-rf3-test'), [], undefined, SessionLogOffset(0), projections)
  s.append('system/message', { turn: 0, step: 0, message: { id: 'm-sys', role: 'system', source: SYS, content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' })
  s.append('user/message', { id: 'm-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }, { surfaceOp: 'append' })
  const a = s.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: {
      id: 'm-a1', role: 'assistant', source: MODEL,
      content: [
        { type: 'reasoning', text: '推理原文', signature: 'SIG-X' },
        { type: 'text', text: '正文原文' },
      ],
    },
  }, { surfaceOp: 'append' })
  return { session: s, assistantSeq: a.seq }
}

/** 取模型可见的助手消息。 */
function assistantMessage(session) {
  return session.deriveMessages().filter(m => m?.role === 'assistant')[0] ?? null
}

test('追加 patch 事件后，模型可见正文立即变成伪造内容', () => {
  const { session, assistantSeq } = makeSession()
  assert.equal(assistantMessage(session).content[1].text, '正文原文', '前提：未伪造时是原文')

  const appended = session.append(PATCH_EVENT_TYPE, buildPatchData([
    { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
  ]))
  assert.equal(typeof appended.seq, 'number', 'patch 事件必须拿到 seq')
  assert.equal(appended.surfaceOp, undefined, '未知类型不得带 surfaceOp（带了会被宿主抛）')
  assert.equal(appended.sourceEventSeqs, undefined, '未知类型不得带 sourceEventSeqs')

  assert.equal(assistantMessage(session).content[1].text, '伪造正文')
  assert.equal(assistantMessage(session).content[0].text, '推理原文', '推理块不受影响')
})

test('双类型投影注册：两种事件类型各一个，project 函数同源', () => {
  // v3→v4 迁移会把 reply-forge/patch 改名成 plugin:reply-forge/patch，
  // 而宿主 projection 按事件类型精确匹配——漏注册新类型，迁移后的会话
  // 伪造全部静默失效。两个投影必须共享同一个 project 函数（行为不漂移）。
  assert.equal(patchProjections.length, 2)
  assert.deepEqual(patchProjections.map(p => p.type), [PATCH_EVENT_TYPE, PATCH_EVENT_TYPE_PLUGIN])
  assert.equal(patchProjections[0].project, patchProjections[1].project, '同一函数引用，不是两份拷贝')
  assert.equal(patchProjection.type, PATCH_EVENT_TYPE, '单数导出仍是旧类型（兼容旧调用方）')
})

test('迁移类型（plugin:reply-forge/patch）的事件直接追加也能驱动投影', () => {
  const { session, assistantSeq } = makeSession(patchProjections)
  session.append(PATCH_EVENT_TYPE_PLUGIN, buildPatchData([
    { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
  ]))
  assert.equal(assistantMessage(session).content[1].text, '伪造正文')
  assert.equal(assistantMessage(session).content[0].text, '推理原文', '推理块不受影响')
})

test('迁移类型的事件同样不进 surface（不改变压缩/遮蔽关系）', () => {
  const { session, assistantSeq } = makeSession(patchProjections)
  const before = session.surface.nodes.slice()
  session.append(PATCH_EVENT_TYPE_PLUGIN, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: 'x' }]))
  assert.deepEqual(session.surface.nodes, before, 'surface.nodes 必须一字不变')
})

test('patch 事件不进 surface（不改变压缩/遮蔽关系）', () => {
  const { session, assistantSeq } = makeSession()
  const before = session.surface.nodes.slice()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: 'x' }]))
  assert.deepEqual(session.surface.nodes, before, 'surface.nodes 必须一字不变')
})

test('伪造后会话能继续对话，且伪造内容留在上下文里', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' }]))
  session.append('user/message', { id: 'm-u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'm-a2', role: 'assistant', source: MODEL, content: [{ type: 'text', text: '第二轮' }] } }, { surfaceOp: 'append' })

  const texts = session.deriveMessages().filter(m => m?.role === 'assistant').map(m => m.content[0].text ?? m.content[1].text)
  assert.equal(texts.length, 2)
  assert.equal(session.deriveMessages().filter(m => m?.role === 'assistant')[0].content[1].text, '伪造正文')
  assert.equal(session.deriveMessages().filter(m => m?.role === 'assistant')[1].content[0].text, '第二轮')
})

test('全量回放（等价于重启 DSH）后伪造仍在', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' }]))
  const seed = session.snapshotEvents()
  const replayed = Session.fromRestore(SessionId('session-rf3-test'), seed, session.header, SessionLogOffset(0), 'shared-frozen', [patchProjection])
  assert.equal(assistantMessage(replayed).content[1].text, '伪造正文', '回放必须重现伪造')
})

test('插件缺席（projection 未注册）→ 伪造静默失效，且不抛错', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' }]))
  const seed = session.snapshotEvents()
  const bare = Session.fromRestore(SessionId('session-rf3-test'), seed, session.header, SessionLogOffset(0), 'shared-frozen', [])
  assert.equal(assistantMessage(bare).content[1].text, '正文原文', '没有插件就退回原文')
})

test('改推理块：模型可见推理被改写，且签名被剥掉', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 0, kind: 'reasoning', text: '伪造推理' }]))
  const msg = assistantMessage(session)
  assert.equal(msg.content[0].text, '伪造推理')
  assert.equal('signature' in msg.content[0], false, '签名对的是原文，改了就必须剥')
})

test('两条 patch 分别改不同块 → 两个改动同时保留（投影累积）', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 0, kind: 'reasoning', text: '伪造推理' }]))
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' }]))
  const msg = assistantMessage(session)
  assert.equal(msg.content[0].text, '伪造推理', '先前的推理改动不能被后一条吃掉')
  assert.equal(msg.content[1].text, '伪造正文')
})

test('同一块连改两次 → 后者生效', () => {
  const { session, assistantSeq } = makeSession()
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '第一版' }]))
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: assistantSeq, blockIndex: 1, kind: 'text', text: '第二版' }]))
  assert.equal(assistantMessage(session).content[1].text, '第二版')
})

test('目标 seq 不是 surface 当前节点 → 跳过，不抛（会话必须还能读）', () => {
  const { session } = makeSession()
  // seq 999 不存在
  session.append(PATCH_EVENT_TYPE, buildPatchData([{ seq: 999, blockIndex: 0, kind: 'text', text: 'x' }]))
  assert.doesNotThrow(() => session.deriveMessages())
  assert.equal(assistantMessage(session).content[1].text, '正文原文')
})

test('畸形 patch 数据 → 跳过，不抛（否则整个会话折叠失败）', () => {
  const { session } = makeSession()
  session.append(PATCH_EVENT_TYPE, { version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'bogus', text: 'x' }] })
  session.append(PATCH_EVENT_TYPE, { version: 99, targets: [] })
  session.append(PATCH_EVENT_TYPE, { nonsense: true })
  assert.doesNotThrow(() => session.deriveMessages())
  assert.equal(assistantMessage(session).content[1].text, '正文原文')
})

test('回归：assistant/message 直接做 surface replacement 必抛（宿主硬约束）', () => {
  const { session, assistantSeq } = makeSession()
  // 这条路的形状在本机宿主上必然抛（回归钉住这个约束）。
  // 形状正确（startSeq/endSeq）也一样抛——两条约束互斥：
  //   · replace 要求 sourceEventSeqs 覆盖被遮蔽节点；
  //   · assistant/message 又禁止携带 sourceEventSeqs。
  assert.throws(() => {
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: { id: 'm-x', role: 'assistant', source: MODEL, content: [{ type: 'text', text: 'x' }] },
    }, { surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq } })
  }, /sourceEventSeqs|invalid/i)
})

test('回归：带 sourceEventSeqs 的 assistant/message 也必抛', () => {
  const { session, assistantSeq } = makeSession()
  assert.throws(() => {
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: { id: 'm-y', role: 'assistant', source: MODEL, content: [{ type: 'text', text: 'y' }] },
    }, { surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq }, sourceEventSeqs: [assistantSeq] })
  })
})

test('回归：键名写成 start/end 的 replace 必抛（本机宿主实测过的形状）', () => {
  const { session, assistantSeq } = makeSession()
  assert.throws(() => {
    session.append('user/message', { id: 'm-z', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'z' }] },
      { surfaceOp: { op: 'replace', start: assistantSeq, end: assistantSeq } })
  }, /invalid replace surfaceOp/)
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
