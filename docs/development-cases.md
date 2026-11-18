# 开发与回归用例

本文是开发者可重复执行的验收清单，不是已经完成的测试报告。提交 PR 时按改动选择相关用例，记录实际结果；没有条件执行的场景写明原因。自动化测试使用模拟服务、临时文件或本地 HTTP 服务，不能代替真实平台、账户与网络验收。

环境安装与常用命令见 [开发指南](development.md)，提交流程见 [贡献指南](../CONTRIBUTING.md)。

## 准备测试环境

- 自动化测试优先使用仓库已有 fixture：以 `fs.mkdtemp()` 创建系统临时目录，通过 `t.after()` 清理，只在 fixture 内写游戏文件；网络失败、摘要错误、并发和提交边界优先用模拟响应或本地 HTTP 服务复现。
- 手工验收使用独立操作系统测试账户或虚拟机，并在独立源码目录运行 `npm ci`、`npm run dev`。普通开发启动会复用该系统账户的启动器账户和设置；仅换一个源码目录不会隔离用户数据。
- 测试时在启动设置中选择并保存「本地目录（启动器旁）」。源码运行时它指向项目根目录下的 `.minecraft`。确认界面显示的目录后再下载、导入或修改文件，不复制正式存档或账户文件。
- 目录切换用例会访问该操作系统账户的系统 Minecraft 目录，只在上述隔离账户或虚拟机中执行。结束所有游戏和下载后再清理自己创建的测试目录。
- 记录操作系统、CPU 架构、源码提交、Node/npm 版本、游戏/加载器版本和下载源。截图与诊断附件分享前检查个人信息；不要附 `accounts.json`、令牌、密码或设备授权码。

## DC-01 首次运行、账户保存与游戏退出

**前提**：干净的测试账户及本地游戏目录；安装正常启动游戏所需的 Java。若只改账户界面，可以跳过游戏下载与启动部分并注明。

**步骤**：

1. 执行 `npm run dev`，观察首页，再打开账户管理，添加名为 `DevPlayer` 的离线账户。
2. 关闭并重新启动应用，检查当前账户和设置是否保留。
3. 安装一个原版游戏版本，选中该离线账户并启动游戏，进入主菜单后正常退出。

**预期**：首页和账户界面可操作；离线账户保存并在重启后恢复；游戏真正启动后启动器隐藏，最后一个游戏退出后启动器重新显示，按钮状态恢复。

**自动化对应**：[account-store.test.js](../test/account-store.test.js)、[account-ipc.test.js](../test/account-ipc.test.js)、[launch-core.test.js](../test/launch-core.test.js)、[game-directory-lifecycle.test.js](../test/game-directory-lifecycle.test.js)。

## DC-02 下载完成、关闭弹窗、取消与重试

**前提**：本地目录中没有目标版本，网络可访问版本清单与游戏文件。

**步骤**：

1. 从版本管理下载一个原版游戏版本；开始接收数据后关闭任务弹窗，再从首页打开该任务。
2. 在下载过程中点击「取消下载」，等待清理结束。
3. 重新安装同一个版本并等待完成，关闭再打开版本列表。
4. 在测试虚拟机中断开网络，尝试下载另一个未安装版本；出现错误后恢复网络并使用重试入口。

**预期**：关闭弹窗后任务继续且重新打开可看到进度；取消后不会把不完整版本标记为已安装，界面允许再次操作；重新安装仅在所需文件检查通过后显示完成；断网错误可理解，重试可以继续流程。取消与暂存清理不应破坏其他已安装版本。

**自动化对应**：[minecraft-core.test.js](../test/minecraft-core.test.js) 覆盖 Range、摘要校验、取消、源回退与完整安装标记；[download-replacement.test.js](../test/download-replacement.test.js) 覆盖替换失败保留旧文件；[task-ipc.test.js](../test/task-ipc.test.js) 覆盖任务身份与取消归属。

## DC-03 Java 缺失、手动路径错误与修复

