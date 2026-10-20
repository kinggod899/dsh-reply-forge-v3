// 发行包构建（scripts/build-release.mjs）。
//
// 做法：`git archive` 从指定 tag 导出**全部受 git 跟踪的文件**，打成两个包：
//   · `<name>.zip`  顶层目录=<name>/（人类用户：解压即用，与仓库布局一致）
//   · `<name>.tgz`  顶层目录=package/（npm pack 式布局：给 `dsh plugin add`
//                  之类的工具链消费；awesome-dsh-plugin 的 `tarball:` 字段
//                  要求 Release 托管的 .tgz，就是这个形状）
// 选定 git archive 这条路是因为：
//   1. 可复现——包内容 = tag 指向的 commit，一字不差；
//   2. 天然脱敏——.gitignore 挡掉的东西（.diag-tmp-focus/、.workbuddy-ai/、
//      *.local.json、diag.config.json）根本没进过 git，不可能漏进包里；
//   3. 不需要维护第二份「发行文件清单」——仓库即真相。
//
// 用法：node scripts/build-release.mjs v3.1.0
// 产物：dist/（zip + tgz + 清单）。dist/ 被 gitignore。

import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tag = process.argv[2]
if (tag === undefined || tag === '') {
  console.error('用法：node scripts/build-release.mjs <tag>，例：v3.1.0')
  process.exit(1)
}
const name = 'dsh-reply-forge-' + tag.replace(/^v/, '')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

// tag 必须真实存在于本地（先 git fetch --tags）
const tags = execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n')
if (tags.includes(tag) === false) {
  console.error('本地没有 tag ' + tag + '。先 git fetch --tags')
  process.exit(1)
}

// ── 出包门禁（在动 dist/ 之前跑，失败即中止）──────────────────────────────
// 为什么需要：包里装的是**已提交的** `.dsh-plugin/client.js`，而所有测试都跑在
// 工作区上。源码改了忘记重建时，本地测试可能全绿（测的是旧产物），用户拿到的
// 就是旧逻辑。这里用两道只读检查把这类事故挡在打包之前：
//   1. `build-client --check`：产物与源码字节一致（改了源码没重建 → 失败）；
//   2. `lint-flat`：客户端模块可安全拍平（跨模块顶层重名 → 失败）。
// 二者都是幂等只读操作，不会改任何文件。
const gates = [
  ['build-client --check（产物必须与源码一致）', 'build-client.mjs', ['--check']],
  ['lint-flat（客户端模块可安全拍平）', 'lint-flat.mjs', []],
]
for (const [label, script, args] of gates) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, stdio: 'inherit' })
  } catch {
    console.error('出包门禁失败：' + label + '。dist/ 未动，先修好再出包。')
    process.exit(1)
  }
}

// 门禁查的是**工作区**，包里装的是**tag**。两者不一致时明确警告：
// 允许「先出包再补提交」的流程，但不能让人以为包内容等于眼前的工作区。
const dirty = execFileSync('git', ['status', '--porcelain', '--', '.dsh-plugin', 'scripts', 'package.json', 'cordis.patch.yml'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean)
if (dirty.length > 0) {
  console.warn('警告：以下文件有未提交改动，包里装的仍是 tag 内容而非工作区版本：')
  for (const line of dirty) console.warn('  ' + line)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
const out = join(dist, name + '.zip')

execFileSync('git', [
  'archive', '--format=zip', '--prefix=' + name + '/',
  '-o', out, tag,
], { cwd: root, stdio: 'inherit' })

// 第二个产物：npm pack 式 tgz（package/ 前缀），供工具链按 tarball 安装
const tgz = join(dist, name + '.tgz')
execFileSync('git', [
  'archive', '--format=tar.gz', '--prefix=package/',
  '-o', tgz, tag,
], { cwd: root, stdio: 'inherit' })

// ── 出包自检：抽验关键文件在位、敏感文件绝不在位 ──────────────────────────
// 注意 core.quotepath=false：ls-tree 默认把中文路径转义成八进制序列，
// 拿着转义形式和 mustHave 的中文名比对会全部「缺失」。
const manifest = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', tag], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean)
const mustHave = [
  '安装插件.bat', '启用插件.bat', '关闭插件.bat', '修复会话.bat',
  'package.json', 'cordis.patch.yml', 'LICENSE', 'README.md', '使用说明.md',
  'CHANGELOG.md', '.dsh-plugin/client.js', '.dsh-plugin/index.mjs',
  'scripts/install.mjs', 'scripts/profile-lib.mjs', 'scripts/repair-sessions.mjs',
  'tests/client.test.mjs',
]
const mustNotHave = /(^|\/)(\.diag-tmp|\.workbuddy-ai)|\.local\.json$|diag\.config\.json$|\.bak-/
const missing = mustHave.filter(f => manifest.includes(f) === false)
const leaked = manifest.filter(f => mustNotHave.test(f))
if (missing.length > 0 || leaked.length > 0) {
  console.error('自检失败：缺 ' + JSON.stringify(missing) + '；泄漏 ' + JSON.stringify(leaked))
  process.exit(1)
}

const bytes = readFileSync(out).byteLength
const tgzBytes = readFileSync(tgz).byteLength
console.log('发行包就绪：' + out)
console.log('  文件数：' + manifest.length + '，大小：' + (bytes / 1024).toFixed(1) + ' KiB')
console.log('           ' + tgz)
console.log('           ' + (tgzBytes / 1024).toFixed(1) + ' KiB（package/ 前缀，tarball 安装用）')
console.log('  自检通过：16 个关键文件在位，无任何本机私有文件')
writeFileSync(join(dist, 'manifest-' + tag + '.txt'), manifest.sort().join('\n') + '\n')
console.log('  清单：dist/manifest-' + tag + '.txt')
