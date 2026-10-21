window.__ModuleLoader__.load({
	id: "dsh-reply-forge-v3",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __m_dsh_plugin_client_styles_mjs = (function(){ 



const CSS = `
.rf3-btn{
  display:inline-flex;align-items:center;gap:4px;
  height:22px;padding:0 8px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  background:transparent;color:inherit;
  font:inherit;font-size:12px;line-height:1;
  cursor:pointer;opacity:.55;
  transition:opacity .12s, background-color .12s;
  white-space:nowrap;user-select:none;
}
.rf3-btn:hover{opacity:1;background:color-mix(in srgb, currentColor 8%, transparent)}
.rf3-btn:focus-visible{outline:2px solid color-mix(in srgb, currentColor 60%, transparent);outline-offset:1px}
.rf3-btn[data-active]{opacity:1;border-color:color-mix(in srgb, #e0a34a 60%, transparent);color:#e0a34a}

/* 悬浮操作条：绝对定位于消息容器内部，不参与文档流，不改动宿主布局 */
.rf3-bar{
  position:absolute;top:2px;right:6px;z-index:5;
  display:inline-flex;gap:4px;align-items:center;
  opacity:0;pointer-events:none;
  transition:opacity .14s;
}
.rf3-host:hover > .rf3-bar,
.rf3-host:focus-within > .rf3-bar,
.rf3-bar:focus-within{opacity:1;pointer-events:auto}

/* 消息容器需要定位上下文：只在被接管的容器上加，宿主其余节点不受影响 */
.rf3-host{position:relative}

/* 待发送气泡的入口。与 .rf3-bar 同一套悬浮显现思路，但挂在外侧（气泡是右
   对齐的用户消息，塞在容器内部会压住宿主自己的 actions）。绝对定位移除
   文档流，不会把下面的消息推走。 */
.rf3-pending{position:relative}
.rf3-pending-bar{
  position:absolute;left:0;bottom:2px;transform:translateY(100%);z-index:5;
  display:inline-flex;gap:4px;align-items:center;
  opacity:0;pointer-events:none;
  transition:opacity .14s;
}
.rf3-pending:hover > .rf3-pending-bar,
.rf3-pending-bar:focus-within{opacity:1;pointer-events:auto}
.rf3-host[data-rf3-edited]{box-shadow:inset 2px 0 0 color-mix(in srgb, #e0a34a 70%, transparent)}

/* 编辑器要盖过操作条（bar z-index:5）——否则编辑器右上角的目标下拉被 bar
   压住，真机上「点不中/点不出光标」有它一份功劳。 */
.rf3-editor{
  display:flex;flex-direction:column;gap:8px;
  margin:6px 0;padding:10px;border-radius:10px;
  border:1px solid color-mix(in srgb, currentColor 18%, transparent);
  background:color-mix(in srgb, currentColor 4%, transparent);
  position:relative;z-index:6;
}
.rf3-editor textarea{
  width:100%;min-height:120px;resize:vertical;
  padding:8px 10px;border-radius:8px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:13px;line-height:1.6;
}
.rf3-editor textarea:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}
.rf3-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rf3-spacer{flex:1 1 auto}
.rf3-hint{font-size:11px;opacity:.55}

/* 目标选择器（v3）：把宿主给的可编辑块清单列出来，思维链与折叠历史
   也能选中——它们走 seq+blockIndex 寻址，不依赖 DOM 形状。 */
.rf3-targets{display:flex;gap:6px;align-items:center}
.rf3-select{
  flex:1 1 auto;max-width:100%;
  height:24px;padding:0 6px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:11px;
}
.rf3-select:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}
.rf3-select:disabled{opacity:.4}

/* 写入方式（v3.1）：在线/落盘两条路的前提差别太大，交给用户显式选。 */
.rf3-mode{
  flex:0 0 auto;
  height:24px;padding:0 6px;border-radius:6px;
  border:1px solid color-mix(in srgb, currentColor 20%, transparent);
  background:color-mix(in srgb, currentColor 3%, transparent);
  color:inherit;font:inherit;font-size:11px;
}
.rf3-mode:focus-visible{outline:2px solid color-mix(in srgb, currentColor 45%, transparent);outline-offset:1px}

/* 状态行：定位结果与写入结果都走这里。
   v1 的 .rf-primary / .rf-danger 是**类选择器**，而代码设的是 data-* 属性，
   选择器永远匹配不上（死样式）。v2 统一改成属性选择器。 */
.rf3-note{font-size:11px;line-height:1.5}
.rf3-note-ok{color:#4caf7d}
.rf3-note-warn{color:#e0a34a}
.rf3-note-info{color:#6aa9e8}
.rf3-note-hint{opacity:.5;word-break:break-all}

.rf3-btn[data-rf3-primary]{
  border-color:color-mix(in srgb, #4f8cff 55%, transparent);
  background:color-mix(in srgb, #4f8cff 14%, transparent);
  color:inherit;opacity:1;
}
.rf3-btn[data-danger]{opacity:.9}
.rf3-btn[data-danger]:hover{border-color:color-mix(in srgb, #d9534f 60%, transparent);color:#d9534f}
.rf3-btn:disabled{opacity:.3;cursor:not-allowed}
.rf3-btn:disabled:hover{background:transparent}

/* 已定位到落盘记录的块：操作条按钮带一个不易察觉的记号，
   让用户一眼看出「这条能写进记录」，而不是点开才发现写不了。 */
.rf3-btn[data-rf3-linked]::before{
  content:'';width:5px;height:5px;border-radius:50%;
  background:#4caf7d;flex:0 0 auto;
}
`

 return { CSS: CSS } })();
var CSS = __m_dsh_plugin_client_styles_mjs.CSS;
var __m_dsh_plugin_client_picker_mjs = (function(){ 


























const CONVERSATION_SELECTOR = '[data-slot="main.conversation"], [data-slot="conversation"]'


const CHAT_NODE_SELECTOR = '[data-slot="conversation.chat.node"]'


















const BLOCK_TAGS = 'p, pre, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, table, .md-code-block, [data-code-block-content], section, article, figure, figcaption, details, summary, dl, dt, dd, aside, main, header, footer, hr'


const TAKEN_ATTR = 'data-rf3-taken'




const MIN_TEXT = 1
function textLen(el) {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length
}











function isBlockLevel(el) {
  try {
    if (typeof el.matches === 'function' && el.matches(BLOCK_TAGS)) return true
  } catch {
    return false
  }
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''
  return tag.includes('-')
}








function isMarkdownContainer(el) {
  if (typeof el.matches !== 'function') return false
  const kids = [...el.children]
  if (kids.length === 0) return false
  let blocks = 0
  for (const k of kids) {
    if (isBlockLevel(k)) blocks += 1
  }
  return blocks >= 1 && blocks * 2 >= kids.length
}

















function pickAssistantBlocks(root, classify = null, options = {}) {
  if (root === null || typeof root.querySelectorAll !== 'function') return []
  const includeTaken = options.includeTaken === true
  const out = []
  const seen = new Set()

  const consider = el => {
    if (el === null || seen.has(el)) return
    if (el.closest('.rf3-editor, .rf3-bar, textarea, input') !== null) return
    
    
    
    
    
    if (el.closest('[data-composer-input]') !== null) return
    if (el.isContentEditable === true) return
    if (typeof el.hasAttribute === 'function' && el.hasAttribute(TAKEN_ATTR)) {
      if (includeTaken === true) {
        
        
      } else if (el.querySelector('.rf3-bar') !== null) {
        
        return
      } else {
        
        
        el.removeAttribute(TAKEN_ATTR)
      }
    }
    seen.add(el)
    out.push(el)
  }

  
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
    
    
    const outermostInNode = containers.filter(el => !containers.some(o => o !== el && o.contains(el)))
    for (const el of outermostInNode) {
      if (textLen(el) < MIN_TEXT) continue
      consider(el)
    }
  }

  
  
  
  if (out.length === 0) {
    const paras = [...root.querySelectorAll('p')]
    for (const p of paras) {
      const host = p.parentElement
      if (host === null) continue
      if (textLen(host) < MIN_TEXT) continue
      consider(host)
    }
  }

  
  const outermost = out.filter(el => !out.some(other => other !== el && other.contains(el)))

  
  
  if (typeof classify !== 'function') return outermost
  return outermost.filter(el => classify(el).ok === true)
}


function conversationRoot(doc = document) {
  const hit = doc.querySelector(CONVERSATION_SELECTOR)
  if (hit !== null) return hit
  
  
  const root = doc.getElementById('root')
  return root ?? doc.body
}

 return { pickAssistantBlocks: pickAssistantBlocks, conversationRoot: conversationRoot, CONVERSATION_SELECTOR: CONVERSATION_SELECTOR, TAKEN_ATTR: TAKEN_ATTR, MIN_TEXT: MIN_TEXT } })();
var CONVERSATION_SELECTOR = __m_dsh_plugin_client_picker_mjs.CONVERSATION_SELECTOR;
var TAKEN_ATTR = __m_dsh_plugin_client_picker_mjs.TAKEN_ATTR;
var pickAssistantBlocks = __m_dsh_plugin_client_picker_mjs.pickAssistantBlocks;
var conversationRoot = __m_dsh_plugin_client_picker_mjs.conversationRoot;
var __m_dsh_plugin_client_markdown_mjs = (function(){ 








function inline(doc, text) {
  const frag = doc.createDocumentFragment()
  
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]*\)|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      const code = doc.createElement('code')
      code.textContent = tok.slice(1, -1)
      frag.append(code)
    } else if (tok.startsWith('**')) {
      const strong = doc.createElement('strong')
      strong.textContent = tok.slice(2, -2)
      frag.append(strong)
    } else if (tok.startsWith('~~')) {
      const del = doc.createElement('del')
      del.textContent = tok.slice(2, -2)
      frag.append(del)
    } else if (tok.startsWith('[')) {
      const hit = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(tok)
      const a = doc.createElement('a')
      if (hit !== null) {
        a.textContent = hit[1]
        const href = hit[2].trim()
        
        if (/^(https?:|mailto:|#|\/|\.)/i.test(href)) {
          a.setAttribute('href', href)
          a.setAttribute('rel', 'noreferrer noopener')
        }
      } else {
        a.textContent = tok
      }
      frag.append(a)
    } else {
      const em = doc.createElement('em')
      em.textContent = tok.slice(1, -1)
      frag.append(em)
    }
    last = m.index + tok.length
  }
  if (last < text.length) frag.append(text.slice(last))
  return frag
}


