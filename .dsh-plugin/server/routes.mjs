// HTTP 路由：会话块的读、以及伪造的在线/落盘双路写（v3 host half）。
//
// 路由形态与邻居插件 dsh-tavern 的生产用法一致：
// { kind: 'exact', path, handler } + ctx.webServer.register(route)，
// handler 收原生 node req/res，自行回 JSON。POST 需要自己读 body。
//
// 依赖 src/ 下的模块，用**相对路径**导入而不是拷贝一份：v1 把 session-log.mjs
// 复制进 .dsh-plugin/server/，代价是两份代码会漂移——这正是本项目反复踩到的
// bug 类型（README 状态漂移、指纹算法漂移）。前提是插件以 junction/软链方式
// 安装到整个仓库（见 README 的安装说明）。
//
// v3 与 v2 的差别只有一处：写路由**先试在线**（活会话 + projection，立即生效），
// 拿不到活会话才退回落盘（v2 的唯一路径）。读路由同样先读活会话的投影后内容，
// 这样界面显示的与模型看见的永远是同一份。
//
// 安全边界：
//   - 读路由只读；sessionId 经 findSessionFile 的安全字符校验，目录穿越在入口拦死；
//   - 写路由要求自定义请求头 x-rf3-forge，避免同源下其它脚本误触；
//     body 有大小上限；写前做陈旧校验；落盘路径写后自读校验不过自动还原。

import {
  assistantEditableBlocks, findSessionFile, readSessionEvents,
  sessionsRootDefault, thinkingSignatureStats,
} from '../../src/session-log.mjs'
import { forgeSession } from '../../src/session-write.mjs'
import { PATCH_EVENT_TYPE, projectedTextsOf } from '../../src/patch-event.mjs'
import { versionStackOf } from '../../src/lineage.mjs'
import { forgeLive, readLiveBlocks, sessionIsLive } from './live.mjs'

/** 请求体上限：正文再长也不该超过这个量级。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 新正文上限。 */
const MAX_TEXT_CHARS = 512 * 1024

/** 允许编辑的块种类。 */
const KINDS = ['text', 'reasoning']

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** 读 POST body（JSON）。超限或非法 JSON 一律 reject。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

/** 读 URL 查询参数。 */
function query(req) {
  try { return new URL(req.url, 'http://127.0.0.1').searchParams }
  catch { return null }
}

/** 请求里的 kind 归一化：缺省 text，非法值返回 null。 */
function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return 'text'
  return KINDS.includes(value) ? value : null
}

/**
 * 注册本插件的路由。webServer 缺失（个别 profile 无该服务）时静默跳过：
 * 浏览器 half 的本机渲染能力不依赖宿主侧路由。
 * @param {{ register: Function } | undefined} webServer 宿主 webServer 服务
 * @param {object | undefined} sessions 宿主 sessions 服务（在线路径用；缺失时自动退回落盘）
 */