**前提**：选择一个已下载的游戏版本；测试虚拟机中缺少该版本所需的 Java 主版本。不要为了制造条件卸载日常使用的 Java。

**步骤**：

1. 在启动设置的 Java 运行环境中选择「自动查找系统 Java」并保存，执行「重新检测 Java 环境」，观察首页启动按钮提示。
2. 点击启动，检查缺少 Java 时的问题对话框；点击「下载 Java … 并启动」，下载过程中取消一次，再重新尝试并等待游戏启动。
3. 退出游戏，点击 Java 路径旁的「选择」，在文件选择器中选取自己创建的无效测试文件（Windows 可用空的 `invalid-java.exe`），观察错误提示；关闭提示并检查原有 Java 选择。

**预期**：提示的 Java 主版本与游戏需求一致；下载可取消且不把半成品当成可用运行时；修复成功后自动重试原游戏。选择无效文件时提示选择有效的 Java 可执行文件，不保存无效路径或覆盖原有选择。

**自动化对应**：[java-selection.test.js](../test/java-selection.test.js)、[java-runtime.test.js](../test/java-runtime.test.js)、[java-acceptance.test.js](../test/java-acceptance.test.js)、[java-probe-cache.test.js](../test/java-probe-cache.test.js)。

## DC-04 加载器安装与 Fabric API 选择

**前提**：使用官方元数据中确实存在的游戏/加载器组合；Forge、NeoForge 安装需要兼容的 Java。

**步骤**：

1. 新装 Fabric，在确认框中选择兼容的 Fabric API 并完成安装，检查目标配置的 `mods` 目录。
2. 使用另一个干净测试目录，重复安装并跳过 Fabric API。
3. 若修改了 Forge、NeoForge 或 Quilt 安装逻辑，再实际安装对应加载器；若修改了 Forge/NeoForge 依赖下载，在依赖下载期间取消一次，再重新安装。

**预期**：选择 API 时只安装与当前游戏兼容且摘要通过的文件；跳过时不会自动加入 API。加载器安装完成后才显示成功；取消后不继续执行安装器处理器。官方没有发布的组合不应被当成兼容目标。

**自动化对应**：[fabric-api-manager.test.js](../test/fabric-api-manager.test.js)、[fabric-api-ui.test.js](../test/fabric-api-ui.test.js)、[loader-manager.test.js](../test/loader-manager.test.js)、[quilt.test.js](../test/quilt.test.js)、[installer-archive.test.js](../test/installer-archive.test.js)。

## DC-05 整合包补齐、错误文件与重启恢复

**前提**：准备可信来源的 CurseForge 整合包，其中至少一个必需文件限制自动下载，且可从官方页面取得有可信摘要的原文件。记录整合包与文件版本；条件不具备时执行对应自动化测试并注明未做真实导入。

**步骤**：

1. 导入整合包，在确认框检查游戏、加载器和文件数，保持可选文件默认不安装。
2. 等待进入缺失文件列表；打开文件选择器后取消，确认还能继续补齐。
3. 选择一个自己创建的错误测试文件，检查拒绝原因，保持等待补齐状态。
4. 关闭应用，将原整合包移动到另一个测试位置，再重新启动应用。
5. 从官方页面获取并选择正确文件，补齐全部文件后继续安装，检查实例列表；安装完成后再重启一次。

**预期**：取消文件选择不会误报导入成功；错误内容被摘要检查拒绝，文件名相同也不能绕过校验。等待状态在重启后恢复，已保存的归档副本允许原包移动后继续；完成前不展示半成品实例，完成后恢复面板消失且实例可选择。磁盘或权限错误应中止安装，不作为「可选文件下载失败」跳过。

**自动化对应**：[modpack-recovery.test.js](../test/modpack-recovery.test.js)、[modpack-manager.test.js](../test/modpack-manager.test.js)、[task-ui.test.js](../test/task-ui.test.js)。

## DC-06 游戏目录切换与隔离

**前提**：独立操作系统测试账户或虚拟机；本地和系统目录均为测试数据，分别准备不同的已安装版本。

