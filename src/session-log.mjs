// 会话落盘日志的只读访问层（多帧 zstd JSONL）。
//
// 为什么存在：UI 层（浏览器 half）要展示「模型侧记录」与本地渲染对照，
// 需要会话落盘文件的内容。写路径刻意不在此文件，也未经验证前不得出现
// —— 本模块严格只读，见 HANDOFF.md §10 的论证与风险清单。
//
// 三个硬点的实现参照本机生产环境的邻居插件 dsh-tavern（同样读 dsh 会话
// 日志，线上验证过），并按本项目需要重写：
//   1. zstd 帧头正规解析：压缩数据内部可能碰巧出现 magic 字节，
//      naive「搜到 magic 就切帧」会误切。这里解析 Frame_Header_Descriptor
//      （FCS 标志 / Single_Segment / 保留位 / 字典 ID）再定位下一帧。
//   2. 会话 id 两种目录形态：裸 <uuid> 与 session-<uuid> 并存
//      （tavern 实测 189 裸 / 71 带前缀，漏一种就查不到）。
//   3. 取最高世代 session.vN：v3/v4 并存时不要读到旧世代。
//
// 本文件不依赖宿主、不注册任何东西，可在测试中直接针对临时目录运行。

import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * zstd 帧魔数。磁盘字节序是 28 B5 2F FD，注意 readUInt32LE 是**小端**读，
 * 常量必须写成 0xfd2fb528（写反端序会一帧都扫不到——踩过）。
 */
const ZSTD_MAGIC = 0xfd2fb528

/** 会话日志文件名：session.v<N>.jsonl.zstd，取世代号。 */
const SESSION_LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/i

/** 会话 id 只允许安全字符，挡住一切目录穿越。 */
const SESSION_ID_SAFE = /^[A-Za-z0-9_-]+$/

/**
 * 扫描多帧 zstd 缓冲区的帧边界（start/end 为字节区间，含头不含下一帧头）。
 * @param {Buffer} buffer 压缩文件全文
 * @returns {Array<{start:number,end:number}>} 帧区间列表
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buffer.length) break
    // Frame_Header_Descriptor：
    //   bit7-6 Frame_Content_Size_flag，bit5 Single_Segment，
    //   bit4 未用，bit3 保留（必须为 0），bit1-0 Dictionary_ID_flag。
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (offset + remainingHeaderBytes > buffer.length) break
    offset += remainingHeaderBytes
    // 下一帧 = 下一个「magic + 保留位干净的描述符」。压缩数据内部
    // 也可能出现 magic，但描述符校验把它挡掉。
    let nextStart = -1
    for (let i = offset; i < buffer.length - 4; i++) {
      if (buffer.readUInt32LE(i) !== ZSTD_MAGIC) continue
      if ((buffer.readUInt8(i + 4) & 0x18) === 0) { nextStart = i; break }
    }
    const end = nextStart > 0 ? nextStart : buffer.length
    frames.push({ start, end })
    offset = end
  }
  return frames
}

/** 取目录中世代最高的 session.vN.jsonl.zstd。 */
export function findSessionLog(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  let bestGen = -1
  for (const name of entries) {
    const m = SESSION_LOG_RE.exec(name)
    if (m === null) continue
    const gen = Number(m[1])
    if (gen > bestGen) {
      bestGen = gen
      best = path.join(dir, name)
    }
  }
  return best
}

/** 会话 id 的候选写法：传什么就原样一份，再加切换前缀/去前缀的另一份。 */
export function sessionIdKeys(sessionId) {
  const sid = String(sessionId ?? '')
  if (sid === '') return []
  const bareId = sid.replace(/^session-/, '')
  return bareId === sid ? [sid, 'session-' + bareId] : [sid, bareId]
}

/**
 * 定位会话日志文件。真实布局是三层：
 *   <sessionsRoot>/<项目目录>/<会话目录>/session.vN.jsonl.zstd
 * 项目目录按 cwd 编码命名；会话目录用裸 <uuid> 或 session-<uuid>
 * 两种形态之一（tavern 实测 189 裸 / 71 带前缀），两种都试。
 * @param {string} sessionsRoot ~/.dsh/sessions
 * @param {string} sessionId 会话 id
 * @returns {string|null} 文件路径；id 不安全或找不到返回 null
 */
