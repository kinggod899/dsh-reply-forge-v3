// host half 路由测试（tests/routes.test.mjs）。
//
// 直接调用路由 handler（不经真实 HTTP 服务器），但**读写都走真实文件系统**：
// 把 DSH_HOME 指到临时目录，放一份合成会话，验证「路由 → forgeSession →
// 落盘 → 读回」整条链，以及各种拒绝分支。这是 host half 唯一的对外接口，
// 参数校验漏一个，UI 或别的脚本就可能写坏会话。
//
// 运行：node tests/routes.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { registerRoutes } from '../.dsh-plugin/server/routes.mjs'
import { readSessionEvents } from '../src/session-log.mjs'
import { buildPatchData, PATCH_EVENT_TYPE } from '../src/patch-event.mjs'
import { installIgnorableShim, resetIgnorableShim } from '../.dsh-plugin/server/ignorable.mjs'

// 普通在线路由用例模拟宿主里可安装的真实写句柄钩子；安全标记装不上时的
// prefer=live 拒绝 / auto 拒绝分支在专门用例里复位后验证。
// 形状照抄真 JsonlBackendTracker / JsonlSessionHandle（verifySessionWriter
// 核验所需成员一个不能少），保证「测试放行」与「真机放行」是同一道闸门。
function installFakeIgnorableShim({ withWriter = true } = {}) {
  const backend = {
    tracker: {
      openHandles: new Set(),
      writers: new Map(),
      claimWrite() {},
      flushAll() { return Promise.resolve() },
      adopt(handle) {
        this.openHandles.add(handle)
        if (handle.access === 'write') this.writers.set(handle.id, handle)
        return handle
      },
    },
  }
  if (withWriter) {
    backend.tracker.writers.set(SESSION_ID, {
      id: SESSION_ID,
      access: 'write',
      storage: { persistBatch() { return Promise.resolve() } },
      enqueueLive() {},
      drainLive() { return Promise.resolve() },
      persistContiguous() { return Promise.resolve() },
    })
  }
  resetIgnorableShim()
  return installIgnorableShim({ reflect: { get: name => name === 'sessionPersistence' ? backend : undefined } })
}

const READ_PATH = '/api/reply-forge-v3/session/blocks'
const WRITE_PATH = '/api/reply-forge-v3/session/forge'
const LINEAGE_PATH = '/api/reply-forge-v3/session/lineage'
const SESSION_ID = 'rftest-0001'
const TEXT_A = '这是第一条助手回复的正文，长度足够。'
const TEXT_B = '这是第二条助手回复的正文，长度足够。'

installFakeIgnorableShim()

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const tick = () => new Promise(resolve => setImmediate(resolve))

/** 把事件逐条压成独立帧（会话头一帧 + 每事件一帧）。 */
function sessionBytes(events) {
  const parts = [Buffer.from(JSON.stringify({ type: 'session', version: 4, id: SESSION_ID, createdAt: 1, cwd: 'C:\\workspace' }) + '\n')]
  for (const ev of events) parts.push(Buffer.from(JSON.stringify(ev) + '\n'))
  return Buffer.concat(parts.map(p => zstdCompressSync(p)))
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: 1700000000000 + seq,
    data: {
      turn: seq,
      step: 1,
      usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 115 },
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' }, id: 'msg-' + seq },
    },
  }
}

/** 建一个临时 DSH_HOME + 一个会话文件。 */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'rf-routes-'))
  const dir = path.join(home, 'sessions', '--proj--', 'session-' + SESSION_ID)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, sessionBytes([assistantEvent(1, TEXT_A), assistantEvent(2, TEXT_B)]))
  return { home, file, dir }
}

/** 收集注册的路由。 */
function mountRoutes(sessions) {
  const routes = {}
  registerRoutes({ register: r => { routes[r.path] = r } }, sessions)
  return routes
}

/** 原生 req 桩：body 由测试显式 emit，便于控制时序。 */
function makeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    on(type, fn) { (listeners[type] ??= []).push(fn); return req },
    destroy() {},
    emitBody(body) {
      const buf = Buffer.from(JSON.stringify(body))
      for (const fn of listeners.data ?? []) fn(buf)
      for (const fn of listeners.end ?? []) fn()
    },
  }
  return req
}

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: null }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = s => { res.body = s }
  return res
}

