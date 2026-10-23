// v3→v4 迁移改名回归测试（tests/migration-rename.test.mjs）。
//
// 背景（2026-10-23 宿主漂移实证，PLAN §9.1）：宿主 0.2.1（hostProtocolVersion=4）
// 读 **v3 世代**会话文件时会触发真迁移——`dsh-session-persistence-jsonl` 的解码 →
// `dsh-session-format-v3-to-v4` 的迁移 → v4 准入校验管线。其中
// `namespaceV3OpaqueEvent` 把「未知类型 + `ignorable: true`」的事件改名为
// `plugin:<原类型>` 并**写盘**。我们的 `reply-forge/patch` 正在此列。
//
// 只认旧类型的话，投影（按类型精确匹配）、血统推导、陈旧校验基准全部静默失配
// ——伪造内容退回原文且不报错。本测试在**真宿主 codec** 上钉死四件事：
//   1. 改名实锤：合成 v3 日志跑真迁移，patch 事件变成 plugin:reply-forge/patch；
//   2. 民警回环：迁移后的事件流喂回真 Session 折叠，双类型投影下伪造仍在；
//   3. 修复前行为钉子：只注册旧类型投影 → 迁移后的 patch 静默失效（必须红着，
//      证明这个回归真实存在，而不是我们臆想的）；
//   4. 缺 ignorable 的 patch 事件会让整条日志被迁移拒绝（ignorable shim 的存在
//      理由——没有它，v3 旧日志连迁移这关都过不去）。
//
// 迁移管线与生产路径逐字节一致：`releasedV3SessionFormatCodec` 编码物理行 →
// `createSessionFormatCatalogWithChildren([]).createRestore(header, {recovery,
// validation})` 逐行 decode → `finish()` 得到 v4 artifact。这正是持久化后端
// 读历史文件时走的那条路（见 dsh-session-persistence-jsonl 的 prepareMigration）。
//
// 找不到宿主包时 SKIP（不判失败）：发行包解开在没有 DSH 的机器上跑要能过。
//
// 运行：node tests/migration-rename.test.mjs
//       DSH_APP_ROOT=<DSH安装根> node tests/migration-rename.test.mjs
import assert from 'node:assert/strict'
import { findHostPackage, findHostSessionPackage, toFileUrl } from './host-pkg.mjs'
import { buildPatchData } from '../src/patch-event.mjs'
import { patchProjection, patchProjections } from '../.dsh-plugin/server/patch.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const catalogPkg = findHostPackage('dsh-session-format-catalog')
const v3CodecPkg = findHostPackage('dsh-session-format-v2-to-v3')
const sessionPkg = findHostSessionPackage()
if (catalogPkg === null || v3CodecPkg === null || sessionPkg === null) {
  console.log('  SKIP  找不到宿主 codec 包（dsh-session-format-catalog / dsh-session-format-v2-to-v3 / dsh-session），跳过迁移回归测试')
  console.log('        （设 DSH_APP_ROOT 指向 DSH 安装根可强制启用）\n')
  console.log('全部通过（0 项执行，已跳过）')
  process.exit(0)
}
console.log('  catalog：' + catalogPkg)
console.log('  v3 codec：' + v3CodecPkg + '\n')

const { createSessionFormatCatalogWithChildren } = await import(toFileUrl(catalogPkg))
const { releasedV3SessionFormatCodec } = await import(toFileUrl(v3CodecPkg))
const { Session, SessionId, SessionLogOffset } = await import(toFileUrl(sessionPkg))

const SESSION_ID = 'session-rf3-migration'
const T0 = 1700000000000

/**
 * 合成一个最小但结构完整的 v3 会话事件流：一个回合（turn/start → step/start →
 * user/message → assistant/message → step/end → turn/end）。
 *
 * turn/step 脚手架不是可选的：v4 准入的关系校验（Relationships 状态机）要求
 * assistant/message 必须落在打开的回合/步骤里，缺一个都过不了
 * `restoreReleasedV4Artifact`。助手消息带推理块 + 正文块——patch 的目标。
 */
function v3SessionEvents() {
  return [
    { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T0 + 1, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: T0 + 2, surfaceOp: 'append',
      data: { id: 'm-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] },
    },
    {
      type: 'assistant/message', seq: 3, time: T0 + 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1, stream: [],
        message: {
          id: 'm-a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
          content: [
            { type: 'reasoning', text: '推理原文', signature: 'SIG-1' },
            { type: 'text', text: '正文原文' },
          ],
        },
      },
    },
    { type: 'step/end', seq: 4, time: T0 + 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: T0 + 5, data: { turn: 1 } },
  ]
}

/** v3 世代 header（字段照 assertReleasedV2Header 的要求）。 */
function v3Header() {
  return { version: 3, id: SESSION_ID, createdAt: T0, isSeeded: false, delegationDepth: 0 }
}

/** 追加一条 v3 世代的 patch 事件——在线写入口原样落盘的样子（seq 接在会话体之后）。 */
function v3PatchEvent(seq, text, { ignorable = true } = {}) {
  const event = {
    type: 'reply-forge/patch',
    seq,
    time: T0 + seq,
    data: buildPatchData([{ seq: 3, blockIndex: 1, kind: 'text', text }]),
  }
  if (ignorable) event.ignorable = true
  return event
}

