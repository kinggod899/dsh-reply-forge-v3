// 极简 DOM 桩：只为在 Node 里跑通 client 逻辑，不追求规范完整。
// 环境没有 jsdom/linkedom，且插件只用到很窄的 DOM 面，自己实现更可控。

/** 默认可聚焦的标签（Chromium 行为，供 focus() 的「无操作」建模用）。 */
const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY'])

export class El {
  constructor(tag, ownerDoc = null) {
    this.tagName = String(tag)
    this.children = []
    this.attrs = {}
    this._text = ''
    this._cls = new Set()
    this._ev = {}
    this.style = {}
    this.parentElement = null
    this.ownerDoc = ownerDoc
    this.spellcheck = false
    this.value = ''
    this.focused = false
    this._disabled = false
    const self = this
    this.classList = {
      add: c => self._cls.add(c),
      remove: c => self._cls.delete(c),
      contains: c => self._cls.has(c),
    }
  }

  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  hasAttribute(k) { return k in this.attrs }

  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { this._text += n; continue }
      n.parentElement = this
      this.children.push(n)
    }
  }

  /** 焦点是否落在「this 或它的子孙」里（真实 DOM 行为，用于焦点回归测试）。 */
  _clearActiveIfInside() {
    const doc = this.ownerDoc
    if (doc === null || doc === undefined) return
    const active = doc.activeElement
    if (active === null || active === undefined) return
    if (this === active || this.contains(active)) doc.activeElement = null
  }

  remove() {
    // Chromium 行为：被抹掉的焦点元素（或其祖先）会让焦点退回 <body>。
    // 桩里用 activeElement=null 表示——不建模这一步，「焦点丢失」类
    // 回归（写完伪造输入框打不了字）根本测不出来。
    this._clearActiveIfInside()
    const p = this.parentElement
    if (p !== null && p !== undefined) p.children = p.children.filter(c => c !== this)
    this.parentElement = null
  }

  get textContent() { return this._text + this.children.map(c => c.textContent).join('') }
  /** 真 DOM 属性：contentEditable 为 false/缺失时元素不可聚焦（focus() 是空操作）。 */
  get isContentEditable() { const v = this.attrs.contenteditable; return v === '' || v === 'true' }
  set textContent(v) {
    this._clearActiveIfInside()
    this.children = []
    this._text = String(v)
  }

  set className(v) { this.attrs.class = v; for (const c of String(v).split(/\s+/)) if (c !== '') this._cls.add(c) }
  get className() { return this.attrs.class ?? '' }

  querySelector(sel) { return this._q(sel)[0] ?? null }
  querySelectorAll(sel) { return this._q(sel) }

  /** 选择器匹配（支持逗号列表；够 picker 的 BLOCK_TAGS 与守卫用）。 */
  matches(sel) {
    return String(sel).split(',').some(s => match(this, s.trim()))
  }

  closest(sel) {
    const sels = sel.split(',').map(s => s.trim())
    let node = this
    while (node !== null && node !== undefined) {
      if (sels.some(s => match(node, s))) return node
      node = node.parentElement
    }
    return null
  }

  contains(other) {
    if (other === this) return true
    return this.children.some(c => c.contains(other))
  }

  addEventListener(type, fn) { (this._ev[type] ??= []).push(fn) }
  removeEventListener(type, fn) { this._ev[type] = (this._ev[type] ?? []).filter(f => f !== fn) }

  /** 触发一个已注册的事件（测试用）。 */
  dispatch(type, extra = {}) {
    const event = { preventDefault() {}, stopPropagation() {}, ...extra }
    for (const fn of [...(this._ev[type] ?? [])]) fn(event)
  }

  click() { this.dispatch('click') }
  /** Chromium：聚焦元素被 disable 时，焦点立刻掉到 <body>。 */
  set disabled(v) {
    this._disabled = v === true
    const doc = this.ownerDoc
    if (v === true && doc !== null && doc !== undefined && doc.activeElement === this) {
      doc.activeElement = null
    }
  }
  get disabled() { return this._disabled === true }
  focus() {
    // Chromium：默认不可聚焦的标签（无 contenteditable、无 tabindex 的 div
    // 等）上 focus() 是无操作。不建模这一步，「宿主输入框不可编辑时交还
    // 不了焦点」这条真机路径在测试里永远是绿的。
    if (this.isContentEditable !== true && this.attrs.tabindex === undefined
      && !FOCUSABLE_TAGS.has(String(this.tagName).toUpperCase())) return
    this.focused = true
    const doc = this.ownerDoc
    if (doc !== null && doc !== undefined) doc.activeElement = this
  }
  blur() {
    this.focused = false
    const doc = this.ownerDoc
    if (doc !== null && doc !== undefined && doc.activeElement === this) doc.activeElement = null
  }

  _q(sel) {
    const sels = sel.split(',').map(s => s.trim())
    const out = []
    const walk = node => {
      for (const c of node.children) {
        if (sels.some(s => match(c, s))) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

/** 支持 tag[attr]、tag[attr="v"]、[attr]、.class、tag、* 这些形状。 */
export function match(el, sel) {
  sel = sel.trim()
  if (sel === '*') return true
  // 复合选择器：tag 后面跟若干 [attr] / .class
  const compound = /^([A-Za-z0-9]+)?((?:\[[^\]]*\]|\.[A-Za-z0-9_-]+)*)$/.exec(sel)
  if (compound !== null) {
    const tag = compound[1]
    if (tag !== undefined && el.tagName !== tag.toLowerCase()) return false
    const rest = compound[2] ?? ''
    const parts = [...rest.matchAll(/\[([^\]]*)\]|\.([A-Za-z0-9_-]+)/g)]
    // rest 必须被完整消费，否则是别的选择器形状
    const consumed = parts.map(m => m[0]).join('')
    if (consumed !== rest) return false
    for (const part of parts) {
      if (part[1] !== undefined) {
        const body = part[1]
        const eq = body.indexOf('=')
        if (eq < 0) {
          if (!el.hasAttribute(body)) return false
        } else {
          const k = body.slice(0, eq)
          const v = body.slice(eq + 1).replace(/^["']|["']$/g, '')
          if (el.getAttribute(k) !== v) return false
        }
      } else if (part[2] !== undefined) {
        if (!(el.attrs.class ?? '').split(/\s+/).includes(part[2])) return false
      }
    }
    return true
  }
  return false
}

/** 造一个带 class 与文本的素节点。 */
export function mk(tag, cls, text) {
  const e = new El(tag)
  if (cls !== undefined && cls !== '') e.attrs.class = cls
  if (text !== undefined) e._text = text
  return e
}

/** 建一套文档级环境：querySelector 覆盖 head 与 body。 */
export function createDocument() {
  const head = new El('head')
  const body = new El('body')
  const documentElement = new El('html')
  // 注意：对象字面量里不能直接引用 doc 自身（TDZ），ownerDoc 一律在外层补。
  const doc = {
    head,
    body,
    activeElement: null,
    createElement: t => new El(t, doc),
    createDocumentFragment: () => new El('#fragment', doc),
    querySelector: sel => head._q(sel)[0] ?? body._q(sel)[0] ?? null,
    querySelectorAll: sel => [...head._q(sel), ...body._q(sel)],
    getElementById: () => null,
    documentElement,
  }
  head.ownerDoc = doc
  body.ownerDoc = doc
  documentElement.ownerDoc = doc
  return doc
}

/** 建一个收集式定时器环境：测试可手动冲刷挂起的回调。 */
export function createWindow({ pathname = '/s/test-session', storage = {}, confirmResult = true } = {}) {
  const pending = []
  const confirmCalls = []
  const listeners = {}
  return {
    pending,
    confirmCalls,
    listeners,
    flush() {
      const list = pending.splice(0)
      for (const fn of list) fn()
    },
    /** 触发 window 上注册的某个事件（如 keydown）。 */
    dispatch(type, event = {}) {
      const ev = { preventDefault() {}, stopPropagation() {}, ...event }
      for (const fn of [...(listeners[type] ?? [])]) fn(ev)
    },
    window: {
      location: { pathname, hash: '' },
      localStorage: {
        getItem: k => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v) },
        removeItem: k => { delete storage[k] },
      },
      setTimeout: fn => { pending.push(fn); return pending.length },
      clearTimeout: () => {},
      setInterval: fn => { pending.push(fn); return 999 },
      clearInterval: () => {},
      addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn) },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] ?? []).filter(f => f !== fn) },
      getComputedStyle: () => ({ display: 'block', position: 'static' }),
      // v2 的落盘写入要二次确认；测试可以控制用户点「确定」还是「取消」。
      confirm: msg => { confirmCalls.push(String(msg)); return confirmResult === true },
    },
  }
}
