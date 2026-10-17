// 伪造写入 CLI（scripts/forge-session.mjs，v3 的关闭态写入器）。
//
// 用法：
//   node scripts/forge-session.mjs --session <id> --list
//   node scripts/forge-session.mjs --session <id> --seq <n> --block-index <i> --text "<新正文>" --dry-run
//   node scripts/forge-session.mjs --session <id> --match "<原文子串>" --text "<新正文>" --dry-run
//   node scripts/forge-session.mjs --session <id> --fingerprint <fp> --text-file new.md
//   node scripts/forge-session.mjs --file <会话文件路径> --match "..." --text "..."
//   node scripts/forge-session.mjs --restore --file <会话文件> --backup <备份文件>
//
// 寻址三选一（优先级：seq > fingerprint > match）：
//   --seq + --block-index  事件序号 + 块索引。UI 走这条（浏览器拿不到 sha256 指纹）
//   --fingerprint          正文指纹 sha256 前 16 位，由 --list 给出
//   --match                原文子串，命中多条时拒绝执行
//
// 选项：
//   --strategy preserve|merge   帧策略，默认 preserve（逐帧重压，边界不变）
//   --strip-scope same-event|all|none   剥签名范围，默认 same-event
//   --kind text|reasoning|both     可编辑块种类，默认 text（v3 起支持推理链）
//   --allow-running             dsh 正在运行也允许写（默认拒绝：v2.0 是关闭态写入，
//                               运行态热写入是 v2.1 的事）
//   --dry-run                   只报告将改动什么，不落盘
//
// 安全网：整文件备份（.bak-forge-<ts>）→ 原子写 → 写后自读校验，失败自动还原。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  forgeSession, loadLines, locateTargets, fingerprint, readSessionEvents,
} from '../src/session-write.mjs'
import { findSessionFile, sessionsRootDefault, assistantEditableBlocks } from '../src/session-log.mjs'

const args = process.argv.slice(2)
const opt = {}
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  const next = args[i + 1]
  if (next === undefined || next.startsWith('--')) { opt[key] = true; continue }
  opt[key] = next
  i += 1
}

const log = (...a) => console.log('[forge]', ...a)
const die = msg => { console.error('[forge] 错误：' + msg); process.exit(1) }

// DSH 桌面端可执行文件名（安装目录随机器不同，只认文件名）。
const DSH_EXE = 'DeepSeek Harness.exe'

/**
 * 探测 DSH 桌面端是否在运行。
 * @returns {{running: true|false|null, detail: string}} running=null 表示「探不到」，
 *   与「确认没在跑」是两回事——调用方必须区别对待，不能把探不到当成没在跑。
 */
function detectDshRunning() {
  const r = spawnSync('tasklist', [], { encoding: 'buffer' })
  if (r.error !== undefined && r.error !== null) return { running: null, detail: 'tasklist 启动失败（' + (r.error.message ?? r.error) + '）' }
  if (r.status !== 0) return { running: null, detail: 'tasklist 退出码 ' + r.status }
  const raw = r.stdout ?? Buffer.alloc(0)
  if (raw.length === 0) return { running: null, detail: 'tasklist 无输出' }
  // 中文 Windows 上 tasklist 输出是 CP936 而非 UTF-16：用 latin1 逐字节保留，
  // 进程名是纯 ASCII，照样能匹配（用 utf16le 解码只会得到乱码）。
  return { running: new RegExp(DSH_EXE.replace(/\./g, '\\.'), 'i').test(raw.toString('latin1')), detail: '已扫描 tasklist 输出 ' + raw.length + ' 字节' }
}

if (opt.restore === true) {
  if (opt.file === undefined || opt.backup === undefined) die('--restore 需要 --file 与 --backup')
  if (!existsSync(opt.backup)) die('备份不存在：' + opt.backup)
  const { copyFileSync } = await import('node:fs')
  copyFileSync(opt.backup, opt.file)
  log('已从备份还原：' + opt.backup + ' → ' + opt.file)
  process.exit(0)
}

// 目标文件
let file = opt.file
if (file === undefined) {
  if (opt.session === undefined) die('需要 --file 或 --session')
  const root = sessionsRootDefault()
  file = findSessionFile(root, opt.session)
  if (file === null) die('找不到会话 ' + opt.session + '（root=' + root + '）')
}
if (existsSync(file) === false) die('文件不存在：' + file)
log('目标文件: ' + file + '（' + statSync(file).size + 'B）')

const loaded = loadLines(file)

// --kind 决定列出/改写哪种块（text / reasoning / both），与写入路径同口径。
// v3 起推理链也能改：--list --kind reasoning 可列出思维链的 seq/blockIndex。
const kinds = opt.kind === 'reasoning' ? ['reasoning']
  : opt.kind === 'both' ? ['text', 'reasoning']
    : ['text']

