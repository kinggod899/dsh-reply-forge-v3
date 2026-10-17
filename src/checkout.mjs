// 诊断/宿主脚本共用的 checkout 锚定（v2，零依赖）。
//
// createRequire 可以用任意现存文件做锚点。历史上用
// node_modules/.anchor.cjs（pnpm 生成），但该文件随时可能被清掉
// （2026-10-15 就遇到一次），所以依次尝试若干候选，全部失败才报错。
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ANCHOR_CANDIDATES = [
  'node_modules/.anchor.cjs',
  'package.json',
  'node_modules/.modules.yaml',
  'pnpm-workspace.yaml',
]

/** 在 checkout 里找一个现存锚点文件并建 require；找不到返回 null。 */
export function anchorRequire(checkout) {
  if (typeof checkout !== 'string' || checkout === '') return null
  for (const rel of ANCHOR_CANDIDATES) {
    const p = join(checkout, rel)
    if (existsSync(p)) return createRequire(p)
  }
  return null
}

/** 解析并校验 checkout：返回 require，缺失时打印指引并以非零码退出。 */
export function requireCheckout(checkout) {
  const req = anchorRequire(checkout)
  if (req === null) {
    console.error('[diag] 未找到可用的 dsh dev checkout 锚点：' + checkout)
    console.error('[diag] 请设置 DSH_CHECKOUT 指向含 node_modules 的 dsh 源码检出，')
    console.error('[diag] 或创建 scripts/diag.config.json：{ "checkout": "<dsh 源码检出路径>" }')
    process.exit(1)
  }
  return req
}
