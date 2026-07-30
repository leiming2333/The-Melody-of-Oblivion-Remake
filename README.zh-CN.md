<div align="center">
  <img src="assets/app-icon.png" width="96" alt="忘却的旋律启动器图标">

# 忘却的旋律启动器

**从零打造，向中文 Minecraft 社区经典启动器“忘却的旋律”致意的现代独立重制项目。**

[English](README.md) · 简体中文
</div>

> [!IMPORTANT]
> 本仓库目前是版本 `0.1.0` 的**开发预览**，尚无公开安装包或稳定版本。如果你不熟悉未完成软件的测试，请等待正式发布；从源码运行前请先备份 Minecraft 数据。

## 项目简介

忘却的旋律启动器是一个从零开发的 Electron Minecraft: Java Edition 启动器。它保留老启动器安静、紧凑的气质，同时用现代实现重新构建下载、账户、Java 运行时、模组加载器和游戏启动流程。

这是一个独立的致意项目，**不是**原版的官方更新、原始代码续作，也没有得到原作者、Mojang Studios 或 Microsoft 的授权或背书。

## 名称与历史

“忘却的旋律”被许多玩家视为中文 Minecraft 社区早期广泛使用的第三方启动器之一。公开资料通常称它在 2012 年前后以易语言编写，凭借体积小、界面简洁、可更换背景和方便的游戏配置受到欢迎。版本 `5.31` 被普遍记作最终版本，维护则在 2014 年停止。

现存公开记录并不完整，部分说法也互相矛盾——例如同一百科词条分别出现了 2009 年和 2012 年两个起点。因此，本文把“约 2012 年”、最终版本 `5.31` 和 2014 年停更视作社区常见记载，而不是经过第一手史料确认的结论。

当前仓库从版本 `0.1.0` 开始重新实现，版本号和代码谱系均与原版无关。

## 已实现功能

- **游戏版本**：读取 Mojang 版本清单，检测本地安装，下载原版游戏，校验必需文件，并将可删除的启动配置移入回收站。
- **模组加载器**：通过统一流程查询并安装 Fabric、Forge 和 NeoForge。
- **可靠下载**：可选择 Mojang 托管地址或 BMCLAPI；自动模式会探测下载源；支持可调任务并发、HTTP Range 大文件分段、SHA-1 校验、任务取消和备用源重试。
- **账户管理**：支持离线档案、Microsoft 设备代码登录与 LittleSkin Yggdrasil 外置登录；同步正版/外置皮肤头像，启动前刷新在线凭据，并阻止令牌进入渲染页面。
- **Java 管理**：匹配游戏要求的 Java 主版本，优先使用用户指定且兼容的运行时，缺失时通过 Adoptium API 准备 Eclipse Temurin JRE。
- **启动核心**：处理版本继承、平台规则、参数与类路径、原生库安全解压、Java 进程启动和状态回传；LittleSkin 账户会自动准备并校验 authlib-injector。
- **整合包**：读取 Modrinth `.mrpack` 与 CurseForge `.zip`，复制覆盖文件、安装支持的加载器，并创建相互隔离的实例目录。
- **桌面界面**：紧凑的无边框 Electron 窗口，包含版本、账户、下载、启动和设置流程。

自动化测试目前包含 60 个用例，覆盖账户、认证、下载、Java 选择、启动、加载器、整合包、设置和本地版本管理。

## 当前限制

