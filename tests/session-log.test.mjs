// 会话落盘只读层测试（tests/session-log.test.mjs（v2 仓库副本，路径已改为 ../src/））。
// 用合成多帧 zstd JSONL fixture 在临时目录里跑，不依赖真实环境。
// 运行：node tests/session-log.test.mjs（v2 仓库副本，路径已改为 ../src/）
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  assistantEditableBlocks, assistantTextBlocks, findSessionFile, findSessionLog, readSessionEvents,
  scanZstdFrames, sessionIdKeys, sessionsRootDefault, thinkingSignatureStats,
} from '../src/session-log.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一个 assistant/message 事件：字段对齐真实落盘结构（2026-10 探针实测）。
 *  事件壳 = {type,seq,time,data,surfaceOp}；message = {role,content,source,id}。
 *  content = [text?, tool-call*, reasoning?]，正文块在最前（真实顺序即如此）。
 *  注意块类型名用真实命名：toolCall→tool-call，thinking→reasoning。 */
function assistantEvent(seq, text, { signature = null, time = 1700000000000 } = {}) {
  const content = []
  if (text !== null) content.push({ type: 'text', text })
  content.push({ type: 'tool-call', id: 'call_1', name: 'shell', arguments: { cmd: 'ls' } })
  const block = { type: 'reasoning', text: '内部推理……' }
  if (signature !== null) block.signature = signature
  content.push(block)
  return {
    type: 'assistant/message',
    seq,
    time,
    surfaceOp: 'append',
    data: {
      message: {
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
        id: 'msg-' + seq,
      },
    },
  }
}

/** 造一个 tool/result 事件：真实数据里 text 块的大头在这类事件中
 *  （探针实测 2011 个 text 块里 1395 个属于 tool/result），但那是工具
 *  结果不是助手正文——助手正文清单必须排除，否则编辑面会混入工具输出。 */
function toolResultEvent(seq, text) {
  return {
    type: 'tool/result',
    seq,
    time: 1700000000001,
    data: { message: { role: 'tool', content: [{ type: 'text', text }] } },
  }
}

/** 把一组事件逐条压成独立帧，拼成会话文件字节。 */
function buildSessionBytes(events) {
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-test', createdAt: 1 }) + '\n')
  const parts = [header]
  for (const ev of events) {
    parts.push(Buffer.from(JSON.stringify(ev) + '\n'))
  }
  return Buffer.concat(parts.map(p => zstdCompressSync(p)))
}

