// 帧解剖探针（scripts/frame-anatomy.mjs）：纯 Node，不起宿主。
// 回答写入器设计需要的四个问题：
//   1. 每个会话几个 zstd 帧？帧与事件什么关系（一帧一批？一帧一轮）？
//   2. 事件在帧间怎么分布（顺序追加？）？最后一帧是不是"活的"（可增长）？
//   3. 帧内 JSONL 行与事件的对应（一行一事件？）；
//   4. assistant/message 事件在帧间的位置（写入器要定位的目标）。
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents, scanZstdFrames, sessionsRootDefault } from '../src/session-log.mjs'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = sessionsRootDefault()
const args = process.argv.slice(2)
const limit = args.length > 0 ? Number(args[0]) : 5

const files = []
for (const slug of readdirSync(ROOT)) {
  const slugDir = join(ROOT, slug)
  try { if (!statSync(slugDir).isDirectory()) continue } catch { continue }
  for (const name of readdirSync(slugDir)) {
    const f = join(slugDir, name, 'session.v4.jsonl.zstd')
    if (existsSync(f)) files.push({ id: name, file: f, size: statSync(f).size, mtime: statSync(f).mtimeMs })
  }
}
files.sort((a, b) => b.size - a.size)

console.log(`会话文件总数: ${files.length}，取体积最大的 ${Math.min(limit, files.length)} 个解剖\n`)

for (const { id, file, size } of files.slice(0, limit)) {
  const buf = readFileSync(file)
  const frames = scanZstdFrames(buf)
  const events = readSessionEvents(file)
  // 每帧解出多少行/事件
  const perFrame = frames.map(fr => {
    let text
    try { text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { return { err: true } }
    const lines = text.split('\n').filter(l => l.trim() !== '')
    const types = lines.map(l => { try { return JSON.parse(l).type ?? '?' } catch { return 'BADLINE' } })
    return { bytes: fr.end - fr.start, lines: lines.length, types }
  })
  const totalEvents = events.length
  const asst = events.map((e, i) => ({ e, i })).filter(x => x.e.type === 'assistant/message')
  console.log(`== ${id} (${size}B, ${frames.length} 帧, ${totalEvents} 事件, ${asst.length} 个 assistant/message)`)
  perFrame.forEach((fr, i) => {
    if (fr.err) { console.log(`   帧${i}: 解压失败`); return }
    const counts = {}
    for (const t of fr.types) counts[t] = (counts[t] ?? 0) + 1
    const summary = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(' ')
    console.log(`   帧${i}: ${fr.bytes}B, ${fr.lines} 行 — ${summary}`)
  })
  console.log('')
}
