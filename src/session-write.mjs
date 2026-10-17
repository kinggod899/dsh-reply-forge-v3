// 会话落盘写入器（v2 核心模块）。
//
// 安全契约（任何一条不满足就拒绝写）：
//   1. **只改** `assistant/message` 事件里 `type==='text'` 的块，且必须
//      命中目标（指纹或子串）；`tool/result`、`system/message` 等一概不碰
//      （真实 schema 里 1395/2011 个 text 块在 tool/result 事件里）；
//   2. 命中事件的 reasoning/thinking 块**剥掉 signature/thinkingSignature**
//      （默认仅该事件；--strip-scope 可扩到全文）——宿主 pi-ai 的降级通道
//      据此把 thinking 降级成纯 text 发送，绕过签名校验；
//   3. 写前整文件备份（`.bak-forge-<ts>`）；原子写（临时文件 + rename）；
//      写后**自读校验**，任一不过 → 自动从备份还原并抛错；
//   4. 帧策略 `preserve`（默认）：逐帧解压→改行→重压，帧数量与顺序不变，
//      宿主的追加式写帧语义不受影响。`merge`：合并为单帧（对照组，等宿主
//      读取兼容性实测后再决定是否启用）。
//
// 零依赖、纯 ESM（与 v1 构建契约一致，便于将来并入 client half）。

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames, readSessionEvents } from './session-log.mjs'
import { projectedTextsOf } from './patch-event.mjs'

/** 正文指纹：规范化空白后取 sha256 前 16 位（与内容一一对应即可寻址）。 */
export function fingerprint(text) {
  const norm = String(text ?? '').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16)
}

/** 事件里的助手正文 text 块索引（只认 assistant/message 的 text 块）。 */
export function assistantTextBlockRefs(event) {
  return assistantEditableBlockRefs(event, ['text'])
}

/**
 * 事件里可编辑块的索引（text + reasoning/thinking）。
 *
 * v3 起支持改推理链：块种类只影响「哪些块可编辑」，寻址仍然是
 * seq + blockIndex（blockIndex 是 content 数组下标，含推理块）。
 * @param {object} event
 * @param {string[]} [kinds] 允许的种类，默认 ['text']
 * @returns {Array<{blockIndex:number,kind:string,text:string,fingerprint:string}>}
 */
export function assistantEditableBlockRefs(event, kinds = ['text']) {
  if (event === null || typeof event !== 'object') return []
  if (event.type !== 'assistant/message') return []
  const content = event?.data?.message?.content
  if (Array.isArray(content) === false) return []
  const want = new Set(kinds)
  const out = []
  content.forEach((block, i) => {
    if (block === null || typeof block !== 'object') return
    if (typeof block.text !== 'string') return
    const kind = block.type === 'text' ? 'text'
      : (block.type === 'reasoning' || block.type === 'thinking') ? 'reasoning' : null
    if (kind === null || want.has(kind) === false) return
    out.push({ blockIndex: i, kind, text: block.text, fingerprint: fingerprint(block.text) })
  })
  return out
}

/**
 * 把会话文件解成「帧 × 行」模型。行保持原文（字节级），可解析事件才进 event。
 * @param {string} file
 * @returns {{frames:Array<{start:number,end:number,trailingNewline:boolean}>,lines:Array<{frame:number,text:string,event:object|null,bad:boolean}>}}
 */
export function loadLines(file) {
  const buf = readFileSync(file)
  const frames = scanZstdFrames(buf)
  const lines = []
  const frameMeta = []
  frames.forEach((fr, fi) => {
    const raw = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8')
    const trailingNewline = raw.endsWith('\n')
    const parts = trailingNewline ? raw.slice(0, -1).split('\n') : raw.split('\n')
    frameMeta.push({ start: fr.start, end: fr.end, trailingNewline })
    for (const text of parts) {
      let event = null
      let bad = false
      if (text.trim() !== '') {
        try { event = JSON.parse(text) } catch { bad = true }
      }
      lines.push({ frame: fi, text, event, bad })
    }
  })
  return { frames: frameMeta, lines }
}

