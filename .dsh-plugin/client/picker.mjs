// AI 消息节点拾取。
//
// 设计约束：宿主 UI 全量使用构建期哈希 CSS 类名（如 .Kwoi6G_body），
// 任何写死类名的定位都会在下一个宿主版本失效。这里改用结构特征定位：
//   1. 锚点用宿主官方槽位属性 data-slot="main.conversation"（新版）
//      与 data-slot="conversation"（alpha.1 及更早），两者都是宿主自己
//      渲染的公开契约，不是内部实现细节；
//   2. 每条聊天节点用官方槽位 data-slot="conversation.chat.node" 定位，
//      在其子树内按「markdown 容器」形状识别助手正文；
//   3. 同一节点绝不重复接管（幂等标记属性）。
//
// 真实 UI 实测（CDP 打到的生产 DOM）修正过的教训：
//   - 旧主路径按 [class*="_body"] 找容器是**毒药**：当前宿主的
//     <hashed>_body 是整个对话滚动区（内含全部消息与工具栏按钮），
//     它会把所有真正的消息容器体在「最外层过滤」里，剩下的巨型
//     容器又被分类器的结构性检查拒绝 → 一条都接管不到。
//   - 当前宿主每条消息是一个 [data-slot="conversation.chat.node"]；
//     助手正文在 markdown 容器里（直接子元素全是 p/ul/ol/pre/…），
//     思考块是可折叠行（子元素为 span/svg，不含块级子元素），
//     用户消息是气泡（span 文本），系统/上下文注入、错误行、
//     用量行各有形状——按「块级子元素占比」全部天然区分开。
//
// 全程不修改宿主节点的结构与样式类，只追加自身属性与子节点，
// 因此不与其他插件在同一子树上的注入相互干扰。

/** 会话列锚点选择器（新版键控槽位优先，旧版兜底）。 */
export const CONVERSATION_SELECTOR = '[data-slot="main.conversation"], [data-slot="conversation"]'

/** 每条聊天节点的官方槽位（当前宿主渲染的消息列表单元）。 */
const CHAT_NODE_SELECTOR = '[data-slot="conversation.chat.node"]'

/** 块级文本标签：markdown 渲染产物的形状。 */
const BLOCK_TAGS = 'p, pre, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, table'

/** 幂等标记：已接管的节点带此属性。 */
export const TAKEN_ATTR = 'data-rf3-taken'

// 门槛从 24 降到 1：短回复（"好的"/"嗯，还醒着。要测什么，直接说。"）
// 恰恰是最常需要就地伪造的对象。容器形状判定（isMarkdownContainer）与
// 分类器已经排除掉状态行/工具栏等噪声，正文长度不再承担过滤职责。
const MIN_TEXT = 1
export { MIN_TEXT }

/** 文本长度（去空白），用于过滤状态标签与工具行。 */
function textLen(el) {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
}

/**
 * 判断是否为「markdown 正文容器」：直接子元素里块级标签占一半以上。
 * 这一形状把三类容器区分开：
 *   - 助手正文容器：子元素就是 p/ul/ol/pre…（全中）；
 *   - 思考块：可折叠行，子元素是 span/svg/div 折行（不中）；
 *   - 布局外壳：子元素是 div 嵌套（不中）。
 */
function isMarkdownContainer(el) {
  if (typeof el.matches !== 'function') return false
  const kids = [...el.children]
  if (kids.length === 0) return false
  let blocks = 0
  for (const k of kids) {
    try {
      if (k.matches(BLOCK_TAGS)) blocks += 1
    } catch {
      return false
    }
  }
  return blocks >= 1 && blocks * 2 >= kids.length
}

/**
 * 从会话根节点中挑出「助手消息块」。
 *
 * 识别策略（按可靠性排序）：
 * - 主路径：官方聊天节点槽位 [data-slot="conversation.chat.node"]
 *   子树内的 markdown 容器（见 isMarkdownContainer）；
 * - 兜底：宿主换皮、槽位不存在时，取直接含 <p> 的父容器。
 *
 * 两种路径都要求「不在输入框内、不在我们自己的 UI内」。
 *
 * @param {Element} root 会话根
 * @param {Function|null} classify 分类器，返回 {ok} 决定是否放行
 * @param {{includeTaken?: boolean}} options
 *   includeTaken=true 用于**枚举**（定位、快捷键）：已接管的块也要收进来。
 *   默认 false 用于**扫描**：已接管的跳过，避免重复挂件。
 */
