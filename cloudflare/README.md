# Cloudflare 下载 CDN

`download-worker.mjs` 可以直接粘贴到 Cloudflare Dashboard 的模块 Worker 编辑器。无需 token、账户 ID、R2、数据库或付费绑定。此目录只提供实现，不会创建资源或配置域名。

公开 URL 固定为：

```text
https://<你的 Worker 域名>/releases/v1.9.1/The-Melody-of-Oblivion-Remake-Windows-x64.exe
```

仅接受仓库现有八种安装包名与 `v数字.数字.数字` 版本。Windows 优先从固定 Blob 主机读取，失败时从固定 GitHub 仓库读取；Linux/macOS 从 GitHub 读取。Worker 在边缘跟随受限的 GitHub 资源重定向，并返回文件内容，不把浏览器重定向到原站。不接受 URL、源站、仓库或文件路径查询参数。

## 部署

1. 在 Cloudflare Dashboard 创建 Worker，将 `download-worker.mjs` 的完整内容替换进编辑器并部署。
2. 先用生成的 `workers.dev` 地址验证下列请求的转发、CORS 和 Range。只有 200/206、实际字节数、最终网站校验都通过，才启用官网 CDN 线路。
3. 如需自定义域名，可检查 `downloads.melodyoblivion.xyz` 是否已有 DNS 或 Worker 用途，再在 Worker 的 Domains & Routes 添加该域名。这里没有硬配任何路由。生产缓存命中需在实际自定义域名/route 上验证；`workers.dev` 或 Dashboard Preview 的转发结果不能证明边缘缓存可用。
4. 将验证后的根地址（不含 `/releases`）写入 `src/shared/website-cdn-config.json` 的 `baseUrl` 并发布网站，或在 Vercel 配置优先级更高的 `CDN_BASE_URL` 后重新部署。两处都未配置时，官网不会启用这条线路。这个 Worker 直接部署在根域名下；如在外层自行配置路径前缀，需先重写到这里的 `/releases/...` 路径。

安装本地 Wrangler 的用户也可在此目录使用 `wrangler.jsonc`，但本地测试不需要 Wrangler、登录或联网：

```powershell
node --test --test-isolation=none test/cloudflare-download-worker.test.js
```

从仓库根目录执行上面的测试命令。代码没有使用 Node 专属 API，默认导出符合 Worker 模块格式。

## 验证

将域名替换成实际部署地址：

```powershell
curl.exe -I "https://<域名>/releases/v1.9.1/The-Melody-of-Oblivion-Remake-Windows-x64.exe"
curl.exe -D range-headers.txt -H "Range: bytes=0-1048575" -o range.bin "https://<域名>/releases/v1.9.1/The-Melody-of-Oblivion-Remake-Windows-x64.exe"
```

`HEAD` 应为 200，当前 v1.9.1 Windows x64 长度为 103871652。Range 应为 206，`Content-Range: bytes 0-1048575/103871652`，`Content-Length: 1048576`，并有 `Access-Control-Allow-Origin: *`。在相同位置重复完整读取 Range 后，`X-Melody-Cache` 应能显示 HIT；网络请求落到不同数据中心时可能仍为 MISS。需额外从实际官网运行一次完整下载，验证全部字节及官网已有的 SHA-256 校验。

## 缓存与限制

- 整包 200 采用流式转发与带背压的缓存分流，不调用整包 `arrayBuffer()`，不会为约 99 MB 安装包创建整包内存副本。Cloudflare 环境使用 `FixedLengthStream` 保留已知字节长度，供完整缓存生成 Range；Node 测试环境使用标准流回退。消费者取消或源站流截断时不会保存不完整缓存。
- 网站使用 1 MiB 对齐分段。完整分段与 EOF 末段存入固定范围的独立 key，把源站 206 转存为内部 200，命中后恢复 206。32 KiB 测速、其他大小/位置、开放区间和后缀 Range 正常转发，通常不写分段缓存。完整对象已经缓存时，Cloudflare Cache API 也可从它生成 Range。
- 单请求只转发一个 Range，不组装多个块；多 Range 请求返回 416。HEAD 返回整包头，不读取/缓存文件体。
- 仅成功的版本化安装包缓存一年；404、错误、HTML 错误页和元数据不写缓存。版本发布后应保持不可变，替换同一版本需要主动清除缓存。
- 缓存读写失败不会中断交付；缓存写入持续背压超过 1 秒时，放弃本次缓存写入。缓存不可用时仍可从源站流式下载。
- Cache API 是各 Cloudflare 数据中心本地的尽力缓存，不提供全球预热、永久存储或 Tiered Cache。首次请求仍需要回源；中国大陆访问表现取决于网络，不能保证线路速度。对象大小、请求量、Worker 运行与套餐限额仍适用。
