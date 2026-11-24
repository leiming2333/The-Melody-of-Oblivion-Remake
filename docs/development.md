# 开发指南

本文面向第一次修改启动器或官网的贡献者。提交方式见 [贡献指南](../CONTRIBUTING.md)，按功能选择验收场景见 [开发与回归用例](development-cases.md)。

## 准备环境

源码开发支持 Node.js `>=24 <27`、npm `11.x`；推荐版本为 Node.js `26.10.0`、npm `11.13.0`，分别记录在 [.node-version](../.node-version)、[.nvmrc](../.nvmrc) 和 [package.json](../package.json) 中。Vercel 网站运行在 Node.js `24.x`。正式打包和 CI 仍由[工具链检查](../scripts/toolchain.cjs)固定使用推荐版本，保证发布输入可追溯。

先安装兼容的 Node.js，再确认 npm 版本。使用 nvm 的贡献者可运行 `nvm install` / `nvm use` 选择推荐版本；需要正式打包时，运行 `npm install --global npm@11.13.0` 安装对应 npm。

```powershell
node --version
npm --version
git clone https://github.com/leiming2333/The-Melody-of-Oblivion-Remake.git
cd The-Melody-of-Oblivion-Remake
npm ci
npm run verify:dev-toolchain
npm run check
npm test
```

准备提交 PR 时，请从自己的 fork 克隆，具体命令见贡献指南。使用 `npm ci` 保持锁文件不变；只有明确修改依赖时才更新 `package.json` 与 `package-lock.json`。

查看界面可运行 `npm run dev`，修改后重启应用。该命令没有热更新服务。首次下载 Electron、安装游戏与托管 Java 都需要网络；运行自动化测试不要求登录真实账户，涉及网络的测试应使用替身或本地 HTTP 服务。

**数据位置需要区分：**普通开发启动会使用 Electron 的用户数据目录，可能与同一系统账户下的日常启动器共用账户和设置；源码目录独立不等于账户隔离。本地游戏目录模式使用源码目录下的 `.minecraft`，系统模式使用系统默认 Minecraft 目录。需要改动账户、安装、删除或切换目录时，请使用独立系统测试账户或虚拟机，具体前提见回归用例。

## 从哪里开始改

| 内容 | 入口与职责 |
| --- | --- |
| Electron 生命周期、窗口、服务装配 | `src/main/main.js`、`src/main/lazy-services.js` |
| 账户和凭据 | `src/main/accounts/`，独立进程负责认证、持久化与公开字段过滤，主进程提供系统凭据加解密 |
| 下载、Java、加载器、启动、整合包 | `src/main/minecraft/`，`ipc.js` 连接界面与目录内的服务 |
| 设置 | `src/main/settings/` |
| 启动器更新 | `src/main/updater/` |
| 主进程与界面的桥接 | `src/preload/preload.js`，通过 `window.launcherEnvironment` 暴露具体方法 |
| 启动器界面 | `src/renderer/index.html`、`renderer.js`、`styles.css` 与 `modules/` |
| 共享错误协议 | `src/shared/task-errors.js` |
| 官网与下载 API | 根目录 `index.html`、`site.js`、`styles.css`、`website-*.mjs` 与 `api/` |
| Cloudflare 下载网关 | `cloudflare/`，配置见 [网关说明](../cloudflare/README.md) |
| 测试与构建 | `test/`、`scripts/` 与 `.github/` |

主进程大多使用 CommonJS；官网模块与部分界面模块使用 `.mjs`。遵循附近文件的写法和 [.editorconfig](../.editorconfig)，不在功能修改中批量重排无关代码。官网和启动器界面是两套入口，修改其中一处后要检查实际目标是否正确。

后台进程、界面边界及共享文件互斥见 [启动器模块隔离](module-isolation.md)。新增业务模块应沿用独立后台入口和明确的 RPC 依赖。

## 常见开发任务

### 修复下载失败或取消行为

1. 从 `src/main/minecraft/downloader.js`、`source-manager.js` 或对应加载器服务定位行为；启动器自身更新使用 `src/main/updater/`，官网分段下载使用根目录 `website-downloader.mjs`。
2. 在已有测试文件中构造失败源、取消信号、错误摘要或不支持 Range 的响应，断言用户可见结果、回退与临时文件清理。使用本地 HTTP 服务或注入替身，不把外部站点的实时可用性写成通过条件。
3. 先运行与修改对应的测试，再运行完整检查。例如修改游戏源选择时：

```powershell
node --test test/source-selection.test.js
node --test --test-name-pattern="one failed speed probe" test/source-selection.test.js
```

