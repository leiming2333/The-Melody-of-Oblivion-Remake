# Microsoft 设备代码登录

账户管理 → 设备代码登录 → 打开授权网页，在浏览器输入页面显示的代码。授权成功后自动保存并选中账户；关闭账户管理或点击取消会停止本窗口的轮询。

使用公共客户端 `72867f11-f8bf-4086-a502-39039a08970c`，消费者账户端点及 XboxLive.signin / offline_access scope，不使用客户端密钥。需要应用注册允许设备代码流，且应用具有 Minecraft 服务使用权限；仅提供 Client ID 不能保证后者。

Minecraft 访问令牌和 Microsoft 刷新令牌沿用系统 safeStorage 加密保存，不暴露给渲染页面。启动时仅在凭据过期后刷新；刷新不会改变用户已切换的当前账户。历史账户沿用其原 Client ID 刷新，不跨应用交换令牌。

本次验证：模拟 OAuth → Xbox → XSTS → Minecraft → profile 全链路，pending/slow_down/拒绝/取消/刷新及加密存储测试；没有代替用户进行真实账户授权，也未验证真实正版游戏启动。真实登录遇到权限拒绝时需检查应用注册与 Minecraft 服务资格。
