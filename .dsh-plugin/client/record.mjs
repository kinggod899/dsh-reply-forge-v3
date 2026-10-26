// 会话落盘记录的浏览器侧访问层。
//
// 为什么需要它：UI 只能看到**渲染后的 DOM 文本**，而落盘记录里是 markdown
// 源码，两者对不上（`**粗体**` 在页面上是「粗体」，`# 标题` 是「标题」）。
// 写入器用 sha256 指纹寻址，浏览器算不出同一个值——所以落盘定位改走
// 「事件 seq + 块索引」：这两个值由只读路由从磁盘原样带出来，与内容无关。
//
// 本模块的职责就是**把页面上看到的块，对上磁盘里的块**：
//   1. 精确匹配：规范化空白后全等（绝大多数纯自然语言回复都走这条）；
//   2. 末尾对齐兜底：宿主只渲染最近若干条时，磁盘块比 DOM 块多，
//      两边各取尾部按序一一对应，并标记为「推断」（exact: false）——
//      UI 必须把这个不确定性显式告诉用户，不能装作确定。
// 对不上的块返回 null，让编辑器禁用落盘出口，而不是猜一个位置去写。
//
// 零依赖、纯 ESM（构建契约：只能用相对导入，不得引入外部包）。

const ROUTE = '/api/reply-forge-v3/session/blocks'

/** 会话级缓存：sessionId → { at, mode, file, blocks, error, domSignature }。 */
const cache = new Map()

/** 规范化空白：与写入器指纹算法的第一步一致，但**不**做哈希。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 页面可见块的「签名」：块数 + 全部正文的哈希。
 *
 * 为什么要签名而不是只比块数：在线模式的记录是**内存快照**，它的过期
 * 判据不是「落盘还没跟上」，而是「这份快照是不是还等于页面」。
 * 新会话里宿主往往先把回复渲染进 DOM、稍后才把它登记进活会话——
 * 这一刻读到的快照是「一个块都没有」，只比块数根本发现不了它已经过期
 * （页面块数 > 0 > 快照块数 是能发现，但反过来页面 1 块、快照 0 块也算
 * 「多」，所以块数判据其实能发现；真正发现不了的是**块数没变、正文变了**：
 * 流式输出中途读到的快照，块数与最终一致，正文却还在长）。
 *
 * 哈希遍历**整段**正文而不是只取首尾：截断省下的那点时间远小于
 * `normalizeText` 自身的开销（它已经把整段扫过一遍了），而截断会漏掉
 * 「长度不变、只改了中间或末尾一个字符」这种变化——签名一旦漏判，
 * 记录就被当成最新的，用户看到的就是永久定位不上。
 *
 * @param {string[]} texts 页面上按顺序的助手正文
 * @returns {string} 可直接用 === 比较的签名
 */
export function domSignatureOf(texts) {
  const list = Array.isArray(texts) ? texts : []
  let hash = 2166136261
  for (const text of list) {
    const norm = normalizeText(text)
    hash = Math.imul(hash ^ norm.length, 16777619)
    for (let i = 0; i < norm.length; i += 1) hash = Math.imul(hash ^ norm.charCodeAt(i), 16777619)
  }
  return list.length + ':' + (hash >>> 0).toString(36)
}

/**
 * 拉取（或取缓存的）会话可编辑块。
 *
 * v3 起宿主侧有两条读路径，响应里的 `mode` 区分：
 *   - `live`：会话在内存里，读的是**投影后**的消息——与模型当前所见完全一致
 *     （含本机已伪造的部分）。写入立即生效，不用重启。
 *   - `disk`：会话不在内存里，读的是落盘记录。写入落到磁盘，该会话下次被
 *     载入时才生效。
 * 界面必须把这个区别显式告诉用户——「要不要重启」是用户最关心的一件事。
 *
 * @param {string} sessionId
 * @param {{force?: boolean, domSignature?: string}} options
 *   force=true 时绕过缓存；domSignature 是**本次拉取时**页面长什么样——
 *   只有真正发了请求才会记下它，缓存命中时刻意不更新（否则签名会随着
 *   每次「看一眼」被刷新，过期判定永远不触发）。
 * @returns {Promise<{at:number,mode:string,file:string|null,blocks:Array,patched:Array,error:string|null,liveCode:string|null,domSignature:string|null}>}
 */
export async function loadRecord(sessionId, options = {}) {
  const force = options.force === true
  const signature = typeof options.domSignature === 'string' ? options.domSignature : null
  if (force !== true) {
    const hit = cache.get(sessionId)
    if (hit !== undefined) return hit
  }
  const entry = {
    at: Date.now(), mode: 'disk', file: null, blocks: [], patched: [],
    error: null, liveCode: null, domSignature: signature,
  }
  try {
    const res = await fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId))
    const data = await res.json()
    if (data === null || typeof data !== 'object' || data.ok !== true) {
      entry.error = String((data && data.error) || ('HTTP ' + res.status))
      entry.liveCode = typeof data?.liveCode === 'string' ? data.liveCode : null
    } else {
      entry.mode = data.mode === 'live' ? 'live' : 'disk'
      entry.file = typeof data.file === 'string' ? data.file : null
      entry.blocks = Array.isArray(data.blocks) ? data.blocks : []
      entry.patched = Array.isArray(data.patched) ? data.patched : []
      entry.liveCode = typeof data.liveCode === 'string' ? data.liveCode : null
    }
  } catch (error) {
    entry.error = String((error && error.message) || error)
  }
  cache.set(sessionId, entry)
  return entry
}

