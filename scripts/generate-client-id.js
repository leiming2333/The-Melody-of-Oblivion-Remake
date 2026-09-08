'use strict';

/**
 * 构建时注入 Microsoft Client ID。
 *
 * 该脚本从环境变量 MELODY_MICROSOFT_CLIENT_ID 读取 Client ID，
 * 写入 src/main/accounts/microsoft-client-id.json（已被 .gitignore 忽略）。
 *
 * 这样做的目的：
 * - Client ID 不出现在 git 仓库中（隐藏凭证）
 * - 构建产物（asar 内）包含真实 Client ID（保证功能可用）
 * - 本地开发时可手动设置环境变量后运行此脚本
 */
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rawClientId = String(process.env.MELODY_MICROSOFT_CLIENT_ID ?? '').trim();
const target = path.join(__dirname, '..', 'src', 'main', 'accounts', 'microsoft-client-id.json');

const isValid = CLIENT_ID_PATTERN.test(rawClientId);
const payload = { clientId: isValid ? rawClientId.toLowerCase() : '' };

fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);

if (isValid) {
  console.log('[generate-client-id] Microsoft Client ID 已注入构建产物。');
} else if (rawClientId) {
  console.warn(`[generate-client-id] 警告：MELODY_MICROSOFT_CLIENT_ID 格式无效，已写入空值。`);
} else {
  console.warn('[generate-client-id] 警告：未设置 MELODY_MICROSOFT_CLIENT_ID，本次构建的 Microsoft 登录将不可用。');
}
