# 官网下载：Turnstile 验证与低 CPU Worker

官网先完成 Cloudflare Turnstile 验证，Vercel 服务端验证成功后签发短期下载链接；现有 `melody-downloads` Worker 校验签名，再从固定 Blob/GitHub 源返回安装包。继续使用现有下载源、域名和 Cache API，无需新增对象存储桶或存储访问凭据。

保护范围是官网的新验证入口以及此 Worker 的安装包资源。旧 `/api/download` 仍供桌面启动器更新使用，是公开重定向接口；GitHub Release、现有公共 Blob 和网盘链接也保持公开，不受 Turnstile 限制。本方案不能把已经公开的发行文件变成仅真人可访问的私有文件。

## 请求流程

1. 官网请求 `GET /api/download-config`，只得到 `enabled`、公开 `siteKey` 和 `action: "download"`。
2. 用户点击下载，完成 Turnstile；前端将一次性 token、版本 `tag` 和精确 `asset` 名发送到同源 `POST /api/download-authorization`。
3. Vercel 调用 Cloudflare Siteverify，要求 `success: true`、`action: "download"` 和配置中的精确 hostname 全部匹配。验证失败、过期或服务不可用时不签发链接。
4. API 返回仅对该版本、该安装包有效的链接及 `expiresAt`。默认有效期 900 秒；同次下载的测速、并行 Range、重试共用这一个链接，不对每个分块弹验证码。
5. Worker 在读取缓存或回源之前验证签名。没有签名、签名错误或过期返回 403；未配置共享密钥返回 503。合法路径的 CORS `OPTIONS` 预检返回 204，不读取安装包。

签名链接格式：

```text
https://downloads.melodyoblivion.xyz/releases/v1.9.1/The-Melody-of-Oblivion-Remake-Windows-x64.exe?expires=<Unix秒>&signature=<Base64URL-HMAC>
```

HMAC-SHA256 的 UTF-8 原文为 `download-v1\n<pathname>\n<expires>`，摘要使用无填充 Base64URL。Vercel 与 Worker 必须使用完全相同的 `DOWNLOAD_AUTH_SECRET` 字节，不要一侧多出空格或换行。签名绑定安装包路径和失效时间，允许 GET/HEAD 和不同 Range 复用；不绑定 IP。持有链接的人在有效期内可以复用或转发它，因此它是限时下载授权，不是严格一次性访问或绝对的真人证明。

## 配置

[.env.example](.env.example) 是配置清单。真实凭据应保存在 Vercel 环境变量及 Cloudflare Worker Secret 中；不要提交 `.env`，不要将密钥放入前端、`wrangler.jsonc` 的 `vars`、截图或日志。

| 变量 | 配置位置 | 内容 |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | Vercel | 生产 Turnstile 站点的公开 Site Key。 |
| `TURNSTILE_SECRET_KEY` | Vercel Secret | 同一站点的 Secret Key，仅服务端使用。 |
| `DOWNLOAD_ALLOWED_HOSTNAMES` | Vercel | 允许的官网 hostname，逗号分隔，例如 `www.melodyoblivion.xyz,melodyoblivion.xyz`。填写纯主机名，不加协议、路径或通配符。 |
| `DOWNLOAD_AUTH_SECRET` | Vercel Secret **及** Worker Secret | 同一个随机共享密钥，至少 32 个 UTF-8 字节。建议使用 32 个随机字节生成的 64 位十六进制字符串。 |
| `DOWNLOAD_CDN_BASE_URL` | Vercel，可选 | 当前前后端固定只允许生产根地址 `https://downloads.melodyoblivion.xyz`；不得改成 `workers.dev` 或其他域名，也不得包含路径前缀、端口、查询或片段。未设时使用 `src/shared/website-cdn-config.json` 的 `baseUrl`，仍须满足此域名限制。 |
| `DOWNLOAD_URL_TTL_SECONDS` | Vercel，可选 | 默认 `900`，仅接受 `60` 到 `3600` 的整数秒。Worker 拒绝超过一小时的授权。 |

