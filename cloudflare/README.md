# 真人验证与分段下载网关

恢复 Turnstile、限时签名、默认 4 路并发的 1 MiB 分段下载、进度/取消、失败重试、固定源回退与整包 SHA-256 校验。不整体回滚 v1.9.3 的 R2 发布或启动器更新。

## 不影响现有服务

- `downloads.melodyoblivion.xyz` 保留为公共 R2 域名，发布清单、同步校验和启动器更新继续使用。
- 默认创建独立 Worker `melody-verified-downloads`，下载入口为 `verified-downloads.melodyoblivion.xyz`。不要把它绑定到旧公共下载域名。
- `wrangler.jsonc` 不预设生产路由；`workers.dev` 和预览 URL 关闭。只部署文件不会自动接管任何域名。添加生产域名或路径需要先确认用途。
- 不需要新建 R2 桶、迁移文件或给本 Worker 配置 R2 S3 密钥；Worker 读取固定公共 R2 源。

## 1. Cloudflare Turnstile

在 Cloudflare 账户的 **Turnstile** 页面检查旧 `melody-downloads` widget；仍可用则复用，否则 **Add widget**：

- 名称可用 `melody-downloads`。
- 模式 **Managed**，Pre-clearance 关闭。
- hostname 分别填写 `www.melodyoblivion.xyz` 与 `melodyoblivion.xyz`，不加协议、路径或通配符。
- 使用同一正式 widget 的 Site Key 与 Secret Key，不使用测试 key。

Secret Key 只放到 Vercel 服务端，Worker 不需要它。

## 2. 配置 Vercel

官网项目 **Settings → Environment Variables**，环境选择 **Production**。已有同名变量则编辑，避免重复。密钥项选 **Secret**，旧界面可显示 **Sensitive**。

| 名称 | 值 | 类型 |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | 正式 widget Site Key | Config |
| `TURNSTILE_SECRET_KEY` | 同一 widget Secret Key | Secret |
| `DOWNLOAD_ALLOWED_HOSTNAMES` | `www.melodyoblivion.xyz,melodyoblivion.xyz` | Config |
| `DOWNLOAD_AUTH_SECRET` | 随机共享密钥，见下 | Secret |
| `DOWNLOAD_CDN_BASE_URL` | `https://verified-downloads.melodyoblivion.xyz` | Config |
| `DOWNLOAD_URL_TTL_SECONDS` | `900`（15 分钟） | Config |

本地生成一次共享密钥：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

生成的 64 位十六进制字符串同时填入 Vercel 和 Worker 的 `DOWNLOAD_AUTH_SECRET`，不要重复生成不同值，不要多出引号、空格或换行。真实值不要发到聊天或写入源码、`vars`、截图、日志和 Git。`.env.example` 只用于说明。

## 3. Worker 代码与 Secret

### 控制台

1. **Workers & Pages** 中创建或选择独立的 `melody-verified-downloads` Worker。
2. 通过模块编辑器部署 `download-worker.mjs`。不要把当前 `downloads` 域名对应服务覆盖掉。
3. **Settings → Variables and Secrets → Add**，类型 **Secret**，名称 `DOWNLOAD_AUTH_SECRET`，值与 Vercel 完全相同，保存并部署。
4. **Settings → Domains & Routes → Add → Custom Domain**，确认后添加 `verified-downloads.melodyoblivion.xyz`，等待域名/证书就绪。保留现有 `downloads` 的 DNS 和 R2 绑定。
5. 关闭不使用的 workers.dev 和预览 URL，不添加公共 Cache Everything 规则。

### 已有 Wrangler 时

从仓库根目录执行（会修改云端，必须先登录并核对账号）：

```powershell
npx wrangler deploy --config cloudflare/wrangler.jsonc
npx wrangler secret put DOWNLOAD_AUTH_SECRET --config cloudflare/wrangler.jsonc
```

共享密钥通过交互输入，不放在命令参数中。此配置不自动创建生产路由，域名仍按上面的控制台步骤确认后添加。

只检查打包、不上传代码或修改云端，可运行：

```powershell
npx wrangler deploy --config cloudflare/wrangler.jsonc --dry-run
```

当前源码已通过 Wrangler `4.160.0` 的 dry-run（约 `15.14 KiB`，gzip `4.71 KiB`），但这不是已上线，也不代表生产 Secrets/域名已经配置。

## 可选：官网窄路径

如果不使用独立下载域名，可将 Vercel 的 `DOWNLOAD_CDN_BASE_URL` 设置为：

```text
https://www.melodyoblivion.xyz/verified-downloads
```

并在 Worker **Domains & Routes → Add → Route** 中添加窄路由：

```text
www.melodyoblivion.xyz/verified-downloads/*
```

