// ignorable shim 测试（tests/ignorable.test.mjs）——v3 的 P0 回归防线。
//
// 这一份守的是本项目**唯一会写坏用户会话**的路径：
// patch 事件对宿主是未知类型，落盘时缺 `ignorable: true` 会让宿主下次读这个
// 会话时 fail-closed 拒绝整条日志（会话打不开）。三层各测一遍：
//   1. `stampIgnorable` 纯函数的语义边界（只动自家事件、不改入参）；
//   2. shim 能否装到宿主持久化句柄上（含装不上必须如实报「装不上」）；
//   3. `forgeLive` 在装不上时**拒绝写入**（而不是写坏会话）。
// 最后再加一条跑在**真宿主** `validateStoredEvents` 上的闸门对照：不带标记
// 必拒、带上必过。找不到宿主包时 SKIP。
//
// 运行：node tests/ignorable.test.mjs
//       DSH_SESSION_PKG=/path/to/dsh-session node tests/ignorable.test.mjs
import assert from 'node:assert/strict'
import { findHostPackage, findHostSessionPackage, toFileUrl } from './host-pkg.mjs'
import { PATCH_EVENT_TYPE, buildPatchData } from '../src/patch-event.mjs'
import {
  APPEND_UNSAFE, WRITER_NOT_ROUTED, ensureIgnorableShim, ignorableShimState,
  installIgnorableShim, resetIgnorableShim, stampIgnorable, verifySessionWriter,
} from '../.dsh-plugin/server/ignorable.mjs'
import { forgeLive } from '../.dsh-plugin/server/live.mjs'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ── 假宿主：结构照抄真 JsonlBackendTracker / JsonlSessionHandle ──────────
// 只保留 shim/核验依赖到的部分（writers Map / adopt / claimWrite / flushAll /
// persistContiguous / enqueueLive / drainLive / storage），真结构对不对由
// README 里记录的源码行号保证，这里只验 shim 的行为。

/** 造一个假持久化后端（tracker + writers Map）。 */
function fakeBackend() {
  const tracker = {
    openHandles: new Set(),
    writers: new Map(),
    claimWrite() {},
    flushAll() { return Promise.resolve() },
    adopt(handle) {
      this.openHandles.add(handle)
      if (handle.access === 'write') this.writers.set(handle.id, handle)
      return handle
    },
  }
  return { tracker }
}

/** 造一个假 ctx：只实现 reflect.get（shim 的探测入口）。 */
function fakeCtx(backend) {
  return {
    reflect: {
      get(name) { return name === 'sessionPersistence' ? backend : undefined },
    },
  }
}

/** 造一个假写句柄：成员照抄真 JsonlSessionHandle，persistContiguous 收到什么记什么。 */
function fakeHandle(id, access = 'write') {
  const received = []
  return {
    id,
    access,
    received,
    storage: { persistBatch() { return Promise.resolve() } },
    enqueueLive() {},
    drainLive() { return Promise.resolve() },
    persistContiguous(batch) {
      received.push(batch)
      return Promise.resolve()
    },
  }
}

/** 造一条别人的（宿主已知类型）事件。 */
function assistantEvent(seq) {
  return {
    type: 'assistant/message',
    seq,
    time: 1,
    data: {
      message: {
        id: 'm-' + seq, role: 'assistant', source: { kind: 'model' },
        content: [{ type: 'text', text: '正文原文' }],
      },
    },
  }
}

/** 造一条自己的 patch 事件（未标记）。 */
function patchEvent(seq) {
  return { type: PATCH_EVENT_TYPE, seq, time: 2, data: buildPatchData([{ seq: 0, blockIndex: 0, kind: 'text', text: 'x' }]) }
}

// ── 1. stampIgnorable ─────────────────────────────────────────────────

