// 升级自检脚本的纯逻辑单测（tests/verify-host.test.mjs）。
//
// 只测不起宿主的部分：基线加载、版本比对、asar 头解析/文件展开/数据区起点/
// 子树提取、套件输出解析、汇总退出码。宿主契约面（T1）与 boot（T2）由
// scripts/verify-host.mjs 本体在真宿主上跑，不在这里重复。
//
// 运行：node tests/verify-host.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadBaseline, compareVersion, parseAsarHeader, collectAsarFiles, asarDataStart,
  extractAsarFiles, summarize, parseSuiteOutput, judgeLiveSessionProjectionSource,
} from '../scripts/verify-host.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 造一个最小 asar：16 字节前缀 + JSON 头 + 数据区。 */
function makeAsar(files, data) {
  const tree = { files: {} }
  for (const f of files) {
    let dir = tree.files
    const parts = f.rel.split('/')
    for (const part of parts.slice(0, -1)) {
      dir[part] = dir[part] ?? { files: {} }
      dir = dir[part].files
    }
    dir[parts[parts.length - 1]] = { size: f.size, offset: f.offset }
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  return Buffer.concat([prefix, json, Buffer.from(data, 'utf8')])
}

// ── 1. loadBaseline ────────────────────────────────────────────────────

test('loadBaseline：读仓库内真基线，四段齐全', () => {
  const baseline = loadBaseline(REPO)
  assert.equal(baseline.host.version, '0.2.1-rc.2')
  assert.equal(baseline.host.hostProtocolVersion, 4)
  assert.ok(baseline.packages['@deepseek-ai/dsh-session'])
  assert.ok(baseline.contract.migrationRenamesOpaqueToPrefix === 'plugin:')
  assert.ok(Array.isArray(baseline.hostGatedTestSuites))
  assert.ok(baseline.hostGatedTestSuites.includes('migration-rename'))
})

test('loadBaseline：文件缺失 → 抛，且点名 host-baseline.json', () => {
  const empty = mkdtempSync(join(tmpdir(), 'vh-bl-'))
  try {
    assert.throws(() => loadBaseline(empty), /host-baseline\.json/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('loadBaseline：坏 JSON / 缺段 → 抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-bl-'))
  try {
    writeFileSync(join(dir, 'host-baseline.json'), '{ not json', 'utf8')
    assert.throws(() => loadBaseline(dir), /不是合法 JSON/)
    writeFileSync(join(dir, 'host-baseline.json'), JSON.stringify({ host: {} }), 'utf8')
    assert.throws(() => loadBaseline(dir), /缺少 "packages"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2. compareVersion ──────────────────────────────────────────────────

test('compareVersion：相等 → match', () => {
  const r = compareVersion('0.2.1-rc.2', '0.2.1-rc.2')
  assert.equal(r.status, 'match')
  assert.equal(r.detail, '0.2.1-rc.2')
})

test('compareVersion：不等 → drift，detail 带两边版本', () => {
  const r = compareVersion('0.2.2-rc.1', '0.2.1-rc.2')
  assert.equal(r.status, 'drift')
  assert.ok(r.detail.includes('0.2.2-rc.1'))
  assert.ok(r.detail.includes('0.2.1-rc.2'))
  assert.ok(r.detail.includes('宿主较基线新'))
})

test('compareVersion：宿主较旧 → 反向提示；缺值 → （缺失）', () => {
  assert.ok(compareVersion('0.1.9', '0.2.1').detail.includes('宿主较基线旧'))
  assert.ok(compareVersion(null, '0.2.1').detail.includes('（缺失）'))
})

test('compareVersion：同三元组不同预发布（rc.2 vs rc.3）仍算 drift', () => {
  const r = compareVersion('0.2.1-rc.2', '0.2.1-rc.3')
  assert.equal(r.status, 'drift')
})

// ── 3. asar 头解析与文件展开 ───────────────────────────────────────────

test('parseAsarHeader：合成 asar 定位正确、树可解析', () => {
  const buf = makeAsar([{ rel: 'dsh/a.js', offset: 0, size: 4 }], 'DATA')
  const { jsonStart, tree } = parseAsarHeader(buf)
  assert.equal(jsonStart, 16)
  assert.equal(typeof tree.files, 'object')
})

test('parseAsarHeader：无 JSON 头 / 配平失败 / files 树畸形 → 抛', () => {
  assert.throws(() => parseAsarHeader(Buffer.from('no header here')), /找不到 asar JSON 头/)
  const broken = Buffer.concat([Buffer.alloc(16), Buffer.from('{"files":{"a":', 'utf8')])
  assert.throws(() => parseAsarHeader(broken), /配平失败/)
  const noFiles = Buffer.concat([Buffer.alloc(16), Buffer.from('{"files":null}', 'utf8')])
  assert.throws(() => parseAsarHeader(noFiles), /缺少 files/)
})

test('collectAsarFiles：展开全部条目；prefix 过滤生效', () => {
  const buf = makeAsar([
    { rel: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js', offset: 0, size: 3 },
    { rel: 'dsh/desktop-runtime.json', offset: 3, size: 2 },
    { rel: 'other/x.js', offset: 5, size: 1 },
  ], 'abcde')
  const { tree } = parseAsarHeader(buf)
  const all = collectAsarFiles(tree)
  assert.equal(all.length, 3)
  assert.deepEqual(all[0], { rel: 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js', offset: 0, size: 3 })
  const scoped = collectAsarFiles(tree, 'dsh/node_modules/')
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].rel, 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js')
})

test('asarDataStart：尾差校准 = buf.length - maxEnd', () => {
  const buf = makeAsar([{ rel: 'a', offset: 0, size: 4 }], 'DATA')
  const { tree } = parseAsarHeader(buf)
  const files = collectAsarFiles(tree)
  assert.equal(asarDataStart(buf, files), buf.length - 4)
})

// ── 4. extractAsarFiles（含 --extract 数据区起点回归） ─────────────────

test('extractAsarFiles：全集提取内容逐字节正确', () => {
  const buf = makeAsar([
    { rel: 'dsh/keep.txt', offset: 0, size: 4 },
    { rel: 'dsh/also.txt', offset: 4, size: 4 },
  ], 'AAAACCCC')
  const { tree } = parseAsarHeader(buf)
  const files = collectAsarFiles(tree)
  const out = mkdtempSync(join(tmpdir(), 'vh-ex-'))
  try {
    const n = extractAsarFiles(buf, files, out)
    assert.equal(n, 2)
    assert.equal(readFileSync(join(out, 'dsh', 'keep.txt'), 'utf8'), 'AAAA')
    assert.equal(readFileSync(join(out, 'dsh', 'also.txt'), 'utf8'), 'CCCC')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('extractAsarFiles：提子集必须按全集算 dataStart（回归：整体错位）', () => {
  // 子集（dsh/keep.txt）的 maxEnd 小于全集（other/skip.txt 垫尾），若按子集
  // 算起点，提取内容会整体错位——提出来是别的文件的字节。
  const buf = makeAsar([
    { rel: 'dsh/keep.txt', offset: 0, size: 4 },
    { rel: 'other/skip.txt', offset: 4, size: 4 },
  ], 'AAAABBBB')
  const { tree } = parseAsarHeader(buf)
  const all = collectAsarFiles(tree)
  const subset = all.filter(f => f.rel.startsWith('dsh/'))
  assert.equal(subset.length, 1)
  const correct = asarDataStart(buf, all)
  assert.ok(asarDataStart(buf, subset) > correct, '子集起点确实算大了（bug 场景成立）')
  const out = mkdtempSync(join(tmpdir(), 'vh-ex-'))
  try {
    extractAsarFiles(buf, subset, out, correct)
    assert.equal(readFileSync(join(out, 'dsh', 'keep.txt'), 'utf8'), 'AAAA', '显式全集起点 → 内容正确')
    const out2 = mkdtempSync(join(tmpdir(), 'vh-ex-'))
    try {
      extractAsarFiles(buf, subset, out2) // 不传起点：按子集算（复现 bug）
      assert.notEqual(readFileSync(join(out2, 'dsh', 'keep.txt'), 'utf8'), 'AAAA', '不传起点 → 复现错位')
    } finally {
      rmSync(out2, { recursive: true, force: true })
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('extractAsarFiles：起点异常 → 抛', () => {
  const buf = makeAsar([{ rel: 'a', offset: 0, size: 1 }], 'X')
  const { tree } = parseAsarHeader(buf)
  const files = collectAsarFiles(tree)
  const out = mkdtempSync(join(tmpdir(), 'vh-ex-'))
  try {
    assert.throws(() => extractAsarFiles(buf, files, out, 0), /数据区起点异常/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

// ── 5. parseSuiteOutput ────────────────────────────────────────────────

test('parseSuiteOutput：自建收集器格式计数，明细行不误判', () => {
  const out = [
    '  PASS  第一项',
    '  PASS  第二项',
    '  FAIL  第三项',
    '        assert.ok(landed !== null)   ← 缩进明细，不是标记行',
    '  SKIP  找不到宿主包',
    '',
    '失败 1 / 3',
  ].join('\n')
  const r = parseSuiteOutput(out)
  assert.equal(r.pass, 2)
  assert.equal(r.fail, 1)
  assert.equal(r.skipped, true)
})

test('parseSuiteOutput：TAP 格式也认；全 PASS 无 SKIP', () => {
  const r = parseSuiteOutput('ok 1 - a\nok 2 - b\n# pass 2\n')
  assert.equal(r.pass, 2)
  assert.equal(r.fail, 0)
  assert.equal(r.skipped, false)
})

// ── 6. summarize ───────────────────────────────────────────────────────

test('summarize：计数与退出码（有 FAIL 才 1）', () => {
  assert.deepEqual(
    summarize([{ status: 'PASS' }, { status: 'PASS' }, { status: 'WARN' }]),
    { pass: 2, warn: 1, fail: 0, exitCode: 0 },
  )
  assert.deepEqual(
    summarize([{ status: 'PASS' }, { status: 'FAIL' }]),
    { pass: 1, warn: 0, fail: 1, exitCode: 1 },
  )
  assert.deepEqual(summarize([]), { pass: 0, warn: 0, fail: 0, exitCode: 0 })
})

// ── 活会话投影来源判定（BUG-7 的采信底座护栏） ─────────────────────────
// 冷读路径用硬编码列表是宿主设计（刷新后界面回原文，插件无解）；但活会话
// 一旦也被换成硬编码列表，模型侧就再也不采信伪造，且不报错——这条护栏必须红。

test('活会话投影来源：prepare 传 this.projections → PASS', () => {
  const src = `
    prepare(id, options) {
      return Session.fromRestore(sessionId, options.seed, options.meta, options.inheritedEventCount, eventState, this.projections);
    }`
  const v = judgeLiveSessionProjectionSource(src)
  assert.equal(v.level, 'PASS')
  assert.match(v.detail, /this\.projections/)
})

test('活会话投影来源：改成硬编码 currentSessionMessageProjections → FAIL（核心采信会断）', () => {
  const src = `
    prepare(id, options) {
      return Session.fromRestore(sessionId, options.seed, options.meta, options.inheritedEventCount, eventState, currentSessionMessageProjections);
    }`
  const v = judgeLiveSessionProjectionSource(src)
  assert.equal(v.level, 'FAIL', '活会话一旦用硬编码列表，模型侧不再采信伪造，必须报警')
  assert.match(v.detail, /硬编码|不再采信/)
})

test('活会话投影来源：冷读路径用硬编码列表不算错（宿主设计）', () => {
  // 关键区分：冷读（query / readStoredLog）用硬编码列表只影响**界面显示**，
  // 不影响模型采信。护栏只盯活会话那处调用。
  const src = `
    function readStored(events) {
      return Session.fromRestore(id, events, header, offset, 'detached', currentSessionMessageProjections);
    }
    prepare(id, options) {
      return Session.fromRestore(sessionId, options.seed, options.meta, options.inheritedEventCount, 'detached', this.projections);
    }`
  // 两处调用里有一处是硬编码 → 当前实现按「只要出现就 FAIL」处理。
  // 这是**刻意保守**：宁可让人复核，也不要放过活会话被污染的可能。
  const v = judgeLiveSessionProjectionSource(src)
  assert.equal(v.level, 'FAIL')
})

test('活会话投影来源：源码读不到 / 没有 fromRestore → WARN（交人工，不误报 FAIL）', () => {
  assert.equal(judgeLiveSessionProjectionSource('').level, 'WARN')
  assert.equal(judgeLiveSessionProjectionSource('const x = 1').level, 'WARN')
  const noRegistry = judgeLiveSessionProjectionSource('Session.fromRestore(a, b, c, d, e, somethingElse)')
  assert.equal(noRegistry.level, 'WARN')
})

// ── 运行 ──────────────────────────────────────────────────────────────
let pass = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  PASS  ' + t.name)
    pass += 1
  } catch (error) {
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error && error.message).split('\n').slice(0, 4).join('\n        '))
  }
}
console.log('\n' + (pass === tests.length ? `全部通过（${pass}）` : `失败 ${tests.length - pass} / ${tests.length}`))
process.exit(pass === tests.length ? 0 : 1)