const parse = res => JSON.parse(res.body)

/** 调一次读路由。 */
function callRead(routes, { method = 'GET', query = '?sessionId=' + SESSION_ID } = {}) {
  const res = makeRes()
  routes[READ_PATH].handler(makeReq({ method, url: READ_PATH + query }), res)
  return { status: res.statusCode, body: parse(res) }
}

/** 调一次血统路由（同步，只读）。 */
function callLineage(routes, { method = 'GET', query = '' } = {}) {
  const res = makeRes()
  routes[LINEAGE_PATH].handler(makeReq({ method, url: LINEAGE_PATH + query }), res)
  return { status: res.statusCode, body: parse(res) }
}

/** 造一个带任意事件序列的临时会话（血统用例要预置 patch 事件）。 */
function makeHomeWith(events) {
  const home = mkdtempSync(path.join(tmpdir(), 'rf-routes-'))
  const dir = path.join(home, 'sessions', '--proj--', 'session-' + SESSION_ID)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, sessionBytes(events))
  return { home, file, dir }
}

/** 造一条 patch 事件（与真实在线写入同一条校验）。 */
function patchEv(seq, targets) {
  return { type: PATCH_EVENT_TYPE, seq, time: 1700000000000 + seq, data: buildPatchData(targets) }
}

/** 调一次写路由（body 会被同步 emit，promise 链需 await tick）。 */
async function callWrite(routes, { method = 'POST', headers = { 'x-rf3-forge': '1' }, body = {} } = {}) {
  const res = makeRes()
  const req = makeReq({ method, url: WRITE_PATH, headers })
  routes[WRITE_PATH].handler(req, res)
  req.emitBody(body)
  await tick()
  return { status: res.statusCode, body: parse(res) }
}

const originalHome = process.env.DSH_HOME

// ── 注册 ────────────────────────────────────────────────────────────────────

test('注册两条路由（读 + 写）', () => {
  const routes = mountRoutes()
  assert.ok(routes[READ_PATH] !== undefined, '必须有读路由')
  assert.ok(routes[WRITE_PATH] !== undefined, '必须有写路由')
  assert.equal(routes[READ_PATH].kind, 'exact')
  assert.equal(routes[WRITE_PATH].kind, 'exact')
})

// ── 读路由 ──────────────────────────────────────────────────────────────────

test('读路由：返回落盘正文块（seq + blockIndex + 原文）', () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callRead(routes)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.total, 2, '应有两个正文块')
  assert.deepEqual(r.body.blocks.map(b => b.seq), [1, 2])
  assert.deepEqual(r.body.blocks.map(b => b.blockIndex), [0, 0])
  assert.deepEqual(r.body.blocks.map(b => b.text), [TEXT_A, TEXT_B])
  rmSync(home, { recursive: true, force: true })
})

test('读路由：缺 sessionId → 400', () => {
  const routes = mountRoutes()
  const r = callRead(routes, { query: '' })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
})

test('读路由：会话不存在 → 404', () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callRead(routes, { query: '?sessionId=nope-not-here' })
  assert.equal(r.status, 404)
  rmSync(home, { recursive: true, force: true })
})

test('读路由：目录穿越被挡死 → 404', () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callRead(routes, { query: '?sessionId=' + encodeURIComponent('../../etc/passwd') })
  assert.equal(r.status, 404, 'sessionId 只允许安全字符，穿越必须落空')
  rmSync(home, { recursive: true, force: true })
})

test('读路由：非 GET → 405', () => {
  const routes = mountRoutes()
  const r = callRead(routes, { method: 'POST' })
  assert.equal(r.status, 405)
})

// ── 血统路由（v3.4）────────────────────────────────────────────────────────

test('注册三条路由（读 + 写 + 血统）', () => {
  const routes = mountRoutes()
  assert.ok(routes[LINEAGE_PATH] !== undefined, '必须有血统路由')
  assert.equal(routes[LINEAGE_PATH].kind, 'exact')
})