/**
 * 在行模型里定位目标 text 块。三种寻址方式，优先级：seq+blockIndex > fingerprint > match。
 *
 * 为什么需要 seq 寻址：浏览器 half 拿不到写入器的 sha256 指纹——它只有
 * **渲染后的 DOM 文本**，而磁盘上是 markdown 源码，两者对不上（`**粗体**`
 * 渲染成「粗体」）。所以 UI 侧改用「事件 seq + 块索引」定位：这两个值从
 * 只读路由读到的磁盘数据里原样带出来，与内容无关，天然稳定。
 *
 * @param {Array} lines loadLines 产物
 * @param {{seq?:number, blockIndex?:number, fingerprint?:string, match?:string}} where
 * @returns {Array<{line:number,blockIndex:number,seq:number|null,text:string,fingerprint:string}>}
 */
export function locateTargets(lines, where = {}) {
  const bySeq = typeof where.seq === 'number' && typeof where.blockIndex === 'number'
  const kinds = Array.isArray(where.kinds) && where.kinds.length > 0 ? where.kinds : ['text']
  const hits = []
  lines.forEach((ln, i) => {
    if (ln.bad || ln.event === null) return
    if (bySeq && ln.event.seq !== where.seq) return
    for (const ref of assistantEditableBlockRefs(ln.event, kinds)) {
      if (bySeq) {
        if (ref.blockIndex !== where.blockIndex) continue
      } else if (where.fingerprint !== undefined) {
        if (ref.fingerprint !== where.fingerprint) continue
      } else if (where.match !== undefined) {
        if (!ref.text.includes(where.match)) continue
      } else {
        continue
      }
      hits.push({
        line: i,
        blockIndex: ref.blockIndex,
        kind: ref.kind,
        seq: typeof ln.event.seq === 'number' ? ln.event.seq : null,
        text: ref.text,
        fingerprint: ref.fingerprint,
      })
    }
  })
  return hits
}

/** 剥掉事件内 reasoning/thinking 块的签名字段，返回剥离计数。 */
export function stripSignaturesInEvent(event, scope = 'same-event') {
  if (event === null || typeof event !== 'object') return 0
  const content = event?.data?.message?.content
  if (Array.isArray(content) === false) return 0
  if (scope === 'none') return 0
  let n = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'thinking' && block.type !== 'reasoning') continue
    for (const key of ['signature', 'thinkingSignature']) {
      if (key in block) { delete block[key]; n += 1 }
    }
  }
  return n
}

/** 全文剥签名（strip-scope=all 用）：返回剥离计数。 */
function stripSignaturesAll(lines) {
  let n = 0
  for (const ln of lines) {
    if (ln.event === null) continue
    if (ln.event.type !== 'assistant/message') continue
    n += stripSignaturesInEvent(ln.event, 'same-event')
  }
  return n
}

/** 重新序列化行（event 非空且被改过的行才重写，其余保持原文）。 */
function reserialize(lines, dirty) {
  for (const i of dirty) {
    const ln = lines[i]
    if (ln.event !== null) ln.text = JSON.stringify(ln.event)
  }
}

/** 按帧策略重组缓冲区。 */
function rebuild(file, loaded, lines, strategy) {
  if (strategy === 'merge') {
    const text = lines.map(l => l.text).join('\n') + '\n'
    return Buffer.concat([zstdCompressSync(Buffer.from(text, 'utf8'))])
  }
  // preserve：逐帧重压。帧的 trailingNewline 语义保持原样。
  const byFrame = new Map()
  lines.forEach(l => {
    if (!byFrame.has(l.frame)) byFrame.set(l.frame, [])
    byFrame.get(l.frame).push(l.text)
  })
  const chunks = []
  for (let fi = 0; fi < loaded.frames.length; fi += 1) {
    const meta = loaded.frames[fi]
    const parts = byFrame.get(fi) ?? []
    let text = parts.join('\n')
    if (meta.trailingNewline && text !== '') text += '\n'
    else if (meta.trailingNewline && text === '') text = '\n'
    chunks.push(zstdCompressSync(Buffer.from(text, 'utf8')))
  }
  void file
  return Buffer.concat(chunks)
}

