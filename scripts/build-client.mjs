// 生成器：.dsh-plugin/client/index.mjs → .dsh-plugin/client.js
//
// 官方 __ModuleLoader__.load 契约与 gal-view 一致：
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//
// 这里不使用 esbuild：插件源码零依赖、无 JSX，因此用一个自研的极简
// ESM → CJS 模块内联器完成打包，避免为构建引入工具链。
// 约束：源码只用 import ... from './x.mjs' / export function|const，
// 不使用 export default、import() 动态导入与循环依赖。
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, '.dsh-plugin', 'client', 'index.mjs')
const OUTPUT = join(ROOT, '.dsh-plugin', 'client.js')
// 浏览器模块表以 npm 包全名索引工厂（不是 cordis patch 的行 id）。
// 从 manifest 读取，避免 scoped 包名与短名再次错位并导致网页端无法加载。
const PLUGIN_ID = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

/**
 * 剥离注释，保留字符串与正则字面量的内容。
 *
 * 朴素正则（`\/\/.*$`）会把 `https?:` 里的 `//`、字符类里的 `/` 当成注释起点，
 * 直接把正则字面量拦腰截断——产物因此语法无效。这里逐字符扫描，
 * 只在「代码上下文」里识别注释起点。
 */
function stripComments(code) {
  let out = ''
  let i = 0
  // 状态：code / line-comment / block-comment / string / template
  let state = 'code'
  let quote = ''
  let templateDepth = 0

  // 当前位置是否可能是正则字面量起点：前一个非空白字符是运算符/括号/
  // 逗号/关键字时才成立，否则该 `/` 是除法。
  const regexAllowed = () => {
    let k = out.length - 1
    while (k >= 0 && /\s/.test(out[k])) k -= 1
    if (k < 0) return true
    const prev = out[k]
    if (/[({[,;=!&|?:+\-*%~^<>]/.test(prev)) return true
    return /\b(?:return|typeof|in|of|new|delete|void|case|do|else|yield|await)\b/.test(out.slice(Math.max(0, k - 8)))
  }

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line-comment'; i += 2; continue }
      if (ch === '/' && next === '*') { state = 'block-comment'; i += 2; continue }
      if (ch === '"' || ch === "'") { state = 'string'; quote = ch; out += ch; i += 1; continue }
      if (ch === '`') { state = 'template'; templateDepth = 0; out += ch; i += 1; continue }
      if (ch === '/' && regexAllowed()) {
        // 正则字面量：原样复制到收尾的未转义 /
        out += ch
        i += 1
        let inClass = false
        while (i < code.length) {
          const c = code[i]
          if (c === '\\') { out += c + (code[i + 1] ?? ''); i += 2; continue }
          if (c === '\n') break // 正则不跨行
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) { out += c; i += 1; break }
          out += c
          i += 1
        }
        continue
      }
      out += ch
      i += 1
      continue
    }

    if (state === 'line-comment') {
      if (ch === '\n') { state = 'code'; out += ch }
      i += 1
      continue
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue }
      if (ch === '\n') out += ch // 保留换行，便于按行定位
      i += 1
      continue
    }

    if (state === 'string') {
      out += ch
      if (ch === '\\') { out += code[i + 1] ?? ''; i += 2; continue }
      if (ch === quote) state = 'code'
      i += 1
      continue
    }

    // template
    out += ch
    if (ch === '\\') { out += code[i + 1] ?? ''; i += 2; continue }
    if (ch === '$' && next === '{') { templateDepth += 1; out += next; i += 2; continue }
    if (ch === '{' && templateDepth > 0) templateDepth += 1
    else if (ch === '}' && templateDepth > 0) {
      templateDepth -= 1
      if (templateDepth === 0) state = 'code'
    } else if (ch === '`' && templateDepth === 0) state = 'code'
    i += 1
  }
  return out
}

/** 收集 import 语句，返回 { code, deps }。 */
function parseImports(code) {
  const re = /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*(?:([A-Za-z0-9_$]+)\s+)?from\s*['"]([^'"]+)['"];?/g
  const deps = []
  const out = code.replace(re, (full, _default, named, _ns, source) => {
    deps.push({ source, named: (named ?? '').trim() })
    return ''
  })
  return { code: out, deps }
}