test('血统路由：未伪造的块 → 只有原稿一版', () => {
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A), assistantEvent(2, TEXT_B)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callLineage(routes, { query: '?sessionId=' + SESSION_ID + '&seq=1&blockIndex=0' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.versions.length, 1)
  assert.equal(r.body.versions[0].source, 'original')
  assert.equal(r.body.versions[0].text, TEXT_A)
  assert.equal(r.body.currentIndex, 0)
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：预置两条 patch → 三版，顺序与 currentIndex 正确', () => {
  const { home } = makeHomeWith([
    assistantEvent(1, TEXT_A),
    patchEv(5, [{ seq: 1, blockIndex: 0, kind: 'text', text: '改一' }]),
    patchEv(6, [{ seq: 1, blockIndex: 0, kind: 'text', text: '改二' }]),
  ])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callLineage(routes, { query: '?sessionId=' + SESSION_ID + '&seq=1&blockIndex=0' })
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.versions.map(v => v.text), [TEXT_A, '改一', '改二'])
  assert.deepEqual(r.body.versions.map(v => v.source), ['original', 'patch', 'patch'])
  assert.deepEqual(r.body.versions.map(v => v.eventSeq), [null, 5, 6])
  assert.equal(r.body.currentIndex, 2)
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：走完一次写路由（落盘）后再读 → 仍只有一版（落盘是原地改写，原稿在备份里）', async () => {
  // 这条锁死的是**如实行为**而不是 bug：v3.4  deliberately 不改写路径。
  // 落盘写入（v2 原路）原地改原始事件、不产生 patch 事件，所以血统看不见它；
  // 真原稿在 .bak-forge-* 备份里。想有血统，用自动/仅在线路径。
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A), assistantEvent(2, TEXT_B)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const w = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '落盘改写', expectText: TEXT_A } })
  assert.equal(w.body.ok, true)
  const r = callLineage(routes, { query: '?sessionId=' + SESSION_ID + '&seq=1&blockIndex=0' })
  assert.equal(r.body.ok, true)
  assert.equal(r.body.versions.length, 1, '落盘写入不产生 patch 事件，血统只有一版')
  assert.equal(r.body.versions[0].text, '落盘改写', '这一版就是磁盘当前文本')
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：缺 seq / blockIndex / 非数字 → 400（不能悄悄变成第 0 块）', () => {
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const base = '?sessionId=' + SESSION_ID
  assert.equal(callLineage(routes, { query: base + '&blockIndex=0' }).status, 400)
  assert.equal(callLineage(routes, { query: base + '&seq=1' }).status, 400)
  assert.equal(callLineage(routes, { query: base + '&seq=abc&blockIndex=0' }).status, 400)
  assert.equal(callLineage(routes, { query: base + '&seq=-1&blockIndex=0' }).status, 400)
  assert.equal(callLineage(routes, { query: base + '&seq=1&blockIndex=0&kind=bogus' }).status, 400)
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：会话不存在 → 404', () => {
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callLineage(routes, { query: '?sessionId=nope-not-here&seq=1&blockIndex=0' })
  assert.equal(r.status, 404)
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：seq 不存在 → ok:false + original-not-found', () => {
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callLineage(routes, { query: '?sessionId=' + SESSION_ID + '&seq=999&blockIndex=0' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'original-not-found')
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：kind 与原稿不符 → ok:false + kind-mismatch', () => {
  const { home } = makeHomeWith([assistantEvent(1, TEXT_A)])
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = callLineage(routes, { query: '?sessionId=' + SESSION_ID + '&seq=1&blockIndex=0&kind=reasoning' })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'kind-mismatch')
  rmSync(home, { recursive: true, force: true })
})

test('血统路由：非 GET → 405', () => {
  const routes = mountRoutes()
  const r = callLineage(routes, { method: 'POST', query: '?sessionId=x&seq=1&blockIndex=0' })
  assert.equal(r.status, 405)
})

// ── 写路由：拒绝分支 ────────────────────────────────────────────────────────

test('写路由：缺自定义头 → 403', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const before = readFileSync(file)
  const r = await callWrite(routes, { headers: {}, body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: 'x' } })
  assert.equal(r.status, 403)
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, '被拒时文件必须一字未动')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：非 POST → 405', async () => {
  const routes = mountRoutes()
  const r = await callWrite(routes, { method: 'GET' })
  assert.equal(r.status, 405)
})

