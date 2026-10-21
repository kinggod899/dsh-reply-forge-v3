// 真宿主持久化闭环测试（tests/persistence.test.mjs）——v3 P0 的正身。
//
// 前面所有测试都停在「Session 层」（内存投影）或「假后端」（钩子行为），
// 唯独这份把整条真链路跑通：
//
//   真 Cordis Context
//     └─ 真 JsonlSessionPersistence 后端（隔离临时 root，zstd，真落盘）
//         └─ 真 SessionStore + 真 Session（prepare → create 写句柄 → enter）
//             └─ 真 session/event 路由 → tracker.writers → enqueueLive
//                 └─ 200ms 批处理 → persistContiguous（被我们的 shim 包住）
//                     └─ storage.persistBatch → session.v4.jsonl.zstd 落盘
//
// 要证明的四件事：
//   1. `ctx.reflect.get('sessionPersistence')` 在**真 Cordis 插件上下文**里
//      确实拿得到后端（移交文档列为未验证项）；
//   2. `verifySessionWriter(sessionId)` 对**真写句柄**核验通过（P0-1 的真机版）；
//   3. patch 事件经真 persistContiguous 落盘后**真的带着 ignorable:true**，
//      真 `validateStoredEvents` 放行；其余事件不被加字段；
//   4. 断开插件（无投影）冷恢复不抛、伪造静默退回原文——且**没装 shim 的
//      对照组成集会真的被宿主闸门拒读**（证明这份测试有区分度，不是橡皮章）。
//
// 全程只用临时目录，**不碰用户真实会话**。找不到宿主包时 SKIP（发行包在
// 没有 DSH 的机器上解开要能过）。
//
// 运行：node tests/persistence.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findHostPackage, findHostSessionPackage, toFileUrl } from './host-pkg.mjs'
import { PATCH_EVENT_TYPE, buildPatchData } from '../src/patch-event.mjs'
import { patchProjection } from '../.dsh-plugin/server/patch.mjs'
import {
  installIgnorableShim, resetIgnorableShim, verifySessionWriter, WRITER_NOT_ROUTED,
} from '../.dsh-plugin/server/ignorable.mjs'
import { readSessionEvents } from '../src/session-log.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ── 宿主包定位（缺任何一件都 SKIP，不判失败）────────────────────────────
const sessionPkg = findHostSessionPackage()
const persistencePkg = findHostPackage('dsh-session-persistence')
const jsonlPkg = findHostPackage('dsh-session-persistence-jsonl')
const cordisPkg = findHostPackage('cordis')

if (sessionPkg === null || persistencePkg === null || jsonlPkg === null || cordisPkg === null) {
  console.log('  SKIP  找不到宿主包（dsh-session / dsh-session-persistence /')
  console.log('        dsh-session-persistence-jsonl / cordis），跳过持久化闭环测试')
  console.log('        （设 DSH_SESSION_PKG 等环境变量可强制启用）')
  console.log('\n全部通过（0 项执行，已跳过）')
  process.exit(0)
}

const { Session, SessionId, SessionStore, SessionLogOffset } = await import(toFileUrl(sessionPkg))
const { validateStoredEvents } = await import(toFileUrl(persistencePkg))
// 导出形状按宿主版本分两种：真宿主（app.asar 提取）是命名导出
// {apply, name, Config, JsonlCompressionSchema}；旧副本是 default 导出。
// 两种都接——Cordis 的 ctx.plugin 认「带 apply 的对象」，整个模块命名空间即可。
// （2026-10-21 首次对真宿主跑本套件时发现的形状差：default 导入拿到 undefined，
//  报「invalid plugin, expect function or object with an "apply" method」。）
const jsonlModule = await import(toFileUrl(jsonlPkg))
const JsonlSessionPersistence = jsonlModule.default ?? jsonlModule
const { Context } = await import(toFileUrl(cordisPkg))
console.log('  宿主包：OK（cordis + jsonl 后端 + session store）\n')

