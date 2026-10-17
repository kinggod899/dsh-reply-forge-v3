// 覆盖表持久化：localStorage。键按「会话 + 消息指纹」分组，
// 因为宿主不向 client 插件暴露稳定的消息 id，指纹是唯一可跨刷新持有的锚。
//
// v2 前缀与 v1（dsh-reply-forge:v1:）严格分离：两个插件可能同时装着，
// 共用前缀会让「v1 的渲染覆盖」与「v2 的渲染覆盖」互相踩踏。

const PREFIX = 'dsh-reply-forge-v3:'

/** 会话 id 占位值：DOM 还没挂载出会话容器、URL 里也没有 id 时用它。 */
export const PLACEHOLDER_SESSION = '_global'

/** 是否拿到了真实会话 id（占位值不能拿去查会话文件）。 */
export function isPlaceholderSession(sessionId) {
  return typeof sessionId !== 'string' || sessionId === '' || sessionId === PLACEHOLDER_SESSION
}

/**
 * 当前会话 id。
 *
 * **主来源是 DOM，不是 URL。** dsh 是单页应用：切换会话只改内存状态，
 * 不碰 location/history（实测 @deepseek-ai/dsh-client-ui-conversation 的
 * client.js 里 location/history 一次都没出现）。宿主把当前会话 id 渲染在
 * 会话容器上：
 *     <div data-conversation-content data-conversation-session="session-…"
 *          data-conversation-region="chat">
 * 所以解析 URL 只能拿到占位值 —— v1 只用它给 localStorage 分桶，
 * `_global` 也能凑合；v2 要拿它去查会话文件，必须拿到真值。
 *
 * @param {Document} [doc] 便于测试注入；缺省用全局 document
 */
export function currentSessionId(doc) {
  try {
    const d = doc ?? (typeof document === 'undefined' ? null : document)
    const el = d?.querySelector?.('[data-conversation-session]')
    const domId = el?.getAttribute?.('data-conversation-session')
    if (typeof domId === 'string' && domId !== '') return domId
    // 兜底：老版本 / 其它宿主形态把 id 放在路径里。
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

/** 文本指纹：规范空白后取首尾与长度，足以区分同一会话内的消息。 */
export function fingerprint(text) {
  const norm = String(text ?? '').replace(/\s+/g, ' ').trim()
  const head = norm.slice(0, 80)
  const tail = norm.slice(-40)
  return head.length + ':' + head + '|' + tail
}

function keyOf(sessionId) {
  return PREFIX + String(sessionId ?? '_global')
}

/** 读一个会话的覆盖表（坏数据降级为空表，绝不抛出）。 */
export function loadOverrides(sessionId) {
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

/** 写一条覆盖（text 为空串表示删除该覆盖）。 */
export function setOverride(sessionId, fp, text) {
  const table = loadOverrides(sessionId)
  if (String(text ?? '') === '') delete table[fp]
  else table[fp] = { text: String(text), at: Date.now() }
  return saveOverrides(sessionId, table)
}

export function removeOverride(sessionId, fp) {
  const table = loadOverrides(sessionId)
  if (!(fp in table)) return false
  delete table[fp]
  return saveOverrides(sessionId, table)
}

/** 清空一个会话的全部覆盖。 */
export function clearOverrides(sessionId) {
  try {
    window.localStorage.removeItem(keyOf(sessionId))
    return true
  } catch {
    return false
  }
}

/** 全局开关（插件启用/停用、自动标记）。 */
export function loadPrefs() {
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

export function savePrefs(prefs) {
  try {
    window.localStorage.setItem(PREFIX + 'prefs', JSON.stringify({
      enabled: prefs.enabled !== false,
      autoMark: prefs.autoMark === true,
    }))
  } catch {
    // 隐私模式下忽略
  }
}