test('写路由：缺 sessionId / newText / seq → 400，且文件未动', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const before = readFileSync(file)
  const cases = [
    [{ seq: 1, blockIndex: 0, newText: 'x' }, 'sessionId'],
    [{ sessionId: SESSION_ID, seq: 1, blockIndex: 0 }, 'newText'],
    [{ sessionId: SESSION_ID, newText: 'x' }, 'seq'],
  ]
  for (const [body, label] of cases) {
    const r = await callWrite(routes, { body })
    assert.equal(r.status, 400, label + ' 缺失应 400')
    assert.equal(r.body.ok, false)
  }
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, '参数不全时文件必须一字未动')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：newText 超长 → 413', async () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: 'x'.repeat(512 * 1024 + 1) } })
  assert.equal(r.status, 413)
  rmSync(home, { recursive: true, force: true })
})

test('写路由：会话不存在 → 404', async () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = await callWrite(routes, { body: { sessionId: 'nope-not-here', seq: 1, blockIndex: 0, newText: 'x' } })
  assert.equal(r.status, 404)
  rmSync(home, { recursive: true, force: true })
})

// ── 写路由：成功路径 ────────────────────────────────────────────────────────

test('写路由：正常写入 → 文件真被改、备份已生成、自读校验通过', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const NEW = '这是被路由改写后的正文。'
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: NEW, expectText: TEXT_A } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true, '应写入成功：' + JSON.stringify(r.body))
  assert.ok(typeof r.body.backup === 'string' && r.body.backup.includes('.bak-forge-'), '必须留下备份')
  assert.deepEqual(r.body.target, { seq: 1, blockIndex: 0, kind: 'text' })

  // 读回：磁盘上确实是新正文，且另一条没被碰
  const blocks = readSessionEvents(file).filter(e => e.type === 'assistant/message')
    .flatMap(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text))
  assert.deepEqual(blocks, [NEW, TEXT_B], '只该改第一条')
  const backups = readdirSync(path.dirname(file)).filter(n => n.includes('.bak-forge-'))
  assert.equal(backups.length, 1, '应有一份备份')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：expectText 不符 → 拒绝且文件一字未动', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const before = readFileSync(file)
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '不该写进去', expectText: '界面以为的旧正文（其实不对）' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false, '陈旧必须被拒')
  assert.equal(r.body.code, 'STALE_TARGET', '必须回 STALE_TARGET 让 UI 提示刷新，实际 ' + JSON.stringify(r.body))
  assert.equal(typeof r.body.actual, 'string', '要回带磁盘上的真实正文，供 UI 对照')
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, '被拒时文件必须一字未动')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：seq 不存在 → ok:false 且文件一字未动', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const before = readFileSync(file)
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 9999, blockIndex: 0, newText: 'x' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, false)
  assert.ok(String(r.body.error).includes('未命中'), '错误信息要说明没命中，实际：' + r.body.error)
  assert.equal(Buffer.compare(before, readFileSync(file)), 0)
  rmSync(home, { recursive: true, force: true })
})

test('写路由：blockIndex 越界 → ok:false 且文件一字未动', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const before = readFileSync(file)
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 7, newText: 'x' } })
  assert.equal(r.body.ok, false)
  assert.equal(Buffer.compare(before, readFileSync(file)), 0)
  rmSync(home, { recursive: true, force: true })
})

// ── v3：在线优先 / 落盘兜底 ────────────────────────────────────────────────

/** 假活会话：nodes 上有一条助手消息，append 可观测。 */
function fakeLiveSession(seq, text, kind = 'text') {
  const content = kind === 'reasoning'
    ? [{ type: 'reasoning', text }, { type: 'text', text: '正文占位' }]
    : [{ type: 'reasoning', text: '推理占位' }, { type: 'text', text }]
  const event = {
    seq,
    type: 'assistant/message',
    data: { message: { id: 'm-' + seq, role: 'assistant', source: { kind: 'model' }, content } },
  }
  const appended = []
  return {
    appended,
    seq: seq + 1,
    surface: { nodes: [seq], deriveEventMessage: ev => ev.data.message },
    eventAt: s => (s === seq ? event : undefined),
    append(type, data) { const ev = { type, seq: 900 + appended.length, data }; appended.push(ev); return ev },
  }
}

test('读路由：会话在内存里 → 走在线，不回传 file', () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const session = fakeLiveSession(1, TEXT_A)
  const routes = mountRoutes({ get: id => (id === SESSION_ID ? session : undefined) })
  const r = callRead(routes)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.mode, 'live', '会话活着就该走在线读')
  assert.equal(r.body.file, undefined, '在线读不该有 file 字段')
  assert.deepEqual(r.body.blocks.map(b => [b.seq, b.blockIndex, b.kind]), [[1, 0, 'reasoning'], [1, 1, 'text']])
  rmSync(home, { recursive: true, force: true })
})

