const crypto = require('node:crypto');
const { normalizeSkinUrl, skinUrlFromProfile } = require('./account-store');

const MICROSOFT_TENANT = 'consumers';
const MICROSOFT_SCOPE = 'XboxLive.signin offline_access';
const DEVICE_CODE_ENDPOINT = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`;
const XBOX_USER_AUTH_ENDPOINT = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_ENDPOINT = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MINECRAFT_LOGIN_ENDPOINT = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_ENTITLEMENTS_ENDPOINT = 'https://api.minecraftservices.com/entitlements/mcstore';
const MINECRAFT_PROFILE_ENDPOINT = 'https://api.minecraftservices.com/minecraft/profile';
const MINECRAFT_SESSION_PROFILE_ENDPOINT = 'https://sessionserver.mojang.com/session/minecraft/profile';
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateClientId(clientId) {
  const normalized = String(clientId ?? '').trim();
  if (!CLIENT_ID_PATTERN.test(normalized)) {
    throw new Error('启动器内置的 Microsoft Client ID 配置无效');
  }
  return normalized.toLowerCase();
}

function combinedSignal(signal, timeoutMs = 15000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 15000) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: combinedSignal(options.signal, timeoutMs)
    });
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Microsoft 登录已取消');
    if (error.name === 'TimeoutError') throw new Error('Microsoft 登录服务连接超时');
    throw new Error(`Microsoft 登录服务连接失败：${error.message}`);
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {}
  return { response, payload };
}

function providerError(payload, fallback) {
  const description = [
    payload?.error_description,
    payload?.errorMessage,
    payload?.developerMessage,
    payload?.Message,
    payload?.message
  ].map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
  if (/invalid app registration/i.test(description)) {
    return '此启动器的 Microsoft 应用尚未通过 Minecraft Services 注册审核；应用所有者需要前往 https://aka.ms/AppRegInfo 提交 Client ID，普通玩家无需处理';
  }
  return description || fallback;
}

function reportLoginProgress(onProgress, phase, message) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ phase, message });
  } catch {}
}

async function postForm(fetchImpl, url, values, signal) {
  return fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal
  });
}

async function postJson(fetchImpl, url, body, signal) {
  return fetchJson(fetchImpl, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
}

function xstsErrorMessage(payload) {
  const code = Number(payload?.XErr);
  const known = {
    2148916233: '此 Microsoft 账户还没有 Xbox 档案，请先登录 Xbox 官网创建档案',
    2148916235: 'Xbox Live 在当前账户所在地区不可用',
    2148916236: '此账户需要先在 Microsoft/Xbox 页面完成成人验证',
    2148916237: '此账户是未成年账户，需要家庭组织者完成授权',
    2148916238: '此儿童账户尚未加入 Xbox 家庭，请由家长账户完成设置'
  };
  return known[code] ?? `Xbox 身份验证失败${code ? `（XErr ${code}）` : ''}`;
}

function hyphenateUuid(value) {
  const hex = String(value ?? '').replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('Minecraft 档案返回了无效 UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function exchangeMicrosoftForMinecraft({
  accessToken,
  clientId,
  refreshToken,
  fetchImpl = fetch,
  signal,
  onProgress
}) {
  reportLoginProgress(onProgress, 'xbox', 'Microsoft 授权成功，正在登录 Xbox Live…');
  const xboxResult = await postJson(fetchImpl, XBOX_USER_AUTH_ENDPOINT, {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${accessToken}`
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  }, signal);
  if (!xboxResult.response.ok || !xboxResult.payload?.Token) {
    throw new Error(providerError(xboxResult.payload, 'Xbox Live 登录失败'));
  }

  reportLoginProgress(onProgress, 'xsts', 'Xbox Live 登录成功，正在验证 Xbox 身份…');
  const xstsResult = await postJson(fetchImpl, XSTS_ENDPOINT, {
    Properties: {
      SandboxId: 'RETAIL',
      UserTokens: [xboxResult.payload.Token]
    },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  }, signal);
  if (!xstsResult.response.ok || !xstsResult.payload?.Token) {
    throw new Error(xstsErrorMessage(xstsResult.payload));
  }
  const claim = xstsResult.payload.DisplayClaims?.xui?.[0]
    ?? xboxResult.payload.DisplayClaims?.xui?.[0];
  const userHash = claim?.uhs;
  if (!userHash) throw new Error('Xbox 身份验证没有返回用户标识');

  reportLoginProgress(onProgress, 'minecraft', 'Xbox 身份验证成功，正在连接 Minecraft…');
  const minecraftLogin = await postJson(fetchImpl, MINECRAFT_LOGIN_ENDPOINT, {
    identityToken: `XBL3.0 x=${userHash};${xstsResult.payload.Token}`
  }, signal);
  if (!minecraftLogin.response.ok || !minecraftLogin.payload?.access_token) {
    const status = Number(minecraftLogin.response.status);
    const fallback = `Minecraft Services 登录失败${status ? `（HTTP ${status}）` : ''}`;
    throw new Error(providerError(minecraftLogin.payload, fallback));
  }
  const minecraftAccessToken = minecraftLogin.payload.access_token;
  const authorization = { authorization: `Bearer ${minecraftAccessToken}` };

  reportLoginProgress(onProgress, 'entitlements', '正在检查 Minecraft Java 版所有权…');
  const entitlementResult = await fetchJson(fetchImpl, MINECRAFT_ENTITLEMENTS_ENDPOINT, {
    headers: authorization,
    signal
  });
  if (!entitlementResult.response.ok) {
    throw new Error(providerError(entitlementResult.payload, '无法检查 Minecraft Java 版所有权'));
  }
  if (!Array.isArray(entitlementResult.payload?.items) || entitlementResult.payload.items.length === 0) {
    throw new Error('此 Microsoft 账户未拥有 Minecraft Java 版');
  }

  reportLoginProgress(onProgress, 'profile', '正在获取玩家档案和正版皮肤…');
  const profileResult = await fetchJson(fetchImpl, MINECRAFT_PROFILE_ENDPOINT, {
    headers: authorization,
    signal
  });
  if (!profileResult.response.ok || !profileResult.payload?.id || !profileResult.payload?.name) {
    throw new Error(providerError(profileResult.payload, '此账户没有可用的 Minecraft Java 游戏档案'));
  }
  const skin = profileResult.payload.skins?.find((entry) => (
    normalizeSkinUrl(entry?.url, ['textures.minecraft.net'])
  ));
  const expiresIn = Math.max(60, Number(minecraftLogin.payload.expires_in) || 86400);
  const uuid = hyphenateUuid(profileResult.payload.id);
  let skinUrl = normalizeSkinUrl(skin?.url, ['textures.minecraft.net']);
  if (!skinUrl) {
    const sessionProfile = await fetchJson(
      fetchImpl,
      `${MINECRAFT_SESSION_PROFILE_ENDPOINT}/${profileResult.payload.id}?unsigned=false`,
      { signal }
    );
    if (sessionProfile.response.ok) {
      skinUrl = skinUrlFromProfile(sessionProfile.payload, ['textures.minecraft.net']);
    }
  }
  return {
    id: `microsoft:${uuid}`,
    type: 'microsoft',
    name: profileResult.payload.name,
    uuid,
    accessToken: minecraftAccessToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    microsoftClientId: validateClientId(clientId),
    microsoftRefreshToken: refreshToken,
    clientId: validateClientId(clientId),
    xuid: String(claim?.xid ?? ''),
    skinUrl,
    skinModel: skin?.variant === 'SLIM' ? 'alex' : 'steve'
  };
}