// --list：列出全部可寻址块（按 --kind 过滤）
if (opt.list === true) {
  const blocks = assistantEditableBlocks(readSessionEvents(file), kinds)
  if (blocks.length === 0) die('该会话没有可编辑的 assistant/message 块（kinds=' + kinds.join(',') + '）')
  log('可寻址的助手块（' + blocks.length + ' 个，kinds=' + kinds.join(',') + '）：')
  for (const b of blocks) {
    const preview = b.text.replace(/\s+/g, ' ').trim()
    console.log(`  seq=${String(b.seq ?? '-').padStart(5)} block=${b.blockIndex} kind=${b.kind}  fp=${fingerprint(b.text)}  「${preview.slice(0, 56)}${preview.length > 56 ? '…' : ''}」`)
  }
  console.log('\n用 --seq <n> --block-index <i> 或 --fingerprint <fp> 精确定位；--match 在命中多个时会拒绝执行。')
  process.exit(0)
}

// 目标
const useSeq = opt.seq !== undefined && opt['block-index'] !== undefined
if (useSeq === false && opt.fingerprint === undefined && opt.match === undefined) {
  die('需要 --seq <n> --block-index <i>、--fingerprint <fp> 或 --match "<子串>"（先用 --list 查看）')
}
if (opt.text === undefined && opt['text-file'] === undefined) die('需要 --text 或 --text-file')
let newText = opt.text
if (opt['text-file'] !== undefined && opt['text-file'] !== true) {
  if (existsSync(opt['text-file']) === false) die('文本文件不存在：' + opt['text-file'])
  newText = readFileSync(opt['text-file'], 'utf8')
}

// --kind 已在上方（--list 之前）算好，这里直接用。
const where = useSeq
  ? { seq: Number(opt.seq), blockIndex: Number(opt['block-index']), kinds }
  : (opt.fingerprint !== undefined ? { fingerprint: opt.fingerprint, kinds } : { match: opt.match, kinds })
const hits = locateTargets(loaded.lines, where)
if (hits.length === 0) die('未命中任何可编辑块（kinds=' + kinds.join(',') + '）')
if (hits.length > 1 && opt.fingerprint === undefined && useSeq === false) {
  log('match 命中多个块，请改用 --fingerprint：')
  for (const h of hits) console.log(`  fp=${h.fingerprint}  seq=${h.seq ?? '-'}  「${h.text.replace(/\s+/g, ' ').slice(0, 50)}…」`)
  process.exit(1)
}
for (const h of hits) {
  log(`命中 seq=${h.seq ?? '-'} fp=${h.fingerprint}：`)
  console.log('  旧：' + h.text.replace(/\s+/g, ' ').slice(0, 100) + (h.text.length > 100 ? '…' : ''))
  console.log('  新：' + newText.replace(/\s+/g, ' ').slice(0, 100) + (newText.length > 100 ? '…' : ''))
}

// dsh 运行中检测（v2.0 = 关闭态写入）。
// 位置刻意放在真正落盘之前、--list 之后：读操作不该被写保护挡住。
if (opt['allow-running'] !== true) {
  const probe = detectDshRunning()
  if (probe.running === true) {
    die('检测到 DSH 桌面端正在运行。本工具默认是关闭态写入：请先完全退出 DSH 再执行；'
      + '确认要在运行中写入请加 --allow-running（自读校验仍会兜底，但宿主内存态可能覆盖改写，属未验证领域）')
  }
  if (probe.running === null) {
    // 探不到 ≠ 没在跑。这里是「大声警告后继续」，不是静默放行——
    // 最坏情况是 DSH 退出时把内存态回写、覆盖掉本次改写，所以必须让用户看见。
    log('警告：无法确认 DSH 是否在运行（' + probe.detail + '）。')
    log('      如果你此刻正开着 DSH，请先完全退出再继续——否则它退出时的回写可能覆盖本次改写。')
    log('      确认无误可忽略本警告；想跳过检测请加 --allow-running。')
  } else {
    log('DSH 未在运行（' + probe.detail + '），可以进行关闭态写入。')
  }
}

const result = forgeSession(file, {
  ...where,
  newText,
  kinds,
  strategy: opt.strategy === undefined ? 'preserve' : opt.strategy,
  stripScope: opt['strip-scope'] === undefined ? 'same-event' : opt['strip-scope'],
  dryRun: opt['dry-run'] === true,
})

if (result.dryRun) {
  log(`dry-run 完成：将改动第 ${result.wouldChangeLines.join(',')} 行（共 ${result.frameCount} 帧，策略 ${result.strategy}），未落盘`)
  process.exit(0)
}
log('写入成功：')
log('  策略: ' + result.strategy + '，剥离签名字段: ' + result.stripped + ' 个')
log('  自读校验: ' + JSON.stringify(result.verify))
log('  备份: ' + result.backup)
log('回滚: node scripts/forge-session.mjs --restore --file "' + file + '" --backup "' + result.backup + '"')
log('重启 DSH 后打开该会话，模型上下文即为伪造上文。')