test('读路由：会话不在内存里 → 退回落盘，mode=disk 且带 liveCode', () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes({ get: () => undefined })
  const r = callRead(routes)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.mode, 'disk')
  assert.equal(r.body.liveCode, 'SESSION_NOT_LIVE', '要告诉 UI 为什么没走在线')
  assert.equal(typeof r.body.file, 'string')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：会话在内存里 → 走在线，不碰磁盘文件', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const before = readFileSync(file)
  const session = fakeLiveSession(1, TEXT_A)
  const routes = mountRoutes({ get: id => (id === SESSION_ID ? session : undefined) })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 1, newText: '在线伪造', expectText: TEXT_A } })
  assert.equal(r.body.ok, true, JSON.stringify(r.body))
  assert.equal(r.body.mode, 'live', '会话活着必须走在线（立即生效，不用重启）')
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'reply-forge/patch')
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, '在线写入不得碰磁盘文件')
  assert.equal(readdirSync(path.dirname(file)).filter(n => n.includes('.bak-forge-')).length, 0, '在线写入不需要备份')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：会话不在内存里 → auto 模式落盘，mode=disk 且带 liveCode', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes({ get: () => undefined })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '落盘伪造', expectText: TEXT_A } })
  assert.equal(r.body.ok, true, JSON.stringify(r.body))
  assert.equal(r.body.mode, 'disk')
  assert.equal(r.body.liveCode, 'SESSION_NOT_LIVE')
  assert.ok(typeof r.body.backup === 'string' && r.body.backup.includes('.bak-forge-'))
  rmSync(home, { recursive: true, force: true })
})

test('写路由：装不上 ignorable shim → prefer=live 拒绝，auto 也拒绝（活会话不回落盘）', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const before = readFileSync(file)
  const event = assistantEvent(1, TEXT_A)
  let appendCalls = 0
  const session = {
    seq: 2,
    surface: { nodes: [1], deriveEventMessage: ev => ev.data.message },
    eventAt: seq => seq === 1 ? event : undefined,
    append() { appendCalls += 1; return { seq: 900 } },
  }
  const routes = mountRoutes({ get: id => id === SESSION_ID ? session : undefined })
  resetIgnorableShim()
  try {
    const liveOnly = await callWrite(routes, { body: {
      sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '不应写入', expectText: TEXT_A, prefer: 'live',
    } })
    assert.equal(liveOnly.body.ok, false)
    assert.equal(liveOnly.body.code, 'APPEND_UNSAFE')
    assert.equal(appendCalls, 0, '安全标记装不上时不得调用 session.append')
    assert.equal(Buffer.compare(before, readFileSync(file)), 0, 'prefer=live 拒绝后磁盘必须一字不动')

    // P0：会话活着且宿主持久化可能在跟它——此时 auto 也**不能**悄悄回落盘
    // （宿主写句柄还开着，缓冲事件稍后照样往磁盘追加，直接改盘有并发覆盖
    // 风险）。一律拒绝，由用户先关闭会话/退出 DSH 再显式选落盘。
    const automatic = await callWrite(routes, { body: {
      sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '不应写入', expectText: TEXT_A,
    } })
    assert.equal(automatic.body.ok, false, JSON.stringify(automatic.body))
    assert.equal(automatic.body.code, 'APPEND_UNSAFE')
    assert.equal(appendCalls, 0, 'auto 拒绝时也不得追加不安全的在线事件')
    assert.equal(Buffer.compare(before, readFileSync(file)), 0, 'auto 拒绝后磁盘必须一字不动')
  } finally {
    installFakeIgnorableShim()
    rmSync(home, { recursive: true, force: true })
  }
})

