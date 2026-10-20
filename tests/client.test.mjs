// 客户端 half 回归测试（tests/client.test.mjs）。
//
// 在 DOM 桩里跑通构建产物 .dsh-plugin/client.js 的完整链路。为什么测产物而不是
// 源码：宿主加载的就是这个文件，构建器（自研内联器）本身也会出错，测源码会漏掉。
//
// 覆盖两类：
//   A. 承自 v1 的渲染层回归（接管、幂等、自愈、分类器、重名警示）——v2 只改了
//      前缀，这些行为一个都不该退化；
//   B. v2 新增的落盘链路（定位成功/失败、POST 载荷、陈旧拒绝、双出口分离）。
//
// 运行：node tests/client.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocument, createWindow, mk } from './dom-stub.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const CODE = readFileSync(resolve(ROOT, '.dsh-plugin', 'client.js'), 'utf8')
const PACKAGE_NAME = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).name

const DEFAULT_TEXT = '这是 AI 原本输出的回复内容，长度足够触发识别阈值并且要超过最小值。'

/** 收集式 MutationObserver 桩：测试可手动 fire() 模拟宿主 DOM 变更。 */
const observers = []
class ObserverStub {
  constructor(cb) { this.cb = cb; observers.push(this) }
  observe() {}
  disconnect() {}
  fire() { this.cb() }
}

/** 加载插件模块（走官方 __ModuleLoader__.load 契约）。 */
function loadPlugin(doc, win, fetchImpl) {
  const mods = {}
  const loader = { load: ({ id, factory }) => { mods[id] = factory(() => { throw new Error('no require') }) } }
  win.__ModuleLoader__ = loader
  const runner = new Function('window', 'document', 'MutationObserver', 'console', 'fetch', CODE)
  runner(
    win,
    doc,
    ObserverStub,
    { warn: () => {}, log: () => {}, error: () => {} },
    fetchImpl,
  )
  assert.ok(mods[PACKAGE_NAME], '加载器工厂 id 必须等于 package.json 的 name：' + PACKAGE_NAME + '；实际 ' + Object.keys(mods).join(','))
  return mods[PACKAGE_NAME]
}

/** 触发全部 Observer 回调 + 冲刷定时器（模拟宿主 DOM 变更后的扫描）。 */
function fireMutations(flush) {
  for (const o of observers) o.fire()
  flush()
}

/** 让挂起的 promise 链跑完（loadRecord → then → scheduleScan）。 */
const tick = () => new Promise(resolve => setImmediate(resolve))

/** fetch 桩：按 URL 分流到「读记录」与「写记录」。
 *  blocksLater：第 2 次及以后的读记录返回值（模拟宿主把新回复落盘后
 *  记录变多——自动重读修复所依赖的场景）。
 *  forgeSequence：按调用顺序依次返回的写入结果（模拟 STALE 后重试成功）；
 *  用完后一直返回最后一个。 */
function makeFetch({ blocks = [], blocksLater = null, forgeResult = null, forgeSequence = null, readError = null, mode = 'disk', patched = [] } = {}) {
  const calls = []
  let reads = 0
  let forges = 0
  const fetchImpl = (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.includes('/session/blocks')) {
      reads += 1
      // readError 模拟「会话文件找不到」这类读失败（路由回 ok:false）。
      if (readError !== null) {
        return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false, error: readError }) })
      }
      const serving = (blocksLater !== null && reads >= 2) ? blocksLater : blocks
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true, mode, patched, sessionId: 'test-session', file: '/tmp/x', total: serving.length, blocks: serving }),
      })
    }
    if (u.includes('/session/forge')) {
      const payload = forgeSequence !== null
        ? forgeSequence[Math.min(forges, forgeSequence.length - 1)]
        : (forgeResult ?? { ok: true, mode: 'disk', liveCode: 'SESSION_NOT_LIVE', backup: '/tmp/x.bak-forge-1', verify: { events: 3, blocks: 1 }, stripped: 0 })
      forges += 1
      return Promise.resolve({ status: 200, json: () => Promise.resolve(payload) })
    }
    return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false, error: 'not found' }) })
  }
  return { calls, fetchImpl }
}

/**
 * 搭一条会话：main.conversation 锚点 + N 个助手消息块 + fetch 桩。
 * 默认让磁盘记录与页面文本完全一致（精确匹配路径）。
 *
 * sessionAttr 是宿主渲染在会话容器上的当前会话 id
 * （`data-conversation-session`）——dsh 的 URL 里没有会话 id，这是唯一来源。
 * 传 null 模拟「容器还没挂载 / 属性缺失」。
 */
function setup({
  texts = [DEFAULT_TEXT], blocks = null, blocksLater = null, forgeResult = null, forgeSequence = null, confirmResult = true,
  sessionAttr = 'test-session', pathname = '/s/test-session', readError = null, mode = 'disk', patched = [],
} = {}) {
  const doc = createDocument()
  const storage = {}
  const { window: win, pending, flush, confirmCalls, dispatch } = createWindow({ storage, confirmResult, pathname })
  const conv = mk('div')
  conv.setAttribute('data-slot', 'main.conversation')
  if (sessionAttr !== null) conv.setAttribute('data-conversation-session', sessionAttr)
  const msgs = texts.map(t => {
    const m = mk('div', 'Kwoi6G_body')
    m.append(mk('p', '', t))
    conv.append(m)
    return m
  })
  doc.body.append(conv)
  const diskBlocks = blocks === null
    ? texts.map((t, i) => ({ seq: 100 + i * 10, blockIndex: 1, kind: 'text', text: t }))
    : blocks
  const { calls, fetchImpl } = makeFetch({ blocks: diskBlocks, blocksLater, forgeResult, forgeSequence, readError, mode, patched })
  return { doc, win, pending, flush, conv, msgs, msg: msgs[0], storage, calls, fetchImpl, confirmCalls, dispatch }
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

/** 打开第 i 个块（默认第 0 个）的编辑器。 */
function openEditor(msg) {
  const bar = msg.children.find(c => c.classList.contains('rf3-bar'))
  assert.ok(bar !== undefined, '必须有操作条')
  bar.children[0].click()
  const editor = msg.children.find(c => c.classList.contains('rf3-editor'))
  assert.ok(editor !== undefined, '必须打开编辑器')
  return editor
}

/**
 * 走完一次写入伪造：页面内两步确认（第一次点击出确认行，第二次才真写）。
 * v3.1 起不再用 window.confirm——Electron 的 OS 级原生模态框会把 app 窗口
 * 的键盘焦点弄丢，是「焦点全绿却打不了字」的疑凶（2026-10-17 中午定位）。
 */
function forgeOnce(editor) {
  const b = btn(editor, '写入伪造')
  b.click()
  b.click()
}

const btn = (editor, label) => editor.querySelectorAll('button').find(b => b.textContent === label)

// ── B. 待发送队列（inbox）编辑 ────────────────────────────────────────────
//
// 这批盯的是「零代价改写」那条出口：消息还没进日志，改它不产生事件、不动已
// 提交字节。风险全在定位上——气泡 DOM 上没有任何 id 锚点，itemId 只能靠
// 文本回匹，所以歧义必须拒绝、附件必须拒绝、定位失败必须不给输入框。

/** 造一个宿主 UserStyleBubble 的最小形态（含时钟，验证它被剔除）。 */
function makePendingBubble(text, clockText = '22:18') {
  const row = mk('div', 'userRow')
  row.setAttribute('data-pending-steering', '')
  const stack = mk('div', 'userStack')
  const body = mk('div', 'bubble')
  body._text = text
  stack.append(body)
  if (clockText !== null) {
    const clock = mk('span')
    clock.setAttribute('data-clock', '')
    clock._text = clockText
    stack.append(clock)
  }
  row.append(stack)
  return row
}

/** next-step 里的一条 user 行。 */
const queueRow = (id, text) => ({ id, content: [{ type: 'text', text }], source: { kind: 'user' } })

/** sessions 服务桩：binding 给一个带 inbox 投影与 updateQueue 的 session。 */
function makeSessions(rows, opts = {}) {
  const calls = []
  const session = {
    projections: {
      faceOf: key => ({
        getSnapshot: () => (key === 'inbox' ? { 'next-turn': [], 'next-step': rows } : undefined),
      }),
    },
    updateQueue: async (itemId, action) => {
      calls.push({ itemId, action })
      if (opts.failWith !== undefined) return { ok: false, error: opts.failWith }
      return { ok: true, value: { accepted: true } }
    },
  }
  return { sessions: { binding: () => ({ session }) }, calls }
}

/** 挂好气泡并跑完扫描。 */
async function withPending(text, rows, opts = {}) {
  const { doc, win, flush, fetchImpl } = setup()
  const bubble = makePendingBubble(text)
  doc.querySelector('[data-conversation-session]').append(bubble)
  const { sessions, calls } = makeSessions(rows, opts)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {}, sessions })
  await tick(); flush()
  return { doc, bubble, calls, flush }
}

test('待发送气泡：宿主给了 sessions 服务才接管', async () => {
  const { doc, win, flush, fetchImpl } = setup()
  const bubble = makePendingBubble('待发送的句子')
  doc.querySelector('[data-conversation-session]').append(bubble)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(btn(bubble, '改待发送'), undefined, '没有 sessions 服务就不该出现入口')
})

