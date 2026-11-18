# 参与贡献

欢迎提交错误修复、功能改进、测试和文档。可以直接提交小范围修复；涉及界面流程、数据格式或较大功能时，建议先开 Issue 说明使用场景和方案。

English contributions are welcome. Fork the repository, create a branch from `main`, and open a pull request against `main`. Describe the problem, the change, and how you verified it. See the [development guide](docs/development.md) and [development cases](docs/development-cases.md) for setup and validation examples (in Chinese).

## 开始开发

- [开发指南](docs/development.md)：环境准备、目录结构、常用命令和测试方式。
- [开发与验收用例](docs/development-cases.md)：按改动范围选择自动化测试和人工验收场景。
- [持续检查与发布验证](docs/ci-release-validation.md)：现有 CI、打包验证和发布门槛。

启动器开发与构建使用 Node.js `26.10.0` 和 npm `11.13.0`。首次准备环境后运行：

```sh
npm ci
npm run verify:toolchain
npm run dev
```

测试时使用独立的游戏目录，并先备份需要保留的数据。普通 `npm run dev` 仍会使用当前系统用户的启动器账号和设置；完整隔离的人工测试可使用独立系统用户或虚拟机，详见开发指南。真实账号登录、游戏下载、游戏启动和安装包升级需要按场景另外验证，不能只凭单元测试判断通过。

## 提交 Issue

使用 [错误报告](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/issues/new?template=bug_report.yml) 或 [功能建议](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/issues/new?template=feature_request.yml) 表单。报告错误时附上版本、系统与架构、复现步骤、预期和实际结果；涉及 Minecraft 或加载器时也注明其版本。

日志和截图分享前，请删除令牌、设备代码、邮箱、用户名、私人路径及服务器地址等敏感内容。不要上传账号数据文件、完整用户目录或未获授权的整合包。

安全漏洞请优先使用仓库的 [私密漏洞报告入口](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/security/advisories/new)。该入口需要维护者在 GitHub 启用；如果不可用，可以开普通 Issue 仅请求提供私密报告方式，暂不公开漏洞细节或利用代码。

## 提交 Pull Request

1. Fork 仓库，从最新的 `main` 创建自己的分支，例如 `fix/download-retry`。
2. 围绕一个问题修改。遵循附近代码的风格；代码行为有变化时，补充能复现原问题或验证新行为的测试。
3. 按改动运行检查，并在 PR 中写清结果：

   ```sh
   npm run check
   npm test
   ```

   可用 `node --test test/具体文件.test.js` 先跑相关测试。界面改动附截图或录屏；涉及本机环境、联网或打包的验证，按[开发与验收用例](docs/development-cases.md)补充结果。纯文档改动可以说明只检查了内容、链接与格式，不必声称运行过代码测试。

4. 提交到自己的 Fork，在本仓库创建以 `main` 为目标的 PR，并填写自动带出的模板。尚未完成的工作可以先开 Draft PR。
5. 根据审核意见更新分支；CI 失败时先查看日志。没有条件完成的验证请明确列出系统、失败现象或缺少的环境。

PR 无需自行修改版本号、创建发布标签或上传安装包。依赖变更请同步提交 `package-lock.json`，并说明原因。提交前检查 diff，避免带入 `node_modules`、构建产物、日志、密钥和个人 Minecraft 数据。

`Quick checks` 会检查 PR；涉及启动器、构建脚本等路径时还会触发 `Native package smoke`。Fork 的首次运行可能需要维护者在 GitHub 批准。检查通过后仍需维护者审核，发布由现有发布流程处理。

## 许可证

项目采用 [GPL-3.0-only](LICENSE)。提交贡献表示你有权提交这些内容，并同意贡献按项目许可证分发。引用第三方代码或素材时，请保留来源和许可信息，并确认其许可与项目兼容。