test('写路由：会话在内存但宿主持久化没在跟它（WRITER_NOT_ROUTED）→ prefer=live 拒绝，auto 安全退回落盘', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const before = readFileSync(file)
  installFakeIgnorableShim({ withWriter: false })
  // 单文本块会话：与磁盘夹具的块布局一致（blockIndex 0 就是 text），
  // 这样 prefer=live 能走到写句柄核验那一步（目标校验先过）。
  const event = assistantEvent(1, TEXT_A)
  const session = {
    seq: 2,
    surface: { nodes: [1], deriveEventMessage: ev => ev.data.message },
    eventAt: s => (s === 1 ? event : undefined),
    appended: [],
    append(type, data) { const ev = { type, seq: 900 + this.appended.length, data }; this.appended.push(ev); return ev },
  }
  const routes = mountRoutes({ get: id => (id === SESSION_ID ? session : undefined) })
  try {
    const liveOnly = await callWrite(routes, { body: {
      sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '不应写入', expectText: TEXT_A, prefer: 'live',
    } })
    assert.equal(liveOnly.body.ok, false)
    assert.equal(liveOnly.body.code, 'WRITER_NOT_ROUTED')
    assert.equal(session.appended.length, 0, '没被持久化路由的会话不得追加在线事件')
    assert.equal(Buffer.compare(before, readFileSync(file)), 0)

    const automatic = await callWrite(routes, { body: {
      sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '安全退回落盘', expectText: TEXT_A,
    } })
    assert.equal(automatic.body.ok, true, JSON.stringify(automatic.body))
    assert.equal(automatic.body.mode, 'disk')
    assert.equal(automatic.body.liveCode, 'WRITER_NOT_ROUTED')
    assert.ok(typeof automatic.body.backup === 'string' && automatic.body.backup.includes('.bak-forge-'))
    assert.equal(readSessionEvents(file).some(e => e?.data?.message?.content?.[0]?.text === '安全退回落盘'), true, '落盘兜底必须真的写进去')
  } finally {
    installFakeIgnorableShim()
    rmSync(home, { recursive: true, force: true })
  }
})

test('写路由：陈旧拒绝**不**退回落盘去改文件（必须原样上报）', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const before = readFileSync(file)
  const session = fakeLiveSession(1, TEXT_A)
  const routes = mountRoutes({ get: id => (id === SESSION_ID ? session : undefined) })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 1, newText: 'x', expectText: '界面以为的旧文本' } })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'STALE_TARGET', '陈旧必须原样上报，不能悄悄去改文件')
  assert.equal(session.appended.length, 0)
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, '被拒时文件必须一字未动')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：prefer=live 且会话不在内存里 → 直接失败，不落盘', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const before = readFileSync(file)
  const routes = mountRoutes({ get: () => undefined })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: 'x', prefer: 'live' } })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'SESSION_NOT_LIVE')
  assert.equal(Buffer.compare(before, readFileSync(file)), 0, 'prefer=live 时绝不能碰磁盘')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：prefer=disk → 即使会话活着也只落盘（但必须标注并发风险）', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const session = fakeLiveSession(1, TEXT_A)
  const routes = mountRoutes({ get: id => (id === SESSION_ID ? session : undefined) })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '强制落盘', expectText: TEXT_A, prefer: 'disk' } })
  assert.equal(r.body.ok, true, JSON.stringify(r.body))
  assert.equal(r.body.mode, 'disk')
  assert.equal(r.body.liveRisk, true, '会话活着时落盘必须带上并发风险标注')
  assert.match(r.body.liveWarning, /并发覆盖风险/)
  assert.equal(session.appended.length, 0, 'prefer=disk 时不该追加在线事件')
  assert.ok(readFileSync(file).length > 0)
  rmSync(home, { recursive: true, force: true })
})

test('写路由：prefer=disk 且会话不在内存里 → 无并发风险标注', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes({ get: () => undefined })
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, newText: '落盘伪造', expectText: TEXT_A, prefer: 'disk' } })
  assert.equal(r.body.ok, true, JSON.stringify(r.body))
  assert.equal(r.body.mode, 'disk')
  assert.equal(r.body.liveRisk, false, '会话不在内存里就没有并发写者')
  assert.equal(r.body.liveWarning, undefined)
  rmSync(home, { recursive: true, force: true })
})

