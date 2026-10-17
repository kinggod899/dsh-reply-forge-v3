/**
 * typert 贡献者体检：在合并 node_modules 里逐包 import ./typert 导出并跑宿主同款
 * validateTypertManifest，把「谁挂了、为什么挂」直接打出来。
 * 路径走环境变量 / 本地配置（安装位置因机器而异，不写死）：
 *   DSH_APP_RUNTIME_NM → app 运行时 node_modules（…/resources/app/dsh/node_modules）；
 *                         未设时读 scripts/diag.config.json 的 hostDir + /node_modules
 *                         （本地私有，被 gitignore）
 *   DSH_PROFILE_NM     → profile 的 node_modules（默认 ~/.dsh/profiles/desktop/node_modules）
 * 用法: CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/probe-typert.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'

let RUNTIME = process.env.DSH_APP_RUNTIME_NM
if (RUNTIME === undefined || RUNTIME === '') {
  const cfgFile = join(dirname(fileURLToPath(import.meta.url)), 'diag.config.json')
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
      if (typeof cfg.hostDir === 'string' && cfg.hostDir !== '') RUNTIME = join(cfg.hostDir, 'node_modules')
    } catch { /* 配置坏了就当没有，走下面的报错 */ }
  }
}
const PROFILE = process.env.DSH_PROFILE_NM ?? join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')

if (RUNTIME === undefined || RUNTIME === '') {
  console.error('[probe-typert] 请设置 DSH_APP_RUNTIME_NM（…/resources/app/dsh/node_modules），')
  console.error('[probe-typert] 或创建 scripts/diag.config.json：{ "hostDir": "<桌面端>/resources/app/dsh" }')
  process.exit(1)
}

const loaderUrl = pathToFileURL(join(RUNTIME, '@deepseek-ai', 'dsh-typert-loader', 'lib', 'index.js')).href
const { validateTypertManifest, TYPERT_HOST_EXPORT } = await import(loaderUrl)

function typertRelOf(manifest) {
	if (typeof manifest.exports !== 'object' || manifest.exports === null) return undefined
	const target = manifest.exports[TYPERT_HOST_EXPORT]
	if (target === undefined) return undefined
	if (typeof target === 'string') return target
	if (typeof target === 'object' && target !== null) return target.default
	throw new Error(`exports["./typert"] must be a string or object with string default`)
}

function scanScope(scopeDir, label) {
	const results = []
	for (const name of readdirSync(scopeDir)) {
		const pkgJsonPath = join(scopeDir, name, 'package.json')
		if (!existsSync(pkgJsonPath)) continue
		let manifest
		try { manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) } catch { continue }
		let rel
		try {
			rel = typertRelOf(manifest)
		} catch (error) {
			results.push({ label, manifestName: manifest.name ?? name, error: String(error) })
			continue
		}
		if (rel === undefined) continue
		results.push({ label, manifestName: manifest.name ?? name, artifactPath: join(dirname(pkgJsonPath), rel) })
	}
	return results
}

const entries = [
	...scanScope(join(RUNTIME, '@deepseek-ai'), 'runtime'),
	...scanScope(join(PROFILE, '@deepseek-ai'), 'profile-scopped'),
	...scanScope(PROFILE, 'profile-plugins')
]
console.log(`[probe] 带 ./typert 导出的包共 ${entries.length} 个`)

let fail = 0
for (const entry of entries) {
	if (entry.error) {
		fail += 1
		console.log(`[FAIL] ${entry.manifestName} (${entry.label}) exports 畸形: ${entry.error}`)
		continue
	}
	try {
		const mod = await import(pathToFileURL(entry.artifactPath).href)
		validateTypertManifest(entry.manifestName, mod.TYPERT)
		console.log(`[ok] ${entry.manifestName} (${entry.label})`)
	} catch (error) {
		fail += 1
		console.log(`[FAIL] ${entry.manifestName} (${entry.label})`)
		console.log(`       ${String(error).split('\n').slice(0, 3).join('\n       ')}`)
	}
}
console.log(`[probe] 完成：失败 ${fail} / 共 ${entries.length}`)
