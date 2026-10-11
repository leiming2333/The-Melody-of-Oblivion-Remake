# Vercel Blob 安装包迁移方案

## 当前状态

- Vercel 静态输出目录是仓库根目录 `.`；`.vercelignore` 忽略 `release/`，因此本地安装包不会被当前网站部署上传。
- 本地 `release/` 中现有 Windows 产物约为 89.6 MiB（EXE）和 139.4 MiB（ZIP）。这只是已找到的 Windows 样本，不代表最新 Release 的全部平台产物；正式估算应在 CI 对当前 Release 的全部 `.exe`、`.zip`、`.AppImage` 求和。
- GitHub Actions 已在 `.github/workflows/build.yml` 为安装包生成 `.sha256` 文件并上传到 GitHub Releases。当前站点从 GitHub Release API 读取版本和资产，`api/download.js` 重定向到 GitHub 或镜像。
- 仓库未安装 `@vercel/blob`，也未配置 Blob token。

## 迁移步骤

1. 在 Vercel 项目中打开 **Storage → Blob → Create Store**，选择 **Public**，将 Store 连接到网站项目。Public Blob 的读取 URL 可公开访问，写入凭据必须保密。
2. 在 Vercel 项目环境变量中创建 `BLOB_READ_WRITE_TOKEN`，仅放入生产/预览部署环境及受信任的 GitHub Actions Secret。不要写入 `index.html`、`site.js`、仓库 JSON 或客户端代码。
3. 在构建环境安装 `@vercel/blob`，提交 `package.json` 与锁文件。建议新增 `scripts/upload-release-assets.mjs`，由 GitHub Actions Release job 在生成 SHA-256 后调用。脚本上传当前 tag 的安装包和校验文件，路径固定为 `releases/<tag>/<asset-name>`，禁止覆盖不同 tag 的文件。

示意代码：

```js
import { readFile } from 'node:fs/promises';
import { put } from '@vercel/blob';

const blob = await put(`releases/${tag}/${assetName}`, await readFile(filePath), {
  access: 'public',
  addRandomSuffix: false,
  contentType: contentTypeFor(assetName),
  token: process.env.BLOB_READ_WRITE_TOKEN
});
```

4. 上传脚本逐个读取资产的 SHA-256，并写出清单，例如 `releases/<tag>/manifest.json`：

```json
{
  "tag": "vX.Y.Z",
  "assets": [
    {
      "name": "The-Melody-of-Oblivion-Remake-Windows-x64.exe",
      "platform": "Windows-x64",
      "size": 93960000,
      "sha256": "由构建产物计算的 64 位十六进制值",
      "url": "https://<public-blob-url>"
    }
  ]
}
```

5. 上传完当前版本的所有资产后，最后更新一个 `latest.json` 清单，包含 tag、Release 页面 URL、每个平台的文件名/大小/SHA-256/Blob URL。只有全部资产上传成功后才发布新清单，避免网站指向未完成的上传。
6. 让 `api/latest-release.js` 从 Blob 的 `latest.json` 返回相同字段，让 `site.js` 从这份 JSON 取版本、下载 URL 和校验值；`api/download.js` 校验平台、文件名和 URL 后重定向到 Blob URL。迁移期保留 GitHub Releases 作为故障回退，官方线路或清单不可用时仍可跳转 GitHub。
7. 在 Release job 中先上传 Blob，再发布或更新 `latest.json`，最后保留当前 GitHub Release 上传步骤。验证 Windows、macOS、Linux 每个资产的下载、SHA-256、浏览器 Range/断点续传行为和回退链路后，再决定是否停止 GitHub 镜像线路。

### 浏览器直传结构（备选）

若未来需要从管理页面上传而非由 CI 上传，可安装 `@vercel/blob` 的客户端模块 `@vercel/blob/client`，由浏览器调用受保护的 `/api/blob-upload`，服务端使用 `handleUpload` 生成一次性上传授权，浏览器再直接将文件传至 Blob。授权回调必须验证登录身份、tag、允许的资产名、内容类型和最大文件大小；完成回调应校验 SHA-256 并更新清单。当前网站没有管理端身份认证，因此不能开放匿名上传；现阶段优先采用 GitHub Actions 上传脚本。

## 免费额度粗算

按任务输入的免费额度假设：1 GB 存储、每月 10 GB 传输。单个约 90 MiB 的 EXE 约可存 11 份，约 114 次完整下载会消耗 10 GiB 传输；约 139 MiB 的 ZIP 约可存 7 份，约 74 次完整下载会消耗 10 GiB 传输。多平台资产和所有用户下载共用传输额度，实际容量按当月所有资产流量累计；旧版本保留越多，越快触及 1 GB 存储上限。删除旧 Blob 可回收存储，但不能依赖它减少已发生的传输量。

以上是按样本大小的数量级估算，不是 Vercel 当前计费承诺。上线前应在 Vercel 控制台复核账号适用计划、当期免费额度、超额单价、带宽计量方式和缓存命中规则；超过免费额度可能产生费用或影响服务，需设置用量告警和旧版本保留策略。

## 风险与回退

- 公共 Blob URL 可被任何持有链接的人访问；不要上传账户数据、配置文件或非公开构建物。
- Blob URL 的公开访问不保证中国大陆链路一定快。先小流量验证不同运营商的首字节时间、完整下载和 Range 请求，再考虑切换默认下载线路。
- 上传成功但清单未更新会留下孤立 Blob；清单先更新则可能产生失效链接。按“上传全部资产 → 校验 → 发布清单”的顺序执行。
- 误删或替换 Blob 会破坏旧 Release 的可用性。采用 tag 版本化路径，生产环境避免复用对象名或覆写已发布文件。
- 保留 GitHub Releases URL 及现有镜像选项作为回退；清单、Blob 或配额异常时可将网站默认线路切回 GitHub，并在 Vercel 用量恢复后再评估迁移。

## 是否值得迁移

当前网站已有 GitHub Release API 与多条镜像线路，尚无证据证明 Blob 会改善大陆各运营商的下载速度。Blob 的主要收益是统一文件分发、由站点控制清单和下载 URL；代价是新增上传凭据、清单发布流程、配额监控和另一种故障面。建议先用一两个版本的小流量验证，并继续保留 GitHub 回退；若实测没有改善或下载量接近免费传输额度，就没有迁移必要。
