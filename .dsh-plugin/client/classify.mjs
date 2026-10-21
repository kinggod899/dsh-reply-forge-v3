// 块分类器：判断一个候选容器是不是「可安全编辑的纯自然语言块」。
//
// 方案2（只允许编辑自然语言部分）的落地就靠这里。宿主不暴露块类型标记，
// 所以按内容特征判定：容器里出现宿主生成的 chrome（工具/批准卡片的交互控件、
// 用量/费用页脚）或形态像命令/结构化数据时，整块拒绝接管——绝不提供编辑入口。
// 注意**不再**靠「工具调用」这类词汇认工具块：真实宿主根本不在助手正文里
// 渲染工具调用（asar 证据见文件头 2026-10-21 条），词汇匹配只会误伤讨论
// 工具的自然语言。
//
// 为什么整块拒绝而不是局部编辑：助手消息的一个「块」在会话记录里是一个
// 原子单元，改动其中一段会让整条记录与渲染错位。宁可不接管，也不错改。
//
// 真实会话全量回归（数十个会话、五百余个 assistant text 块）修正的
// 过拟合防线——旧规则把大量正常自然语言回复误挡在编辑入口外：
//   - 'diff' 是 "different/difficult" 的子串、'patch' 命中普通技术叙述、
//     'arguments' 命中英文常用词——裸子串匹配不可用，已删除这三项；
//   - ACTION_TAGS 里的 code/pre/table 把「带内联代码的回复」整块拒掉
//     （实测约占四成，开发向会话过半中招）。markdown 容器里出了代码
//     也只是助手的正文文本，就地编辑只动本机渲染，无记录错位风险，
//     真正需要防的 tool/result 块由 picker 的节点/容器策略 + 关键词兜底；
//   - 文本与形态检查改为先剥离代码围栏/行内代码再匹配——命令示例写进
//     回复正文不该连带整条回复被拒；
//   - 命令行旗标正则要求行首（旧 /\s--?[a-z]/ 命中 " - yes" 这类散文），
//     裸 JSON 要求整篇匹配（旧 /m 版命中多行文本里任意一行的 [..]。
//
// 2026-10-21 再砍一刀词汇表（真机 bug 五修）：**工具/文件/批准一族的文字
// 标记全部删除**。证据链：
//   1. 真实桌面端宿主（app.asar 内 dsh-client-ui-chat）的 AssistantMarkdown
//      对 `case "tool-call": break;`——工具调用块在助手正文里**根本不渲染**，
//      正文容器只可能出现 text / reasoning / image / unknown 块；
//   2. 工具调用/结果/批准都是**独立的 chat.node**，由各自的卡片渲染，
//      不经过 markdown 容器路径；批准卡片带真按钮，由 ACTION_TAGS 结构检查
//      拦（豁免只给代码块外壳，见下）；
//   3. 真机复现（session-8adcb914-…）：一条 3641 字的技术分析回复因为正文里
//      **讨论了**「工具调用」三个字被整条拒绝，页面没有编辑入口——而「改
//      思维链/改已说的话」正是本插件的主功能，技术讨论提到工具再正常不过。
// 剩下唯一保留的文字标记是宿主**用量/费用页脚**（2026-10-17 无头诊断复现：
// 页脚文本更新后会被渲染成 markdown 容器形状，必须靠文字认出它）——它是宿主
// 生成的 chrome，不是模型输出，词汇精确、无散文误伤。

/** 宿主生成的结构化文字：目前只剩用量/费用页脚（见文件头 2026-10-21 条）。 */
const ACTION_TEXT = [
  // 宿主的用量/费用页脚（每轮回复后自动追加的 chat.node）：它不是模型消息，
  //  forged 它毫无意义，还会把「最后一条」之类的启发式带偏。真机复现
  //  （2026-10-17 无头诊断）：页脚文本更新后被渲染成 markdown 容器形状，
  //  兜底被接管。这几个词对助手正文是安全方向——误伤只是少个入口。
  '本轮费用', '未定价用量', '单价单位为每百万',
]

/** 结构性元素：交互控件（代码/表格不再拒绝，见文件头说明）。 */
const ACTION_TAGS = new Set(['button', 'input', 'select', 'textarea', 'iframe'])