test('stampIgnorable：只给自家类型补标记，别家事件一字不动', () => {
  const foreign = assistantEvent(0)
  const mine = patchEvent(1)
  const out = stampIgnorable([foreign, mine])
  assert.equal(out.length, 2)
  assert.equal(out[0], foreign, '别家事件必须是**同一个对象**（连拷贝都不做）')
  assert.equal(out[1].ignorable, true)
  assert.equal(out[1].type, PATCH_EVENT_TYPE, 'type 不变')
  assert.equal(out[1].seq, 1, 'seq 不变')
  assert.deepEqual(out[1].data, mine.data, 'data 不变')
})

test('stampIgnorable：不改动入参里的对象（batch 已是宿主的深拷贝，仍不就地改）', () => {
  const mine = patchEvent(1)
  const out = stampIgnorable([mine])
  assert.equal(mine.ignorable, undefined, '入参对象不得被就地修改')
  assert.notEqual(out[0], mine)
})

test('stampIgnorable：已标记 / 空批次 / 非数组 → 原样返回同一个值', () => {
  const marked = { ...patchEvent(1), ignorable: true }
  const batch = [marked]
  assert.equal(stampIgnorable(batch), batch, '全部已标记时不得新建数组')
  assert.equal(stampIgnorable([]).length, 0)
  assert.equal(stampIgnorable(null), null)
  assert.equal(stampIgnorable(undefined), undefined)
})

test('stampIgnorable：批里有非对象元素也不炸（宿主理论上不会给，但不赌）', () => {
  const out = stampIgnorable([null, patchEvent(1), 'x'])
  assert.equal(out[0], null)
  assert.equal(out[2], 'x')
  assert.equal(out[1].ignorable, true)
})

// ── 2. 安装 ───────────────────────────────────────────────────────────

test('没有 ctx / 没有持久化服务 → ok:false，且原因说得清', () => {
  resetIgnorableShim()
  const s1 = ensureIgnorableShim()
  assert.equal(s1.ok, false)
  assert.match(s1.reason, /未初始化|拿不到/)

  resetIgnorableShim()
  const s2 = installIgnorableShim({ reflect: { get: () => undefined } })
  assert.equal(s2.ok, false)
  assert.match(s2.reason, /拿不到/)
})

test('后端结构不认识（没有 tracker.writers）→ ok:false，不假装成功', () => {
  resetIgnorableShim()
  const s = installIgnorableShim(fakeCtx({ tracker: {} }))
  assert.equal(s.ok, false)
  assert.match(s.reason, /结构不认识/)
})

test('tracker 缺成员（宿主升级改结构）→ ok:false，fail-closed', () => {
  resetIgnorableShim()
  const backend = { tracker: { writers: new Map() } }  // 有 Map 但没 adopt/claimWrite/flushAll
  const s = installIgnorableShim(fakeCtx(backend))
  assert.equal(s.ok, false)
  assert.match(s.reason, /结构不认识/)
})

test('正常安装：挂上 tracker.adopt 与 writers.set，并包住已有句柄', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const existing = fakeHandle('s-old')
  backend.tracker.writers.set('s-old', existing)   // 插件加载前就开着的会话

  const s = installIgnorableShim(fakeCtx(backend))
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.equal(s.handles, 1, '已有写句柄要被就地包住')
  assert.deepEqual(s.hooks.sort(), ['tracker.adopt', 'writers.set'])
  assert.equal(ignorableShimState().ok, true)
})

test('安装后新开的句柄（走 tracker.adopt）也会被包住', async () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  installIgnorableShim(fakeCtx(backend))

  const handle = backend.tracker.adopt(fakeHandle('s-new'))
  await handle.persistContiguous([patchEvent(0)])
  assert.equal(handle.received[0][0].ignorable, true, '新句柄也必须补标记')
})

test('包装后：到达 persistContiguous 的批次已带 ignorable，其余事件不动', async () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const handle = fakeHandle('s1')
  backend.tracker.writers.set('s1', handle)
  installIgnorableShim(fakeCtx(backend))

  const foreign = assistantEvent(0)
  await handle.persistContiguous([foreign, patchEvent(1)])
  const got = handle.received[0]
  assert.equal(got[0], foreign)
  assert.equal(got[1].ignorable, true)
  assert.equal(got.length, 2, '批次长度不得变化（宿主用 batch.length 推 cursor）')
})

