// patch 纯数据层测试（tests/patch.test.mjs）。
//
// 这一层是 v3 的机制本体：projection 拿到的就是它，宿主侧与测试共用同一份
// 实现。所有边界（非法形状、块种类不符、块不存在、签名剥离、多 patch 叠加）
// 都在这里钉死——projection 抛错会让整个会话打不开，所以这层必须自己兜住。
//
// 运行：node tests/patch.test.mjs
import assert from 'node:assert/strict'
import {
  PATCH_EVENT_TYPE, PATCH_EVENT_TYPE_PLUGIN, PATCH_VERSION, applyPatch, buildPatchData,
  isPatchEventType, listBlocks, projectedTextsOf, readBlock, validatePatchData,
} from '../src/patch-event.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一条助手消息：推理块（带签名）+ 正文块 + 工具调用块 + 第二个正文块。 */
function assistantMessage() {
  return {
    id: 'm-1',
    role: 'assistant',
    source: { kind: 'model', provider: 'p', model: 'm' },
    content: [
      { type: 'reasoning', text: '推理原文', signature: 'SIG-1', thinkingSignature: 'SIG-2' },
      { type: 'text', text: '正文一' },
      { type: 'tool-call', id: 'c1', name: 'read' },
      { type: 'text', text: '正文二' },
    ],
  }
}

test('事件类型是自有命名空间，不与宿主类型撞名', () => {
  assert.equal(PATCH_EVENT_TYPE, 'reply-forge/patch')
  assert.equal(PATCH_VERSION, 1)
})

test('双类型接受：isPatchEventType 认迁移改名前后的两种类型', () => {
  // v3→v4 迁移会把 reply-forge/patch 改名成 plugin:reply-forge/patch 写盘
  // （宿主 namespaceV3OpaqueEvent，2026-10-23 实证）。读侧必须两种都认。
  assert.equal(PATCH_EVENT_TYPE_PLUGIN, 'plugin:reply-forge/patch')
  assert.equal(isPatchEventType(PATCH_EVENT_TYPE), true)
  assert.equal(isPatchEventType(PATCH_EVENT_TYPE_PLUGIN), true)
  assert.equal(isPatchEventType('assistant/message'), false)
  assert.equal(isPatchEventType('reply-forge'), false, '差一截也不行')
  assert.equal(isPatchEventType('plugin:reply-forge/patch/extra'), false, '精确匹配，不是前缀匹配')
  assert.equal(isPatchEventType('plugin:reply-forge'), false, '少了段也不行')
  assert.equal(isPatchEventType(undefined), false)
  assert.equal(isPatchEventType(null), false)
})

test('readBlock：blockIndex 是 content 数组下标（含工具调用块）', () => {
  const msg = assistantMessage()
  assert.deepEqual(readBlock(msg.content, 0), { kind: 'reasoning', text: '推理原文' })
  assert.deepEqual(readBlock(msg.content, 1), { kind: 'text', text: '正文一' })
  assert.equal(readBlock(msg.content, 2), null, '工具调用块不可编辑')
  assert.deepEqual(readBlock(msg.content, 3), { kind: 'text', text: '正文二' })
  assert.equal(readBlock(msg.content, 4), null, '越界返回 null')
  assert.equal(readBlock(msg.content, -1), null, '负数下标返回 null')
  assert.equal(readBlock(null, 0), null)
})

test('listBlocks：只列可编辑块，工具调用块被跳过', () => {
  const blocks = listBlocks(assistantMessage().content)
  assert.deepEqual(blocks.map(b => [b.blockIndex, b.kind]), [[0, 'reasoning'], [1, 'text'], [3, 'text']])
})

test('validatePatchData：拒绝一切非法形状', () => {
  const good = { version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'text', text: 'x' }] }
  assert.equal(validatePatchData(good), good)

  const bad = [
    [null, 'null'],
    [[], '数组'],
    [{}, '缺 version'],
    [{ version: 2, targets: [] }, '版本不符'],
    [{ version: 1, targets: [] }, '空 targets'],
    [{ version: 1, targets: 'x' }, 'targets 非数组'],
    [{ version: 1, targets: [null] }, 'target 非对象'],
    [{ version: 1, targets: [{ seq: -1, blockIndex: 0, kind: 'text', text: 'x' }] }, 'seq 负数'],
    [{ version: 1, targets: [{ seq: 1.5, blockIndex: 0, kind: 'text', text: 'x' }] }, 'seq 非整数'],
    [{ version: 1, targets: [{ seq: 1, blockIndex: -0, kind: 'text', text: 'x' }] }, 'blockIndex 负零'],
    [{ version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'image', text: 'x' }] }, 'kind 非法'],
    [{ version: 1, targets: [{ seq: 1, blockIndex: 0, kind: 'text', text: 1 }] }, 'text 非字符串'],
  ]
  for (const [value, label] of bad) {
    assert.throws(() => validatePatchData(value), label + ' 应被拒绝')
  }
})