/**
 * 跑真迁移：合成事件流 → v3 codec 编码物理行 → 宿主 catalog 恢复 + 迁移 → v4 artifact。
 * 与生产路径的差别只在「字节来自内存而非磁盘」。
 * @returns {{header: object, events: object[], inheritedEventCount: number}} v4 artifact
 */
function migrateV3ToV4(events) {
  const encodedHeader = releasedV3SessionFormatCodec.encodeHeader(v3Header(), 0)
  const rows = events.map(event => releasedV3SessionFormatCodec.encodeEvent(event))
  const restore = createSessionFormatCatalogWithChildren([]).createRestore(encodedHeader, {
    recovery: 'recoverable',
    validation: 'transformed',
  })
  for (const row of rows) restore.decodeRow(row)
  return restore.finish()
}

/** 把迁移后的 v4 事件流喂回真 Session 折叠，返回模型可见的助手消息。 */
function foldAssistant(artifact, projections) {
  const session = Session.fromRestore(
    SessionId(SESSION_ID),
    artifact.events,
    artifact.header,
    SessionLogOffset(artifact.inheritedEventCount ?? 0),
    'shared-frozen',
    projections,
  )
  return session.deriveMessages().filter(m => m?.role === 'assistant')[0] ?? null
}

/** 取迁移后事件流里的 patch 事件（按 data 形状认，type 正是要断言的）。 */
function patchEventOf(artifact) {
  return artifact.events.find(e => e?.data?.version === 1 && Array.isArray(e.data.targets)) ?? null
}

// ── 1. 改名实锤 ─────────────────────────────────────────────────────────────

test('真迁移：reply-forge/patch 被改名成 plugin:reply-forge/patch（codec 级实锤）', () => {
  const artifact = migrateV3ToV4([...v3SessionEvents(), v3PatchEvent(6, '伪造正文')])
  assert.equal(artifact.header.version, 4, '迁移产物必须是 v4 世代')

  const patch = patchEventOf(artifact)
  assert.equal(patch.type, 'plugin:reply-forge/patch', '未知+ignorable 事件必须被改名')
  assert.equal(patch.ignorable, true, 'ignorable 必须保留（v4 准入靠它）')
  assert.equal(patch.data.targets[0].text, '伪造正文', 'data 一字不动')

  const assistant = artifact.events.find(e => e.type === 'assistant/message')
  assert.equal(assistant.data.message.content[1].text, '正文原文', '会话本体不受迁移影响')
})

// ── 2. 民警回环 ─────────────────────────────────────────────────────────────

test('民警回环：迁移后的事件流 + 双类型投影 → 伪造仍在', () => {
  const artifact = migrateV3ToV4([...v3SessionEvents(), v3PatchEvent(6, '伪造正文')])
  const msg = foldAssistant(artifact, patchProjections)
  assert.equal(msg.content[1].text, '伪造正文', '迁移改名后投影必须仍然命中')
  assert.equal(msg.content[0].text, '推理原文', '推理块不受影响')
})

test('民警回环：迁移后改推理块 → 签名仍被剥掉（迁移不破坏投影的签名纪律）', () => {
  const events = [...v3SessionEvents(), {
    type: 'reply-forge/patch', seq: 6, time: T0 + 6, ignorable: true,
    data: buildPatchData([{ seq: 3, blockIndex: 0, kind: 'reasoning', text: '伪造推理' }]),
  }]
  const artifact = migrateV3ToV4(events)
  const msg = foldAssistant(artifact, patchProjections)
  assert.equal(msg.content[0].text, '伪造推理')
  assert.equal('signature' in msg.content[0], false, '签名对的是原文，改了就必须剥')
})

test('回归钉子：只注册旧类型投影 → 迁移后的 patch 静默失效（修复前行为）', () => {
  // 这条断言的就是修复前的真实缺陷：投影按类型精确匹配，迁移把类型
  // 改成 plugin:reply-forge/patch 之后，只注册了 reply-forge/patch 的投影全部
  // 匹配不上——伪造退回原文，不抛不错，用户毫无感知。修复=读侧双类型接受。
  const artifact = migrateV3ToV4([...v3SessionEvents(), v3PatchEvent(6, '伪造正文')])
  const msg = foldAssistant(artifact, [patchProjection])
  assert.equal(msg.content[1].text, '正文原文', '没有新类型投影时伪造必须退回原文')
})

// ── 3. ignorable 是迁移的通行证 ─────────────────────────────────────────────

test('真迁移：缺 ignorable 的 patch 事件 → 整条日志被拒（shim 的存在理由）', () => {
  // v3→v4 迁移对「未知类型且未标记 ignorable」的事件是硬拒绝
  // （SessionFormatUnsupportedMigrationError）——整条日志都读不了。
  // 我们在线写入口的 ignorable shim 补的正是这个标记。
  assert.throws(
    () => migrateV3ToV4([...v3SessionEvents(), v3PatchEvent(6, 'x', { ignorable: false })]),
    /refus|unknown event type/i,
  )
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
