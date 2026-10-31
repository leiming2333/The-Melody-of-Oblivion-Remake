const crypto = require('node:crypto');
const { normalizeSkinUrl, skinUrlFromProfile } = require('./account-store');

const LITTLE_SKIN_API = 'https://littleskin.cn/api/yggdrasil';
const LITTLE_SKIN_NAME = 'LittleSkin';
const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const PROFILE_ID_PATTERN = /^[a-f0-9]{32}$/i;

function hyphenateProfileId(value) {
  const hex = String(value ?? '').replaceAll('-', '').toLowerCase();
  if (!PROFILE_ID_PATTERN.test(hex)) throw new Error('LittleSkin 返回了无效的角色 UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeProfile(profile) {
  const id = String(profile?.id ?? '').replaceAll('-', '').toLowerCase();
  const name = String(profile?.name ?? '');
  if (!PROFILE_ID_PATTERN.test(id) || !PLAYER_NAME_PATTERN.test(name)) {
    throw new Error('LittleSkin 返回了无效的角色档案');
  }
  return { id, name };
}

function readableProviderError(payload, fallback) {
  const message = [payload?.errorMessage, payload?.message, payload?.error]
    .map((value) => String(value ?? '').trim())
    .find(Boolean);
  if (/invalid credentials/i.test(message ?? '')) return 'LittleSkin 用户名或密码错误';
  if (/forbiddenoperationexception/i.test(String(payload?.error ?? ''))) {
    return message || 'LittleSkin 登录被拒绝，请检查用户名和密码';
  }
  return message || fallback;
}

function combinedSignal(signal, timeoutMs = 15000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestJson(fetchImpl, url, options = {}, timeoutMs = 15000) {
  const signal = combinedSignal(options.signal, timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal
    });
    if (response.status === 204) return { response, payload: {} };
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      // Error pages need not be JSON; preserve their HTTP status for diagnostics.
      if (!(error instanceof SyntaxError) || response.ok) throw error;
      payload = {};
    }
    if (signal.aborted) throw signal.reason;
    return { response, payload };
  } catch (error) {
    let message = `LittleSkin 服务连接失败：${error.message}`;
    let code = 'NETWORK_ERROR';
    if (options.signal?.aborted) { message = 'LittleSkin 登录已取消'; code = 'TASK_CANCELLED'; }
    else if (signal.reason?.name === 'TimeoutError' || error.name === 'TimeoutError') {
      message = 'LittleSkin 服务连接超时'; code = 'ETIMEDOUT';
    } else if (error instanceof SyntaxError) {
      message = 'LittleSkin 服务返回了无效的 JSON 响应，请稍后重试'; code = 'YGGDRASIL_INVALID_RESPONSE';
    }
    throw Object.assign(new Error(message, { cause: error }), { code,
      retryable: ['NETWORK_ERROR', 'ETIMEDOUT'].includes(code) });
  }
}

function responseError(result, fallback, { expired = false } = {}) {
  const status = result.response.status;
  const cause = new Error(`LittleSkin HTTP ${status}`);
  if (status >= 500 || status === 429) {
    return Object.assign(new Error(`LittleSkin 服务暂时不可用（HTTP ${status}），请稍后重试`, { cause }),
      { code: 'NETWORK_ERROR', status, retryable: true });
  }
  if (expired && [401, 403].includes(status)) {
    return Object.assign(new Error('LittleSkin 登录已过期，请在账户管理中重新登录', { cause }),
      { code: 'YGGDRASIL_AUTH_EXPIRED', status, retryable: false });
  }
  return Object.assign(new Error(`${readableProviderError(result.payload, fallback)}（HTTP ${status}）`, { cause }),
    { code: result.response.ok ? 'YGGDRASIL_INVALID_RESPONSE' : 'YGGDRASIL_AUTH_FAILED', status,
      retryable: false });
}