test('写路由：kind=reasoning 能改推理块（落盘路径）', async () => {
  // 单独造一份带推理块的会话：现有夹具的助手事件只有 text 块，
  // 直接往它上面加推理块会挪动 text 的 blockIndex，把别的用例一起改坏。
  const home = mkdtempSync(path.join(tmpdir(), 'rf-routes-reasoning-'))
  const dir = path.join(home, 'sessions', '--proj--', 'session-' + SESSION_ID)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const event = {
    type: 'assistant/message',
    seq: 1,
    time: 1700000000001,
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 115 },
      message: {
        role: 'assistant',
        id: 'msg-1',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [
          { type: 'reasoning', text: '先想一下', signature: 'SIG-A' },
          { type: 'text', text: TEXT_A },
        ],
      },
    },
  }
  writeFileSync(file, sessionBytes([event]))
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, kind: 'reasoning', newText: '伪造推理链', expectText: '先想一下' } })
  assert.equal(r.body.ok, true, '落盘路径也要支持推理块：' + JSON.stringify(r.body))
  assert.equal(r.body.target.kind, 'reasoning')
  const after = readSessionEvents(file).find(e => e.type === 'assistant/message')
  assert.equal(after.data.message.content[0].text, '伪造推理链')
  assert.equal('signature' in after.data.message.content[0], false, '改推理块必须连带剥签名')
  assert.equal(after.data.message.content[1].text, TEXT_A, '正文块不该被动')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：kind 非法 → 400', async () => {
  const { home } = makeHome()
  process.env.DSH_HOME = home
  const routes = mountRoutes()
  const r = await callWrite(routes, { body: { sessionId: SESSION_ID, seq: 1, blockIndex: 0, kind: 'image', newText: 'x' } })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /kind/)
  rmSync(home, { recursive: true, force: true })
})

// ── 投影与落盘的一致性（真机 2026-10-17：重启后写入全被 STALE 拒）──────────
// 会话重启后，此前的在线伪造已被宿主持久化落盘（reply-forge/patch 事件）。
// 落盘读不过投影 → UI 拿着投影前的原文当 expectText → 在线路径的陈旧校验
// 必然拒。所以：读必须过投影；已投影的块不允许落盘改写（投影盖住原文，
// 写了也不生效），要明说走在线。

/** 在会话文件末尾追加一帧 patch 事件（模拟此前的在线写入落盘）。 */
function appendPatchFrame(file, targets) {
  const line = JSON.stringify({
    seq: 9, type: 'reply-forge/patch', ignorable: true, time: 1700000009999,
    data: { version: 1, targets },
  }) + '\n'
  writeFileSync(file, Buffer.concat([readFileSync(file), zstdCompressSync(Buffer.from(line, 'utf8'))]))
}

test('读路由：落盘读取过投影——patch 事件改写块文本（与模型所见一致）', () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  appendPatchFrame(file, [{ seq: 2, blockIndex: 0, kind: 'text', text: '这是被在线伪造改过的第二条回复。' }])
  const routes = mountRoutes()
  const r = callRead(routes)
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.blocks.map(b => b.text),
    [TEXT_A, '这是被在线伪造改过的第二条回复。'],
    '落盘读到的必须是投影后的文本——与模型所见、与在线 stale 校验基准同口径')
  assert.deepEqual(r.body.patched, [{ seq: 2, blockIndex: 0 }], 'patched 清单要报出哪些块被投影改过')
  rmSync(home, { recursive: true, force: true })
})

test('写路由：目标块已有 patch → 拒绝磁盘改写（PATCHED_TARGET），引导走在线', async () => {
  const { home, file } = makeHome()
  process.env.DSH_HOME = home
  appendPatchFrame(file, [{ seq: 2, blockIndex: 0, kind: 'text', text: '这是被在线伪造改过的第二条回复。' }])
  const routes = mountRoutes()
  // expectText 用投影后的文本（读路由现在的口径）——以前会写到原始块上然后
  // 被投影盖住，静默无效；现在必须拒绝。
  const r = await callWrite(routes, {
    body: { sessionId: SESSION_ID, seq: 2, blockIndex: 0, kind: 'text', newText: '又一次改写', expectText: '这是被在线伪造改过的第二条回复。' },
  })
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'PATCHED_TARGET')
  assert.match(String(r.body.error), /在线伪造|打开这个会话/)
  rmSync(home, { recursive: true, force: true })
})

// 执行
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name)
    console.log('        ' + String(error?.message ?? error).split('\n')[0])
  }
}
if (originalHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = originalHome
console.log(failed === 0 ? '\n全部通过（' + tests.length + '）' : '\n失败 ' + failed + ' / ' + tests.length)
process.exit(failed === 0 ? 0 : 1)