test('重复安装不叠层（幂等）', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const handle = fakeHandle('s1')
  backend.tracker.writers.set('s1', handle)
  installIgnorableShim(fakeCtx(backend))
  const after1 = handle.persistContiguous
  ensureIgnorableShim()
  ensureIgnorableShim()
  assert.equal(handle.persistContiguous, after1, '第二次安装不得再包一层')
  assert.equal(ignorableShimState().handles, 1, '已包过的句柄不重复计数')
})

test('只读句柄不包（读句柄本来就不会落盘事件）', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  installIgnorableShim(fakeCtx(backend))
  const reader = fakeHandle('s-read', 'read')
  const before = reader.persistContiguous
  backend.tracker.adopt(reader)
  assert.equal(reader.persistContiguous, before, '读句柄不该被改')
  assert.equal(backend.tracker.writers.has('s-read'), false, '读句柄不进 writers')
})

// ── 3. forgeLive 的拒绝闸门 ───────────────────────────────────────────

/** 一个能通过全部校验的假会话（目标块是 content[0] 的 text 块）。 */
function okSession() {
  return {
    seq: 12,
    surface: { nodes: [10], deriveEventMessage: ev => ev.data.message },
    eventAt: seq => (seq === 10 ? assistantEvent(10) : undefined),
    append() { throw new Error('不该走到 append（安全闸门必须先拦住）') },
  }
}

test('装上 shim → forgeLive 放行，返回值标注已标记', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  backend.tracker.writers.set('sid-1', fakeHandle('sid-1'))
  installIgnorableShim(fakeCtx(backend))
  const session = okSession()
  session.append = () => ({ type: PATCH_EVENT_TYPE, seq: 100 })
  const r = forgeLive({ get: id => (id === 'sid-1' ? session : undefined) }, {
    sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'text', newText: '伪造', expectText: '正文原文',
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.ignorableStamped, true)
  assert.equal(r.writerVerified, true)
})

test('装不上 shim → forgeLive 返回 APPEND_UNSAFE，且**一次 append 都没发生**', () => {
  resetIgnorableShim()
  const r = forgeLive({ get: id => (id === 'sid-1' ? okSession() : undefined) }, {
    sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'text', newText: '伪造', expectText: '正文原文',
  })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.code, APPEND_UNSAFE, JSON.stringify(r))
  assert.match(r.error, /写坏|可忽略/)
  assert.equal(r.detail.length > 0, true, '要带上装不上的原因，便于排错')
})

// ── 2.5 verifySessionWriter：每会话写句柄核验（P0 第二层）────────────────

test('核验通过：句柄在 writers 里、且 persistContiguous 是本插件的包装', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const handle = fakeHandle('sid-ok')
  backend.tracker.writers.set('sid-ok', handle)
  installIgnorableShim(fakeCtx(backend))
  const r = verifySessionWriter('sid-ok')
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('writers 里没有这个会话 → WRITER_NOT_ROUTED（没被持久化，回落盘安全）', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  installIgnorableShim(fakeCtx(backend))
  const r = verifySessionWriter('sid-ghost')
  assert.equal(r.ok, false)
  assert.equal(r.code, WRITER_NOT_ROUTED)
  assert.match(r.reason, /写句柄/)
})

test('写入中（writers 里是 null 占位）→ APPEND_UNSAFE，不赌', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  backend.tracker.writers.set('sid-null', null)
  installIgnorableShim(fakeCtx(backend))
  const r = verifySessionWriter('sid-null')
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.match(r.reason, /null/)
})