const MODEL = { kind: 'model', provider: 'probe', model: 'probe' }
const SYS = { kind: 'system-prompt' }

/** 造一条助手消息事件（含推理块 + 正文块，仿 projection 测试的形状）。 */
function assistantEventData(text, reasoning = '推理原文') {
  return {
    turn: 1, step: 1, stream: [],
    message: {
      id: 'm-a1', role: 'assistant', source: MODEL,
      content: [
        { type: 'reasoning', text: reasoning, signature: 'SIG-X' },
        { type: 'text', text },
      ],
    },
  }
}

/** 在隔离 root 上装一个最小真 app。withShim=false 是负面对照组。 */
async function makeApp(root, { withShim }) {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  await ctx.plugin(SessionStore)
  if (withShim) {
    // 复刻本插件 index.mjs 的关键动作：注册投影 + 装 ignorable shim。
    // 这里的 ctx 就是「真 Cordis 插件上下文」——reflect 可达性由它验证。
    // 先 reset：同一进程里连续起多个 app 时，模块级 shim 状态还指向上一个
    // （已死的）后端；真实世界里这对应「插件全新加载」（生产的热重载由
    // ensureIgnorableShim 的自愈路径兜底，这里直接建模成干净加载）。
    await ctx.plugin({
      name: '@local/dsh-reply-forge-v3',
      inject: ['sessions'],
      apply(c) {
        resetIgnorableShim()
        c.sessions.registerMessageProjection(patchProjection)
        installIgnorableShim(c)
      },
    })
  }
  return ctx
}

/** 按 agent-loop 的顺序造一个被持久化的会话：prepare → create 写句柄 → enter → announce。 */
async function makePersistedSession(ctx, sessionId, cwd) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const session = sessions.prepare(sessionId, { meta: { cwd } })
  const handle = await persistence.create(session.header)
  sessions.enter(session)
  sessions.announce(session)
  return { session, handle }
}

/** 灌三条基础事件（system/user/assistant），返回 assistant 的 seq。 */
function seedEvents(session) {
  // 注意 turn/step 必须为正：持久化侧的 format catalog 会校验（内存层不校验，
  // 所以 projection 测试里 turn:0/step:0 也能跑——两份测试的形状差异就在这里）。
  session.append('system/message', { turn: 1, step: 1, message: { id: 'm-sys', role: 'system', source: SYS, content: [{ type: 'text', text: 'SYS' }] } }, { surfaceOp: 'append' })
  session.append('user/message', { id: 'm-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }, { surfaceOp: 'append' })
  const a = session.append('assistant/message', assistantEventData('正文原文'), { surfaceOp: 'append' })
  return a.seq
}

/** 轮询等会话文件出现且 patch 事件落盘（宿主懒物化 + 200ms 批处理，给足余量）。 */
async function waitForPatchOnDisk(root, sessionId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const file = findLogUnder(root, sessionId)
    if (file !== null) {
      const events = readSessionEvents(file)
      if (events.some(e => e?.type === PATCH_EVENT_TYPE)) return { file, events }
    }
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

/** 在 root 下找会话日志文件（cwd 编码后的目录结构不预测，直接扫）。 */
function findLogUnder(root, sessionId) {
  const hits = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session\.v\d+\.jsonl\.zstd$/i.test(e.name) && p.toLowerCase().includes(sessionId.toLowerCase())) hits.push(p)
    }
  }
  walk(root)
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return hits[0] ?? null
}

/** 把磁盘行拆成 header + events（第一行是会话头）。 */
function splitRows(rows) {
  const header = { ...rows[0] }
  delete header.type
  return { header, events: rows.slice(1) }
}

/** 建一个隔离 root，返回 root 与一个合法 cwd。 */
function makeHome(label) {
  const home = mkdtempSync(path.join(tmpdir(), 'rf3-persist-' + label + '-'))
  const cwd = path.join(home, 'workspace')
  mkdirSync(cwd, { recursive: true })
  return { home, cwd, root: path.join(home, 'sessions') }
}

