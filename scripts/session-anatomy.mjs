// 会话解剖 / 上下文预算体检（scripts/session-anatomy.mjs）
//
// 为什么需要它：v2 的目标 3 是「还能继续对话」。一个真实失败案例不是改写造成
// 的，而是**会话自己太大了**——
//   某会话（从被改写的会话分叉而来）有效上下文涨到约 52 万 tokens，
//   用户把模型切到一个上游声明 10 万窗口的模型 →
//   CONTEXT_WINDOW_EXCEEDED，且 dsh 的自动压缩也救不回来（压缩请求自己超限）。
// 于是「改写前/后能不能继续对话」需要一个能直接读出来的体检报告，而不是靠猜。
//
// 数据来源全部是宿主自己写进会话日志的字段，不重新实现分词器：
//   assistant/message.data.usage      → 每轮真实用量（宿主自报，最权威）
//   assistant/message.data.message.source → 该轮 provider/model
//   model/selection                   → 用户切模型的时刻
//   assistant/attempt.stream[].chunk.reason.failure → 失败码与文案
//   compaction/prune.shadowedTokenCount → 被压缩剪掉的 token
//   request/header.tools              → 工具定义体积（prompt 的固定开销）
//
// 有效上下文口径：inputTokens + cacheReadTokens + cacheWriteTokens。
// 实测（同一会话的几轮，取整到百位）：
//   turn2 157+186304=186461 → 18.6 万；turn3 → 19.8 万；turn4 → 25.6 万
//   turn5 → 31.8 万；turn8 505671+21632=527303 → 52.7 万
// 缓存命中的部分不会出现在 inputTokens 里，只加 inputTokens 会严重低估。
//
// 用法：
//   node scripts/session-anatomy.mjs --session <会话id>
//   node scripts/session-anatomy.mjs --file <会话文件>
//   node scripts/session-anatomy.mjs --list
//   node scripts/session-anatomy.mjs --session <会话id> --turns 10 --json
//   node scripts/session-anatomy.mjs --session <会话id> --marker FORGE-OK
//
// 退出码：有 blocker → 2；正常 → 0；找不到文件 → 1。
// 两种输出模式（文本 / --json）**共用同一套退出码**，便于脚本链式判断。
//
// 只读：本脚本不写任何文件，也不接触 DSH_HOME 以外的东西。
//
// 结构：analyzeSession() 是纯分析（可被测试直接 import），runCli() 负责参数、
// 输出与退出码。CLI 只是薄壳——测试因此不需要 spawn 子进程。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readSessionEvents,
  scanZstdFrames,
  findSessionFile,
  findSessionLog,
  sessionsRootDefault,
} from '../src/session-log.mjs'

// ── 通用小工具 ──────────────────────────────────────────────────────────────
function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}
function safeIsDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function textLen(v) {
  if (typeof v === 'string') return v.length
  if (Array.isArray(v)) return v.reduce((a, x) => a + textLen(x), 0)
  if (v !== null && typeof v === 'object') return Object.values(v).reduce((a, x) => a + textLen(x), 0)
  return 0
}

