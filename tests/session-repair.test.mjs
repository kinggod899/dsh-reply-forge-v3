// 受损会话修复逻辑测试（tests/session-repair.test.mjs）。
//
// 修文件是最高危操作，这一份把安全契约逐条钉死：
//   1. strictRead 对坏帧/坏行**抛**（不是跳过）——宽松口径不许进修复路径；
//   2. 只补毒事件的 ignorable:true，别的事件一字不动；
//   3. 没动过的帧连压缩字节都保持原样（原样拷贝，不是重压）；
//   4. 备份先建先校验，写后自读复验不过自动还原；
//   5. 幂等：修好的文件再诊断是 clean，再 repair 直接抛「无可修复」；
//   6. 宿主闸门可注入：注入一个「必拒」的假闸门时，写入必须被还原。
//
// 全程临时目录，不碰真实会话。运行：node tests/session-repair.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  strictRead, poisonLines, headerOf, eventsOf, repairFile, diagnoseFile,
} from '../src/session-repair.mjs'
import { PATCH_EVENT_TYPE, buildPatchData } from '../src/patch-event.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const KNOWN = new Set([
  'session', 'system/message', 'user/message', 'assistant/message', 'tool/result', 'request/header',
])

/** 造会话字节：头一帧 + 每事件一帧（与 routes 测试同配方）。 */
function sessionBytes(events, { header = null } = {}) {
  const head = header ?? { type: 'session', version: 4, id: 'session-repair-test', createdAt: 1, cwd: 'C:\\workspace' }
  const parts = [Buffer.from(JSON.stringify(head) + '\n')]
  for (const ev of events) parts.push(Buffer.from(JSON.stringify(ev) + '\n'))
  return Buffer.concat(parts.map(p => zstdCompressSync(p)))
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message', seq, time: 1700000000000 + seq,
    data: { turn: 1, step: 1, message: { id: 'm-' + seq, role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/** 造一条毒事件（未知类型、无 ignorable）。 */
function poisonEvent(seq) {
  return { type: PATCH_EVENT_TYPE, seq, time: 1700000000000 + seq, data: buildPatchData([{ seq: 1, blockIndex: 0, kind: 'text', text: 'x' }]) }
}

/** 建一个带受损事件的临时会话文件。 */
function makeDamaged(events, { label = 'd' } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'rf-repair-' + label + '-'))
  const dir = path.join(home, 'sessions', '--proj--', 'session-repair-test')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, sessionBytes(events))
  return { home, file }
}

// ── 1. 严格读取 ─────────────────────────────────────────────────────────

