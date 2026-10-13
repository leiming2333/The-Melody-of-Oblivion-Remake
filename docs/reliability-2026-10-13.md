# 启动器可靠性修复验证记录

日期：2026-10-13（Asia/Hong_Kong）。基线：`eb61692`，分支：`codex/launcher-reliability`。

## 修复与提交

| 提交 | 改动 | 验证要点 |
| --- | --- | --- |
| `2297997` | 按文件共享账户/设置写入队列；Electron 单实例锁；拒绝 Linux `basic_text`、`unknown` 及无法确认后端的在线凭据读写；Windows 更新等待旧进程退出 | 多对象修改保留双方数据；写入失败后队列可恢复；第二进程不创建窗口或加载存储；无窗口时可重新打开；离线账户可用；重命名便携 EXE、真实进程等待和替换回滚 |
| `47f4900` | 游戏元数据及下载文件以唯一临时文件原子替换；有限重试 Windows 临时共享锁；捕获并脱敏 Java 输出 | 替换失败保留旧文件且清理临时文件；并发元数据写入保持完整 JSON；跨数据块脱敏、UTF-8、日志上限与历史清理；日志不可写时游戏仍可启动 |
| `d6ad8ca` | 整合包预览随机读取清单；按内容缓存已校验下载 | 预览不解压 overrides；拒绝清单解压炸弹和目录越界；失败/取消重试复用；缓存篡改重新下载；无有效哈希不缓存 |
| `b79a564` | 普通提交/PR 快速检查；发布依赖最终安装包启动检查；抽离启动器更新界面；闪退提示提供日志位置 | 更新界面行为测试；异常退出日志提示；安装包报告必须匹配打包状态、平台和目标架构；发布依赖和 artifact 名称匹配 |

窗口关闭后重新打开与 Windows 更新等待是接入单实例锁时一并修复的生命周期问题。Windows 便携更新保留用户自定义的 EXE 文件名。

## 验证结果

- `npm run check`：89 个 JavaScript 文件语法检查通过。
- `npm test`：287 项测试，286 通过、0 失败、1 项按平台跳过。
- `npm run smoke`：源码 Electron 启动检查通过，输出 `SMOKE_TEST_OK`。
- 5 个 workflow/action YAML 解析通过；Windows smoke 脚本解析通过；7 个发布产物名称与构建矩阵对应。
- Windows x64 便携 EXE 构建成功，实际启动验证报告：`{"ok":true,"packaged":true,"platform":"win32","arch":"x64","version":"1.6.5"}`。

首次全套测试与语法检查同时运行时，既有持续慢速下载测试的 100 ms 空闲期限因调度延迟触发。下载器的空闲监控未改；测试增加调度裕量，并显式确认总传输时间仍超过空闲期限，随后全套通过。

本地构建使用 Electron 43.4.1、electron-builder 26.15.3、Node.js 26.10.0。CI 使用 Node.js 22；本机结果不等于跨平台 CI 结果。

## Windows 验证产物

- 路径：`release-reliability/The-Melody-of-Oblivion-Remake-Windows-x64.exe`
- 大小：94,686,828 字节。
- SHA-256：`0d976a0ffe8931d12ebec5389de2fc4dfb9d4e9fa9872f44817ef26fad11918e`。
- 命令：`node scripts/verify-packaged.cjs --expected-arch x64 release-reliability/The-Melody-of-Oblivion-Remake-Windows-x64.exe`。

产物保留在本地忽略目录中，版本仍为 1.6.5。

## 运行边界

发布检查配置覆盖 Windows x64/ia32/ARM64、Linux x64/ARM64、macOS x64/ARM64；本次本机仅实际运行 Windows x64，其余等待 GitHub runner 验证。Linux ARMv7 没有可用的 GitHub 原生 runner，仍需 ARMv7 设备验证实际产物。启动检查覆盖窗口、preload 和模块加载，真实账户登录与完整 Minecraft 游戏启动未在本机重新验收。

Java 日志存放在游戏根目录的 `launcher-cache/game-logs`，单份最多 2 MiB，默认保留 5 份，正在运行的日志始终保留。整合包缓存位于 `launcher-cache/modpack-files`，每次复用重新校验 SHA-1；缓存不替代上游文件真实性保障，可在停止安装并关闭游戏后手动清理。详情已同步到中英文 README。