/** 取已缓存的记录（没拉过返回 null，不触发请求）。 */
export function cachedRecord(sessionId) {
  return cache.get(sessionId) ?? null
}

/** 丢弃缓存（不传 sessionId 清全部）。 */
export function resetCache(sessionId) {
  if (sessionId === undefined) cache.clear()
  else cache.delete(sessionId)
}

/**
 * 缓存里的记录是否「可能比页面旧」——需要重读的信号。
 *
 * 为什么需要这个判断：本模块的缓存只在四种时候失效——首次拉起、写入成功、
 * 用户点「重新读取」、以及这里的自动重读。而会话是**持续增长**的：宿主把新
 * 回复渲染进 DOM 之后才登记进会话，本插件的缓存却不会自己更新。于是
 * 「伪造掉第一条回复之后，后面每一条新回复都拿着旧快照去比对，一律提示
 * 对不上」——2026-10-15 真机踩到的坑。
 *
 * 两条路径的过期判据**不一样**，混用会出两种错：
 *
 * - **落盘（disk）**：判据是「页面块数 > 记录块数」。宿主落盘滞后约 200ms，
 *   且页面永远 ≤ 记录（历史可能被虚拟化折叠，记录反而更多），所以这个信号
 *   单调、不误报。注意**不能**用签名——正文在流式输出期间每帧都变，会把
 *   读记录打成高频请求，而每次读都要解压整个会话文件。
 *
 * - **在线（live）**：判据是「页面签名 ≠ 拉取时的页面签名」。在线读的是内存
 *   里的投影结果，没有落盘滞后，但**新会话必然踩一次空快照**：宿主先渲染、
 *   后登记，这一刻读到 blocks=[]，块数判据的结论是「页面 1 块 > 记录 0 块」
 *   → 会重读（这点没问题），可一旦块数相同而正文还在长（流式输出中途那次
 *   读取），块数判据就永远发现不了。2026-10-16 真机就是它：**新会话全程提示
 *   「会话记录里没有可定位的助手正文」**，而老会话（打开时内容早已齐备）一切
 *   正常。改成签名比较后，正文一变就重读，读完签名对齐即收敛。
 *
 * 空快照另外单列一条：live 且 blocks 为空时一律可疑。这是为了兜住「流式文本
 * 恰好停在最终值、事件却还没登记」这个竞态——此时签名相同，只有「空」这个
 * 事实本身还能当信号。重读次数由调用方的退避计数器兜底（拿不到新块就停手，
 * 页面再次变化会解除退避）。
 *
 * @param {{blocks:Array,mode?:string,error:string|null,domSignature?:string|null}|null|null|undefined} entry
 *   cachedRecord 的返回值
 * @param {number} domBlockCount 页面上拾取到的助手正文块数
 * @param {string} [signature] domSignatureOf(页面正文数组) 的结果
 * @returns {boolean} true = 该重读
 */
export function recordNeedsRefresh(entry, domBlockCount, signature) {
  if (!(domBlockCount > 0)) return false
  if (entry === null || entry === undefined) return true
  if (entry.error !== null && entry.error !== undefined) return true
  if (entry.mode === 'live') {
    // 空快照：宿主还没把这条回复登记进活会话（新会话/流式输出中都这样）。
    if (entry.blocks.length === 0) return true
    if (typeof signature !== 'string') return false
    if (typeof entry.domSignature !== 'string') return true
    return entry.domSignature !== signature
  }
  return domBlockCount > entry.blocks.length
}