test('句柄在但没被包过（安装前打开又绕过钩子塞进来）→ APPEND_UNSAFE', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  installIgnorableShim(fakeCtx(backend))
  // 绕过被包装的 writers.set，用原型方法直接塞一个没包过的句柄
  const raw = fakeHandle('sid-raw')
  Map.prototype.set.call(backend.tracker.writers, 'sid-raw', raw)
  const r = verifySessionWriter('sid-raw')
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.match(r.reason, /不是本插件包装/)
})

test('宿主把 persistContiguous 换掉了（brand 丢失）→ APPEND_UNSAFE', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const handle = fakeHandle('sid-swap')
  backend.tracker.writers.set('sid-swap', handle)
  installIgnorableShim(fakeCtx(backend))
  assert.equal(verifySessionWriter('sid-swap').ok, true, '前提：换之前是通的')
  // 模拟宿主升级/热更换掉实现
  handle.persistContiguous = function (batch) { return Promise.resolve(batch) }
  const r = verifySessionWriter('sid-swap')
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.match(r.reason, /不是本插件的包装/)
})

test('读句柄混进 writers → APPEND_UNSAFE（读句柄不会被包装，核验收住）', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const reader = fakeHandle('sid-read', 'read')
  backend.tracker.writers.set('sid-read', reader)
  installIgnorableShim(fakeCtx(backend))
  const r = verifySessionWriter('sid-read')
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.match(r.reason, /不是本插件包装/)
})

test('后端实例被换掉（服务重载）→ 自动重装到新实例，核验跟着走', () => {
  resetIgnorableShim()
  const old = fakeBackend()
  installIgnorableShim(fakeCtx(old))
  assert.equal(ignorableShimState().ok, true)
  const next = fakeBackend()
  next.tracker.writers.set('sid-new', fakeHandle('sid-new'))
  // ctx 现在指向新后端
  const ctx = { reflect: { get: name => (name === 'sessionPersistence' ? next : undefined) } }
  // 换 ctx 需要重置（模拟热重载给新 ctx）
  resetIgnorableShim()
  installIgnorableShim(ctx)
  assert.equal(verifySessionWriter('sid-new').ok, true, '新实例上的句柄也必须核验通过')
})

test('后端实例在安装后被静默替换 → 自愈重装到新实例，不拿旧 tracker 冒充', () => {
  resetIgnorableShim()
  const old = fakeBackend()
  old.tracker.writers.set('sid-old', fakeHandle('sid-old'))
  const ctx = { reflect: { get: name => (name === 'sessionPersistence' ? old : undefined) } }
  installIgnorableShim(ctx)
  assert.equal(verifySessionWriter('sid-old').ok, true, '前提：旧后端上是通的')

  const next = fakeBackend()
  next.tracker.writers.set('sid-x', fakeHandle('sid-x'))
  // ctx 还是那个 ctx，但它背后的后端被换成 next（模拟服务被替换）
  ctx.reflect.get = name => (name === 'sessionPersistence' ? next : undefined)

  const r = verifySessionWriter('sid-x')
  assert.equal(r.ok, true, JSON.stringify(r), '自愈后必须重装到新后端并核验通过')
  // 旧 tracker 上的会话在新后端眼里就是「没被路由」——证明核验跟的是新实例
  const oldLook = verifySessionWriter('sid-old')
  assert.equal(oldLook.ok, false)
  assert.equal(oldLook.code, WRITER_NOT_ROUTED)
})

test('后端被换成结构损坏的实例 → 自愈失败 → APPEND_UNSAFE（fail-closed）', () => {
  resetIgnorableShim()
  const old = fakeBackend()
  old.tracker.writers.set('sid-old', fakeHandle('sid-old'))
  const ctx = { reflect: { get: name => (name === 'sessionPersistence' ? old : undefined) } }
  installIgnorableShim(ctx)
  assert.equal(verifySessionWriter('sid-old').ok, true)

  const broken = { tracker: { writers: new Map() } }  // 没有 adopt/claimWrite/flushAll
  ctx.reflect.get = name => (name === 'sessionPersistence' ? broken : undefined)
  const r = verifySessionWriter('sid-old')
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.match(r.reason, /结构不认识/)
})

