// 版本血统的浏览器侧访问层 + 展示用纯函数（v3.4）。
//
// 与 record.mjs 的分工：那个管「块定位与写入」，这个只管「一个块的版本
// 历史」。拆开的理由是热路径——blocks/forge 是每次开编辑器都会走的，
// 血统只有点开「历史版本」才拉一次，多一个字节都不该混进前者的响应。
//
// 零依赖、纯 ESM（构建契约：只能用相对导入，不得引入外部包）。

const LINEAGE_ROUTE = '/api/reply-forge-v3/session/lineage'

/**
 * 版本徽标高文案。
 *
 * index 0 永远是原稿（src/lineage.mjs 的栈形状）；currentIndex 是投影
 * 最终生效的那一版。两者可能重合（从未伪造过）——那时「原稿」就是当前。
 *
 * @param {number} index
 * @param {number} currentIndex
 * @returns {string} 「原稿」「原稿 · 当前」「v1」「v2 · 当前」
 */
export function versionLabelOf(index, currentIndex) {
  const base = index === 0 ? '原稿' : 'v' + index
  return index === currentIndex ? base + ' · 当前' : base
}

/**
 * 版本预览文本：压平空白后截断。
 * 全文在面板里可滚动看，这里只做列表行的摘要。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function lineagePreview(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * 拉取一个块的版本栈（只读路由，无自定义头——与 blocks 同一条边界）。
 *
 * 业务失败（ok:false + code）不走 HTTP 错误码：路由与 blocks/forge 同一
 * 约定，200 + ok:false，UI 拿 code 出文案（original-not-found /
 * kind-mismatch 的提示完全不同）。
 *
 * @param {string} sessionId
 * @param {number} seq
 * @param {number} blockIndex
 * @param {string} [kind] 缺省 text
 * @returns {Promise<{ok:true,versions:Array,currentIndex:number,kind:string}
 *                | {ok:false,error:string,code:string|null}>}
 */
export async function loadLineage(sessionId, seq, blockIndex, kind) {
  try {
    const url = LINEAGE_ROUTE
      + '?sessionId=' + encodeURIComponent(String(sessionId ?? ''))
      + '&seq=' + encodeURIComponent(String(seq))
      + '&blockIndex=' + encodeURIComponent(String(blockIndex))
      + '&kind=' + encodeURIComponent(String(kind ?? 'text'))
    const res = await fetch(url)
    const data = await res.json()
    if (data === null || typeof data !== 'object') {
      return { ok: false, error: 'HTTP ' + res.status, code: null }
    }
    if (data.ok !== true) {
      return {
        ok: false,
        error: String(data.error ?? '读取版本历史失败'),
        code: typeof data.code === 'string' ? data.code : null,
      }
    }
    return {
      ok: true,
      kind: typeof data.kind === 'string' ? data.kind : 'text',
      versions: Array.isArray(data.versions) ? data.versions : [],
      currentIndex: typeof data.currentIndex === 'number' ? data.currentIndex : 0,
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), code: null }
  }
}
