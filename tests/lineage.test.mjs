// 版本血统推导的单元测试（tests/lineage.test.mjs）。
//
// 盯三件事：
//   1. 版本栈与投影折叠规则**逐字对应**——后者覆盖前者、按事件顺序堆叠；
//      推导错一位，「还原到此版」写进去的就是错的内容（比没有功能更糟）。
//   2. 容坏与投影层同口径：单条坏 patch 跳过、种类不符跳过、原稿缺失/
//      种类不符返回业务失败码而不是抛。
//   3. 连续重复塌缩、非连续重复保留——「还原」列表里不该出现两版
//      一字不差的条目，但用户刻意改回 A 是两个动作。
//
// 直接 import 源码（src/lineage.mjs 是零依赖纯函数，不碰 DOM/IO）。
//
// 运行：node tests/lineage.test.mjs
import assert from 'node:assert/strict'
import { versionStackOf, originalBlockOf } from '../src/lineage.mjs'
import { buildPatchData, PATCH_EVENT_TYPE } from '../src/patch-event.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一条 assistant/message 事件（块可带 reasoning）。 */
function assistantEvent(seq, blocks) {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000 + seq,
    data: {
      turn: seq,
      step: 1,
      message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' }, id: 'msg-' + seq },
    },
  }
}

const textBlock = text => ({ type: 'text', text })
const reasoningBlock = text => ({ type: 'reasoning', text })

/** 造一条 patch 事件（走 buildPatchData，与真实写入同一条校验）。 */
function patchEvent(seq, targets) {
  return { type: PATCH_EVENT_TYPE, seq: 500 + seq, time: 1700000000000 + seq, data: buildPatchData(targets) }
}

const target = (seq, blockIndex, kind, text) => ({ seq, blockIndex, kind, text })

// ── originalBlockOf ────────────────────────────────────────────────────────

test('原稿：从原始 assistant/message 事件读块', () => {
  const events = [assistantEvent(7, [textBlock('你好'), textBlock('世界')])]
  assert.deepEqual(originalBlockOf(events, 7, 1), { kind: 'text', text: '世界' })
})

test('原稿：seq 不存在 → null', () => {
  assert.equal(originalBlockOf([assistantEvent(7, [textBlock('x')])], 8, 0), null)
})

test('原稿：块越界 / 不是可编辑种类 → null', () => {
  const events = [assistantEvent(7, [textBlock('x'), { type: 'tool-call', id: 't' }])]
  assert.equal(originalBlockOf(events, 7, 5), null)
  assert.equal(originalBlockOf(events, 7, 1), null)
})

test('原稿：events 不是数组 → null（不抛）', () => {
  assert.equal(originalBlockOf(null, 1, 0), null)
  assert.equal(originalBlockOf(undefined, 1, 0), null)
})

// ── versionStackOf：基本形状 ────────────────────────────────────────────────

test('没有 patch → 只有原稿一版，currentIndex=0', () => {
  const events = [assistantEvent(7, [textBlock('原文')])]
  const stack = versionStackOf(events, 7, 0)
  assert.equal(stack.ok, true)
  assert.equal(stack.versions.length, 1)
  assert.equal(stack.versions[0].source, 'original')
  assert.equal(stack.versions[0].text, '原文')
  assert.equal(stack.currentIndex, 0)
})

