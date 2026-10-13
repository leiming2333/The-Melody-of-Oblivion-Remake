const PREFIX = 'safe-storage:v1:';

function createSecretCodec(safeStorage, platform = process.platform) {
  function requireProtectedStorage(action) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(`系统凭据存储当前不可用，已拒绝${action}在线账户登录信息`);
    }
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (!backend || backend === 'basic_text' || backend === 'unknown') {
        throw new Error(`系统凭据存储未使用受保护的密钥后端，已拒绝${action}在线账户登录信息，请启用系统密钥环后重试`);
      }
    }
  }

  return {
    encode(value) {
      requireProtectedStorage('保存');
      return `${PREFIX}${safeStorage.encryptString(value).toString('base64')}`;
    },
    decode(value) {
      if (!String(value).startsWith(PREFIX)) {
        throw new Error('检测到未加密的在线账户登录信息，请删除该账户后重新登录');
      }
      requireProtectedStorage('读取');
      return safeStorage.decryptString(Buffer.from(String(value).slice(PREFIX.length), 'base64'));
    }
  };
}

module.exports = { createSecretCodec };