test('待发送气泡：有服务就挂按钮，且不碰助手消息的接管链', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const bubble = makePendingBubble('待发送的句子')
  doc.querySelector('[data-conversation-session]').append(bubble)
  const { sessions } = makeSessions([queueRow('q1', '待发送的句子')])
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {}, sessions })
  await tick(); flush()
  assert.ok(btn(bubble, '改待发送') !== undefined, '气泡必须有编辑入口')
  assert.ok(msg.hasAttribute('data-rf3-taken'), '助手消息块照旧接管')
  assert.ok(!msg.hasAttribute('data-rf3-pending'), '助手块不该被误标成气泡')
})

test('待发送气泡：点开编辑器预填队列文本（时钟文本不混进来）', async () => {
  const { bubble } = await withPending('帮我看看这段代码', [queueRow('q1', '帮我看看这段代码')])
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  assert.ok(editor !== null, '必须打开编辑器')
  assert.equal(editor.querySelector('textarea').value, '帮我看看这段代码')
})

test('待发送气泡：保存走官方 updateQueue，且只发 kind edit + 纯文本', async () => {
  const { bubble, calls } = await withPending('改好的内容', [queueRow('q9', '改好的内容')])
  btn(bubble, '改待发送').click()
  const area = bubble.querySelector('.rf3-editor').querySelector('textarea')
  area.value = '改好的内容 v2'
  btn(bubble.querySelector('.rf3-editor'), '保存').click()
  await tick()
  assert.equal(calls.length, 1, '必须调一次 updateQueue')
  assert.equal(calls[0].itemId, 'q9')
  assert.deepEqual(calls[0].action, {
    kind: 'edit',
    content: [{ type: 'text', text: '改好的内容 v2' }],
  })
})

test('待发送气泡：保存成功后编辑器关闭（inbox 投影会自己刷气泡）', async () => {
  const { bubble } = await withPending('一句话', [queueRow('q1', '一句话')])
  btn(bubble, '改待发送').click()
  btn(bubble.querySelector('.rf3-editor'), '保存').click()
  await tick()
  assert.equal(bubble.querySelector('.rf3-editor'), null, '成功后编辑器必须关掉')
})

test('待发送气泡：保存失败保留编辑器与文案，允许改完重试', async () => {
  const { bubble, calls } = await withPending('一句话', [queueRow('q1', '一句话')],
    { failWith: { code: 'session/queue-item-not-found', message: 'gone' } })
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  const area = editor.querySelector('textarea')
  area.value = '换个说法'
  btn(editor, '保存').click()
  await tick()
  assert.equal(editor.querySelector('.rf3-editor'), null, '编辑器还在（没被关掉）')
  // 状态行在卡片里（第一个 .rf3-hint 是标题「编辑待发送消息」，不是状态）。
  assert.match(editor.textContent, /不在队列/)
  assert.equal(btn(editor, '保存').disabled, false, '按钮必须放回来')
  assert.equal(calls.length, 1)
})

test('待发送气泡：定位失败（气泡不在队列里）→ 只说明原因，不给输入框', async () => {
  const { bubble } = await withPending('队列里没有这句话', [queueRow('q1', '别的内容')])
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  assert.ok(editor !== null, '仍要给出反馈卡片')
  assert.equal(editor.querySelector('textarea'), null, '定位不到就不给输入框')
  assert.match(editor.textContent, /无法定位/)
})

test('待发送气泡：两条一字不差的相同文本 → 拒绝，不赌第一条', async () => {
  const { bubble, calls } = await withPending('同一句', [queueRow('q1', '同一句'), queueRow('q2', '同一句')])
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  assert.equal(editor.querySelector('textarea'), null, '歧义时不给输入框')
  assert.match(editor.textContent, /多个相同/)
  assert.equal(calls.length, 0, '一个 updateQueue 都不该发')
})

test('待发送气泡：带附件的行 → 拒绝，不静默丢附件', async () => {
  const rows = [queueRow('q1', '看图')]
  rows[0].content.push({ type: 'file', file: { name: 'a.png' } })
  const { bubble, calls } = await withPending('看图', rows)
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  assert.equal(editor.querySelector('textarea'), null)
  assert.match(editor.textContent, /附件/)
  assert.equal(calls.length, 0)
})

test('待发送气泡：上下文注入行不算用户消息，不许编辑', async () => {
  const rows = [{ id: 'c1', content: [{ type: 'text', text: '注入的内容' }], source: { kind: 'context' } }]
  const { bubble, calls } = await withPending('注入的内容', rows)
  btn(bubble, '改待发送').click()
  assert.match(bubble.querySelector('.rf3-editor').textContent, /无法定位/)
  assert.equal(calls.length, 0)
})

test('待发送气泡：内容为空时不给保存（与服务端同判据）', async () => {
  const { bubble, calls } = await withPending('有内容', [queueRow('q1', '有内容')])
  btn(bubble, '改待发送').click()
  const editor = bubble.querySelector('.rf3-editor')
  editor.querySelector('textarea').value = '   '
  btn(editor, '保存').click()
  await tick()
  assert.equal(calls.length, 0, '空白内容不该发请求')
  assert.match(editor.textContent, /不能为空/)
})

// ── A. 渲染层回归 ───────────────────────────────────────────────────────────

test('apply 注入样式并接管助手消息', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  assert.equal(typeof mod.apply, 'function', 'apply 必须导出')
  assert.deepEqual(mod.inject, ['slots', 'sessions'])
  mod.apply({ effect: () => {} })
  assert.ok(doc.querySelector('style[data-dsh-reply-forge-v3]') !== null, '样式必须注入')
  await tick(); flush()
  assert.ok(msg.hasAttribute('data-rf3-taken'), '消息块必须被接管')
  assert.ok(msg.classList.contains('rf3-host'), '需补定位上下文')
})

test('仅本机渲染 → 覆盖落库（v2 前缀）且渲染生效', async () => {
  const { doc, win, flush, msg, storage, fetchImpl, calls } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  assert.ok(editor.querySelector('textarea').value.length > 0, '编辑器需预填原文')
  editor.querySelector('textarea').value = '# 伪造标题\n\n这是 **伪造** 的内容。'
  btn(editor, '仅本机渲染').click()
  assert.ok(msg.textContent.includes('伪造标题'), '覆盖必须渲染出来')
  assert.equal(editor.parentElement, null, '保存后编辑器必须关闭')
  const keys = Object.keys(storage)
  assert.ok(keys.some(k => k.startsWith('dsh-reply-forge-v3:')), '覆盖必须落 v2 前缀的库，实际 ' + JSON.stringify(keys))
  assert.equal(keys.some(k => k.startsWith('dsh-reply-forge:v1:')), false, '绝不能写 v1 的键')
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false, '仅本机渲染不得触发落盘写入')
})

test('重复扫描幂等：不重复挂操作条', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush(); flush(); flush()
  const bars = msg.children.filter(c => c.classList.contains('rf3-bar'))
  assert.equal(bars.length, 1, '操作条只能有一个，实际 ' + bars.length)
})

test('真实 UI 结构：chat.node 槽位精确接管正文、排除思考/用户/系统/滚动壳', async () => {
  const doc = createDocument()
  const { window: win, flush } = createWindow()
  const { fetchImpl } = makeFetch()
  const conv = mk('div')
  conv.setAttribute('data-slot', 'main.conversation')

  const scrollBody = mk('div', 'wSkVaW_body')
  conv.append(scrollBody)

  const sysNode = mk('div')
  sysNode.setAttribute('data-slot', 'conversation.chat.node')
  const sysRow = mk('div', 'XrJvXW_root')
  sysRow.append(mk('span', '_title_luwio_79', '系统提示词'))
  sysRow.append(mk('span', 'XrJvXW_source', '@deepseek-ai/dsh-system-prompt'))
  sysNode.append(sysRow)
  scrollBody.append(sysNode)

  const userNode = mk('div')
  userNode.setAttribute('data-slot', 'conversation.chat.node')
  const userRow = mk('div', 'Sixlwa_userRow')
  const bubble = mk('div', 'Sixlwa_bubble')
  bubble.append(mk('span', '_plainRun_z12h9_6', '你好'))
  userRow.append(bubble)
  userNode.append(userRow)
  scrollBody.append(userNode)

  const aiNode = mk('div')
  aiNode.setAttribute('data-slot', 'conversation.chat.node')
  const aiBody = mk('div', 'hWmORq_body')
  const thinkWrap = mk('div')
  const think = mk('div', 'lcKema_root')
  const thinkRow = mk('div', '_row_luwio_16')
  thinkRow.append(mk('span', 'lcKema_leading', ''))
  thinkRow.append(mk('span', 'lcKema_label', '思考'))
  think.append(thinkRow)
  thinkWrap.append(think)
  const md = mk('div', '_markdown_kcgor_5')
  md.append(mk('p', '', '你好！我是助手，这是给你的回复正文，长度肯定够。'))
  md.append(mk('ul', '', '要点一要点二要点三'))
  aiBody.append(thinkWrap, md)
  aiNode.append(aiBody)
  scrollBody.append(aiNode)

  doc.body.append(conv)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()

  assert.ok(md.hasAttribute('data-rf3-taken'), 'markdown 正文容器必须被接管')
  assert.ok(!think.hasAttribute('data-rf3-taken'), '思考块不能被接管')
  assert.ok(!bubble.hasAttribute('data-rf3-taken'), '用户气泡不能被接管')
  assert.ok(!sysRow.hasAttribute('data-rf3-taken'), '系统/上下文节点不能被接管')
  assert.ok(!scrollBody.hasAttribute('data-rf3-taken'), '巨型滚动容器不能被接管')
  assert.equal(doc.querySelectorAll('.rf3-bar').length, 1, '只能挂一个操作条')
})

