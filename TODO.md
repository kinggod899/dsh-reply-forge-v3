# dsh-reply-forge-v3 — 项目规则与进度

> 本文件是项目的**进度看板 + 规则速查**。权威设计论证在 [PLAN.md](./PLAN.md)，
> 用户向说明：中文 [README.md](./README.md) / 英文 [README.en.md](./README.en.md) /
> [使用说明.md](./使用说明.md)，深度开发日志在
> 开发期工作区记忆目录（不随仓库分发），项目级记忆在 `.workbuddy-ai/memory/`。

## 当前状态（2026-10-26 复核）

- **BUG-7「伪造刷新就恢复」已修（10-26，待发行 v3.4.2）**：用户报「明明是正常的
  伪造，刷新就恢复」。核查结论——**模型侧一直是好的**，失效的是界面显示层。
  三条实证：91 条 patch 全落盘且带 ignorable、类型未被迁移改名；真宿主回放
  5/5 命中；同块连续改 3 次全过陈旧校验（投影没生效的话第二次就 STALE 了）。
  真因两层：① 宿主刷新/重开走 `dsh-session-query` 冷读，折叠用**硬编码**的
  `currentSessionMessageProjections = [imageOffloadProjection]`，插件投影进不去
  （`SessionStore` 活会话才有）→ 页面内显示伪造、刷新后显示原文，这是宿主设计；
  ② 本机覆盖表（刷新后的唯一兜底）键锚在「接管那一刻 DOM 文本」上，而页面内
  DOM 是**投影文本**，刷新后拿原文算的键在表里不存在 → 兜底失败。LevelDB 取证：
  某会话 6 个被投影块原文键命中 **0/6**，被改成 `"1"` 的块伪造键反倒命中。
  修复：读路由两条路径回传 `rawText`（未投影原文）→ 覆盖键改锚 rawText
  （内容寻址，跨刷新稳定）+ 旧键兜底 + 记录后到自动纠键 + 还原时清旧键。
  顺带加固：伪造推理块时连 `source.replayState.blocks[i].signature` 一起剥
  （provider 序列化会原样回填，只剥块签名会让签名校验型 provider 拒掉整条请求
  ——「伪造写进去了但下位模型不采信」）。另加升级护栏：verify-host 新增
  「活会话投影来源」检查（静态核验 `SessionStore.prepare` 仍传 `this.projections`，
  若哪天宿主把活会话也换成冷读那份硬编码列表 → 采信会整条断且不报错 → 直接 FAIL）。
  回归 **417 项 / 17 套全绿**（+11）。
  **已知边界**：换设备/清缓存/无痕仍回原文（覆盖表是本机 localStorage），
  那一层要宿主把插件投影纳入冷读路径，目前无公开入口。
  **采信不受影响**：patch 事件在会话文件里，模型请求走活会话的注册表投影
  （真机自检实测 2 处 `this.projections`，硬编码列表未侵入）——与浏览器存储无关。

- **v3.4.1 已发行（10-24）**：GitHub Release
  https://github.com/kinggod899/dsh-reply-forge-v3/releases/tag/v3.4.1
  （release id `422421583`，zip/tgz 双资产已传，tag `v3.4.1` → `8704a4e`）；
  npm **10-24 08:3x CST 发布成功**（`dist-tags.latest = 3.4.1`，账号 end1949）。
  终验：fresh clone 到 tag 后 `build-client --check` OK + **404 项 / 17 套全绿**；
  `npm install dsh-reply-forge-v3@3.4.1` 从 registry 装出 **17 文件**、版本号一致。
  3.4.0 从未单独发行（版本号预提后并入本版），README 中英两版的宿主升级口径
  已改为「v3.4.1 起」。

- **BUG-6 长回复内容不全 / 改了不生效已修并发行（10-23 修，10-24 随 v3.4.1 发行；
  PR #17 已合并，merge commit `bdb2827`，分支已删）**：真机症状是「1450 字回复点伪造只剩几个词」+
  「从目标下拉切回该消息后写入不生效」。根因在取正文与定位两处：
  ① `ownText` 只遍历 `children`（元素子节点），markdown 段落是混合内容
  （`<p>正文<strong>粗</strong>正文</p>`），直属文本节点整段被丢；
  ② 记录存 markdown 源码、页面是渲染结果，字符串直接比永远不等 → 精确匹配
  形同虚设 → 全部退化成「末尾对齐推断」→ 页面与记录条数一错位就写错块。
  修复四点：`ownText` 按文档顺序遍历（含文本节点，块级边界补空格、行内不补）；
  `matchBlocks` 新增 `canonical` 选项（用插件渲染器把源码渲染后再比，源码形态
  同时入索引以免误伤思维链）；精确命中时编辑器初值取记录原文（否则一保存就把
  加粗/标题拍平）；目标下拉「选回自己这条」不再按外来目标处理。回归 **404 项 /
  17 套全绿**（client 91 / record 31，+9）。

