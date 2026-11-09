# 对象存储下载

官网的下载按钮直接链接到 Cloudflare R2 公共对象存储，由浏览器负责传输与保存安装包。GitHub Release 是版本、文件大小与 SHA-256 的权威来源；只有版本和文件信息都匹配时，官网与启动器才采用 R2 直链。未同步的文件显示 GitHub 下载。

## 配置与发布

- Vercel 项目和 GitHub Actions 仓库配置 R2 的公开地址及同步凭据。`R2_SECRET_ACCESS_KEY` 只保存为 GitHub Actions Secret，不提交到仓库。
- 标签发布流程在八包构建与既定原生验收通过、GitHub Release 公开后同步对象存储。
- 同步覆盖 Windows x64、ia32、ARM64，Linux x64、ARM64、ARMv7，以及 macOS x64、ARM64。
- 对象按 `releases/<tag>/<官方文件名>` 保存。每个对象须从 R2 源站和公开地址回读，并匹配已发布清单中的大小与 SHA-256；全部完成后才更新 `releases/latest.json`。失败时保留之前的 latest。
- 已存在的同版本发布清单必须一致；已存在的安装包须验证一致后复用。补齐同版本其他平台不更改已公开 GitHub Release。
- 保留历史版本需要相应存储空间，下载产生对象存储传输用量。扩容与删除历史文件应单独决定。

## 回填现有版本

先将同步脚本和工作流推送到 main，在 GitHub Actions 运行 `Sync an existing release to Cloudflare R2`，分支选择 main，输入已经公开的版本，例如 `v1.9.2`。该流程读取现有 Release 和发布清单，下载并同步八个安装包。无需重新构建或覆盖该版本的 Release。

验收时确认官网 `/api/latest-release` 返回正确版本、八个 R2 下载地址均与 GitHub 的 size/digest 一致，并实际测试对象的 HEAD、Range 与完整下载校验。官网最多有数分钟元数据缓存；未确认对象就绪时不会标为对象存储下载。

## 旧方案清理

旧 `melody-downloads` Cloudflare Worker、`downloads.melodyoblivion.xyz` Worker 域名绑定和相应 DNS 记录，以及 `melody-downloads` Turnstile 站点均停止使用。移除 Vercel 中本下载功能的 `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`DOWNLOAD_AUTH_SECRET`、`DOWNLOAD_ALLOWED_HOSTNAMES`，以及如有设置的 `CDN_BASE_URL`、`DOWNLOAD_CDN_BASE_URL` 和 `DOWNLOAD_URL_TTL_SECONDS`。

官网不再加载 Turnstile、请求下载授权或通过 JavaScript 分段拼接整包。旧的授权 API、Worker 源码及部署配置已从当前源码删除。Git 历史保留旧实现以供审查。