可参考 [现有源选择用例](../test/source-selection.test.js) 和 [更新下载用例](../test/update-downloader.test.js)。修复应证明失败分支可恢复，而不只断言调用了某个内部函数。

### 增加一个界面操作或 IPC 方法

1. 在领域服务中实现文件、网络或账户操作，在对应的主进程 IPC 模块检查参数、路径和任务归属。
2. 在 `src/preload/preload.js` 暴露明确的方法，不向界面开放任意 IPC 通道、Node.js 或文件系统访问。
3. 在 `src/renderer/` 调用桥接方法，并处理等待、成功、错误及取消状态。进度订阅沿用返回取消订阅函数的约定，避免重复绑定。
4. 对带有错误码、重试或取消信息的任务，沿用 `src/shared/task-errors.js` 的错误传递协议，避免信息在 IPC 边界丢失。
5. 以主进程 IPC 测试和界面状态测试覆盖边界，再实际打开界面检查布局。例如：

```powershell
node --test test/account-ipc.test.js test/task-ipc.test.js
node --test test/renderer.test.js test/renderer-modules.test.js test/task-ui.test.js
```

可参考 [账户 IPC 测试](../test/account-ipc.test.js) 如何记录桥接调用并确认令牌不进入公开对象。测试里的凭据必须是虚构值。

### 修改官网文案、布局或下载入口

同时检查 `site.js` 的中英文文案和窄屏布局。静态页面预览不能替代 `api/` 与下载验证网关的联调；Turnstile、签名和对象存储配置见 [Cloudflare 说明](../cloudflare/README.md)，测试与文案修改无需填写生产密钥。

```powershell
node --test test/website-*.test.js test/site-download.test.js
```

如果修改下载行为，额外选择 [开发与回归用例](development-cases.md) 中的官网场景，核对取消、校验失败和公开下载入口。新增配置应说明用途与本地准备方法，机密值不写入代码、截图或日志。

## 检查与构建

| 命令 | 用途与边界 |
| --- | --- |
| `npm run check` | ESLint 语法及正确性规则检查 |
| `npm run lint` | 当前与 `check` 覆盖相同 JavaScript 范围及规则 |
| `npm test` | Node.js 自动化测试；不代表真实登录、安装和游戏启动均已通过 |
| `npm run smoke` | 临时用户数据下加载 Electron、生成启动报告并退出；不提供持续交互窗口 |
| `npm run build:targets` | 查看统一构建目标定义 |
| `npm run build -- --target windows-x64` | 构建单个目标，产物位于 `release/build/windows-x64/`，不公开发布 |

`npm run smoke` 需要已下载的 Electron 和图形环境；Linux 无显示服务时可在安装 Xvfb 后运行 `xvfb-run -a npm run smoke`。构建优先使用目标平台的环境，不能把其他平台上的打包成功当作目标平台运行成功。不要直接调用 electron-builder 绕过项目构建入口。

测试一般使用 `node:test` 和 `node:assert/strict`，可参考现有用例用 `fs.mkdtemp` 创建独立数据并在 `t.after` 清理。新增测试应覆盖实际行为变化；纯文案修改无需添加镜像实现的测试。提交前运行 `npm run check`、`npm test`，并在 PR 中说明手动场景及未验证的平台；只改文档时可以说明未运行应用测试的原因。

## PR 如何被接收

PR 目标为 `main`。仓库现有流程已经支持 fork PR：

- [Quick checks](../.github/workflows/check.yml) 对 PR 运行源码检查、完整测试和 Node.js 24 网站兼容测试。
- [Native package smoke](../.github/workflows/package-smoke.yml) 仅在 PR 触及源码、构建脚本、依赖或工作流等指定路径时，执行七类原生打包和启动／升级检查。纯文档 PR 不触发此矩阵。
- 以上 PR 工作流只授予 `contents: read`，不需要贡献者提供发布密钥。首次外部贡献的工作流可能需要维护者在 GitHub 上批准运行，取决于仓库设置。

[CODEOWNERS](../.github/CODEOWNERS) 指定维护者，在文件进入默认分支后，为适用的非草稿 PR 自动请求评审。它本身不强制审批；如需强制检查和审批，由维护者在 GitHub 分支保护或规则集中配置。模板、贡献入口也需提交到默认分支后，才会出现在 GitHub 新建 Issue／PR 的界面中。

当前发布工作流由版本标签或手动运行触发；PR 流程不会公开发布安装包。详细发布门槛、八个构建目标和 Linux ARMv7 的验收限制见 [持续检查与发布验证](ci-release-validation.md)。
