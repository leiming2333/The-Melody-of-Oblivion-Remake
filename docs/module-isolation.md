# 启动器模块隔离

业务模块通过 `ModuleProcess` 在独立 Node 子进程中执行。进程按需启动并保留自身状态；界面通过 preload 的既有接口调用，Electron 主进程负责装配、窗口和系统能力。

## 模块边界

| 模块 | 后台入口 | 状态与职责 |
| --- | --- | --- |
| 设置 | `worker-modules/settings.js` | 设置读写、备份与损坏恢复 |
| 账户 | `worker-modules/accounts.js` | 账户读写、公开字段过滤与写入队列 |
| Microsoft / LittleSkin 登录 | `worker-modules/account-auth.js`，每个服务单独进程 | 各自的认证会话与网络请求 |
| 皮肤 | `worker-modules/account-skins.js` | 在线皮肤同步，远程请求不占用账户写入队列 |
| 启动器更新 | `worker-modules/updater.js` | 元数据、下载、校验、历史与恢复状态 |
| 诊断 | `worker-modules/diagnostics.js` | 错误日志、诊断报告组装与保存 |
| 游戏下载 | `worker-modules/minecraft-download.js` | 版本目录、文件验证、下载与修复 |
| 加载器目录 | `worker-modules/minecraft-loaders.js` | Forge、NeoForge、Fabric、Quilt 列表与版本校验 |
| 加载器安装 | `minecraft/loader-install-worker.js` | 每次安装独立进程，包含基础游戏文件准备与 Java 安装器 |
| Java | `worker-modules/minecraft-java.js` | 探测、兼容性检查和托管运行时；设置页另有独立进程 |
| 本地版本 | `worker-modules/minecraft-versions.js` | 扫描、元数据、版本删除与实例路径 |
| Mods | `worker-modules/minecraft-mods.js` | 列表、导入、启用与禁用 |
| 整合包 | `worker-modules/minecraft-modpacks.js` | 解析、安装、缺失文件会话与恢复 |
| Fabric API | `worker-modules/minecraft-fabric-api.js` | 列表、解析与安装；无需目录的查询另有进程 |
| authlib-injector | `worker-modules/minecraft-authlib.js` | 第三方登录组件准备 |
| 游戏启动准备 | `worker-modules/minecraft-launch-preparation.js` | 元数据合并、原生库解压与启动参数准备 |
| 游戏日志 | `worker-modules/game-log.js`，每个游戏独立进程 | 脱敏、完整行缓存、限长与落盘 |

主进程保留 `safeStorage`、系统对话框、回收站、窗口显示与隐藏、真实游戏进程的生命周期。更新安装辅助进程也由主进程启动，并以主进程 PID 等待交接，避免被更新模块的进程清理误杀。

## 故障、取消与退出

- 通用协议在 `src/main/module-process.js` 与 `module-worker.js`。调用携带独立请求编号、取消信号、进度和结构化错误；工作进程只调用明确列出的主进程服务。
- 一个模块崩溃时，拒绝该模块的未完成调用。下次调用重新启动该模块，其他模块继续运行。已经结束的认证会话等临时状态需要重新建立。
- 取消首先通知对应请求；超过宽限期仍未退出时，停止该模块及已报告的子进程。强制停止可能结束同一模块内的其他请求。
- Forge 安装始终等到工作进程关闭并清理 Java 子进程后，才释放安装任务；应用退出也等待专用安装进程和通用模块清理。
- 游戏日志限制待发送数据和内存中的日志尾部，批量传送输出。日志模块崩溃后保留原日志路径并报告错误，游戏及其他游戏日志继续运行。

## 界面和启动

`module-controller.js` 管理功能自身的错误、重试和请求取消。`download-ui.js` 管理下载显示，`version-catalog-ui.js` 管理本地版本、目录和加载器列表；账户、整合包、更新和 Fabric API 使用各自的按需界面模块。

启动准备只等待核心静态资源。可选模块损坏通过 `moduleErrors` 返回；设置、账户、Java、版本扫描和更新确认在主页解除交互限制后分别加载。设置模块无响应时，依赖设置的操作可以继续等待，账户等无关功能仍可使用。配置初始化和目录创建由使用它们的业务模块按需完成。

版本目录和本地扫描分别维护请求标识，目录切换后丢弃旧请求结果。下载任务的进度和取消入口保留在主页，避免关闭功能面板后找不到后台任务。

## 必要的共享数据约束

进程隔离不取消共享文件的保护。游戏安装、修复、整合包及 Fabric API 安装仍共用安装组互斥，因为它们可能写入相同的库、资源和版本文件。Java 下载和整合包检查属于另外的任务组，目录浏览也不占安装锁。

活动下载期间仍保留切换游戏目录的既有保护。旧目录的游戏继续由主进程统一跟踪；各目录的 Java 探测缓存使用规范化目录的稳定哈希命名，避免并发写入相同 `.part` 文件。

新模块应通过明确的 RPC 连接依赖，传递每次操作的设置快照、信号和进度，避免业务代码退回主进程执行。测试可显式注入内联服务；生产路径始终使用后台模块。

## 验证入口

进程协议、崩溃恢复和取消见 `test/module-process.test.js`；真实后台集成见 `test/background-*.test.js`、`test/minecraft-background-services.test.js` 和 `test/loader-install-process.test.js`；启动与界面边界见 `test/startup-preparation.test.js`、`test/ui-module-boundaries.test.js` 和 `test/renderer.test.js`。

运行 `npm run check`、`node --test --test-concurrency=4 test/*.test.js`、`npm run smoke`。源码冒烟及打包验收都会实际启动通用模块进程和加载器工作进程，覆盖 `app.asar` 内的入口路径；这些检查不替代真实 Forge 安装验收。
