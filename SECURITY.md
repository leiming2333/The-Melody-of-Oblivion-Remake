# 安全政策 / Security Policy

简体中文 · [English](#english)

## 安全维护范围

安全修复优先面向[最新公开稳定版本](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest)。旧版本不单独维护，请升级到最新稳定版；如果无法升级，请在报告中说明原因。`main` 分支和预发布版本的问题也欢迎报告，但这些版本可能尚未完成稳定版验收。

本政策涵盖本仓库维护的 Electron 启动器、官网与 API、Cloudflare 下载网关，以及构建、发布和更新流程。可报告的问题包括凭据泄露、沙箱或 IPC 边界绕过、路径穿越、不安全的归档解压、下载或更新校验绕过，以及未授权访问。

第三方服务、模组、整合包、Java 和加载器自身的问题，应报告给对应维护者。如果本项目的集成方式受到影响，或不确定问题归谁负责，也可以先私密联系我们。GitHub、公共 R2 和网盘中的公开安装包允许直接下载。仅绕过官网按钮的真人验证来获取这些公开文件，不构成未授权访问；如果能进一步访问受保护内容或造成其他安全影响，请说明具体影响。

## 私密报告漏洞

请将报告发送至 **[leiming2333@qq.com](mailto:leiming2333@qq.com)**，由维护者 [@leiming2333](https://github.com/leiming2333) 处理。建议邮件主题为 `[Security] 简要描述`。

仓库启用 GitHub 私密漏洞报告后，也可以通过 [Report a vulnerability](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/security/advisories/new) 报告。如果该入口不可用，请直接发邮件。

请勿在公开 Issue、PR、讨论或评论中发布未修复漏洞的细节、利用代码或敏感信息。普通功能故障和兼容性问题可以使用[错误报告表单](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/issues/new?template=bug_report.yml)；社区行为问题请参阅[行为准则](CODE_OF_CONDUCT.md)。

## 报告内容

请尽量提供以下信息；信息不完整也可以先报告：

- 启动器版本或源码提交号；官网问题附受影响的页面 URL 或接口路径。
- 操作系统、CPU 架构，以及相关的浏览器、Minecraft、Java 或加载器版本。
- 受影响的组件、问题描述、可能造成的影响和利用前提。
- 最小复现步骤，以及使用虚构数据的最小示例或概念验证。
- 脱敏后的日志、截图和错误信息；如已知，可以附修复建议。

不要发送账户数据文件、密码、访问或刷新令牌、设备代码、服务器密钥、带授权信息的下载 URL、完整用户目录或个人游戏数据。请使用自己的账户，在隔离环境中测试，避免访问他人数据、干扰公共服务或进行破坏性操作。如果凭据已经泄露，请先通过对应服务撤销或更换，再报告泄露原因，不要发送仍然有效的凭据。

## 处理与披露

维护者会尽力确认报告并复现问题，通过原来的私密渠道沟通影响范围、修复进度，以及还需要哪些信息。处理时间取决于问题的复杂程度，以及维护者能投入的时间。本项目不承诺固定的响应或修复期限。

公开细节前，请先与维护者协商披露时间，让受影响的用户有机会获得修复或缓解措施。修复完成后，可通过 GitHub Security Advisory 或发布说明公布受影响版本和修复方式。署名致谢前会征得报告者同意，公告不会公开私密报告中的个人信息。

## English

### Supported Versions and Scope

Security fixes prioritize the [latest public stable release](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest). Older releases are not maintained separately; upgrade to the latest stable release, or explain in your report if you cannot. Reports affecting `main` or prereleases are also welcome, although these versions may not have completed stable-release validation.

This policy covers the Electron launcher, website and APIs, Cloudflare download gateway, and build, release, and update processes maintained in this repository. Relevant issues include credential exposure, sandbox or IPC boundary bypasses, path traversal, unsafe archive extraction, download or update verification bypasses, and unauthorized access.

Report vulnerabilities in third-party services, mods, modpacks, Java, and loaders to their maintainers. Contact us privately if this project's integration is affected or you are unsure who owns the issue. Installers on GitHub, public R2 storage, and cloud drives intentionally allow direct downloads. Obtaining these public files without using the website button's human verification alone is not unauthorized access; describe any additional impact, such as access to protected content.

### Reporting a Vulnerability

Email **[leiming2333@qq.com](mailto:leiming2333@qq.com)**, monitored by maintainer [@leiming2333](https://github.com/leiming2333). A suggested subject is `[Security] Brief description`.

You may also use [Report a vulnerability](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/security/advisories/new) when GitHub private vulnerability reporting is enabled for this repository. If that entry point is unavailable, email the report directly.

Do not publish details of unpatched vulnerabilities, exploit code, or sensitive information in public issues, pull requests, discussions, or comments. Use the [bug report form](https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/issues/new?template=bug_report.yml) for ordinary functional or compatibility issues and the [Code of Conduct](CODE_OF_CONDUCT.md#english) for community behavior reports.

### What to Include

Provide as much of the following as you can; incomplete reports are welcome:

- Launcher version or source commit; affected page URL or API path for website issues.
- Operating system, CPU architecture, and relevant browser, Minecraft, Java, or loader versions.
- Affected component, description, potential impact, and prerequisites for exploitation.
- Minimal reproduction steps and a minimal example or proof of concept using synthetic data.
- Redacted logs, screenshots, error messages, and suggested fixes if known.

Do not send account data files, passwords, access or refresh tokens, device codes, server secrets, download URLs containing authorization information, entire user directories, or personal game data. Test with your own accounts in an isolated environment, without accessing others' data, disrupting public services, or performing destructive actions. If credentials have leaked, revoke or replace them through the relevant service before reporting the cause; do not send credentials that are still valid.

### Response and Disclosure

The maintainer will make a best effort to acknowledge and reproduce reports, and discuss impact, progress, and any information needed through the original private channel. Timing depends on complexity and maintainer availability; there is no fixed response or remediation deadline.

Coordinate disclosure timing with the maintainer before publishing details so affected users have an opportunity to obtain a fix or mitigation. Once resolved, affected versions and remediation may be documented in a GitHub Security Advisory or release notes. Reporter credit requires consent, and personal information from private reports will not be published in advisories.
