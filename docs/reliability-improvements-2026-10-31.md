# 可靠性改进记录（2026-10-31）

基于 `f2c9921` / `1.8.0` 源码实施。本轮集中修复安装、认证、启动和配置持久化中的可复现问题；没有升级 Electron 主版本，没有发布安装包。

## 已实施的优先修复

| 优先级 | 问题与改动 | 主要代码 |
| --- | --- | --- |
| 1 | Forge / NeoForge 安装器和缓存执行前，取得官方 Maven 摘要并校验；拿不到可信摘要时停止 | `src/main/minecraft/installer-support.js`、`loader-manager.js` |
| 2 | 全新游戏目录缺少官方启动器配置时，安全创建最小 `launcher_profiles.json`；保留已有配置 | `installer-support.js` |
| 3 | 启动前验证继承链、客户端、库、native、日志和资源；提供补全后重新启动，保留存档和 Mod | `downloader.js`、`launch-core.js`、`minecraft/ipc.js` |
| 4 | 版本 JSON、资源索引按下载原始字节核对摘要和大小，检查数据结构；单个坏版本不再阻断列表；阻止日志配置 ID 通过路径穿越覆盖 Mod | `metadata-schema.js`、`source-manager.js`、`version-manager.js` |
| 5 | 账户 / 设置原子保存，保留有效备份、隔离损坏原件；无有效备份时阻止覆盖并给出恢复位置 | `recoverable-json-store.js`、`accounts/account-store.js`、`settings/settings-store.js` |
| 6 | Windows 超长参数按 Java 版本处理，Java 9+ 保留原始类路径且按本地编码写入；令牌不进入参数文件 | `java-launch-arguments.js`、`java-runtime.js` |
| 7 | 检查 Java 主版本、架构、位数；按架构隔离托管运行时，修正 x86 / ARM32 供应商查询；32 位堆限制 1536 MiB | `managed-java-runtime.js`、`launch-core.js` |
| 8 | 游戏进程登记跨目录保留，准备阶段防止重复启动；Mod / 删除保护按目录判定，启动请求绑定原目录 | `game-process-registry.js`、`minecraft/ipc.js`、`renderer.js` |
| 9 | 允许合法中文 / 空格版本名；统一平台规则；旧参数解析保留反斜杠；修正 NeoForge 1.20.1 历史 Maven 坐标 | `profile-id.js`、`platform-rules.js`、`launch-core.js`、`loader-manager.js` |
| 10 | LittleSkin 皮肤请求失败不抹去登录，网络错误与授权失效分开；安装器日志 / 超时 / 取消可诊断，问题对话框支持报告导出 | `yggdrasil-auth.js`、`java-runtime.js`、`diagnostics-report.js` |

另外修复不支持硬链接的文件系统上的 Mod 启用 / 禁用；清理未使用的 LittleSkin 会话接口，抽取共享模块，加入 ESLint 正确性检查，统一内部版本号与文档中的 Microsoft 登录说明。保留现有微软设备代码登录流程。

## 使用和恢复

- 版本列表中的「待验证或修复」不等于无法启动。可选中版本启动，启动前会完整验证；文件缺失时选择「补全文件并启动」。
- 补全依赖本地有效的版本 JSON 与其中的下载地址。版本 JSON 已损坏，或自定义组件缺少下载信息时，会提示重新安装对应版本，不猜测并覆盖配置。
- `.bak` 保存上一次有效配置；`.corrupt-摘要` 保留损坏原件。恢复后请核对账户和设置。无有效备份时，界面会给出文件位置供手动恢复。
- 安装器和游戏日志位于游戏目录 `launcher-cache/game-logs`；主进程错误与启动阶段记录位于用户数据目录 `logs`。问题对话框可导出 JSON 报告，报告不包含账户文件或完整游戏日志。
- Java 9+ 在部分 Windows 系统上仍以 GBK 等本地编码读取参数文件。超长参数中的路径若无法无损表示，会明确报错；更换为当前系统能表示的目录后重试。普通长度参数继续使用原生参数传递。
- Electron 43 不支持 Windows 7 / 8 / 8.1。发布目标有安装包不代表任意 Minecraft / Java / Mod 组合均兼容；缺少对应架构的 Java 发行包时需手动安装。

## 验证

回归测试覆盖摘要错误和备用源、同大小损坏文件、资源索引缺失、继承版本修复、中文 / 空格路径、配置损坏恢复、账户令牌并发更新、目录切换、准备阶段保护、安装器生命周期，以及补全与诊断导出的界面行为。测试使用临时目录和受控账户数据，不访问真实账户存储或游戏存档。

本机 Windows GBK 环境已用真实 Java 8、17、21、25 运行小型 Java 探针；每组 8 项参数测试全部通过。覆盖中文 / 空格 JAR 路径、超长类路径、中文系统属性及游戏参数、原始 `java.class.path`、令牌只走原生参数。Java 8 JRE 从 Azul 官方元数据取得，下载后独立核对 SHA-256 再解压到临时目录；没有安装到用户游戏目录。

可在本机通过以下方式重复原生参数验收；常规 `npm test` 默认跳过此依赖本机 JDK 的验收项：

```powershell
$env:MELODY_JAVA_TEST_HOME = 'C:\Program Files\Java\jdk-17'
# 可选：指定真实 Java 8 JRE，验证 Java 8 manifest-JAR 分支
# $env:MELODY_JAVA8_TEST_HOME = 'C:\path\to\verified-java8-jre'
node --test --test-isolation=none test/java-launch-arguments.test.js
```

Electron 使用临时用户数据运行 `npm run smoke`，返回 `SMOKE_TEST_OK`；验收检查窗口、渲染模块、预加载接口和新增的补全 / 诊断入口。没有进行真实 Microsoft 账户交互登录或完整 Minecraft / 加载器的进游戏验收，也未在其他操作系统和不同架构的实体设备运行本轮代码。

最终检查结果：

| 检查 | 结果 |
| --- | --- |
| `npm test` | 521 项：519 通过、2 跳过、0 失败 |
| `npm run check` | 132 个 JavaScript 文件语法及 ESLint 检查通过 |
| `npm run smoke` | `SMOKE_TEST_OK` |
| 真实 Java 8 / 17 / 21 / 25 参数验收 | 每组 8 项全部通过 |
| `git diff --check` | 通过 |

两项常规测试跳过分别是 Windows 下不适用的 Unix Java 符号链接测试，以及需要显式配置本机 JDK 的原生 Java 参数验收；后者已另外按上述命令实际执行并通过。

## 后续三阶段路线

1. **先稳定**：本轮完成可验证的核心修复。发布前补真实 Microsoft 账户刷新、原版 1.12.2 / 1.16.5 / 1.20.1 / 1.21.x、Forge / Fabric / NeoForge 的安装和进游戏验收，并在 Windows 10 / 11 的中文 / 空格路径测试；覆盖镜像中断、磁盘空间不足及取消后重试。
2. **再重构**：本轮已抽取配置存储、平台规则、元数据校验、参数处理和进程登记。下一步将 renderer 中的启动 / 账户 / 设置状态迁到独立模块，用明确的启动阶段与依赖接口替代对 DOM 和全局状态的直接依赖，保持已有回归测试。
3. **后体验**：本轮已加入文件补全、配置恢复通知和诊断报告。下一步完善下载 / 验证阶段的进度与取消交互，对大型资源集合做经过测量的验证缓存，并增加报告预览和按错误类别给出更具体的操作入口。