// ── 会话枚举 ────────────────────────────────────────────────────────────────
export function listSessions(root = sessionsRootDefault()) {
  const rows = []
  for (const project of safeReaddir(root)) {
    const projectDir = path.join(root, project)
    if (!safeIsDir(projectDir)) continue
    for (const session of safeReaddir(projectDir)) {
      const dir = path.join(projectDir, session)
      if (!safeIsDir(dir)) continue
      const log = findSessionLog(dir)
      if (log === null) continue
      let st
      try { st = statSync(log) } catch { continue }
      rows.push({ session, project, file: log, mtime: st.mtimeMs, bytes: st.size })
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  return rows
}

/** 把 --session 片段解析成会话文件路径；--file 直接给路径。 */
export function resolveSessionFile({ file = null, session = null, root = sessionsRootDefault() } = {}) {
  if (typeof file === 'string') return path.resolve(file)
  if (typeof session === 'string') {
    const hit = findSessionFile(root, session)
    if (hit !== null) return hit
    // 会话 id 可能只给了前缀片段：扫一遍目录名做子串匹配。
    for (const project of safeReaddir(root)) {
      const projectDir = path.join(root, project)
      if (!safeIsDir(projectDir)) continue
      for (const s of safeReaddir(projectDir)) {
        if (s.includes(session)) {
          const log = findSessionLog(path.join(projectDir, s))
          if (log !== null) return log
        }
      }
    }
    return null
  }
  return null
}

// ── 核心分析（纯函数：文件进，报告出）──────────────────────────────────────
/**
 * @param {{ file: string, turns?: number, marker?: string }} opts
 * @returns {{ report: object, exitCode: number }}
 */
export function analyzeSession({ file, turns = 6, marker = '' }) {
  const FILE = path.resolve(file)
  const bytes = readFileSync(FILE)
  const frames = scanZstdFrames(bytes)
  const events = readSessionEvents(FILE)
  const report = {}

  // ── 基本信息 ──────────────────────────────────────────────────────────────
  const head = events.find(e => e?.type === 'session') ?? {}
  const typeCount = {}
  for (const e of events) {
    const t = e?.type ?? '?'
    typeCount[t] = (typeCount[t] ?? 0) + 1
  }
  const seqs = events.map(e => e.seq).filter(s => typeof s === 'number')
  report.file = FILE
  report.bytes = bytes.length
  report.frames = frames.length
  report.events = events.length
  report.seqRange = seqs.length > 0 ? [Math.min(...seqs), Math.max(...seqs)] : null
  report.session = {
    id: head.id ?? null,
    cwd: head.cwd ?? null,
    parentSession: head.parentSession ?? null,
    isSeeded: head.isSeeded === true,
    createdAt: head.createdAt ?? null,
  }
  report.typeCount = typeCount

  // ── 上下文足迹：以宿主自报的 usage 为准 ───────────────────────────────────
  const usageRows = []
  for (const e of events) {
    if (e?.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (u === undefined || u === null) continue
    const src = e.data?.message?.source ?? {}
    usageRows.push({
      turn: e.data?.turn ?? null,
      step: e.data?.step ?? null,
      seq: e.seq ?? null,
      provider: src.provider ?? null,
      model: src.model ?? null,
      inputTokens: u.inputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      // 有效上下文：缓存命中的部分不在 inputTokens 里，必须补回来。
      contextTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
    })
  }
  // 每轮取最后一步（该轮的真实上下文水位）。
  const perTurn = new Map()
  for (const r of usageRows) if (r.turn !== null) perTurn.set(r.turn, r)
  const turnRows = [...perTurn.values()].sort((a, b) => a.turn - b.turn)
  const peak = turnRows.length > 0 ? turnRows.reduce((a, b) => (b.contextTokens > a.contextTokens ? b : a)) : null
  report.usage = { perTurn: turnRows, peak }

  // 被压缩剪掉的 token（宿主自报）。
  const prunes = events.filter(e => e?.type === 'compaction/prune')
  report.compaction = {
    pruneCount: prunes.length,
    prunedTokens: prunes.reduce((a, e) => a + (e.data?.shadowedTokenCount ?? 0), 0),
    starts: events.filter(e => e?.type === 'compaction/start').length,
    failures: events
      .filter(e => e?.type === 'compaction/end' && typeof e.data?.error === 'string')
      .map(e => ({ seq: e.seq ?? null, time: e.time ?? null, error: e.data.error })),
  }

  // 原始字符统计（只作参考：真正进 prompt 的量由 usage 给出）。
  const byRole = {}
  for (const e of events) {
    if (!['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'].includes(e?.type)) continue
    byRole[e.type] = (byRole[e.type] ?? 0) + textLen(e.data?.message?.content ?? e.data)
  }
  report.rawChars = { total: Object.values(byRole).reduce((a, b) => a + b, 0), byRole }

  // 助手块的构成：正文 vs 推理 vs 工具调用（判断「正文占比」是否异常）。
  const blockChars = {}
  for (const e of events) {
    if (e?.type !== 'assistant/message') continue
    const content = e.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const t = b?.type ?? '?'
      const n = (typeof b?.text === 'string' ? b.text.length : 0)
        + (b?.input !== undefined ? JSON.stringify(b.input).length : 0)
        + (b?.signature !== undefined ? String(b.signature).length : 0)
      blockChars[t] = (blockChars[t] ?? 0) + n
    }
  }
  report.assistantBlocks = blockChars

  // ── 模型切换时间线 ────────────────────────────────────────────────────────
  report.modelSelections = events
    .filter(e => e?.type === 'model/selection')
    .map(e => ({ seq: e.seq ?? null, time: e.time ?? null, provider: e.data?.provider ?? null, model: e.data?.model ?? null }))

  // ── 每轮结局 ──────────────────────────────────────────────────────────────
  const turnStarts = events.filter(e => e?.type === 'turn/start')
  const turnEnds = events.filter(e => e?.type === 'turn/end')
  const attempts = events.filter(e => e?.type === 'assistant/attempt')
  const routeEvents = events.filter(e => e?.type === 'request/context' || e?.type === 'request/header')
  const turnOutcomes = []
  for (const ts of turnStarts) {
    const turn = ts.data?.turn ?? null
    const end = turnEnds.find(e => e.seq > ts.seq && (e.data?.turn ?? null) === turn) ?? null
    const att = attempts.filter(e => e.seq > ts.seq && (e.data?.turn ?? null) === turn)
    const failures = []
    for (const a of att) {
      for (const s of (a.data?.stream ?? [])) {
        const f = s?.chunk?.reason?.failure
        if (f !== undefined && f !== null) failures.push({ seq: a.seq ?? null, code: f.code ?? null, message: f.message ?? null })
      }
    }
    // 该轮真正用的模型：取这一轮里最后一个 request/context|request/header 的声明。
    // 不能用「最后一次 model/selection」——用户可能在那轮之后又切了模型。
    let route = null
    for (const r of routeEvents) {
      if (r.seq <= ts.seq) continue
      if (end !== null && r.seq > end.seq) continue
      const p = r.data?.provider ?? r.data?.header?.config?.provider ?? null
      const m = r.data?.model ?? r.data?.header?.config?.model ?? null
      if (p !== null) route = { provider: p, model: m }
    }
    turnOutcomes.push({
      turn,
      startTime: ts.time ?? null,
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      endKind: end?.data?.reason?.kind ?? null,
      endError: end?.data?.reason?.error?.code ?? end?.data?.reason?.error?.message ?? null,
      failures,
    })
  }
  report.turns = turnOutcomes

  // ── 伪造痕迹 ──────────────────────────────────────────────────────────────
  if (marker !== '') {
    const hits = []
    for (const e of events) {
      if (e?.type !== 'assistant/message') continue
      const content = e.data?.message?.content
      if (!Array.isArray(content)) continue
      content.forEach((b, i) => {
        if (typeof b?.text === 'string' && b.text.includes(marker)) {
          hits.push({ seq: e.seq ?? null, blockIndex: i, chars: b.text.length })
        }
      })
    }
    report.marker = { marker, hits }
  }

  // ── 结论 ──────────────────────────────────────────────────────────────────
  const lastTurn = turnOutcomes.length > 0 ? turnOutcomes[turnOutcomes.length - 1] : null
  const lastFailure = lastTurn !== null && lastTurn.failures.length > 0 ? lastTurn.failures[lastTurn.failures.length - 1] : null
  const lastSelection = report.modelSelections.length > 0
    ? report.modelSelections[report.modelSelections.length - 1]
    : null
  const verdict = []
  if (lastFailure !== null && lastFailure.code === 'CONTEXT_WINDOW_EXCEEDED') {
    const who = lastTurn?.provider !== null && lastTurn?.provider !== undefined
      ? `${lastTurn.provider}/${lastTurn.model ?? '?'}`
      : (lastSelection !== null ? `${lastSelection.provider}/${lastSelection.model}` : '?')
    verdict.push({
      level: 'blocker',
      code: lastFailure.code,
      message: `会话上下文 ${peak?.contextTokens ?? '?'} tokens，失败那一轮用的模型 ${who} 装不下（上游报 ${lastFailure.message ?? ''}）。`,
      action: '换回大窗口模型（上游声明 1M 窗口的模型，具体以 modelCatalog 为准），或新建任务。',
    })
  } else if (lastFailure !== null && lastFailure.code === 'NO_ADAPTER') {
    const who = lastTurn?.provider ?? lastSelection?.provider ?? '?'
    verdict.push({
      level: 'blocker',
      code: lastFailure.code,
      message: `provider "${who}" 没有注册适配器——通常是提供该 provider 的插件没加载。`,
      action: '检查对应插件包目录是否完整、dsh 是否需要重启。',
    })
  } else if (lastFailure !== null) {
    verdict.push({ level: 'warn', code: lastFailure.code, message: lastFailure.message ?? '', action: '看 assistant/attempt 的 failure 详情。' })
  } else if (lastTurn !== null && lastTurn.endKind === 'completed') {
    verdict.push({ level: 'ok', code: null, message: '最后一轮正常完成，会话可以继续。', action: '' })
  }
  if (report.compaction.failures.length > 0) {
    verdict.push({
      level: 'warn',
      code: 'COMPACTION_FAILED',
      message: `有 ${report.compaction.failures.length} 次自动压缩失败（压缩请求自己也超限时，小窗口模型救不回来）。`,
      action: '换大窗口模型后再让它压缩。',
    })
  }
  report.verdict = verdict

  return { report, exitCode: verdict.some(v => v.level === 'blocker') ? 2 : 0 }
}

// ── 人读输出 ────────────────────────────────────────────────────────────────
export function formatReport(report, { turns = 6, marker = '' } = {}) {
  const L = []
  const fmt = n => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '?'))
  const t = ms => (typeof ms === 'number' ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '?')
  const peak = report.usage.peak
  const turnRows = report.usage.perTurn

  L.push('══ 会话解剖 ══')
  L.push(`文件      ${report.file}`)
  L.push(`体积      ${(report.bytes / 1024).toFixed(0)} KB · ${report.frames} 帧 · ${report.events} 事件 · seq ${report.seqRange?.[0]}..${report.seqRange?.[1]}`)
  L.push(`会话      ${report.session.id}`)
  L.push(`cwd       ${report.session.cwd}`)
  if (report.session.parentSession !== null) L.push(`父会话    ${report.session.parentSession}${report.session.isSeeded ? '（isSeeded，历史已继承）' : ''}`)
  L.push('')

  L.push('══ 上下文足迹（宿主自报 usage）══')
  if (peak === null) {
    L.push('  没有带 usage 的 assistant/message —— 这个会话还没成功跑过一轮。')
  } else {
    L.push(`  峰值上下文 ${fmt(peak.contextTokens)} tokens（turn ${peak.turn}，${peak.provider}/${peak.model}）`)
    L.push('  轮次   模型                              上下文      input      cacheRead   输出')
    for (const r of turnRows.slice(-turns)) {
      L.push(`  ${String(r.turn).padStart(4)}   ${(r.provider + '/' + r.model).padEnd(32)}  ${fmt(r.contextTokens).padStart(9)}  ${fmt(r.inputTokens).padStart(9)}  ${fmt(r.cacheReadTokens).padStart(10)}  ${fmt(r.outputTokens).padStart(6)}`)
    }
  }
  L.push(`  被压缩剪掉 ${fmt(report.compaction.prunedTokens)} tokens（${report.compaction.pruneCount} 次 prune）`)
  L.push(`  原始字符 ${fmt(report.rawChars.total)} → ${JSON.stringify(report.rawChars.byRole)}`)
  L.push(`  助手块字符 ${JSON.stringify(report.assistantBlocks)}`)
  L.push('')

  L.push('══ 模型切换 ══')
  for (const s of report.modelSelections) L.push(`  seq ${String(s.seq).padStart(4)}  ${t(s.time)}  → ${s.provider}/${s.model}`)
  L.push('')

  L.push('══ 每轮结局 ══')
  for (const r of report.turns.slice(-turns)) {
    const f = r.failures.length > 0 ? `  failure=${r.failures.map(x => x.code).join(',')}` : ''
    const who = r.provider !== null ? `  ${r.provider}/${r.model ?? '?'}` : ''
    L.push(`  turn ${String(r.turn).padStart(3)}  ${t(r.startTime)}${who}  end=${r.endKind ?? '?'}${f}`)
    for (const x of r.failures) L.push(`        ${x.code}: ${String(x.message).slice(0, 120)}`)
  }
  L.push('')

  if (marker !== '' && report.marker !== undefined) {
    L.push(`══ 伪造痕迹（marker="${marker}"）══`)
    if (report.marker.hits.length === 0) L.push('  未命中')
    for (const h of report.marker.hits) L.push(`  seq ${h.seq} block#${h.blockIndex} ${h.chars} 字符`)
    L.push('')
  }

  L.push('══ 结论 ══')
  for (const v of report.verdict) {
    const icon = v.level === 'blocker' ? '✖' : v.level === 'warn' ? '!' : '✔'
    L.push(`  ${icon} [${v.code ?? 'OK'}] ${v.message}`)
    if (v.action !== '') L.push(`      → ${v.action}`)
  }
  return L.join('\n') + '\n'
}

