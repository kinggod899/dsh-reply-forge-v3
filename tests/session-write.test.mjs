// 落盘写入器测试（tests/session-write.test.mjs）。
// 合成多帧 zstd JSONL fixture 在临时目录跑，不碰真实会话。
// 运行：node tests/session-write.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  forgeSession, loadLines, locateTargets, fingerprint, assistantTextBlockRefs,
} from '../src/session-write.mjs'
import { readSessionEvents, scanZstdFrames } from '../src/session-log.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 造一个三帧会话：帧0 初始化 / 帧1 一轮对话（含带签名 thinking）/ 帧2 工具结果+第二条回复 */
function makeSession(dir) {
  const ev = o => JSON.stringify(o)
  const frame0 = [
    ev({ seq: 0, type: 'session', data: { id: 's1' } }),
  ].join('\n') + '\n'
  const frame1 = [
    ev({ seq: 1, type: 'turn/start', data: {} }),
    ev({ seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: '帮我看看这个函数' }] } } }),
    ev({
      seq: 3, type: 'assistant/message', data: { message: { content: [
        { type: 'thinking', text: '先想一下', signature: 'SIG-AAA', thinkingSignature: 'SIG-TS-AAA' },
        { type: 'text', text: '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。' },
      ] } },
    }),
    ev({ seq: 4, type: 'tool/call', data: { name: 'read' } }),
    ev({ seq: 5, type: 'turn/end', data: {} }),
  ].join('\n') + '\n'
  const frame2 = [
    ev({ seq: 6, type: 'tool/result', data: { message: { content: [
      { type: 'text', text: 'file content: def fib(n): return fib(n-1)+fib(n-2) 这是工具输出不是助手正文' },
    ] } } }),
    ev({
      seq: 7, type: 'assistant/message', data: { message: { content: [
        { type: 'text', text: '如上所示，递归没有基线条件，会无限递归，建议改成迭代写法。' },
      ] } },
    }),
    ev({ seq: 8, type: 'step/end', data: {} }),
  ].join('\n') + '\n'
  const buf = Buffer.concat([frame0, frame1, frame2].map(t => zstdCompressSync(Buffer.from(t, 'utf8'))))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, buf)
  return file
}