export function pickAssistantBlocks(root, classify = null, options = {}) {
  if (root === null || typeof root.querySelectorAll !== 'function') return []
  const includeTaken = options.includeTaken === true
  const out = []
  const seen = new Set()

  const consider = el => {
    if (el === null || seen.has(el)) return
    if (el.closest('.rf3-editor, .rf3-bar, textarea, input') !== null) return
    // 宿主持话输入框（Lexical 宿主，恒带 data-composer-input）：草稿阶段的
    // typed 文本就在 <p> 里，兜底路径会顺着 p.parentElement 摸到它——给输入框
    // 挂一条「伪造回复」操作条纯属干扰（真机复现：新会话里字打完，输入框上
    // 多出按钮）。可编辑区一律不接管：插件改写的是已渲染的消息文本，
    // 不是用户正在输入的内容。
    if (el.closest('[data-composer-input]') !== null) return
    if (el.isContentEditable === true) return
    if (typeof el.hasAttribute === 'function' && el.hasAttribute(TAKEN_ATTR)) {
      if (includeTaken === true) {
        // 枚举用途：已接管的块照样收进来。不收的话，一旦所有块都接管完，
        // 调用方就拿到空列表——快捷键静默失效、定位接口报 0 个块。
      } else if (el.querySelector('.rf3-bar') !== null) {
        // 已接管且操作条还在 → 跳过（幂等）。
        return
      } else {
        // 已接管但操作条被宿主抹掉（流式更新原地替换子节点）→ 清标记
        // 重新接管：否则按钮会永远消失，直到整个消息节点被换新。
        el.removeAttribute(TAKEN_ATTR)
      }
    }
    seen.add(el)
    out.push(el)
  }

  // 主路径：聊天节点槽位 → markdown 容器
  let nodes = []
  try {
    nodes = [...root.querySelectorAll(CHAT_NODE_SELECTOR)]
  } catch {
    nodes = []
  }
  for (const node of nodes) {
    let containers = []
    try {
      containers = [...node.querySelectorAll('*')].filter(isMarkdownContainer)
    } catch {
      containers = []
    }
    // 节点内取最外层：嵌套的 markdown 容器（如 blockquote 内的段落）
    // 由外层代管，避免同一条消息挂多个按钮。
    const outermostInNode = containers.filter(el => !containers.some(o => o !== el && o.contains(el)))
    for (const el of outermostInNode) {
      if (textLen(el) < MIN_TEXT) continue
      consider(el)
    }
  }

  // 兜底路径：没有聊天节点槽位时（宿主换皮），取直接含段落的容器。
  // 只有主路径颗粒无收时才走这里——旧版把 _body 容器当主路径，
  // 它先塞进巨型滚动容器把兜底路径堵死，是「界面无变化」的根因。
  if (out.length === 0) {
    const paras = [...root.querySelectorAll('p')]
    for (const p of paras) {
      const host = p.parentElement
      if (host === null) continue
      if (textLen(host) < MIN_TEXT) continue
      consider(host)
    }
  }

  // 只保留最外层：若 A 包含 B，丢掉 B，避免嵌套重复挂按钮
  const outermost = out.filter(el => !out.some(other => other !== el && other.contains(el)))

  // 分类器（方案2）：只放行纯自然语言块，工具调用/结构化动作整块拒绝。
  // 未传分类器时不做限制（保持向后兼容的调用形态）。
  if (typeof classify !== 'function') return outermost
  return outermost.filter(el => classify(el).ok === true)
}

/** 会话根：优先取锚点，退化到含 main.conversation 的文档。 */
export function conversationRoot(doc = document) {
  const hit = doc.querySelector(CONVERSATION_SELECTOR)
  if (hit !== null) return hit
  // 宿主可能在 #root 之下才挂载；退回文档体但限制在 #root 内，
  // 避免接管插件自身面板等非会话区域。
  const root = doc.getElementById('root')
  return root ?? doc.body
}
