// 记录过期判据的单元测试（tests/record.test.mjs）。
//
// 这个文件专门盯 2026-10-16 真机 bug 的根因：**新会话全程提示「会话记录里没有
// 可定位的助手正文」**。老会话一切正常，新会话必挂——因为 v3.0 给在线模式
// 写了一条「live 永不重读」的捷径（当时的理由是「内存投影没有落盘滞后」），
// 而新会话第一次读到的快照必然是空的：宿主先把回复渲染进 DOM，稍后才把它
// 登记进活会话。空快照被当成终态缓存住，于是永远对不上。
//
// 直接 import 源码而不是构建产物：record.mjs 是纯逻辑（不碰 DOM），
// 单独测比隔着 client.js 快得多，出错也定位得准。
//
// 运行：node tests/record.test.mjs
import assert from 'node:assert/strict'
import { domSignatureOf, recordNeedsRefresh, normalizeText } from '../.dsh-plugin/client/record.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const live = (blocks, extra = {}) => ({ mode: 'live', blocks, error: null, ...extra })
const disk = (blocks, extra = {}) => ({ mode: 'disk', blocks, error: null, ...extra })
const block = text => ({ seq: 100, blockIndex: 1, kind: 'text', text })

// ── domSignatureOf ─────────────────────────────────────────────────────────

test('签名：同一批正文 → 同一签名（可当 === 用）', () => {
  assert.equal(domSignatureOf(['甲', '乙']), domSignatureOf(['甲', '乙']))
})

test('签名：块数不变、正文变了 → 签名必须变（流式输出中途那次读取就靠它）', () => {
  assert.notEqual(domSignatureOf(['甲']), domSignatureOf(['甲 乙']))
})

test('签名：块数变了 → 签名必须变', () => {
  assert.notEqual(domSignatureOf(['甲']), domSignatureOf(['甲', '乙']))
})

test('签名：空白差异视为相同（与写入器指纹同一套归一化）', () => {
  assert.equal(domSignatureOf(['甲  乙\n']), domSignatureOf([' 甲 乙 ']))
})

test('签名：超长正文的尾部变化也要能发现（不能截断掉信息）', () => {
  const head = 'x'.repeat(9000)
  assert.notEqual(domSignatureOf([head + 'A']), domSignatureOf([head + 'B']))
})

test('签名：超长正文的中间变化也要能发现', () => {
  const before = 'a'.repeat(5000) + 'B' + 'c'.repeat(5000)
  const after = 'a'.repeat(5000) + 'D' + 'c'.repeat(5000)
  assert.notEqual(domSignatureOf([before]), domSignatureOf([after]))
})

test('签名：非数组输入降级为空列表签名，不抛', () => {
  assert.equal(domSignatureOf(null), domSignatureOf([]))
  assert.equal(domSignatureOf(undefined), domSignatureOf([]))
})

// ── recordNeedsRefresh：在线 ───────────────────────────────────────────────

test('在线 · 空快照 + 页面有块 → 必须重读（真机 bug 的正身）', () => {
  // v3.0 在这里返回 false：mode==='live' 直接短路，于是新会话永久卡住。
  assert.equal(recordNeedsRefresh(live([]), 1, domSignatureOf(['甲'])), true)
})

test('在线 · 快照与页面签名一致 → 不重读（不能把读记录打成轮询）', () => {
  const sig = domSignatureOf(['甲'])
  assert.equal(recordNeedsRefresh(live([block('甲')], { domSignature: sig }), 1, sig), false)
})

test('在线 · 块数相同但正文变了 → 必须重读（v3.0 漏掉的正是这一条）', () => {
  const before = domSignatureOf(['甲'])
  const after = domSignatureOf(['甲 乙'])
  assert.equal(recordNeedsRefresh(live([block('甲')], { domSignature: before }), 1, after), true)
})

test('在线 · 老缓存没记签名 → 重读一次补上基准', () => {
  assert.equal(recordNeedsRefresh(live([block('甲')]), 1, domSignatureOf(['甲'])), true)
})

test('在线 · 没给签名 → 不重读（调用方没准备好基准时不乱读）', () => {
  assert.equal(recordNeedsRefresh(live([block('甲')], { domSignature: 'x' }), 1, undefined), false)
})

// ── recordNeedsRefresh：落盘 ───────────────────────────────────────────────

test('落盘 · 页面块数多于记录 → 重读（宿主落盘滞后约 200ms）', () => {
  assert.equal(recordNeedsRefresh(disk([block('甲')]), 2, domSignatureOf(['甲', '乙'])), true)
})

test('落盘 · 块数相同 → **不**重读，哪怕正文变了', () => {
  // 这是刻意的：落盘读要解压整个会话文件，流式输出期间每帧都变会把
  // 读记录打成高频请求。正文变化交给「在线」那条路去发现。
  const rec = disk([block('甲')], { domSignature: domSignatureOf(['甲']) })
  assert.equal(recordNeedsRefresh(rec, 1, domSignatureOf(['甲 乙'])), false)
})

test('落盘 · 页面块数少于记录（历史被虚拟化折叠）→ 不重读', () => {
  assert.equal(recordNeedsRefresh(disk([block('甲'), block('乙')]), 1, domSignatureOf(['甲'])), false)
})

// ── recordNeedsRefresh：公共分支 ───────────────────────────────────────────

test('页面一个助手块都没有 → 不重读（没东西可定位）', () => {
  assert.equal(recordNeedsRefresh(null, 0, ''), false)
  assert.equal(recordNeedsRefresh(live([], { domSignature: 'x' }), 0, 'x'), false)
})

test('记录没拉到过 → 重读', () => {
  assert.equal(recordNeedsRefresh(null, 1, domSignatureOf(['甲'])), true)
  assert.equal(recordNeedsRefresh(undefined, 1, domSignatureOf(['甲'])), true)
})

test('读失败 → 重读（新会话「还没落盘」时就是这条，要能自愈）', () => {
  assert.equal(recordNeedsRefresh({ mode: 'disk', blocks: [], error: 'session log not found' }, 1, 'x'), true)
})

test('normalizeText：空白归一（签名与指纹共用）', () => {
  assert.equal(normalizeText(' 甲\n乙 '), '甲 乙')
})

// ── 跑 ─────────────────────────────────────────────────────────────────────

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String((error && error.message) || error))
  }
}
console.log(failed === 0 ? `\n全部通过（${tests.length}）` : `\n失败 ${failed} / ${tests.length}`)
process.exit(failed === 0 ? 0 : 1)
