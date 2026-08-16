<div align="center">
  <img src="assets/app-icon.png" width="96" alt="忘却的旋律启动器图标">

# 忘却的旋律启动器

**经典国产 Minecraft Java 版启动器“忘却的旋律”的现代独立重制版。**

[English](README.md) · 简体中文

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-43+-9feaf9.svg)](https://www.electronjs.org/)
[![Minecraft](https://img.shields.io/badge/Minecraft-Java_Edition-62b74a.svg)](https://www.minecraft.net/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#当前限制)
[![Release](https://img.shields.io/badge/Release-v1.2.0-red.svg)](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases)
</div>

> [!IMPORTANT]
> 当前仓库版本为 `1.2.0`。Windows、macOS 与 Linux x64 版本通过 GitHub Releases 发布。测试新版本前，请先备份 Minecraft 数据。

## 项目简介

忘却的旋律启动器是一款从零开发的 Electron Minecraft Java 版启动器。它保留了旧版启动器安静、紧凑的气质，并使用现代的下载、账户、Java 运行时、模组加载器和游戏启动流程重写了内部实现。

本项目是一份独立致敬作品，并非原项目的官方更新或延续，也未使用原版源代码。本项目与原作者、Mojang Studios 及 Microsoft 均无隶属或认可关系。

## 名称与历史

“忘却的旋律”是国内 Minecraft 社区早期广泛使用的第三方启动器之一。现存公开资料通常将其描述为一款易语言程序，约在 2012 年流行，因体积小、界面简单、可更换背景及游戏配置方便而为人熟知。公开资料普遍称 `5.31` 为最终版本，并称项目于 2014 年停止维护。

现存资料并不完整，部分说法也互相矛盾，例如同一个百科页面同时提到了 2009 年和 2012 年。因此，本文将“约 2012 年”、最终版本 `5.31` 以及 2014 年停止维护视为社区流传的信息，而非经一手资料验证的事实。

当前仓库是全新的实现，其版本号与代码沿革均与历史启动器无关。

## 已实现功能

- **游戏版本**：浏览 Mojang 版本清单、识别本地安装、下载原版游戏、验证所需文件，并将可移除的配置移动到回收站。
- **模组加载器**：通过统一流程查询并安装 Fabric、Forge 与 NeoForge。
- **可靠下载**：在 Mojang 官方源与 BMCLAPI 之间选择；自动模式会测速；支持任务并发、大文件 HTTP Range 分段、SHA-1 校验、取消下载及失败后切换来源重试。
- **账户系统**：支持离线账户、Microsoft 设备代码登录及 LittleSkin Yggdrasil；可同步皮肤头像、启动前刷新在线凭据，并阻止令牌进入渲染进程。
- **Java 管理**：匹配游戏所需的 Java 主版本，优先使用用户指定且兼容的运行时，否则通过 Adoptium API 安装 Eclipse Temurin JRE。
- **启动核心**：处理版本继承、平台规则、参数与类路径、本地库安全解压、Java 进程启动及状态报告。LittleSkin 账户会自动准备经过 SHA-256 校验的 authlib-injector。
- **整合包**：检查并安装 Modrinth `.mrpack` 与 CurseForge `.zip`，使用独立实例目录并支持 overrides 和已兼容的加载器。
- **桌面界面**：紧凑的无边框 Electron 窗口，覆盖版本、账户、下载、启动及设置流程。

自动化测试目前覆盖账户、身份验证、下载、Java 选择、游戏启动、加载器、整合包、设置及本地版本管理等 64 个测试用例。

## 当前限制

- 提供 Windows、macOS 与 Linux 的 x64 公开构建，不同平台的细节表现仍可能存在差异。
- 暂无自动更新功能；新版本需从 GitHub Releases 下载。
- Microsoft 登录依赖启动器的 Azure 应用注册获得 Minecraft Services 接受。服务方策略或注册状态改变可能导致登录暂时不可用。
- LittleSkin Yggdrasil 仅在客户端和服务端使用相同验证服务时生效；它不能代替正版账户，也不会授予进入正版验证服务器的权限。参见 [LittleSkin 用户使用手册](https://manual.littlesk.in/yggdrasil/)。
- CurseForge 安装依赖 CurseTools 提供的可下载文件元数据，或配置 `CURSEFORGE_API_KEY`。包含受限或已下架文件的整合包可能安装失败。
- 暂不支持 Quilt 整合包。
- 整合包处理和面向用户的失败恢复流程仍在持续完善。

## 运行要求

- Windows 10/11、macOS 或 Linux x64
- Node.js 22 或更高版本
- 与已提交锁文件兼容的 npm
- 用于元数据、游戏文件、账户验证及托管 Java 下载的网络连接
- 进行正版在线游戏时，需要合法拥有的 Minecraft Java 版账户

## 从源码运行

```powershell
npm ci
$env:MELODY_MICROSOFT_CLIENT_ID = "你的公开 Azure 应用 ID"
npm run dev
```

启动器使用操作系统默认的 Minecraft 应用数据目录（Windows 为 `%APPDATA%\.minecraft`）。整合包实例存放在 `.minecraft\melody-instances` 下。测试前请备份已有安装。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 以开发模式启动 Electron 应用 |
| `npm run check` | 检查主进程、预加载脚本与渲染脚本语法 |
| `npm test` | 运行 Node.js 自动化测试 |
| `npm run smoke` | 使用临时用户数据加载 Electron 窗口并退出 |
| `npm run build:win` | 构建 Windows x64 便携版 |
| `npm run build:linux` | 构建 Linux x64 AppImage 与 deb 包 |
| `npm run build:mac` | 构建 macOS x64 dmg 与 zip 包 |

## 仓库结构

```text
src/
├── main/                 Electron 主进程
│   ├── accounts/         离线、Microsoft 与 LittleSkin 账户
│   ├── minecraft/        下载、Java、加载器、启动与整合包
│   └── settings/         持久化设置
├── preload/              沙箱化的渲染进程桥接层
└── renderer/             启动器界面
test/                     自动化测试
assets/                   共用美术资源
index.html                项目落地页
site.js                   落地页翻译与交互逻辑
styles.css                落地页样式
```

仓库根目录的落地页与 `src/renderer` 下的 Electron 界面是两个不同的界面。

## 安全说明

- Electron 渲染进程启用了上下文隔离和沙箱，并关闭 Node.js 集成。
- Microsoft 与 LittleSkin 的访问令牌、刷新令牌和客户端令牌不会出现在提供给渲染进程的账户对象中。
- 在线账户令牌使用 Electron `safeStorage` 加密保存。如果安全存储不可用，启动器会拒绝保存或读取在线凭据，不会降级为明文存储。
- Microsoft 登录从 `MELODY_MICROSOFT_CLIENT_ID` 读取公开 OAuth 应用 ID。仓库不包含客户端密钥或生产环境 Client ID；公开 Electron 构建无法对内嵌 Client ID 保密。
- 下载目标、整合包路径、压缩包解压位置和远程模组 URL 均会经过验证，以降低路径穿越及不安全 URL 的风险。
- 上游元数据提供哈希时，SHA-1 校验可发现意外损坏，但不应将 SHA-1 视为现代的真实性保证。

提交安全问题时，请勿包含账户文件、访问令牌、刷新令牌、设备代码或个人 Minecraft 数据。

## 后续计划

- 继续完善整合包兼容性和错误恢复流程。
- 改进界面中的错误提示及取消操作。
- 完善多平台的可重复构建与发布产物。
- 补充发布校验、升级行为和已知问题文档。

## 历史资料

- [百度百科：忘却的旋律（《Minecraft》游戏启动器）](https://baike.baidu.com/item/%E5%BF%98%E5%8D%B4%E7%9A%84%E6%97%8B%E5%BE%8B/16496487)：社区编辑的二手资料，用于参考常见的 2012/2014 时间线与最终版本说法。
- [Minecraft: Java Edition is moving house](https://www.minecraft.net/en-us/article/java-edition-moving-house)：Mojang 关于 Mojang 账户迁移至 Microsoft 账户的公告。

这些链接仅用于说明历史背景，并不代表相关方认可本重制项目。请勿从未经验证的镜像下载旧启动器程序。

## 许可证与商标

本项目采用 [GNU Affero General Public License v3.0](LICENSE) 许可。第三方名称、商标及素材仍受各自权利人的条款约束。

Minecraft 是 Microsoft 的商标。本项目为非官方项目，与 Microsoft 或 Mojang Studios 无隶属或认可关系。“忘却的旋律”名称仅用于指代和致敬历史启动器，本项目不主张拥有原项目。
