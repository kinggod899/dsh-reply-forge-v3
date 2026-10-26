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
import { domSignatureOf, recordNeedsRefresh, normalizeText, matchBlocks } from '../.dsh-plugin/client/record.mjs'
import { loadLineage, versionLabelOf, lineagePreview } from '../.dsh-plugin/client/lineage.mjs'

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

// ── matchBlocks 的规范化口径（2026-10-23 真机）─────────────────────────────
//
// 记录里是 markdown 源码，页面 DOM 里是渲染结果。不带 canonical 直接比字符串，
// 只要回复用了任何行内格式就永远对不上 → 精确匹配形同虚设 → 全部退化成
// 「按顺序推断」，页面少渲染一条就整条链错位（长回复的写入打到别的块上）。

test('matchBlocks：源码 vs 渲染结果直接比 → 只能退化成顺序推断（旧行为的病灶）', () => {
  const out = matchBlocks([{ seq: 46, blockIndex: 0, kind: 'text', text: '这类内容**不会**挂出来' }], ['这类内容不会挂出来'])
  assert.equal(out[0].exact, false, '不规范化时只能靠「末尾对齐」猜位置，不能标成精确匹配')
})

test('matchBlocks：给了 canonical → 源码与渲染结果算精确匹配', () => {
  const strip = t => t.replace(/\*\*/g, '')
  const out = matchBlocks([{ seq: 46, blockIndex: 0, kind: 'text', text: '这类内容**不会**挂出来' }], ['这类内容不会挂出来'], { canonical: strip })
  assert.equal(out[0].seq, 46)
  assert.equal(out[0].exact, true)
})

test('matchBlocks：canonical 渲染不出内容时退回源码比较（不能判成空串全等）', () => {
  const same = matchBlocks([{ seq: 7, blockIndex: 0, kind: 'text', text: '原文在此' }], ['原文在此'], { canonical: () => '' })
  assert.equal(same[0].seq, 7, '退回源码后仍应匹配')
  assert.equal(same[0].exact, true)
  const other = matchBlocks([{ seq: 7, blockIndex: 0, kind: 'text', text: '原文在此' }], ['别的内容'], { canonical: () => '' })
  assert.equal(other[0].exact, false, '退回源码不等于「什么都能配上」')
})

test('matchBlocks：源码形态也入索引（思维链这类纯文本块不能被规范化误伤）', () => {
  const strip = t => t.replace(/^- /gm, '')
  const blocks = [{ seq: 3, blockIndex: 0, kind: 'reasoning', text: '- 先看用户诉求\n- 再看边界' }]
  const out = matchBlocks(blocks, ['- 先看用户诉求 - 再看边界'], { canonical: strip })
  assert.equal(out[0].seq, 3)
  assert.equal(out[0].exact, true, '页面按纯文本渲染时，源码形态必须命中')
})

test('matchBlocks：同一个块不会被两个 DOM 块各认领一次', () => {
  const strip = t => t.replace(/\*\*/g, '')
  const blocks = [{ seq: 9, blockIndex: 0, kind: 'text', text: '**甲**' }]
  const out = matchBlocks(blocks, ['甲', '甲'], { canonical: strip })
  assert.equal(out[0].seq, 9)
  assert.equal(out[1], null, '第二个「甲」没有对应的记录块，不能复用同一个 seq')
})

test('matchBlocks：规范化后同文本多条仍按出现顺序一一对应', () => {
  const strip = t => t.replace(/\*\*/g, '')
  const blocks = [
    { seq: 1, blockIndex: 0, kind: 'text', text: '**甲**' },
    { seq: 2, blockIndex: 0, kind: 'text', text: '甲' },
  ]
  const out = matchBlocks(blocks, ['甲', '甲'], { canonical: strip })
  assert.deepEqual(out.map(m => m.seq), [1, 2])
  assert.deepEqual(out.map(m => m.exact), [true, true])
})

// ── rawText 也入索引（2026-10-26 BUG-8 真机）───────────────────────────────
//
// 读路由给的 `text` 是**投影后**文本，宿主 UI 不渲染投影 → 被伪造过的块在页面
// 上显示的是**原文**。只拿 text 建索引，它就永远精确匹配不上，只能落到「末尾
// 对齐」兜底；新消息一进来，新消息的块被兜底配到这条旧块上，于是新消息显示
// 上一条的伪造内容、还挂着「还原」按钮（真机：session-7806f695）。

test('matchBlocks：rawText（未投影原文）也入索引 → 被伪造的块凭原文精确对回自己', () => {
  const strip = t => t.replace(/\*\*/g, '')
  // 记录：投影后是「1」，磁盘原文是那段长回复；页面上宿主显示的是原文
  const blocks = [{ seq: 46, blockIndex: 0, kind: 'text', text: '1', rawText: '这类内容**不会**挂出来' }]
  const out = matchBlocks(blocks, ['这类内容不会挂出来'], { canonical: strip })
  assert.equal(out[0].seq, 46, '必须凭 rawText 命中自己')
  assert.equal(out[0].exact, true, '原文命中同样是精确匹配，不是推断')
})

