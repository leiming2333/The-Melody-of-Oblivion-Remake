const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const OFFLINE_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const SKIN_MODELS = Object.freeze(['steve', 'alex']);
const YGGDRASIL_SECRET_FIELDS = Object.freeze(['accessToken', 'clientToken']);
const ONLINE_ACCOUNT_TYPES = Object.freeze(['yggdrasil']);

const passthroughSecretCodec = Object.freeze({
  decode: (value) => value,
  encode: (value) => value
});

function transformAccountSecrets(value, transform) {
  if (!Array.isArray(value?.accounts)) return value;
  return {
    ...value,
    accounts: value.accounts.map((account) => {
      if (!ONLINE_ACCOUNT_TYPES.includes(account?.type)) return account;
      const copy = { ...account };
      for (const field of YGGDRASIL_SECRET_FIELDS) {
        if (typeof copy[field] === 'string' && copy[field]) copy[field] = transform(copy[field]);
      }
      return copy;
    })
  };
}

function normalizeSkinUrl(value, allowedDomains = ['textures.minecraft.net']) {
  try {
    const parsed = new URL(String(value ?? ''));
    const hostname = parsed.hostname.toLowerCase();
    const domainAllowed = allowedDomains.some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
    if (!domainAllowed || !['http:', 'https:'].includes(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password || parsed.port) return undefined;
    if (hostname === 'textures.minecraft.net'
      && !/^\/texture\/[a-f0-9]+$/i.test(parsed.pathname)) return undefined;
    parsed.protocol = 'https:';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function validateSkinModel(skinModel) {
  const normalized = String(skinModel ?? 'steve').toLowerCase();
  if (!SKIN_MODELS.includes(normalized)) throw new Error('不支持的离线皮肤模型');
  return normalized;
}

function offlineUuid(playerName) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${playerName}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function javaUuidHashCode(uuid) {
  const hex = String(uuid ?? '').replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error('离线账户 UUID 无效');
  const blocks = [0, 8, 16, 24]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 8), 16));
  return (blocks[0] ^ blocks[1] ^ blocks[2] ^ blocks[3]) | 0;
}

function offlineUuidForSkinModel(uuid, skinModel) {
  const model = validateSkinModel(skinModel);
  const hex = String(uuid ?? '').replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('离线账户 UUID 无效');
  const blocks = [0, 8, 16]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 8), 16));
  const desiredHash = model === 'alex' ? 1 : 0;
  const finalBlock = (blocks[0] ^ blocks[1] ^ blocks[2] ^ desiredHash) >>> 0;
  const adjusted = `${hex.slice(0, 24)}${finalBlock.toString(16).padStart(8, '0')}`;
  return `${adjusted.slice(0, 8)}-${adjusted.slice(8, 12)}-${adjusted.slice(12, 16)}-${adjusted.slice(16, 20)}-${adjusted.slice(20)}`;
}

function validateOfflineName(playerName) {
  const normalized = String(playerName ?? '').trim();
  if (!OFFLINE_NAME_PATTERN.test(normalized)) {
    throw new Error('离线用户名需为 3–16 位英文字母、数字或下划线');
  }
  return normalized;
}

function normalizeState(value) {
  const accounts = Array.isArray(value?.accounts)
    ? value.accounts.filter(
        (account) =>
          account &&
          (account.type === 'offline' || ONLINE_ACCOUNT_TYPES.includes(account.type)) &&
          typeof account.id === 'string' &&
          typeof account.name === 'string' &&
          typeof account.uuid === 'string'
      ).map((account) => ({
        ...account,
        skinModel: SKIN_MODELS.includes(account.skinModel) ? account.skinModel : 'steve',
        skinUrl: account.type === 'yggdrasil'
          ? normalizeSkinUrl(account.skinUrl, ['littleskin.cn'])
          : undefined
      }))
    : [];
  const currentId = accounts.some((account) => account.id === value?.currentId)
    ? value.currentId
    : accounts[0]?.id ?? null;
  return { version: 4, currentId, accounts };
}

function skinUrlFromProfile(profile, allowedDomains = ['textures.minecraft.net']) {
  const encoded = profile?.properties?.find((property) => property?.name === 'textures')?.value;
  if (typeof encoded !== 'string') return undefined;
  try {
    const textures = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const skinUrl = textures?.textures?.SKIN?.url;
    return normalizeSkinUrl(skinUrl, allowedDomains);
  } catch {
    return undefined;
  }
}