test('宿主持话输入框（带草稿文本）绝不被接管——兜底路径不误伤可编辑区', async () => {
  const { doc, win, flush, conv, msg, fetchImpl } = setup()
  // 宿主输入框是 Lexical 宿主 div，恒带 data-composer-input；草稿阶段的 typed
  // 文本就在 <p> 里。真机复现（2026-10-17 无头诊断）：新会话里字打完，
  // 兜底路径顺着 p.parentElement 把输入框也接管了，挂出一条「伪造回复」。
  const composer = doc.createElement('div')
  composer.setAttribute('data-composer-input', '')
  composer.setAttribute('contenteditable', 'true')
  const draft = doc.createElement('p')
  draft.textContent = '用户正在输入草稿'
  composer.append(draft)
  conv.append(composer)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(composer.hasAttribute('data-rf3-taken'), false, '输入框不能被接管')
  assert.equal(composer.querySelectorAll('.rf3-bar').length, 0, '输入框里不该有操作条')
  assert.ok(msg.hasAttribute('data-rf3-taken'), '真消息块照常接管')
})

test('宿主的用量/费用页脚不是模型消息，不接管（真机复现：页脚被渲染成 markdown 容器后误接）', async () => {
  const { doc, win, flush, conv, msg, fetchImpl } = setup()
  const cost = doc.createElement('div')
  const p = doc.createElement('p')
  p.textContent = '本轮费用 ≈ ¥0 + 未定价用量按已记录用量和配置价格估算；单价单位为每百万 tokens。'
  cost.append(p)
  conv.append(cost)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(cost.hasAttribute('data-rf3-taken'), false, '费用页脚不能接管')
  assert.ok(msg.hasAttribute('data-rf3-taken'), '真消息块照常接管')
})

test('分类器：工具调用块不接管，短回复与含代码正文接管', async () => {
  const doc = createDocument()
  const { window: win, flush } = createWindow()
  const { fetchImpl } = makeFetch()
  const conv = mk('div')
  conv.setAttribute('data-slot', 'main.conversation')

  const natural = mk('div', 'Kwoi6G_body')
  natural.append(mk('p', '', '这是一段纯粹的自然语言回复，用来说明某个问题的成因与解决办法，长度足够。'))
  const tool = mk('div', 'Kwoi6G_body')
  tool.append(mk('p', '', '调用工具 读取文件 C:\\Users\\test\\a.txt 完成后返回结果，长度也足够长。'))
  const code = mk('div', 'Kwoi6G_body')
  code.append(mk('pre', '', 'npm install'), mk('p', '', '上面是执行的命令内容，长度足够触发识别阈值。'))
  const english = mk('div', 'Kwoi6G_body')
  english.append(mk('p', '', 'The difference between the two approaches is difficult to see; a patched version needs another patch discussion.'))
  const short = mk('div', 'Kwoi6G_body')
  short.append(mk('p', '', '嗯，还醒着。要测什么，直接说。'))

  conv.append(natural, tool, code, english, short)
  doc.body.append(conv)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()

  assert.ok(natural.hasAttribute('data-rf3-taken'), '纯自然语言块必须接管')
  assert.equal(tool.hasAttribute('data-rf3-taken'), false, '工具调用块不得接管')
  assert.ok(code.hasAttribute('data-rf3-taken'), '含代码块的正文必须接管')
  assert.ok(english.hasAttribute('data-rf3-taken'), 'diff/patch 子串不得误伤英文散文')
  assert.ok(short.hasAttribute('data-rf3-taken'), '短回复必须接管')
})

test('宿主重渲染抹掉操作条后自愈重接管', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(msg.querySelectorAll('.rf3-bar').length, 1, '首轮一条操作条')
  msg.children.length = 0
  msg.append(mk('p', '', '这是宿主重渲染后的全新正文内容，长度足够通过所有识别阈值。'))
  fireMutations(flush)
  assert.equal(msg.querySelectorAll('.rf3-bar').length, 1, '操作条必须被重新挂上（自愈）')
  assert.ok(msg.hasAttribute('data-rf3-taken'), '自愈后接管标记必须还在')
})

test('覆盖在重载后自动重新应用（自愈）', async () => {
  const { doc, win, flush, msg, storage, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '持久化后的伪造内容'
  btn(editor, '仅本机渲染').click()

  const store = { ...storage }
  const doc2 = createDocument()
  const { window: win2, flush: flush2 } = createWindow({ storage: store })
  const { fetchImpl: fetch2 } = makeFetch()
  const conv2 = mk('div')
  conv2.setAttribute('data-slot', 'main.conversation')
  const msg2 = mk('div', 'Kwoi6G_body')
  msg2.append(mk('p', '', DEFAULT_TEXT))
  conv2.append(msg2)
  doc2.body.append(conv2)
  const mod2 = loadPlugin(doc2, win2, fetch2)
  mod2.apply({ effect: () => {} })
  await tick(); flush2()
  assert.ok(msg2.textContent.includes('持久化后的伪造内容'), '刷新后覆盖必须自动恢复')
})

test('偏好 enabled=false 时不接管，setEnabled 实时开/关', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  win.localStorage.setItem('dsh-reply-forge-v3:prefs', JSON.stringify({ enabled: false }))
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(msg.hasAttribute('data-rf3-taken'), false, '停用状态下不得接管')
  assert.equal(typeof win.__dshReplyForgeV3?.setEnabled, 'function', '调试命名空间必须暴露 setEnabled')

  win.__dshReplyForgeV3.setEnabled(true)
  flush()
  assert.ok(msg.hasAttribute('data-rf3-taken'), 'setEnabled(true) 后必须恢复接管')
  win.__dshReplyForgeV3.setEnabled(false)
  assert.equal(msg.querySelector('.rf3-bar'), null, 'setEnabled(false) 后操作条必须拆除')
})

test('待发送气泡：setEnabled(false) 后按钮与 class 一并拆干净', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const bubble = makePendingBubble('待发送的句子')
  doc.querySelector('[data-conversation-session]').append(bubble)
  const { sessions } = makeSessions([queueRow('q1', '待发送的句子')])
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {}, sessions })
  await tick(); flush()
  assert.ok(btn(bubble, '改待发送') !== undefined, '先接管上')

  win.__dshReplyForgeV3.setEnabled(false)
  assert.equal(bubble.querySelector('.rf3-pending-bar'), null, '按钮容器必须拆掉')
  assert.equal(btn(bubble, '改待发送'), undefined, '按钮本身不得残留')
  assert.equal(bubble.hasAttribute('data-rf3-pending'), false, '接管标记必须摘掉')
  assert.ok(!bubble.classList.contains('rf3-pending'), '定位 class 不得残留')
  // setEnabled(false) 的既有语义就是全拆（含助手消息的接管标记），
  // 待发送气泡不是例外——这里钉住「一起拆」而不是「单独拆一半」。
  assert.equal(msg.hasAttribute('data-rf3-taken'), false, '停用是全拆，气泡不该被漏下')
  win.__dshReplyForgeV3.setEnabled(true)
  flush()
  assert.ok(btn(bubble, '改待发送') !== undefined, '重新启用后气泡入口要回来')
})

test('指纹重名：编辑器给共享覆盖警示，并说明落盘出口不受影响', async () => {
  const dup = '这是两条一模一样的回复正文，用来验证指纹重名时的共享覆盖逻辑与编辑器警示，长度足够触发阈值。'
  const { doc, win, flush, msgs, fetchImpl } = setup({ texts: [dup, dup] })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.ok(msgs[0].hasAttribute('data-rf3-taken') && msgs[1].hasAttribute('data-rf3-taken'), '两条都必须接管')
  const editor = openEditor(msgs[0])
  const warn = editor.querySelector('.rf3-note-warn')
  assert.ok(warn !== null, '重名时必须出现警示')
  assert.ok(warn.textContent.includes('2'), '警示需说明重名条数')
  assert.ok(warn.textContent.includes('写入伪造只作用于当前这一条'), '必须讲清两个出口的差别')
})

// ── B. 落盘链路 ─────────────────────────────────────────────────────────────

test('定位成功 → 按钮带记号、编辑器显示已定位、落盘出口可用', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const bar = msg.children.find(c => c.classList.contains('rf3-bar'))
  assert.ok(bar.children[0].hasAttribute('data-rf3-linked'), '已定位的块，操作条按钮要带记号')
  const editor = openEditor(msg)
  const ok = editor.querySelector('.rf3-note-ok')
  assert.ok(ok !== null, '必须显示已定位')
  assert.ok(ok.textContent.includes('seq=100'), '定位状态要带出 seq，实际：' + ok.textContent)
  assert.equal(Boolean(btn(editor, '写入伪造').disabled), false, '定位到了就该能写')
})

