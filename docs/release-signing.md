# 发布签名与迁移

v2.2.0 登记了 Ed25519 发布公钥及对应 GitHub Actions 私钥 secret，安装包、清单和补丁在验收后签名，客户端与镜像验证独立签名。Windows/macOS 平台证书签名及公证已接线，但未配置证书；旧版首次升级仍依赖原 SHA-256 更新链。

当前公钥 SPKI DER 的 SHA-256 指纹：`7e5ccc6204ba9faad1b9afbb5baff26ff4ba2be922a0b32a8caed1e0987ca0fb`。完整公钥位于 `src/main/updater/release-trust.json`。私钥保存在仓库外的访问受限目录并配置到 CI，不随源码或安装包分发。

## 登记公钥

在可信电脑上选择仓库之外、访问受限且有备份的目录，先创建该目录，再运行：

```powershell
node scripts/sign-release.cjs --generate-key C:\secure-release-keys\melody-release.key
```

脚本拒绝覆盖已有私钥或把私钥写入仓库。仅公钥和 SPKI DER 的 SHA-256 指纹写入 `src/main/updater/release-trust.json`。Windows 上应通过目录 ACL 限制私钥读取者，Unix 文件 mode 不能代替 Windows 权限。核对公钥后提交 JSON，并在 README 公示实际指纹。已有密钥无需为每个版本重新生成；该命令用于首次配置或有计划的轮换。

将私钥完整 PKCS#8 PEM 内容保存为 Actions secret `MELODY_RELEASE_SIGNING_KEY`，安全备份，勿写入提交、发布资产、日志或用户配置。签名函数先确认私钥与登记公钥匹配，再生成侧文件。

## 发布与客户端验证

所有正式 release 文件生成 `<文件名>.sig`，包括八类安装包、SHA-256 侧文件、`SHA256SUMS`、`release-manifest.json`、补丁和 `patch-manifest.json`。签名在构建、启动、升级验收和补丁验证之后生成，发布前再次验证签名及文件摘要。

每个 JSON 侧文件签署带固定用途前缀的规范元数据，绑定版本标签、文件名、大小和 SHA-256。客户端先通过内置公钥验证 Ed25519 签名，再下载内容并比较受签名保护的摘要。签名响应按 16 KiB 上限流式读取。

标签构建与正式发布入口默认要求已登记公钥，assemble 阶段要求私钥 secret，缺少配置即失败。手动构建仍可输出本地验收用的未签名包。离线安装夹具隔离生产签名配置，完整验签链另有真实密钥测试。

内置非空公钥列表的客户端要求完整包、补丁清单及补丁通过验签；缺失签名、未知密钥、跨版本或元数据不符不能降级为同源哈希。补丁失败仅回退到独立验签的完整包。事务保存完整包签名，重启后离线安装再次验签并核对摘要；旧无签名事务需保留当前版本后重新下载。R2、Blob 同步先验本地签名，再不可覆盖地上传并回读验证，最后更新 latest。

空公钥列表只用于迁移准备阶段的源码兼容，此时客户端保留原有 SHA-256 行为。首次迁移必须先准备源码公钥和 CI 私钥，再发布新版本；旧客户端取得内置公钥版本的首次引导仍依赖旧更新链，已有公开二进制无法追溯加固。轮换时先发布同时信任旧、新公钥的客户端，再改用新私钥，避免旧客户端断更。签名不能阻止合法发布者签署恶意版本，也不能证明服务返回的“已是最新”确实最新。

## Windows 签名与 macOS 公证

CI 使用 electron-builder 自带证书签名和 `@electron/notarize` 集成，接入以下 secrets：

| 配置 | 用途 |
| --- | --- |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows Authenticode 证书和密码 |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS Developer ID Application 证书和密码 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple 公证身份 |

证书来源支持 electron-builder 认可的 `CSC_LINK` 格式，建议使用 secret 中的 base64 内容。macOS 启用 hardened runtime，entitlements 允许 Electron JIT 及打包本地模块。仓库变量 `MELODY_REQUIRE_CODE_SIGNING=true` 会强制 Windows/macOS 有效签名，macOS 还要求公证凭据齐全；缺少配置即中止。Linux 使用独立发布签名。

证书须由维护者申请配置。本次没有证书，未执行 Authenticode、Apple 公证或全平台签名实机验收。强制变量未开启时仍可生成未做平台签名的测试包；不要仅凭配置宣称产物已经签名。

## 第三方验签

从可信源码或独立公示渠道取得公钥并核对指纹，使用 `src/main/updater/release-signature.js` 的 `verifyAssetSignature` 验证 `.sig`，明确传入期望版本、文件名和大小，再计算下载文件 SHA-256 与返回值 `sha256` 比较。不要从同一个未知镜像首次获取并直接信任公钥。