/** 自读校验：解析、事件数、seq 连续、新文本在、旧文本不在。 */
function selfVerify(file, expect) {
  const events = readSessionEvents(file)
  const kinds = Array.isArray(expect.kinds) && expect.kinds.length > 0 ? expect.kinds : ['text']
  const blocks = []
  for (const ev of events) {
    if (ev?.type !== 'assistant/message') continue
    const content = ev?.data?.message?.content
    if (Array.isArray(content) === false) continue
    for (const ref of assistantEditableBlockRefs(ev, kinds)) blocks.push(ref.text)
  }
  if (events.length !== expect.eventCount) {
    throw new Error(`自读校验失败：事件数 ${events.length} ≠ 预期 ${expect.eventCount}`)
  }
  const seqs = events.map(e => (typeof e.seq === 'number' ? e.seq : null)).filter(s => s !== null)
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] <= seqs[i - 1]) throw new Error(`自读校验失败：seq 非严格递增（${seqs[i - 1]} → ${seqs[i]}）`)
  }
  if (!blocks.some(t => t.includes(expect.newText))) {
    throw new Error('自读校验失败：新正文未出现在任何可编辑块')
  }
  if (expect.oldText !== undefined && blocks.some(t => t === expect.oldText)) {
    throw new Error('自读校验失败：旧正文仍然存在')
  }
  return { events: events.length, blocks: blocks.length }
}

/**
 * 执行一次伪造写入。
 * @param {string} file 会话文件路径
 * @param {{seq?:number, blockIndex?:number, fingerprint?:string, match?:string, newText:string,
 *          expectText?:string, strategy?:'preserve'|'merge', stripScope?:'same-event'|'all'|'none',
 *          dryRun?:boolean}} opts
 *   寻址三选一：seq+blockIndex（UI 用）/ fingerprint / match。
 *   expectText 给定时做陈旧校验：与磁盘当前文本不符即拒绝。
 * @returns {{ok:boolean,dryRun:boolean,targets:Array,stripped:number,backup?:string,verify?:object,strategy:string}}
 */