test('定位失败（记录为空）→ 显示警示且落盘出口禁用', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ blocks: [] })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const warn = editor.querySelector('.rf3-note-warn')
  assert.ok(warn !== null, '必须给出未定位警示')
  assert.ok(warn.textContent.includes('没有可定位的助手正文'), '实际：' + warn.textContent)
  assert.equal(btn(editor, '写入伪造').disabled, true, '定位不到就不许写——宁可少个按钮，也不能猜位置')
})

test('记录里有正文但这条对不上 → 提示要区分于「记录是空的」', async () => {
  // 磁盘上只有一段不相干的内容。页面两条、磁盘一条 → 末尾对齐兜底只能
  // 配上最后一条，第一条仍然对不上（这正是兜底的设计意图）。
  const { doc, win, flush, conv, fetchImpl } = setup({
    texts: [
      '页面上这条完全不在磁盘记录里，长度也够触发识别阈值。',
      '页面上第二同样不在磁盘记录里，长度也够触发识别阈值。',
    ],
    blocks: [{ seq: 1, blockIndex: 0, text: '磁盘上是完全另一段内容，跟页面这两条没有任何关系。' }],
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(conv.children[0])
  // 页面比记录新时编辑器会先自动重读一次（防「记录是旧快照」造成误判），
  // 重读之后仍然是这个结果，才给出最终警示。
  await tick(); await tick(); flush()
  const warn = editor.querySelector('.rf3-note-warn')
  assert.ok(warn !== null, '必须给出未定位警示')
  assert.ok(warn.textContent.includes('未在会话记录中定位到'), '实际：' + warn.textContent)
  assert.ok(warn.textContent.includes('记录里有 1 条正文'), '要报出记录规模，便于判断是「没读到」还是「对不上」')
  assert.equal(btn(editor, '写入伪造').disabled, true)
})

// ── v2.3：记录过期自动重读（真机 bug：伪造第一条后，后面每条都定位不上）─────

test('页面比记录新（新回复刚进来）→ 自动重读并把定位补上', async () => {
  // 真机复现的最小化：首屏页面 1 条、记录 1 条（匹配）。随后宿主插入第二条
  // 消息，但记录还是旧快照——日志缓存不自己更新，第二条本该永久定位失败。
  const SECOND = '第二条回复是后来才生成的，长度也够触发识别阈值。'
  const { doc, win, flush, conv, fetchImpl, calls } = setup({
    texts: [DEFAULT_TEXT],
    blocksLater: [
      { seq: 100, blockIndex: 1, text: DEFAULT_TEXT },
      { seq: 110, blockIndex: 1, text: SECOND },
    ],
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush(); await tick(); flush()
  const reads = () => calls.filter(c => c.url.includes('/session/blocks')).length
  assert.equal(reads(), 1, '页面与记录一致时不该反复重读')

  // 宿主把新回复渲染进 DOM（落盘要晚约 200ms，宿主是批处理写入）
  const second = mk('div', 'Kwoi6G_body')
  second.append(mk('p', '', SECOND))
  conv.append(second)
  fireMutations(flush)
  await tick(); flush()

  assert.ok(reads() >= 2, '页面比记录新时必须自动重读，实际读次数 ' + reads())
  await tick(); await tick(); flush()
  assert.ok(second.hasAttribute('data-rf3-taken'), '新消息块必须被接管')
  const editor = openEditor(second)
  const ok = editor.querySelector('.rf3-note-ok')
  assert.ok(ok !== null, '重读后必须补上定位，实际：'
    + (editor.querySelector('.rf3-note-warn')?.textContent ?? editor.querySelector('.rf3-note-info')?.textContent ?? 'none'))
  assert.ok(ok.textContent.includes('seq=110'), '要定位到新落盘的那一条，实际：' + ok.textContent)
  assert.equal(Boolean(btn(editor, '写入伪造').disabled), false, '补上定位后就该允许写入')
})

test('编辑器打开时记录是旧快照 → 先重读再下结论，不当场宣判「对不上」', async () => {
  // 打开编辑器那一刻记录还没刷新（自动重读有 800ms 间隔）。此时必须先重读，
  // 而不是把「记录里有 N 条正文」的误判怼到用户脸上。
  const SECOND = '第二条回复是后来才生成的，长度也够触发识别阈值。'
  const { doc, win, flush, conv, fetchImpl } = setup({
    texts: [DEFAULT_TEXT, SECOND],
    blocks: [{ seq: 100, blockIndex: 1, text: DEFAULT_TEXT }],
    blocksLater: [
      { seq: 100, blockIndex: 1, text: DEFAULT_TEXT },
      { seq: 110, blockIndex: 1, text: SECOND },
    ],
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(conv.children[1])
  await tick(); await tick(); flush()
  const ok = editor.querySelector('.rf3-note-ok')
  assert.ok(ok !== null, '必须补上定位，实际：'
    + (editor.querySelector('.rf3-note-warn')?.textContent ?? editor.querySelector('.rf3-note-info')?.textContent ?? 'none'))
  assert.equal(Boolean(btn(editor, '写入伪造').disabled), false, '定位补上后落盘出口必须可用')
})

test('记录读失败 → 落盘出口禁用，且把真实错误显示出来', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ readError: 'session log not found' })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  assert.equal(btn(editor, '写入伪造').disabled, true)
  const warn = editor.querySelector('.rf3-note-warn')
  // 关键：不能把「读失败」和「对不上」混成同一句话——排查时会变成猜谜。
  assert.ok(warn.textContent.includes('读取会话记录失败'), '实际：' + warn.textContent)
  assert.ok(warn.textContent.includes('session log not found'), '必须带上真实错误原因')
})

test('会话 id 取自 DOM 的 data-conversation-session（dsh 的 URL 里没有会话 id）', async () => {
  // URL 里故意不含任何会话段，只有 DOM 属性有真值
  const { doc, win, flush, fetchImpl, calls } = setup({ sessionAttr: 'session-dom-abc123', pathname: '/' })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const read = calls.find(c => c.url.includes('/session/blocks'))
  assert.ok(read !== undefined, '必须发起读记录请求')
  assert.ok(read.url.includes('session-dom-abc123'), '必须用 DOM 上的会话 id；实际 URL：' + read.url)
})

test('容器未挂载时用占位值不发请求，DOM 出现后自动升级为真实会话 id', async () => {
  // 首屏：会话容器还没有 data-conversation-session
  const { doc, win, flush, conv, fetchImpl, calls } = setup({ sessionAttr: null, pathname: '/' })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.equal(calls.filter(c => c.url.includes('/session/blocks')).length, 0,
    '会话未知时不该发必然 404 的请求')

  // 宿主把会话容器挂出来，带上真实 id
  conv.setAttribute('data-conversation-session', 'session-late-777')
  fireMutations(flush)
  await tick(); flush()

  const read = calls.find(c => c.url.includes('/session/blocks'))
  assert.ok(read !== undefined, '识别出会话后必须补拉记录')
  assert.ok(read.url.includes('session-late-777'), '必须用新识别出的 id；实际：' + read.url)
  // 定位成功后落盘出口应当可用
  const editor = openEditor(conv.children[0])
  assert.equal(Boolean(btn(editor, '写入伪造').disabled), false, '定位成功就该允许写入')
})

test('写入伪造 → POST 载荷正确（seq/blockIndex/expectText/自定义头）且页面内两步确认', async () => {
  const { doc, win, flush, msg, fetchImpl, calls, storage } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '改写后的正文'
  // 第一步：只出确认行，不发请求
  const forgeBtn0 = btn(editor, '写入伪造')
  forgeBtn0.click()
  await tick(); flush()
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false,
    '两步确认：第一次点击只出确认行，绝不能直接写')
  const confirmNote = [...editor.querySelectorAll('.rf3-note-warn')]
    .map(n => n.textContent).find(t => t.includes('确认写入伪造'))
  assert.ok(confirmNote !== undefined, '第一次点击必须出页面内确认行')
  // v3 起不再写死「必须重启」——多数情况是在线写入、立即生效。
  // 但两条路径的前提必须都讲清楚，否则用户不知道这次到底生效了没有。
  assert.ok(confirmNote.includes('立即生效'), '确认文案必须讲明在线路径立即生效')
  assert.ok(confirmNote.includes('不用重启'), '必须明确「不用重启」')
  assert.ok(confirmNote.includes('下次载入时生效'), '落盘路径的前提也要讲清')
  assert.ok(confirmNote.includes('不可逆'), '必须提示不可逆')
  // 第二步：再次点击才真写
  forgeOnce(editor)
  await tick(); flush()
  const post = calls.find(c => c.url.includes('/session/forge'))
  assert.ok(post !== undefined, '必须发出写入请求')
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.headers['x-rf3-forge'], '1', '必须带自定义头（挡住同源误触）')
  const body = JSON.parse(post.init.body)
  assert.equal(body.sessionId, 'test-session')
  assert.equal(body.seq, 100, 'seq 必须来自会话记录')
  assert.equal(body.blockIndex, 1)
  assert.equal(body.kind, 'text', 'v3：块种类必须一起带上')
  assert.equal(body.prefer, 'auto', 'v3：默认让宿主先试在线')
  assert.equal(body.expectText, DEFAULT_TEXT, '必须回传 UI 看到的那份原文做陈旧校验')
  assert.equal(body.newText, '改写后的正文')
  // 成功后同步一份本机覆盖：界面立刻看到，且与记录一致
  assert.ok(msg.textContent.includes('改写后的正文'), '写入成功后页面要立刻显示新内容')
  assert.ok(Object.keys(storage).some(k => k.startsWith('dsh-reply-forge-v3:')), '同时写本机覆盖')
  assert.ok(msg.textContent.includes('下次载入时生效'), '落盘路径要如实说明何时生效')
})

test('页面内两步确认：只点第一次不出确认行就不写，内容改了要重新确认', async () => {
  const { doc, win, flush, msg, fetchImpl, calls } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '不该被写进去的正文'
  // 只点第一次：出了确认行，但没有第二次 → 不写
  btn(editor, '写入伪造').click()
  await tick(); flush()
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false,
    '没有二次确认绝不能发请求')
  // 改了内容：之前的确认作废，还得重新点两次
  editor.querySelector('textarea').value = '改过之后的正文'
  const b = btn(editor, '写入伪造')
  b.click()
  await tick(); flush()
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false,
    '内容变化后旧确认必须失效，仍不能直接写')
  b.click()
  await tick(); flush()
  assert.ok(calls.some(c => c.url.includes('/session/forge')), '重新两次点击后才写')
  const body = JSON.parse(calls.find(c => c.url.includes('/session/forge')).init.body)
  assert.equal(body.newText, '改过之后的正文')
})