const root = mkdtempSync(path.join(tmpdir(), 'rf-session-test-'))
{
  const bareUuid = 'a1b2c3d4-0000-4000-8000-000000000001'
  const prefixedUuid = 'b2c3d4e5-0000-4000-8000-000000000002'

  // 真实三层布局：<root>/<项目目录>/<会话目录>/session.vN.jsonl.zstd
  // 裸 uuid 会话带 v3+v4 两个世代（验证取最高世代），带前缀会话只有 v4
  const PROJECT_A = '--proj-a--'
  const PROJECT_B = '--proj-b--'
  mkdirSync(path.join(root, PROJECT_A, bareUuid), { recursive: true })
  mkdirSync(path.join(root, PROJECT_B, 'session-' + prefixedUuid), { recursive: true })
  writeFileSync(path.join(root, PROJECT_A, bareUuid, 'session.v3.jsonl.zstd'), buildSessionBytes([assistantEvent(1, '旧世代内容', { signature: null })]))
  writeFileSync(path.join(root, PROJECT_A, bareUuid, 'session.v4.jsonl.zstd'), buildSessionBytes([assistantEvent(1, '新世代正文', { signature: 'sig-abc' })]))
  writeFileSync(path.join(root, PROJECT_B, 'session-' + prefixedUuid, 'session.v4.jsonl.zstd'), buildSessionBytes([assistantEvent(1, '带前缀会话正文')]))

  test('scanZstdFrames 帧数与逐帧解压', () => {
    const bytes = buildSessionBytes([assistantEvent(1, 'x'), assistantEvent(2, 'y')])
    const frames = scanZstdFrames(bytes)
    assert.equal(frames.length, 1 + 2, '帧数=会话头1+事件2')
    assert.equal(frames[0].start, 0, '第一帧从 0 开始')
    assert.equal(frames[frames.length - 1].end, bytes.length, '末帧到缓冲区结尾')
  })

  test('findSessionLog 取最高世代', () => {
    const dir = path.join(root, PROJECT_A, bareUuid)
    const hit = findSessionLog(dir)
    assert.ok(hit !== null && hit.endsWith('session.v4.jsonl.zstd'), '必须选 v4，实际 ' + hit)
  })

  test('sessionIdKeys 双形态', () => {
    assert.deepEqual(sessionIdKeys(bareUuid), [bareUuid, 'session-' + bareUuid])
    assert.deepEqual(sessionIdKeys('session-' + bareUuid), ['session-' + bareUuid, bareUuid])
    assert.deepEqual(sessionIdKeys(''), [])
  })

  test('findSessionFile 两种目录形态都能定位', () => {
    const a = findSessionFile(root, bareUuid)
    const b = findSessionFile(root, 'session-' + prefixedUuid)
    assert.ok(a !== null && a.includes(bareUuid), '裸 uuid 目录要命中')
    assert.ok(b !== null && b.includes(prefixedUuid), '带前缀目录要命中')
  })

  test('findSessionFile 拒绝目录穿越', () => {
    for (const bad of ['../etc', 'a/b', '..', '.', '', './x']) {
      assert.equal(findSessionFile(root, bad), null, '危险 id 必须拒绝：' + bad)
    }
  })

  test('readSessionEvents 多帧逐行解析', () => {
    const file = findSessionFile(root, bareUuid)
    const events = readSessionEvents(file)
    assert.equal(events.length, 2, '会话头+1条助手消息')
    assert.equal(events[0].type, 'session')
    assert.equal(events[1].type, 'assistant/message')
  })

  test('assistantTextBlocks 只要 text 块', () => {
    const file = findSessionFile(root, bareUuid)
    const blocks = assistantTextBlocks(readSessionEvents(file))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text, '新世代正文')
    assert.equal(blocks[0].seq, 1)
    assert.equal(blocks[0].blockIndex, 0, '块索引按 content 内实际位置')
  })

  test('tool/result 与 system/message 的 text 块不进助手正文清单', () => {
    // 真实数据陷阱（52 会话实测）：2011 个 text 块中 1395 个在 tool/result
    // 事件、67 个在 system/message 事件。误收会把工具输出/系统消息当成
    // 助手正文展示和编辑。
    const events = [
      { type: 'session', version: 4, id: 'session-test', createdAt: 1 },
      assistantEvent(1, '助手正文'),
      toolResultEvent(2, '工具输出：ls 的结果'),
      { type: 'system/message', seq: 3, data: { message: { role: 'system', content: [{ type: 'text', text: '系统消息' }] } } },
    ]
    const blocks = assistantTextBlocks(events)
    assert.equal(blocks.length, 1, '只应收录 assistant/message 的正文，实际 ' + blocks.length)
    assert.equal(blocks[0].text, '助手正文')
  })

  test('assistantEditableBlocks：v3 起 text 与 reasoning 都可编辑，blockIndex 含工具调用块', () => {
    const events = [
      assistantEvent(1, '助手正文'),
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          message: {
            id: 'm2', role: 'assistant', source: { kind: 'model' },
            content: [
              { type: 'reasoning', text: '推理链' },
              { type: 'text', text: '正文二' },
              { type: 'tool-call', id: 'c1', name: 'read' },
              { type: 'text', text: '正文三' },
            ],
          },
        },
      },
    ]
    const all = assistantEditableBlocks(events, ['text', 'reasoning'])
    // 夹具 assistantEvent 的 content 是 [text, tool-call, reasoning]
    assert.deepEqual(all.map(b => [b.seq, b.blockIndex, b.kind]), [
      [1, 0, 'text'],
      [1, 2, 'reasoning'],
      [2, 0, 'reasoning'],
      [2, 1, 'text'],
      [2, 3, 'text'],
    ], 'blockIndex 是 content 数组下标，工具调用块占位但不入清单')
  })

  test('assistantEditableBlocks：默认只要 text（向后兼容）', () => {
    const events = [{
      type: 'assistant/message',
      seq: 1,
      data: { message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: '推理' }, { type: 'text', text: '正文' }] } },
    }]
    const only = assistantEditableBlocks(events)
    assert.deepEqual(only.map(b => [b.blockIndex, b.kind]), [[1, 'text']], '默认口径必须与 assistantTextBlocks 一致')
  })

  test('assistantEditableBlocks：thinking 别名按 reasoning 归类', () => {
    const events = [{
      type: 'assistant/message',
      seq: 1,
      data: { message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'thinking', text: '旧版推理' }] } },
    }]
    const r = assistantEditableBlocks(events, ['reasoning'])
    assert.equal(r.length, 1)
    assert.equal(r[0].kind, 'reasoning')
    assert.equal(r[0].text, '旧版推理')
  })

  test('reasoning 块真实 key set {type,text} 无签名字段时 signed=0', () => {
    // 2026-10 实测：本机 696 个 reasoning 块 keys 全是 {text,type}，
    // provider 不产签名。统计器不能因 signature 字段缺席而误判或抛错。
    const events = [{ type: 'session', version: 4, id: 'session-test', createdAt: 1 }, assistantEvent(1, '正文')]
    const stats = thinkingSignatureStats(events)
    assert.deepEqual(stats, { thinking: 1, signed: 0, eventCount: 2, assistantMessages: 1 })
  })

  test('thinkingSignatureStats 统计推理块与签名', () => {
    const file = findSessionFile(root, bareUuid)
    const stats = thinkingSignatureStats(readSessionEvents(file))
    assert.deepEqual(stats, { thinking: 1, signed: 1, eventCount: 2, assistantMessages: 1 })

    const file2 = findSessionFile(root, 'session-' + prefixedUuid)
    const stats2 = thinkingSignatureStats(readSessionEvents(file2))
    assert.deepEqual(stats2, { thinking: 1, signed: 0, eventCount: 2, assistantMessages: 1 }, '无签名时 signed=0')
  })

  test('sessionsRootDefault 尊重 DSH_HOME', () => {
    const prev = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'C:\\somewhere\\custom'
      assert.equal(sessionsRootDefault(), path.join(path.resolve('C:\\somewhere\\custom'), 'sessions'))
      process.env.DSH_HOME = ''
      assert.equal(sessionsRootDefault(), path.join(homedir(), '.dsh', 'sessions'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
}
// 注意：fixture 的清理必须在测试循环**之后**执行。曾经用
// try{...}finally{rmSync} 包住「定义+执行」整段，finally 在定义结束时
// 就删了目录，测试循环拿到的是空目录——全部 find 类用例假失败。
let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error?.message ?? error).split('\n')[0])
  }
}
rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过（' + tests.length + '）' : '\n失败 ' + failed + ' / ' + tests.length)
process.exit(failed === 0 ? 0 : 1)