function defaultWait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Microsoft 登录已取消'));
    }, { once: true });
  });
}

class MicrosoftAuthManager {
  constructor({ accountStore, clientId = process.env.MELODY_MICROSOFT_CLIENT_ID, fetchImpl = fetch, wait = defaultWait } = {}) {
    this.accountStore = accountStore;
    this.clientId = clientId ? validateClientId(clientId) : null;
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.sessions = new Map();
  }

  requireClientId() {
    if (!this.clientId) {
      throw new Error('Microsoft 登录未配置，请设置 MELODY_MICROSOFT_CLIENT_ID');
    }
    return this.clientId;
  }

  async begin(ownerId) {
    const validatedId = this.requireClientId();
    const controller = new AbortController();
    const result = await postForm(this.fetchImpl, DEVICE_CODE_ENDPOINT, {
      client_id: validatedId,
      scope: MICROSOFT_SCOPE
    }, controller.signal);
    if (!result.response.ok || !result.payload?.device_code || !result.payload?.user_code) {
      throw new Error(providerError(result.payload, '无法开始 Microsoft 设备代码登录'));
    }
    const sessionId = crypto.randomUUID();
    const intervalSeconds = Math.max(1, Number(result.payload.interval) || 5);
    const expiresInSeconds = Math.max(60, Number(result.payload.expires_in) || 900);
    this.sessions.set(sessionId, {
      clientId: validatedId,
      controller,
      deviceCode: result.payload.device_code,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      intervalMs: intervalSeconds * 1000,
      ownerId
    });
    return {
      sessionId,
      userCode: result.payload.user_code,
      verificationUri: result.payload.verification_uri ?? 'https://microsoft.com/devicelogin',
      expiresAt: Date.now() + expiresInSeconds * 1000
    };
  }