要求该官网主机 DNS 已通过 Cloudflare 代理，且部署前核对现有路由。不要添加 `www.melodyoblivion.xyz/*`。如使用非 www 基地址，代码也支持 `https://melodyoblivion.xyz/verified-downloads`，需设置对应窄路由。这里只处理下载路径，Vercel 页面和 `/api/*` 继续保持原样。

窄路由必须选择 **Fail closed**，不能在请求额度耗尽时绕过签名 Worker 回源。这里不是全站防机器人规则，不要给公共 R2、官网 API 或启动器更新加验证码挑战。

API、网页与 Worker 仅允许 `src/shared/website-cdn-config.json` 中的三个入口。`downloads` 公共域名与其他任意 URL 都不能用作签名入口。修改域名时必须同步修改三个允许列表和测试，不能只改环境变量。

## 4. 网站部署和验收

先准备并验证 Worker，再发布包含 `api/download-config.js`、`api/download-authorization.js`、`website-download-auth.mjs`、`website-downloader.mjs` 及网页改动的网站版本。环境变量只在新部署生效；代码已经发布但变量刚修改时，进入 **Vercel → Deployments → 对应部署 `…` → Redeploy**。

1. 官网 `/api/download-config` 返回 `enabled: true`，仅包含公开 Site Key、action 和受保护 baseUrl，不包含任何 Secret。
2. 验证失败、错误 action/hostname、过期或已消费的 token 不签发下载许可。真实 token 的单次消费由 Cloudflare Siteverify 校验。
3. 签名 Worker 的合法安装包路径在无许可、伪造/重复/过期签名时返回 403；共享密钥缺失返回 503。请求缓存与回源前都校验签名。
4. 真实官网完成一次验证后，安装包请求带 `expires` 和 `signature`；Range 返回正确的 206、Content-Range、Content-Length 和 CORS。
5. 下载页面显示进度、速度与取消；最终大小、官方 SHA-256 一致后才保存。验证失败、取消和校验失败不能自动跟随公共直链。
6. 公共 `https://downloads.melodyoblivion.xyz/releases/latest.json`、版本清单和原始安装包仍可访问，启动器自动更新不用验证码。
7. 测冷/热缓存与整包实际速度，查看 Worker 请求量、CPU 和失败结果。一次短样本或离线测试通过不等于生产性能保证。

GitHub 原始下载和网盘继续提供公开备用入口，这不意味着 R2/GitHub 文件已私有化。签名协议为 `HMAC-SHA256("download-v1\n<完整 pathname>\n<Unix 秒>")`，无填充 Base64URL。签名链接可以在有效期内被转发，不是严格一次性下载；许可默认 900 秒，最多 3600 秒。密钥轮换需要两端协调，会使旧链接失效。

离线检查：

```powershell
node --test test/download-authorization.test.js test/cloudflare-download-worker.test.js test/website-download-auth.test.js test/website-downloader.test.js test/website-download-ui.test.js
npm run check
npm run lint
npm run verify:website-browser
```

`verify:website-browser` 使用仓库已有 Electron 的真实 Chromium 运行时、隔离会话、拦截的 HTTPS 请求、假 widget 和合成字节，测试动态模块加载、四路并发、真实 Blob 保存、错误、过期、取消与桌面/移动宽度。它不访问线上 CF 验证、不使用生产凭据、不运行安装包，因此不能代替生产 Turnstile 验收。

## 资源限制与性能

- Workers Free 当前为每日 100,000 次请求、单请求 10 ms CPU，具体以 [官方限制](https://developers.cloudflare.com/workers/platform/limits/) 和账号套餐为准；每个分段、测速和重试都计请求。约 100 MiB 的安装包通常需要约 100 个分段请求，不能将额度理解为 100,000 次完整下载。
- 网络等待不计 CPU。Worker 保留原生响应流，不把整包放到 Worker 内存；最多 clone/tee 一个 1 MiB 分段作缓存，减少旧版 `exceededCpu` 风险，但离线测试不能保证生产始终低于 CPU 预算。
- Cache API 是各数据中心本地的尽力缓存，不是永久对象存储或全球预热。公开 R2 继续保留原始对象。
- 网页下载器在浏览器内存中拼接并校验完整安装包，内存需求可能高于文件大小；下载时保持页面打开。公共 GitHub/网盘仍适用于无法使用网页下载器的环境。
- 当前网络的短样本显示 R2 四路比单路快约 1.5 倍，不能证明未部署的独立域名一定快于官网窄路径。网关上线后需测实际完整文件、冷/热缓存、失败率与 CPU，再决定是否调整入口或并发，不盲目加到 32 路。

常见排错：`enabled: false` 查环境、真实 widget key、共享密钥及受保护 baseUrl；验证 API 403 查 hostname/action/token；Worker 403 查两端密钥与有效期；404 查精确路径/文件名；502 查固定上游与 Range 表示。授权错误不会关闭验证或自动开放公共下载。