test('buildPatchData：构造前先自校验，非法输入直接抛', () => {
  const data = buildPatchData([{ seq: 3, blockIndex: 1, kind: 'text', text: '新' }])
  assert.deepEqual(data, { version: 1, targets: [{ seq: 3, blockIndex: 1, kind: 'text', text: '新' }] })
  assert.throws(() => buildPatchData([{ seq: -1, blockIndex: 0, kind: 'text', text: 'x' }]))
})

test('applyPatch：改正文，其余块原样保留', () => {
  const msg = assistantMessage()
  const { message, applied, skipped } = applyPatch(msg, [{ seq: 1, blockIndex: 1, kind: 'text', text: '伪造正文' }])
  assert.equal(applied, 1)
  assert.deepEqual(skipped, [])
  assert.equal(message.content[1].text, '伪造正文')
  assert.deepEqual(message.content[0], msg.content[0], '推理块一字未动')
  assert.deepEqual(message.content[2], msg.content[2], '工具调用块一字未动')
  assert.equal(message.content[3].text, '正文二', '另一条正文未动')
  assert.equal(msg.content[1].text, '正文一', '不得就地改原消息')
})

test('applyPatch：改推理块必须连带剥掉签名', () => {
  const msg = assistantMessage()
  const { message, applied } = applyPatch(msg, [{ seq: 1, blockIndex: 0, kind: 'reasoning', text: '伪造推理' }])
  assert.equal(applied, 1)
  assert.equal(message.content[0].text, '伪造推理')
  assert.equal('signature' in message.content[0], false, 'signature 必须被剥掉')
  assert.equal('thinkingSignature' in message.content[0], false, 'thinkingSignature 必须被剥掉')
})

test('applyPatch：改正文时不动签名（正文块本来就没有）', () => {
  const msg = assistantMessage()
  const { message } = applyPatch(msg, [{ seq: 1, blockIndex: 1, kind: 'text', text: 'x' }])
  assert.equal(message.content[0].signature, 'SIG-1', '别的块的签名不受影响')
})

test('applyPatch：块种类不符 → 跳过该条，其余照常', () => {
  const msg = assistantMessage()
  const { message, applied, skipped } = applyPatch(msg, [
    { seq: 1, blockIndex: 1, kind: 'reasoning', text: '种类错' },
    { seq: 1, blockIndex: 3, kind: 'text', text: '种类对' },
  ])
  assert.equal(applied, 1)
  assert.deepEqual(skipped, [{ blockIndex: 1, reason: 'kind-mismatch' }])
  assert.equal(message.content[1].text, '正文一', '种类不符的块不动')
  assert.equal(message.content[3].text, '种类对')
})

test('applyPatch：目标块不可编辑/不存在 → 跳过，不抛（否则整个会话打不开）', () => {
  const msg = assistantMessage()
  const { applied, skipped, message } = applyPatch(msg, [
    { seq: 1, blockIndex: 2, kind: 'text', text: '工具块' },
    { seq: 1, blockIndex: 99, kind: 'text', text: '越界' },
  ])
  assert.equal(applied, 0)
  assert.deepEqual(skipped.map(s => s.blockIndex).sort((a, b) => a - b), [2, 99])
  assert.deepEqual(message.content, msg.content, '什么都没改')
})

test('applyPatch：同 blockIndex 多条 → 后写覆盖先写', () => {
  const msg = assistantMessage()
  const { message } = applyPatch(msg, [
    { seq: 1, blockIndex: 1, kind: 'text', text: '第一次' },
    { seq: 1, blockIndex: 1, kind: 'text', text: '第二次' },
  ])
  assert.equal(message.content[1].text, '第二次')
})

test('applyPatch：消息没有 content 数组 → 抛（调用方负责兜住）', () => {
  assert.throws(() => applyPatch({ id: 'x' }, [{ seq: 1, blockIndex: 0, kind: 'text', text: 'x' }]))
  assert.throws(() => applyPatch(null, []))
})