  session(sessionId, ownerId) {
    const session = this.sessions.get(String(sessionId ?? ''));
    if (!session || session.ownerId !== ownerId) throw new Error('Microsoft 登录会话不存在或已过期');
    return session;
  }

  async complete(sessionId, ownerId, onProgress) {
    const session = this.session(sessionId, ownerId);
    try {
      let intervalMs = session.intervalMs;
      reportLoginProgress(onProgress, 'waiting', '等待浏览器授权，完成后会自动继续…');
      while (Date.now() < session.expiresAt) {
        const result = await postForm(this.fetchImpl, TOKEN_ENDPOINT, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: session.clientId,
          device_code: session.deviceCode
        }, session.controller.signal);
        if (result.response.ok && result.payload?.access_token) {
          const account = await exchangeMicrosoftForMinecraft({
            accessToken: result.payload.access_token,
            clientId: session.clientId,
            refreshToken: result.payload.refresh_token,
            fetchImpl: this.fetchImpl,
            signal: session.controller.signal,
            onProgress
          });
          reportLoginProgress(onProgress, 'saving', '验证完成，正在保存玩家账户…');
          return this.accountStore.upsertMicrosoft(account);
        }
        if (result.payload?.error === 'authorization_pending') {
          await this.wait(intervalMs, session.controller.signal);
          continue;
        }
        if (result.payload?.error === 'slow_down') {
          intervalMs += 5000;
          await this.wait(intervalMs, session.controller.signal);
          continue;
        }
        if (result.payload?.error === 'authorization_declined') {
          throw new Error('Microsoft 登录已被拒绝');
        }
        if (result.payload?.error === 'expired_token') {
          throw new Error('Microsoft 登录代码已过期，请重新登录');
        }
        throw new Error(providerError(result.payload, 'Microsoft 登录失败'));
      }
      throw new Error('Microsoft 登录代码已过期，请重新登录');
    } finally {
      this.sessions.delete(String(sessionId));
    }
  }

  cancel(sessionId, ownerId) {
    const session = this.sessions.get(String(sessionId ?? ''));
    if (!session || session.ownerId !== ownerId) return { cancelled: false };
    session.controller.abort();
    this.sessions.delete(String(sessionId));
    return { cancelled: true };
  }

  cancelOwner(ownerId) {
    for (const [sessionId, session] of this.sessions) {
      if (session.ownerId === ownerId) this.cancel(sessionId, ownerId);
    }
  }

  async ensureAccount(account) {
    if (!account || account.type !== 'microsoft') return account;
    if (Number(account.accessTokenExpiresAt) > Date.now() + 5 * 60 * 1000 && account.accessToken) {
      return account;
    }
    const clientId = validateClientId(account.microsoftClientId ?? account.clientId);
    if (!account.microsoftRefreshToken) {
      throw new Error('Microsoft 登录已过期，请在账户管理中重新登录');
    }
    const tokenResult = await postForm(this.fetchImpl, TOKEN_ENDPOINT, {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: account.microsoftRefreshToken,
      scope: MICROSOFT_SCOPE
    });
    if (!tokenResult.response.ok || !tokenResult.payload?.access_token) {
      throw new Error(providerError(tokenResult.payload, 'Microsoft 登录已过期，请重新登录'));
    }
    const refreshed = await exchangeMicrosoftForMinecraft({
      accessToken: tokenResult.payload.access_token,
      clientId,
      refreshToken: tokenResult.payload.refresh_token ?? account.microsoftRefreshToken,
      fetchImpl: this.fetchImpl
    });
    await this.accountStore.upsertMicrosoft(refreshed);
    return this.accountStore.getAccount(refreshed.id);
  }
}

module.exports = {
  CLIENT_ID_PATTERN,
  DEVICE_CODE_ENDPOINT,
  MICROSOFT_SCOPE,
  MicrosoftAuthManager,
  TOKEN_ENDPOINT,
  exchangeMicrosoftForMinecraft,
  hyphenateUuid,
  validateClientId,
  xstsErrorMessage
};