配置缺失或无效时，`/api/download-config` 返回 `enabled: false`，授权接口返回 503。公开的 Turnstile 测试 key 不允许用作生产配置。

下载域名在授权 API 与前端链接校验中使用同一固定允许列表。迁移下载域名需要同时修改两处允许列表并验证；仅更改环境变量会关闭验证下载，不会签发前端无法使用的链接。

### Cloudflare Turnstile

在 Cloudflare 的 Turnstile 中添加官网 widget，将允许的 hostname 限定为实际使用的官网主机名，并与 `DOWNLOAD_ALLOWED_HOSTNAMES` 保持一致。推荐 Managed 模式。Site Key 用于前端 widget，Secret Key 仅放在 Vercel。代码将 widget action 设置为 `download`，服务端也要求该 action；不能仅依靠前端回调显示“成功”。

预览域名不会自动获得生产权限。需要验证预览环境时，单独配置明确的预览 hostname 和适当的 widget；不要用 `*` 放开所有来源。Turnstile token 只能由 Siteverify 消费一次；超时或验证失败后应由用户重新完成验证。参考 [Turnstile 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。

### Worker 与网站部署

1. 将同一个 `DOWNLOAD_AUTH_SECRET` 分别保存至 Vercel 项目和 `melody-downloads` Worker 的 Secret。Worker 不需要 Turnstile Secret Key。
2. 在现有 Worker 模块编辑器部署 [download-worker.mjs](download-worker.mjs)，保留 `downloads.melodyoblivion.xyz` 的现有自定义域名。已有 Wrangler 的环境也可使用 [wrangler.jsonc](wrangler.jsonc)；配置文件中的域名是实际现有域名，部署前核对用途。
3. 在 Vercel 配好其余变量，部署包含新官网代码、`api/download-config.js` 和 `api/download-authorization.js` 的版本。环境变量变更后重新部署网站。
4. 两端发布需要协调：新 Worker 会拒绝旧官网的无签名请求。先在测试环境验证，再连续发布两端；不要只更新其中一端就宣布迁移完成。
5. 不要给 `downloads` 域名另加“Cache Everything”来缓存受保护响应。浏览器响应是 `private, no-store, no-transform`，授权后只使用 Worker 内部 Cache API。

已有 Wrangler 时可从仓库根目录执行以下部署命令；这会修改云端，不是本地测试：

```powershell
wrangler secret put DOWNLOAD_AUTH_SECRET --config cloudflare/wrangler.jsonc
wrangler deploy --config cloudflare/wrangler.jsonc
```

轮换密钥会使已签发的链接立即失效。Vercel 与 Worker 应协调使用新密钥；当前实现不提供双密钥过渡。

## 低 CPU 转发与缓存

- 安装包体直接返回原生 `fetch` 响应流，保留网络背压。移除了 `getReader()` 逐块处理、`FixedLengthStream` 包装、每块的 `Promise.race` 和定时器，不再由 JavaScript 循环复制整包数据。
- 大于 1 MiB 的整包响应原生透传，不写整包缓存；不把约 100 MB 的安装包 tee 到缓存。已知长度不超过 1 MiB 的响应可使用原生 `response.clone()` 与 `cache.put()`；官网的 1 MiB 对齐分块和 EOF 末块使用独立缓存 key。测速小片段通常不写分段缓存。
- 内部 cache key 使用 `/.melody-cache/v2/`，不包含短期签名，可在验证通过的不同下载间共享；签名验证始终先于缓存读取。内部成功对象缓存一年，对浏览器仍返回 `private, no-store, no-transform`。
- HEAD 不消费安装包体。单请求只接受一个 Range，多 Range 返回 416；不在 Worker 内组装多个块。缓存写入错误被捕获，不能因此中断正在返回的下载。
- 只接受现有八种精确安装包名和 `v数字.数字.数字` 版本；只接受 `expires`、`signature` 两种查询参数。未知路径或参数返回 `404 Unknown release asset`。回源 URL 和仓库固定，不能用作任意 URL 代理。
- Windows 优先读取固定公共 Blob，失败时读取 GitHub；Linux/macOS 使用 GitHub。只跟随受限的 GitHub 资源重定向，保持 HTML/JSON 错误页、压缩表示与 Range 校验，官网继续校验完整文件大小及 SHA-256。

免费计划的请求数量与 CPU 时间是两种限制：Workers Free 通常有每日 100,000 次请求额度，单次请求有 10ms CPU 预算。分块、重试、测速也会产生请求；网络等待时间与 CPU 实际运算时间不同。减少逐块 JavaScript 工作是为降低此前 `exceededCpu` 的风险，不等于承诺所有请求在线上一定低于 10ms。套餐、子请求和其他限制仍以账号控制台及 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 为准。

Cache API 是各数据中心本地的尽力缓存，不能代替永久对象存储，也不提供全球预热或本方案中的 Tiered Cache。不同数据中心可能重复 MISS；大陆下载速度仍需要实际网络验证。

## 验收与排错

从仓库根目录执行离线检查，无需登录 Cloudflare：

```powershell
node --test --test-isolation=none test/cloudflare-download-worker.test.js test/download-authorization.test.js
npm run check
npm run lint
```

线上应按顺序验证：

1. `GET /api/download-config` 只返回公开配置，不包含共享密钥或 Turnstile Secret。
2. 不带 token、错误 token、过期 token、错误 action 或错误 hostname，均不能取得签名链接。合法 token 消费一次后，重放授权请求应失败。
3. 不带签名直接请求一个合法 Worker 安装包路径，GET/HEAD 均为 403；修改版本、文件名、过期时间或签名不能读缓存或回源。无共享密钥时为 503，而不是开放下载。
4. 从真实官网完成一次验证并下载；Network 中的安装包请求应带 `expires` 与 `signature`。同一次并行下载只消费一次 Turnstile token；完整下载后核对官方文件大小和 SHA-256。
5. 对同一有效链接读取 `Range: bytes=0-1048575`，应返回 206、正确的 `Content-Range`、`Content-Length`、CORS 和私有缓存响应头。同一数据中心重复完整读取该分块后，`X-Melody-Cache` 可显示 HIT。当前有效链接只保存在本地测试环境中，不要提交到工单或公开日志。
6. 比较冷缓存、热缓存、并行分块以及整包下载的 `cpuTimeMs`、`outcome` 和成功字节数，确认是否仍有 `exceededCpu`。本地测试通过不能证明生产 CPU 配额已经满足。历史“错误 7”是时间窗口内的计数，不会因发布或重试立刻清零，应查看新请求。

| 现象 | 检查项 |
| --- | --- |
| 官网显示验证下载未配置 / API 503 | Vercel 变量、CDN 根地址、非测试 Turnstile key、共享密钥长度。 |
| Turnstile 看似成功但 API 403 | widget hostname、`DOWNLOAD_ALLOWED_HOSTNAMES`、action 是否为 `download`，token 是否过期或已消费。 |
| 已取得链接但 Worker 403 | 两端共享密钥是否完全一致，链接是否过期，查询参数是否重复或被修改。 |
| Worker 503 | Worker 是否实际保存了有效的 `DOWNLOAD_AUTH_SECRET` Secret。 |
| `404 Unknown release asset` | URL 路径、版本格式、精确文件名及额外查询参数。 |
| `404 Release asset not found` / 502 | 合法资源的固定上游是否存在、Range/内容表示及上游网络是否正常。 |
| 仍有 `exceededCpu` | 生产是否部署了新 Worker、是否真的走原生透传，按具体请求及冷热缓存测 CPU。 |

回滚应成对回滚网站和 Worker，避免新旧授权协议不一致。旧公开模式的回滚会恢复无验证的 Worker 下载；这应是明确的运维决策，不能把关掉验证当成验证成功。
