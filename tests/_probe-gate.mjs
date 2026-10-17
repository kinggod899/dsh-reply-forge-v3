// 临时探针 2：用宿主真正的读取闸门验证「带 patch 事件的会话还能不能被读出来」。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSessionEvents, sessionsRootDefault } from '../src/session-log.mjs'
import { findHostPackage } from './host-pkg.mjs'

// 宿主 @deepseek-ai 根：经 host-pkg 三级解析（环境变量 → host-paths.local.json → 标准位置）
const sessionEntry = findHostPackage('dsh-session')
if (sessionEntry === null) {
  console.error('找不到宿主 @deepseek-ai 包。设置 DSH_SESSION_PKG，或建 tests/host-paths.local.json')
  process.exit(1)
}
const APP = dirname(dirname(dirname(sessionEntry)))
const imp = n => import(pathToFileURL(join(APP, n, 'lib', 'index.js')).href)

const { KNOWN_SESSION_EVENT_TYPES } = await imp('dsh-session')
const { validateStoredEvents } = await imp('dsh-session-persistence')

function allSessionFiles() {
  const root = sessionsRootDefault()
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.jsonl\.zstd$/i.test(e.name)) out.push({ path: p, mtimeMs: statSync(p).mtimeMs })
    }
  }
  walk(root)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

const files = allSessionFiles()
console.log('会话文件总数:', files.length)

let withPatch = 0
const bad = []
for (const f of files) {
  const rows = readSessionEvents(f.path)
  if (rows.length === 0) continue
  const header = { ...rows[0] }
  delete header.type
  const events = rows.slice(1)
  const foreign = events.filter(e => !KNOWN_SESSION_EVENT_TYPES.has(e?.type))
  if (foreign.length === 0) continue
  withPatch += 1
  const types = [...new Set(foreign.map(e => e.type))].join(',')
  let verdict
  try {
    validateStoredEvents({ id: header.id }, events, { kind: 'jsonl', path: f.path })
    verdict = 'PASS'
  } catch (error) {
    verdict = 'REFUSED: ' + String(error.message).slice(0, 150)
  }
  bad.push({ id: header.id, version: header.version, types, foreignCount: foreign.length, verdict })
}

console.log('含未知事件类型的会话数:', withPatch)
for (const b of bad) {
  console.log('\n--- session ' + b.id + ' (format v' + b.version + ')')
  console.log('    未知类型:', b.types, '条数:', b.foreignCount)
  console.log('    宿主读取闸门:', b.verdict)
}

// 顺便验证：把 ignorable 补上就放行了吗
if (bad.length > 0) {
  const target = files.find(f => readSessionEvents(f.path).some(e => e?.type === 'reply-forge/patch'))
  if (target !== undefined) {
    const rows = readSessionEvents(target.path)
    const header = { ...rows[0] }
    delete header.type
    const events = rows.slice(1).map(e => (e?.type === 'reply-forge/patch' ? { ...e, ignorable: true } : e))
    try {
      validateStoredEvents({ id: header.id }, events, { kind: 'jsonl', path: target.path })
      console.log('\n[对照] 给 patch 事件补上 ignorable:true → PASS')
    } catch (error) {
      console.log('\n[对照] 补 ignorable 后仍被拒:', String(error.message).slice(0, 150))
    }
  }
}

// 顺便看：插件侧能不能 import 到宿主那份 dsh-session（词汇表注册的前提）
try {
  const mod = await import('@deepseek-ai/dsh-session')
  const same = mod.KNOWN_SESSION_EVENT_TYPES === KNOWN_SESSION_EVENT_TYPES
  console.log('\n插件位置能否解析 @deepseek-ai/dsh-session: 能；是否同一个 Set 实例:', same)
} catch (error) {
  console.log('\n插件位置能否解析 @deepseek-ai/dsh-session: 不能 →', String(error.code ?? error.message).slice(0, 120))
}