- **v3.4.0 版本血统已合并**（10-23，PR #14，merge commit `2702b4d`，分支已删）：
  编辑器「历史版本」面板 + 「还原到此版」。零新事件字段 / 零写路径改动 /
  零投影改动：血统从已有事件**纯推导**（`src/lineage.mjs`：原稿在原始事件、
  patch 按事件顺序堆叠、连续重复塌缩），只在点开面板时算一次；还原 = 把旧版
  文本填回编辑器、走既有「写入伪造」（两步确认/陈旧校验/自动备份全复用）。
  新增只读路由 `GET /api/reply-forge-v3/session/lineage`（sessionId 安全字符
  校验 + seq/blockIndex 显式必填，防 Number(null)=0 悄悄变第 0 块）。
  测试 **360 项 / 15 套**（本态执行 339，21 项需宿主包 SKIP）：新增 lineage 19
  + routes +8 + client +5 + record +6。已知边界（文档已如实写明）：仅落盘写入
  的块无版本链（原稿在 `.bak-forge-*` 备份）；在线写落盘数百毫秒滞后。
  **已随 v3.4.1 发行**（3.4.0 未单独发行）。
- **v3→v4 双类型修复已实施（10-23，分支 `fix/patch-event-plugin-namespace`，
  PR #15 已合并，merge commit `def3e07`，分支已删；随 v3.4.1 发行）**：宿主 0.2.1 迁移改名
  （`reply-forge/patch` → `plugin:reply-forge/patch`）导致的静默失假已修。
  读侧双类型接受（`PATCH_EVENT_TYPES` + `isPatchEventType`，
  `projectedTextsOf` / `versionStackOf` 两种类型行为一致）、两种类型各注册一个
  投影（`project` 模块级共享，行为不漂移）、`OWN_EVENT_TYPES` 纳入两者；
  写侧不变。回归 **378 项 / 16 套全绿**（本态 349 + 宿主门控 29）：
  单元级 +13，新增 `tests/migration-rename.test.mjs` 5 项跑**真宿主 codec
  生产迁移路径**（合成 v3 日志 → 编码 → catalog 恢复+迁移 → 改名实锤 →
  喂回真 Session 折叠民警回环 → 缺 ignorable 整条被拒）。
- **① 升级自检已实施（10-23，分支 `feat/verify-host`，PR #16 已合并，merge commit `d6570e6`，分支已删，
  随 v3.4.1 发行）**：`scripts/verify-host.mjs` 四层探针落地（PLAN §9.2）：
  T0 版本基线（`host-baseline.json`：宿主三元组 + 8 个关键包版本 + 契约期望值，
  漂移 → WARN；附 app.asar 结构校验）/ T1 契约面十项（导出面 / 已知事件类型表 /
  投影注册 API / `append` 收 `surfaceOp` / 未知类型直通 / 持久化闸门正负对照 /
  读侧双类型接受 / 投影注册面 / plugin 记录 API）+ **强制跑四个宿主门控套件，
  缺宿主 = FAIL** / T2 boot 冒烟（`--boot`）/ T3 活体 CDP（`--live`，委托
  diag-focus）。`--extract` 从裸 app.asar（asar + unpacked 叠加，dataStart
  按全集算）提取宿主树；`--json` 机器可读。实测：带宿主 T0+T1 26 PASS/0 FAIL、
  `--boot` 31 PASS、裸 asar 提取后 28 PASS、真·无宿主双 FAIL 退出码 1
  （设计语义正确）。全量回归 **395 项 / 17 套全绿**（原 378/16 + 自测 17），
  无宿主优雅 SKIP（此态执行 366）。实测纠偏一条旧认知：本机宿主**无需环境
  变量**即可解析——`resources/app/dsh` 是真实 444M 目录（此前 `ls` 失败是
  沙箱读取限制造成的误判）。
