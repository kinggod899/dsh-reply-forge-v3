// 受损会话修复工具 CLI（scripts/repair-sessions.mjs）——v3 P0 的第二块拼图。
//
// 修什么：v3.0 曾把缺少顶层 `ignorable: true` 的 `reply-forge/patch` 事件写进
// 会话日志。宿主 `validateStoredEvents` 对「不认识且未标记」的事件 fail-closed
// 拒读**整条日志**——会话直接打不开。本工具给这些事件补标记，让宿主放行。
//
// 安全契约（纯逻辑在 src/session-repair.mjs，这里只做门卫与编排）：
//   1. **默认只诊断**：不带 --apply 时绝不写任何文件；
//   2. DSH 必须完全退出（按进程名检测；--force 可绕过但会大声警告）——
//      活着的宿主持着写锁、内存里还有旧状态；
//   3. 必须解析到宿主包（KNOWN_SESSION_EVENT_TYPES + validateStoredEvents），
//      否则拒绝——修没修好不能靠猜；
//   4. --apply 必须配 --all 或至少一个 --session <id>（不猜修哪些）；
//   5. 没有 --yes 时，打印完整计划后停下，等人在 stdin 输入 yes；
//   6. 逐文件：备份（.bak-repair-<时间戳>，永不删除）→ 原子写 → 自读复验
//      （帧数/行数/未改行逐字节一致 + 宿主闸门放行 + 冷恢复不抛）→ 不过即还原。
//
// 用法：
//   node scripts/repair-sessions.mjs                        # 诊断全部
//   node scripts/repair-sessions.mjs --session <id>         # 诊断指定（可重复）
//   node scripts/repair-sessions.mjs --apply --session <id> [--yes]
//   node scripts/repair-sessions.mjs --apply --all [--yes] [--force]
//
// 环境：DSH_HOME 指向 profile 根（默认 ~/.dsh）；sessions 根取其下 sessions/。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import { findSessionFile, sessionsRootDefault } from '../src/session-log.mjs'
import { diagnoseFile, repairFile } from '../src/session-repair.mjs'
import { findHostPackage, findHostSessionPackage, toFileUrl } from '../tests/host-pkg.mjs'

// ── 参数解析 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const APPLY = flag('apply')
const YES = flag('yes')
const FORCE = flag('force')
const ALL = flag('all')
const SESSIONS = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--session' && i + 1 < argv.length) SESSIONS.push(argv[i + 1])
}

// ── 宿主包（修没修好只能问宿主）────────────────────────────────────────
let KNOWN_SESSION_EVENT_TYPES = null
let validateStoredEvents = null
let coldRestore = null
try {
  const sessionPkg = findHostSessionPackage()
  const persistencePkg = findHostPackage('dsh-session-persistence')
  if (sessionPkg !== null && persistencePkg !== null) {
    const s = await import(toFileUrl(sessionPkg))
    const p = await import(toFileUrl(persistencePkg))
    KNOWN_SESSION_EVENT_TYPES = s.KNOWN_SESSION_EVENT_TYPES
    validateStoredEvents = p.validateStoredEvents
    coldRestore = (header, events) => {
      try {
        const bare = s.Session.fromRestore(s.SessionId(header.id), events, header, s.SessionLogOffset(0), 'shared-frozen', [])
        bare.deriveMessages()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
      }
    }
  }
} catch (error) {
  console.log('[警告] 宿主包导入失败：' + String(error?.message ?? error))
}

// ── DSH 运行检测 ────────────────────────────────────────────────────────
const DSH_PROCESS_NAMES = ['DeepSeek Harness.exe', 'DeepSeekHarness.exe', 'dsh.exe']
function dshRunning() {
  for (const name of DSH_PROCESS_NAMES) {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (out.toLowerCase().includes(name.toLowerCase())) return name
    } catch { /* tasklist 不可用等情况往下走 */ }
  }
  return null
}

// ── 扫描 ────────────────────────────────────────────────────────────────
function allSessionFiles(root) {
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session\.v\d+\.jsonl\.zstd$/i.test(e.name)) out.push(p)
    }
  }
  walk(root)
  return out
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const root = sessionsRootDefault()
console.log('会话根目录：' + root)
if (existsSync(root) === false) {
  console.log('目录不存在，无可修复内容。')
  process.exit(0)
}

let files = []
if (SESSIONS.length > 0) {
  for (const id of SESSIONS) {
    const f = findSessionFile(root, id)
    if (f === null) {
      console.log('[警告] 找不到会话 ' + id + ' 的日志文件，跳过')
      continue
    }
    files.push(f)
  }
} else {
  files = allSessionFiles(root).sort()
}
console.log('待扫描会话文件：' + files.length + ' 个\n')

