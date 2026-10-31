# 持续检查与发布验证

## 固定输入与构建入口

开发、CI 和发布固定使用 Node.js `26.10.0`、npm `11.13.0`、Electron `43.4.1`、electron-builder `26.15.3`。直接依赖固定版本，`package-lock.json` 保存已有解析版本、registry 来源和完整性信息。使用 `npm ci` 安装，`npm run verify:toolchain` 检查工具链。这里的可重复构建指固定环境与可追溯产物，不要求两次输出的字节完全一致。

`scripts/release-targets.cjs` 是构建矩阵和预期文件名的唯一来源。`npm run build -- --target windows-x64` 等命令先验证工具链，再清空该目标自己的输出目录；所有构建显式禁用 electron-builder 发布。正式包位于 `release/build/<目标>/`。不要直接调用 electron-builder 绕过检查。

| 目标 | 固定 runner 标签 | 产物 | 原生启动与升级门槛 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | portable EXE | 必须通过 |
| Windows ia32 | `windows-2022` | portable EXE | 必须通过，在 x64 系统运行 ia32 程序 |
| Windows arm64 | `windows-11-arm` | portable EXE | 必须通过 |
| Linux x64 | `ubuntu-24.04` | AppImage | 必须通过 |
| Linux arm64 | `ubuntu-24.04-arm` | AppImage | 必须通过 |
| Linux armv7l | `ubuntu-24.04`，交叉构建 | AppImage | 尚无运行时验收，不将构建成功视为启动成功 |
| macOS x64 | `macos-15-intel` | ZIP | 必须通过 |
| macOS arm64 | `macos-15` | ZIP | 必须通过 |

runner 标签不是不可变镜像；每个构建另记实际 `ImageOS`、`ImageVersion`、操作系统、架构和工具版本。工具或 runner 不可用时流程失败，不静默换用其他版本。

## CI 与产物

- [check.yml](../.github/workflows/check.yml) 对分支提交、PR 和手动运行执行语法与自动化测试。
- [package-smoke.yml](../.github/workflows/package-smoke.yml) 提供 PR 和手动运行的原生打包检查。
- [build.yml](../.github/workflows/build.yml) 构建八个目标，再调用 [release-smoke.yml](../.github/workflows/release-smoke.yml) 检查最终包。普通手动运行只上传 Actions 产物，不创建公开 Release。

每个 `dist-<目标>` 包含安装包和 `build-metadata.json`；`smoke-<目标>` 保存启动与升级报告。所有构建及七类原生验收通过后，`verified-release-bundle` 汇总八个安装包、校验侧文件、排序后的 `SHA256SUMS` 和内含验证报告的 `release-manifest.json`。Actions 产物有保留期限，交付时需下载保存。

汇总器严格检查预期文件名、非空内容、重复或缺失文件、源码提交、锁文件摘要、工具链、包内版本以及报告与安装包摘要的对应关系。构建清单记录文件大小、SHA-256、runner、源提交和验证状态。校验文件的文件项只包含文件名，不含构建机器绝对路径。ARMv7 没有运行时验收，清单中记为 `not-verified`。

## 启动与升级验收范围

启动检查调用最终包的 `--smoke-test`，必须成功退出并生成平台、架构、包内版本相符的报告；仅零退出码不算通过。检查窗口、preload、renderer 和延迟加载模块，不验证真实账户登录、远程游戏下载或 Java 游戏启动。

原生升级检查额外构建隔离的旧测试包：同一源码通过打包元数据设为 `0.0.0`，输出到 `release/upgrade-fixtures/<目标>/`，不进入发布集合。先实际启动旧测试包，再用真实更新管理器和辅助进程安装当前包，实际启动新版后确认健康；再升级一次检查唯一备份、最近一代保留与更旧受管备份清理。它验证不同包内版本和真实替换流程，不代表与任意历史公开版本兼容。

ARMv7 曾尝试用 QEMU 用户态替代原生验收：`ubuntu-24.04` 上注册 binfmt 后，armhf 容器可以执行自身工具链，但 AppImage 运行时（ELF 带尾部 squashfs）在 qemu-user 下始终返回 `ENOEXEC`，因此该路线暂时不纳入发布门槛，armv7 产物只做构建与校验。`verify-packaged.cjs` 与 `verify-upgrade.cjs` 保留 `--emulated <机制>` 参数，报告写入 `native:false` 与 `emulatedBy`，汇总时记为 `passed-emulated`；重新启用时不需要改脚本。待 AppImage 运行时可在模拟环境中执行后，把 `linux-armv7l` 的 `smokeRunner` 与 `emulatedBy` 加回 `scripts/release-targets.cjs` 即可恢复门槛。

测试使用隔离安装目录和用户数据目录。健康确认由测试程序在新版启动报告成功后调用，实际产品则由主进程检测新版窗口显示、主框架本地页面加载和预加载桥接就绪。Java、账户与网络后台检查不阻挡健康确认。两类 macOS runner 还实际撤销隔离应用目录的写权限，要求系统拒绝写入后保留已校验 ZIP、降级为手动替换入口，且不退出或启动辅助进程；报告必须包含 `manualPermissionFallbackPassed:true`。App Translocation 降级、Windows 文件锁与辅助进程错误、回滚错误、不同安装路径隔离等故障分支另由事务测试覆盖。

## 公开发布与 Blob

只有版本标签 `v<package.json.version>` 触发公开发布。流程校验标签与检出的源码、锁文件及包内版本，等待八包和七类原生报告完整通过，再上传 draft 并公开。已有公开版本仅允许相同摘要的幂等重跑；内容不同直接失败，不能覆盖。

配置 Blob 后，只同步 Windows x64、ia32、arm64 三个已验证的 portable EXE；逐个上传并回读校验大小与 SHA-256，全部成功才更新仅含这三个 EXE 的 `releases/latest.json`，失败不切换 latest。完整 `release-manifest.json` 原样保存为 `releases/<tag>/manifest.json`，用于来源验证及同标签不可变校验。GitHub Releases 仍发布完整八包和校验文件，macOS、Linux 下载继续使用 GitHub。手动回填只下载三个 Windows EXE 和完整发布清单。未配置 Blob 时报告跳过，不伪造同步成功。手动分支构建始终不走公开发布与 Blob 同步步骤。

## 本地交付检查

```powershell
npm run verify:toolchain
npm run check
npm test
npm run smoke
npm run build -- --target windows-x64
```

在 Windows 实际运行便携包检查首次释放、再次复用、活动版本保护，再运行 `scripts/verify-upgrade.cjs` 验证隔离双版本升级。界面在实际 `760×466` 窗口检查导入确认、缺失文件列表、取消状态、错误建议及更新恢复入口。发布验收记录应附源码提交、CI 链接、八类产物、校验清单和原生报告，并清楚列出未执行或失败的项目。
