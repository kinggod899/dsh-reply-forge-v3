# dsh-reply-forge-v3 — 项目规则与进度

> 本文件是项目的**进度看板 + 规则速查**。权威设计论证在 [PLAN.md](./PLAN.md)，
> 用户向说明：中文 [README.md](./README.md) / 英文 [README.en.md](./README.en.md) /
> [使用说明.md](./使用说明.md)，深度开发日志在
> 开发期工作区记忆目录（不随仓库分发），项目级记忆在 `.workbuddy-ai/memory/`。

## 当前状态（2026-10-20 复核）

- 版本 `3.1.0`（**v3.2.0 待发**：两个 PR 已合并进 main，本机已装待用户真机测试）；
  测试 **272 项 / 14 套**（10-20 实测：`node --test "tests/*.test.mjs"` 14/14 全绿；
  其中 2 套（persistence/projection）需本机宿主包，缺则 SKIP 不计失败；client 套件 74 项，
  `build-client.mjs --check` 字节一致）。
- **仓库管理纪律（2026-10-20 用户拍板改）**：废除「main 单一干净 commit」，
  改为常规多 commit + PR 流程。每个特性/修复各一个分支、一个 PR，合并用
  **merge commit**（保留完整 commit message，不 squash、不重写公开历史）。
  上个版本的脱敏历史（v3.1.0 之前的 orphan 重写）是既成事实，不再追溯。
- **公开发布脱敏已完成（10-17 午间）**：`.gitignore` 补挡 `.diag-tmp-focus/`（63M 真宿主
  Edge profile，IndexedDB 里有真实会话内容）与 `.workbuddy-ai/`（项目记忆含账号信息）；
  TODO.md / 脚本 / bat / 探针里的一切本机路径改为环境变量 + 本地私有配置
  （`scripts/diag.config.json`、`tests/host-paths.local.json`，均被 gitignore）；
  `修复会话.bat` 按 GBK+CRLF 房规做了字节级手术删掉写死的 node 路径；补 `.gitattributes`
  统一行尾。fresh clone 全量门禁 13/13 通过、
  集成套件无宿主时优雅 SKIP。**仓库已上线**（见下方待办 #5，PR 流程见「当前状态」）。
- 代码侧 P0/P1 已封口：`ignorable` shim + 每会话写句柄核验、真宿主持久化闭环、
  受损会话修复工具、文档安全断言纠偏。
- **BUG-1 第四轮修复（10-17 下午）：锁定最大疑凶——native `window.confirm`。**
  真机证据链：焦点探针全绿（`active=composer / editable=true / selIn=true`）却打不了字；
  两条路径的唯一结构性差异就是写入路径有 OS 级原生模态框。Electron 的原生 confirm
  会把 app 窗口的键盘焦点弄丢（Windows 尤甚），鼠标还能用、DOM 焦点也全对，
  但按键进不来——与用户看到的现象完全吻合；无头复现里 CDP 自动批对话框、
  不经 OS 焦点逻辑，所以一直复现不出。**改为页面内两步确认**（第一次点击出
  确认行、第二次才写；内容/目标/写入方式变化即失效），写入路径不再有任何
  OS 级模态。顺带保留：textarea 点击保险、bar 压层修复（z-index + 编辑器
  开着藏 bar）、候选择优、selection 兜底、打字保险丝。
- 真宿主终验（含打字探针）：两步确认正常、**原生对话框出现次数 0**、
  提示行「✓ 已写入活会话…焦点已交还输入框」、打字验证 landed=true；
  对照（仅本机渲染）同样 landed=true。
- **BUG-2 第五轮修复（10-17 晚）：写入伪造被 STALE_TARGET 拒绝（重启后必现）。**
  根因：**投影双口径不一致**——在线写（`forgeLive`）的陈旧校验基准是投影后文本，
  落盘读（`assistantEditableBlocks`）读的是原始事件文本；DSH 重启后此前的在线
  伪造（`reply-forge/patch` 事件）被宿主持久化落盘 → 原文 ≠ 投影文本 →
  expectText 拿旧文本当基准 → 被拒。修复三件套：
  ① 读路由（`routes.mjs`）落盘分支过 `projectedTextsOf` 投影，UI 拿到的就是
  模型所见；② `session-write.mjs` 在陈旧校验**之前**加投影优先拒绝
  （PATCHED_TARGET：改原文会被投影盖住、写了也不生效，明说走在线路径）；
  ③ 客户端 `runForge()` 保留「陈旧自动重试一次」兜底（强制重读 → 重新定位 →
  原样再写），失败时摆出 actual/expected 两边文本。
