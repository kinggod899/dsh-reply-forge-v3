// 构建契约自检：client.js 必须与源码一致，且模块 id 不能泄漏仓库绝对路径。
//
// 为什么单独一个文件：这里的 bug 曾在真机咬过一次——safeId 用绝对路径生成模块
// 前缀，导致换任何目录构建产物就变。仓库自己 --check 照样过，只有把发行包解到
// 别处才暴露（解开 --check 失败）。所以除了「产物新鲜」，还要钉住「产物里不出现
// 本仓库路径的编码形态」。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generate } from '../scripts/build-client.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUTPUT = resolve(ROOT, '.dsh-plugin', 'client.js')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('client.js 与源码一致（generate --check）', () => {
  const r = generate({ check: true })
  if (!r.ok) throw new Error('--check 未过：' + (r.errors ?? []).join('; '))
})

test('产物里没有仓库绝对路径的编码形态（换目录构建必须等价）', () => {
  const code = readFileSync(OUTPUT, 'utf8')
  // safeId 会把非字母数字替换成下划线；任何一段本仓库绝对路径被编码后都不该出现
  const leak = ROOT.replace(/[^A-Za-z0-9]/g, '_')
  if (code.includes(leak)) {
    throw new Error('client.js 里出现了绝对路径编码 ' + leak + '，构建不可移植')
  }
  // 依赖模块的前缀必须是仓库相对路径的编码（入口模块自身不套 factory，没有前缀）
  if (!code.includes('__m_dsh_plugin_client_record_mjs')) {
    throw new Error('没找到按相对路径生成的模块前缀，safeId 可能又被改回了绝对路径')
  }
})

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log('  PASS  ' + t.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + t.name + ' —— ' + String(error?.message ?? error))
  }
}
console.log(failed === 0 ? '\n全部通过（' + tests.length + '）' : '\n失败 ' + failed + '/' + tests.length)
process.exit(failed === 0 ? 0 : 1)
