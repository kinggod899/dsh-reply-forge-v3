// 受损会话修复的纯逻辑层（src/session-repair.mjs）。
//
// 与 session-write.mjs（伪造写入）划清界限：那个改 assistant/message 的正文，
// 这个只给「未知类型且缺 ignorable 标记」的事件补 `ignorable: true`——v3.0
// 曾经写出的那种会让宿主 fail-closed 拒读整条日志的毒事件。除此之外**一字
// 不动**，没动过的帧连压缩字节都保持原样。
//
// 本文件不 import 任何宿主包（可在没有 DSH 的机器上测）：事件词汇表闸门
// （knownTypes）与持久化准入闸门（validateStoredEvents）由调用方注入。
//
// 安全契约：
//   1. strictRead 严格读取——坏帧/坏行直接抛，绝不「跳过继续」（session-log
//      的宽松口径是给 UI 列目录用的，修文件不能沿用）；
//   2. repairFile 逐个文件：备份（逐字节校验）→ 只改毒行 → 原子写 → 自读
//      复验 → **只有「没修好」才还原**：结构被破坏、或闸门仍因未知类型拒读，
//      说明标记没生效，还原；闸门因别的旧伤拒读、或冷恢复冒烟失败（比闸门
//      更严的 header 校验）都属于文件本来就有问题——补标记是严格改进，
//      保留写入并在返回里带 note，由调用方亮给用户；
//   3. 备份永不删除。

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from './session-log.mjs'

/**
 * 逐帧解压、逐行解析地严格读取会话日志。
 * @param {string} file
 * @returns {{buf:Buffer, frames:Array<{start:number,end:number}>, lines:Array<{frame:number, raw:string, json:object|null, blank:boolean, trailingNewline:boolean}>}}
 * @throws 帧解压失败 / 行 JSON 解析失败时（修文件的工具不猜）
 */
export function strictRead(file) {
  const buf = readFileSync(file)
  const frames = scanZstdFrames(buf)
  if (frames.length === 0) throw new Error('没有完整可解析的 zstd 帧（文件为空或帧头损坏）')
  const lines = []
  frames.forEach((fr, fi) => {
    let text
    try {
      text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8')
    } catch (error) {
      throw new Error(`第 ${fi} 帧（字节 ${fr.start}-${fr.end}）解压失败：${String(error?.message ?? error)}`)
    }
    const trailingNewline = text.endsWith('\n')
    const parts = trailingNewline ? text.slice(0, -1).split('\n') : text.split('\n')
    parts.forEach((raw, i) => {
      if (raw.trim() === '') {
        lines.push({ frame: fi, raw, json: null, blank: true, trailingNewline })
        return
      }
      let json = null
      try { json = JSON.parse(raw) } catch (error) {
        throw new Error(`第 ${fi} 帧第 ${i + 1} 行 JSON 解析失败：${String(error?.message ?? error)}`)
      }
      lines.push({ frame: fi, raw, json, blank: false, trailingNewline })
    })
  })
  return { buf, frames, lines }
}

/**
 * 找出「未知类型且未标记 ignorable」的行（毒事件行）。会话头行（type=session）
 * 不是事件，跳过；已知类型与已标记事件都跳过。
 * @param {Array} lines strictRead 产物
 * @param {Set<string>} knownTypes 宿主 KNOWN_SESSION_EVENT_TYPES
 * @returns {number[]} 行下标（lines 的下标）
 */
export function poisonLines(lines, knownTypes) {
  const out = []
  lines.forEach((ln, i) => {
    const ev = ln.json
    if (ev === null || ln.blank) return
    if (ev.type === 'session') return
    if (knownTypes.has(ev.type)) return
    if (ev.ignorable === true) return
    out.push(i)
  })
  return out
}

/** 从行模型取会话头（首行，剔除 type 字段）。 */
export function headerOf(lines) {
  const first = lines[0]
  if (first === undefined || first.json === null || first.json.type !== 'session') {
    throw new Error('首行不是会话头（type=session）')
  }
  const header = { ...first.json }
  delete header.type
  return header
}

/** 从行模型取事件全集（跳过会话头与空行）。 */
export function eventsOf(lines) {
  const headerLine = lines[0]
  return lines.filter(l => l.blank === false && l !== headerLine).map(l => l.json)
}

/**
 * 修复一个文件：给毒事件补 ignorable:true，别的什么都不动。
 *
 * @param {string} file 会话日志路径
 * @param {{knownTypes:Set<string>, validate?:(header:object, events:object[], path:string)=>void}} opts
 *   validate 是宿主持久化准入闸门（validateStoredEvents），注入了才会跑；
 *   冷恢复冒烟同理（scripts 层注入 Session.fromRestore）。
 * @param {(header:object, events:object[]) => {ok:boolean, reason?:string}} [coldRestore] 可选冷恢复冒烟
 * @returns {{file:string, backup:string, poisoned:number, frames:number}}
 * @throws 任何一步不过都抛；写入后复验失败会先从备份还原再抛
 */