test('一条 patch → 两版，currentIndex 指向最后一版', () => {
  const events = [
    assistantEvent(7, [textBlock('原文')]),
    patchEvent(1, [target(7, 0, 'text', '改一')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.equal(stack.versions.length, 2)
  assert.equal(stack.versions[1].source, 'patch')
  assert.equal(stack.versions[1].text, '改一')
  assert.equal(stack.versions[1].eventSeq, 501)
  assert.equal(stack.currentIndex, 1)
})

test('多条 patch → 按事件顺序堆叠（与投影「后者覆盖前者」对应）', () => {
  const events = [
    assistantEvent(7, [textBlock('v0')]),
    patchEvent(1, [target(7, 0, 'text', 'v1')]),
    patchEvent(2, [target(7, 0, 'text', 'v2')]),
    patchEvent(3, [target(7, 0, 'text', 'v3')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.deepEqual(stack.versions.map(v => v.text), ['v0', 'v1', 'v2', 'v3'])
  assert.equal(stack.currentIndex, 3)
})

test('patch 别的块 / 别的消息 → 不串味', () => {
  const events = [
    assistantEvent(7, [textBlock('a0'), textBlock('b0')]),
    assistantEvent(8, [textBlock('别人')]),
    patchEvent(1, [target(7, 1, 'text', 'b1')]),
    patchEvent(2, [target(8, 0, 'text', '别人改')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.equal(stack.versions.length, 1)
  assert.equal(stack.versions[0].text, 'a0')
})

test('一条 patch 打多个 target → 各块各算各的栈', () => {
  const events = [
    assistantEvent(7, [textBlock('a0'), textBlock('b0')]),
    patchEvent(1, [target(7, 0, 'text', 'a1'), target(7, 1, 'text', 'b1')]),
  ]
  assert.equal(versionStackOf(events, 7, 0).versions.length, 2)
  assert.equal(versionStackOf(events, 7, 1).versions.length, 2)
})

// ── versionStackOf：种类 ───────────────────────────────────────────────────

test('思维链块：原稿与 patch 都按 reasoning 推导', () => {
  const events = [
    assistantEvent(7, [textBlock('正文'), reasoningBlock('内心戏')]),
    patchEvent(1, [target(7, 1, 'reasoning', '新内心戏')]),
  ]
  const stack = versionStackOf(events, 7, 1)
  assert.equal(stack.kind, 'reasoning')
  assert.deepEqual(stack.versions.map(v => v.text), ['内心戏', '新内心戏'])
})

test('kind 参数与原稿不符 → kind-mismatch（业务失败码，不抛）', () => {
  const events = [assistantEvent(7, [textBlock('x')])]
  const stack = versionStackOf(events, 7, 0, 'reasoning')
  assert.deepEqual(stack, { ok: false, reason: 'kind-mismatch' })
})

test('种类不符的 patch 被跳过（防御：宿主写入时就会拒）', () => {
  const events = [
    assistantEvent(7, [textBlock('x'), reasoningBlock('r')]),
    patchEvent(1, [target(7, 0, 'reasoning', '串味')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.equal(stack.versions.length, 1)
})

// ── versionStackOf：塌缩与容坏 ─────────────────────────────────────────────

test('连续重复塌缩：同一文本紧接着再 patch 不占版本位', () => {
  const events = [
    assistantEvent(7, [textBlock('a')]),
    patchEvent(1, [target(7, 0, 'text', 'b')]),
    patchEvent(2, [target(7, 0, 'text', 'b')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.deepEqual(stack.versions.map(v => v.text), ['a', 'b'])
  assert.equal(stack.currentIndex, 1)
})

test('非连续重复保留：A→B→A 是三版（用户刻意改回去是两个动作）', () => {
  const events = [
    assistantEvent(7, [textBlock('a')]),
    patchEvent(1, [target(7, 0, 'text', 'b')]),
    patchEvent(2, [target(7, 0, 'text', 'a')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.deepEqual(stack.versions.map(v => v.text), ['a', 'b', 'a'])
  assert.equal(stack.currentIndex, 2)
})

test('坏 patch 事件跳过，不牵连其余（与 projectedTextsOf 同口径）', () => {
  const events = [
    assistantEvent(7, [textBlock('a')]),
    { type: PATCH_EVENT_TYPE, seq: 501, data: { version: 1, targets: 'not-an-array' } },
    { type: PATCH_EVENT_TYPE, seq: 502, data: null },
    patchEvent(3, [target(7, 0, 'text', 'c')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.deepEqual(stack.versions.map(v => v.text), ['a', 'c'])
  assert.equal(stack.versions[1].eventSeq, 503)
})

test('原稿事件缺失（被压缩改写掉的会话）→ original-not-found', () => {
  const events = [patchEvent(1, [target(99, 0, 'text', 'x')])]
  assert.deepEqual(versionStackOf(events, 99, 0), { ok: false, reason: 'original-not-found' })
})

test('events 不是数组 → original-not-found（不抛）', () => {
  assert.deepEqual(versionStackOf(null, 1, 0), { ok: false, reason: 'original-not-found' })
})

test('事件数组里混 null/垃圾对象 → 不抛', () => {
  const events = [null, 'x', 42, assistantEvent(7, [textBlock('a')]), undefined]
  const stack = versionStackOf(events, 7, 0)
  assert.equal(stack.ok, true)
  assert.equal(stack.versions.length, 1)
})

test('空文本也是合法一版（用户把回复抹空是刻意行为）', () => {
  const events = [
    assistantEvent(7, [textBlock('a')]),
    patchEvent(1, [target(7, 0, 'text', '')]),
  ]
  const stack = versionStackOf(events, 7, 0)
  assert.deepEqual(stack.versions.map(v => v.text), ['a', ''])
  assert.equal(stack.currentIndex, 1)
})

// ── 跑 ─────────────────────────────────────────────────────────────────────

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String((error && error.message) || error))
  }
}
console.log(failed === 0 ? `\n全部通过（${tests.length}）` : `\n失败 ${failed} / ${tests.length}`)
process.exit(failed === 0 ? 0 : 1)