test('陈旧拒绝（STALE_TARGET）→ 提示重新读取', async () => {
  const stale = { ok: false, error: '磁盘上的正文与预期不一致（界面看到的内容已过期），已拒绝写入。请刷新后重试。', code: 'STALE_TARGET', actual: '磁盘上其实是别的内容' }
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ forgeResult: stale })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '新的正文'
  forgeOnce(editor)
  await tick(); flush()
  const notes = editor.querySelectorAll('.rf3-note-warn')
  const hit = notes.find(n => n.textContent.includes('已过期') || n.textContent.includes('重新读取'))
  assert.ok(hit !== undefined, '陈旧拒绝必须给出可操作提示，实际：' + JSON.stringify([...notes].map(n => n.textContent)))
})

// ── v3：陈旧自动重试（真机 2026-10-17 下午：重启后写入全被 STALE 拒）─────────
// 服务端读路由现已同样过投影，一般不会再发生；客户端仍保留「自动重试一次」
// 兜底：强制重读 → 重新定位 → 原样再写。失败时把 actual/expected 都摆出来。

test('陈旧拒绝 → 自动重读重试一次即成功（重试用的是新读到的记录）', async () => {
  const stale = {
    ok: false, error: '磁盘上的正文与预期不一致（界面看到的内容已过期），已拒绝写入。请刷新后重试。',
    code: 'STALE_TARGET', actual: '磁盘上其实是别的内容', expected: DEFAULT_TEXT,
  }
  const ok = { ok: true, mode: 'disk', liveCode: 'SESSION_NOT_LIVE', backup: '/tmp/x.bak-forge-2', verify: { events: 3, blocks: 1 }, stripped: 0 }
  // 第二次及以后的读记录返回「换了 seq 的同内容块」：证明重试确实重新读了
  // 记录并重新定位，而不是拿旧 match 再赌一次。
  const { doc, win, flush, msg, fetchImpl, calls } = setup({
    forgeSequence: [stale, ok],
    blocksLater: [{ seq: 200, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT }],
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '新的正文'
  forgeOnce(editor)
  await tick(); flush(); await tick(); flush()
  const posts = calls.filter(c => c.url.includes('/session/forge'))
  assert.equal(posts.length, 2, '必须恰好自动重试一次（共两次写入请求），实际 ' + posts.length)
  const body2 = JSON.parse(posts[1].init.body)
  assert.equal(body2.seq, 200, '重试必须用重新读到的记录定位，实际 seq=' + String(body2.seq))
  assert.equal(body2.expectText, DEFAULT_TEXT, '重试的 expectText 必须来自新记录')
  assert.equal(body2.newText, '新的正文', '重试内容原样')
  assert.ok(msg.textContent.includes('新的正文'), '重试成功后界面要立刻显示新内容')
  assert.ok(msg.textContent.includes('已写入'), '重试成功后必须报告写入成功')
  assert.equal(doc.querySelectorAll('.rf3-editor').length, 0, '成功后编辑器必须关闭')
})

test('陈旧重试仍败 → 摆出 actual/expected 且绝不无限重试', async () => {
  const stale = {
    ok: false, error: '磁盘上的正文与预期不一致（界面看到的内容已过期），已拒绝写入。请刷新后重试。',
    code: 'STALE_TARGET', actual: '磁盘上其实是别的内容', expected: DEFAULT_TEXT,
  }
  const { doc, win, flush, msg, fetchImpl, calls } = setup({ forgeSequence: [stale, stale] })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '新的正文'
  forgeOnce(editor)
  await tick(); flush(); await tick(); flush()
  // 只重试一次：第二次仍陈旧就直接放弃（不能让用户在无谓的循环里等）
  assert.equal(calls.filter(c => c.url.includes('/session/forge')).length, 2,
    '陈旧自动重试只允许一次，绝不能无限循环')
  // 重试前的信息行要把两边文本摆出来
  const info = [...editor.querySelectorAll('.rf3-note-info')].map(n => n.textContent)
  assert.ok(info.some(t => t.includes('自动重新读取后重试')), '必须有自动重试的信息行，实际：' + JSON.stringify(info))
  assert.ok(info.some(t => t.includes('磁盘上其实是别的内容')), 'actual 必须摆出来')
  assert.ok(info.some(t => t.includes(DEFAULT_TEXT)), 'expected 必须摆出来')
  // 最终失败提示同样给全两边文本 + 可操作建议
  const warn = [...editor.querySelectorAll('.rf3-note-warn')].map(n => n.textContent)
  const hit = warn.find(t => t.includes('磁盘上其实是别的内容') && t.includes('重新读取'))
  assert.ok(hit !== undefined, '最终失败必须带 actual/expected 与「重新读取」建议，实际：' + JSON.stringify(warn))
  // 编辑器保持打开，用户可以改内容或手动重新读取
  assert.equal(doc.querySelectorAll('.rf3-editor').length, 1, '失败后编辑器应保持打开')
})

test('内容没变化时不发请求', async () => {
  const { doc, win, flush, msg, fetchImpl, calls } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  // 原样不改，直接点写入
  btn(editor, '写入伪造').click()
  await tick(); flush()
  const warnNotes = [...editor.querySelectorAll('.rf3-note-warn')].map(n => n.textContent)
  assert.equal(warnNotes.some(t => t.includes('确认写入伪造')), false, '没变化不该出确认行')
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false, '没变化不该发请求')
})

test('快捷键 Alt+Shift+E：全部块已接管后仍能打开最后一条的编辑器', async () => {
  // 回归：picker 的幂等守卫会跳过「已接管」的块，于是「所有块都接管完之后
  // 按快捷键毫无反应」。枚举用途必须带 includeTaken 才拿得到块。
  const { doc, win, flush, msgs, dispatch, fetchImpl } = setup({ texts: ['第一条回复正文，长度足够触发阈值。', '第二条回复正文，长度足够触发阈值。'] })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  assert.ok(msgs[0].hasAttribute('data-rf3-taken') && msgs[1].hasAttribute('data-rf3-taken'), '两条都该被接管')
  assert.equal(doc.querySelectorAll('.rf3-editor').length, 0, '此刻不该有编辑器')
  dispatch('keydown', { altKey: true, shiftKey: true, key: 'e' })
  assert.equal(doc.querySelectorAll('.rf3-editor').length, 1, '快捷键必须能打开编辑器')
  const editor = msgs[1].children.find(c => c.classList.contains('rf3-editor'))
  assert.ok(editor !== undefined, '必须开在最后一条上')
  assert.ok(editor.querySelector('textarea').value.includes('第二条'), '编辑框要预填该条正文（不含按钮文字）')
})

test('调试命名空间 locate() 能报出定位情况', async () => {
  const { doc, win, flush, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const info = win.__dshReplyForgeV3.locate()
  assert.equal(info.ok, true)
  assert.equal(info.diskBlocks, 1)
  assert.equal(info.domBlocks, 1)
  assert.equal(info.matched, 1)
  assert.equal(info.exact, 1)
})

// ── C. v3 新增：在线路径 + 目标选择器 ──────────────────────────────────────

test('在线模式 → 编辑器提示「立即生效，不用重启」', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ mode: 'live' })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  assert.ok(editor.textContent.includes('在线'), '必须标出在线模式')
  assert.ok(editor.textContent.includes('立即生效'), '必须告诉用户立即生效')
  assert.ok(editor.textContent.includes('不用重启'), '必须明确不用重启')
  assert.equal(editor.textContent.includes('落盘：'), false, '在线时不该显示落盘提示')
})

test('落盘模式 → 编辑器提示「下次载入时生效」', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ mode: 'disk' })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  assert.ok(editor.textContent.includes('落盘'), '必须标出落盘模式')
  assert.ok(editor.textContent.includes('下次载入时生效'))
})

