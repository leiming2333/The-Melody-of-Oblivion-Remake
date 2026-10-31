# Vercel Blob 安装包迁移方案

## 当前状态

- Vercel 静态输出目录是仓库根目录 `.`；`.vercelignore` 忽略 `release/`，因此本地安装包不会被当前网站部署上传。
- 本地 `release/` 中已有约 89.6 MiB 的 Windows EXE 样本。Blob 容量应按当前 Release 的 Windows x64、ia32、arm64 三个 EXE 大小之和估算；macOS ZIP 和 Linux AppImage 不纳入同步范围。
- GitHub Actions 会为安装包生成 `.sha256` 文件并保留在 GitHub Releases；站点日志仍从 GitHub Release API 读取。
- `download` Public Blob Store 已连接到网站项目，启用了 `BLOB_READ_WRITE_TOKEN`，区域为 HKG1。
- 网站和 Release 工作流现已支持 Blob：GitHub Releases 仍发布完整八包及校验文件；Blob 只同步 Windows x64、ia32、arm64 三个 portable EXE，上传至 `releases/<tag>/` 并回读校验后，最后更新仅含这三个 EXE 的 `releases/latest.json`。Windows 对象不存在时回退 GitHub，macOS、Linux 下载继续使用 GitHub。
- 网站 `/api/latest-release` 先核实 GitHub 最新版本，再合并同版本、同大小、同 SHA-256 的 Blob 下载地址；Windows 更新可直接下载公共 Blob URL，macOS、Linux 资产保留 GitHub 地址。Blob 连接失败、停滞或速度过慢时，按清单中的 `github_download_url` 切换 GitHub 镜像与官方源；若资产仍使用 GitHub 地址，启动器先尝试网站 `/api/download?source=blob`，对象不存在时由该接口回退 GitHub。更新包仍校验大小和 SHA-256，客户端无需 Blob 写入令牌。
- 自动同步还需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加 `BLOB_READ_WRITE_TOKEN`。该值应从 Vercel Blob Store 凭据中取得，不要提交到仓库。
- 已有 Release 可在 GitHub Actions 中运行 **Sync an existing release to Vercel Blob**，输入 tag（例如 `v1.6.1`）进行首次回填。

## 迁移步骤

1. Public Blob Store 已创建并连接项目。Public Blob 的读取 URL 可公开访问，写入凭据必须保密。
2. 将 `BLOB_READ_WRITE_TOKEN` 添加为 GitHub 仓库 Actions Secret，使 Release workflow 可以上传对象。Vercel 项目自身已通过 Store 连接获得该变量。
3. Release workflow 在发布完整 GitHub Release 后，运行 `scripts/sync-release-to-blob.mjs`，仅上传 Windows x64、ia32、arm64 三个 portable EXE。手动回填只从 GitHub 下载 `*-Windows-*.exe` 和 `release-manifest.json`。对象路径固定为 `releases/<tag>/<asset-name>`；不同 tag 不会互相覆盖，同一 tag 仅允许相同发布清单的幂等重跑。

4. 上传脚本先核对三个 Windows EXE 的大小、SHA-256 与完整发布清单，逐个上传并回读验证。完整 `release-manifest.json` 原样保存为 `releases/<tag>/manifest.json`，用于来源验证和同标签不可变校验；其中保留八个平台的构建记录，不表示这些包都已同步至 Blob。最后写出的 `releases/latest.json` 仅列出三个 Windows EXE，以下为其中一项：

```json
{
  "tag_name": "vX.Y.Z",
  "assets": [
    {
      "name": "The-Melody-of-Oblivion-Remake-Windows-x64.exe",
      "platform": "Windows-x64",
      "size": 93960000,
      "digest": "sha256:<64 位十六进制值>",
      "browser_download_url": "https://<public-blob-url>",
      "github_download_url": "https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>"
    }
  ]
}
```

5. 只有三个 Windows EXE 都上传并回读校验成功后才更新 `releases/latest.json`，避免网站指向未完成的上传；回填旧版本不会覆盖已知的更新版本。
6. `api/latest-release.js` 核实 GitHub 最新发布与校验值，仅为匹配的 Windows 资产合并 Blob 下载 URL。macOS、Linux 和其他 GitHub 资产继续保留，页面的其他线路及 GitHub 原始链接也保留。
7. 配置 GitHub Actions Secret 后，创建一个测试 Release 验证 Windows Blob 下载、SHA-256、Range/断点续传和 GitHub 回退链路，并确认 macOS、Linux 仍从 GitHub 下载。若 Secret 尚未配置，Release 会正常发布到 GitHub，但 Blob 同步会跳过并给出提示。

### 浏览器直传结构（备选）

若未来需要从管理页面上传而非由 CI 上传，可安装 `@vercel/blob` 的客户端模块 `@vercel/blob/client`，由浏览器调用受保护的 `/api/blob-upload`，服务端使用 `handleUpload` 生成一次性上传授权，浏览器再直接将文件传至 Blob。授权回调必须验证登录身份、tag、允许的资产名、内容类型和最大文件大小；完成回调应校验 SHA-256 并更新清单。当前网站没有管理端身份认证，因此不能开放匿名上传；现阶段优先采用 GitHub Actions 上传脚本。

## 免费额度粗算

按任务输入的免费额度假设：1 GB 存储、每月 10 GB 传输。单个约 90 MiB 的 Windows EXE 约可存 11 份，约 114 次完整下载会消耗 10 GiB 传输；若三个架构均按该样本估算，每个版本约占 270 MiB，约可保留三个完整版本。正式估算须使用当前三个 EXE 的实际大小，并计入清单及已存历史对象。三个 Windows 架构及所有用户的 Blob 下载共用额度，传输量按当月实际读取累计；macOS ZIP 和 Linux AppImage 的 GitHub 下载不计入 Blob 用量。删除旧 Blob 可回收存储，但不能依赖它减少已发生的传输量。

以上是按样本大小的数量级估算，不是 Vercel 当前计费承诺。上线前应在 Vercel 控制台复核账号适用计划、当期免费额度、超额单价、带宽计量方式和缓存命中规则；超过免费额度可能产生费用或影响服务，需设置用量告警和旧版本保留策略。

## 风险与回退

- 公共 Blob URL 可被任何持有链接的人访问；不要上传账户数据、配置文件或非公开构建物。
- Blob URL 的公开访问不保证中国大陆链路一定快。先小流量验证不同运营商的首字节时间、完整下载和 Range 请求，再考虑切换默认下载线路。
- 上传成功但清单未更新会留下孤立 Blob；清单先更新则可能产生失效链接。按“上传三个 Windows EXE → 回读校验 → 发布清单”的顺序执行。
- 误删或替换 Blob 会破坏旧 Release 的可用性。采用 tag 版本化路径，生产环境避免复用对象名或覆写已发布文件。
- 保留 GitHub Releases URL 及现有镜像选项作为回退；清单、Blob 或配额异常时可将网站默认线路切回 GitHub，并在 Vercel 用量恢复后再评估迁移。

## 是否值得迁移

当前网站已有 GitHub Release API 与多条镜像线路，尚无证据证明 Blob 会改善大陆各运营商的下载速度。Blob 的主要收益是统一文件分发、由站点控制清单和下载 URL；代价是新增上传凭据、清单发布流程、配额监控和另一种故障面。建议先用一两个版本的小流量验证，并继续保留 GitHub 回退；若实测没有改善或下载量接近免费传输额度，就没有迁移必要。