export function registerRoutes(webServer, sessions) {
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return

  // ── 读：助手可编辑块清单（在线优先，落盘兜底）─────────────────────────
  webServer.register({
    kind: 'exact',
    path: '/api/reply-forge-v3/session/blocks',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      const params = query(req)
      if (params === null) { json(res, 400, { ok: false, error: 'bad request url' }); return }
      const sessionId = params.get('sessionId') ?? ''
      if (sessionId === '') { json(res, 400, { ok: false, error: 'sessionId required' }); return }

      // 在线：读的是**投影后**的消息，与模型所见完全一致（含本机已伪造的部分）
      const live = readLiveBlocks(sessions, sessionId)
      if (live.ok === true) { json(res, 200, live); return }

      // 落盘兜底：会话不在内存里（未打开/已关闭），或宿主没有 sessions 服务
      const file = findSessionFile(sessionsRootDefault(), sessionId)
      if (file === null) {
        json(res, 404, { ok: false, error: 'session log not found', liveCode: live.code })
        return
      }
      try {
        const events = readSessionEvents(file)
        // UI 只需要「能定位」：seq + 块索引 + 原文。不回传指纹——浏览器
        // 用不上它（它改用 seq 寻址），少传一份就少一处不一致。
        const rawBlocks = assistantEditableBlocks(events, KINDS)
        // 落盘读取也要过投影：文件里可能有本插件此前的在线伪造（被宿主持久化
        // 落盘的 reply-forge/patch 事件）。不应用它们，磁盘读到的「原文」就与
        // 模型实际看到的投影后文本不一致—— expectText 拿旧文本当基准，会被
        // 在线路径的陈旧校验拒掉（真机 2026-10-17：会话重启后写入全被 STALE 拒）。
        const projected = projectedTextsOf(events)
        const blocks = rawBlocks.map(b => {
          const byBlock = projected.get(b.seq)
          const text = byBlock === undefined ? undefined : byBlock.get(b.blockIndex)
          return text === undefined ? b : { ...b, text }
        })
        const patched = []
        for (const [seq, byBlock] of projected) {
          for (const blockIndex of byBlock.keys()) patched.push({ seq, blockIndex })
        }
        json(res, 200, {
          ok: true,
          mode: 'disk',
          liveCode: live.code,
          sessionId,
          file: String(file),
          events: events.length,
          total: blocks.length,
          blocks,
          patched,
          signatures: thinkingSignatureStats(events),
        })
      } catch (error) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // ── 读：版本血统（v3.4，只读，按需）──────────────────────────────────
  // 为什么单独一个路由而不是塞进 blocks 响应：blocks 是编辑器每次打开都会
  // 拉的，血统要回传每个版本全文（可能很大），且只有点开「历史版本」才
  // 需要——分开拉，热路径上一个字节都不多付。只读路由，不需要 x-rf3-forge
  // 自定义头（与 blocks 同一条安全边界：sessionId 过安全字符校验）。
  //
  // 数据全部从落盘事件推导（src/lineage.mjs）：原稿在原始事件里、patch 链
  // 按事件顺序堆叠。**不走 live**——活会话的事件遍历要碰宿主内部 API，
  // 而磁盘副本就是持久化的同一份（在线写入最终同样落进 session.vN）。
  // 已知代价：刚刚完成的在线写入落盘有约数百毫秒滞后，此刻读血统可能
  // 差最后一版；UI 已在面板脚注如实说明。
  webServer.register({
    kind: 'exact',
    path: '/api/reply-forge-v3/session/lineage',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      const params = query(req)
      if (params === null) { json(res, 400, { ok: false, error: 'bad request url' }); return }
      const sessionId = params.get('sessionId') ?? ''
      if (sessionId === '') { json(res, 400, { ok: false, error: 'sessionId required' }); return }
      // seq/blockIndex 必须显式给出：Number(null) 是 0，缺参会悄悄变成
      // 「第 0 块」这种看似合法的查询——参数校验漏一个，UI 就可能读到
      // 别的块的血统还以为是这条的。
      const seqRaw = params.get('seq')
      const blockRaw = params.get('blockIndex')
      if (seqRaw === null || seqRaw === '' || blockRaw === null || blockRaw === '') {
        json(res, 400, { ok: false, error: 'seq and blockIndex required' }); return
      }
      const seq = Number(seqRaw)
      const blockIndex = Number(blockRaw)
      if (Number.isSafeInteger(seq) === false || seq < 0
        || Number.isSafeInteger(blockIndex) === false || blockIndex < 0) {
        json(res, 400, { ok: false, error: 'seq and blockIndex must be non-negative integers' }); return
      }
      const kind = normalizeKind(params.get('kind'))
      if (kind === null) { json(res, 400, { ok: false, error: 'kind must be text or reasoning' }); return }

      const file = findSessionFile(sessionsRootDefault(), sessionId)
      if (file === null) { json(res, 404, { ok: false, error: 'session log not found' }); return }
      try {
        const events = readSessionEvents(file)
        const stack = versionStackOf(events, seq, blockIndex, kind)
        if (stack.ok !== true) {
          // 业务失败一律 200 + ok:false + code：UI 要拿 code 出文案。
          json(res, 200, {
            ok: false,
            code: stack.reason,
            error: stack.reason === 'kind-mismatch'
              ? '这个块的种类与请求不符（可能是思维链/正文选反了）'
              : '会话记录里找不到这条回复的原始事件（会话可能被压缩改写掉）',
          })
          return
        }
        json(res, 200, {
          ok: true,
          mode: 'disk',
          sessionId,
          file: String(file),
          seq,
          blockIndex,
          kind: stack.kind,
          versions: stack.versions,
          currentIndex: stack.currentIndex,
        })
      } catch (error) {
        json(res, 500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  // ── 写：伪造一条助手块。先在线（立即生效），落盘兜底（v2 路径）────────
  webServer.register({
    kind: 'exact',
    path: '/api/reply-forge-v3/session/forge',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      // 自定义头挡住「同源下别的脚本顺手 POST 一下」这种误触。
      if (req.headers['x-rf3-forge'] !== '1') {
        json(res, 403, { ok: false, error: 'missing x-rf3-forge header' })
        return
      }
      readBody(req).then(body => {
        try {
          const b = (body === null || typeof body !== 'object') ? {} : body
          const sessionId = typeof b.sessionId === 'string' ? b.sessionId : ''
          if (sessionId === '') { json(res, 400, { ok: false, error: 'sessionId required' }); return }
          if (typeof b.newText !== 'string' || b.newText.trim() === '') {
            json(res, 400, { ok: false, error: 'newText required' }); return
          }
          if (b.newText.length > MAX_TEXT_CHARS) {
            json(res, 413, { ok: false, error: 'newText too long' }); return
          }
          if (typeof b.seq !== 'number' || typeof b.blockIndex !== 'number') {
            json(res, 400, { ok: false, error: 'seq and blockIndex required' }); return
          }
          const kind = normalizeKind(b.kind)
          if (kind === null) { json(res, 400, { ok: false, error: 'kind must be text or reasoning' }); return }
          const prefer = b.prefer === 'live' || b.prefer === 'disk' ? b.prefer : 'auto'
          const expectText = typeof b.expectText === 'string' ? b.expectText : undefined
          let liveCode = null

          // ── 在线路径 ───────────────────────────────────────────────
          if (prefer !== 'disk') {
            const live = forgeLive(sessions, { sessionId, seq: b.seq, blockIndex: b.blockIndex, kind, newText: b.newText, expectText })
            if (live.ok === true) { json(res, 200, live); return }
            if (prefer === 'live') { json(res, 200, live); return }
            // auto 模式只对这三类退回落盘：
            //   SESSION_NOT_LIVE / NO_SESSIONS_SERVICE —— 会话不在内存里，在线本来就不成立；
            //   WRITER_NOT_ROUTED —— 会话在内存里，但宿主持久化没有它的写句柄
            //     （没在跟这个会话）：在线 append 不会落盘，且**没有并发写者**，
            //     回落盘安全。
            // 明确**不**回落盘的：
            //   APPEND_UNSAFE —— 会话活着且宿主持久化在跟它，但没法确认 ignorable
            //     一定补上。此时直接改盘有内存/文件并发覆盖风险（宿主写句柄还开着，
            //     它的缓冲事件稍后照样往磁盘追加）。一律拒绝，由用户先关闭该会话
            //     或退出 DSH，再显式选择落盘。详见 ignorable.mjs 文件头「为什么要
            //     按会话核验」。
            // 其余（陈旧、被遮蔽、种类不符、追加被拒）是**真实业务失败**，更不能
            // 悄悄去改文件——那会让用户以为改的是这条消息，实际改的是别的。
            if (live.code !== 'SESSION_NOT_LIVE' && live.code !== 'NO_SESSIONS_SERVICE' && live.code !== 'WRITER_NOT_ROUTED') {
              json(res, 200, live); return
            }
            liveCode = live.code
          }

          // ── 落盘路径（v2 原路径）────────────────────────────────────
          const file = findSessionFile(sessionsRootDefault(), sessionId)
          if (file === null) { json(res, 404, { ok: false, error: 'session log not found' }); return }

          // 活会话直接改盘有并发覆盖风险（宿主写句柄还开着，缓冲事件稍后
          // 照样往磁盘追加）。显式选择落盘时放行，但必须在响应里标注，
          // 让 UI 明确告知用户「这个会话正开着」。
          const liveRisk = sessionIsLive(sessions, sessionId)

          const result = forgeSession(file, {
            seq: b.seq,
            blockIndex: b.blockIndex,
            kinds: [kind],
            newText: b.newText,
            // 陈旧校验：UI 看到的那份原文必须与磁盘当前一致。
            expectText,
            strategy: 'preserve',
            stripScope: typeof b.stripScope === 'string' ? b.stripScope : 'same-event',
          })
          json(res, 200, {
            ok: true,
            mode: 'disk',
            liveCode,
            liveRisk,
            liveWarning: liveRisk === true
              ? '这个会话正在 DSH 里开着；直接改写磁盘有并发覆盖风险，建议先关闭该会话（或退出 DSH）再写入。'
              : undefined,
            sessionId,
            file: String(file),
            target: { seq: b.seq, blockIndex: b.blockIndex, kind },
            stripped: result.stripped,
            backup: result.backup,
            verify: result.verify,
          })
        } catch (error) {
          // 业务失败一律 200 + ok:false：UI 要拿 code/actual 做分支，
          // 而不是解析 HTTP 状态码。
          json(res, 200, {
            ok: false,
            error: String((error && error.message) || error),
            code: typeof error?.code === 'string' ? error.code : null,
            actual: typeof error?.actual === 'string' ? error.actual : null,
            backup: typeof error?.backup === 'string' ? error.backup : null,
          })
        }
      }).catch(error => {
        json(res, 400, { ok: false, error: String((error && error.message) || error) })
      })
    },
  })
}