test('matchBlocks：rawText 命中后，新消息不再被兜底错配到旧块', () => {
  const strip = t => t.replace(/\*\*/g, '')
  const blocks = [{ seq: 46, blockIndex: 0, kind: 'text', text: '1', rawText: '原来那段长回复内容' }]
  // 页面上两条：上一条（原文）+ 新生成的一条（记录里还没有）
  const out = matchBlocks(blocks, ['原来那段长回复内容', '后来新生成的一条回复'], { canonical: strip })
  assert.equal(out[0].seq, 46)
  assert.equal(out[0].exact, true)
  assert.equal(out[1], null, '新消息必须留空，绝不能被末尾对齐配到旧块上')
})

test('matchBlocks：text 与 rawText 都不同 → 仍退回末尾对齐（不假装精确）', () => {
  const blocks = [{ seq: 5, blockIndex: 0, kind: 'text', text: '投影后的内容', rawText: '磁盘原文' }]
  const out = matchBlocks(blocks, ['页面上完全另一段内容'], { canonical: t => t })
  assert.equal(out[0].seq, 5, '兜底仍然配对（写入/展示要靠它）')
  assert.equal(out[0].exact, false, '但必须标成推断，覆盖键不许用它')
})

// ── v3.4 血统访问层（client/lineage.mjs）────────────────────────────────────

test('versionLabelOf：原稿 / vN / 当前标记', () => {
  assert.equal(versionLabelOf(0, 0), '原稿 · 当前')
  assert.equal(versionLabelOf(0, 2), '原稿')
  assert.equal(versionLabelOf(1, 2), 'v1')
  assert.equal(versionLabelOf(2, 2), 'v2 · 当前')
})

test('lineagePreview：压平空白 + 截断', () => {
  assert.equal(lineagePreview(' 甲\n\n乙 '), '甲 乙')
  assert.equal(lineagePreview('一二三四五', 3), '一二三…')
  assert.equal(lineagePreview('', 10), '')
  assert.equal(lineagePreview(null, 10), '')
})

/** fetch 桩：按 URL 回放给定 payload（可抛）。 */
function stubFetch(payload, { throws = false } = {}) {
  const seen = []
  globalThis.fetch = (url) => {
    seen.push(String(url))
    if (throws) return Promise.reject(new Error('网络断了'))
    return Promise.resolve({ status: 200, json: () => Promise.resolve(payload) })
  }
  return seen
}

test('loadLineage：成功 → 透出 versions / currentIndex / kind', async () => {
  const payload = {
    ok: true, kind: 'reasoning', currentIndex: 1,
    versions: [
      { index: 0, source: 'original', text: '原稿', eventSeq: null },
      { index: 1, source: 'patch', text: '改', eventSeq: 42 },
    ],
  }
  const seen = stubFetch(payload)
  const res = await loadLineage('sess/1', 7, 2, 'reasoning')
  assert.equal(res.ok, true)
  assert.equal(res.kind, 'reasoning')
  assert.equal(res.currentIndex, 1)
  assert.equal(res.versions.length, 2)
  assert.ok(seen[0].includes('sessionId=sess%2F1'), 'sessionId 必须编码，实际：' + seen[0])
  assert.ok(seen[0].includes('seq=7'), '实际：' + seen[0])
  assert.ok(seen[0].includes('blockIndex=2'), '实际：' + seen[0])
  assert.ok(seen[0].includes('kind=reasoning'), '实际：' + seen[0])
})

test('loadLineage：kind 缺省按 text 请求', async () => {
  const seen = stubFetch({ ok: true, kind: 'text', currentIndex: 0, versions: [] })
  await loadLineage('s', 1, 0)
  assert.ok(seen[0].includes('kind=text'), '实际：' + seen[0])
})

test('loadLineage：业务失败 → ok:false + code 透出（UI 靠它出文案）', async () => {
  stubFetch({ ok: false, code: 'original-not-found', error: '找不到原始事件' })
  const res = await loadLineage('s', 1, 0)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'original-not-found')
  assert.ok(res.error.includes('找不到原始事件'))
})

test('loadLineage：网络异常 → ok:false 带 error，不抛', async () => {
  stubFetch(null, { throws: true })
  const res = await loadLineage('s', 1, 0)
  assert.equal(res.ok, false)
  assert.ok(res.error.includes('网络断了'))
})

// ── 跑 ─────────────────────────────────────────────────────────────────────

let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String((error && error.message) || error))
  }
}
console.log(failed === 0 ? `\n全部通过（${tests.length}）` : `\n失败 ${failed} / ${tests.length}`)
process.exit(failed === 0 ? 0 : 1)
