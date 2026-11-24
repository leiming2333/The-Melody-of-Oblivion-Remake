# Microsoft Client ID 与登录配置

启动器保留现有内置 Microsoft Client ID：`72867f11-f8bf-4086-a502-39039a08970c`。它是公开的 OAuth 应用标识，不是密码或客户端密钥。

当前仓库没有足以确认该 ID 已通过 Minecraft Services 应用审核的证据，因此账户管理和高级登录设置显示「审核状态未确认」。这不表示它已被拒绝。设备代码登录、Microsoft OAuth 或 Xbox 授权成功，均不能单独证明 Minecraft Services 已允许该应用；最终结果以服务响应及应用所有者的审核记录为准。

## 自有应用与覆盖顺序

应用所有者或分叉维护者可在 Microsoft Entra 管理中心注册面向个人 Microsoft 账户的应用，启用公共客户端设备代码登录，并按照 Microsoft / Minecraft 当前要求配置应用。Minecraft Services 的第三方应用注册与审核入口见 [AppRegInfo](https://aka.ms/AppRegInfo)。审核流程会变更，应以官方页面为准；不要复制其他启动器的应用 ID。

在「启动与更新设置 → 高级登录设置」填写自己的公开 Client ID，保存后会用于新发起的 Microsoft 登录。留空恢复内置 ID。界面和后台均校验 UUID 格式，但格式有效不代表配置正确或审核通过。

优先顺序为：

1. 启动进程的 `MELODY_MICROSOFT_CLIENT_ID` 环境变量。
2. 已保存的自有 Client ID。
3. 启动器内置 Client ID。

环境变量生效时输入框只读，并显示覆盖来源。环境变量格式错误时明确报告配置错误，不静默回退。设置通过现有原子写入和备份恢复机制保存。Client ID 是公开信息，不需要放入凭证库。

每次新登录在主进程重新读取配置；登录会话创建后固定使用当时的 ID。已保存账户的令牌刷新继续使用账户原先授权的 ID，修改设置不会让旧刷新令牌改用其他应用。需要转换应用时，应重新登录同一 Microsoft 账户。

构建时可设置 `MELODY_MICROSOFT_CLIENT_ID`，再运行 `node scripts/generate-client-id.js` 将自己的 ID 写入打包配置。该脚本不会申请应用、获取审核状态或自动授予游戏服务访问权限。

## 应用注册被拒绝时

`Invalid app registration` 表示 Minecraft Services 拒绝当前应用注册，不应引导玩家更改密码或反复切换网络。玩家可以联系维护者；应用所有者应核对自己的 Client ID 与审核记录。界面同时提供「使用离线账户」和「使用 LittleSkin」入口：离线账户适用于单人和允许离线身份的服务器；LittleSkin 适用于支持其外置登录的服务器，二者均不能替代正版服务器验证。

启动器不读取或导入官方启动器的账户令牌。