- **外部审计整改（10-18）**：两份独立 AI 审计报告逐条核对，真问题全部修复——
  `doneNote` 死代码与安全语义矛盾（`APPEND_UNSAFE` 从不自动回落盘，删死分支、
  给 `WRITER_NOT_ROUTED` 补文案）；`patched` 契约在线 `number[]` / 落盘
  `{seq,blockIndex}[]` 不统一 → 统一块级对象数组；CLI `--list` 忽略 `--kind`
  列不出思维链 → 按 `--kind` 过滤；client/record 文件头 v2 残留注释更新；
  四个 bat 补探 DSH 自带 node（`%USERPROFILE%\.dsh\dsh-runtimes\...\node\bin\node.exe`）；
  package.json 补 `engines>=18` + scripts；「233 项全绿」口径区分 21 项 SKIP；
  README 瘦身门面化（细节归使用说明.md）；`scripts/provider-oracle.mjs`
  （含商业客户端渠道信息）从公开仓库撤下，本地保留。
- 仓库已上线：公开 GitHub 仓库 `kinggod899/dsh-reply-forge-v3`；v2 仓库独立维护，
  架构不同勿混用（README 内已互链）。v3.1.0 发布时做过一次 orphan 历史重写（脱敏），
  该段历史不可追溯也不必追溯；**此后一律走 PR 流程，不再重写**。

## 待办（按优先级）

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| BUG-1 | 写入伪造保存后焦点未回到宿主输入框 / 打字无效 | ✅ 已修复，用户真机复验通过（10-18） | 疑凶=native confirm（已改页面内两步确认）+ 焦点三机制 + 点击保险 + bar 压层 |
| BUG-2 | 写入伪造被 STALE_TARGET 拒绝（重启后必现） | ✅ 已修复，用户真机复验通过（10-18） | 根因=投影双口径；修复=读路过投影 + PATCHED_TARGET 拒绝 + 自动重试一次 |
| BUG-3 | 插件整页失效、按钮全无，重启 DSH 才好 | ✅ 已修复（10-20，PR #2），待用户真机复验 | 根因=bootstrap interval 找到锚点即永久自停，锚点被宿主 reconcile 换掉后 observer 挂死；修复=常驻心跳 + focus/visibilitychange 唤醒 |
| BUG-4 | 带代码块的回复没有「伪造」按钮，但编辑器里能调出 | ✅ 已修复（10-20，PR #2），待用户真机复验 | 根因=宿主代码块 banner 带复制 button，被 classify 的 ACTION_TAGS 当结构化控件整块拒绝；修复=豁免代码块外壳 + BLOCK_TAGS 计代码块为块级内容 |
| 1 | 焦点修复真机复验：重启 DSH → 写入伪造 → 保存后直接打字 | ✅ 已验证通过（10-18） | 提示行显示「焦点已交还输入框」，可直接打字 |
| 2 | 修复受损会话（`ignorable` 缺失的旧记录）：退出 DSH → `修复会话.bat` 诊断 → `apply` | ⬜ 待用户 | 原文件未动，工具已诊断命中 |
| 3 | 真机验收矩阵：新/老会话 × 在线/落盘 | ⬜ 待用户 | 确认模型下一轮采信 |
| 4 | 关插件重启回归：`关闭插件.bat` → 重启 → 会话可开、伪造退原文 | ⬜ 待用户 | 再 `启用插件.bat` 验恢复 |
| 5 | 发布：独立 v3 仓库 + release | ✅ 已上线（release id 415609796） | https://github.com/kinggod899/dsh-reply-forge-v3/releases/tag/v3.1.0 ；标题/正文已补（name「dsh-reply-forge v3.1.0」+ 版本说明）；附件 zip + tgz 均为 tag 对应构建、与本地 `node scripts/build-release.mjs v3.1.0` 输出字节级一致（不在此处写死字节数，避免自指）；README 中文为主 + README.en.md 英文附加（用户拍板中文优先）；PR #7845 已投 awesome-dsh-plugin 待评审 |
| 6 | awesome-dsh-plugin 收录投稿 | ✅ 已过稿（PR #7845 合并，条目在列表 2285 行） | 条目 yml 已随 PR 提交并合并；硬条件已补齐：`dsh-plugin` 等 6 个 topic 经 API 设置、仓库满 24h、单条目、描述无营销词、tarball 钉 v3.1.0；README 中英双版已加收录注记 |
| 7 | **v3.2.0 发布**（inbox 队列编辑 + 三个 bug 修复） | 🔵 代码已合并（PR #1/#2/#4 + 新 PR：在途等待 + 长文本按钮），本机待装新版，用户真机测试后发版 | 真机 bug 二修：PR #4 的「`getSnapshot().queue` 镜像源」是**旧副本接口**（真实桌面端宿主 buildSnapshot 无 queue 字段）→ 已回退为 inbox 投影单一权威源（与宿主 UI `useProjection("inbox")` 逐字对齐）+ 新增在途检测：`getSnapshot().pendingSubmissions` 回显匹配即轮询等落库（200ms/6s），回显消失=入队失败快失败；另修拾取层：markdown 原始 HTML 的自定义元素/语义标签计入块级（长文本回复有按钮）。发布循环：版本号 bump（package.json / release 脚本 / index.mjs 调试命名空间 / CHANGELOG 定日期）→ `build-release.mjs v3.2.0` → GitHub API 建 release + 传 zip/tgz 资产（正文用 CHANGELOG 用户版）→ fresh clone 终验；**不再 orphan 重写历史**，tag v3.1.0 保留作历史锚 |