/**
 * 把 DOM 块与磁盘块配对。
 *
 * `options.canonical` 是「记录文本 → 可与页面文本直接比较的形态」的规范化
 * 函数。落盘块里是 markdown **源码**，页面 DOM 里是**渲染结果**，两者只在
 * 完全不带格式的回复上才碰巧相等；带 `**加粗**` / `## 标题` / 行内代码的
 * 回复一律对不上，精确匹配形同虚设、全部退化成顺序推断（2026-10-23 真机：
 * 长回复的写入打到了别的块上）。调用方（client/index.mjs）传入「用插件
 * 自己的渲染器渲染一遍再取文本」的实现，两边就落在同一口径上。
 * 不传时按原样比较——record.mjs 保持零 DOM 依赖，纯逻辑可单测。
 *
 * 两种形态**都**入索引（源码原文 + 渲染后文本），命中任一即算精确匹配。
 * 只加渲染形态会误伤思维链这类纯文本块：宿主可能按纯文本渲染，源码里的
 * `- ` / `#` 在页面上原样可见，规范化反倒把它们抹掉、从此对不上。
 *
 * `block.rawText`（**未投影**的磁盘原文）也必须入索引——2026-10-26 BUG-8：
 * 读路由给的 `text` 是**投影后**的文本，宿主 UI 却不渲染投影，所以刷新后页面
 * 上是被伪造块的**原文**。只拿 `text` 建索引 → 被伪造过的块永远精确匹配不上
 * → 落到末尾对齐兜底（推断）→ 一旦有新消息到达，新消息的块被错配到旧块上
 * → 新消息显示上一条的伪造内容、还挂着「还原」按钮。
 * 把 rawText 也入索引，被伪造的块就能凭原文精确对回自己，兜底不再被误用。
 *
 * @param {Array<{seq:number|null,blockIndex:number,text:string,rawText?:string}>} diskBlocks 只读路由给的落盘块
 * @param {string[]} domTexts 页面上按顺序的块文本
 * @param {{canonical?: (text:string)=>string}} [options]
 * @returns {Array<{seq:number|null,blockIndex:number,text:string,exact:boolean}|null>}
 *   与 domTexts 等长；对不上的位置是 null。
 */
export function matchBlocks(diskBlocks, domTexts, options = {}) {
  const canonical = typeof options.canonical === 'function' ? options.canonical : null
  /** 一个记录块可能匹配的键：投影文本 / 未投影原文，各带（可选）渲染后形态。 */
  const keysOf = block => {
    const out = []
    const push = text => {
      if (typeof text !== 'string') return
      const raw = normalizeText(text)
      if (raw !== '' && out.includes(raw) === false) out.push(raw)
      if (canonical === null) return
      const rendered = canonical(text)
      // 规范化失败（渲染不出来）时只留源码键，别把整块当成空串。
      if (rendered === '') return
      const norm = normalizeText(rendered)
      if (norm !== '' && out.includes(norm) === false) out.push(norm)
    }
    push(block.text)
    if (block.rawText !== block.text) push(block.rawText)
    return out.length === 0 ? [normalizeText(block.text)] : out
  }
  const out = domTexts.map(() => null)
  const used = new Set()
  const domNorm = domTexts.map(normalizeText)

  // ── 1) 精确匹配：规范化后全等。同名多条按出现顺序一一对应。 ──────────────
  const byText = new Map()
  diskBlocks.forEach((b, i) => {
    for (const key of keysOf(b)) {
      if (!byText.has(key)) byText.set(key, [])
      byText.get(key).push(i)
    }
  })
  domNorm.forEach((key, di) => {
    if (key === '') return
    const list = byText.get(key)
    if (list === undefined) return
    // 跳过已被前面同文本块占用掉的候选（一个记录块可能挂在多个键下，
    // 占用位未必在队首，所以用 findIndex 找第一个还没被占的）。
    const pos = list.findIndex(i => used.has(i) === false)
    if (pos < 0) return
    const bi = list.splice(pos, 1)[0]
    used.add(bi)
    out[di] = { ...diskBlocks[bi], exact: true }
  })

  // ── 2) 末尾对齐兜底 ────────────────────────────────────────────────────
  // 页面上往往只有最近若干条（历史被虚拟化/折叠），磁盘块更多。
  // 两侧各取未配对的尾部，按顺序一一对应。这是**推断**，不是事实，
  // 所以 exact: false，UI 要如实标注。
  const domLeft = []
  out.forEach((v, i) => { if (v === null) domLeft.push(i) })
  const diskLeft = diskBlocks.map((_, i) => i).filter(i => used.has(i) === false)
  const n = Math.min(domLeft.length, diskLeft.length)
  for (let k = 1; k <= n; k += 1) {
    const di = domLeft[domLeft.length - k]
    const bi = diskLeft[diskLeft.length - k]
    out[di] = { ...diskBlocks[bi], exact: false }
  }
  return out
}

/**
 * 执行伪造写入（POST 到 host half）。
 *
 * `prefer` 交给宿主决定走哪条路：
 *   - `auto`（默认）：先试在线（立即生效），会话不在内存里才落盘；
 *   - `live`：只在线；
 *   - `disk`：只落盘。
 * 响应里的 `mode` 说明实际用了哪条路，界面据此告诉用户「要不要重启」。
 *
 * @param {{sessionId:string,seq:number,blockIndex:number,kind?:string,newText:string,
 *          expectText?:string,prefer?:'auto'|'live'|'disk'}} payload
 * @returns {Promise<{ok:boolean,mode?:string,eventSeq?:number,liveCode?:string,backup?:string,
 *          verify?:object,stripped?:number,error?:string,code?:string,actual?:string,detail?:string}>}
 */
export async function forgeRecord(payload) {
  try {
    const res = await fetch('/api/reply-forge-v3/session/forge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 自定义头：挡住「同源下别的脚本顺手 POST 一下」这种误触。
        // host half 会校验它，缺了直接 403。
        'x-rf3-forge': '1',
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data === null || typeof data !== 'object') return { ok: false, error: 'HTTP ' + res.status }
    return data
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}