- 当前开发和发布目标是 Windows 10/11。部分底层代码包含 macOS 和 Linux 处理，但尚未作为受支持平台发布。
- 尚无打包后的可执行文件、安装程序、更新器或公开下载。
- Microsoft 登录依赖启动器的 Azure 应用注册通过 Minecraft Services 审核；服务方策略或注册状态变化可能导致预览版无法登录。
- LittleSkin 外置登录仅适用于客户端和服务端均正确配置 Yggdrasil 的环境，不能替代正版，也不能进入仅支持正版的服务器。详见 [LittleSkin 用户手册](https://manual.littlesk.in/yggdrasil/)。
- CurseForge 安装依赖 CurseTools 提供可下载的文件信息；配置 `CURSEFORGE_API_KEY` 后也可尝试官方接口。包含受限或已下架文件的整合包可能安装失败。
- 暂不支持 Quilt 整合包。
- 整合包兼容性和失败恢复提示仍在完善。

## 环境要求

- Windows 10 或 Windows 11
- Node.js 22 或更高版本
- 与仓库锁文件兼容的 npm
- 可用于获取元数据、游戏文件、认证和托管 Java 的网络连接
- 如需正版在线游戏，需要合法拥有 Minecraft: Java Edition

## 从源码运行

```powershell
npm ci
$env:MELODY_MICROSOFT_CLIENT_ID = "你的公开 Azure 应用标识"
npm run dev
```

预览版使用操作系统中的 Minecraft 应用数据目录（Windows 为 `%APPDATA%\.minecraft`），整合包实例位于 `.minecraft\melody-instances`。测试前请备份已有游戏目录。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 以开发模式启动 Electron 应用 |
| `npm run check` | 对主进程、预加载和渲染端 JavaScript 进行语法检查 |
| `npm test` | 运行 Node.js 测试套件 |
| `npm run smoke` | 使用临时用户数据加载 Electron 窗口后退出 |
| `npm run build:exe` | 构建 Windows x64 便携版可执行文件 |

## 仓库结构

```text
src/
├── main/                 Electron 主进程
│   ├── accounts/         离线、Microsoft 与 LittleSkin 账户
│   ├── minecraft/        下载、Java、加载器、启动与整合包
│   └── settings/         启动器持久化设置
├── preload/              沙箱化渲染层桥接
└── renderer/             启动器界面
test/                     Node.js 测试
assets/                   共用美术资源
index.html                项目介绍网站
site.js                   网站翻译与交互
styles.css                网站样式
```

仓库根目录的介绍网站与 `src/renderer` 下的 Electron 启动器界面是两个独立界面。

## 安全说明

- Electron 渲染层开启上下文隔离和沙箱，并关闭 Node.js 集成。
- 面向渲染层的账户对象会移除 Microsoft 和 LittleSkin 的访问令牌、刷新令牌及客户端令牌。
- 在线账户令牌使用 Electron `safeStorage` 加密落盘；安全存储不可用时，启动器会拒绝保存或读取在线凭据，不会退回明文。
- Microsoft 登录从 `MELODY_MICROSOFT_CLIENT_ID` 读取公开 OAuth 应用标识。仓库不包含客户端密钥或生产 Client ID；公开 Electron 程序无法保密内置 Client ID。
- 下载目标、整合包路径、压缩包解压和远程模组地址均经过校验，以降低目录穿越和不安全 URL 风险。
- 上游元数据提供哈希时会使用 SHA-1 检测意外损坏；SHA-1 不应被视为现代意义上的真实性保障。

提交安全问题时，请勿附带账户文件、访问令牌、刷新令牌、设备代码或个人 Minecraft 数据。

## 首个公开预览版之前

- 完善整合包兼容性与失败恢复。
- 改进界面中的错误提示和取消行为。
- 建立可重复的 Windows 打包与发布流程。
- 补充版本校验、升级行为和已知问题文档。

## 历史参考

- [百度百科：忘却的旋律（Minecraft Java 版游戏启动器）](https://baike.baidu.com/item/%E5%BF%98%E5%8D%B4%E7%9A%84%E6%97%8B%E5%BE%8B/16496487)：社区编辑的二手资料，本文用它核对常见的 2012/2014 时间线和最终版本说法。
- [Minecraft：Java Edition is moving house](https://www.minecraft.net/en-us/article/java-edition-moving-house)：Mojang 关于 Mojang 账户迁移至 Microsoft 账户的公告。

以上链接只用于说明历史背景，并不代表相关网站认可本重制项目。请勿从来源不明的镜像下载旧启动器程序。

## 许可证与商标

本项目采用 [GNU Affero General Public License v3.0](LICENSE) 发布。第三方名称、商标与资源仍受各自权利人的条款约束。

Minecraft 是 Microsoft 的商标。本项目是非官方项目，与 Microsoft 或 Mojang Studios 无关，也未得到其认可。“忘却的旋律”名称仅用于指代和致意历史启动器，本项目不主张拥有原项目。