function postJson(fetchImpl, endpoint, body, signal) {
  return requestJson(fetchImpl, `${LITTLE_SKIN_API}${endpoint}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });
}

function skinModelFromProfile(profile) {
  const encoded = profile?.properties?.find((property) => property?.name === 'textures')?.value;
  if (typeof encoded !== 'string') return 'steve';
  try {
    const textures = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return textures?.textures?.SKIN?.metadata?.model === 'slim' ? 'alex' : 'steve';
  } catch {
    return 'steve';
  }
}

class YggdrasilAuthManager {
  constructor({ accountStore, fetchImpl = fetch } = {}) {
    this.accountStore = accountStore;
    this.fetchImpl = fetchImpl;
  }

  async fetchProfile(profileId, signal) {
    const { response, payload } = await requestJson(
      this.fetchImpl,
      `${LITTLE_SKIN_API}/sessionserver/session/minecraft/profile/${profileId}?unsigned=false`,
      { signal },
      10000
    );
    if (!response.ok) return {};
    return {
      skinUrl: skinUrlFromProfile(payload, ['littleskin.cn']),
      skinModel: skinModelFromProfile(payload)
    };
  }

  async saveAccount({ accessToken, clientToken, profile, signal, select = true }) {
    if (!accessToken || !clientToken) throw new Error('LittleSkin 没有返回可用的登录令牌');
    const selectedProfile = normalizeProfile(profile);
    if (signal?.aborted) throw Object.assign(new Error('LittleSkin 登录已取消'), { code: 'TASK_CANCELLED' });
    const credentials = {
      name: selectedProfile.name,
      uuid: hyphenateProfileId(selectedProfile.id),
      accessToken,
      clientToken,
      authServer: LITTLE_SKIN_API,
      serverName: LITTLE_SKIN_NAME
    };
    // A rotated token must survive even if optional texture lookup subsequently fails.
    const state = await this.accountStore.upsertYggdrasil(credentials, { select });
    const texture = await this.fetchProfile(selectedProfile.id, signal).catch(() => ({}));
    if (!texture.skinUrl) return state;
    return this.accountStore.updateYggdrasilTexture(`littleskin:${credentials.uuid}`, {
      skinUrl: normalizeSkinUrl(texture.skinUrl, ['littleskin.cn']), skinModel: texture.skinModel
    });
  }

  async refreshProfile({ accessToken, clientToken, profile, signal }) {
    const result = await postJson(this.fetchImpl, '/authserver/refresh', {
      accessToken,
      clientToken,
      selectedProfile: normalizeProfile(profile),
      requestUser: true
    }, signal);
    if (!result.response.ok || !result.payload?.accessToken || !result.payload?.selectedProfile) {
      throw responseError(result, 'LittleSkin 角色选择失败', { expired: true });
    }
    return result.payload;
  }

  async login(username, password) {
    const normalizedUsername = String(username ?? '').trim();
    const normalizedPassword = String(password ?? '');
    if (!normalizedUsername || normalizedUsername.length > 254) {
      throw new Error('请输入 LittleSkin 邮箱或角色名');
    }
    if (!normalizedPassword || normalizedPassword.length > 512) {
      throw new Error('请输入 LittleSkin 密码');
    }
    const clientToken = crypto.randomUUID();
    const result = await postJson(this.fetchImpl, '/authserver/authenticate', {
      agent: { name: 'Minecraft', version: 1 },
      username: normalizedUsername,
      password: normalizedPassword,
      clientToken,
      requestUser: true
    });
    if (!result.response.ok || !result.payload?.accessToken) {
      throw responseError(result, 'LittleSkin 登录失败');
    }

    const returnedClientToken = result.payload.clientToken || clientToken;
    if (result.payload.selectedProfile) {
      return {
        state: await this.saveAccount({
          accessToken: result.payload.accessToken,
          clientToken: returnedClientToken,
          profile: result.payload.selectedProfile
        })
      };
    }

    if (!Array.isArray(result.payload.availableProfiles)) {
      throw Object.assign(new Error('LittleSkin 返回了无效的角色列表'), { code: 'YGGDRASIL_INVALID_RESPONSE' });
    }
    const profiles = result.payload.availableProfiles.map(normalizeProfile);
    if (profiles.length === 0) throw new Error('LittleSkin 账户还没有可用角色，请先在网站创建角色');

    const existingState = await this.accountStore.read();
    const existingUuids = new Set(
      existingState.accounts
        .filter((a) => a.type === 'yggdrasil')
        .map((a) => a.uuid)
    );
    const unsavedProfile = profiles.find(
      (p) => !existingUuids.has(hyphenateProfileId(p.id))
    );
    const selectedProfile = unsavedProfile ?? profiles[0];
    const refreshed = await this.refreshProfile({
      accessToken: result.payload.accessToken,
      clientToken: returnedClientToken,
      profile: selectedProfile
    });
    return {
      state: await this.saveAccount({
        accessToken: refreshed.accessToken,
        clientToken: refreshed.clientToken || returnedClientToken,
        profile: refreshed.selectedProfile
      })
    };
  }

  async ensureAccount(account) {
    if (!account || account.type !== 'yggdrasil') return account;
    const validation = await postJson(this.fetchImpl, '/authserver/validate', {
      accessToken: account.accessToken,
      clientToken: account.clientToken
    });
    if (validation.response.status === 204) return account;
    if (![401, 403].includes(validation.response.status)) {
      throw responseError(validation, 'LittleSkin 返回了无效的令牌验证响应');
    }

    const refreshed = await this.refreshProfile({
      accessToken: account.accessToken,
      clientToken: account.clientToken,
      profile: { id: account.uuid, name: account.name }
    });
    await this.saveAccount({
      accessToken: refreshed.accessToken,
      clientToken: refreshed.clientToken || account.clientToken,
      profile: refreshed.selectedProfile,
      select: false
    });
    return this.accountStore.getAccount(`littleskin:${hyphenateProfileId(refreshed.selectedProfile.id)}`);
  }
}

module.exports = {
  LITTLE_SKIN_API,
  LITTLE_SKIN_NAME,
  YggdrasilAuthManager,
  hyphenateProfileId,
  normalizeProfile,
  readableProviderError
};
