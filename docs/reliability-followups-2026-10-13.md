# 启动器第二轮可靠性修复验证记录

日期：2026-10-13（Asia/Hong_Kong）。基线：`8348fd8`，修复分支：`codex/reliability-followups`。

## 修复与提交

| 提交 | 修复 | 验证要点 |
| --- | --- | --- |
| `c9f07b7` | Linux AppImage 使用独立随机暂存目录；官网与启动器核对 GitHub 最新发布 | 同名和自定义文件名均保留旧版；替换失败保留当前文件、已有备份和已校验更新包；旧 Blob、旧镜像不能覆盖已知新版本；仅同版本、同大小、同官方 SHA-256 的 Blob 地址可复用；官方缺少摘要时读取官方校验侧文件 |
| `9465ad0` | 删除配置检查整合包实例的 `profileId`；Minecraft 1.21 匹配 NeoForge `21.0.*` | 直接和多级继承引用阻止删除；循环继承安全终止；版本目录缺失时仍检查实例；移除实例后可删除；1.21.0 与 1.21.1 分别匹配正确系列 |
| `b50cb58` | Microsoft 刷新不改变当前账户；离线改名持续监听失焦 | 刷新期间切换账户仍保留选择；显式登录仍选择账户；连续改名按序保存；慢响应不覆盖后续输入；失败回退到最新已保存名字；改名响应保留同时变更的账户选择 |
| `620b2ff` | 设置打开时清空旧返回值；在线加载失败后初始化本地版本操作 | 保存后重开并按 Esc 不会保存草稿；三个设置入口共用初始化；首次断网可使用和删除本地原版及加载器；在线恢复不产生重复条目；删除本地回退条目后立即移除，避免错误重新安装参数 |

发布新鲜度无法核实时，官网返回失败，启动器不会仅凭官网缓存宣称“已是最新版”。若缓存版本明确高于已安装版本，启动器仍可提示已有更新。GitHub 已知元数据与 Blob 的版本或资产不一致时，使用 GitHub 的发布信息与校验值。

Linux 备份使用独占复制；已有 `.old` 文件会保留，新备份使用唯一后缀。最终替换采用同一文件系统内的重命名，失败不会先移走当前 AppImage。

## 验证结果

- `npm test`：318 项测试，317 通过、0 失败、1 项按平台跳过。
- `npm run check`：90 个 JavaScript 文件语法检查通过。
- `npm run smoke`：源码 Electron 启动检查通过，输出 `SMOKE_TEST_OK`。
- `git diff --check`：通过。
- Windows x64 便携包重新构建成功；实际启动报告：`{"ok":true,"packaged":true,"platform":"win32","arch":"x64","version":"1.6.5"}`。

本地使用 Node.js 26.10.0、Electron 43.4.1、electron-builder 26.15.3。测试和构建按序执行，避免打包或语法扫描干扰计时测试。

## Windows 验证产物

- 路径：`release-followups/The-Melody-of-Oblivion-Remake-Windows-x64.exe`。
- 大小：94,688,031 字节。
- SHA-256：`96e422d75f7fd2b99d1f155e1a50ebf43dc6afa60a586098b485b87de3c7fa77`。
- 验证命令：`node scripts/verify-packaged.cjs --expected-arch x64 release-followups/The-Melody-of-Oblivion-Remake-Windows-x64.exe`。

产物保留在本地忽略目录，应用版本仍为 1.6.5。

## 验证范围

本机为 Windows：Linux AppImage 暂存、备份和替换失败通过真实文件操作及故障注入测试，尚未在真实 Linux AppImage 运行环境验收。官网与发布源测试使用可控响应，未部署官网或发布安装包，也未触发远程 CI。启动检查覆盖安装包窗口及模块加载，真实账户登录与完整 Minecraft 游戏启动未在本轮重新验收。

代码按上述四组提交管理，验证记录另作提交。验证通过后快进合并到本地 `main`，删除本轮修复分支；远端推送与发布不在本轮操作范围。
