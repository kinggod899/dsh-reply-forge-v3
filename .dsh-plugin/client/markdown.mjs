// 极简 Markdown 渲染：零依赖、纯 DOM 构造（不使用 innerHTML），
// 因此不存在 HTML 注入面，也不会触发宿主的图片自动加载。
//
// 只覆盖助手回复里最常见的语法：标题、代码块、引用、列表、表格、
// 水平线、段落，以及行内 代码/粗体/斜体/删除线/链接。
// 刻意不做完整 CommonMark：目标是「看起来像原渲染」，不是重造 marked。

/** 行内解析：返回 DocumentFragment。 */
function inline(doc, text) {
  const frag = doc.createDocumentFragment()
  // 行内代码优先（内部不再解析其它语法）
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
        // 只放行安全协议，阻断 javascript: / data:
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

/** 表格行拆分（忽略转义竖线）。 */
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

/**
 * 把 Markdown 渲染进目标容器（清空后重建）。
 * @param {HTMLElement} container 目标容器（由调用方创建并负责样式作用域）
 * @param {string} source Markdown 源码
 */
export function renderMarkdown(container, source, docOverride) {
  // 文档对象由调用方显式传入最可靠：ownerDocument 在合成节点上可能缺失，
  // 隐式全局 document 在打包的模块作用域里也未必可见。
  const doc = docOverride ?? container.ownerDocument ?? globalThis.document
  container.textContent = ''
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 空行
    if (line.trim() === '') { i += 1; continue }

    // 围栏代码块
    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const lang = fence[1] ?? ''
      const buf = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1 }
      i += 1 // 跳过收尾围栏
      const pre = doc.createElement('pre')
      const code = doc.createElement('code')
      if (lang !== '') code.setAttribute('data-language', lang)
      code.textContent = buf.join('\n')
      pre.append(code)
      container.append(pre)
      continue
    }

    // 水平线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(doc.createElement('hr'))
      i += 1
      continue
    }

    // 标题
    const head = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (head !== null) {
      const h = doc.createElement('h' + head[1].length)
      h.append(inline(doc, head[2]))
      container.append(h)
      i += 1
      continue
    }

    // 表格：当前行含 | 且下一行是分隔行
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

    // 引用块（连续 > 行）
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

    // 无序列表（含缩进续行）
    if (/^\s*[-*+]\s+/.test(line)) {
      const list = doc.createElement('ul')
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = doc.createElement('li')
        const text = lines[i].replace(/^\s*[-*+]\s+/, '')
        li.append(inline(doc, text))
        i += 1
        // 缩进续行并入当前项
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          li.append(doc.createTextNode(' ' + lines[i].trim()))
          i += 1
        }
        list.append(li)
      }
      container.append(list)
      continue
    }

    // 有序列表
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

    // 普通段落（连续的普通行合成一段）
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
