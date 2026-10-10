const { setTimeout: wait } = require('node:timers/promises');

const CLIENT_ID = '72867f11-f8bf-4086-a502-39039a08970c';
const OAUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

class MicrosoftAuth {
  constructor({ accountStore, fetchImpl = fetch, waitImpl = wait, now = Date.now }) {
    this.accountStore = accountStore;
    this.fetch = fetchImpl;
    this.wait = waitImpl;
    this.now = now;
    this.sessions = new Map();
    this.refreshes = new Map();
  }

  cancelOwner(owner) {
    this.sessions.get(owner)?.abort();
  }

  async request(url, body, signal, form = false) {
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    const data = await response.json();
    // Never include response bodies: OAuth responses may contain credentials.
    if (!response.ok) {
      const error = new Error(`Microsoft 登录失败：${data.error === 'access_denied' ? '用户拒绝授权' : data.error === 'expired_token' ? '设备代码已过期，请重试' : `HTTP ${response.status}，请检查账户权限或重新登录`}`);
      error.authCode = data.error;
      if (data.XErr === 2148916233) error.message = 'Xbox 账户尚未创建，请先登录 xbox.com 完成账户设置';
      if (data.XErr === 2148916238) error.message = 'Xbox 账户需要家长授权，请检查家庭账户设置';
      throw error;
    }
    return data;
  }

  async login(owner, notify) {
    if (this.sessions.has(owner)) throw new Error('Microsoft 登录正在进行，请等待或取消');
    const controller = new AbortController();
    this.sessions.set(owner, controller);
    const signal = controller.signal;
    try {
      const code = await this.request(`${OAUTH}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE }, signal, true);
      if (!code.device_code || !code.user_code || !Number.isFinite(code.expires_in) || code.expires_in <= 0) {
        throw new Error('Microsoft 设备代码响应无效，请重试');
      }
      notify({ userCode: code.user_code, verificationUri: 'https://www.microsoft.com/link', expiresIn: code.expires_in });
      const deadline = this.now() + code.expires_in * 1000;
      let interval = Math.max(1, Number(code.interval) || 5) * 1000;
      while (this.now() < deadline) {
        await this.wait(Math.min(interval, deadline - this.now()), undefined, { signal });
        signal.throwIfAborted();
        if (this.now() >= deadline) break;
        let token;
        try {
          token = await this.request(`${OAUTH}/token`, {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: code.device_code
          }, signal, true);
        } catch (error) {
          if (error.authCode === 'authorization_pending') continue;
          if (error.authCode === 'slow_down') { interval += 5000; continue; }
          throw error;
        }
        const account = await this.exchange(token, signal);
        signal.throwIfAborted();
        return await this.accountStore.upsertMicrosoft(account);
      }
      throw new Error('Microsoft 设备代码已过期，请重新登录');
    } catch (error) {
      if (signal.aborted) throw new Error('Microsoft 登录已取消');
      throw error;
    } finally {
      if (this.sessions.get(owner) === controller) this.sessions.delete(owner);
    }
  }

  async exchange(token, signal, clientId = CLIENT_ID, previousRefreshToken) {
    if (!token.access_token) throw new Error('Microsoft 登录响应无效，请重新登录');
    const xbox = await this.request('https://user.auth.xboxlive.com/user/authenticate', {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${token.access_token}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
    }, signal);
    if (!xbox.Token) throw new Error('Xbox 身份验证失败，请重新登录');
    const xsts = await this.request('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbox.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
    }, signal);
    const user = xsts.DisplayClaims?.xui?.[0];
    if (!xsts.Token || !user?.uhs) throw new Error('Xbox 身份验证失败，请重新登录');
    const minecraft = await this.request('https://api.minecraftservices.com/authentication/login_with_xbox', {
      identityToken: `XBL3.0 x=${user.uhs};${xsts.Token}`
    }, signal);
    if (!minecraft.access_token || !Number.isFinite(minecraft.expires_in) || minecraft.expires_in <= 0) {
      throw new Error('Minecraft 登录响应无效，请重新登录');
    }
    const response = await this.fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${minecraft.access_token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    if (response.status === 404) throw new Error('该 Microsoft 账户没有 Java 版档案，请确认已购买游戏并创建角色');
    if (!response.ok) throw new Error(`Minecraft 档案读取失败：HTTP ${response.status}，请重新登录`);
    const profile = await response.json();
    if (!/^[a-f0-9]{32}$/i.test(profile.id)) throw new Error('Minecraft 档案 UUID 无效');
    const id = profile.id;
    const skin = profile.skins?.find(item => item.state === 'ACTIVE');
    return {
      uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
      name: profile.name, accessToken: minecraft.access_token,
      accessTokenExpiresAt: this.now() + minecraft.expires_in * 1000,
      microsoftRefreshToken: token.refresh_token ?? previousRefreshToken,
      microsoftClientId: clientId, xuid: user.xid, skinUrl: skin?.url,
      skinModel: skin?.variant === 'SLIM' ? 'alex' : 'steve'
    };
  }

  ensureAccount(account) {
    if (account.accessToken && Number(account.accessTokenExpiresAt) > this.now() + 60000) return Promise.resolve(account);
    if (!account.microsoftRefreshToken) return Promise.reject(new Error('Microsoft 登录已过期，请重新登录'));
    if (this.refreshes.has(account.id)) return this.refreshes.get(account.id);
    const task = (async () => {
      const clientId = account.microsoftClientId || CLIENT_ID;
      const token = await this.request(`${OAUTH}/token`, {
        grant_type: 'refresh_token', client_id: clientId, refresh_token: account.microsoftRefreshToken, scope: SCOPE
      }, undefined, true);
      const credentials = await this.exchange(token, undefined, clientId, account.microsoftRefreshToken);
      if (credentials.uuid !== account.uuid.toLowerCase()) throw new Error('Microsoft 账户身份不匹配，请重新登录');
      await this.accountStore.upsertMicrosoft(credentials, { select: false });
      return this.accountStore.getAccount(account.id);
    })().finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, task);
    return task;
  }
}

module.exports = { MicrosoftAuth, CLIENT_ID };
