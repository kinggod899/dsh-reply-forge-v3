// 临时探针：验证「未知事件类型 + 无 ignorable」在持久化读取路径上会不会被拒。
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
const { restoreReleasedV4Artifact } = await imp('dsh-session-format-v3-to-v4')

function newestSessionFile() {
  const root = sessionsRootDefault()
  let best = null
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.jsonl\.zstd$/i.test(e.name)) {
        const st = statSync(p)
        if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, size: st.size }
      }
    }
  }
  walk(root)
  return best
}

const file = newestSessionFile()
console.log('会话文件:', file.path, '(' + file.size + ' 字节)')
const rows = readSessionEvents(file.path)
console.log('解出行数:', rows.length)
console.log('前 3 行 type:', rows.slice(0, 3).map(r => r.type).join(' | '))
const headerRow = rows[0]
console.log('首行 keys:', Object.keys(headerRow).join(','))
console.log('首行片段:', JSON.stringify(headerRow).slice(0, 300))

// 行布局：第 0 行是 header（物理层多一个 type 字段），其余是事件（seq 从 0 起）
const events = rows.slice(1)
const header = { ...headerRow }
delete header.type
const artifact = { header, inheritedEventCount: 0, events }
console.log('事件 seq 首尾:', events[0]?.seq, '→', events[events.length - 1]?.seq)

try {
  restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
  console.log('\n[基线] 真会话原样 → 通过')
} catch (error) {
  console.log('\n[基线] 真会话原样 → 抛错:', String(error.message).slice(0, 200))
}

const patchData = { version: 1, targets: [{ seq: 0, blockIndex: 1, kind: 'text', text: 'x' }] }
const withUnknown = {
  ...artifact,
  events: [...events, { type: 'reply-forge/patch', seq: events.length, time: Date.now(), data: patchData }],
}
try {
  restoreReleasedV4Artifact(withUnknown, KNOWN_SESSION_EVENT_TYPES)
  console.log('[无 ignorable] 追加 reply-forge/patch → 通过')
} catch (error) {
  console.log('[无 ignorable] 追加 reply-forge/patch → 抛错:', String(error.message).slice(0, 220))
}

const withIgnorable = {
  ...artifact,
  events: [...events, { type: 'reply-forge/patch', seq: events.length, time: Date.now(), data: patchData, ignorable: true }],
}
try {
  restoreReleasedV4Artifact(withIgnorable, KNOWN_SESSION_EVENT_TYPES)
  console.log('[带 ignorable] 追加 reply-forge/patch → 通过')
} catch (error) {
  console.log('[带 ignorable] 追加 reply-forge/patch → 抛错:', String(error.message).slice(0, 220))
}

console.log('\n已知类型里有没有 reply-forge/patch:', KNOWN_SESSION_EVENT_TYPES.has('reply-forge/patch'))