- **宿主漂移调研完成（10-23，PLAN.md §9；① 已实施，③ 已放弃）**：本机真宿主已是
  **0.2.1-rc.2**（PLAN 主体分析基于 0.2.0-rc.2）。三个新结论：
  ①**v3→v4 迁移会把未知 ignorable 事件改名** `plugin:<type>`
  （`dsh-session-format-v3-to-v4` 的 `namespaceV3OpaqueEvent`，
  由 `dsh-session-persistence-jsonl` 在读 v3 世代文件时触发并写盘），
  我们的 `reply-forge/patch` 将被改成 `plugin:reply-forge/patch` →
  投影/血统/投影基准全部静默失配（本机只读扫描：57 个 patch 全在 v4
  文件未被改名，v3 文件 0 个——风险潜在但真实）。修复=双类型接受
  （读侧认两种类型、投影双注册、写侧不变），顺带成为 ① 的基线断言。
  ②**① 升级自检**（verify-host）设计定稿并**已实施**（分支
  `feat/verify-host`，PR #16 已合并，merge commit `d6570e6`，分支已删）：T0 版本基线 / T1 契约面
  （含强制跑宿主依赖测试，缺宿主=FAIL）/ T2 boot 冒烟 / T3 活体 CDP。
  ③**③ 就地回溯**（rewind）机制打通后经用户评审**放弃**：宿主管道
  `system/message` + `surfaceOp:replace` + 空 content（不占 wire message）
  即可遮蔽区间，持久化原生免 shim，但**被宿主 `SessionStore.fork`
  严格支配**（同模型效果；fork 有 parentSession/inheritedEventCount
  显式血缘、双向第一等会话 vs 回溯单向不可逆、forked closers 兜未收尾
  轮次、零新写杠杆）。用户原话：「和分支没什么区别，还比分支少了个
  记录」——核查后成立。机制留档 PLAN §9.3，不再开发；残余选项=
  逐消息「从这里分支」快捷键（调宿主 fork，非新机制）。
  建议顺序：**双类型修复 → ① 升级自检**（③ 不为）。
  **执行更新（10-23 晚）**：双类型修复已实施（PR #15 已合并，见上）；
  ① 升级自检已实施（见上，PR #16 已合并，merge commit `d6570e6`，分支已删）；改名断言同时成为 ① T0 基线的
  组成部分。