test('applyPatch：保留消息身份字段（id/role/source 不能被吃掉）', () => {
  const msg = assistantMessage()
  const { message } = applyPatch(msg, [{ seq: 1, blockIndex: 1, kind: 'text', text: 'x' }])
  assert.equal(message.id, 'm-1')
  assert.equal(message.role, 'assistant')
  assert.deepEqual(message.source, msg.source)
})

test('applyPatch：thinking 别名块按 reasoning 处理', () => {
  const msg = { id: 'm', role: 'assistant', source: {}, content: [{ type: 'thinking', text: '旧', signature: 'S' }] }
  assert.deepEqual(readBlock(msg.content, 0), { kind: 'reasoning', text: '旧' })
  const { message, applied } = applyPatch(msg, [{ seq: 1, blockIndex: 0, kind: 'reasoning', text: '新' }])
  assert.equal(applied, 1)
  assert.equal(message.content[0].text, '新')
  assert.equal('signature' in message.content[0], false)
})

// ── projectedTextsOf（落盘读取的投影基准；双类型接受是 2026-10-23 回归点）────
// 这一层是「磁盘读到的原文」与「模型实际看到的投影后文本」对齐的唯一关卡，
// 之前没有直接单测——双类型修复后补上，并把迁移类型钉成回归。

/** 造一条 patch 事件（与真实落盘的事件同形：type/seq/time/data）。 */
function patchEventOf(type, seq, targets) {
  return { type, seq, time: 1, data: buildPatchData(targets) }
}

const tgt = (seq, blockIndex, kind, text) => ({ seq, blockIndex, kind, text })

test('projectedTextsOf：旧类型照常归并，后写覆盖先写', () => {
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    patchEventOf(PATCH_EVENT_TYPE, 10, [tgt(1, 0, 'text', '第一版')]),
    patchEventOf(PATCH_EVENT_TYPE, 11, [tgt(1, 0, 'text', '第二版')]),
  ]
  const texts = projectedTextsOf(events)
  assert.equal(texts.get(1).get(0), '第二版')
})

test('projectedTextsOf：v3→v4 迁移改名后的 plugin: 类型同样归并（升级宿主后不失假）', () => {
  // 修复前这里返回空 Map —— 落盘读取拿原文当基准，在线路径的陈旧校验与
  // 伪造内容全部静默失配。这是本次修复的核心回归。
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    patchEventOf(PATCH_EVENT_TYPE_PLUGIN, 10, [tgt(1, 0, 'text', '伪造正文')]),
  ]
  const texts = projectedTextsOf(events)
  assert.equal(texts.get(1).get(0), '伪造正文')
})

test('projectedTextsOf：新旧类型混合 → 按数组顺序叠加（与折叠顺序一致）', () => {
  const events = [
    patchEventOf(PATCH_EVENT_TYPE, 10, [tgt(1, 0, 'text', 'A')]),
    patchEventOf(PATCH_EVENT_TYPE_PLUGIN, 11, [tgt(1, 0, 'text', 'B')]),
    patchEventOf(PATCH_EVENT_TYPE, 12, [tgt(1, 0, 'text', 'C')]),
  ]
  assert.equal(projectedTextsOf(events).get(1).get(0), 'C')
})

test('projectedTextsOf：多个 (seq, blockIndex) 各自归并', () => {
  const events = [
    patchEventOf(PATCH_EVENT_TYPE_PLUGIN, 10, [
      tgt(1, 0, 'text', '块零'),
      tgt(2, 1, 'reasoning', '推理'),
    ]),
  ]
  const texts = projectedTextsOf(events)
  assert.equal(texts.get(1).get(0), '块零')
  assert.equal(texts.get(2).get(1), '推理')
  assert.equal(texts.get(1).get(1), undefined, '没被 patch 过的块不出现在 Map 里')
})

test('projectedTextsOf：非 patch 类型 / 坏数据 / 非数组输入 → 容坏跳过', () => {
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'plugin:something-else', seq: 11, data: buildPatchData([tgt(1, 0, 'text', 'x')]) },
    { type: PATCH_EVENT_TYPE, seq: 12, data: { version: 1, targets: 'bad' } },
    { type: PATCH_EVENT_TYPE_PLUGIN, seq: 13, data: null },
    null,
    'not-an-object',
  ]
  assert.equal(projectedTextsOf(events).size, 0)
  assert.deepEqual(projectedTextsOf(null), new Map())
  assert.deepEqual(projectedTextsOf(undefined), new Map())
  assert.deepEqual(projectedTextsOf('x'), new Map())
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
