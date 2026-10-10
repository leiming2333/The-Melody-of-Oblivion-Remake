'use strict';

/**
 * 构建时注入 Microsoft Client ID。
 *
 * 该脚本从环境变量 MELODY_MICROSOFT_CLIENT_ID 读取 Client ID，
 * 写入 src/main/accounts/microsoft-client-id.json（公开 OAuth 应用 ID）。
 *
 * 这样做的目的：
 * - Client ID 是公开 OAuth 应用 ID，不是客户端密钥
 * - 构建产物（asar 内）包含真实 Client ID（保证功能可用）
 * - 本地开发时可手动设置环境变量后运行此脚本
 */
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rawClientId = String(process.env.MELODY_MICROSOFT_CLIENT_ID ?? '').trim();
const target = path.join(__dirname, '..', 'src', 'main', 'accounts', 'microsoft-client-id.json');

const isValid = CLIENT_ID_PATTERN.test(rawClientId);
if (!isValid) {
  console.error('[generate-client-id] 缺少有效的 MELODY_MICROSOFT_CLIENT_ID，构建已中止。');
  process.exitCode = 1;
} else {
  fs.writeFileSync(target, `${JSON.stringify({ clientId: rawClientId.toLowerCase() }, null, 2)}\n`);
  console.log('[generate-client-id] Microsoft Client ID 已注入构建产物。');
}