- 版本 `3.3.0` **GitHub 侧已发布**（10-22，release id 420101843，
  https://github.com/kinggod899/dsh-reply-forge-v3/releases/tag/v3.3.0）：
  上 npm（包名去 `@local` scope）+ files 白名单 + 旧安装自动迁移；
  **npm publish 10-22 11:38 CST 已成功**（registry 实证 dist-tags.latest=3.3.0，账号 end1949）。
  上一版 `3.2.0`（10-21，release id 419545336）：
  PR #1/#2/#4/#5/#6/#7/#8/#9/#10/#11/#12 全部合并进 main；
  测试 **321 项 / 14 套**（10-21 实测：逐文件跑 14/14 全绿（`node --test` 按文件计），
  其中 3 套（persistence/projection 及 ignorable 的宿主项共 21 项）需本机宿主包，
  缺则 SKIP 不计失败（此态执行 300 项）；client 套件 81 项、queue 64 项，
  `build-client.mjs --check` 字节一致）。**persistence 闭环首次在真实桌面端宿主
  （app.asar 提取 + asar.unpacked 原生模块叠加）上验证通过**——此前对齐的是旧副本
  （`E:/game/DSH`），其 jsonl 包是 default 导出、真宿主是命名导出，测试从没在真宿主上
  跑通过（形状差 + 原生模块 koffi 缺失两连坑，已修）。
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
| BUG-3 | 插件整页失效、按钮全无，重启 DSH 才好 | ✅ 已修复（10-20，PR #2），用户真机复验通过（10-21） | 根因=bootstrap interval 找到锚点即永久自停，锚点被宿主 reconcile 换掉后 observer 挂死；修复=常驻心跳 + focus/visibilitychange 唤醒 |
| BUG-4 | 带代码块的回复没有「伪造」按钮，但编辑器里能调出 | ✅ 已修复（10-20，PR #2），用户真机复验通过（10-21） | 根因=宿主代码块 banner 带复制 button，被 classify 的 ACTION_TAGS 当结构化控件整块拒绝；修复=豁免代码块外壳 + BLOCK_TAGS 计代码块为块级内容（残留见 BUG-5） |
| BUG-5 | 长文本回复（正文提到「工具调用」等词）没有「伪造」按钮 | ✅ 已修复（10-21，PR #7），用户真机复验通过（10-21） | 根因=classify 的 ACTION_TEXT 含 20+ 条工具/文件/批准词汇，把 3641 字技术分析整条拒掉（宿主不在正文渲染工具调用块——asar ui-chat `case "tool-call": break;`；真 <button> 由 ACTION_TAGS 结构检查拦）；修复=ACTION_TEXT 只留 3 条费用页脚标记 |
| 1 | 焦点修复真机复验：重启 DSH → 写入伪造 → 保存后直接打字 | ✅ 已验证通过（10-18） | 提示行显示「焦点已交还输入框」，可直接打字 |
| 2 | 修复受损会话（`ignorable` 缺失的旧记录）：退出 DSH → `修复会话.bat` 诊断 → `apply` | ⬜ 待用户 | 原文件未动，工具已诊断命中 |
| 3 | 真机验收矩阵：新/老会话 × 在线/落盘 | ⬜ 待用户 | 确认模型下一轮采信 |
| 4 | 关插件重启回归：`关闭插件.bat` → 重启 → 会话可开、伪造退原文 | ⬜ 待用户 | 再 `启用插件.bat` 验恢复 |
| 5 | 发布：独立 v3 仓库 + release | ✅ 已上线（release id 415609796） | https://github.com/kinggod899/dsh-reply-forge-v3/releases/tag/v3.1.0 ；标题/正文已补（name「dsh-reply-forge v3.1.0」+ 版本说明）；附件 zip + tgz 均为 tag 对应构建、与本地 `node scripts/build-release.mjs v3.1.0` 输出字节级一致（不在此处写死字节数，避免自指）；README 中文为主 + README.en.md 英文附加（用户拍板中文优先）；PR #7845 已投 awesome-dsh-plugin 待评审；**v3.2.0 亦已上线**（release id 419545336，https://github.com/kinggod899/dsh-reply-forge-v3/releases/tag/v3.2.0，zip + tgz 资产与 `node scripts/build-release.mjs v3.2.0` 输出字节级一致，fresh clone 终验通过——无宿主 300 项执行 + 2 套 SKIP，带宿主 321/14 全绿） |
| 6 | awesome-dsh-plugin 收录投稿 | ✅ 已过稿（PR #7845 合并，条目在列表 2285 行） | 条目 yml 已随 PR 提交并合并；硬条件已补齐：`dsh-plugin` 等 6 个 topic 经 API 设置、仓库满 24h、单条目、描述无营销词；**tarball 钉版已随 v3.2.0 发布更新**（v3.1.0 → v3.2.0，PR #8495 待合并，链接 200 验证通过）；README 中英双版已加收录注记 |
| 7 | **v3.2.0 发布**（inbox 队列编辑 + 四个 bug 修复） | ✅ 已发布（10-21）：用户真机复验通过 → PR #8（persistence 真宿主兼容）/ #9（版本 bump + 文档定稿）合并 → tag v3.2.0 → GitHub release id 419545336（zip + tgz 资产字节级一致）→ fresh clone 终验通过 | 真机 bug 三修（PR #6）归因**错误**——「投影在气泡渲染后又变了（回合收走/React 慢半拍）」被新证据推翻：新诊断 `nextStepRows:"unreadable"`（readInboxRows 返回 null）与 `inboxNextStep:1`（queueDiag 绑定调用成功）出现在同一函数，唯一差异是绑定/未绑定 ⟹ 真凶 = `const faceOf = projections.faceOf; faceOf(INBOX_KEY)` 摘函数调用（宿主 ProjectionValueStore 是 class，faceOf 内部用 this；ES module 严格模式下 this=undefined → TypeError 被 try/catch 吞成 null）。测试桩全是箭头函数不碰 this，所以一直绿、真机必崩。修复=绑定调用 + 宿主形状 class 桩回归测试（`class HostProjectionStore`，断言绑定读得到 + 裸调必抛）。锚点复核/三路诚实失败/在途等待保留为有效加固（叙事不改错方向，改的是病根诊断）。分类器五修：ACTION_TEXT 从 20+ 条工具/文件/批准词汇收缩到仅 3 条费用页脚标记（asar 证据：ui-chat `case "tool-call": break;`——正文容器只渲染 text/reasoning/image/unknown，工具调用/批准是独立 node 带真按钮，ACTION_TAGS 结构检查已拦）——真机 3641 字技术分析（ session-8adcb914 消息#15）因含「工具调用」四字被拒，实跑从❌变✅。测试 queue 64 / client 81（带宿主 321 项 / 14 套）。发布循环：版本号 bump（package.json / release 脚本 / index.mjs 调试命名空间 / CHANGELOG 定日期）→ `build-release.mjs v3.2.0` → GitHub API 建 release + 传 zip/tgz 资产（正文用 CHANGELOG 用户版）→ fresh clone 终验；**不再 orphan 重写历史**，tag v3.1.0 保留作历史锚 |
| 8 | **v3.3.0 上 npm**（包名去 @local scope） | ✅ 已完成（10-22 11:38 CST，registry 实证 dist-tags.latest=3.3.0，账号 end1949） | 宿主「插件管理器」支持 npm 包名 / Git 仓库 / 本地目录三种来源，`dsh plugin --profile desktop add <pkg>` 本质转发 pnpm ⟹ 发 npm 是生态标准装法。改动：name `@local/dsh-reply-forge-v3` → `dsh-reply-forge-v3`、删 `private`、加 `files` 白名单（`.dsh-plugin/index.mjs` + `client.js` + `server/` + `src/` + `cordis.patch.yml`，**必须含 src/ 因为 server/* 直接 import ../../src/*`）、`keywords`、`publishConfig.access=public`。包体积 69 文件/1.63 MB → **16 文件/86.3 KB**。install.mjs 加旧身份迁移（junction/dependencies/bundles/lockfile 四处清理，新增 `removeLockEntry` 认三种 key 写法）+ 反方向保护（node_modules 里是真实目录即 npm 装 → realpath 比对后不覆盖成 link）。本机已迁移完成（v1/v2 原样保留） |
| 9 | **v3→v4 迁移改名修复**（双类型接受，防静默失假） | ✅ 已实施（10-23，分支 `fix/patch-event-plugin-namespace`，随 v3.4.1 发行） | 宿主 0.2.1-rc.2 的 v3→v4 迁移把未知 ignorable 事件改名 `plugin:<type>`，`reply-forge/patch` → `plugin:reply-forge/patch`，投影/血统/投影基准静默失配。已修：读侧双类型（`PATCH_EVENT_TYPES` + `isPatchEventType`，`projectedTextsOf`/`versionStackOf` 接受两种）、投影双注册（`project` 共享）、`OWN_EVENT_TYPES` 纳入两者；写侧不变；`poisonLines` 通用判定不用改。测试 378/16 全绿，含真宿主迁移回环 5 项 |
| 10 | **① 升级自检**（verify-host） | ✅ 已实施（10-23，分支 `feat/verify-host`，PR #16 已合并，merge commit `d6570e6`，分支已删，随 v3.4.1 发行） | `scripts/verify-host.mjs`：T0 版本基线比对（`host-baseline.json`：宿主三元组 + 8 包 + 契约期望值）/ T1 契约面十项 + 强制跑 4 个宿主门控套件（缺宿主=FAIL）/ T2 boot 冒烟（host-oracle 配方）/ T3 活体 CDP（委托 diag-focus）。`--extract` 从裸 asar（asar+unpacked 叠加）提取、`--json` 机器可读。「DSH 升级后必跑」写进 使用说明.md 第七节 + 安装插件.bat 末尾提示（npm 包装法不含 scripts/，该提示面向 zip 源码树） |
| BUG-6 | 长回复点「伪造回复」内容不全；从目标下拉切回该消息后写入「不生效」 | ✅ 已修复（10-23，分支 `fix/long-message-fragment`，随 v3.4.1 发布） | 根因两条：① `ownText` 只遍历 `children`（元素子节点），混合段落 `<p>正文<strong>粗</strong>正文</p>` 的直属文本整段丢失 → 编辑器只剩加粗片段与标题；② 记录是 markdown 源码、页面是渲染结果，字符串直接比永远不等 → 精确定位失效、退化成顺序推断 → 写入打到别的块。修复：`ownText` 按文档顺序遍历含文本节点（块级边界补空格、行内不补）；`matchBlocks` 加 `canonical` 选项，用插件渲染器把源码渲染后再比（源码形态同时入索引，思维链不被误伤）；精确命中时编辑器初值取记录原文（防保存把格式拍平）；下拉「选回自己这条」不再算外来目标（本机渲染照常跟随）。回归 +9（client +5 / record +4），**404 项 / 17 套全绿** |
| 11 | **③ 就地回溯**（rewind） | 🚫 已评估放弃（10-23 用户评审） | 机制已打通（system/message + surfaceOp:replace + 空 content，PLAN §9.3 留档），但被宿主 `SessionStore.fork(source, boundary)` **严格支配**：同模型效果、fork 有显式分支血缘（parentSession/inheritedEventCount）、双向第一等会话 vs 回溯单向不可逆、forked closers 处理未收尾轮次、零新写杠杆。残余选项另议：逐消息「从这里分支」快捷键（调宿主 fork，非新机制），先确认宿主界面是否已有按消息边界 fork 再定 |

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
8. 数测试项数要逐文件跑（自建 test() 收集器，`node --test` 只按文件计 17 项）。
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