/** 收集 export：具名导出与 export function/const。 */
function transformExports(code) {
  const names = []
  // 必须连 async 变体一起吃：`export async function f` 若只按 `export function`
  // 匹配就漏掉，产物里会残留一个作用域内的裸 `export` → 语法错误。
  let out = code.replace(/export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/g, (_m, asy, n) => {
    names.push(n)
    return (asy ?? '') + 'function ' + n
  })
  out = out.replace(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g, (_m, n) => {
    names.push(n)
    return 'const ' + n
  })
  out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, list) => {
    for (const part of list.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name !== '') names.push(name)
    }
    return ''
  })
  return { code: out, names: [...new Set(names)] }
}

/** 递归内联打包，返回 { body, modules }。 */
function bundle(file, seen = new Map()) {
  const abs = resolve(file)
  if (seen.has(abs)) return seen.get(abs)
  const raw = readFileSync(abs, 'utf8')
  const { code: noComments } = { code: stripComments(raw) }
  const { code: noImports, deps } = parseImports(noComments)
  const { code: body, names } = transformExports(noImports)

  const parts = []
  for (const dep of deps) {
    if (!dep.source.startsWith('.')) {
      throw new Error('不支持的外部依赖：' + dep.source + '（插件必须零依赖）')
    }
    const depPath = join(dirname(abs), dep.source)
    const sub = bundle(depPath, seen)
    const wanted = dep.named === '' ? [] : dep.named.split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(s => s !== '')
    parts.push('var __m' + safeId(depPath) + ' = (function(){ ' + sub.body + '\n return { ' + sub.names.map(n => n + ': ' + n).join(', ') + ' } })();')
    for (const name of wanted) {
      parts.push('var ' + name + ' = __m' + safeId(depPath) + '.' + name + ';')
    }
  }
  seen.set(abs, { body: parts.join('\n') + '\n' + body, names })
  return seen.get(abs)
}

/** 模块 id 只由「相对仓库根的路径」决定，与仓库装在哪里无关。
 *  曾经这里直接用绝对路径再 slice(-40)，换个目录构建产物就变——
 *  发行包解开后 build --check 必然不过，且任何克隆者重建都会得到不同字节。 */
function safeId(absPath) {
  return relative(ROOT, absPath).replace(/[^A-Za-z0-9]/g, '_')
}

export function generate({ check = false } = {}) {
  const main = bundle(ENTRY)
  const body = main.body
  // 契约：factory 必须返回 { name, inject, apply }。产物里 export 关键字已被
  // 剥掉（函数/常量都是普通声明），所以这里显式把它们挂到 module.exports 上，
  // 否则内核拿不到 apply，插件等于没装。
  const exportAssignments = main.names
    .map(n => 'module.exports.' + n + ' = ' + n + ';')
    .join('\n')
  const code = Buffer.from(
    'window.__ModuleLoader__.load({\n'
    + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
    + '\tfactory: (require) => {\n'
    + '\t\tvar module = { exports: {} };\n'
    + '\t\tvar exports = module.exports;\n'
    + body.replace(/\n$/, '')
    + '\n' + exportAssignments + '\n'
    + '\n\t\treturn module.exports;\n'
    + '\t}\n'
    + '});\n',
  )
  if (!check) {
    writeFileSync(OUTPUT, code)
    // 产物自检：语法必须有效，且导出三件套齐备（缺一等于插件没装）。
    try {
      new Function('window', code)
    } catch (error) {
      return { ok: false, errors: ['client.js 语法无效：' + String(error?.message ?? error)] }
    }
    for (const n of ['name', 'inject', 'apply']) {
      if (!code.includes('module.exports.' + n + ' = ')) {
        return { ok: false, errors: ['client.js 缺少导出 ' + n + '：宿主内核调用不到 apply'] }
      }
    }
    return { ok: true }
  }
  let committed = null
  try {
    committed = readFileSync(OUTPUT)
  } catch {
    return { ok: false, errors: [OUTPUT + ' 不存在：运行 node scripts/build-client.mjs'] }
  }
  if (Buffer.compare(committed, code) !== 0) {
    return { ok: false, errors: ['client.js 与源码不一致：重新运行构建'] }
  }
  return { ok: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const result = generate({ check })
  if (!result.ok) {
    for (const e of result.errors ?? []) console.error('[build-client] ' + e)
    process.exit(1)
  }
  console.log(check ? '[build-client] client.js 新鲜（--check OK）' : '[build-client] client.js 已生成：' + OUTPUT)
}