## 不可破的规则（改代码前必读）

1. **projection 绝不注册到 `assistant/message`**，绝不对它抛错（抛错=会话折叠失败）；
   必须用自有事件类型 `reply-forge/patch`，且 `apply()` 里**同步**注册。
2. `assistant/message` 不能做 surface replacement（`sourceEventSeqs` 互斥约束，PLAN §2）。
3. `blockIndex` 是 content 数组下标，`session-log.assistantEditableBlocks` /
   `session-write.locateTargets` / `patch-event.readBlock` **三处同口径**，改一处改三处。
4. 每个 patch 事件落盘前必须带 `ignorable: true`（shim 在宿主持久化前补）；
   写前核验目标会话写句柄（`WRITER_NOT_ROUTED` 可 auto 回落盘，`APPEND_UNSAFE` 一律拒绝）。
5. 改 reasoning 块必须连带剥 `signature` / `thinkingSignature`。
6. 改 `.dsh-plugin/client/*.mjs` 后必须 `node scripts/build-client.mjs` 重建，并跑
   `--check`（异地重建需字节一致）。
7. 安装/启用/关闭只改静态配置；**绝不在 DSH 运行时跑 pnpm install**；bat 房规 =
   GBK + CRLF + chcp 936，node 调用外包一层内层 `cmd /d /s /c "chcp 65001 …"`。
8. 数测试项数要逐文件跑（自建 test() 收集器，`node --test` 只按文件计 13 项）。
9. **焦点/输入类回归必须包含「真实打字验证」**：只验 activeElement 落点会漏掉整整
   一类「有焦点但打不了字」的故障（抓错输入框副本 / selection 缺失 / 宿主事后抢焦）。
   无头复现用 `Input.insertText` 后读输入框文本长度断言。
10. 未停 DSH、未备份、未经用户逐项确认，**不改用户会话文件**。
11. 集成测试按 `DSH_SESSION_PKG` / `DSH_APP_ROOT` 等环境变量定位宿主包，**找不到就
    SKIP 不算失败**（发行包在没装 DSH 的机器上也要能跑绿）；绝不在代码里写死
    本机安装路径。

## 常用命令

```bash
# 全量测试门禁（13/13 即过）
node --test "tests/*.test.mjs"
# 重建客户端产物 + 校验
node scripts/build-client.mjs && node scripts/build-client.mjs --check
# 真机焦点复现（起真宿主 + 无头 Edge，会往目标会话写一条 patch）
CODEBUDDY_SAFE_DELETE_ENABLED=0 node scripts/diag-focus.mjs
```