test('在线写入成功 → 结果提示「不用重启」而不是「需重启」', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '在线伪造后的正文'
  forgeOnce(editor)
  await tick(); flush()
  assert.ok(msg.textContent.includes('不用重启'), '在线成功必须说「不用重启」')
  assert.equal(msg.textContent.includes('需重启'), false, '在线成功不该出现「需重启」')
})

// ── 焦点回归（2026-10-16 真机 bug）──────────────────────────────────────────
// 真机现象：「写入伪造」保存成功后，下方输入框打不了字、没有光标，点一下
// 「+ 添加文件」才能继续输入。根因：编辑器就地插在消息块里，保存成功后
// applyOverride 把整个消息块（含此刻持有焦点的按钮/textarea）抹掉，焦点掉到
// <body>；而宿主工具栏的 mousedown 会把焦点拉回输入框，所以看起来像
// 「添加文件才能好」。修法：关编辑器前先把焦点交还宿主输入框。

/** 宿主输入框：contenteditable 的 Lexical 宿主，带官方 data 属性。 */
function addComposerInput(doc) {
  const composer = doc.createElement('div')
  composer.setAttribute('data-composer-input', '')
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  doc.body.append(composer)
  return composer
}

test('真机回归：写入伪造成功后焦点交还宿主输入框（否则输入框打不了字、没光标）', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  // 真实浏览器里 mousedown 会把焦点放到按钮上；抹块时被抹掉的就是它。
  forgeBtn.focus()
  assert.equal(doc.activeElement, forgeBtn, '前置条件：焦点在「写入伪造」按钮上')
  editor.querySelector('textarea').value = '在线伪造后的正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick(); flush()
  assert.equal(msg.children.some(c => c.classList.contains('rf3-editor')), false, '编辑器必须关闭')
  assert.equal(doc.activeElement, composer,
    '写完伪造焦点必须交还宿主输入框，实际=' + (doc.activeElement === null ? 'null(<body>)' : doc.activeElement.tagName))
})

// 第二轮真机 bug 的精确复现路径：用户报告「仅本机渲染」好了、「写入伪造」还是
// 没光标。差别就在写入路径点下去会 disable 两个按钮防重复提交，而 Chromium 的
// 规矩是聚焦元素被 disable 时焦点立刻掉 <body>——等异步写完再来关编辑器时，
// 「焦点在不在 wrap 里」已经看不出来了，第一版 closeEditorOnBlock 因此把交还
// 整段跳过。「仅本机渲染」是同步路径，从不断开焦点，所以一条好一条坏。
test('真机回归：点「写入伪造」后按钮被 disable 抢焦（焦点掉 body），保存成功仍交还输入框', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '在线伪造后的正文'
  forgeBtn.click()
  forgeBtn.click()
  assert.equal(doc.activeElement, null,
    '前置条件：点击即 disable 按钮，Chromium 会把焦点打到 <body>——焦点此刻已经丢了')
  await tick(); flush()
  assert.equal(msg.children.some(c => c.classList.contains('rf3-editor')), false, '编辑器必须关闭')
  assert.equal(doc.activeElement, composer,
    '焦点被 disable 打到 body 后，保存成功仍必须交还宿主输入框，实际='
    + (doc.activeElement === null ? 'null(<body>)' : doc.activeElement.tagName))
  const note = msg.children.find(c => c.classList.contains('rf3-note'))
  assert.ok(note !== undefined && note.textContent.includes('焦点已交还输入框'),
    '提示行必须如实报告交还成功，实际=' + (note === undefined ? '无提示行' : note.textContent))
})

test('焦点回归：写入期间焦点主动移到别处 → 不抢焦点，但如实记录', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  addComposerInput(doc)
  const other = doc.createElement('button')
  doc.body.append(other)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '在线伪造后的正文'
  forgeBtn.click()
  forgeBtn.click()
  // 模拟用户在网络写入等待期间主动把焦点移到别处（非 body）：保存完成时
  // 插件不能夺走用户有意设置的焦点，只能在结果提示里如实说明没执行交还。
  other.focus()
  await tick(); flush()
  assert.equal(doc.activeElement, other, '用户主动移走的焦点不应被插件抢回')
  const note = msg.children.find(c => c.classList.contains('rf3-note'))
  assert.ok(note !== undefined && note.textContent.includes('关闭编辑器时焦点已不在编辑器里'),
    '提示行要说明为什么没有交还，实际=' + (note === undefined ? '无提示行' : note.textContent))
  const f = win.__dshReplyForgeV3.focus()
  assert.equal(f.last.reason, 'focus-not-in-editor', '跳过交还必须留痕，实际=' + JSON.stringify(f.last))
})

test('焦点回归：仅本机渲染保存后同样交还宿主输入框', async () => {
  const { doc, win, flush, msg, fetchImpl, calls } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const localBtn = btn(editor, '仅本机渲染')
  localBtn.focus()
  editor.querySelector('textarea').value = '# 伪造标题'
  localBtn.click()
  assert.equal(calls.some(c => c.url.includes('/session/forge')), false, '仅本机渲染不得触发落盘写入')
  assert.equal(doc.activeElement, composer, '本机渲染保存后焦点也要交还宿主输入框')
})

test('焦点回归：取消 / Esc 关闭编辑器也交还宿主输入框', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const area = editor.querySelector('textarea')
  assert.equal(doc.activeElement, area, '前置条件：编辑器打开时焦点在 textarea 上')
  area.dispatch('keydown', { key: 'Escape' })
  assert.equal(editor.parentElement, null, 'Esc 必须关闭编辑器')
  assert.equal(doc.activeElement, composer, 'Esc 关闭后焦点交还宿主输入框')
})

test('焦点回归：宿主输入框不存在（hero 态）时不抛错，只是不交还', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  editor.querySelector('textarea').value = '# 伪造标题'
  const localBtn = btn(editor, '仅本机渲染')
  localBtn.focus()
  localBtn.click()
  assert.equal(msg.textContent.includes('伪造标题'), true, '没有宿主输入框也要能正常保存')
  assert.equal(doc.activeElement, null, '没有可交还的目标时焦点退回 body，不应抛错')
})

test('焦点回归：保存后提示行如实报告交还结论', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const localBtn = btn(editor, '仅本机渲染')
  localBtn.focus()
  editor.querySelector('textarea').value = '# 伪造标题'
  localBtn.click()
  const note = msg.children.find(c => c.classList.contains('rf3-note'))
  assert.ok(note !== undefined, '保存后要有结果提示行')
  assert.ok(note.textContent.includes('焦点已交还输入框'),
    '交还成功时提示行必须如实说"焦点已交还输入框"，实际=' + note.textContent)
  assert.equal(doc.activeElement, composer, '焦点应落在宿主输入框')
})

test('焦点回归：输入框不可编辑时提示行说明原因，不假报成功', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  // 宿主把输入框置于 inert（无会话/被锁/机审中）：同一个 div 变成
  // contenteditable=false，此时 focus() 是无操作——真机「没有光标」的
  // 另一种成因。提示行必须能区分这一点，否则用户没法判断该重试还是等宿主。
  const composer = doc.createElement('div')
  composer.setAttribute('data-composer-input', '')
  composer.setAttribute('contenteditable', 'false')
  doc.body.append(composer)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const localBtn = btn(editor, '仅本机渲染')
  localBtn.focus()
  editor.querySelector('textarea').value = '# 伪造标题'
  localBtn.click()
  const note = msg.children.find(c => c.classList.contains('rf3-note'))
  assert.ok(note !== undefined, '保存后要有结果提示行')
  assert.ok(note.textContent.includes('输入框暂不可编辑'),
    '不可聚焦时提示行必须说"输入框暂不可编辑"，实际=' + note.textContent)
  assert.equal(note.textContent.includes('焦点已交还'), false, '没交还成功就不能报已交还')
  assert.equal(doc.activeElement, null, '不可编辑的输入框拿不走焦点')
})

test('调试命名空间 focus() 报出最近交还结果与输入框当前状态', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const localBtn = btn(editor, '仅本机渲染')
  localBtn.focus()
  editor.querySelector('textarea').value = '# 伪造标题'
  localBtn.click()
  const f = win.__dshReplyForgeV3.focus()
  assert.equal(f.last.ok, true, '最近一次交还应成功')
  assert.equal(f.composer.editable, true, '输入框当前可编辑')
  assert.equal(f.activeIsComposer, true, '此刻焦点就在宿主输入框')
})

// ── 第二轮真机 bug（2026-10-17）：提示行说「焦点已交还输入框」，用户依旧打不了字 ──
// 桩里全绿、真机依旧。差别只能在桩没建模的地方：焦点落点 ≠ 可打字。
// 三种真实成因各自配了一条回归：抓错输入框候选、selection 不在输入框里、
// 宿主在守候窗口结束后又把焦点弄丢（打字保险丝兜底）。

