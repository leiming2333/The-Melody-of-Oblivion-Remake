# 持续检查与发布验证

- `check.yml` 在普通分支提交、PR 和手动触发时运行语法检查和单元测试，不下载 Electron 二进制，也不打包。
- `package-smoke.yml` 保留 PR 和手动触发的原生打包启动检查。
- `build.yml` 完成所有构建后调用 `release-smoke.yml`，下载本次构建的最终 `dist-*` 产物，启动 Windows 便携 EXE、从 Linux AppImage 解出的 `AppRun`、以及从 macOS ZIP 解出的应用。发布任务必须等待构建和启动检查全部成功。

发布启动检查覆盖 Windows x64、ia32、ARM64，Linux x64、ARM64，以及 macOS x64、ARM64。Windows ia32 在 x64 runner 上运行，报告仍必须声明 ia32。Linux ARMv7 (`armv7l`) 没有可用的 GitHub 原生 runner；目前仅构建和运行源代码测试，尚未验证该安装包的实际启动，需要在 ARMv7 设备上补充验证。

启动检查调用打包应用的 `--smoke-test`，要求成功退出且生成与平台、目标架构相符的打包应用报告；零退出码而没有报告也会失败。它检查窗口、preload、renderer 与延迟加载模块，不覆盖真实账户登录、游戏下载或 Java 游戏启动。
