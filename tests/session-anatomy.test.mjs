// 会话解剖工具测试（tests/session-anatomy.test.mjs）。
//
// 为什么直接 import 而不是 spawn 子进程：session-anatomy.mjs 已经把分析逻辑
// 抽成 analyzeSession()、把 CLI 抽成 runCli()，两者都是纯函数（runCli 支持注入
// stdout/stderr）。这样测试跑的是**交付面本身**（JSON 报告 + 退出码 + 文本输出），
// 不需要子进程——本沙箱禁止 node 进程再 spawn（EBUSY），而且进程内调用更快更稳。
//
// 运行：node tests/session-anatomy.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { runCli } from '../scripts/session-anatomy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'session-anatomy.mjs')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/**
 * 把事件逐条压成独立帧（与真实落盘一致：会话头一帧 + 每事件一帧）。
 * 注意：**会话头也必须压缩**——scanZstdFrames 要求缓冲区从第 0 字节起就是
 * zstd magic，明文头会让它一帧都扫不到（踩过：整份报告全空）。
 */
function buildSessionBytes(events, head = {}) {
  const parts = [Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-anatomy-test', createdAt: 1, cwd: 'C:\\workspace', ...head }) + '\n')]
  for (const ev of events) parts.push(Buffer.from(JSON.stringify(ev) + '\n'))
  return Buffer.concat(parts.map(p => zstdCompressSync(p)))
}

/** 造一轮：turn/start → request/context → assistant/message(usage) → [attempt 失败] → turn/end。 */
function turnEvents({ turn, seq, provider, model, inputTokens, cacheReadTokens, outputTokens = 1, failure = null, markerText = null }) {
  const evs = [
    { type: 'turn/start', seq, time: 1700000000000 + turn * 1000, data: { turn } },
    { type: 'request/context', seq: seq + 1, time: 1700000000001 + turn * 1000, data: { provider, model } },
    {
      type: 'assistant/message',
      seq: seq + 2,
      time: 1700000000002 + turn * 1000,
      data: {
        turn,
        step: 1,
        usage: { inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens, totalTokens: inputTokens + cacheReadTokens + outputTokens },
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: markerText ?? ('第 ' + turn + ' 轮正文') }],
          source: { kind: 'model', provider, model },
          id: 'msg-' + turn,
        },
      },
    },
  ]
  if (failure !== null) {
    evs.push({
      type: 'assistant/attempt',
      seq: seq + 3,
      time: 1700000000003 + turn * 1000,
      data: { turn, step: 1, stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] },
    })
  }
  evs.push({
    type: 'turn/end',
    seq: seq + 4,
    time: 1700000000004 + turn * 1000,
    data: { turn, reason: failure === null ? { kind: 'completed' } : { kind: 'error', error: failure } },
  })
  return evs
}

/** 跑一次 CLI（进程内），返回退出码与两路输出。 */
function cli(args) {
  let stdout = ''
  let stderr = ''
  const status = runCli(args, { stdout: s => { stdout += s }, stderr: s => { stderr += s } })
  return { status, stdout, stderr }
}

/** 跑 --json 并解析报告。 */
function runAnatomy(file, extra = []) {
  const res = cli([SCRIPT, '--file', file, '--json', ...extra].slice(1))
  assert.equal(res.stderr, '', 'JSON 模式不应有 stderr：' + res.stderr)
  assert.equal(res.status === 0 || res.status === 2, true, '意外退出码 ' + res.status + '：' + res.stderr)
  return { status: res.status, report: JSON.parse(res.stdout) }
}

const root = mkdtempSync(path.join(tmpdir(), 'rf-anatomy-test-'))

// ── fixture 1：大上下文 + 小窗口模型 → CONTEXT_WINDOW_EXCEEDED ─────────────
const bigFile = path.join(root, 'big.jsonl.zstd')
{
  const evs = [
    ...turnEvents({ turn: 1, seq: 10, provider: 'provider-a', model: 'model-a', inputTokens: 100, cacheReadTokens: 200000 }),
    ...turnEvents({
      turn: 2, seq: 20, provider: 'provider-b', model: 'model-b', inputTokens: 400000, cacheReadTokens: 127000,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prompt is too long: 100001 tokens > 100000 maximum' },
    }),
    { type: 'compaction/prune', seq: 30, time: 1700000005000, data: { shadowedSeqs: [10], shadowedTokenCount: 94299 } },
    { type: 'compaction/start', seq: 31, time: 1700000005001, data: { compactionId: 'c1', turn: 2 } },
    { type: 'compaction/end', seq: 32, time: 1700000005002, data: { compactionId: 'c1', turn: 2, error: 'prompt is too long: 100001 tokens > 100000 maximum' } },
  ]
  writeFileSync(bigFile, buildSessionBytes(evs, { parentSession: 'session-parent-1', isSeeded: true }))
}