test('forgeLive：会话在内存但 writers 没路由 → WRITER_NOT_ROUTED，不 append', () => {
  resetIgnorableShim()
  const backend = fakeBackend()  // sid-1 没有写句柄
  installIgnorableShim(fakeCtx(backend))
  const session = okSession()
  const r = forgeLive({ get: id => (id === 'sid-1' ? session : undefined) }, {
    sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'text', newText: '伪造', expectText: '正文原文',
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, WRITER_NOT_ROUTED, JSON.stringify(r))
  assert.match(r.detail, /写句柄/)
})

test('forgeLive：句柄被宿主换掉 → APPEND_UNSAFE，且一次 append 都没发生', () => {
  resetIgnorableShim()
  const backend = fakeBackend()
  const handle = fakeHandle('sid-1')
  backend.tracker.writers.set('sid-1', handle)
  installIgnorableShim(fakeCtx(backend))
  handle.persistContiguous = function (batch) { return Promise.resolve(batch) }  // 宿主换实现
  const session = okSession()
  let appendCalls = 0
  session.append = () => { appendCalls += 1; return { type: PATCH_EVENT_TYPE, seq: 100 } }
  const r = forgeLive({ get: id => (id === 'sid-1' ? session : undefined) }, {
    sessionId: 'sid-1', seq: 10, blockIndex: 0, kind: 'text', newText: '伪造', expectText: '正文原文',
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, APPEND_UNSAFE)
  assert.equal(appendCalls, 0, '核验不过不得调用 append')
})

// ── 4. 真宿主闸门对照（这一条就是 P0 的正身）──────────────────────────

const sessionPkg = findHostSessionPackage()
const persistencePkg = findHostPackage('dsh-session-persistence')

if (sessionPkg === null || persistencePkg === null) {
  console.log('  SKIP  找不到宿主 @deepseek-ai/dsh-session(-persistence) 包，跳过闸门对照')
  console.log('        （设 DSH_SESSION_PKG 指向包目录可强制启用）')
} else {
  const { validateStoredEvents } = await import(toFileUrl(persistencePkg))
  const META = { id: 'session-rf3-ignorable' }
  const LOC = { kind: 'jsonl', path: '/tmp/session.v4.jsonl.zstd' }

  test('真宿主闸门：patch 事件**不带** ignorable → 拒绝整条日志（这就是会话打不开的原因）', () => {
    assert.throws(
      () => validateStoredEvents(META, [patchEvent(0)], LOC),
      /reply-forge\/patch|unknown to this harness/,
    )
  })

  test('真宿主闸门：经 stampIgnorable 处理后 → 放行', () => {
    const events = stampIgnorable([patchEvent(0)])
    assert.doesNotThrow(() => validateStoredEvents(META, events, LOC))
  })

  test('真宿主闸门：多条 patch 里只要有一条没标记，整条日志照样被拒（逐条判定）', () => {
    const stamped = stampIgnorable([patchEvent(0)])[0]
    assert.equal(stamped.ignorable, true)
    assert.doesNotThrow(() => validateStoredEvents(META, [stamped, stampIgnorable([patchEvent(1)])[0]], LOC))
    assert.throws(
      () => validateStoredEvents(META, [stamped, patchEvent(1)], LOC),
      /reply-forge\/patch|unknown to this harness/,
    )
  })
}

// ── 运行 ──────────────────────────────────────────────────────────────
let pass = 0
for (const t of tests) {
  try { await t.fn(); console.log('  PASS  ' + t.name); pass += 1 }
  catch (error) {
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error && error.message).split('\n').slice(0, 4).join('\n        '))
  }
}
console.log('\n' + (pass === tests.length ? `全部通过（${pass}）` : `失败 ${tests.length - pass} / ${tests.length}`))
process.exit(pass === tests.length ? 0 : 1)