**步骤**：

1. 在本地目录选择一个版本，切换到系统目录并保存，重新打开版本列表。
2. 在系统目录下载一个测试版本，确认它的落盘位置，再切回本地目录。
3. 若有 DC-05 的待补齐会话，在本地目录等待补齐时切到系统目录，再切回原目录并重新检查恢复入口。

**预期**：列表、当前选择、Java 就绪状态和下载服务随保存后的目录刷新，不显示旧目录的安装状态；系统目录下载不会写入本地目录。缺失文件操作只能属于原目录，切换后不应沿用旧按钮操作另一目录；返回原目录后可以重新取得该目录的持久恢复会话。

**自动化对应**：[game-directory.test.js](../test/game-directory.test.js)、[game-directory-lifecycle.test.js](../test/game-directory-lifecycle.test.js)、[task-ipc.test.js](../test/task-ipc.test.js)、[task-ui.test.js](../test/task-ui.test.js)。

## DC-07 账户取消、问题详情与诊断导出

**前提**：测试账户；网络正常。不需要完成 Microsoft 授权也能执行取消场景。

**步骤**：

1. 在账户管理开始 Microsoft 登录，出现设备代码后取消，等待界面恢复，再开始一次登录。
2. 用 DC-03 的无效 Java 文件选择触发问题对话框，点击「复制错误详情」并粘贴到本地文本编辑器。
3. 点击「导出诊断报告」，先取消保存，再导出到测试目录，检查生成内容。

**预期**：取消的登录不会在稍后更新当前账户，界面可再次申请授权；取消保存不留下报告。问题详情对常见凭据字段脱敏，诊断报告还对用户主目录做脱敏；报告不打包账户文件或完整游戏日志。复制的详情仍可能包含个人路径，即使程序已脱敏，也要人工检查附件再分享。

**自动化对应**：[microsoft-auth.test.js](../test/microsoft-auth.test.js)、[account-ipc.test.js](../test/account-ipc.test.js)、[secret-codec.test.js](../test/secret-codec.test.js)、[diagnostics-report.test.js](../test/diagnostics-report.test.js)、[game-log.test.js](../test/game-log.test.js)。

## 更新、网站与跨平台改动

这几类改动需要各自的环境，按实际范围补充记录：

| 改动 | 首先执行 | 进一步验收 |
| --- | --- | --- |
| 更新下载、增量补丁 | `node --test test/update-downloader.test.js test/update-manager-delta.test.js test/update-patch.test.js` | 在临时安装位置验证损坏补丁回退完整包、取消后不可安装；真实替换与恢复按 [发布验证](ci-release-validation.md) 的隔离双版本流程执行 |
| 更新事务与辅助进程 | `node --test test/update-transactions.test.js test/update-transaction-store.test.js` | 验证当前平台实际打包产物的启动、升级与健康确认，记录未覆盖的平台 |
| 网站下载与验证 | `node --test test/website-downloader.test.js test/website-download-auth.test.js test/website-download-ui.test.js test/cloudflare-download-worker.test.js` | 在配置好的测试部署检查平台选择、验证失败、下载取消与成功保存；取消不得触发文件保存，摘要错误不得交付文件。环境要求见 [下载网关说明](../cloudflare/README.md) |
| 主进程、preload 或界面 | `npm run check`、`npm test` | 启动真实 Electron 检查本次修改的交互、布局和窗口行为；自动化 DOM 模拟通过不等于真实窗口验收通过 |

## 在 PR 中记录结果

按下面格式填写实际执行的项目即可，无需把全部用例复制进 PR：

```text
环境：Windows 11 x64；Node 26.10.0 / npm 11.13.0；提交 <sha>
自动化：node --test test/loader-manager.test.js — 通过
手工：DC-04；Minecraft <版本> + Forge <版本>；BMCLAPI
结果：安装完成；依赖下载期间取消后未继续执行安装器；重试成功
未执行：macOS / Linux 实际安装（无对应测试设备）
附件：脱敏后的错误详情或界面截图（如有）
```