function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let buf = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '\\' && inner[i + 1] === '|') { buf += '|'; i += 1; continue }
    if (ch === '|') { cells.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function isDivider(line) {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')
}






function renderMarkdown(container, source, docOverride) {
  
  
  const doc = docOverride ?? container.ownerDocument ?? globalThis.document
  container.textContent = ''
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    
    if (line.trim() === '') { i += 1; continue }

    
    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const lang = fence[1] ?? ''
      const buf = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1 }
      i += 1 
      const pre = doc.createElement('pre')
      const code = doc.createElement('code')
      if (lang !== '') code.setAttribute('data-language', lang)
      code.textContent = buf.join('\n')
      pre.append(code)
      container.append(pre)
      continue
    }

    
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(doc.createElement('hr'))
      i += 1
      continue
    }

    
    const head = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (head !== null) {
      const h = doc.createElement('h' + head[1].length)
      h.append(inline(doc, head[2]))
      container.append(h)
      i += 1
      continue
    }

    
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const bodyRows = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        bodyRows.push(splitRow(lines[i]))
        i += 1
      }
      const table = doc.createElement('table')
      const thead = doc.createElement('thead')
      const htr = doc.createElement('tr')
      for (const cell of header) {
        const th = doc.createElement('th')
        th.append(inline(doc, cell))
        htr.append(th)
      }
      thead.append(htr)
      table.append(thead)
      const tbody = doc.createElement('tbody')
      for (const row of bodyRows) {
        const tr = doc.createElement('tr')
        for (const cell of row) {
          const td = doc.createElement('td')
          td.append(inline(doc, cell))
          tr.append(td)
        }
        tbody.append(tr)
      }
      table.append(tbody)
      container.append(table)
      continue
    }

    
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      const quote = doc.createElement('blockquote')
      const inner = doc.createElement('div')
      renderMarkdown(inner, buf.join('\n'))
      quote.append(inner)
      container.append(quote)
      continue
    }

    
    if (/^\s*[-*+]\s+/.test(line)) {
      const list = doc.createElement('ul')
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = doc.createElement('li')
        const text = lines[i].replace(/^\s*[-*+]\s+/, '')
        li.append(inline(doc, text))
        i += 1
        
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          li.append(doc.createTextNode(' ' + lines[i].trim()))
          i += 1
        }
        list.append(li)
      }
      container.append(list)
      continue
    }

    
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = doc.createElement('ol')
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const li = doc.createElement('li')
        li.append(inline(doc, lines[i].replace(/^\s*\d+[.)]\s+/, '')))
        i += 1
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          li.append(doc.createTextNode(' ' + lines[i].trim()))
          i += 1
        }
        list.append(li)
      }
      container.append(list)
      continue
    }

    
    const buf = []
    while (
      i < lines.length
      && lines[i].trim() !== ''
      && !/^\s*```/.test(lines[i])
      && !/^\s*#{1,6}\s/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i])
      i += 1
    }
    if (buf.length > 0) {
      const p = doc.createElement('p')
      p.append(inline(doc, buf.join('\n')))
      container.append(p)
    } else {
      i += 1
    }
  }
}

 return { renderMarkdown: renderMarkdown } })();
var renderMarkdown = __m_dsh_plugin_client_markdown_mjs.renderMarkdown;
var __m_dsh_plugin_client_classify_mjs = (function(){ 









































const ACTION_TEXT = [
  
  
  
  
  '本轮费用', '未定价用量', '单价单位为每百万',
]


const ACTION_TAGS = new Set(['button', 'input', 'select', 'textarea', 'iframe'])


const OWN_UI_SELECTOR = '.rf3-bar, .rf3-editor'












const CODE_CHROME_SELECTOR = '[data-code-block-banner], .md-code-block'


const ACTION_SHAPE = [
  /^[A-Za-z]:\\/m,                       
  /^\/(?:Users|home|usr|etc|var|opt)\//m, 
  /^\s*--?[a-z][a-z0-9-]{2,}/m,          
  /^\s*[{[][\s\S]*[\]}]\s*$/,            
  /\$\s+\S+/,                            
]







function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
}






function classifyNaturalLanguage(el) {
  if (el === null || el === undefined) return { ok: false, reason: '空节点' }

  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return { ok: false, reason: '空文本' }

  
  const lower = stripCode(text).toLowerCase()
  for (const marker of ACTION_TEXT) {
    if (lower.includes(marker.toLowerCase())) {
      return { ok: false, reason: '含结构化动作痕迹：' + marker }
    }
  }

  
  
  
  
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
    
  }
  if (structural !== null) {
    return { ok: false, reason: '含结构性元素 <' + structural + '>' }
  }

  
  for (const re of ACTION_SHAPE) {
    if (re.test(stripCode(text))) return { ok: false, reason: '形态像命令或结构化数据' }
  }

  return { ok: true, reason: '纯自然语言' }
}






function partitionEditable(blocks) {
  const editable = []
  const rejected = []
  for (const el of blocks) {
    const verdict = classifyNaturalLanguage(el)
    if (verdict.ok) editable.push(el)
    else rejected.push({ el, reason: verdict.reason })
  }
  return { editable, rejected }
}

 return { classifyNaturalLanguage: classifyNaturalLanguage, partitionEditable: partitionEditable } })();
var classifyNaturalLanguage = __m_dsh_plugin_client_classify_mjs.classifyNaturalLanguage;
var __m_dsh_plugin_client_store_mjs = (function(){ 






const PREFIX = 'dsh-reply-forge-v3:'


const PLACEHOLDER_SESSION = '_global'


function isPlaceholderSession(sessionId) {
  return typeof sessionId !== 'string' || sessionId === '' || sessionId === PLACEHOLDER_SESSION
}















function currentSessionId(doc) {
  try {
    const d = doc ?? (typeof document === 'undefined' ? null : document)
    const el = d?.querySelector?.('[data-conversation-session]')
    const domId = el?.getAttribute?.('data-conversation-session')
    if (typeof domId === 'string' && domId !== '') return domId
    
    const path = window.location.pathname ?? ''
    const hit = /(?:^|\/)s(?:ession)?\/([A-Za-z0-9_-]+)/.exec(path)
    if (hit !== null && hit[1] !== undefined) return hit[1]
    const hash = window.location.hash ?? ''
    const hit2 = /(?:^|\/)s(?:ession)?\/([A-Za-z0-9_-]+)/.exec(hash)
    return hit2 !== null && hit2[1] !== undefined ? hit2[1] : PLACEHOLDER_SESSION
  } catch {
    return PLACEHOLDER_SESSION
  }
}


function fingerprint(text) {
  const norm = String(text ?? '').replace(/\s+/g, ' ').trim()
  const head = norm.slice(0, 80)
  const tail = norm.slice(-40)
  return head.length + ':' + head + '|' + tail
}

function keyOf(sessionId) {
  return PREFIX + String(sessionId ?? '_global')
}


function loadOverrides(sessionId) {
  try {
    const raw = window.localStorage.getItem(keyOf(sessionId))
    if (raw === null) return {}
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'object' && v !== null && typeof v.text === 'string') {
        out[k] = { text: v.text, at: typeof v.at === 'number' ? v.at : 0 }
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveOverrides(sessionId, table) {
  try {
    window.localStorage.setItem(keyOf(sessionId), JSON.stringify(table))
    return true
  } catch {
    return false
  }
}


function setOverride(sessionId, fp, text) {
  const table = loadOverrides(sessionId)
  if (String(text ?? '') === '') delete table[fp]
  else table[fp] = { text: String(text), at: Date.now() }
  return saveOverrides(sessionId, table)
}

function removeOverride(sessionId, fp) {
  const table = loadOverrides(sessionId)
  if (!(fp in table)) return false
  delete table[fp]
  return saveOverrides(sessionId, table)
}


function clearOverrides(sessionId) {
  try {
    window.localStorage.removeItem(keyOf(sessionId))
    return true
  } catch {
    return false
  }
}


function loadPrefs() {
  const base = { enabled: true, autoMark: false }
  try {
    const raw = window.localStorage.getItem(PREFIX + 'prefs')
    if (raw === null) return base
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return base
    return {
      enabled: parsed.enabled !== false,
      autoMark: parsed.autoMark === true,
    }
  } catch {
    return base
  }
}

function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFIX + 'prefs', JSON.stringify({
      enabled: prefs.enabled !== false,
      autoMark: prefs.autoMark === true,
    }))
  } catch {
    
  }
}

 return { isPlaceholderSession: isPlaceholderSession, currentSessionId: currentSessionId, fingerprint: fingerprint, loadOverrides: loadOverrides, setOverride: setOverride, removeOverride: removeOverride, clearOverrides: clearOverrides, loadPrefs: loadPrefs, savePrefs: savePrefs, PLACEHOLDER_SESSION: PLACEHOLDER_SESSION } })();
var currentSessionId = __m_dsh_plugin_client_store_mjs.currentSessionId;
var isPlaceholderSession = __m_dsh_plugin_client_store_mjs.isPlaceholderSession;
var fingerprint = __m_dsh_plugin_client_store_mjs.fingerprint;
var loadOverrides = __m_dsh_plugin_client_store_mjs.loadOverrides;
var setOverride = __m_dsh_plugin_client_store_mjs.setOverride;
var removeOverride = __m_dsh_plugin_client_store_mjs.removeOverride;
var clearOverrides = __m_dsh_plugin_client_store_mjs.clearOverrides;
var loadPrefs = __m_dsh_plugin_client_store_mjs.loadPrefs;
var savePrefs = __m_dsh_plugin_client_store_mjs.savePrefs;
var __m_dsh_plugin_client_record_mjs = (function(){ 
















const ROUTE = '/api/reply-forge-v3/session/blocks'


const cache = new Map()


function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}




















function domSignatureOf(texts) {
  const list = Array.isArray(texts) ? texts : []
  let hash = 2166136261
  for (const text of list) {
    const norm = normalizeText(text)
    hash = Math.imul(hash ^ norm.length, 16777619)
    for (let i = 0; i < norm.length; i += 1) hash = Math.imul(hash ^ norm.charCodeAt(i), 16777619)
  }
  return list.length + ':' + (hash >>> 0).toString(36)
}


















async function loadRecord(sessionId, options = {}) {
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


function cachedRecord(sessionId) {
  return cache.get(sessionId) ?? null
}


function resetCache(sessionId) {
  if (sessionId === undefined) cache.clear()
  else cache.delete(sessionId)
}




































function recordNeedsRefresh(entry, domBlockCount, signature) {
  if (!(domBlockCount > 0)) return false
  if (entry === null || entry === undefined) return true
  if (entry.error !== null && entry.error !== undefined) return true
  if (entry.mode === 'live') {
    
    if (entry.blocks.length === 0) return true
    if (typeof signature !== 'string') return false
    if (typeof entry.domSignature !== 'string') return true
    return entry.domSignature !== signature
  }
  return domBlockCount > entry.blocks.length
}








function matchBlocks(diskBlocks, domTexts) {
  const out = domTexts.map(() => null)
  const used = new Set()
  const domNorm = domTexts.map(normalizeText)

  
  const byText = new Map()
  diskBlocks.forEach((b, i) => {
    const key = normalizeText(b.text)
    if (!byText.has(key)) byText.set(key, [])
    byText.get(key).push(i)
  })
  domNorm.forEach((key, di) => {
    if (key === '') return
    const list = byText.get(key)
    if (list === undefined) return
    
    while (list.length > 0 && used.has(list[0])) list.shift()
    if (list.length === 0) return
    const bi = list.shift()
    used.add(bi)
    out[di] = { ...diskBlocks[bi], exact: true }
  })

  
  
  
  
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















async function forgeRecord(payload) {
  try {
    const res = await fetch('/api/reply-forge-v3/session/forge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        
        
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

 return { normalizeText: normalizeText, domSignatureOf: domSignatureOf, loadRecord: loadRecord, cachedRecord: cachedRecord, resetCache: resetCache, recordNeedsRefresh: recordNeedsRefresh, matchBlocks: matchBlocks, forgeRecord: forgeRecord } })();
var loadRecord = __m_dsh_plugin_client_record_mjs.loadRecord;
var cachedRecord = __m_dsh_plugin_client_record_mjs.cachedRecord;
var resetCache = __m_dsh_plugin_client_record_mjs.resetCache;
var matchBlocks = __m_dsh_plugin_client_record_mjs.matchBlocks;
var normalizeText = __m_dsh_plugin_client_record_mjs.normalizeText;
var forgeRecord = __m_dsh_plugin_client_record_mjs.forgeRecord;
var recordNeedsRefresh = __m_dsh_plugin_client_record_mjs.recordNeedsRefresh;
var domSignatureOf = __m_dsh_plugin_client_record_mjs.domSignatureOf;
var __m_dsh_plugin_client_queue_mjs = (function(){ 
























































const INBOX_KEY = 'inbox'









const PENDING_SOURCE_KIND = 'user'












function normalizeInbox(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null
  const value = snapshot
  const nextTurn = Array.isArray(value['next-turn']) ? value['next-turn'] : []
  const nextStep = Array.isArray(value['next-step']) ? value['next-step'] : []
  return { nextTurn, nextStep }
}














function readPendingEchoes(session) {
  try {
    if (session === null || typeof session !== 'object') return []
    if (typeof session.getSnapshot !== 'function') return []
    const snap = session.getSnapshot()
    const list = snap !== null && typeof snap === 'object' ? snap.pendingSubmissions : undefined
    if (!Array.isArray(list)) return []
    const out = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      if (item.placement !== 'steering') continue
      const requestId = typeof item.requestId === 'string' && item.requestId !== '' ? item.requestId : undefined
      const text = typeof item.text === 'string' ? item.text : ''
      if (requestId === undefined) continue
      out.push({ requestId, text, time: typeof item.time === 'number' ? item.time : 0 })
    }
    return out
  } catch {
    return []
  }
}













function hasPendingEcho(session, bubbleText) {
  const raw = String(bubbleText ?? '')
  if (raw === '') return false
  const collapsed = collapseWhitespace(raw)
  return readPendingEchoes(session).some(e =>
    e.text === raw || (collapsed !== '' && collapseWhitespace(e.text) === collapsed))
}























function readInboxProjection(session) {
  try {
    const projections = session === null || session === undefined ? undefined : session.projections
    if (projections === null || projections === undefined) return null
    if (typeof projections.faceOf !== 'function') return null
    const face = projections.faceOf(INBOX_KEY)
    if (face === null || face === undefined) return null
    if (typeof face.getSnapshot !== 'function') return null
    const normalized = normalizeInbox(face.getSnapshot())
    if (normalized === null) return null
    return normalized.nextStep.filter(isPendingUserRow)
  } catch {
    
    return null
  }
}










function readInbox(session) {
  return readInboxProjection(session)
}














function readInboxRows(session) {
  try {
    const projections = session === null || session === undefined ? undefined : session.projections
    if (projections === null || projections === undefined) return null
    if (typeof projections.faceOf !== 'function') return null
    const face = projections.faceOf(INBOX_KEY)
    if (face === null || face === undefined) return null
    if (typeof face.getSnapshot !== 'function') return null
    const normalized = normalizeInbox(face.getSnapshot())
    if (normalized === null) return null
    return normalized.nextStep
  } catch {
    return null
  }
}
















function queueDiag(session, extra = {}) {
  const out = {}
  try {
    if (extra.sessionId !== undefined) out.sessionId = String(extra.sessionId)
    if (extra.bubbleKind !== undefined) out.bubbleKind = extra.bubbleKind
    out.hasSession = session !== null && typeof session === 'object'
    if (!out.hasSession) return out
    out.ctor = typeof session.constructor?.name === 'string' ? session.constructor.name : '?'
    out.hasGetSnapshot = typeof session.getSnapshot === 'function'
    const projections = session.projections
    out.projections = projections === null || projections === undefined ? 'absent' : typeof projections
    out.faceOf = projections === null || projections === undefined ? 'absent' : typeof projections.faceOf
    try {
      const rows = projections?.rows
      out.projectionKeys = rows instanceof Map ? [...rows.keys()] : 'no-rows'
    } catch { out.projectionKeys = 'throw' }
    try {
      if (typeof projections?.faceOf === 'function') {
        const face = projections.faceOf(INBOX_KEY)
        out.face = face === null || face === undefined ? 'absent' : typeof face
        const snap = typeof face?.getSnapshot === 'function' ? face.getSnapshot() : undefined
        if (snap === undefined || snap === null) {
          out.inboxSnapshot = snap === undefined ? 'undefined' : 'null'
        } else if (typeof snap === 'object') {
          out.inboxSnapshot = Array.isArray(snap['next-step'])
            ? 'keys:' + Object.keys(snap).join(',')
            : 'object(no next-step array)'
          out.inboxNextStep = Array.isArray(snap['next-step']) ? snap['next-step'].length : 'absent'
          out.inboxNextTurn = Array.isArray(snap['next-turn']) ? snap['next-turn'].length : 'absent'
        } else {
          out.inboxSnapshot = typeof snap
        }
        if (typeof projections?.seqOf === 'function') {
          const seq = projections.seqOf(INBOX_KEY)
          out.inboxSeq = typeof seq === 'number' ? seq : String(seq)
        }
      } else {
        out.face = 'absent'
      }
    } catch (error) {
      out.inboxSnapshot = `throw:${String(error && error.message ? error.message : error)}`
    }
    try {
      const echoes = readPendingEchoes(session)
      out.echoCount = echoes.length
      out.echoTexts = echoes.map(e => `${String(e.time)}:${e.text.slice(0, 30)}`)
    } catch { out.echoCount = 'throw' }
    // next-step 每行的速写：点击时刻投影里到底有谁、kind 是什么。真机 bug 的
    // 分歧点全在这一层（inboxNextStep 有行而过滤后为 0 = 行的 kind 不是 user）。
    try {
      out.nextStepRows = describeInboxRows(readInboxRows(session))
    } catch { out.nextStepRows = 'throw' }
    try {
      const snap = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
      const subs = snap !== null && typeof snap === 'object' ? snap.pendingSubmissions : null
      if (Array.isArray(subs)) {
        const tally = { total: subs.length, steering: 0, queued: 0, transcript: 0, other: 0 }
        for (const s of subs) {
          const p = s === null || typeof s !== 'object' ? undefined : s.placement
          if (p === 'steering') tally.steering += 1
          else if (p === 'queued') tally.queued += 1
          else if (p === 'transcript') tally.transcript += 1
          else tally.other += 1
        }
        out.subPlacements = tally
      }
      const perr = snap !== null && typeof snap === 'object' ? snap.promptError : null
      if (perr !== null && perr !== undefined) {
        out.promptError = typeof perr === 'object' && typeof perr.error?.code === 'string'
          ? perr.error.code
          : 'present'
      }
    } catch { out.subPlacements = 'throw' }
    out.projectionRows = (readInboxProjection(session) ?? []).length
    // 调用方补充的定位线索：气泡文本头、锚点、对话里是否已有同文本的已发送气泡。
    if (extra.bubbleTextHead !== undefined) out.bubbleTextHead = String(extra.bubbleTextHead).slice(0, 40)
    if (extra.anchor !== undefined) out.anchor = extra.anchor
    if (extra.sentInTranscript !== undefined) out.sentInTranscript = extra.sentInTranscript === true
  } catch { /* 诊断自身绝不影响主流程 */ }
  return out
}

/**
 * next-step 行的安全速写（读属性全程兜底，单行坏掉不影响其它行）。
 *
 * 回答「点击时刻投影里这一行是什么」：id、source.kind、文本头。kind 读不出来
 * （getter 抛异常之类）记 'throw'，与 'absent' 区分——前者说明值结构异常，
 * 后者说明这行本来就没有 source。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @returns {Array<{i: number, id: string, kind: string, len: number, head: string}> | string}
 */
function describeInboxRows(rows) {
  if (rows === null) return 'unreadable'
  if (!Array.isArray(rows)) return 'not-array'
  const out = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const entry = { i, id: '?', kind: '?', len: 0, head: '' }
    try {
      const id = rowId(row)
      entry.id = id ?? '(no-id)'
    } catch { entry.id = 'throw' }
    try {
      const source = row.source
      if (source === null || source === undefined) entry.kind = 'absent'
      else if (typeof source !== 'object') entry.kind = typeof source
      else entry.kind = typeof source.kind === 'string' ? source.kind : String(source.kind)
    } catch { entry.kind = 'throw' }
    try {
      const parts = contentText(rowContent(row))
      entry.len = parts.text.length
      entry.head = parts.text.slice(0, 30)
    } catch { entry.head = 'throw' }
    out.push(entry)
  }
  return out
}

/** 取一行是否为「用户发的、显示成 pending 气泡」的 steering 行。 */
function isPendingUserRow(row) {
  if (row === null || typeof row !== 'object') return false
  const source = row.source
  if (source === null || typeof source !== 'object') return false
  return source.kind === PENDING_SOURCE_KIND
}

/** 行 id 必须是可用字符串，否则 updateQueue 无从下手。 */
function rowId(row) {
  const id = row === null || row === undefined ? undefined : row.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 取一行的 content 数组（缺失按空数组，容错）。
 * @returns {unknown[]}
 */
function rowContent(row) {
  if (row === null || typeof row !== 'object') return []
  const content = row.content
  return Array.isArray(content) ? content : []
}

/**
 * content blocks → 纯文本。
 *
 * `textOnly` 表示这一行**只有文本块**。QueueAction.edit 只接受文本内容
 * （宿主导览原话：Non-empty text-only replacement content），带附件时改写会
 * 静默丢附件 —— 我们宁可拒绝编辑，不做静默丢失。
 *
 * @param {unknown[]} blocks
 * @returns {{ text: string, textOnly: boolean }}
 */
function contentText(blocks) {
  let text = ''
  let textOnly = true
  if (!Array.isArray(blocks)) return { text, textOnly }
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') { textOnly = false; continue }
    const type = block.type
    if (type === 'text') {
      const value = block.text
      if (typeof value === 'string') { text += value; continue }
    }
    // 非文本块（image / file / …）→ 标记，但仍继续拼文本以便提示用。
    textOnly = false
  }
  return { text, textOnly }
}

/** 折叠连续空白：markdown 渲染会把换行/缩进抹掉，DOM 文本与原文只在这一层可比。 */
function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 提取 pending 气泡的可见文本。
 *
 * 必须剔除两类节点，否则文本永远对不上：
 *   1. `[data-clock]`：宿主持有的时间戳，不是消息内容；
 *   2. **本插件注入的 UI**：编辑按钮/编辑器是挂在气泡容器里的，它们的文字
 *     会被算进气泡文本——按钮一旦挂上，定位就永远失败（踩过）。
 * 第 2 类由调用方通过 skipSelector 传入（queue.mjs 不关心 rf3-* 前缀）。
 *
 * @param {Element} row
 * @param {string} [skipSelector] 要剔除的节点选择器，逗号列表
 * @returns {string}
 */
function bubbleTextOf(row, skipSelector = '[data-clock]') {
  try {
    if (row === null || row === undefined) return ''
    if (typeof row.cloneNode !== 'function') return ''
    const clone = row.cloneNode(true)
    if (clone === null || clone === undefined) return ''
    if (typeof clone.querySelectorAll !== 'function') return ''
    const skip = typeof skipSelector === 'string' && skipSelector !== '' ? skipSelector : '[data-clock]'
    for (const node of clone.querySelectorAll(skip)) node.remove()
    const text = clone.textContent
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * 把气泡文本回匹到队列行，拿出 itemId。
 *
 * 两级匹配 + **歧义拒绝**：
 *   tier 0  气泡文本与行文本完全相同；
 *   tier 1  折叠空白后相同（吃掉 markdown 渲染造成的换行差异）。
 * 先扫 tier 0：恰好一条就用，**多于一条直接拒绝**（文本撞车时改哪条都是赌）；
 * tier 0 无果再扫 tier 1，同样要求唯一。
 *
 * 之所以比对面保守：对面在多个相同文本匹配时取出现顺序第一条。队列里两条一字
 * 不差的待发送消息虽然少见，但改错一条的代价是用户的消息被悄悄换掉，而这里是
 * 纯文本回匹、没有任何强锚点可依，宁可提示「定位不准」也不能猜。
 *
 * @param {unknown[] | null} inbox readInbox 的产物（next-step 的 user 行）
 * @param {string} bubbleText 气泡可见文本
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
function resolvePendingItem(inbox, bubbleText) {
  return matchPendingRow(inbox, bubbleText)
}

/**
 * 按 itemId 直接定位（强锚点复核）。
 *
 * 接管气泡时当场按文本解析出的 itemId 存在这里；点击时用它复核——行还在队列里
 * 就直接开编辑器，不用再赌文本。行已离开队列（回合结束被 claim）时返回失败，
 * 由上层走完整路径并给出「已经发出去了」的诚实提示。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @param {string} itemId 接管时记下的行 id
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
function resolvePendingItemById(rows, itemId) {
  if (rows === null) return { ok: false, error: '读不到待发送队列，请稍后重试' }
  if (typeof itemId !== 'string' || itemId === '') return { ok: false, error: '锚点无效' }
  for (const row of rows) {
    if (rowId(row) !== itemId) continue
    const parts = contentText(rowContent(row))
    if (!parts.textOnly) return { ok: false, error: '这条待发送消息含附件，暂不支持编辑' }
    return { ok: true, itemId, text: parts.text, textOnly: true }
  }
  return { ok: false, error: '这条消息已经不在队列里了（可能已发出）' }
}

/**
 * next-step 里是否存在与气泡文本相同的行（kind 不设限）。
 *
 * 只回答「是文本对不上，还是行被 kind 过滤掉了」这一个问题，给失败文案指路：
 * 有同文本行而不能编辑 = 那行不是用户消息（注入行）；完全没有同文本行 =
 * 用户点的那条真的离开了队列（回合结束被 claim 后插件又补了行）。
 *
 * @param {unknown[] | null} rows readInboxRows 的产物
 * @param {string} bubbleText 气泡可见文本
 * @returns {boolean}
 */
function hasTextMatchRow(rows, bubbleText) {
  if (rows === null || !Array.isArray(rows)) return false
  const raw = String(bubbleText ?? '')
  const collapsed = collapseWhitespace(raw)
  if (raw === '') return false
  for (const row of rows) {
    const text = contentText(rowContent(row)).text
    if (text === '') continue
    if (text === raw || collapseWhitespace(text) === collapsed) return true
  }
  return false
}

/**
 * 两级文本匹配 + 唯一性约束，只认 source.kind === 'user' 的行（与界面渲染
 * 条件逐字对齐——宿主 prompt 走的永远是 user 行，kind 不同的行都是插件注入，
 * 不是用户待发送的消息，不给编辑）。
 *
 * @param {unknown[] | null} inbox readInbox 的产物
 * @param {string} bubbleText 气泡可见文本
 * @returns {{ ok: true, itemId: string, text: string, textOnly: boolean }
 *          | { ok: false, error: string }}
 */
function matchPendingRow(inbox, bubbleText) {
  if (inbox === null) return { ok: false, error: '读不到待发送队列，请稍后重试' }
  const raw = String(bubbleText ?? '')
  const collapsed = collapseWhitespace(raw)

  // tier 0：精确匹配。
  let exact = []
  // tier 1：折叠空白后匹配。
  let fuzzy = []
  for (const row of inbox) {
    if (!isPendingUserRow(row)) continue
    const parts = contentText(rowContent(row))
    if (parts.text === raw && raw !== '') exact.push({ row, parts })
    else if (parts.text !== '' && collapseWhitespace(parts.text) === collapsed) fuzzy.push({ row, parts })
  }

  const picked = pickUnique(exact) ?? pickUnique(fuzzy)
  if (picked === undefined) {
    if (exact.length > 1 || fuzzy.length > 1) {
      return { ok: false, error: '队列里有多个相同的待发送消息，无法定位，请在队列变化后重试' }
    }
    return { ok: false, error: '消息还在发送或已经变化，无法定位，请稍后重试' }
  }
  if (!picked.parts.textOnly) {
    return { ok: false, error: '这条待发送消息含附件，暂不支持编辑' }
  }
  const itemId = rowId(picked.row)
  if (itemId === undefined) {
    return { ok: false, error: '无法定位这条待发送消息，请稍后重试' }
  }
  return { ok: true, itemId, text: picked.parts.text, textOnly: true }
}

/**
 * 候选集合里恰好一条才返回，否则 undefined。
 * 空文本行不参与（空串会和任何空气泡误配）。
 */
function pickUnique(candidates) {
  if (candidates.length !== 1) return undefined
  const only = candidates[0]
  if (only.parts.text === '') return undefined
  return only
}

// ── 写入：session.updateQueue ────────────────────────────────────────────

/**
 * updateQueue 的业务错误码 → 中文。
 *
 * 码表不是抄来的，逐个在宿主源码里核对过，全部出自
 * `@deepseek-ai/dsh-api-session-controller/lib/index.js` 的 updateQueue
 * handler（822-845 行）：
 *   - session/attachment-invalid：content 里含非 text 块（824 行）
 *   - gateway/bad-request：空或纯空白文本（825 行）
 *   - session/queue-item-not-found：会话没有活 agent，或 item 已不在队列（828/842 行）
 *   - session/steer-unavailable：kind 为 steer 但目标不是 next-turn 或回合没在跑（845 行）
 * steer 这条我们暂时不产（见下方说明），列出来只为别把它误译成别的意思。
 *
 * @param {string} [code]
 * @returns {string | undefined} undefined = 未知码，交给调用方用原始 message
 */
function explainQueueError(code) {
  switch (code) {
    case 'session/queue-item-not-found':
      return '这条消息已经不在队列里了（可能已发出）'
    case 'session/attachment-invalid':
      return '修改失败：队列编辑只能保存纯文本，附件会丢失'
    case 'gateway/bad-request':
      return '内容不能为空'
    case 'session/steer-unavailable':
      return '当前回合已经不能接受这条消息了'
    default:
      return undefined
  }
}

/**
 * RemoteResult → 失败原因文本。
 *
 * 形状按 `{ ok, value }` / `{ ok, error: { code, message } }` 解，两种都容忍：
 * 码认识就用中文，不认识的退回宿主原文（那通常已经是可读的业务说明）。
 *
 * @param {unknown} result session.updateQueue 的返回值
 * @returns {string | null} null = 成功了
 */
function updateQueueFailure(result) {
  if (result === null || result === undefined) return '保存失败，请稍后重试'
  if (typeof result !== 'object') return '保存失败，请稍后重试'
  const res = result
  if (res.ok === true) return null
  const error = res.error
  if (error === null || typeof error !== 'object') {
    // 抛到 invoke 的那一半：没有 RemoteResult 形状就当异常处理。
    return '保存失败，请稍后重试'
  }
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' ? error.message : ''
  return explainQueueError(code) ?? (message !== '' ? message : '保存失败，请稍后重试')
}

/**
 * 调官方 updateQueue 改一条待发送消息的文本。
 *
 * 我们**只发 kind: 'edit' 且纯文本**。handler 明确拒绝任何非 text 块，附件场景
 * 由 resolvePendingItem 在上游就挡掉了，不会走到这里被服务端拒。
 *
 * steer / remove 不做：handler 要求 steer 的目标必须是 next-turn 且回合在跑
 * （index.js 845 行），而带 data-pending-steering 气泡的恰好是 next-step
 * （placement 'steering'）——两者不重叠，要做 steer 得另找 UI 锚点，那是独立
 * 一件事，不塞进这个模块。
 *
 * @param {{ updateQueue?: Function }} session ISession
 * @param {string} itemId resolvePendingItem 给出的行 id
 * @param {string} text 新文本
 * @returns {Promise<string | null>} null = 成功；否则为可读失败原因
 */
async function submitQueueEdit(session, itemId, text) {
  try {
    if (session === null || session === undefined) return '当前会话还没准备好，稍后再试'
    if (typeof session.updateQueue !== 'function') return '当前宿主版本不支持编辑待发送消息'
    const result = await session.updateQueue(itemId, {
      kind: 'edit',
      content: [{ type: 'text', text }],
    })
    return updateQueueFailure(result)
  } catch (error) {
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : ''
    return message !== '' ? message : '保存失败，请稍后重试'
  }
}

 return { normalizeInbox: normalizeInbox, readPendingEchoes: readPendingEchoes, hasPendingEcho: hasPendingEcho, readInboxProjection: readInboxProjection, readInbox: readInbox, readInboxRows: readInboxRows, queueDiag: queueDiag, describeInboxRows: describeInboxRows, rowContent: rowContent, contentText: contentText, collapseWhitespace: collapseWhitespace, bubbleTextOf: bubbleTextOf, resolvePendingItem: resolvePendingItem, resolvePendingItemById: resolvePendingItemById, hasTextMatchRow: hasTextMatchRow, explainQueueError: explainQueueError, updateQueueFailure: updateQueueFailure, submitQueueEdit: submitQueueEdit, INBOX_KEY: INBOX_KEY, PENDING_SOURCE_KIND: PENDING_SOURCE_KIND } })();
var readInbox = __m_dsh_plugin_client_queue_mjs.readInbox;
var readInboxRows = __m_dsh_plugin_client_queue_mjs.readInboxRows;
var resolvePendingItem = __m_dsh_plugin_client_queue_mjs.resolvePendingItem;
var resolvePendingItemById = __m_dsh_plugin_client_queue_mjs.resolvePendingItemById;
var hasTextMatchRow = __m_dsh_plugin_client_queue_mjs.hasTextMatchRow;
var bubbleTextOf = __m_dsh_plugin_client_queue_mjs.bubbleTextOf;
var submitQueueEdit = __m_dsh_plugin_client_queue_mjs.submitQueueEdit;
var queueDiag = __m_dsh_plugin_client_queue_mjs.queueDiag;
var hasPendingEcho = __m_dsh_plugin_client_queue_mjs.hasPendingEcho;
var collapseWhitespace = __m_dsh_plugin_client_queue_mjs.collapseWhitespace;



























const name = 'dsh-reply-forge-v3'












const inject = ['slots', 'sessions']


let sessionsRef = null








const pendingAnchors = new WeakMap()

const SCAN_DEBOUNCE_MS = 220
const EDIT_ATTR = 'data-rf3-edited'











const RECORD_REFRESH_MIN_GAP_MS = 800


const RECORD_REFRESH_MAX_TRIES = 4


const OWN_UI_CLASSES = ['rf3-bar', 'rf3-editor', 'rf3-note', 'rf3-notes']


const taken = new WeakMap()


const dupCount = new WeakMap()


const blockMatch = new WeakMap()


const recordInflight = new Map()










function readRecord(sessionId, options = {}) {
  if (options.force !== true) return loadRecord(sessionId, options)
  const hit = recordInflight.get(sessionId)
  if (hit !== undefined) return hit
  const pending = loadRecord(sessionId, { force: true, domSignature: options.domSignature })
    .finally(() => recordInflight.delete(sessionId))
  recordInflight.set(sessionId, pending)
  return pending
}





let scheduleScanRef = null





let refreshRecordRef = null






let domSignatureNowRef = () => ''


let openEditor = null

function log(...args) {
  try { console.warn('[dsh-reply-forge-v3]', ...args) } catch {  }
}


function isOwnUi(el) {
  const cls = el.classList
  if (cls === undefined || cls === null) return false
  for (const name of OWN_UI_CLASSES) if (cls.contains(name)) return true
  return false
}










function ownText(el) {
  const kids = el.children ?? []
  if (kids.length === 0) return String(el.textContent ?? '').replace(/\s+/g, ' ').trim()
  let out = ''
  for (const child of kids) {
    if (isOwnUi(child)) continue
    if (child.tagName === 'TEXTAREA' || child.tagName === 'BUTTON') continue
    out += ownText(child) + ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}


function makeButton(doc, label, title, onClick, extra = {}) {
  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'rf3-btn'
  btn.textContent = label
  if (typeof title === 'string' && title !== '') btn.title = title
  for (const [k, v] of Object.entries(extra)) {
    if (v === true) btn.setAttribute(k, '')
    else if (v !== false && v !== null && v !== undefined) btn.setAttribute(k, String(v))
  }
  btn.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    try { onClick() } catch (error) { log('按钮回调失败', error) }
  })
  return btn
}


const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'


let lastFocusHandoff = null


function describeEl(el) {
  if (el === null || el === undefined) return 'null(<body>)'
  const cls = typeof el.className === 'string' && el.className !== ''
    ? '.' + el.className.split(/\s+/).filter(Boolean).join('.')
    : ''
  return String(el.tagName) + cls
}










function composerCandidates(doc) {
  if (doc === null || doc === undefined || typeof doc.querySelectorAll !== 'function') return []
  try {
    return [...doc.querySelectorAll(COMPOSER_INPUT_SELECTOR)]
  } catch {
    return []
  }
}


function composerVisible(el) {
  try {
    if (el.isConnected === false) return false
  } catch {  }
  if (typeof el.getClientRects === 'function') {
    try {
      const rects = el.getClientRects()
      if (rects !== null && rects !== undefined && rects.length === 0) return false
    } catch {  }
  }
  return true
}


function composerInert(el) {
  try { if (el.inert === true) return true } catch {  }
  try {
    if (typeof el.closest === 'function' && el.closest('[inert]') !== null) return true
  } catch {  }
  return false
}







function pickComposerTarget(doc) {
  const all = composerCandidates(doc)
  const editable = all.filter(el => {
    try { return el.isContentEditable === true } catch { return false }
  })
  const pool = editable.length > 0 ? editable : all
  let best = null
  let bestScore = -1
  for (const el of pool) {
    let score = 0
    if (composerInert(el) !== true) score += 2
    if (composerVisible(el) === true) score += 1
    if (score > bestScore) { best = el; bestScore = score }
  }
  return { el: best, total: all.length }
}





function selectionInComposer(doc, el) {
  if (el === null || el === undefined) return false
  try {
    const view = (doc && typeof doc.defaultView === 'object' && doc.defaultView !== null)
      ? doc.defaultView
      : (typeof window === 'object' && window !== null ? window : null)
    if (view === null || typeof view.getSelection !== 'function') return false
    const sel = view.getSelection()
    if (sel === null || sel === undefined) return false
    const node = sel.anchorNode ?? sel.focusNode ?? null
    if (node === null) return false
    return node === el || (typeof el.contains === 'function' && el.contains(node) === true)
  } catch {
    return false
  }
}









function ensureComposerSelection(doc, el) {
  if (el === null || el === undefined) return
  try { if (el.isContentEditable !== true) return } catch { return }
  if (selectionInComposer(doc, el) === true) return
  try {
    const view = (doc && typeof doc.defaultView === 'object' && doc.defaultView !== null)
      ? doc.defaultView
      : (typeof window === 'object' && window !== null ? window : null)
    if (view === null || typeof view.getSelection !== 'function') return
    const sel = view.getSelection()
    if (sel === null || sel === undefined) return
    if (typeof doc.createRange !== 'function') return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {  }
}
















function focusHostComposer(doc) {
  const { el, total } = pickComposerTarget(doc)
  if (el === null || typeof el.focus !== 'function') {
    lastFocusHandoff = { ok: false, editable: false, reason: 'no-input', candidates: total, detail: '页面里没有 ' + COMPOSER_INPUT_SELECTOR }
    return lastFocusHandoff
  }
  let called = false
  try { el.focus({ preventScroll: true }); called = true } catch {
    try { el.focus(); called = true } catch { called = false }
  }
  const landed = (doc.activeElement ?? null) === el
  let editable = false
  try { editable = el.isContentEditable === true } catch {  }
  if (landed === true) ensureComposerSelection(doc, el)
  lastFocusHandoff = {
    ok: landed,
    editable,
    candidates: total,
    reason: landed ? 'ok' : (editable ? (called ? 'focus-noop' : 'focus-threw') : 'not-editable'),
    detail: describeEl(el) + (total > 1 ? '（共 ' + total + ' 个输入框候选，取的是可见/可编辑的那个）' : ''),
  }
  return lastFocusHandoff
}








function keepComposerFocus(doc) {
  try {
    let ticks = 0
    const stop = () => {
      try { doc.removeEventListener('keydown', onUser, true) } catch {  }
      try { doc.removeEventListener('pointerdown', onUser, true) } catch {  }
    }
    const onUser = () => stop()
    doc.addEventListener('keydown', onUser, true)
    doc.addEventListener('pointerdown', onUser, true)
    const tick = () => {
      ticks += 1
      if (ticks > 6) { stop(); return }
      const active = doc.activeElement ?? null
      if (active !== null && active !== doc.body) { stop(); return }
      const el = typeof doc.querySelector === 'function' ? doc.querySelector(COMPOSER_INPUT_SELECTOR) : null
      if (el === null) { stop(); return }
      try { el.focus({ preventScroll: true }) } catch {  }
      window.setTimeout(tick, 120)
    }
    window.setTimeout(tick, 120)
  } catch {  }
}


let typingGuardHandler = null
let typingGuardExtras = null
let typingGuardTimer = null

function disarmTypingGuard() {
  try {
    if (typeof window !== 'undefined' && window !== null) {
      if (typingGuardHandler !== null) {
        try { window.removeEventListener('keydown', typingGuardHandler, true) } catch {  }
      }
      if (typingGuardExtras !== null) {
        try { window.removeEventListener('focusin', typingGuardExtras.onFocusIn, true) } catch {  }
        try { window.removeEventListener('pointerdown', typingGuardExtras.onPointer, true) } catch {  }
      }
      if (typingGuardTimer !== null) {
        try { window.clearTimeout(typingGuardTimer) } catch {  }
      }
    }
  } catch {  }
  typingGuardHandler = null
  typingGuardExtras = null
  typingGuardTimer = null
}


function isEditableTarget(target) {
  if (target === null || target === undefined) return false
  try {
    const tag = String(target.tagName ?? '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (target.isContentEditable === true) return true
    if (typeof target.closest === 'function') {
      if (target.closest('.rf3-editor') !== null) return true
      if (target.closest('[data-composer-input]') !== null) return true
    }
  } catch {  }
  return false
}














function armTypingGuard(doc) {
  disarmTypingGuard()
  try {
    if (typeof window === 'undefined' || window === null || typeof window.addEventListener !== 'function') return
    const pull = event => {
      if (event === null || event === undefined) return
      
      if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return
      const target = event.target ?? null
      if (isEditableTarget(target) === true) { disarmTypingGuard(); return }
      const { el } = pickComposerTarget(doc)
      if (el === null || typeof el.focus !== 'function') return
      try { el.focus({ preventScroll: true }) } catch { try { el.focus() } catch {  } }
      ensureComposerSelection(doc, el)
    }
    
    const onFocusIn = event => {
      const t = (event && event.target) ?? null
      if (t === null || t === undefined) return
      if (isEditableTarget(t) === true) {
        try { if (t.getAttribute && t.getAttribute('data-composer-input') === null) disarmTypingGuard() } catch {  }
      } else {
        disarmTypingGuard()
      }
    }
    const onPointer = () => disarmTypingGuard()
    typingGuardHandler = pull
    window.addEventListener('keydown', pull, true)
    window.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('pointerdown', onPointer, true)
    typingGuardExtras = { onFocusIn, onPointer }
    typingGuardTimer = window.setTimeout(disarmTypingGuard, 60000)
  } catch {  }
}


function unhideBlockBar(block) {
  try {
    for (const child of (block.children ?? [])) {
      if (child.classList !== undefined && child.classList.contains('rf3-bar')) {
        child.style.display = ''
      }
    }
  } catch {  }
}












function closeEditor(options = {}) {
  if (openEditor === null) return
  const { wrap, poll } = openEditor
  
  
  if (poll !== undefined && poll !== null) {
    try { clearInterval(poll) } catch {  }
  }
  const doc = openEditor.doc ?? wrap.ownerDocument ?? document
  const block = openEditor.block
  const active = doc.activeElement ?? null
  const hadFocus = active !== null && wrap.contains(active)
  openEditor = null
  if (hadFocus === true) {
    try { active.blur() } catch {  }
  }
  try { wrap.remove() } catch {  }
  if (block !== undefined && block !== null) unhideBlockBar(block)
  if (hadFocus === true && options.refocus !== false) {
    const handoff = focusHostComposer(doc)
    
    
    if (handoff.ok === true || handoff.editable === true) {
      keepComposerFocus(doc)
      armTypingGuard(doc)
    }
  }
}












function closeEditorOnBlock(doc, block, options = {}) {
  if (openEditor === null || openEditor.block !== block) return
  const { wrap } = openEditor
  const active = doc.activeElement ?? null
  const inside = active !== null && wrap.contains(active)
  
  
  
  
  
  
  
  
  const lostToBody = active === null || active === doc.body
  const hadFocus = inside === true
    || (lostToBody === true && options.hadFocusAtClick === true)
  openEditor = null
  if (inside === true) {
    try { active.blur() } catch {  }
  }
  try { wrap.remove() } catch {  }
  unhideBlockBar(block)
  if (hadFocus === true && options.refocus !== false) {
    const handoff = focusHostComposer(doc)
    if (handoff.ok === true || handoff.editable === true) {
      keepComposerFocus(doc)
      armTypingGuard(doc)
    }
  } else if (options.refocus !== false) {
    
    recordFocusSkip(doc)
  }
}





function stripInjectedUI() {
  closeEditor()
  for (const el of [...document.querySelectorAll('[' + TAKEN_ATTR + ']')]) {
    el.removeAttribute(TAKEN_ATTR)
    el.removeAttribute(EDIT_ATTR)
    if (el.classList !== undefined && el.classList.contains('rf3-host')) el.classList.remove('rf3-host')
    for (const own of [...el.querySelectorAll('.rf3-bar, .rf3-editor, .rf3-note')]) own.remove()
  }
  
  
  for (const el of [...document.querySelectorAll('[' + PENDING_TAKEN_ATTR + ']')]) {
    el.removeAttribute(PENDING_TAKEN_ATTR)
    if (el.classList !== undefined) el.classList.remove('rf3-pending')
    for (const own of [...el.querySelectorAll('[data-rf3-pending-btn], .rf3-pending-bar, .rf3-editor, .rf3-note')]) own.remove()
  }
}


const originals = new Map()

function rememberOriginal(fp, text) {
  if (typeof fp !== 'string') return
  if (!originals.has(fp)) originals.set(fp, text)
}

function fpOriginal(block, fp) {
  return originals.get(fp) ?? ownText(block)
}


function makeNote(doc, kind, text) {
  const el = doc.createElement('div')
  el.className = 'rf3-note rf3-note-' + kind
  el.textContent = text
  return el
}






function focusNoteSuffix() {
  const h = lastFocusHandoff
  if (h === null) return ''
  if (h.ok === true) {
    
    
    if (typeof h.candidates === 'number' && h.candidates > 1) {
      return ' · 焦点已交还输入框（页面有 ' + h.candidates + ' 个输入框候选，已择优）'
    }
    return ' · 焦点已交还输入框'
  }
  if (h.reason === 'focus-not-in-editor') return ' · ⚠ 焦点未交还：关闭编辑器时焦点已不在编辑器里'
  if (h.reason === 'no-input') return ' · ⚠ 焦点未交还：页面上没有输入框'
  if (h.reason === 'not-editable') return ' · ⚠ 焦点未交还：输入框暂不可编辑'
  return ' · ⚠ 焦点未交还：' + h.reason
}







function recordFocusSkip(doc) {
  const el = typeof doc.querySelector === 'function' ? doc.querySelector(COMPOSER_INPUT_SELECTOR) : null
  lastFocusHandoff = {
    ok: false,
    editable: el === null ? false : el.isContentEditable === true,
    reason: 'focus-not-in-editor',
    detail: '关闭编辑器时焦点已不在编辑器里',
  }
}











function makeFocusProbe(doc) {
  const probe = () => {
    const { el: c, total } = pickComposerTarget(doc)
    const a = doc.activeElement ?? null
    const h = lastFocusHandoff
    const composerEditable = c === null
      ? null
      : (() => { try { return c.isContentEditable === true } catch { return null } })()
    const visible = c === null ? null : composerVisible(c)
    const selIn = selectionInComposer(doc, c)
    const guardArmed = typingGuardHandler !== null
    const out = {
      lastOk: h === null ? null : h.ok,
      lastReason: h === null ? null : h.reason,
      lastEditable: h === null ? null : h.editable,
      lastCandidates: h === null ? null : h.candidates,
      composerEditable,
      composerVisible: visible,
      composerTotal: total,
      active: describeEl(a),
      activeIsComposer: a === c,
      selectionInComposer: selIn,
      guardArmed,
    }
    out.summary = 'last.ok=' + out.lastOk + ' reason=' + out.lastReason
      + ' | composer.editable=' + out.composerEditable + ' visible=' + out.composerVisible
      + ' total=' + out.composerTotal
      + ' | active=' + out.active + ' selIn=' + out.selectionInComposer
      + ' | guard=' + (out.guardArmed ? 'armed' : 'off')
    
    out.last = h
    out.composer = c === null ? null : {
      editable: composerEditable,
      attr: typeof c.getAttribute === 'function' ? c.getAttribute('contenteditable') : null,
      visible,
    }
    return out
  }
  probe.trace = (ms = 8000) => new Promise(resolve => {
    const samples = []
    const events = []
    const TRACED = ['keydown', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'paste', 'focusin', 'focusout', 'blur']
    const listeners = []
    const record = type => event => {
      
      const t = (event && event.target) !== undefined ? event.target : null
      let desc = 'null'
      if (t !== null && t !== undefined) {
        const cls = typeof t.className === 'string' && t.className !== ''
          ? '.' + t.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
          : ''
        desc = String(t.tagName ?? '?') + cls
      }
      const rec = { t: Date.now(), type, target: desc }
      if (typeof event.key === 'string') rec.key = event.key
      if (typeof event.data === 'string') rec.data = event.data.slice(0, 24)
      if (typeof event.defaultPrevented === 'boolean') rec.prevented = event.defaultPrevented
      events.push(rec)
    }
    for (const type of TRACED) {
      const fn = record(type)
      listeners.push([type, fn])
      try { window.addEventListener(type, fn, true) } catch {  }
    }
    const started = Date.now()
    const cleanup = () => {
      for (const [type, fn] of listeners) {
        try { window.removeEventListener(type, fn, true) } catch {  }
      }
    }
    const tick = () => {
      const s = probe()
      samples.push({
        t: Date.now() - started,
        active: s.active,
        activeIsComposer: s.activeIsComposer,
        editable: s.composerEditable,
        selIn: s.selectionInComposer,
        guard: s.guardArmed,
      })
      if (Date.now() - started >= ms) {
        cleanup()
        resolve({ samples, events })
        return
      }
      try { window.setTimeout(tick, 200) } catch { cleanup(); resolve({ samples, events }) }
    }
    tick()
  })
  return probe
}









function applyOverride(block, text, prefs, docOverride) {
  block.textContent = ''
  renderMarkdown(block, text, docOverride ?? block.ownerDocument)
  if (prefs.autoMark === true) block.setAttribute(EDIT_ATTR, '')
  else block.removeAttribute(EDIT_ATTR)
}









function attachBar(block, doc, getSessionId, prefs, match) {
  let bar = null
  for (const child of (block.children ?? [])) {
    if (child.classList !== undefined && child.classList.contains('rf3-bar')) { bar = child; break }
  }
  if (bar === null) {
    bar = doc.createElement('div')
    bar.className = 'rf3-bar'
    block.append(bar)
  }
  bar.textContent = ''
  
  
  bar.style.display = ''

  const sessionId = getSessionId()
  const fp = taken.get(block)
  const forgeBtn = makeButton(doc, '伪造回复', '就地编辑这条 AI 回复', () => openBlockEditor(block, getSessionId, prefs, doc))
  if (match !== null && match !== undefined) forgeBtn.setAttribute('data-rf3-linked', '')
  bar.append(forgeBtn)
  const override = fp === undefined ? undefined : loadOverrides(sessionId)[fp]
  if (override !== undefined && typeof override.text === 'string') {
    bar.append(makeButton(doc, '还原', '删除本条本机覆盖', () => {
      removeOverride(sessionId, fp)
      block.removeAttribute(EDIT_ATTR)
      
      
      closeEditorOnBlock(doc, block)
      applyOverride(block, fpOriginal(block, fp), prefs, doc)
      attachBar(block, doc, getSessionId, prefs, match)
    }, { 'data-active': true }))
  }
  return bar
}







const PENDING_TAKEN_ATTR = 'data-rf3-pending'


const PENDING_BUBBLE_ATTR = 'data-pending-steering'








const PENDING_TEXT_SKIP = '[data-clock], [data-rf3-pending-btn], .rf3-pending-bar, .rf3-editor, .rf3-note'









function resolveSession(sessions, sessionId) {
  if (isPlaceholderSession(sessionId)) return null
  if (sessions === null || sessions === undefined) return null
  if (typeof sessions.binding !== 'function') return null
  try {
    const binding = sessions.binding(sessionId)
    if (binding === null || binding === undefined) return null
    const session = binding.session
    return session === null || session === undefined ? null : session
  } catch {
    return null
  }
}













function openQueueEditor(bubble, sessions, docOverride) {
  closeEditor({ refocus: false })
  
  
  disarmTypingGuard()
  const doc = docOverride ?? bubble.ownerDocument ?? document
  const sessionId = currentSessionId(doc)
  
  let bubbleKind = 'unknown'
  try {
    bubbleKind = bubble.hasAttribute('data-submission-echo') ? 'echo' : 'host'
  } catch {  }

  const wrap = doc.createElement('div')
  wrap.className = 'rf3-editor'

  const label = doc.createElement('div')
  label.className = 'rf3-hint'
  label.textContent = '编辑待发送消息'

  
  const failOpen = (text, diag) => {
    wrap.textContent = ''
    wrap.append(label, makeNote(doc, 'warn', text))
    if (diag !== undefined) {
      let line = ''
      try { line = JSON.stringify(diag) } catch { line = String(diag) }
      const note = makeNote(doc, 'info', '诊断：' + line)
      note.setAttribute('data-rf3-queue-diag', '')
      wrap.append(note)
      try {
        console.error('[rf3] 待发送队列读取失败：' + text, diag)
        
        const store = doc.defaultView?.localStorage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
        store?.setItem('dsh-reply-forge-v3:queueDiag', JSON.stringify({ at: Date.now(), error: text, diag }))
      } catch {  }
    }
    bubble.append(wrap)
    openEditor = { wrap, doc, kind: 'queue', anchor: bubble }
  }

  const session = resolveSession(sessions, sessionId)
  if (session === null) {
    failOpen('当前会话还没准备好，稍后再试', queueDiag(null, { sessionId, bubbleKind }))
    return
  }
  const bubbleText = bubbleTextOf(bubble, PENDING_TEXT_SKIP)
  const bubbleHead = bubbleText.slice(0, 40)

  
  
  
  const anchor = pendingAnchors.get(bubble)
  if (anchor !== undefined) {
    const byId = resolvePendingItemById(readInboxRows(session), anchor.itemId)
    if (byId.ok === true) {
      buildQueueEditor(session, byId.itemId, byId.text, bubble, doc, wrap, label)
      return
    }
  }

  
  
  
  const inbox = readInbox(session)
  const resolved = resolvePendingItem(inbox, bubbleText)
  if (resolved.ok === true) {
    buildQueueEditor(session, resolved.itemId, resolved.text, bubble, doc, wrap, label)
    return
  }

  
  
  
  
  if (hasPendingEcho(session, bubbleText)) {
    waitForInboxLanding(session, bubbleText, bubble, doc, wrap, label, failOpen, sessionId, bubbleKind, bubbleHead, anchor)
    return
  }

  
  
  
  
  const rows = readInboxRows(session)
  const sent = findSentBubble(doc, bubbleText)
  const specific = resolved.error.includes('附件') || resolved.error.includes('多个相同')
  const sameText = hasTextMatchRow(rows, bubbleText)
  let why
  if (rows === null) {
    why = '读不到待发送队列（投影读取失败），请稍后重试'
  } else if (rows.length === 0) {
    why = '待发送队列是空的——这条消息已经不在队列里了（可能已开始生成）'
  } else if (specific) {
    
    why = resolved.error
  } else if (sameText === true) {
    why = '队列里有同文本的消息，但它不是待发送的用户消息，无法定位'
  } else {
    why = `队列里有 ${rows.length} 条待发送消息，但都不是你点的这条（它可能已经发出去了）`
  }
  if (sent === true) {
    why += '；对话里已经能看到这条消息，说明它已经发送成功，待发送编辑只对还没发送的消息有效'
  }
  failOpen(why, queueDiag(session, {
    sessionId, bubbleKind, bubbleTextHead: bubbleHead,
    sentInTranscript: sent,
    anchor: anchor === undefined ? 'none' : { itemId: anchor.itemId },
  }))
}

/** 在途轮询的节奏：200ms 一次，最多等 6s（宿主入队通常在 1s 内）。 */
const INBOX_LANDING_POLL_MS = 200
const INBOX_LANDING_TIMEOUT_MS = 6000

/**
 * 消息在途时的等待：轮询 inbox 投影，等这条消息落库后原地换成编辑器。
 *
 * 停下来的条件有三个：落库成功（换编辑器）、超时（如实报错 + 诊断）、
 * wrap 被拔掉（用户按 Esc 或 closeEditor 抢先关掉——轮询回调自停）。
 *
 * @param {string} [bubbleHead] 气泡文本头（只进诊断）
 * @param {{ itemId: string } | undefined} [anchor] 接管时预取的锚点（只进诊断）
 */
function waitForInboxLanding(session, bubbleText, bubble, doc, wrap, label, failOpen, sessionId, bubbleKind, bubbleHead = '', anchor = undefined) {
  const diagExtra = {
    sessionId, bubbleKind, bubbleTextHead: bubbleHead,
    anchor: anchor === undefined ? 'none' : { itemId: anchor.itemId },
  }
  const note = makeNote(doc, 'info', '消息正在进入队列，请稍候…')
  wrap.append(label, note)
  bubble.append(wrap)
  openEditor = { wrap, doc, kind: 'queue-wait', anchor: bubble }
  const deadline = Date.now() + INBOX_LANDING_TIMEOUT_MS
  const timer = setInterval(() => {
    if (openEditor === null || openEditor.wrap !== wrap || wrap.isConnected === false) {
      clearInterval(timer)
      return
    }
    const resolved = resolvePendingItem(readInbox(session), bubbleText)
    if (resolved.ok === true) {
      clearInterval(timer)
      wrap.textContent = ''
      buildQueueEditor(session, resolved.itemId, resolved.text, bubble, doc, wrap, label)
      return
    }
    // 回显消失了但投影还是没有 = 消息没能入队（发送失败 / 已被宿主处理），
    // 不用等满超时。
    if (hasPendingEcho(session, bubbleText) !== true) {
      clearInterval(timer)
      openEditor = null
      failOpen(
        '这条消息没有进入待发送队列（可能发送失败或已被处理）。',
        queueDiag(session, diagExtra)
      )
      return
    }
    if (Date.now() >= deadline) {
      clearInterval(timer)
      openEditor = null
      failOpen(
        '这条消息一直没有进入待发送队列（可能已发出或被宿主拒绝）。若反复出现，请把下面的诊断信息反馈给插件作者。',
        queueDiag(session, diagExtra)
      )
    }
  }, INBOX_LANDING_POLL_MS)
  openEditor.poll = timer
}

/**
 * 构造队列编辑器本体（textarea + 保存/取消）。
 *
 * 不负责把 wrap 挂上气泡——两个调用方（直接定位成功 / 轮询落库后）各自挂，
 * 避免「轮询路径重复 append」。
 */
function buildQueueEditor(session, itemId, text, bubble, doc, wrap, label) {
  const area = doc.createElement('textarea')
  area.value = text
  area.spellcheck = false
  area.setAttribute('aria-label', '编辑待发送消息')
  // 点击保险与 openBlockEditor 同源：真机上宿主会在 mousedown 之后把焦点
  // 弄丢，导致「点进 textarea 不出光标」。只在确实丢了时补 focus，
  // 不抢用户用键盘刻意放在别处的焦点。
  const reassertAreaFocus = () => {
    try {
      const active = doc.activeElement ?? null
      if (active !== area && area.isConnected !== false) {
        if (typeof area.focus === 'function') area.focus()
      }
    } catch { /* 忽略 */ }
  }
  area.addEventListener('mouseup', reassertAreaFocus)
  area.addEventListener('click', reassertAreaFocus)

  const row = doc.createElement('div')
  row.className = 'rf3-row'

  const status = doc.createElement('span')
  status.className = 'rf3-hint'
  status.textContent = '消息还没发给模型 · Ctrl+Enter 保存 · Esc 取消'

  const saveBtn = makeButton(doc, '保存', '修改队列里这条待发送消息', () => submit())
  const cancelBtn = makeButton(doc, '取消', '放弃修改', () => closeEditor())
  row.append(status, saveBtn, cancelBtn)

  area.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    }
  })

  let saving = false
  const submit = async () => {
    if (saving === true) return
    const next = String(area.value ?? '')
    // 与服务端同一条判据（index.js 825 行：必须含非空白字符）。
    if (next.trim() === '') {
      status.textContent = '内容不能为空'
      return
    }
    saving = true
    saveBtn.disabled = true
    cancelBtn.disabled = true
    status.textContent = '保存中…'
    const failure = await submitQueueEdit(session, itemId, next)
    if (failure === null) {
      // inbox 投影会自己刷新气泡，这里不需要重扫；焦点交还由 closeEditor 负责。
      closeEditor()
      return
    }
    // 失败要能把按钮放回来：定位失效（itemId 过期）是失败里最常见的，
    // 用户改完文案重试一次往往就好了，不该被迫重开编辑器。
    saving = false
    saveBtn.disabled = false
    cancelBtn.disabled = false
    status.textContent = failure
    try { area.focus() } catch { /* 忽略 */ }
  }

  wrap.append(label, area, row)
  bubble.append(wrap)
  openEditor = { wrap, doc, kind: 'queue', anchor: bubble }
  try { area.focus() } catch { /* 忽略 */ }
}

/**
 * 给一个 pending 气泡挂编辑入口。幂等：已接管就跳过。
 *
 * 宿主每次刷新队列都会重渲染这些气泡，所以接管必须像 takeBlock 一样可重复
 * 执行——新节点没标记就接管，老节点有标记就跳过。
 *
 * 接管的同时**预取定位锚点**（见 pendingAnchors）：此刻投影与渲染一致，按文本
 * 解析出的 itemId 是点击时可复核的强锚点。
 */
function takePendingBubble(bubble, sessions, doc) {
  if (bubble.hasAttribute(PENDING_TAKEN_ATTR)) return
  bubble.setAttribute(PENDING_TAKEN_ATTR, '')
  // 位置上下文单独加 class，不直接样式化宿主的 data-pending-steering
  // （命名隔离纪律：我们的外观只由 rf3-* 类决定）。
  if (bubble.classList !== undefined) bubble.classList.add('rf3-pending')
  const bar = doc.createElement('div')
  bar.className = 'rf3-pending-bar'
  const btn = makeButton(doc, '改待发送', '修改这条还没发给模型的消息', () => {
    openQueueEditor(bubble, sessions, doc)
  })
  btn.setAttribute('data-rf3-pending-btn', '')
  bar.append(btn)
  bubble.append(bar)
  const anchor = prefetchPendingAnchor(bubble, sessions, doc)
  if (anchor !== null) pendingAnchors.set(bubble, anchor)
}

/**
 * 接管瞬间按气泡文本预取 itemId。
 *
 * 只读投影、全部兜底；失败（投影还没有这行、文本撞车、会话没就绪）就返回
 * null——点击时会走完整定位路径，预取只是优化，不是前提。
 *
 * @returns {{ itemId: string } | null}
 */
function prefetchPendingAnchor(bubble, sessions, doc) {
  try {
    const session = resolveSession(sessions, currentSessionId(doc))
    if (session === null) return null
    const text = bubbleTextOf(bubble, PENDING_TEXT_SKIP)
    const resolved = resolvePendingItem(readInbox(session), text)
    if (resolved.ok !== true) return null
    return { itemId: resolved.itemId }
  } catch {
    return null
  }
}

/**
 * 对话里是否已有同文本的**已发送**用户气泡。
 *
 * 用于「点击的待发送气泡已经不在队列里」时交叉验证：消息若已被回合 claim，
 * 它会以普通用户消息（无 data-pending-steering）出现在对话里。宿主用户行的
 * class 是 CSS module 哈希名（cJsG2q_userRow 之类，会随构建变），所以用
 * `[class*="userRow"]` 宽容匹配。
 *
 * @param {Document} doc
 * @param {string} text 气泡可见文本
 * @returns {boolean}
 */
function findSentBubble(doc, text) {
  try {
    const target = collapseWhitespace(text)
    if (target === '') return false
    const nodes = doc.querySelectorAll('[class*="userRow"]')
    for (const node of nodes) {
      if (typeof node.hasAttribute !== 'function') continue
      // pending 气泡（含自己点的这条）不算「已发送」。
      if (node.hasAttribute('data-pending-steering')) continue
      const seen = collapseWhitespace(bubbleTextOf(node, PENDING_TEXT_SKIP))
      if (seen !== '' && seen === target) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 扫描并接管页面上的待发送气泡。
 *
 * 蹭 scan 的现有节流，不另起调度器：宿主刷新队列和刷新消息流是同一批 React
 * 渲染，多一个 observer 只会更吵。没有 sessions 服务时整段跳过——旧宿主上
 * 这个入口根本不该出现。
 */
function takePendingBubbles(doc) {
  if (sessionsRef === null || sessionsRef === undefined) return
  if (doc === null || doc === undefined) return
  if (typeof doc.querySelectorAll !== 'function') return
  try {
    const bubbles = [...doc.querySelectorAll('[' + PENDING_BUBBLE_ATTR + ']')]
    for (const bubble of bubbles) {
      try {
        takePendingBubble(bubble, sessionsRef, doc)
      } catch (error) {
        log('接管待发送气泡失败', error)
      }
    }
  } catch { /* 忽略 */ }
}

/**
 * 打开编辑器：把一块消息就地换成 textarea，并提供两个保存出口。
 * 会话 id 在**打开这一刻**解析一次并固定：编辑器是模态的，开着的期间
 * 用户不会同时切会话。
 */
function openBlockEditor(block, getSessionId, prefs, docOverride) {
  closeEditor({ refocus: false })
  // 打字保险丝在编辑器开着期间必须解除：用户在 textarea 里打字是正经输入，
  // 且 select/按钮操作不该被「拉回输入框」干扰。
  disarmTypingGuard()
  // 两步确认的已确认指纹：内容/目标/写入方式任一变化即失效（见 saveRecord）。
  let confirmedForge = null
  // 点击「写入伪造」当场记下的「焦点原本在编辑器里」。点击会把焦点放到按钮上，
  // 紧接着的两个 disable 会让 Chromium 把焦点打到 <body>，等异步写完再来关
  // 编辑器时「焦点在不在 wrap 里」已经看不出来——用它把交还那一步捞回来。
  let hadFocusAtClick = false
  const sessionId = getSessionId()
  const doc = docOverride ?? block.ownerDocument ?? document
  // let 而不是 const：记录过期时下面会重读后补定位，结果要能就地更新。
  let match = blockMatch.get(block) ?? null
  // 用户是否从目标下拉里选了**别的**消息（不是页面上这一条）。
  // 选了就要关掉「仅本机渲染」——那条出口只能改本节点在页面上的样子。
  let pickedForeign = false

  // 初值取「当前显示的正文」：有本机覆盖就是覆盖内容，否则是块里非本插件 UI 的文本。
  const blockFp = taken.get(block)
  const applied = blockFp === undefined ? undefined : loadOverrides(sessionId)[blockFp]
  const original = (applied !== undefined && typeof applied.text === 'string')
    ? applied.text
    : ownText(block)

  const wrap = doc.createElement('div')
  wrap.className = 'rf3-editor'

  const label = doc.createElement('div')
  label.className = 'rf3-hint'
  label.textContent = '编辑 AI 回复'

  const area = doc.createElement('textarea')
  area.value = original
  area.spellcheck = false
  area.setAttribute('aria-label', '编辑 AI 回复')
  // 点击保险：真机上出现过「点进 textarea 不出光标」——宿主在 mousedown 之后
  // 把焦点弄丢了（焦点最终停在 <body>）。这里在 click/mouseup（宿主自己的
  // 处理器都跑完之后）检查一次：焦点不在 textarea 上就补 focus。
  // 只在「确实丢了」时动手，不抢用户用键盘刻意放在别处的焦点。
  const reassertAreaFocus = () => {
    try {
      const active = doc.activeElement ?? null
      if (active !== area && area.isConnected !== false) {
        if (typeof area.focus === 'function') area.focus()
      }
    } catch { /* 忽略 */ }
  }
  area.addEventListener('mouseup', reassertAreaFocus)
  area.addEventListener('click', reassertAreaFocus)

  const row = doc.createElement('div')
  row.className = 'rf3-row'

  const status = doc.createElement('span')
  status.className = 'rf3-hint'
  status.textContent = 'Ctrl+Enter 保存 · Esc 取消'

  const spacer = doc.createElement('span')
  spacer.className = 'rf3-spacer'

  // 状态行容器：定位结果与写入结果都往里追加。
  // 注意不能往「已经展开进 DOM 的数组」里 push —— 那样新节点根本不在文档里
  // （踩过：写入失败的提示永远不显示）。
  const notes = doc.createElement('div')
  notes.className = 'rf3-notes'

  const head = [label, notes]

  // 指纹重名警示：宿主不提供稳定消息 id，正文完全相同的两条消息会共享
  // 同一条本机覆盖。落盘出口不受影响（走 seq 寻址），必须分别说明。
  const dup = dupCount.get(block) ?? 1
  if (dup > 1) {
    notes.append(makeNote(doc, 'warn',
      '⚠ 本会话有 ' + dup + ' 条正文完全相同的消息。本机渲染覆盖由它们共享；'
      + '写入伪造只作用于当前这一条。'))
  }

  // ── 落盘定位状态 ────────────────────────────────────────────────────────
  // 定位不到就不给落盘出口：宁可少一个按钮，也不能猜个位置去写。
  // 失败原因要分开讲——「记录没读到」「记录是空的」「这条对不上」是三件
  // 完全不同的事，全都显示同一句话会让排查变成猜谜（踩过）。
  //
  // match 用 let：记录过期时下方会先重读再补定位，定位结果要能就地更新。
  const matchNote = doc.createElement('div')
  let relocating = false

  // 写入方式（v3.1）：用户显式选这次走哪条路。
  // v3 一开始是隐式 auto——宿主自己决定在线还是落盘。真机反馈是「我想自己
  // 控制」，而且两条路的前提（要不要重启、会不会动磁盘）差别太大，不该由
  // 插件替用户猜。默认仍是 auto。
  let prefer = 'auto'

  /** 「这次写入会怎么生效」的一句话说明（跟随写入方式下拉框）。 */
  const modeHint = (rec, mode) => {
    const isLive = rec !== null && rec.mode === 'live'
    if (mode === 'live') {
      return '⚡ 仅在线：写进活会话，下一轮对话立即生效（不用重启）。'
        + (isLive ? '' : ' ⚠ 这个会话当前不在内存里，这么选会写入失败。')
    }
    if (mode === 'disk') {
      return '💾 仅落盘：写入会话记录文件（自动备份），该会话下次载入时生效。'
        + (isLive ? ' ⚠ 这个会话在内存里，要等它被重新载入才对模型生效。' : '')
    }
    return isLive
      ? '⚡ 自动：这个会话在内存里 → 写活会话，下一轮对话立即生效（不用重启）。'
      : '💾 自动：这个会话不在内存里 → 落盘写入会话记录文件，该会话下次载入时生效。'
  }

  const renderMatch = () => {
    matchNote.textContent = ''
    if (match === null) {
      const rec = cachedRecord(sessionId)
      if (relocating === true) {
        matchNote.append(makeNote(doc, 'info', '⏳ 会话记录可能不是最新的，正在重新读取…'))
      } else if (isPlaceholderSession(sessionId)) {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 还没识别出当前会话（会话容器尚未就绪）。稍等片刻，或点「重新读取」。'))
      } else if (rec === null) {
        matchNote.append(makeNote(doc, 'warn', '⚠ 正在读取会话记录…稍后重开本编辑器。'))
      } else if (rec.error !== null) {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 读取会话记录失败：' + rec.error + '（点「重新读取」重试）'))
      } else if (rec.blocks.length === 0) {
        // 空清单分两种，别用同一句话糊过去：
        //  · 在线空 = 宿主还没把这条回复登记进活会话（新会话、流式输出中）；
        //    本插件会自动重读，通常一两秒内就好——不能吓唬用户去重启。
        //  · 落盘空 = 会话确实还没落盘（或压根没有助手正文）。
        matchNote.append(makeNote(doc, 'warn', rec.mode === 'live'
          ? '⏳ 宿主还没把这条回复登记进会话（新会话或还在输出中）。稍等一两秒，或点「重新读取」。'
          : '⚠ 会话记录里没有可定位的助手正文（这个会话可能还没落盘过）。'))
      } else {
        matchNote.append(makeNote(doc, 'warn',
          '⚠ 未在会话记录中定位到这条回复（记录里有 ' + rec.blocks.length + ' 条正文，'
          + '可能是含公式/表格/代码等渲染差异导致对不上）。'))
      }
    } else if (match.exact !== true) {
      matchNote.append(makeNote(doc, 'warn',
        '⚠ 与记录中的位置是按顺序推断的（seq=' + match.seq + '），未做内容比对。'
        + '写入前请确认正文无误。'))
    } else {
      matchNote.append(makeNote(doc, 'ok', '✓ 已定位到会话记录 seq=' + match.seq + '（块 ' + match.blockIndex + '）'))
    }
    // v3：把「这次写入会不会立即生效」摆在最显眼处——这是用户最关心的一件事，
    // 也是 v3 相对 v2 的全部价值所在。
    const modeRec = cachedRecord(sessionId)
    if (modeRec !== null && modeRec.error === null && match !== null) {
      matchNote.append(makeNote(doc, 'info', modeHint(modeRec, prefer)))
    }
    saveRecord.disabled = match === null
    renderTargets()
  }

  notes.append(matchNote)

  const cancel = makeButton(doc, '取消', '放弃改动', () => closeEditor())

  const refresh = makeButton(doc, '重新读取', '重新读取会话记录并重新定位', () => {
    closeEditor()
    readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
      .then(() => { if (scheduleScanRef !== null) scheduleScanRef() })
      .catch(error => log('重新读取失败', error))
  })

  const reset = makeButton(doc, '还原原文', '删除本条本机覆盖', () => {
    const fp = taken.get(block)
    if (typeof fp === 'string') {
      removeOverride(sessionId, fp)
      block.removeAttribute(EDIT_ATTR)
      closeEditorOnBlock(doc, block)
      applyOverride(block, fpOriginal(block, fp), prefs, doc)
      attachBar(block, doc, getSessionId, prefs, match)
    } else {
      closeEditor()
    }
  }, { 'data-danger': true })

  const saveLocal = makeButton(doc, '仅本机渲染', '只改本页显示，模型看不见（Ctrl+Enter）', () => {
    const next = area.value
    const fp = taken.get(block) ?? fingerprint(original)
    setOverride(sessionId, fp, next)
    // 先关编辑器交还焦点，再就地重写消息块。反过来做（先 applyOverride）
    // 会把正拿着焦点的 textarea 连块一起抹掉，焦点掉到 <body> ——
    // 真机上就是「保存完输入框打不了字、没有光标」。
    closeEditorOnBlock(doc, block)
    applyOverride(block, next, prefs, doc)
    attachBar(block, doc, getSessionId, prefs, match)
    block.append(makeNote(doc, 'ok', '本机渲染已保存' + focusNoteSuffix()))
  })

  const saveRecord = makeButton(doc, '写入伪造', '让模型采信改后的内容（在线立即生效，落盘则需会话重新载入）', () => {
    const next = area.value
    // 点击会把焦点放到本按钮上；紧接着的两个 disable 会让 Chromium 把焦点打到
    // <body>（聚焦元素被 disable 的既定行为），异步写完再来关编辑器时「焦点在
    // 不在 wrap 里」已经看不出来了。所以在点击当场（disable 之前）先记下
    // 「焦点原本在编辑器里」，让 closeEditorOnBlock 敢把焦点交还出去。
    hadFocusAtClick = wrap.contains(doc.activeElement)
    if (normalizeText(next) === normalizeText(original)) {
      status.textContent = '内容没有变化。'
      return
    }
    // 两步确认（页面内）：第一次点击只出确认行，第二次才真写。
    // 内容 / 目标 / 写入方式任一变化，确认即失效，要重新确认。
    // 不用 window.confirm：那是 OS 级原生模态框，真机上会把 app 窗口的键盘
    // 焦点弄丢——「焦点全绿却打不了字」的疑凶（2026-10-17 中午定位）。
    const fpNow = (match === null ? 'null' : match.seq + ':' + match.blockIndex)
      + '|' + prefer + '|' + normalizeText(next)
    if (confirmedForge !== fpNow) {
      confirmedForge = fpNow
      notes.append(makeNote(doc, 'warn', confirmWriteNote(next, match, prefer)))
      status.textContent = '请阅读上方确认信息，再次点击「写入伪造」执行写入'
      return
    }
    confirmedForge = null
    runForge()
  }, { 'data-rf3-primary': true })

  /**
   * 发起一次写入（可被陈旧自动重试复用）。
   *
   * STALE_TARGET 的真机成因（2026-10-17 下午，seq=15）：会话重启后磁盘记录与
   * 内存投影不一致（此前的在线伪造被落盘，投影盖过原文），而界面侧记录读到的是
   * 未过投影的原文 → expectText 对不上 → 被拒。服务端读路由现已同样过投影
   * （routes.mjs），一般不会再发生；这里仍保留**自动重试一次**兜底：
   * 强制重读记录 → 重新定位 → 用新 expectText 再写一次。失败就把两边文本
   * 都摆出来（actual/expected），不再让用户猜。
   */
  let forgeAttempt = 0
  const runForge = () => {
    if (match === null) {
      status.textContent = '定位不到这条回复，无法写入。'
      return
    }
    forgeAttempt += 1
    status.textContent = forgeAttempt > 1 ? '正在重试（第 ' + forgeAttempt + ' 次）…' : '正在写入…'
    saveRecord.disabled = true
    saveLocal.disabled = true
    forgeRecord({
      sessionId,
      seq: match.seq,
      blockIndex: match.blockIndex,
      // v3：块种类一起带上，思维链与正文走同一条路。
      kind: match.kind ?? 'text',
      newText: area.value,
      expectText: match.text,
      // 用户在「写入方式」里选的那条路：auto 由宿主先试在线、再落盘；
      // live / disk 是显式指定，宿主不替用户改主意（失败就如实报错）。
      prefer,
    }).then(res => {
      saveRecord.disabled = false
      saveLocal.disabled = pickedForeign
      if (res.ok !== true) {
        status.textContent = ''
        if (res.code === 'STALE_TARGET' && forgeAttempt === 1) {
          // 自动重试一次：重读记录 → 重新定位 → 再写
          notes.append(makeNote(doc, 'info',
            '⟳ 写入时发现记录已变化（' + staleDetail(res) + '），自动重新读取后重试…'))
          relocateThenRetry()
          return
        }
        notes.append(makeNote(doc, 'warn', '✖ ' + (res.error || '写入失败')
          + (res.code === 'STALE_TARGET'
            ? '（' + staleDetail(res) + '。点「重新读取」后重试）'
            : '')))
        return
      }
      // 写入成功后同步一份本机覆盖：界面立刻看到结果，且与记录一致。
      // 只在改的就是本节点时做——改的是别的消息（从下拉里选的）时，
      // 本节点不该跟着变。
      if (pickedForeign !== true) {
        const fp = taken.get(block) ?? fingerprint(original)
        setOverride(sessionId, fp, area.value)
        // 先关编辑器交还焦点，再就地重写消息块。反过来做的话，抹块时焦点
        // 还落在编辑器里，焦点会掉到 <body>——真机表现是「写完伪造后输入框
        // 打不了字、没有光标，点一下 + 添加文件才能继续输入」。
        closeEditorOnBlock(doc, block, { hadFocusAtClick })
        applyOverride(block, area.value, prefs, doc)
        attachBar(block, doc, getSessionId, prefs, match)
      } else {
        closeEditorOnBlock(doc, block, { hadFocusAtClick })
      }
      // 记录已变，缓存作废，重新读一遍让后续定位对得上。
      resetCache(sessionId)
      readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
        .then(() => { if (scheduleScanRef !== null) scheduleScanRef() })
        .catch(() => {})
      block.append(makeNote(doc, 'ok', doneNote(res) + focusNoteSuffix()))
    }).catch(error => {
      saveRecord.disabled = false
      saveLocal.disabled = pickedForeign
      status.textContent = '写入异常：' + String((error && error.message) || error)
    })
  }

  /** 陈旧失败时把「记录里实际是什么 / 界面以为是什么」摆出来。 */
  const staleDetail = res => {
    const actual = typeof res.actual === 'string' ? res.actual : null
    const expected = typeof res.expected === 'string' ? res.expected : null
    if (actual === null && expected === null) return '内容已被改动'
    const cut = t => String(t).replace(/\s+/g, ' ').slice(0, 40)
    return '记录里是「' + cut(actual ?? '') + '」，界面预期「' + cut(expected ?? '') + '」'
  }

  /** 陈旧自动重试：强制重读 → 重新定位 → 原样再写一次（只重试一次）。 */
  const relocatingRetry = { value: false }
  const relocateThenRetry = () => {
    if (relocatingRetry.value === true) return
    relocatingRetry.value = true
    status.textContent = '正在重新读取会话记录…'
    readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
      .then(() => {
        const rec = cachedRecord(sessionId)
        if (rec === null || rec.error !== null || Array.isArray(rec.blocks) === false) {
          notes.append(makeNote(doc, 'warn', '✖ 自动重试失败：会话记录读取不到。点「重新读取」后再试。'))
          status.textContent = ''
          return
        }
        // 重新定位：优先内容匹配（与扫描同口径），失败再用顺序推断。
        const live = pickAssistantBlocks(conversationRoot(doc), classifyNaturalLanguage, { includeTaken: true })
        const idx = live.indexOf(block)
        const fresh = idx === -1
          ? null
          : (matchBlocks(rec.blocks, live.map(ownText))[idx] ?? null)
        if (fresh === null) {
          notes.append(makeNote(doc, 'warn',
            '✖ 自动重试失败：重新读取后这条回复仍对不上记录。点「重新读取」打开新编辑器再试。'))
          status.textContent = ''
          return
        }
        match = fresh
        blockMatch.set(block, fresh)
        renderMatch()
        runForge()
      })
      .catch(error => {
        notes.append(makeNote(doc, 'warn', '✖ 自动重试失败：' + String((error && error.message) || error)))
        status.textContent = ''
      })
  }

  // ── 目标选择（v3）────────────────────────────────────────────────────────
  // 页面上拾取不到的块也能改。典型是**思维链**：它在宿主里是可折叠行，
  // 子元素只有 span/svg（没有块级子元素），picker 的 markdown 形状判定天然
  // 收不到它；被虚拟化折叠掉的历史回复同理。
  // 这里直接列出宿主给的「可编辑块清单」——它来自 seq+blockIndex 寻址，
  // 与 DOM 长什么样无关，所以思维链和折叠历史都能选到。
  let currentValue = match === null ? '' : match.seq + ':' + match.blockIndex

  const targetRow = doc.createElement('div')
  targetRow.className = 'rf3-targets'
  const targetSel = doc.createElement('select')
  targetSel.className = 'rf3-select'
  targetSel.setAttribute('aria-label', '选择要改的块')

  const renderTargets = () => {
    targetSel.textContent = ''
    const rec = cachedRecord(sessionId)
    const blocks = (rec !== null && rec.error === null && Array.isArray(rec.blocks)) ? rec.blocks : []
    const blank = doc.createElement('option')
    blank.value = ''
    blank.textContent = blocks.length === 0
      ? '（这个会话还没有可编辑块）'
      : ('跟随页面上的这条' + (match === null ? '（当前未定位到）' : ''))
    targetSel.append(blank)
    for (const b of blocks) {
      const value = b.seq + ':' + b.blockIndex
      const opt = doc.createElement('option')
      opt.value = value
      const preview = normalizeText(b.text).slice(0, 46)
      opt.textContent = (b.kind === 'reasoning' ? '【思维链】' : '【正文】')
        + ' seq=' + b.seq + ' 块' + b.blockIndex + ' · ' + preview + (b.text.length > 46 ? '…' : '')
      if (value === currentValue) opt.selected = true
      targetSel.append(opt)
    }
    targetSel.disabled = blocks.length === 0
  }

  targetSel.addEventListener('change', () => {
    // 目标换了，之前那个「再次点击确认」不再算数——重新确认。
    confirmedForge = null
    const value = String(targetSel.value ?? '')
    if (value === '') {
      // 回到「跟随页面上的这条」
      pickedForeign = false
      match = blockMatch.get(block) ?? null
      const fp = taken.get(block)
      const appliedLocal = fp === undefined ? undefined : loadOverrides(sessionId)[fp]
      area.value = (appliedLocal !== undefined && typeof appliedLocal.text === 'string')
        ? appliedLocal.text
        : ownText(block)
      saveLocal.disabled = false
    } else {
      const rec = cachedRecord(sessionId)
      const blocks = (rec !== null && rec.error === null && Array.isArray(rec.blocks)) ? rec.blocks : []
      const found = blocks.find(b => (b.seq + ':' + b.blockIndex) === value)
      if (found === undefined) return
      // 目标清单直接来自宿主（在线模式下就是模型可见的那一份），
      // 所以定位是确定的，exact: true。
      match = { seq: found.seq, blockIndex: found.blockIndex, kind: found.kind ?? 'text', text: found.text, exact: true }
      pickedForeign = true
      area.value = found.text
      // 本机渲染只能改本节点，改别的消息时这条出口没有意义。
      saveLocal.disabled = true
    }
    currentValue = match === null ? '' : match.seq + ':' + match.blockIndex
    renderMatch()
  })

  targetRow.append(targetSel)

  // ── 写入方式（v3.1）──────────────────────────────────────────────────────
  // 两条路的前提差别很大（要不要重启、动不动磁盘），交给用户显式选。
  // 默认 auto：会话在内存里就立即生效，不在就落盘——对多数人这是对的。
  const MODES = [
    ['auto', '自动（推荐）'],
    ['live', '仅在线（立即生效）'],
    ['disk', '仅落盘（重载后生效）'],
  ]
  const modeSel = doc.createElement('select')
  modeSel.className = 'rf3-mode'
  modeSel.setAttribute('aria-label', '写入方式')
  for (const [value, label] of MODES) {
    const opt = doc.createElement('option')
    opt.value = value
    opt.textContent = label
    if (value === prefer) opt.selected = true
    modeSel.append(opt)
  }
  modeSel.value = prefer
  modeSel.addEventListener('change', () => {
    // 写入方式换了，确认同样失效——两条路的前提不同，必须重新确认。
    confirmedForge = null
    const picked = String(modeSel.value ?? '')
    prefer = picked === 'live' || picked === 'disk' ? picked : 'auto'
    renderMatch()
  })
  targetRow.append(modeSel)

  row.append(status, spacer, refresh, reset, cancel, saveLocal, saveRecord)
  renderMatch()
  wrap.append(...head, targetRow, area, row)

  block.append(wrap)
  try { area.focus() } catch { /* 忽略 */ }

  // ── 记录可能比页面旧：先重读，再下结论 ──────────────────────────────────
  // 宿主把新回复渲染进 DOM 之后约 200ms 才落盘（dsh-session-persistence-jsonl
  // 的 enqueueLive 是 setTimeout 批处理），而记录缓存不会自己更新。此刻直接
  // 宣判「对不上」就是真机上那个 bug：伪造第一条之后，后面每条新回复都永久
  // 定位失败。所以记录明显比页面旧时，先重读一次，读完就地补定位。
  if (match === null) {
    try {
      const live = pickAssistantBlocks(conversationRoot(doc), classifyNaturalLanguage, { includeTaken: true })
      const idx = live.indexOf(block)
      if (idx !== -1) {
        const liveTexts = live.map(ownText)
        const rec = cachedRecord(sessionId)
        // 两种「记录明显比页面旧」：
        //  · 落盘记录非空但比页面少 → 宿主还没落盘；
        //  · 在线记录为空 → 宿主还没把这条回复登记进活会话（新会话/流式中）。
        //    v3.0 只认前一种，于是新会话永远停在「没有可定位的助手正文」。
        // 记录读失败是终态信息，重读也不会变，直接按原样提示（可点「重新读取」）。
        const stale = rec !== null && rec.error === null
          && ((rec.blocks.length > 0 && liveTexts.length > rec.blocks.length)
            || (rec.mode === 'live' && rec.blocks.length === 0))
        if (stale === true) {
          relocating = true
          renderMatch()
          readRecord(sessionId, { force: true, domSignature: domSignatureNowRef() })
            .then(() => {
              const fresh = cachedRecord(sessionId)
              if (fresh === null || fresh.error !== null || fresh.blocks.length === 0) return
              const next = matchBlocks(fresh.blocks, liveTexts)[idx] ?? null
              if (next !== null) {
                match = next
                blockMatch.set(block, next)
              }
            })
            .catch(error => log('重新读取失败', error))
            .then(() => {
              relocating = false
              renderMatch()
              if (scheduleScanRef !== null) scheduleScanRef()
            })
        }
      }
    } catch (error) {
      log('补定位失败', error)
    }
  }

  area.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeEditor(); return }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      // Ctrl+Enter = 本机渲染（可逆、无风险）；落盘改写必须用鼠标点，
      // 免得手快把一个不可逆操作顺手做了。
      saveLocal.click()
    }
  })

  // 编辑器开着时把**这个块**的操作条藏起来：bar 是绝对定位 z-index:5，会压在
  // 编辑器的右上角（目标下拉那一带），真机上点不中的目标有一半是它盖的。
  // 关编辑器时 attachBar 重建会恢复显示。
  try {
    for (const child of (block.children ?? [])) {
      if (child.classList !== undefined && child.classList.contains('rf3-bar')) {
        child.style.display = 'none'
      }
    }
  } catch { /* 忽略 */ }

  openEditor = { wrap, block, doc }
}

/**
 * 写入成功后的结果说明。
 *
 * v3 的关键区别就在这里：宿主实际走了哪条路决定「要不要重启」。
 * 在线（live）写的是活会话对象，下一轮对话模型立刻看到新内容；
 * 落盘（disk）写的是磁盘记录，要等该会话被重新载入。这两句话必须分开说，
 * 否则用户永远不知道自己这次改动到底生效了没有。
 */
function doneNote(res) {
  if (res.mode === 'live') {
    return '✓ 已写入活会话 · 下一轮对话模型就看到改后的内容（不用重启）'
  }
  // 只有这三个 code 会被路由放行到落盘分支（routes.mjs 的 auto 白名单）；
  // 其余失败码（APPEND_UNSAFE 等）根本走不到这里，不配文案。
  const why = res.liveCode === 'SESSION_NOT_LIVE' ? '（该会话当前不在内存里）'
    : res.liveCode === 'NO_SESSIONS_SERVICE' ? '（拿不到宿主的 sessions 服务）'
      : res.liveCode === 'WRITER_NOT_ROUTED' ? '（这台宿主持久化没有这个会话的写句柄，已自动改为写会话记录）'
        : ''
  return '✓ 已写入会话记录' + why + ' · 该会话下次载入时生效'
    + (typeof res.backup === 'string' ? ' · 备份：' + res.backup : '')
}

/**
 * 写入前的确认文案（页面内两步确认的第一步展示用）。
 *
 * 这里**不再**写死「必须重启」——v3 多数情况下是在线写入、立即生效。
 * 只把两条路径各自的前提讲清楚，并把用户这次选的写入方式原样复述一遍，
 * 让用户自己判断当前这次属于哪种。
 *
 * 为什么不用 window.confirm：Electron 里它是 **OS 级原生模态框**，真机上
 * 会把 app 窗口的键盘焦点弄丢（Windows 上尤甚）——表现正是「DOM 焦点/
 * selection 全绿却打不了字」（鼠标还能用、按键进不来）。改为编辑器内的
 * 确认行 + 再次点击确认，UI 层面的「不可逆操作二次确认」一点没少。
 */
function confirmWriteNote(newText, match, prefer = 'auto') {
  const preview = String(newText).replace(/\s+/g, ' ').slice(0, 120)
  const kindLabel = match?.kind === 'reasoning' ? '思维链' : '正文'
  const route = prefer === 'live'
    ? '写入方式：仅在线（写活会话，立即生效、不用重启；会话不在内存里会失败）。'
    : prefer === 'disk'
      ? '写入方式：仅落盘（写会话记录文件，该会话下次载入时生效）。'
      : '写入方式：自动（会话在内存里 → 立即生效、不用重启；不在 → 写会话记录，下次载入时生效）。'
  return '确认写入伪造？目标：' + kindLabel + '（seq=' + match.seq + '，块 ' + match.blockIndex + '）'
    + '｜新内容：' + preview + (newText.length > 120 ? '…' : '')
    + '｜' + route
    + '｜改的是「模型看到的对话」，不可逆（有自动备份可还原）。'
    + '确认无误请再次点击「写入伪造」。'
}

/** 两个定位结果是否等价（只比寻址字段，不比正文省内存）。 */
function sameMatch(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  return a.seq === b.seq && a.blockIndex === b.blockIndex && a.exact === b.exact
}

/**
 * 接管一个消息节点：挂操作条 + 应用已有覆盖。
 */
function takeBlock(block, getSessionId, overrides, prefs, docOverride, dup = 1, match = null) {
  // 文档对象由扫描器显式传入：ownerDocument 在合成节点上可能缺失，
  // 隐式全局 document 在打包后的模块作用域里也未必可见。
  const doc = docOverride ?? block.ownerDocument ?? document

  // 已接管：**定位结果必须刷新**。会话记录是异步后到的（首屏扫描往往还没
  // 拉到），若不刷新，块会永远停留在接管那一刻的 match=null 上——
  // 表现就是「每条回复都定位不到，落盘出口全程禁用」。踩过。
  if (block.hasAttribute(TAKEN_ATTR)) {
    if (sameMatch(blockMatch.get(block) ?? null, match ?? null)) return
    blockMatch.set(block, match)
    attachBar(block, doc, getSessionId, prefs, match)
    return
  }

  const original = ownText(block)
  const fp = fingerprint(original)
  rememberOriginal(fp, original)
  taken.set(block, fp)
  dupCount.set(block, dup)
  blockMatch.set(block, match)
  block.setAttribute(TAKEN_ATTR, '')

  // 定位上下文：无条件添加——读 computed style 再判断既慢（流式重渲染时
  // 每个节点一次样式计算）又不可靠（祖先已定位时 position 未必是 static），
  // 而 .rf3-host 的 position:relative 对宿主布局无影响。
  block.classList.add('rf3-host')

  attachBar(block, doc, getSessionId, prefs, match)
  const override = overrides[fp]
  if (override !== undefined && typeof override.text === 'string') {
    applyOverride(block, override.text, prefs, doc)
    attachBar(block, doc, getSessionId, prefs, match)
  }
}

/** 一轮扫描：接管当前所有助手消息块，并刷新落盘定位。 */
function scan(getSessionId, prefs, docOverride) {
  // 全局开关：停用时不提供任何编辑入口（setEnabled(false) 的实时效果）。
  if (prefs.enabled === false) return
  const doc = docOverride ?? document
  const root = conversationRoot(doc)
  if (root === null) return
  const sessionId = getSessionId()
  const overrides = loadOverrides(sessionId)
  // 只接管纯自然语言块，工具调用/结构化动作不提供编辑入口。
  //
  // 必须 includeTaken：已接管的块也要枚举回来。不是为了重挂操作条
  // （takeBlock 会早退），而是为了**刷新落盘定位**——会话记录是异步
  // 后到的，首屏扫描时块已经以 match=null 接管完；若此后扫描把已接管块
  // 全跳过，定位就永远停在 null，表现是「每条回复都定位不到、落盘出口
  // 全程禁用」。踩过。
  const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })

  // 指纹重数统计：先数重再接管，编辑器里对重名者给出警示。
  const texts = blocks.map(ownText)
  const fps = new Map()
  const counts = new Map()
  for (const block of blocks) {
    const fp = fingerprint(ownText(block))
    fps.set(block, fp)
    counts.set(fp, (counts.get(fp) ?? 0) + 1)
  }

  // 落盘定位：把页面上这一批块与磁盘块配对。记录没拉到就全部按「未定位」处理，
  // 落盘出口禁用——不猜位置。
  const rec = cachedRecord(sessionId)
  const matches = (rec !== null && rec.error === null && rec.blocks.length > 0)
    ? matchBlocks(rec.blocks, texts)
    : blocks.map(() => null)

  blocks.forEach((block, i) => {
    try {
      takeBlock(block, getSessionId, overrides, prefs, doc, counts.get(fps.get(block)) ?? 1, matches[i] ?? null)
    } catch (error) {
      log('接管消息块失败', error)
    }
  })

  // 待发送气泡：与上面的助手块是两条互不相交的接管链（气泡是用户消息，
  // 且只在回合进行中以 steering 形式出现）。没有 sessions 服务就整段跳过。
  takePendingBubbles(doc)

  // 页面比记录新（新回复刚渲染进 DOM，宿主还没落盘 / 缓存是旧快照）→
  // 后台重读一次，读完会再进来自旋一轮把定位补上。见文件头部说明。
  // refreshRecordRef 由 apply() 注入（scan 是模块级函数，拿不到闭包状态）。
  if (refreshRecordRef !== null) {
    try { refreshRecordRef(sessionId, texts) } catch (error) { log('重读会话记录失败', error) }
  }
}

/**
 * 插件入口：注入样式、启动扫描与会话级操作。
 * @param ctx - client 根上下文（提供 slots 服务）。
 */
function apply(ctx) {
  // 幂等守卫：重复执行（HMR / loader 重跑）不重复注入。
  if (document.querySelector('style[data-dsh-reply-forge-v3]') !== null) return

  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-dsh-reply-forge-v3', '')
  styleEl.setAttribute('data-plugin', 'dsh-reply-forge-v3')
  styleEl.textContent = CSS
  document.head.append(styleEl)

  // sessions 服务必须在 apply 期取：宿主只在 apply() 的 ctx 上暴露服务，
  // slot 回调 / 事件处理器里再读 ctx.<service> 会抛。存进 ref 供 handler 用。
  // 宿主没给这个服务（旧版本）时留 null，队列编辑入口不出现，其余功能不受影响。
  const sessions = ctx === null || ctx === undefined ? null : (ctx.sessions ?? null)
  sessionsRef = sessions

  let prefs = loadPrefs()
  let sessionId = currentSessionId(document)
  /** 会话 id 取「用的时候现读」，不要把它固定进闭包（见 attachBar 注释）。 */
  const getSessionId = () => sessionId

  // 落盘记录自动重读的状态（见文件头部 RECORD_REFRESH_* 的说明）。
  let recordRefreshMisses = 0
  let lastRecordRefreshAt = 0

  /** 扫描节流：流式输出期间宿主高频重渲染，按帧合并。 */
  let timer = null
  const scheduleScan = () => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      try { runScan() } catch (error) { log('扫描失败', error) }
    }, SCAN_DEBOUNCE_MS)
  }
  // 供模块级的 openBlockEditor 用（补定位成功后要重扫一次刷操作条记号）。
  scheduleScanRef = scheduleScan

  /**
   * 页面上的正文块比记录里多 → 记录过期了，后台重读一次，读完重扫。
   *
   * 不重读的后果就是真机上那个 bug：伪造第一条之后，后面每条新回复都拿着
   * 旧快照比对，永久提示「记录里有 N 条正文，对不上」。
   *
   * 双重退避：时间间隔 + 连续无果次数。页面再次增长（签名变化）会解除退避
   * ——用户继续聊天就该继续尝试，不能被一次「读不到」永久堵死。
   */
  let lastDomSignature = ''
  const refreshRecordIfStale = (sid, domTexts) => {
    if (isPlaceholderSession(sid)) return
    const signature = domSignatureOf(domTexts)
    // 页面变了（新回复进来 / 流式正文变长 / 历史折叠）→ 重新给自动重读计机会
    if (signature !== lastDomSignature) {
      lastDomSignature = signature
      recordRefreshMisses = 0
    }
    if (recordRefreshMisses >= RECORD_REFRESH_MAX_TRIES) return
    if (Date.now() - lastRecordRefreshAt < RECORD_REFRESH_MIN_GAP_MS) return
    const rec = cachedRecord(sid)
    if (recordNeedsRefresh(rec, domTexts.length, signature) !== true) return
    const before = rec === null ? -1 : rec.blocks.length
    lastRecordRefreshAt = Date.now()
    // 签名必须带上：它就是这次快照的「页面基准」，下次比较才有意义。
    readRecord(sid, { force: true, domSignature: signature })
      .then(next => {
        // 读到的块数没变 → 记一次无果；变了 → 复位（会话在正常增长）。
        recordRefreshMisses = next.blocks.length === before ? recordRefreshMisses + 1 : 0
        scheduleScan()
      })
      .catch(() => { recordRefreshMisses += 1 })
  }
  // 供模块级的 scan() 用：页面比记录新时自动重读（scan 拿不到 apply 的闭包）。
  refreshRecordRef = refreshRecordIfStale

  /** 当前页面的块签名。会话切换时用——那时 scan 还没跑，只能现取。 */
  const domSignatureNow = () => {
    const root = conversationRoot(document)
    if (root === null) return ''
    try {
      return domSignatureOf(
        pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true }).map(ownText),
      )
    } catch { return '' }
  }

  // 供模块级的 openBlockEditor 用：补定位/手动重读时带上的签名基准。
  domSignatureNowRef = domSignatureNow

  /** 拉一次落盘记录，拿到后重扫以便刷新定位。 */
  const syncRecord = () => {
    // 还没识别出会话时不发请求：路由必然 404，只会刷一屏没用的噪音。
    if (isPlaceholderSession(sessionId)) return
    readRecord(sessionId, { domSignature: domSignatureNow() })
      .then(() => scheduleScan())
      .catch(error => log('读取会话记录失败', error))
  }

  /**
   * 每轮扫描都重算会话 id。
   *
   * 为什么不能只在 popstate/hashchange 上挂：dsh 是单页应用，切换会话
   * **不触发任何 URL 事件**（实测 @deepseek-ai/dsh-client-ui-conversation
   * 的 client.js 里 location/history 一次都没出现）。会话 id 只体现在
   * DOM 属性 `data-conversation-session` 上。首屏同理——容器挂载前拿到
   * 的是占位值，挂载后才变成真值，所以必须每轮都重算。
   */
  const runScan = () => {
    const next = currentSessionId(document)
    if (next !== sessionId) {
      // 会话真的变了（首屏就绪 / 切到别的会话）：关掉编辑态、重新拉记录。
      if (isPlaceholderSession(sessionId) === false) closeEditor()
      sessionId = next
      // 换会话后自动重读的退避计数归零：新会话的增长是独立计量的。
      // 签名也要清——上一个会话的页面签名对新会话毫无意义。
      recordRefreshMisses = 0
      lastDomSignature = ''
      syncRecord()
    }
    scan(getSessionId, prefs, document)
  }

  window.addEventListener('popstate', scheduleScan)
  window.addEventListener('hashchange', scheduleScan)

  // 宿主 DOM 变化驱动接管：会话区子树内的节点增删（新消息、流式定稿、
  // 标签切换重渲染）都会触发。作用域限定在会话锚点内，避免观察整棵树。
  let observedRoot = null
  let observer = null
  const attachObserver = () => {
    const root = document.querySelector(CONVERSATION_SELECTOR)
    if (root === observedRoot) return
    if (observer !== null) { observer.disconnect(); observer = null }
    observedRoot = root
    if (root === null) return
    observer = new MutationObserver(() => scheduleScan())
    observer.observe(root, { childList: true, subtree: true })
    // 锚点刚出现时立刻扫一次：此刻会话里往往已经有历史消息，
    // 而 MutationObserver 只对「之后的」变动触发，不补这一刀就会漏掉首屏。
    scheduleScan()
  }

  // 锚点重连的常驻心跳。**永不 clearInterval**——
  //
  // 旧代码「找到锚点就 clearInterval」是真机 bug「插件经常整页失效、
  // 只有重启 DSH 才好」的直接根因：宿主 reconcile（HMR teardown 半途、
  // 版本切换、turn 折叠重挂会话容器）会把 [data-slot="main.conversation"]
  // 锚点整体换掉或短暂摘掉，旧 observer 挂到脱离文档的节点上后再也不会
  // 触发，而 bootstrap interval 早已自停 → 没有任何路径重连 observer
  // → scan 停摆、按钮全没。重启之所以能好：重启走 entries.start() 全新
  // fiber，interval 重开、锚点重挂。
  //
  // attachObserver 内部有 `root === observedRoot` 早退，常驻成本就是
  // 每秒一次 querySelector，可忽略。真机复现会话：
  // session-25eecb09-67c5-41e6-b5a5-8259dd11c898（2026-10-19/20 反复出现）。
  const BOOTSTRAP_INTERVAL_MS = 1000
  const bootstrap = window.setInterval(() => {
    attachObserver()
  }, BOOTSTRAP_INTERVAL_MS)
  attachObserver()

  // 窗口唤醒兜底：浏览器会挂起后台 tab 的定时器与 MutationObserver 回调，
  // 挂起期间锚点可能已被替换。切窗口 / 最小级还原时主动重挂重扫，
  // 不等下一个 DOM 变动来触发。
  const onWake = () => { attachObserver(); scheduleScan() }
  const onWakeVisibility = () => {
    if (document.visibilityState === 'visible') onWake()
  }
  window.addEventListener('focus', onWake)
  document.addEventListener('visibilitychange', onWakeVisibility)
  syncRecord()

  // 快捷键：Alt+Shift+E 编辑当前视图最后一条 AI 回复
  const onKey = event => {
    if (event.altKey !== true || event.shiftKey !== true) return
    if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'e') return
    const root = conversationRoot(document)
    // includeTaken：快捷键是枚举用途。默认的扫描语义会跳过已接管的块，
    // 于是「所有块都接管完之后按快捷键毫无反应」——静默失效，最难查的那种。
    const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })
    const last = blocks[blocks.length - 1]
    if (last === undefined) return
    event.preventDefault()
    openBlockEditor(last, getSessionId, prefs, document)
  }
  window.addEventListener('keydown', onKey)

  ctx.effect(() => () => {
    window.clearInterval(bootstrap)
    if (timer !== null) window.clearTimeout(timer)
    if (observer !== null) observer.disconnect()
    window.removeEventListener('popstate', scheduleScan)
    window.removeEventListener('hashchange', scheduleScan)
    window.removeEventListener('focus', onWake)
    document.removeEventListener('visibilitychange', onWakeVisibility)
    window.removeEventListener('keydown', onKey)
    stripInjectedUI()
    // 放在 stripInjectedUI 之后：它内部的 closeEditor 也可能再装上保险丝，
    // 拆除必须保证最终是解除状态，否则停用后还留一个全局 keydown 监听。
    disarmTypingGuard()
    styleEl.remove()
  }, 'dsh-reply-forge-v3: teardown')

  // 调试命名空间：不注册任何宿主槽位，只在 window 上暴露，供手动排查。
  // v3 起改名为 __dshReplyForgeV3：v2 插件也定义 __dshReplyForgeV2，
  // 两个插件同时装（--keep-v2）时同名会互相覆盖，排查时根本分不清是谁。
  try {
    window.__dshReplyForgeV3 = {
      version: '3.3.0',
      sessionId() { return sessionId },
      /** 直接从 DOM 现读一次（排查「id 认错了」时对比用）。 */
      domSessionId() { return currentSessionId(document) },
      clearAll() {
        clearOverrides(sessionId)
        log('已清空当前会话的本机覆盖')
      },
      /**
       * 强制重算会话 id + 重读落盘记录（定位不上的时候用）。
       * 会顺带修掉「id 还是首屏占位值」这种状态。
       */
      refresh() {
        sessionId = currentSessionId(document)
        resetCache(sessionId)
        if (isPlaceholderSession(sessionId)) {
          return Promise.resolve({ ok: false, sessionId, error: '未识别出当前会话（DOM 里没有 data-conversation-session）' })
        }
        return loadRecord(sessionId, { force: true, domSignature: domSignatureNow() }).then(rec => {
          scheduleScan()
          return { ok: rec.error === null, sessionId, mode: rec.mode, blocks: rec.blocks.length, error: rec.error }
        })
      },
      /** 当前页面上各块的落盘定位情况，用于排查「为什么写不了」。 */
      locate() {
        const root = conversationRoot(document)
        // includeTaken：枚举用途，已接管的块也要算进来（否则全接管完就是空列表）。
        const blocks = pickAssistantBlocks(root, classifyNaturalLanguage, { includeTaken: true })
        const texts = blocks.map(ownText)
        const rec = cachedRecord(sessionId)
        const head = {
          sessionId, domSessionId: currentSessionId(document), domBlocks: blocks.length,
          domSignature: domSignatureOf(texts),
        }
        if (rec === null) return { ...head, ok: false, error: '记录未加载' }
        if (rec.error !== null) return { ...head, ok: false, error: rec.error }
        const matches = matchBlocks(rec.blocks, texts)
        return {
          ...head,
          ok: true,
          mode: rec.mode,
          recordSignature: rec.domSignature,
          diskBlocks: rec.blocks.length,
          matched: matches.filter(m => m !== null).length,
          exact: matches.filter(m => m !== null && m.exact === true).length,
          // 页面与记录不一致 → 记录过期，正在自动重读（排查「新回复定位不上」时看这里）
          stale: recordNeedsRefresh(rec, blocks.length, domSignatureOf(texts)),
          rows: matches.map((m, i) => ({
            domIndex: i,
            preview: ownText(blocks[i]).slice(0, 40),
            seq: m === null ? null : m.seq,
            blockIndex: m === null ? null : m.blockIndex,
            exact: m === null ? null : m.exact,
          })),
        }
      },
      setEnabled(value) {
        prefs = { ...prefs, enabled: value === true }
        savePrefs(prefs)
        // 实时生效：停用立即拆除已注入的 UI；启用则触发一次扫描补挂。
        if (prefs.enabled) scheduleScan()
        else stripInjectedUI()
      },
      /**
       * 焦点排查：最近一次交还结果 + 此刻宿主持话输入框的真实状态。
       * 真机「保存后输入框打不了字」时，先看这里：
       *   - last.ok=false 且 editable=false → 输入框当时不可聚焦（宿主状态）；
       *   - last.ok=true 但 activeIsComposer=false → 焦点被别的东西拿走了；
       *   - composerTotal>1 → 页面上有多个输入框节点，看一眼 chosenVisible。
       *
       * 字段一律放平 + summary 一行摘要：真机上用户从 DevTools 里复制
       * `JSON.stringify(__dshReplyForgeV3.focus())` 就能拿到全量证据
       * （折叠的 {…} 会把最关键的 reason 藏掉，踩过）。
       */
      focus: makeFocusProbe(document),
    }
  } catch {
    // window 不可写时忽略
  }
}
module.exports.apply = apply;
module.exports.name = name;
module.exports.inject = inject;

		return module.exports;
	}
});
