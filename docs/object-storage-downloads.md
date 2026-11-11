# 对象存储下载

Cloudflare R2 保留公共安装包和发布清单，供启动器自动更新以及官网下载网关读取。官网主按钮完成 Turnstile 真人验证后，通过独立的签名 Worker 进行 1 MiB 分块、默认 4 路并发下载；完整文件大小和官方 SHA-256 校验通过后才交给浏览器保存。GitHub Release 是版本、大小与 SHA-256 的权威来源。GitHub 原始下载与网盘入口继续公开；桌面更新不需要真人验证。

## 配置与发布

- Vercel 项目和 GitHub Actions 仓库配置 R2 的公开地址及同步凭据。`R2_SECRET_ACCESS_KEY` 只保存为 GitHub Actions Secret，不提交到仓库。
- 标签发布流程在八包构建与既定原生验收通过、GitHub Release 公开后同步对象存储。
- 同步覆盖 Windows x64、ia32、ARM64，Linux x64、ARM64、ARMv7，以及 macOS x64、ARM64。
- 对象按 `releases/<tag>/<官方文件名>` 保存。每个对象须从 R2 源站和公开地址回读，并匹配已发布清单中的大小与 SHA-256；全部完成后才更新 `releases/latest.json`。失败时保留之前的 latest。
- 增量补丁单独保存在 `patches/<tag>/patch-manifest.json` 和 `patches/<tag>/patch-*.patch`，同样回读校验后才进入 latest 更新步骤。补丁路径与完整包路径互不覆盖，启动器优先读取该镜像，失败回退 GitHub。
- 已存在的同版本发布清单必须一致；已存在的安装包须验证一致后复用。补齐同版本其他平台不更改已公开 GitHub Release。
- 保留历史版本需要相应存储空间，下载产生对象存储传输用量。扩容与删除历史文件应单独决定。

## 回填现有版本

先将同步脚本和工作流推送到 main，在 GitHub Actions 运行 `Sync an existing release to Cloudflare R2`，分支选择 main，输入已经公开的版本，例如 `v1.9.2`。该流程读取现有 Release 和发布清单，下载并同步八个安装包。无需重新构建或覆盖该版本的 Release。

验收时确认官网 `/api/latest-release` 返回正确版本、八个 R2 下载地址均与 GitHub 的 size/digest 一致，并实际测试对象的 HEAD、Range 与完整下载校验。官网最多有数分钟元数据缓存；未确认对象就绪时不会标为对象存储下载。

## 官网真人验证入口

用户点击下载后，页面加载验证组件；Vercel 向 Cloudflare Siteverify 校验 token、`action: download` 和官网 hostname。通过后签发绑定版本、安装包路径及有效期的 HMAC-SHA256 链接。同一次下载的测速、并行 Range 和重试复用一个许可，不对每块重新弹验证码。

Worker 原生流式转发固定的 R2 安装包，失败时尝试固定 Blob（仅 Windows）与 GitHub。只缓存不超过 1 MiB 的完整小对象或对齐分段，不在 JavaScript 中逐块搬运大安装包。缓存读取也必须先验证许可；浏览器响应为 `private, no-store, no-transform`。网页显示速度、进度与取消；取消或关闭页面丢弃本次内存分段。

**不能将旧 Worker 直接绑定到 `downloads.melodyoblivion.xyz`。** 该域名及 `/releases/latest.json`、`/releases/<tag>/manifest.json` 与公共安装包继续用于 R2 同步、发布校验和启动器更新。恢复网关默认使用 `verified-downloads.melodyoblivion.xyz`；也支持官网 `/verified-downloads` 独立路径，但只能绑定窄路径，不能覆盖整个官网。

配置 Vercel Production 环境变量：

- `TURNSTILE_SITE_KEY`：Turnstile 站点的公开 Site Key。
- `TURNSTILE_SECRET_KEY`：同一站点的 Secret Key，只放在 Vercel Secret 中。
- `DOWNLOAD_ALLOWED_HOSTNAMES`：`www.melodyoblivion.xyz,melodyoblivion.xyz`。
- `DOWNLOAD_AUTH_SECRET`：至少 32 个 UTF-8 字节的随机共享密钥，以完全相同的值同时保存为 Vercel Secret 与 Worker Secret；不能多出空格或换行。
- `DOWNLOAD_CDN_BASE_URL`：默认 `https://verified-downloads.melodyoblivion.xyz`，不是 R2 公共下载域名；API、浏览器和 Worker 使用相同允许列表。
- `DOWNLOAD_URL_TTL_SECONDS`：可选，默认 `900`，表示真实签名有效 15 分钟，可设 `60` 至 `3600`。

完整后台操作、部署顺序及窄路径选项见 [Cloudflare 下载网关](../cloudflare/README.md)。真实凭据不能进入前端、仓库、截图或聊天。配置变量后必须部署新版本；只有源码恢复或变量保存不代表线上已经生效。

## 性能测试

可在当前网络执行只读样本测试，不保存或运行安装包：

```powershell
npm run benchmark:website -- --rounds=3 --source=r2 --timeout-ms=60000
```

每轮比较一条 4 MiB Range 与四条 1 MiB Range，报告吞吐、响应头等待、CORS 和缓存状态；各模式样本 SHA-256 必须一致。这不是整包校验，也不能代替真实浏览器和生产 Worker 测速。

2026-11-11 当前电脑网络的 3 轮热缓存样本：R2 单路中位数约 `0.24 MiB/s`，4 路约 `0.37 MiB/s`（约 1.5 倍）。旧 Blob 的 v1.9.3 Windows x64 文件返回 404，GitHub 多次超时。样本不证明其他地区或网络同样提速；新验证域名和官网窄路径在部署前无法直接比较。Worker 的请求量、CPU 配额和浏览器内存也需要生产验收。

真实 Chromium 离线验收可执行 `npm run verify:website-browser`，以隔离的 HTTPS 拦截、测试 widget 与合成文件检查一次验证、四路分段、完整文件校验与保存，以及失败、过期、取消和窄屏布局。所有外部网络请求都被拦截，不使用真实密钥或运行安装包；不替代生产 CF 验证。

保护范围是官网主按钮与独立签名 Worker。R2、GitHub、Blob 和网盘本身仍公开，持有签名链接的人在有效期内也可以复用它。不要宣称全部发行文件已私有化，或通过关闭校验自动跳转公共直链来掩盖验证失败。