if (KNOWN_SESSION_EVENT_TYPES === null) {
  console.log('[拒绝] 解析不到宿主事件词汇表（KNOWN_SESSION_EVENT_TYPES）——')
  console.log('        哪些事件是「未知类型」都判不了，更不能验证修复结果。拒绝动手。')
  process.exit(1)
}

// 诊断（只读）
const damaged = []
let unreadable = 0
for (const file of files) {
  const diag = diagnoseFile(file, KNOWN_SESSION_EVENT_TYPES, validateStoredEvents ?? undefined)
  if (diag.status === 'damaged') {
    damaged.push(diag)
    console.log('[受损] ' + file)
    console.log('        待补标记行数：' + diag.poison.length
      + (diag.verdict !== undefined ? '｜宿主闸门预演：' + diag.verdict : ''))
    if (diag.verdict === 'REFUSED' && diag.verdictReason !== undefined) {
      console.log('        （现在打开会被拒：' + diag.verdictReason + '）')
    }
  } else if (diag.status === 'unreadable') {
    unreadable += 1
    console.log('[读取失败] ' + file)
    console.log('        ' + diag.note + '（该文件有别的伤，本工具不修，请人工检查）')
  } else if (diag.note !== undefined) {
    console.log('[注意] ' + file)
    console.log('        ' + diag.note)
  }
}

console.log('\n── 诊断汇总 ──────────────────────────────')
console.log('扫描：' + files.length + '｜受损：' + damaged.length + '｜读取失败：' + unreadable)

if (damaged.length === 0) {
  console.log('没有发现「未知类型且缺 ignorable 标记」的会话。无需修复。')
  process.exit(0)
}

if (APPLY === false) {
  console.log('\n以上为诊断结果（未修改任何文件）。')
  console.log('确认要修复请：完全退出 DSH 后运行  修复会话.bat apply')
  process.exit(0)
}

// ── --apply：门卫 ───────────────────────────────────────────────────────
if (ALL === false && SESSIONS.length === 0) {
  console.log('\n--apply 需要 --all 或至少一个 --session <id>（不猜修哪些）。')
  process.exit(1)
}
if (validateStoredEvents === null) {
  console.log('\n[拒绝] 解析不到宿主持久化准入闸门（validateStoredEvents）——')
  console.log('        修没修好无法验证，拒绝动手。')
  process.exit(1)
}
const running = dshRunning()
if (running !== null && FORCE === false) {
  console.log('\n[拒绝] 检测到 DSH 正在运行（' + running + '）。')
  console.log('活着的宿主持着会话写锁、内存里还有旧状态——此刻改文件有并发覆盖风险。')
  console.log('请完全退出 DSH 后重试；确实要强行修复请加 --force（后果自负）。')
  process.exit(1)
}
console.log('\n[检查] ' + (running === null
  ? '未检测到 DSH 进程（tasklist 不可用时同理）：请自行确认 DSH 已完全退出。'
  : '--force 模式：DSH 仍在运行，强行修复！'))

// 计划 + 确认
console.log('\n── 修复计划 ──────────────────────────────')
for (const d of damaged) {
  console.log('  ' + d.file)
  console.log('    将给 ' + d.poison.length + ' 个事件补 ignorable:true，别的一字不动')
}
console.log('  每个文件先备份（.bak-repair-<时间戳>，永不删除），原子写回后复验；')
console.log('  复验不过自动还原。')

if (YES === false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise(resolve => {
    rl.question('\n确认执行？输入 yes 继续，其它任何输入取消：', resolve)
  })
  rl.close()
  if (String(answer).trim().toLowerCase() !== 'yes') {
    console.log('已取消，未修改任何文件。')
    process.exit(0)
  }
}

// 执行
console.log('\n── 执行 ──────────────────────────────────')
let fixed = 0
let partial = 0
let failed = 0
for (const d of damaged) {
  try {
    const r = repairFile(d.file, { knownTypes: KNOWN_SESSION_EVENT_TYPES, validate: validateStoredEvents }, coldRestore ?? undefined)
    if (r.gate === 'other-issue') {
      partial += 1
      console.log('[部分修复] ' + r.file)
      console.log('        ' + r.poisoned + ' 个事件补标记｜备份：' + r.backup)
      console.log('        注意：' + r.note)
    } else {
      fixed += 1
      console.log('[已修复] ' + r.file)
      console.log('        ' + r.poisoned + ' 个事件补标记｜备份：' + r.backup + '｜闸门复验：PASS')
    }
  } catch (error) {
    failed += 1
    console.log('[失败] ' + d.file)
    console.log('        ' + String(error?.message ?? error))
  }
}
console.log('\n修复完成：完全修复 ' + fixed + '｜部分修复（有旧伤，标记已写入）' + partial + '｜失败（已还原）' + failed)
console.log('备份文件保留在原文件旁边（.bak-repair-*），确认无误后可自行删除。')
process.exit(failed === 0 ? 0 : 1)