test('真机回归：多个输入框候选时，交还挑可见/非 inert 的那个（抓错=打不了字）', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  // 复刻真机形状：document order 第一个是 inert 副本（宿主 modal/遮罩里那个），
  // 用户眼前可见的是第二个。querySelector 只会抓第一个——focus() 对 inert
  // 内容是无操作，提示行还傻乎乎报「已交还」，用户眼前输入框根本没光标。
  const inertWrap = mk('div')
  inertWrap.setAttribute('inert', '')
  const hidden = mk('div')
  hidden.setAttribute('data-composer-input', '')
  hidden.setAttribute('contenteditable', 'true')
  inertWrap.append(hidden)
  doc.body.append(inertWrap)
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '多个输入框候选时的正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick(); flush()
  assert.equal(doc.activeElement, composer,
    '焦点必须落在用户可见的那个输入框上，实际='
    + (doc.activeElement === null ? 'null(<body>)' : doc.activeElement.tagName))
  const f = win.__dshReplyForgeV3.focus()
  assert.equal(f.composerTotal, 2, '调试视图要报出候选总数，实际=' + f.composerTotal)
  assert.equal(f.activeIsComposer, true, 'activeIsComposer 要对着挑出来的那个')
})

test('打字保险丝：保存后宿主又把焦点弄丢 → 第一个键就把焦点拉回输入框', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '保险丝回归正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick()
  assert.equal(doc.activeElement, composer, '前置条件：保存后焦点确实交还了')
  // 宿主异步重渲染/状态翻转，把焦点又弄丢了（守候窗口 700ms 已过）
  doc.activeElement = null
  // 用户按键：capture 段先把焦点拉回输入框，这个键之后的输入才有着落
  dispatch('keydown', { key: 'a', target: doc.body })
  assert.equal(doc.activeElement, composer,
    '焦点丢了之后第一个键必须把焦点拉回输入框，实际='
    + (doc.activeElement === null ? 'null(<body>)' : doc.activeElement.tagName))
  flush()
})

test('打字保险丝：不碰快捷键（Alt+Shift+E 开编辑器照常工作）', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '快捷键不碰回归正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick()
  doc.activeElement = null
  // 保险丝处于武装状态时按 Alt+Shift+E：快捷键必须照常开编辑器，
  // 保险丝只放行不拦截，顺带被 openBlockEditor 解除。
  dispatch('keydown', { key: 'e', altKey: true, shiftKey: true, target: doc.body })
  const reopened = msg.children.find(c => c.classList.contains('rf3-editor'))
  assert.ok(reopened !== undefined, 'Alt+Shift+E 必须还能开编辑器（保险丝不拦快捷键）')
  assert.equal(doc.activeElement, reopened.querySelector('textarea'),
    '快捷键打开编辑器后焦点应在新 textarea 上，说明保险丝没有半路抢焦点')
  flush()
})

test('打字保险丝：用户焦点在别的可编辑控件里 → 不抢，且随即解除', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const search = mk('input')
  doc.body.append(search)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '可编辑目标回归正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick()
  doc.activeElement = null
  // 用户把焦点放在别的可编辑控件里（比如搜索框）→ 不抢
  dispatch('keydown', { key: 'a', target: search })
  assert.equal(doc.activeElement, null, '别处正经输入不该被抢走焦点')
  // 已经解除：再按「无处可去」的键也无动作
  dispatch('keydown', { key: 'b', target: doc.body })
  assert.equal(doc.activeElement, null, '遇到可编辑目标后保险丝应已解除')
  flush()
})

test('打字保险丝：编辑器重新打开后解除，不与编辑输入互相打结', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '重开编辑器回归正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick()
  // 再开一次编辑器（点新操作条上的「伪造回复」）——textarea 会拿回焦点
  const editor2 = openEditor(msg)
  assert.equal(doc.activeElement, editor2.querySelector('textarea'), '前置条件：重开后焦点在编辑器 textarea 上')
  doc.activeElement = null
  dispatch('keydown', { key: 'a', target: doc.body })
  assert.equal(doc.activeElement, null, '编辑器开着时保险丝必须已解除，不能把焦点从 textarea 抢走')
  flush()
})

// ── 第三轮真机 bug（2026-10-17 中午）：连编辑器 textarea 都点不出光标 ──
// 用户真机证据：__dshReplyForgeV3.focus() → {composerTotal: 1, active: 'BODY',
// activeIsComposer: false}。焦点不在任何输入框，点击也不落。两类各自修了：
// A. 宿主在 mousedown 之后把焦点弄丢 → textarea 挂点击保险（mouseup/click 复查）；
// B. 操作条 z-index:5 压在编辑器上层，盖住右上角的点击区 → 编辑器 z-index:6 +
//    编辑器开着时藏起本块 bar。再加扁平化 focus() 探针方便真机取证。

test('真机回归：编辑器 textarea 点击保险——宿主弄丢焦点后点击即补回光标', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const area = editor.querySelector('textarea')
  assert.equal(doc.activeElement, area, '前置条件：编辑器打开时 textarea 拿到焦点')
  // 真机上宿主会在点击后把焦点弄丢（activeElement 停在 <body>）
  doc.activeElement = null
  area.dispatch('mouseup')
  assert.equal(doc.activeElement, area, '点进 textarea 就必须有光标，不管宿主中途弄丢过几次')
  // 焦点本来就在时不乱动（点别处不该触发 textarea 的保险）
  const other = doc.createElement('input')
  doc.body.append(other)
  other.focus()
  assert.equal(doc.activeElement, other, '前置条件：焦点在别的输入控件')
  other.dispatch('click')
  assert.equal(doc.activeElement, other, '点别处时 textarea 保险不抢焦点')
  flush()
})

test('真机回归：编辑器开着时藏起本块操作条（防绝对定位 bar 压住编辑器点击区）', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const barOf = () => msg.children.find(c => c.classList && c.classList.contains('rf3-bar'))
  const editor = openEditor(msg)
  const bar = barOf()
  assert.ok(bar !== undefined, '操作条还在块上')
  assert.equal(bar.style.display, 'none', '编辑器开着时本块 bar 必须藏起来（否则盖住编辑器右上角）')
  // Esc 取消：编辑器关了，bar 必须恢复（否则块上再也点不到「伪造回复」）
  editor.querySelector('textarea').dispatch('keydown', { key: 'Escape' })
  assert.equal(barOf().style.display, '', 'Esc 关闭编辑器后 bar 必须恢复显示')
  flush()
})

test('焦点探针：focus() 扁平全字段 + summary 一行摘要（真机取证不被折叠藏信息）', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', sessionId: 'test-session', eventSeq: 42, target: { seq: 100, blockIndex: 1, kind: 'text' } },
  })
  const composer = addComposerInput(doc)
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const forgeBtn = btn(editor, '写入伪造')
  forgeBtn.focus()
  editor.querySelector('textarea').value = '探针扁平化回归正文'
  forgeBtn.click()
  forgeBtn.click()
  await tick()
  const f = win.__dshReplyForgeV3.focus()
  assert.equal(f.lastOk, true, '扁平字段 lastOk 必须可用')
  assert.equal(f.lastReason, 'ok', '扁平字段 lastReason 必须可用')
  assert.equal(f.composerEditable, true, '扁平字段 composerEditable 必须可用')
  assert.equal(f.composerTotal, 1, '扁平字段 composerTotal 必须可用')
  assert.equal(f.activeIsComposer, true, '扁平字段 activeIsComposer 必须可用')
  assert.equal(typeof f.selectionInComposer, 'boolean', 'selection 状态必须可查')
  assert.equal(typeof f.guardArmed, 'boolean', '保险丝状态必须可查')
  assert.ok(f.summary.includes('last.ok=true'), 'summary 必须一行说清 last.ok，实际=' + f.summary)
  assert.ok(f.summary.includes('composer.editable=true'), 'summary 必须一行说清输入框可编辑性，实际=' + f.summary)
  assert.ok(f.summary.includes('guard='), 'summary 必须一行说清保险丝状态，实际=' + f.summary)
  // 旧字段名兼容（早期说明/脚本引用过）
  assert.equal(f.last.ok, true, '旧字段 f.last.ok 仍可用')
  assert.equal(f.composer.editable, true, '旧字段 f.composer.editable 仍可用')
  flush()
})

test('目标选择器：列出全部可编辑块，含思维链，并带 kind 标记', async () => {
  const blocks = [
    { seq: 100, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT },
    { seq: 100, blockIndex: 0, kind: 'reasoning', text: '这是模型的思维链原文，长度足够。' },
    { seq: 110, blockIndex: 1, kind: 'text', text: '第二条回复正文，长度足够触发阈值。' },
  ]
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ blocks })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-select')
  assert.ok(sel !== null, '编辑器必须有目标选择器')
  const options = [...sel.children].map(o => ({ value: o.value, text: o.textContent }))
  assert.equal(options.length, 4, '1 个「跟随页面」+ 3 个块')
  assert.ok(options.some(o => o.text.includes('【思维链】')), '思维链必须出现在清单里——它在页面上是折叠行，拾取不到')
  assert.ok(options.some(o => o.value === '100:0'), '思维链的寻址是 seq+blockIndex')
})

test('目标选择器：选中思维链 → 文本框换成思维链内容，且关掉「仅本机渲染」', async () => {
  const blocks = [
    { seq: 100, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT },
    { seq: 100, blockIndex: 0, kind: 'reasoning', text: '这是模型的思维链原文，长度足够。' },
  ]
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({ blocks })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-select')
  sel.value = '100:0'
  sel.dispatch('change')

  assert.equal(editor.querySelector('textarea').value, '这是模型的思维链原文，长度足够。', '文本框要换成选中的那条')
  assert.equal(btn(editor, '仅本机渲染').disabled, true, '改别的消息时本机渲染出口无意义，必须禁用')
  assert.equal(btn(editor, '写入伪造').disabled, false, '写入出口必须可用')
})

