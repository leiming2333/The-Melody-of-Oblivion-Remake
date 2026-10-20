# Vercel 自定义域名与国内 CNAME 配置清单

示例域名使用 `dl.yourdomain.com`。开始前先确认域名已注册、可编辑 DNS，且该主机名没有被其他服务占用。

网站部署使用 Vercel 支持的 Node.js `24.x`，项目的 Node.js Version 设为 `24.x`。仓库根 `package.json` 的 `engines.node` 同时兼容 `24.x` 和启动器构建所需的 `26.10.0`；不要将它改回仅含 `26.10.0`，否则 Vercel 会在安装依赖前拒绝部署。启动器的 `.node-version`、CI 构建环境与 `scripts/toolchain.cjs` 继续固定为 `26.10.0`。网站 CI 单独在 Node.js 24 下安装生产依赖并运行网站 API 测试。

## 绑定到 Vercel

1. 打开 Vercel 项目 **Settings → Domains → Add**，输入 `dl.yourdomain.com` 并添加到当前网站项目。
2. 在域名 DNS 控制台新增一条记录：

   | 类型 | 主机记录 | 指向 | TTL |
   | --- | --- | --- | --- |
   | CNAME | `dl` | `cname-china.vercel-dns.com` | 默认或 300–600 秒 |

   若 Vercel 项目域名页为该域名显示了不同的专属 DNS 目标或额外验证记录，以控制台给出的值为准；不要同时保留冲突的 A、AAAA 或另一条 CNAME。
3. 等待 DNS 生效并回到 Vercel Domains 页面确认状态为 **Valid Configuration**，同时等待 Vercel 自动签发 HTTPS 证书。可在本地执行 `nslookup -type=CNAME dl.yourdomain.com` 检查 CNAME 解析结果。
4. 通过 `https://dl.yourdomain.com` 检查首页、静态资源、`/api/latest-release`、`/api/releases` 和下载重定向。首次签发证书或 DNS 传播期间可能暂时无法访问；不要绕过浏览器证书告警。

## 社区 CNAME（可选）

如果大陆 DNS 线路仍有解析问题，可在确认 Vercel 已添加并验证该域名后，单独测试社区维护的目标 `vercel-cname.xingpingcn.top`：将 `dl` 的 CNAME 暂时改为该地址，等待 DNS 刷新并复测 HTTPS。

此地址由第三方维护，不是 Vercel 官方服务，也没有可保证的 SLA。若出现 Vercel 403、证书错误、解析不稳定或目标停止维护，立即把 CNAME 改回 Vercel 项目推荐的 `cname-china.vercel-dns.com`（或控制台显示的专属目标）。切换前记录原值，修改后确认 Vercel 域名验证和 HTTPS 均恢复。

## 接入腾讯云 EdgeOne 免费版（可选）

1. 在腾讯云 EdgeOne 创建站点并按控制台要求验证域名所有权；确认免费版支持当前账号、地区、流量类型及所需功能。
2. 添加加速域名 `dl.yourdomain.com`，将源站设为 Vercel 部署域名或已验证的 Vercel 自定义域名。回源 Host 应保持为 Vercel 接受的主机名，回源使用 HTTPS，并验证源站证书。
3. 在 EdgeOne 中申请/部署客户端 HTTPS 证书。待控制台显示站点和证书正常后，将 DNS 的 `dl` CNAME 改为 EdgeOne 控制台为该站点分配的 CNAME 目标；接入后 DNS 不再直接指向 `cname-china.vercel-dns.com`。
4. 缓存带版本号的静态文件和图片，使用较长缓存时间；对 `/api/latest-release`、`/api/releases` 等动态接口遵循源站 Cache-Control 或设置短缓存。不要缓存错误响应、账号数据或未验证的重定向。先用小流量验证缓存命中、回源 Host、HTTPS、Release API 和所有下载线路。
5. 若出现 403、回源循环、证书错误、版本信息过期或下载线路异常，先在 EdgeOne 排查 Host、回源协议和缓存规则；需要回退时，将 DNS CNAME 改回 `cname-china.vercel-dns.com`，确认 Vercel 域名仍绑定后再等待 DNS 刷新。

## 效果预期与限制

- `cname-china.vercel-dns.com` 主要改变 Vercel 自定义域名的 DNS 解析路径，可能改善大陆用户访问网站首页和 Vercel API 的解析时间；实际效果受运营商、地区、DNS 缓存和 Vercel 当前路由影响，不承诺固定加速比例。
- 单独绑定自定义域名不会改变文件存储位置。本网站的下载 API 会把浏览器重定向到 GitHub Release 或镜像域名，因此安装包字节仍由这些目标主机传输；Vercel CNAME 本身不会加速 GitHub 安装包下载。
- EdgeOne 可在规则正确且缓存命中的情况下加速网站静态资源。要让安装包下载也走 EdgeOne，必须把安装包放在 EdgeOne 可缓存的源站（例如 Blob）并配置合适的缓存/Range 规则，或明确代理下载流量；这会增加流量成本、缓存一致性和回源配置工作。
- EdgeOne 接入会改变 DNS 流量入口。切换 CNAME 前先记录 TTL 和原记录，确认域名验证及 HTTPS 状态，并准备按原记录回滚。DNS 变更有传播时间，回滚也不会即时对所有解析缓存生效。

## 检查记录

每次变更后记录日期、DNS 提供商、解析结果、Vercel/EdgeOne 验证状态，并从至少一个大陆网络分别测试首页、API 响应、下载重定向和最终下载域名。若关心实际下载速度，还要在不同运营商网络测量完整文件吞吐和失败率；仅首页能打开不能证明安装包链路已经加速。