export function repairFile(file, opts, coldRestore) {
  const { buf, frames, lines } = strictRead(file)
  const knownTypes = opts.knownTypes
  const poisonIdx = poisonLines(lines, knownTypes)
  if (poisonIdx.length === 0) throw new Error('没有需要修复的事件（未知类型且未标记）')

  // 1. 备份（逐字节校验）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = file + '.bak-repair-' + stamp
  copyFileSync(file, backup)
  if (existsSync(backup) === false || statSync(backup).size === 0) {
    throw new Error('备份创建失败或为空，拒绝写入：' + backup)
  }
  if (createHash('sha256').update(readFileSync(backup)).digest('hex')
    !== createHash('sha256').update(buf).digest('hex')) {
    throw new Error('备份与原文件逐字节不一致，拒绝写入：' + backup)
  }

  // 2. 只改毒行
  const dirty = new Set()
  for (const i of poisonIdx) {
    const ln = lines[i]
    const stamped = { ...ln.json, ignorable: true }
    ln.json = stamped
    ln.raw = JSON.stringify(stamped)
    dirty.add(i)
  }
  const header = headerOf(lines)
  const newEvents = eventsOf(lines)

  // 3. 重组：没动过的帧保留**原字节**；动过的帧按行重压（帧结构、行序、行内容不变）
  const byFrame = new Map()
  lines.forEach((ln, i) => {
    if (!byFrame.has(ln.frame)) byFrame.set(ln.frame, [])
    byFrame.get(ln.frame).push(i)
  })
  const chunks = []
  for (let fi = 0; fi < frames.length; fi++) {
    const idxs = byFrame.get(fi) ?? []
    if (idxs.some(i => dirty.has(i)) === false) {
      chunks.push(buf.subarray(frames[fi].start, frames[fi].end))
      continue
    }
    const meta = lines[idxs[0]]
    let text = idxs.map(i => lines[i].raw).join('\n')
    if (meta.trailingNewline) text += '\n'
    chunks.push(zstdCompressSync(Buffer.from(text, 'utf8')))
  }

  // 4. 原子写
  const tmp = file + '.repair-tmp'
  writeFileSync(tmp, Buffer.concat(chunks))
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { if (existsSync(tmp)) renameSync(tmp, tmp + '.failed-' + stamp) } catch { /* 忽略 */ }
    throw new Error('原子替换失败（已保留备份 ' + backup + '）：' + String(error?.message ?? error))
  }

  // 5. 自读复验
  try {
    const reread = strictRead(file)
    if (reread.frames.length !== frames.length) throw new Error(`帧数变化 ${frames.length} → ${reread.frames.length}`)
    if (reread.lines.length !== lines.length) throw new Error(`行数变化 ${lines.length} → ${reread.lines.length}`)
    for (const [i, before] of lines.entries()) {
      const after = reread.lines[i]
      if (dirty.has(i)) {
        if (after.json?.ignorable !== true) throw new Error(`第 ${i} 行补标记后仍不是 ignorable:true`)
      } else if (after.raw !== before.raw) {
        throw new Error(`第 ${i} 行被意外改动（未列入修改计划）`)
      }
    }
    // 闸门：我们的毒没修好才还原；文件本来就有别的伤 → 保留修复+报告
    // （补标记是严格改进：少一条拒读理由。还原反而把改进扔了。）
    if (typeof opts.validate === 'function') {
      try {
        opts.validate(header, newEvents, file)
      } catch (error) {
        const msg = String(error?.message ?? error)
        if (/unknown to this harness|not marked ignorable/.test(msg)) {
          throw new Error('补标记未生效（闸门仍因未知类型拒读）：' + msg.slice(0, 200))
        }
        return {
          file, backup, poisoned: dirty.size, frames: frames.length,
          gate: 'other-issue',
          note: '补标记已写入；但该会话还有与本次无关的问题，宿主闸门仍拒读：' + msg.slice(0, 200),
        }
      }
    }
    // 冷恢复冒烟（比闸门更严：还要校验 header 形状）。它失败从来不是因为
    // 我们的标记，一律按「旧伤」处理：保留修复 + 报告。
    if (typeof coldRestore === 'function') {
      const cold = coldRestore(header, newEvents)
      if (cold.ok === false) {
        return {
          file, backup, poisoned: dirty.size, frames: frames.length,
          gate: 'other-issue',
          note: '补标记已写入、闸门已放行；但冷恢复冒烟仍失败（与本次修复无关的旧伤）：' + cold.reason,
        }
      }
    }
    return { file, backup, poisoned: dirty.size, frames: frames.length, gate: 'pass' }
  } catch (error) {
    // 复验不过 → 还原
    copyFileSync(backup, file)
    try { if (existsSync(tmp)) renameSync(tmp, tmp + '.failed-' + stamp) } catch { /* 忽略 */ }
    const wrapped = new Error('写入后复验失败，已从备份还原：' + String(error?.message ?? error))
    wrapped.backup = backup
    throw wrapped
  }
}

/**
 * 诊断一个文件（只读，绝不写）。
 * @param {string} file
 * @param {Set<string>} knownTypes
 * @param {(header:object, events:object[], path:string)=>void} [validate]
 * @returns {{file:string, status:'clean'|'damaged'|'unreadable'|'bad-header', poison?:number[], note?:string}}
 */
export function diagnoseFile(file, knownTypes, validate) {
  let parsed
  try {
    parsed = strictRead(file)
  } catch (error) {
    return { file, status: 'unreadable', note: String(error?.message ?? error) }
  }
  let header
  try {
    header = headerOf(parsed.lines)
  } catch (error) {
    return { file, status: 'bad-header', note: String(error?.message ?? error) }
  }
  const poison = poisonLines(parsed.lines, knownTypes)
  if (poison.length === 0) {
    if (typeof validate === 'function') {
      try {
        validate(header, eventsOf(parsed.lines), file)
        return { file, status: 'clean' }
      } catch (error) {
        return { file, status: 'clean', note: '无未标记未知事件，但闸门仍拒读：' + String(error?.message ?? error).slice(0, 200) }
      }
    }
    return { file, status: 'clean' }
  }
  const result = { file, status: 'damaged', poison }
  if (typeof validate === 'function') {
    try {
      validate(header, eventsOf(parsed.lines), file)
      result.verdict = 'PASS'
    } catch (error) {
      result.verdict = 'REFUSED'
      result.verdictReason = String(error?.message ?? error).slice(0, 200)
    }
  }
  return result
}