test('目标选择器：选中思维链后写入 → 载荷带 kind=reasoning 与思维链原文', async () => {
  const blocks = [
    { seq: 100, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT },
    { seq: 100, blockIndex: 0, kind: 'reasoning', text: '这是模型的思维链原文，长度足够。' },
  ]
  const { doc, win, flush, msg, fetchImpl, calls } = setup({ blocks, mode: 'live', forgeResult: { ok: true, mode: 'live', eventSeq: 7 } })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-select')
  sel.value = '100:0'
  sel.dispatch('change')
  editor.querySelector('textarea').value = '伪造后的思维链'
  forgeOnce(editor)
  await tick(); flush()

  const post = calls.find(c => c.url.includes('/session/forge'))
  assert.ok(post !== undefined, '必须发出写入请求')
  const body = JSON.parse(post.init.body)
  assert.equal(body.kind, 'reasoning', '思维链必须带 kind=reasoning')
  assert.equal(body.blockIndex, 0)
  assert.equal(body.seq, 100)
  assert.equal(body.expectText, '这是模型的思维链原文，长度足够。', '陈旧校验要用选中的那条的原文')
  assert.equal(body.newText, '伪造后的思维链')
})

test('目标选择器：改的是别的消息时，不往本节点写本机覆盖', async () => {
  const blocks = [
    { seq: 100, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT },
    { seq: 110, blockIndex: 1, kind: 'text', text: '第二条回复正文，长度足够触发阈值。' },
  ]
  const { doc, win, flush, msg, storage, fetchImpl } = setup({ blocks, forgeResult: { ok: true, mode: 'live', eventSeq: 9 } })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-select')
  sel.value = '110:1'
  sel.dispatch('change')
  editor.querySelector('textarea').value = '伪造第二条'
  forgeOnce(editor)
  await tick(); flush()

  assert.equal('dsh-reply-forge-v3:test-session' in storage, false,
    '改别的消息不该在本节点写本机覆盖（会让页面显示错乱）')
  assert.equal(msg.textContent.includes('伪造第二条'), false, '本节点内容不该被改成别的消息的内容')
})

// ── D. v3.1：新会话空快照自愈 + 写入方式显式选择 ───────────────────────────

test('真机回归：新会话首读拿到 live 空快照 → 自动重读补上，不再永久卡住', async () => {
  // 2026-10-16 真机：老会话（打开时内容早已齐备）一切正常，**新会话**全程
  // 提示「会话记录里没有可定位的助手正文」。根因是 live 的空快照被当成终态
  // 缓存住了——宿主先把回复渲染进 DOM，稍后才把它登记进活会话。
  const { doc, win, flush, msg, fetchImpl, calls } = setup({
    mode: 'live',
    blocks: [],
    blocksLater: [{ seq: 100, blockIndex: 1, kind: 'text', text: DEFAULT_TEXT }],
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush(); await tick(); flush(); await tick(); flush()

  const reads = calls.filter(c => c.url.includes('/session/blocks')).length
  assert.ok(reads >= 2, 'live 空快照必须自动重读，实际读次数 ' + reads)
  const editor = openEditor(msg)
  const ok = editor.querySelector('.rf3-note-ok')
  assert.ok(ok !== null, '重读后必须补上定位，实际：'
    + (editor.querySelector('.rf3-note-warn')?.textContent ?? 'none'))
  assert.equal(Boolean(btn(editor, '写入伪造').disabled), false, '补上定位后写入出口必须可用')
})

test('新会话空快照的提示：在线说「还没登记进会话」，落盘才说「还没落盘过」', async () => {
  // 两句提示对应两个完全不同的原因，混用会让用户去重启一个根本没坏的会话。
  const liveCase = setup({ mode: 'live', blocks: [] })
  const liveMod = loadPlugin(liveCase.doc, liveCase.win, liveCase.fetchImpl)
  liveMod.apply({ effect: () => {} })
  await tick(); liveCase.flush()
  const liveEditor = openEditor(liveCase.msg)
  // 打开时编辑器会先补读一次（那一刻显示「正在重新读取…」），等它落定再看文案。
  await tick(); await tick(); liveCase.flush()
  assert.ok(liveEditor.textContent.includes('还没把这条回复登记进会话'),
    '在线空快照要讲清楚是「宿主还没登记」，实际：' + liveEditor.textContent)
  assert.equal(liveEditor.textContent.includes('会话记录里没有可定位的助手正文'), false,
    '在线空快照不该套用落盘那句话')

  const diskCase = setup({ mode: 'disk', blocks: [] })
  const diskMod = loadPlugin(diskCase.doc, diskCase.win, diskCase.fetchImpl)
  diskMod.apply({ effect: () => {} })
  await tick(); diskCase.flush()
  const diskEditor = openEditor(diskCase.msg)
  assert.ok(diskEditor.textContent.includes('会话记录里没有可定位的助手正文'),
    '落盘空清单保留原提示，实际：' + diskEditor.textContent)
})

test('写入方式：默认自动，三选项齐备', async () => {
  const { doc, win, flush, msg, fetchImpl } = setup()
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-mode')
  assert.ok(sel !== null, '编辑器必须有「写入方式」下拉框')
  const values = [...sel.children].map(o => o.value)
  assert.deepEqual(values, ['auto', 'live', 'disk'], '两种模式都要能显式选到')
  assert.equal(sel.value, 'auto', '默认必须是自动')
  assert.equal(editor.textContent.includes('自动：'), true, '默认要说明自动的含义')
})

test('写入方式：选「仅在线」→ 提示变、载荷 prefer=live', async () => {
  const { doc, win, flush, msg, fetchImpl, calls } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'live', eventSeq: 5 },
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-mode')
  sel.value = 'live'
  sel.dispatch('change')
  assert.ok(editor.textContent.includes('仅在线'), '提示要跟着选择变，实际：' + editor.textContent)

  editor.querySelector('textarea').value = '只走在线的一条'
  forgeOnce(editor)
  await tick(); flush()
  const post = calls.find(c => c.url.includes('/session/forge'))
  assert.equal(JSON.parse(post.init.body).prefer, 'live', '用户选了只在线就必须只在线')
})

test('写入方式：选「仅落盘」→ 载荷 prefer=disk，且在线成功也不冒充', async () => {
  const { doc, win, flush, msg, fetchImpl, calls, confirmCalls } = setup({
    mode: 'live',
    forgeResult: { ok: true, mode: 'disk', liveCode: null, backup: '/tmp/x.bak-forge-2', verify: { events: 3, blocks: 1 } },
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-mode')
  sel.value = 'disk'
  sel.dispatch('change')
  assert.ok(editor.textContent.includes('仅落盘'), '提示要跟着选择变，实际：' + editor.textContent)
  assert.ok(editor.textContent.includes('在内存里'), '要提醒用户：这个会话其实在内存里，落盘得等重新载入')

  editor.querySelector('textarea').value = '只走落盘的一条'
  // 第一步点击先截住确认行，确认文案必须复述用户选的那条路
  const diskBtn = btn(editor, '写入伪造')
  diskBtn.click()
  await tick(); flush()
  const confirmNote = [...editor.querySelectorAll('.rf3-note-warn')]
    .map(n => n.textContent).find(t => t.includes('确认写入伪造'))
  assert.ok(confirmNote !== undefined, '第一次点击必须出页面内确认行')
  assert.ok(confirmNote.includes('仅落盘'), '确认文案要复述用户选的那条路，实际：' + confirmNote)
  diskBtn.click()
  await tick(); flush()
  const post = calls.find(c => c.url.includes('/session/forge'))
  assert.equal(JSON.parse(post.init.body).prefer, 'disk', '用户选了只落盘就必须只落盘')
  assert.ok(msg.textContent.includes('下次载入时生效'), '落盘结果必须如实说明何时生效')
})

test('写入方式：选「仅在线」但会话不在内存里 → 宿主拒绝，如实报错不偷偷落盘', async () => {
  const { doc, win, flush, msg, fetchImpl, dispatch } = setup({
    forgeResult: {
      ok: false, code: 'SESSION_NOT_LIVE',
      error: '这个会话当前不在内存里（未打开或已关闭），只能走落盘写入',
    },
  })
  const mod = loadPlugin(doc, win, fetchImpl)
  mod.apply({ effect: () => {} })
  await tick(); flush()
  const editor = openEditor(msg)
  const sel = editor.querySelector('.rf3-mode')
  sel.value = 'live'
  sel.dispatch('change')
  editor.querySelector('textarea').value = '会话不在内存里时的在线写入'
  forgeOnce(editor)
  await tick(); flush()
  const warn = editor.querySelectorAll('.rf3-note-warn').find(n => n.textContent.includes('不在内存里'))
  assert.ok(warn !== undefined, '必须如实报出失败原因，实际：'
    + JSON.stringify(editor.querySelectorAll('.rf3-note-warn').map(n => n.textContent)))
})

// 执行（异步：落盘链路要走 promise）
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
console.log(failed === 0 ? '\n全部通过（' + tests.length + '）' : '\n失败 ' + failed + ' / ' + tests.length)
process.exit(failed === 0 ? 0 : 1)