// ── fixture 2：正常完成的会话 ───────────────────────────────────────────────
const okFile = path.join(root, 'ok.jsonl.zstd')
{
  const evs = turnEvents({ turn: 1, seq: 10, provider: 'provider-a', model: 'model-a', inputTokens: 100, cacheReadTokens: 5000 })
  writeFileSync(okFile, buildSessionBytes(evs))
}

// ── fixture 3：NO_ADAPTER，且失败轮的 provider 与最后一次切换不同 ───────────
const noAdapterFile = path.join(root, 'noadapter.jsonl.zstd')
{
  const evs = [
    ...turnEvents({
      turn: 1, seq: 10, provider: 'provider-c', model: 'model-c',
      inputTokens: 10, cacheReadTokens: 1000,
      failure: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "provider-c"' },
    }),
    // 失败之后用户又切了模型：结论必须仍指向 provider-c，而不是 provider-a。
    { type: 'model/selection', seq: 40, time: 1700000009000, data: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
  ]
  writeFileSync(noAdapterFile, buildSessionBytes(evs))
}

// ── fixture 4：伪造痕迹 ─────────────────────────────────────────────────────
const markerFile = path.join(root, 'marker.jsonl.zstd')
{
  const evs = turnEvents({
    turn: 1, seq: 10, provider: 'provider-a', model: 'model-a',
    inputTokens: 10, cacheReadTokens: 100, markerText: '正文里有 FORGE-OK-TEST 这个标记',
  })
  writeFileSync(markerFile, buildSessionBytes(evs))
}

test('大上下文 + 小窗口 → blocker，且上下文取 input+cacheRead', () => {
  const { status, report } = runAnatomy(bigFile)
  assert.equal(status, 2, 'blocker 必须给退出码 2')
  assert.equal(report.usage.peak.contextTokens, 400000 + 127000, '峰值上下文 = input + cacheRead')
  assert.equal(report.usage.peak.model, 'model-b')
  const codes = report.verdict.map(v => v.code)
  assert.ok(codes.includes('CONTEXT_WINDOW_EXCEEDED'), '必须有 CONTEXT_WINDOW_EXCEEDED：' + JSON.stringify(codes))
  assert.ok(codes.includes('COMPACTION_FAILED'), '压缩失败也要报：' + JSON.stringify(codes))
  assert.equal(report.compaction.prunedTokens, 94299, '被剪 token 取宿主自报值')
  assert.equal(report.session.parentSession, 'session-parent-1', '分叉信息要带出')
  assert.equal(report.session.isSeeded, true)
})

test('正常完成的会话 → ok，退出码 0', () => {
  const { status, report } = runAnatomy(okFile)
  assert.equal(status, 0, '无 blocker 必须退出码 0')
  assert.deepEqual(report.verdict.map(v => v.level), ['ok'])
})

test('NO_ADAPTER 的结论指向失败轮的 provider，而不是最后一次切换', () => {
  const { status, report } = runAnatomy(noAdapterFile)
  assert.equal(status, 2)
  const v = report.verdict.find(x => x.code === 'NO_ADAPTER')
  assert.ok(v !== undefined, '必须有 NO_ADAPTER 结论')
  assert.ok(v.message.includes('provider-c'), '必须指名 provider-c，实际：' + v.message)
  assert.equal(v.message.includes('provider-a'), false, '不能被最后一次 model/selection 带偏')
  const lastTurn = report.turns[report.turns.length - 1]
  assert.equal(lastTurn.provider, 'provider-c', '每轮结局要记录该轮真实 provider')
})

test('伪造痕迹按 marker 命中并给出字符数', () => {
  const { report } = runAnatomy(markerFile, ['--marker', 'FORGE-OK-TEST'])
  assert.equal(report.marker.hits.length, 1, '应命中 1 处')
  assert.equal(report.marker.hits[0].seq, 12, '命中 seq 应为 assistant/message 的 seq')
  assert.ok(report.marker.hits[0].chars > 0)
})

test('不带 marker 时不产生 marker 段', () => {
  const { report } = runAnatomy(markerFile)
  assert.equal(report.marker, undefined)
})

test('文本模式与 JSON 模式共用同一退出码，且文本模式能读出结论', () => {
  const text = cli(['--file', bigFile])
  assert.equal(text.status, 2, '文本模式下 blocker 也要退出码 2（两种模式口径必须一致）')
  assert.ok(text.stdout.includes('CONTEXT_WINDOW_EXCEEDED'), '文本里要有结论码')
  assert.ok(text.stdout.includes('527,000'), '文本里要有人读的上下文数字：' + text.stdout.split('\n').slice(0, 8).join(' | '))
  const json = cli(['--file', bigFile, '--json'])
  assert.equal(json.status, text.status, 'JSON 与文本的退出码必须相同')
})

test('文件不存在 → 退出码 1，且报错走 stderr', () => {
  const res = cli(['--file', path.join(root, '不存在.jsonl.zstd')])
  assert.equal(res.status, 1)
  assert.ok(res.stderr.includes('找不到会话文件'), '应给出可操作的提示')
  assert.equal(res.stdout, '', '出错时不该往 stdout 写东西')
})

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