// ── CLI 薄壳 ────────────────────────────────────────────────────────────────
/**
 * @param {string[]} argv 不含 node 与脚本名
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void }} io
 * @returns {number} 退出码
 */
export function runCli(argv, io = {}) {
  const write = io.stdout ?? (s => process.stdout.write(s))
  const writeErr = io.stderr ?? (s => process.stderr.write(s))

  const opt = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    opt[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
  }
  const JSON_OUT = opt.json === true
  const TURNS = Number.isFinite(Number(opt.turns)) && Number(opt.turns) > 0 ? Number(opt.turns) : 6
  const MARKER = typeof opt.marker === 'string' ? opt.marker : ''
  const ROOT = typeof opt.root === 'string' ? opt.root : sessionsRootDefault()

  if (opt.list === true) {
    const rows = listSessions(ROOT)
    if (JSON_OUT) {
      write(JSON.stringify({ sessions: rows }, null, 2) + '\n')
    } else {
      write(`共 ${rows.length} 个会话（按修改时间倒序，前 20）\n`)
      for (const r of rows.slice(0, 20)) {
        write(`  ${new Date(r.mtime).toLocaleString('zh-CN')}  ${(r.bytes / 1024).toFixed(0).padStart(6)} KB  ${r.session}\n`)
      }
    }
    return 0
  }

  const FILE = resolveSessionFile({ file: typeof opt.file === 'string' ? opt.file : null, session: typeof opt.session === 'string' ? opt.session : null, root: ROOT })
  if (FILE === null || !existsSync(FILE)) {
    writeErr('找不到会话文件。用 --list 看有哪些，或 --file 直接指定。\n')
    return 1
  }

  const { report, exitCode } = analyzeSession({ file: FILE, turns: TURNS, marker: MARKER })
  if (JSON_OUT) write(JSON.stringify(report, null, 2) + '\n')
  else write(formatReport(report, { turns: TURNS, marker: MARKER }))
  return exitCode
}

// 直接执行时（node scripts/session-anatomy.mjs …）才跑 CLI；被 import 时不跑。
const SELF = fileURLToPath(import.meta.url)
const invoked = process.argv[1] !== undefined
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(SELF).toLowerCase()
if (invoked) process.exit(runCli(process.argv.slice(2)))
