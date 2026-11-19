const { skinUrlFromProfile } = require('../accounts/account-store');

function createModule({ callMain }) {
  return {
    async refreshSkin(accountId, context) {
      const account = await callMain('getAccount', [accountId]);
      if (!['microsoft', 'yggdrasil'].includes(account?.type)) throw new Error('当前账户不支持在线皮肤同步');
      const origin = account.type === 'microsoft' ? 'https://sessionserver.mojang.com'
        : 'https://littleskin.cn/api/yggdrasil/sessionserver';
      const uuid = String(account.uuid).replaceAll('-', '');
      const response = await fetch(`${origin}/session/minecraft/profile/${uuid}?unsigned=false`, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(8000)])
      });
      if (!response.ok) throw new Error(`皮肤同步失败：HTTP ${response.status}`);
      const skinUrl = skinUrlFromProfile(await response.json(), account.type === 'microsoft' ? ['textures.minecraft.net'] : ['littleskin.cn']);
      if (!skinUrl) throw new Error('玩家档案没有可用皮肤');
      return callMain('updateSkin', [accountId, skinUrl, account.accessToken]);
    }
  };
}

module.exports = { createModule };