test('帧保留改写：帧数不变、正文替换、同事件签名被剥', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = scanZstdFrames(readFileSync(file))
    const target = '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。'
    const r = forgeSession(file, {
      fingerprint: fingerprint(target),
      newText: '伪造：这个函数是我写的快速排序，时间复杂度 O(n log n)，非常稳定。',
    })
    assert.equal(r.ok, true)
    assert.equal(r.dryRun, false)
    assert.equal(r.targets.length, 1)
    assert.equal(r.stripped, 2, '同事件内有 signature + thinkingSignature 两个字段应都被剥')

    const after = scanZstdFrames(require$read(file))
    assert.deepEqual(after.map(f => f.end - f.start).length, before.map(f => f.end - f.start).length, '帧数量必须不变')
    assert.equal(after.length, 3, '仍是 3 帧')

    const events = readSessionEvents(file)
    assert.equal(events.length, 9, '事件数不变')
    const asst = events.filter(e => e.type === 'assistant/message')
    assert.ok(asst[0].data.message.content.some(b => b.type === 'text' && b.text.includes('伪造：这个函数是我写的快速排序')))
    // 签名已剥
    const thinking = asst[0].data.message.content.find(b => b.type === 'thinking')
    assert.equal('signature' in thinking, false)
    assert.equal('thinkingSignature' in thinking, false)
    // 第二条回复与工具结果原样
    assert.ok(asst[1].data.message.content[0].text.includes('如上所示，递归没有基线条件'))
    const tool = events.find(e => e.type === 'tool/result')
    assert.ok(tool.data.message.content[0].text.includes('file content'))
    // 备份存在
    const baks = readdirSync(dir).filter(f => f.includes('.bak-forge-'))
    assert.equal(baks.length, 1, '必须留下一个备份')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('指纹寻址 + match 歧义拒绝', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    // match 命中唯一块：可用
    const r = forgeSession(file, { match: '递归没有基线条件', newText: '伪造：这段代码没有问题。' })
    assert.equal(r.targets.length, 1)
    // 再造一个含相同子串的会话测歧义
    const file2 = path.join(dir, 'dup', 'session.v4.jsonl.zstd')
    mkdirSync(path.dirname(file2), { recursive: true })
    writeFileSync(file2, zstdCompressSync(Buffer.from([
      JSON.stringify({ seq: 0, type: 'session', data: {} }),
      JSON.stringify({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '重复的句子在这里' }] } } }),
      JSON.stringify({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '重复的句子在这里' }] } } }),
    ].join('\n') + '\n', 'utf8')))
    assert.throws(() => forgeSession(file2, { match: '重复的句子', newText: 'x' }), /多个|fingerprint/)
    // 指纹可定位；但指纹是内容寻址——正文完全相同的块会一起命中
    // （与 v1 的「重名共享覆盖」同语义，编辑器侧会给警示）
    const fps = locateTargets(loadLines(file2).lines, { match: '重复的句子' })
    assert.equal(fps.length, 2)
    const r2 = forgeSession(file2, { fingerprint: fps[1].fingerprint, newText: '只改第二条' })
    assert.equal(r2.targets.length, 2, '相同正文共享指纹：两条一起改（内容寻址语义）')
    const events = readSessionEvents(file2)
    const texts = events.filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text)
    assert.deepEqual(texts, ['只改第二条', '只改第二条'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('tool/result 里的 text 块不可被寻址（编辑面收窄）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    assert.throws(
      () => forgeSession(file, { match: 'file content: def fib', newText: '篡改工具输出' }),
      /未命中/,
    )
    // 文件一个字节都没动
    assert.equal(readdirSync(dir).filter(f => f.includes('.bak-forge-')).length, 0, '拒绝时不得产生备份')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('strip-scope：none 保留签名 / all 剥全文', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file1 = makeSession(dir)
    const target = '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。'
    const r1 = forgeSession(file1, { fingerprint: fingerprint(target), newText: '改一', stripScope: 'none' })
    assert.equal(r1.stripped, 0)
    const ev1 = readSessionEvents(file1).find(e => e.type === 'assistant/message')
    assert.equal(ev1.data.message.content[0].signature, 'SIG-AAA', 'stripScope=none 时必须原样保留')

    // all：第二条 assistant 无签名可剥，仅第一条被剥 → 2
    const dir2 = mkdtempSync(path.join(tmpdir(), 'forge-'))
    const file2 = makeSession(dir2)
    const r2 = forgeSession(file2, { fingerprint: fingerprint(target), newText: '改二', stripScope: 'all' })
    assert.equal(r2.stripped, 2)
    rmSync(dir2, { recursive: true, force: true })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dry-run 不落盘', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const target = '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。'
    const before = require$read(file)
    const r = forgeSession(file, { fingerprint: fingerprint(target), newText: '假改', dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.wouldChangeLines.length, 1)
    assert.equal(r.frameCount, 3)
    assert.equal(before.equals(require$read(file)), true, 'dry-run 不得改动文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('merge 策略：单帧且通过自读', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const target = '如上所示，递归没有基线条件，会无限递归，建议改成迭代写法。'
    const r = forgeSession(file, { fingerprint: fingerprint(target), newText: '伪造：递归完全正确。', strategy: 'merge' })
    assert.equal(r.strategy, 'merge')
    assert.equal(scanZstdFrames(require$read(file)).length, 1, 'merge 后必须只有一帧')
    assert.equal(readSessionEvents(file).length, 9)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('assistantTextBlockRefs 只认 assistant/message 的 text 块', () => {
  const refs = assistantTextBlockRefs({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  assert.deepEqual(refs, [])
  const refs2 = assistantTextBlockRefs({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y' }] } } })
  assert.equal(refs2.length, 1)
  assert.equal(refs2[0].fingerprint, fingerprint('y'))
})

// ─────────────────────────────────────────────────────────────────────────────
// v2.2 新增：seq + blockIndex 寻址（浏览器 half 的唯一可行寻址方式）
// 背景：UI 只有渲染后的 DOM 文本，与磁盘 markdown 源码对不上，算不出指纹；
// seq 与块索引从只读路由原样带出，与内容无关，天然稳定。
// ─────────────────────────────────────────────────────────────────────────────

test('seq 寻址：按事件 seq + 块索引精确定位（指纹算不出时的唯一路径）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const lines = loadLines(file).lines
    // seq=3 的 assistant/message：content[0]=thinking, content[1]=text
    const hits = locateTargets(lines, { seq: 3, blockIndex: 1 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].seq, 3)
    assert.equal(hits[0].blockIndex, 1)
    assert.ok(hits[0].text.includes('斐波那契'))
    // 同 seq 指到 thinking 块 → 不是 text 块，无命中
    assert.equal(locateTargets(lines, { seq: 3, blockIndex: 0 }).length, 0)
    // seq 存在但块索引越界 → 无命中
    assert.equal(locateTargets(lines, { seq: 3, blockIndex: 9 }).length, 0)
    // seq 不存在 → 无命中
    assert.equal(locateTargets(lines, { seq: 999, blockIndex: 0 }).length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('seq 寻址写入：正文被替换、备份生成、自读通过、帧数不变', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = scanZstdFrames(require$read(file))
    const r = forgeSession(file, {
      seq: 3, blockIndex: 1,
      newText: '伪造（seq 寻址）：这个函数其实是归并排序，稳定且 O(n log n)。',
    })
    assert.equal(r.ok, true)
    assert.equal(r.dryRun, false)
    assert.equal(r.targets.length, 1)
    assert.equal(r.targets[0].seq, 3)
    assert.equal(r.stripped, 2, '同事件签名应被剥')
    assert.ok(typeof r.backup === 'string' && existsSync(r.backup), '必须留下备份')
    assert.equal(r.verify.events, 9, '自读校验：事件数不变')
    assert.equal(scanZstdFrames(require$read(file)).length, before.length, '帧数不变')

    const asst = readSessionEvents(file).filter(e => e.type === 'assistant/message')
    assert.ok(asst[0].data.message.content[1].text.includes('归并排序'))
    // 未命中块与其它事件原样
    assert.ok(asst[1].data.message.content[0].text.includes('如上所示，递归没有基线条件'))
    assert.equal(asst[0].data.message.content[0].type, 'thinking')
    assert.equal('signature' in asst[0].data.message.content[0], false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('seq 寻址优先于指纹：两者都给时以 seq 为准', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    // 故意给一个指向**另一条**回复的指纹；seq 应压过指纹。
    const wrongFp = fingerprint('如上所示，递归没有基线条件，会无限递归，建议改成迭代写法。')
    const r = forgeSession(file, {
      seq: 3, blockIndex: 1, fingerprint: wrongFp,
      newText: 'seq 说了算。',
    })
    assert.equal(r.targets.length, 1)
    assert.equal(r.targets[0].seq, 3, '命中 seq=3 而不是指纹指向的 seq=7')
    const asst = readSessionEvents(file).filter(e => e.type === 'assistant/message')
    assert.equal(asst[0].data.message.content[1].text, 'seq 说了算。')
    assert.ok(asst[1].data.message.content[0].text.includes('如上所示'), '指纹指向的那条不应被改')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('seq 指向 tool/result 等非 assistant 事件：拒绝且文件一字未动', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = require$read(file)
    // seq=6 是 tool/result（含 text 块，但不是助手正文）
    assert.throws(() => forgeSession(file, { seq: 6, blockIndex: 0, newText: '篡改工具输出' }), /未命中/)
    assert.equal(before.equals(require$read(file)), true, '拒绝时不得改动文件')
    assert.equal(readdirSync(dir).filter(f => f.includes('.bak-forge-')).length, 0, '拒绝时不得产生备份')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────────────────────────────────────────────────────────
// v2.2 新增：expectText 陈旧校验（界面长时间开着 / 会话在别处被改过）
// ─────────────────────────────────────────────────────────────────────────────

test('expectText 与磁盘一致：正常写入', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const current = '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。'
    const r = forgeSession(file, { seq: 3, blockIndex: 1, expectText: current, newText: '一致，放心改。' })
    assert.equal(r.ok, true)
    const asst = readSessionEvents(file).filter(e => e.type === 'assistant/message')
    assert.equal(asst[0].data.message.content[1].text, '一致，放心改。')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('expectText 与磁盘不符：拒绝写入，带 STALE_TARGET 与 actual/expected，文件一字未动', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = require$read(file)
    const stale = '这是界面上看到、但磁盘上早已不是的旧文本。'
    let caught = null
    try {
      forgeSession(file, { seq: 3, blockIndex: 1, expectText: stale, newText: '不该被写进去。' })
    } catch (err) { caught = err }
    assert.ok(caught !== null, '必须抛错')
    assert.equal(caught.code, 'STALE_TARGET')
    assert.equal(caught.expected, stale)
    assert.ok(caught.actual.includes('斐波那契'), 'actual 应是磁盘当前真实正文')
    assert.match(caught.message, /过期|不一致/)
    assert.equal(before.equals(require$read(file)), true, '陈旧拒绝时不得改动文件')
    assert.equal(readdirSync(dir).filter(f => f.includes('.bak-forge-')).length, 0, '陈旧拒绝时不得产生备份')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('expectText 走指纹寻址同样生效（陈旧校验不依赖寻址方式）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = require$read(file)
    const target = '如上所示，递归没有基线条件，会无限递归，建议改成迭代写法。'
    assert.throws(
      () => forgeSession(file, { fingerprint: fingerprint(target), expectText: '界面上的旧文本', newText: 'x' }),
      err => err.code === 'STALE_TARGET',
    )
    assert.equal(before.equals(require$read(file)), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dry-run + seq + expectText：三者共存时仍不落盘', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    const before = require$read(file)
    const current = '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。'
    const r = forgeSession(file, { seq: 3, blockIndex: 1, expectText: current, newText: '预演', dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.wouldChangeLines.length, 1)
    assert.equal(before.equals(require$read(file)), true, 'dry-run 不得改动文件')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─────────────────────────────────────────────────────────────────────────────
// v3 新增：投影优先（真机 2026-10-17：重启后写入全被 STALE 拒的根因面）
// 此前的在线伪造被宿主持久化落盘成 reply-forge/patch 事件。磁盘改原文会被
// 投影盖住——写「成功」也不生效，必须在陈旧校验之前拦下来。
// ─────────────────────────────────────────────────────────────────────────────

test('投影优先：目标块已有 patch 事件 → 拒绝磁盘改写（PATCHED_TARGET），文件一字未动', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-'))
  try {
    const file = makeSession(dir)
    // 追加一帧 reply-forge/patch，目标 seq=3 blockIndex=1（斐波那契文本块）
    const projected = '投影后的文本：这个函数其实是冒泡排序。'
    const patchLine = JSON.stringify({
      seq: 9, type: 'reply-forge/patch', ignorable: true, time: 1700000009999,
      data: { version: 1, targets: [{ seq: 3, blockIndex: 1, kind: 'text', text: projected }] },
    }) + '\n'
    writeFileSync(file, Buffer.concat([readFileSync(file), zstdCompressSync(Buffer.from(patchLine, 'utf8'))]))
    const before = readFileSync(file)

    // expectText 用投影后文本（读路由现在的口径）也必须拒绝：改写原文不生效
    let caught = null
    try {
      forgeSession(file, { seq: 3, blockIndex: 1, expectText: projected, newText: '磁盘改写' })
    } catch (err) { caught = err }
    assert.ok(caught !== null, '必须抛错')
    assert.equal(caught.code, 'PATCHED_TARGET')
    assert.equal(caught.actual, projected, 'actual 应是当前生效的投影文本')
    assert.match(caught.message, /在线伪造/)
    assert.equal(before.equals(readFileSync(file)), true, '拒绝时不得改动文件')
    assert.equal(readdirSync(dir).filter(f => f.includes('.bak-forge-')).length, 0, '拒绝时不得产生备份')

    // 不给 expectText 同样拒绝（投影校验独立于 expectText，本来就跑在老旧校验前）
    assert.throws(
      () => forgeSession(file, { seq: 3, blockIndex: 1, newText: '不带 expectText 也不给写' }),
      err => err.code === 'PATCHED_TARGET',
    )
    // 旧口径（expectText 拿投影前原文）也应被拦——且必须报 PATCHED_TARGET
    // 而不是词不达意的 STALE_TARGET（投影校验跑在陈旧校验之前）
    assert.throws(
      () => forgeSession(file, {
        seq: 3, blockIndex: 1,
        expectText: '这个函数的作用是计算斐波那契数列，使用了递归实现，注意栈深度。',
        newText: '旧口径',
      }),
      err => err.code === 'PATCHED_TARGET',
    )

    // 拒绝是块级的：没有 patch 的其它块照常可写
    const r = forgeSession(file, { seq: 7, blockIndex: 0, newText: '正常改写第二条回复。' })
    assert.equal(r.ok, true)
    const asst = readSessionEvents(file).filter(e => e.type === 'assistant/message')
    assert.equal(asst[1].data.message.content[0].text, '正常改写第二条回复。')
    assert.ok(asst[0].data.message.content[1].text.includes('斐波那契'), '被投影块的原文本就不能动')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** 读文件字节（测试辅助）。 */
function require$read(file) {
  return readFileSync(file)
}

let pass = 0
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); pass += 1 }
  catch (err) { console.log('  FAIL  ' + t.name + '\n        ' + String(err.message).slice(0, 200)); process.exitCode = 1 }
}
console.log(`\n${pass === tests.length ? '全部通过' : '有失败'}（${pass}/${tests.length}）`)