// ── 1. 真机可达性与每会话核验 ──────────────────────────────────────────

test('真 Cordis 上下文：ctx.reflect.get 拿得到 JSONL 后端，且 verifySessionWriter 核验通过', async () => {
  const { home, cwd, root } = makeHome('reach')
  const ctx = await makeApp(root, { withShim: true })
  try {
    const persistence = ctx.get('sessionPersistence')
    assert.ok(persistence !== undefined, 'sessionPersistence 服务必须可达')
    assert.equal(persistence.name, 'session-persistence-jsonl', '拿到的必须是 JSONL 后端')

    const { session, handle } = await makePersistedSession(ctx, 'session-rf3-reach-1', cwd)
    assert.ok(handle !== undefined && handle.access === 'write', 'create 必须返回写句柄')

    // 这就是 P0-1 的真机形态：真 tracker + 真句柄 + 真 brand
    const v = verifySessionWriter(session.id)
    assert.equal(v.ok, true, JSON.stringify(v))

    // 不存在的会话：没被路由（而不是假成功）
    const ghost = verifySessionWriter('session-rf3-ghost')
    assert.equal(ghost.ok, false)
    assert.equal(ghost.code, WRITER_NOT_ROUTED)
    void session
  } finally {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 2. 正主：真落盘 + 真闸门 ───────────────────────────────────────────

test('真链路：shim 装上后，patch 事件落盘**带着** ignorable:true，宿主闸门放行', async () => {
  const { home, cwd, root } = makeHome('stamp')
  const ctx = await makeApp(root, { withShim: true })
  let file = null
  try {
    const { session } = await makePersistedSession(ctx, 'session-rf3-stamp-1', cwd)
    const assistantSeq = seedEvents(session)
    session.append(PATCH_EVENT_TYPE, buildPatchData([
      { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
    ]))

    // 先让批处理定时器把事件 rout 到 persistContiguous，再确认落盘
    const landed = await waitForPatchOnDisk(root, 'session-rf3-stamp-1')
    assert.ok(landed !== null, 'patch 事件必须在超时前落盘（200ms 批处理）')
    const file = landed.file

    const rows = landed.events

    const { header, events } = splitRows(rows)
    const patches = events.filter(e => e?.type === PATCH_EVENT_TYPE)
    assert.ok(patches.length >= 1, '落盘事件里必须有一条 patch')
    for (const p of patches) {
      assert.equal(p.ignorable, true, '落盘的 patch 事件必须带 ignorable:true——这就是 P0 的修复本体')
    }
    // 别家事件一字不加（宿主 decode 允许 ignorable，但没理由给别人的事件加）
    for (const e of events) {
      if (e?.type === PATCH_EVENT_TYPE) continue
      assert.equal(e.ignorable, undefined, '非 patch 事件不得被加 ignorable')
    }
    // seq 连续、事件数不变（我们只加字段，别的不动）
    events.forEach((e, i) => assert.equal(e.seq, i, 'seq 必须连续'))

    // 真宿主闸门：必须放行（不带标记的话这里会抛「unknown to this harness」）
    assert.doesNotThrow(() => validateStoredEvents(header, events, { kind: 'jsonl', path: file }))
  } finally {
    await ctx.fiber.dispose()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 3. 冷启动：插件缺席时不抛、退回原文 ────────────────────────────────

test('真链路：落盘后无投影冷恢复 → 不抛，伪造静默退回原文', async () => {
  const { home, cwd, root } = makeHome('cold')
  const ctx = await makeApp(root, { withShim: true })
  try {
    const { session } = await makePersistedSession(ctx, 'session-rf3-cold-1', cwd)
    const assistantSeq = seedEvents(session)
    session.append(PATCH_EVENT_TYPE, buildPatchData([
      { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
    ]))
    const file = findLogUnder(root, 'session-rf3-cold-1')
    const landed = await waitForPatchOnDisk(root, 'session-rf3-cold-1')
    assert.ok(landed !== null)
    void file
    const rows = landed.events

    // 重启等价物：用磁盘行做一次「没有投影」的全量回放
    const { header, events } = splitRows(rows)
    const bare = Session.fromRestore(SessionId(session.id), events, header, SessionLogOffset(0), 'shared-frozen', [])
    const assistant = bare.deriveMessages().filter(m => m?.role === 'assistant')[0]
    assert.ok(assistant !== undefined, '冷恢复必须能折叠出助手消息')
    assert.equal(assistant.content[1].text, '正文原文', '插件缺席时伪造必须静默失效（退回原文）')

    // 有投影的冷恢复：伪造仍在
    const withProj = Session.fromRestore(SessionId(session.id), events, header, SessionLogOffset(0), 'shared-frozen', [patchProjection])
    const forged = withProj.deriveMessages().filter(m => m?.role === 'assistant')[0]
    assert.equal(forged.content[1].text, '伪造正文', '有投影时冷恢复必须重现伪造')
  } finally {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 4. 负面对照：没装 shim → 宿主真的拒读（证明测试有区分度）────────────

test('负面对照：**不装** shim 的同款写入 → 落盘缺 ignorable，宿主闸门拒读整条日志', async () => {
  const { home, cwd, root } = makeHome('neg')
  resetIgnorableShim()
  const ctx = await makeApp(root, { withShim: false })
  try {
    const { session } = await makePersistedSession(ctx, 'session-rf3-neg-1', cwd)
    const assistantSeq = seedEvents(session)
    session.append(PATCH_EVENT_TYPE, buildPatchData([
      { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
    ]))
    const landed = await waitForPatchOnDisk(root, 'session-rf3-neg-1')
    assert.ok(landed !== null, '对照组也必须能落盘（webServer 无关，路由照样走）')
    const file = landed.file

    const { header, events } = splitRows(landed.events)
    const patch = events.find(e => e?.type === PATCH_EVENT_TYPE)
    assert.ok(patch !== undefined)
    assert.equal(patch.ignorable, undefined, '对照组不该有标记（没装 shim）')

    // 宿主 fail-closed：整条日志被拒——这正是那个真实受损会话的翻版
    assert.throws(
      () => validateStoredEvents(header, events, { kind: 'jsonl', path: file }),
      /reply-forge\/patch|unknown to this harness/,
    )
  } finally {
    resetIgnorableShim()
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 5. 补标记即可救回（受损会话修复工具的验证依据）─────────────────────

test('修复路径：给对照组的缺标记事件补 ignorable:true → 同一条闸门放行', async () => {
  const { home, cwd, root } = makeHome('fix')
  resetIgnorableShim()
  const ctx = await makeApp(root, { withShim: false })
  try {
    const { session } = await makePersistedSession(ctx, 'session-rf3-fix-1', cwd)
    const assistantSeq = seedEvents(session)
    session.append(PATCH_EVENT_TYPE, buildPatchData([
      { seq: assistantSeq, blockIndex: 1, kind: 'text', text: '伪造正文' },
    ]))
    const landed = await waitForPatchOnDisk(root, 'session-rf3-fix-1')
    assert.ok(landed !== null)
    const file = landed.file

    const { header, events } = splitRows(landed.events)
    const repaired = events.map(e => (e?.type === PATCH_EVENT_TYPE ? { ...e, ignorable: true } : e))
    assert.doesNotThrow(() => validateStoredEvents(header, repaired, { kind: 'jsonl', path: file }))
  } finally {
    resetIgnorableShim()
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 运行 ──────────────────────────────────────────────────────────────
let pass = 0
for (const t of tests) {
  try { await t.fn(); console.log('  PASS  ' + t.name); pass += 1 }
  catch (error) {
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error && error.message).split('\n').slice(0, 6).join('\n        '))
  }
}
console.log('\n' + (pass === tests.length ? `全部通过（${pass}）` : `失败 ${tests.length - pass} / ${tests.length}`))
process.exit(pass === tests.length ? 0 : 1)