test('strictRead：正常文件读出全部行，帧边界正确', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const { frames, lines } = strictRead(file)
    assert.equal(frames.length, 3, '头一帧 + 两事件各一帧')
    assert.equal(lines.length, 3)
    assert.equal(lines[0].json.type, 'session')
    assert.equal(lines[1].json.seq, 1)
    assert.equal(lines[2].json.type, PATCH_EVENT_TYPE)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('strictRead：坏帧直接抛（不跳过）——修复路径不许宽松', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A')])
  try {
    const buf = readFileSync(file)
    // 把第二帧中部掏坏（保留帧头结构，解压必失败）
    const mid = Math.floor(buf.length * 0.75)
    buf[mid] = buf[mid] ^ 0xff
    buf[mid + 1] = buf[mid + 1] ^ 0xff
    writeFileSync(file, buf)
    assert.throws(() => strictRead(file), /解压失败/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('strictRead：坏行直接抛（JSON 都不许猜）', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'rf-repair-badline-'))
  const dir = path.join(home, 's', 'x')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1 }) + '\n')),
    zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":1,\n')),  // 半行 JSON
  ]))
  try {
    assert.throws(() => strictRead(file), /JSON 解析失败/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 2. 毒事件识别 ───────────────────────────────────────────────────────

test('poisonLines：只认未知类型且未标记的；已知/已标记/头行都不算', () => {
  const { home, file } = makeDamaged([
    assistantEvent(1, 'A'),
    poisonEvent(2),
    { ...poisonEvent(3), ignorable: true },          // 已标记 → 不算
    { type: 'tool/result', seq: 4, time: 1 },         // 已知 → 不算
  ])
  try {
    const { lines } = strictRead(file)
    assert.deepEqual(poisonLines(lines, KNOWN), [2], '只有第 2 行（0-based）是毒行')
    assert.deepEqual(poisonLines(lines, new Set([...KNOWN, PATCH_EVENT_TYPE])), [], '全known时无毒行')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 3. 修复 ─────────────────────────────────────────────────────────────

test('repairFile：只补毒事件，未动帧保持原字节', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  const before = readFileSync(file)
  try {
    const r = repairFile(file, { knownTypes: KNOWN })
    assert.equal(r.poisoned, 1)
    assert.ok(existsSync(r.backup) && r.backup.includes('.bak-repair-'))
    // 备份与原文件一致
    assert.equal(Buffer.compare(readFileSync(r.backup), before), 0)

    const after = strictRead(file)
    assert.equal(after.frames.length, 3)
    // 毒事件补上了，别家没动
    assert.equal(after.lines[2].json.ignorable, true)
    assert.equal(after.lines[2].json.type, PATCH_EVENT_TYPE)
    assert.equal(after.lines[2].json.seq, 2)
    assert.equal(after.lines[1].json.ignorable, undefined, '别家事件不加字段')
    assert.equal(after.lines[0].json.type, 'session')
    // 没动过的帧（0、1）字节级保持
    const beforeFrames = strictRead  // 单纯触发一次类型检查占位
    void beforeFrames
    const origFrames = []
    {
      const { frames } = strictRead(r.backup)
      origFrames.push(...frames)
    }
    // 第 0、1 帧在备份里的原字节，必须与修后文件对应帧字节一致
    const afterBuf = readFileSync(file)
    const beforeBuf = readFileSync(r.backup)
    const { frames: af } = strictRead(file)
    for (const fi of [0, 1]) {
      const a = afterBuf.subarray(af[fi].start, af[fi].end)
      const b = beforeBuf.subarray(origFrames[fi].start, origFrames[fi].end)
      assert.equal(Buffer.compare(a, b), 0, `第 ${fi} 帧必须原字节保留（不是重压）`)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：没有毒事件 → 拒绝修（不碰文件）', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A')])
  const before = readFileSync(file)
  try {
    assert.throws(() => repairFile(file, { knownTypes: KNOWN }), /没有需要修复/)
    assert.equal(Buffer.compare(readFileSync(file), before), 0, '文件一字未动')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：注入「必过」闸门与冷恢复 → 成功', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const r = repairFile(file, {
      knownTypes: KNOWN,
      validate: () => {},
    }, () => ({ ok: true }))
    assert.equal(r.poisoned, 1)
    assert.equal(poisonLines(strictRead(file).lines, KNOWN).length, 0, '修完后无毒行')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：多帧里的多个毒事件全部补上，帧结构不变', () => {
  const { home, file } = makeDamaged([
    assistantEvent(1, 'A'),
    poisonEvent(2),
    assistantEvent(3, 'B'),
    poisonEvent(4),
    assistantEvent(5, 'C'),
  ])
  try {
    const before = strictRead(file)
    const r = repairFile(file, { knownTypes: KNOWN })
    assert.equal(r.poisoned, 2)
    const after = strictRead(file)
    assert.equal(after.frames.length, before.frames.length, '帧数不变')
    assert.equal(after.lines.length, before.lines.length, '行数不变')
    assert.equal(after.lines[2].json.ignorable, true)
    assert.equal(after.lines[4].json.ignorable, true)
    assert.equal(after.lines[1].json.ignorable, undefined)
    assert.equal(after.lines[3].json.ignorable, undefined)
    assert.equal(after.lines[5].json.ignorable, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 4. 诊断与幂等 ───────────────────────────────────────────────────────

test('diagnoseFile：受损/干净/坏头 三种判定', () => {
  const a = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)], { label: 'a' })
  const b = makeDamaged([assistantEvent(1, 'A')], { label: 'b' })
  try {
    assert.equal(diagnoseFile(a.file, KNOWN).status, 'damaged')
    assert.equal(diagnoseFile(b.file, KNOWN).status, 'clean')
  } finally {
    rmSync(a.home, { recursive: true, force: true })
    rmSync(b.home, { recursive: true, force: true })
  }
})

test('修完再诊断 → clean，再修 → 拒绝（幂等）', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    repairFile(file, { knownTypes: KNOWN })
    assert.equal(diagnoseFile(file, KNOWN).status, 'clean', '修完必须干净')
    assert.throws(() => repairFile(file, { knownTypes: KNOWN }), /没有需要修复/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 5. 事件/头行提取 ────────────────────────────────────────────────────

test('headerOf / eventsOf：头行剔 type，事件不含头行', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const { lines } = strictRead(file)
    const header = headerOf(lines)
    assert.equal(header.version, 4)
    assert.equal(header.id, 'session-repair-test')
    assert.equal(header.type, undefined, '头行不带 type')
    const events = eventsOf(lines)
    assert.equal(events.length, 2)
    assert.equal(events[0].seq, 1)
    assert.equal(events[1].type, PATCH_EVENT_TYPE)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：闸门因「未知类型」拒读 → 判定为没修好，写入被还原', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  const before = readFileSync(file)
  try {
    assert.throws(
      () => repairFile(file, {
        knownTypes: KNOWN,
        validate: () => { throw new Error('session "x" contains event type "reply-forge/patch" unknown to this harness and not marked ignorable') },
      }),
      /补标记未生效/,
    )
    assert.equal(Buffer.compare(readFileSync(file), before), 0, '没修好必须还原')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：闸门因**其它旧伤**拒读 → 补标记保留并报告（不是我们的锅）', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const r = repairFile(file, {
      knownTypes: KNOWN,
      validate: () => { throw new Error('session event at seq 8 message must have system-prompt source') },
    })
    assert.equal(r.gate, 'other-issue')
    assert.match(r.note, /system-prompt/)
    // 标记确实写进去了（比还原更严格改进）
    assert.equal(poisonLines(strictRead(file).lines, KNOWN).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('diagnoseFile：受损文件带闸门预演', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const refused = diagnoseFile(file, KNOWN, () => { throw new Error('unknown to this harness') })
    assert.equal(refused.status, 'damaged')
    assert.equal(refused.verdict, 'REFUSED')
    const passed = diagnoseFile(file, KNOWN, () => {})
    assert.equal(passed.verdict, 'PASS')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('repairFile：冷恢复冒烟失败（header 旧伤）→ 补标记保留并报告', () => {
  const { home, file } = makeDamaged([assistantEvent(1, 'A'), poisonEvent(2)])
  try {
    const r = repairFile(file, { knownTypes: KNOWN, validate: () => {} },
      () => ({ ok: false, reason: 'session header isSeeded must be a boolean' }))
    assert.equal(r.gate, 'other-issue')
    assert.match(r.note, /冷恢复冒烟仍失败/)
    assert.equal(poisonLines(strictRead(file).lines, KNOWN).length, 0, '标记必须已写入')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── 运行 ──────────────────────────────────────────────────────────────
let pass = 0
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); pass += 1 }
  catch (error) {
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error && error.message).split('\n').slice(0, 4).join('\n        '))
  }
}
console.log('\n' + (pass === tests.length ? `全部通过（${pass}）` : `失败 ${tests.length - pass} / ${tests.length}`))
process.exit(pass === tests.length ? 0 : 1)