class AccountStore {
  constructor(filePath, { secretCodec = passthroughSecretCodec } = {}) {
    this.filePath = filePath;
    this.secretCodec = secretCodec;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const decoded = transformAccountSecrets(JSON.parse(content), (value) => (
        this.secretCodec.decode(value)
      ));
      return normalizeState(decoded);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        return normalizeState({});
      }
      throw error;
    }
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.part`;
    const encoded = transformAccountSecrets(normalizeState(state), (value) => (
      this.secretCodec.encode(value)
    ));
    await fs.writeFile(temporary, `${JSON.stringify(encoded, null, 2)}\n`, 'utf8');
    await fs.rm(this.filePath, { force: true });
    await fs.rename(temporary, this.filePath);
  }

  publicState(state) {
    const publicAccount = (account) => {
      if (!account) return null;
      const {
        accessToken: _accessToken,
        accessTokenExpiresAt: _accessTokenExpiresAt,
        clientId: _clientId,
        clientToken: _clientToken,
        ...visible
      } = account;
      return visible;
    };
    return {
      currentId: state.currentId,
      current: publicAccount(state.accounts.find((account) => account.id === state.currentId)),
      accounts: state.accounts.map(publicAccount)
    };
  }

  runExclusive(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async getState() {
    return this.publicState(await this.read());
  }

  async getCurrentAccount() {
    const state = await this.read();
    return state.accounts.find((account) => account.id === state.currentId) ?? null;
  }

  async getAccount(accountId) {
    const state = await this.read();
    return state.accounts.find((account) => account.id === accountId) ?? null;
  }

  async addOffline(playerName, skinModel = 'steve') {
    const name = validateOfflineName(playerName);
    const selectedSkinModel = validateSkinModel(skinModel);
    return this.runExclusive(async () => {
      const state = await this.read();
      const existing = state.accounts.find(
        (account) => account.type === 'offline' && account.name.toLowerCase() === name.toLowerCase()
      );

      if (existing) {
        existing.skinModel = selectedSkinModel;
        state.currentId = existing.id;
        await this.write(state);
        return this.publicState(state);
      }

      const uuid = offlineUuid(name);
      const account = {
        id: `offline:${uuid}`,
        type: 'offline',
        name,
        uuid,
        skinModel: selectedSkinModel,
        createdAt: new Date().toISOString()
      };
      state.accounts.push(account);
      state.currentId = account.id;
      await this.write(state);
      return this.publicState(state);
    });
  }

  async upsertYggdrasil(credentials) {
    const uuid = String(credentials?.uuid ?? '').toLowerCase();
    const name = String(credentials?.name ?? '');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)) {
      throw new Error('LittleSkin 角色 UUID 无效');
    }
    if (!OFFLINE_NAME_PATTERN.test(name) || !credentials?.accessToken || !credentials?.clientToken) {
      throw new Error('LittleSkin 角色档案无效');
    }
    return this.runExclusive(async () => {
      const state = await this.read();
      const id = `littleskin:${uuid}`;
      const existingIndex = state.accounts.findIndex((account) => account.id === id);
      const existing = existingIndex >= 0 ? state.accounts[existingIndex] : undefined;
      const account = {
        ...existing,
        ...credentials,
        id,
        type: 'yggdrasil',
        provider: 'littleskin',
        serverName: 'LittleSkin',
        authServer: 'https://littleskin.cn/api/yggdrasil',
        name,
        uuid,
        skinUrl: normalizeSkinUrl(credentials.skinUrl, ['littleskin.cn']),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (existingIndex >= 0) state.accounts[existingIndex] = account;
      else state.accounts.push(account);
      state.currentId = id;
      await this.write(state);
      return this.publicState(state);
    });
  }

  async select(accountId) {
    return this.runExclusive(async () => {
      const state = await this.read();
      if (!state.accounts.some((account) => account.id === accountId)) {
        throw new Error('账户不存在');
      }
      state.currentId = accountId;
      await this.write(state);
      return this.publicState(state);
    });
  }

  async setSkinModel(accountId, skinModel) {
    const selectedSkinModel = validateSkinModel(skinModel);
    return this.runExclusive(async () => {
      const state = await this.read();
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账户不存在');
      if (account.type !== 'offline') throw new Error('只有离线账户可以切换默认皮肤');
      account.skinModel = selectedSkinModel;
      await this.write(state);
      return this.publicState(state);
    });
  }

  async renameAccount(accountId, newName) {
    const name = validateOfflineName(newName);
    return this.runExclusive(async () => {
      const state = await this.read();
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账户不存在');
      if (account.type !== 'offline') throw new Error('仅离线账户支持修改玩家 ID');
      account.name = name;
      account.updatedAt = new Date().toISOString();
      await this.write(state);
      return this.publicState(state);
    });
  }

  async refreshYggdrasilSkin(accountId, fetchImpl = fetch) {
    return this.runExclusive(async () => {
      const state = await this.read();
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account || account.type !== 'yggdrasil') throw new Error('LittleSkin 账户不存在');
      const profileUuid = String(account.uuid).replaceAll('-', '');
      const response = await fetchImpl(
        `https://littleskin.cn/api/yggdrasil/sessionserver/session/minecraft/profile/${profileUuid}?unsigned=false`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!response.ok) throw new Error(`LittleSkin 皮肤同步失败：HTTP ${response.status}`);
      const skinUrl = skinUrlFromProfile(await response.json(), ['littleskin.cn']);
      if (!skinUrl) throw new Error('LittleSkin 角色没有可用皮肤');
      account.skinUrl = skinUrl;
      await this.write(state);
      return this.publicState(state);
    });
  }

  async refreshSkin(accountId, fetchImpl = fetch) {
    const account = await this.getAccount(accountId);
    if (account?.type === 'yggdrasil') return this.refreshYggdrasilSkin(accountId, fetchImpl);
    throw new Error('当前账户不支持在线皮肤同步');
  }

  async remove(accountId) {
    return this.runExclusive(async () => {
      const state = await this.read();
      state.accounts = state.accounts.filter((account) => account.id !== accountId);
      if (state.currentId === accountId) {
        state.currentId = state.accounts[0]?.id ?? null;
      }
      await this.write(state);
      return this.publicState(state);
    });
  }
}

module.exports = {
  AccountStore,
  OFFLINE_NAME_PATTERN,
  SKIN_MODELS,
  YGGDRASIL_SECRET_FIELDS,
  javaUuidHashCode,
  normalizeSkinUrl,
  offlineUuid,
  offlineUuidForSkinModel,
  skinUrlFromProfile,
  transformAccountSecrets,
  validateSkinModel,
  validateOfflineName
};
