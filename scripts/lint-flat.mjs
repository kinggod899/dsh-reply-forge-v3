// 「拍平守卫」（scripts/lint-flat.mjs）。
//
// 用途：在把 `.dsh-plugin/client/` 下的多个模块合并成单文件（零构建路线）
// 之前，先机器确认两件事——
//
//   1. **没有任何顶层标识符跨模块重名**（ERROR）。
//      ESM 里每个模块是独立作用域，同名互不干扰；拍平后所有顶层声明共处
//      一个作用域，后者静默覆盖前者。这类 bug 语法检查抓不到，只有运行到
//      才炸，而炸出来的现象往往是「某个按钮点不动」这种离现场很远的症状。
//      这是零构建**唯一新增**的 bug 类型，所以必须机器守，不能靠人看。
//
//   2. **没有用到当前内联器不支持的语法**（WARN）。
//      `build-client.mjs` 是自研的 ESM→CJS 内联器，不是完整解析器：
//      export default / import * as / 动态 import / export * from /
//      export { a as b } 别名 / 顶层 await 都不支持。这些在拍平后依然存在，
//      属于「构建器约束」而非「拍平约束」，所以单列 WARN，不挡拍平。
//
// 用法：
//   node scripts/lint-flat.mjs            # 人读报告；有 ERROR 时退出码 1
//   node scripts/lint-flat.mjs --strict   # 连 WARN 也当失败
//   node scripts/lint-flat.mjs --json     # 机读（CI / 发布门禁）
//
// 已知局限：只识别「行首无缩进 + 声明关键字 + 单个名字」。
//   `const a = 1, b = 2` 这种一行多声明只认第一个名字；本项目目前没有
//   这种写法，将来若出现，请拆行（脚本的 MULTI_DECL 警告会提示）。
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const DIR = join(ROOT, '.dsh-plugin', 'client')
const ENTRY = 'index.mjs'

/** 顶层声明：行首无缩进（缩进的 await / 变量都在函数体内，不算）。 */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/

/** 一行里出现 `, name =` —— 疑似多声明，逐个名字没被检查。
 *  必须排除字符串里的逗号（`const TAGS = 'p, pre, ul'` 曾被误报），
 *  所以 `[^;'"\`]*` 一旦撞上引号就停，不会跨过字面量。 */
const MULTI_DECL = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=[^;'"`]*,\s*[A-Za-z0-9_$]+\s*=/

/** 当前内联器不支持的语法。 */
const UNSUPPORTED = [
  { code: 'EXPORT_DEFAULT', re: /^export\s+default\b/m, msg: 'export default 不被内联器支持（产物会残留裸 export）' },
  { code: 'IMPORT_NS', re: /\bimport\s+\*\s+as\b/, msg: 'import * as 的命名空间绑定会被静默丢弃（产物里变量未定义）' },
  { code: 'DYNAMIC_IMPORT', re: /[^.\w]import\s*\(/, msg: '动态 import() 不被内联器处理' },
  { code: 'EXPORT_STAR', re: /^export\s+\*\s+from\b/m, msg: 'export * from 不被内联器支持' },
  { code: 'EXPORT_ALIAS', re: /^export\s*\{[^}]*\bas\b[^}]*\}/m, msg: 'export { a as b } 的别名会被丢弃（只导出原名）' },
  { code: 'TOP_LEVEL_AWAIT', re: /^await\s/m, msg: '顶层 await 不被支持' },
]

/**
 * 扫描一个目录里的客户端模块，返回结构化结果。
 * @param {string} [dir]
 * @returns {{files: string[], decls: Map<string, Array<{file: string, line: number}>>, duplicates: Array, entryShadows: Array, unsupported: Array, multiDecl: Array}}
 */
export function lint(dir = DIR) {
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()
  const decls = new Map()
  const unsupported = []
  const multiDecl = []

  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      const hit = DECL.exec(line)
      if (hit !== null) {
        const name = hit[1]
        const list = decls.get(name) ?? []
        list.push({ file, line: i + 1 })
        decls.set(name, list)
      }
      if (MULTI_DECL.test(line)) multiDecl.push({ file, line: i + 1 })
    })
    for (const rule of UNSUPPORTED) {
      const match = rule.re.exec(text)
      if (match === null) continue
      const line = text.slice(0, match.index).split('\n').length
      unsupported.push({ code: rule.code, file, line, message: rule.msg })
    }
  }

  // 跨模块重名：同一个名字出现在两个及以上文件。
  const duplicates = []
  for (const [name, hits] of decls) {
    const filesOf = new Set(hits.map(h => h.file))
    if (filesOf.size < 2) continue
    duplicates.push({ name, hits })
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name))

  // 入口遮蔽：当前内联器把依赖包进 IIFE，但**入口直接展开**。所以
  // 「入口 vs 依赖」重名现在就已经是活的 bug，比纯拍平风险更高一档。
  const entryShadows = duplicates.filter(d => d.hits.some(h => h.file === ENTRY))

  return { files, decls, duplicates, entryShadows, unsupported, multiDecl }
}

/** 把结果渲染成人读报告。 */
export function format(result) {
  const out = []
  out.push('[lint-flat] 检查 ' + result.files.length + ' 个模块 / ' + result.decls.size + ' 个顶层声明')
  out.push('')
  if (result.entryShadows.length > 0) {
    out.push('  ERROR  入口遮蔽（当前内联器下就会生效，拍平后同样冲突）')
    for (const d of result.entryShadows) {
      out.push('         ' + d.name + '  ←  ' + d.hits.map(h => h.file + ':' + h.line).join(', '))
    }
    out.push('')
  }
  const flatOnly = result.duplicates.filter(d => result.entryShadows.includes(d) === false)
  if (flatOnly.length > 0) {
    out.push('  ERROR  跨模块重名（拍平后会静默互相覆盖）')
    for (const d of flatOnly) {
      out.push('         ' + d.name + '  ←  ' + d.hits.map(h => h.file + ':' + h.line).join(', '))
    }
    out.push('')
  }
  if (result.unsupported.length > 0) {
    out.push('  WARN   当前内联器不支持（拍平不受影响，但改构建器前别用）')
    for (const u of result.unsupported) {
      out.push('         ' + u.code + '  ' + u.file + ':' + u.line + '  ' + u.message)
    }
    out.push('')
  }
  if (result.multiDecl.length > 0) {
    out.push('  WARN   一行多声明（只检查了首个名字，建议拆行）')
    for (const m of result.multiDecl) out.push('         ' + m.file + ':' + m.line)
    out.push('')
  }
  const errors = result.duplicates.length
  const warns = result.unsupported.length + result.multiDecl.length
  out.push('结论：' + (errors === 0
    ? '可安全拍平（0 ERROR / ' + warns + ' WARN）'
    : '不可拍平（' + errors + ' ERROR / ' + warns + ' WARN）'))
  return out.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = lint()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      files: result.files,
      duplicateCount: result.duplicates.length,
      entryShadowCount: result.entryShadows.length,
      duplicates: result.duplicates.map(d => ({ name: d.name, hits: d.hits })),
      unsupported: result.unsupported,
      multiDecl: result.multiDecl,
    }, null, 2))
  } else {
    console.log(format(result))
  }
  const strict = process.argv.includes('--strict')
  const failed = result.duplicates.length > 0
    || (strict && (result.unsupported.length > 0 || result.multiDecl.length > 0))
  process.exit(failed ? 1 : 0)
}