/** 插件自身注入的 UI 容器——分类时必须忽略，否则按钮会被自己挡回去。 */
const OWN_UI_SELECTOR = '.rf3-bar, .rf3-editor'

/**
 * 宿主代码块的「外壳」：围栏代码块渲染时自带语言 banner 和**复制按钮**
 * （宿主语义类名与 data 属性，非构建期哈希）。这些 button 是宿主代码块
 * 的固定 UI，不是消息内容里的交互控件。
 *
 * 真机 bug（2026-10-20，session-25eecb09-67c5-41e6-b5a5-8259dd11c898）：
 * 一条含围栏代码块的复盘回复整条没有编辑入口，而在别的消息的编辑器里
 * 能调出它——根因就是 ACTION_TAGS 里的 'button' 把代码块 banner 的复制
 * 按钮当成「结构化动作」，连带整条自然语言正文被拒。与文件头记录的
 * 「code/pre 误伤带内联代码的回复」是同一类过拟合，只是换了个标签名。
 */
const CODE_CHROME_SELECTOR = '[data-code-block-banner], .md-code-block'

/** 命令/路径形态：先剥离代码再匹配。 */
const ACTION_SHAPE = [
  /^[A-Za-z]:\\/m,                       // Windows 绝对路径（行首）
  /^\/(?:Users|home|usr|etc|var|opt)\//m, // Unix 绝对路径（行首）
  /^\s*--?[a-z][a-z0-9-]{2,}/m,          // 命令行旗标（行首）
  /^\s*[{[][\s\S]*[\]}]\s*$/,            // 整篇就是裸 JSON
  /\$\s+\S+/,                            // shell 提示符
]

/**
 * 剥离代码围栏与行内代码：命令/路径示例写在回复正文里是常态，
 * 不该连带整条回复被判「形态像命令」。
 * @param {string} text
 * @returns {string}
 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
}

/**
 * 判定一个容器是否为可编辑的纯自然语言块。
 * @param {Element} el 候选容器
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyNaturalLanguage(el) {
  if (el === null || el === undefined) return { ok: false, reason: '空节点' }

  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return { ok: false, reason: '空文本' }

  // 1. 文字痕迹命中：直接拒绝（对剥离代码后的文本匹配）
  const lower = stripCode(text).toLowerCase()
  for (const marker of ACTION_TEXT) {
    if (lower.includes(marker.toLowerCase())) {
      return { ok: false, reason: '含结构化动作痕迹：' + marker }
    }
  }

  // 2. 结构性元素：交互控件一律拒绝。两类豁免：
  //    - 插件自身注入的 UI（OWN_UI_SELECTOR）；
  //    - 宿主代码块外壳的复制按钮（CODE_CHROME_SELECTOR，围栏代码块 banner）。
  //    拿不到 closest 的合成节点按老规矩保守放行，不在这里误杀。
  let structural = null
  try {
    for (const tag of ACTION_TAGS) {
      const hit = el.querySelector(tag)
      if (hit === null) continue
      if (typeof hit.closest !== 'function') continue
      if (hit.closest(OWN_UI_SELECTOR) !== null) continue
      if (hit.closest(CODE_CHROME_SELECTOR) !== null) continue
      structural = tag
      break
    }
  } catch {
    // 选择器异常按可编辑处理（保守：交给用户判断）
  }
  if (structural !== null) {
    return { ok: false, reason: '含结构性元素 <' + structural + '>' }
  }

  // 3. 形态命中：路径/命令/JSON（同样基于剥离代码后的文本）
  for (const re of ACTION_SHAPE) {
    if (re.test(stripCode(text))) return { ok: false, reason: '形态像命令或结构化数据' }
  }

  return { ok: true, reason: '纯自然语言' }
}

/**
 * 批量分类，只返回可编辑的块。
 * @param {Element[]} blocks 候选容器
 * @returns {{ editable: Element[], rejected: Array<{el: Element, reason: string}> }}
 */
export function partitionEditable(blocks) {
  const editable = []
  const rejected = []
  for (const el of blocks) {
    const verdict = classifyNaturalLanguage(el)
    if (verdict.ok) editable.push(el)
    else rejected.push({ el, reason: verdict.reason })
  }
  return { editable, rejected }
}