export function findSessionFile(sessionsRoot, sessionId) {
  const sid = String(sessionId ?? '')
  if (sid === '' || SESSION_ID_SAFE.test(sid) === false) return null
  let projects
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  const keys = sessionIdKeys(sid)
  for (const project of projects) {
    if (project.isDirectory() === false) continue
    const projectDir = path.join(sessionsRoot, project.name)
    for (const key of keys) {
      const hit = findSessionLog(path.join(projectDir, key))
      if (hit !== null) return hit
    }
  }
  return null
}

/**
 * 读取会话全部事件（多帧逐帧解压 → 逐行 JSON）。
 * 单帧损坏只丢该帧，不整体失败（与宿主的容错方向一致）。
 * @param {string} filePath 会话日志路径
 * @returns {object[]} 事件对象数组
 */
export function readSessionEvents(filePath) {
  let compressed
  try {
    compressed = readFileSync(filePath)
  } catch {
    return []
  }
  const events = []
  for (const frame of scanZstdFrames(compressed)) {
    let text
    try {
      text = zstdDecompressSync(compressed.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // 坏行跳过：宁可少一条，不可抛
      }
    }
  }
  return events
}

/**
 * 读取一个会话的「助手正文块」清单：只取 text 块，
 * 工具调用与推理块不进入本清单（后续编辑面收敛的预处理）。
 * @param {object[]} events readSessionEvents 的产物
 * @returns {Array<{seq:number|null,blockIndex:number,text:string}>}
 */
export function assistantTextBlocks(events) {
  const out = []
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type !== 'assistant/message') continue
    const content = ev?.data?.message?.content
    if (Array.isArray(content) === false) continue
    let blockIndex = 0
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        out.push({
          seq: typeof ev.seq === 'number' ? ev.seq : null,
          blockIndex,
          text: block.text,
        })
      }
      blockIndex += 1
    }
  }
  return out
}

/**
 * 读取一个会话的「可编辑块」清单：text 与 reasoning/thinking。
 *
 * v3 起推理块也可编辑（对齐块种类，寻址仍是 seq + blockIndex）。
 * blockIndex 是 content 数组下标——含工具调用块，不只是可编辑块的序号；
 * 这与写入器 locateTargets 的口径一致，改一处必须改两处。
 *
 * @param {object[]} events readSessionEvents 的产物
 * @param {string[]} [kinds] 允许的种类，默认 ['text']
 * @returns {Array<{seq:number|null,blockIndex:number,kind:string,text:string}>}
 */
export function assistantEditableBlocks(events, kinds = ['text']) {
  const want = new Set(kinds)
  const out = []
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type !== 'assistant/message') continue
    const content = ev?.data?.message?.content
    if (Array.isArray(content) === false) continue
    content.forEach((block, blockIndex) => {
      if (block === null || typeof block !== 'object') return
      if (typeof block.text !== 'string') return
      const kind = block.type === 'text' ? 'text'
        : (block.type === 'reasoning' || block.type === 'thinking') ? 'reasoning' : null
      if (kind === null || want.has(kind) === false) return
      out.push({ seq: typeof ev.seq === 'number' ? ev.seq : null, blockIndex, kind, text: block.text })
    })
  }
  return out
}

/**
 * 统计推理块与带签名推理块的数量。字段名做兼容读取：
 * 落盘事件用 signature，pi-ai 内部模型用 thinkingSignature。
 * @param {object[]} events readSessionEvents 的产物
 * @returns {{thinking:number,signed:number,eventCount:number,assistantMessages:number}}
 */
export function thinkingSignatureStats(events) {
  let thinking = 0
  let signed = 0
  let assistantMessages = 0
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') continue
    if (ev.type === 'assistant/message') assistantMessages += 1
    const content = ev?.data?.message?.content
    if (Array.isArray(content) === false) continue
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type !== 'thinking' && block.type !== 'reasoning') continue
      thinking += 1
      const signature = block.signature ?? block.thinkingSignature
      if (typeof signature === 'string' && signature.length > 0) signed += 1
    }
  }
  return { thinking, signed, eventCount: events.length, assistantMessages }
}

/**
 * dsh sessions 根目录：$DSH_HOME（非空时）优先，否则 ~/.dsh/sessions。
 * 与邻居插件的解析规则一致（DSH_HOME 非默认位置时不能写死 ~/.dsh）。
 * @returns {string} 目录路径
 */
export function sessionsRootDefault() {
  const env = process.env.DSH_HOME
  const home = typeof env === 'string' && env.trim() !== '' ? path.resolve(env.trim()) : path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}