export function forgeSession(file, opts) {
  const strategy = opts.strategy ?? 'preserve'
  const stripScope = opts.stripScope ?? 'same-event'
  if (typeof opts.newText !== 'string' || opts.newText.trim() === '') {
    throw new Error('newText 不能为空')
  }
  if (existsSync(file) === false) throw new Error('会话文件不存在：' + file)

  const originalEvents = readSessionEvents(file)
  const loaded = loadLines(file)
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length > 0 ? opts.kinds : ['text']
  const where = { fingerprint: opts.fingerprint, match: opts.match, kinds }
  if (typeof opts.seq === 'number') { where.seq = opts.seq; where.blockIndex = opts.blockIndex }
  const targets = locateTargets(loaded.lines, where)
  if (targets.length === 0) {
    const how = typeof opts.seq === 'number'
      ? `seq=${opts.seq} blockIndex=${opts.blockIndex}`
      : (opts.fingerprint !== undefined ? 'fingerprint=' + opts.fingerprint : 'match')
    throw new Error('未命中任何可编辑块（' + how + ' 无匹配）')
  }
  if (targets.length > 1 && opts.fingerprint === undefined && typeof opts.seq !== 'number') {
    const list = targets.map(t => `  line#${t.line} seq=${t.seq} fp=${t.fingerprint} 「${t.text.replace(/\s+/g, ' ').slice(0, 40)}…」`).join('\n')
    throw new Error('match 命中多个块，请改用 --fingerprint 精确定位：\n' + list)
  }
  // 投影优先：目标块上如果已经有本插件的 patch 事件（此前的在线伪造被宿主
  // 持久化落盘），改原始文本会被投影盖住——写「成功」也不生效。必须在陈旧
  // 校验之前拦下来（那时的 raw 文本与界面看到的投影后文本本来就不同，会先
  // 抛一个词不达意的 STALE_TARGET），并说清楚该怎么办。
  const projections = projectedTextsOf(loaded.lines.map(ln => ln.event))
  const targetProjection = typeof targets[0].seq === 'number' ? projections.get(targets[0].seq) : undefined
  if (targetProjection !== undefined && targetProjection.has(targets[0].blockIndex)) {
    const err = new Error('这个块已有本插件的在线伪造（投影优先于原文），磁盘改写不会生效。请在 DSH 里打开这个会话，用「写入伪造」的自动路径写入')
    err.code = 'PATCHED_TARGET'
    err.actual = targetProjection.get(targets[0].blockIndex)
    throw err
  }
  // 陈旧校验：调用方（UI）看到的那份文本必须与磁盘当前文本逐字节一致。
  // 界面长时间开着、或同一会话在别处被改过时，seq 仍在但内容已变——
  // 不校验就会把「用户以为在改 A」的编辑写到 B 上。
  if (typeof opts.expectText === 'string' && targets[0].text !== opts.expectText) {
    const stale = new Error('磁盘上的正文与预期不一致（界面看到的内容已过期），已拒绝写入。请刷新后重试。')
    stale.code = 'STALE_TARGET'
    stale.actual = targets[0].text
    stale.expected = opts.expectText
    throw stale
  }

  // 应用编辑
  const dirty = new Set()
  let stripped = 0
  for (const t of targets) {
    const ln = loaded.lines[t.line]
    const content = ln.event.data.message.content
    const block = content[t.blockIndex]
    if (block === undefined || typeof block !== 'object') throw new Error('目标块不存在（内部错误）')
    block.text = opts.newText
    // 改推理块必须连带剥签名（签名对的是原文，正文一改就失配）
    if (t.kind === 'reasoning') {
      delete block.signature
      delete block.thinkingSignature
    }
    dirty.add(t.line)
    stripped += stripSignaturesInEvent(ln.event, stripScope)
  }
  if (stripScope === 'all') stripped += stripSignaturesAll(loaded.lines)
  reserialize(loaded.lines, dirty)

  if (opts.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      strategy,
      targets,
      stripped,
      wouldChangeLines: [...dirty].sort((a, b) => a - b),
      frameCount: loaded.frames.length,
    }
  }

  // 备份 → 原子写 → 自读校验（失败自动还原）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = file + '.bak-forge-' + stamp
  copyFileSync(file, backup)
  const bs = statSync(backup)
  if (bs.size === 0) throw new Error('备份文件为空，拒绝写入')

  const tmp = file + '.forge-tmp'
  writeFileSync(tmp, rebuild(file, loaded, loaded.lines, strategy))
  const oldText = targets[0].text
  try {
    renameSync(tmp, file)
    const verify = selfVerify(file, {
      eventCount: originalEvents.length,
      newText: opts.newText,
      oldText: targets.length === 1 ? oldText : undefined,
      kinds: [...new Set(targets.map(t => t.kind))],
    })
    return { ok: true, dryRun: false, strategy, targets, stripped, backup, verify }
  } catch (err) {
    // 自读不过 → 还原
    copyFileSync(backup, file)
    try { if (existsSync(tmp)) renameSync(tmp, tmp + '.failed-' + stamp) } catch { /* 忽略 */ }
    const wrapped = new Error('写入后自读校验失败，已从备份还原：' + err.message)
    wrapped.backup = backup
    throw wrapped
  }
}

export { readSessionEvents, scanZstdFrames }
