const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeConfiguredClientId(value = '') {
  if (typeof value !== 'string') throw new Error('Microsoft Client ID 必须是 UUID 格式的应用 ID');
  const normalized = value.trim().toLowerCase();
  if (normalized && !CLIENT_ID_PATTERN.test(normalized)) {
    throw new Error('Microsoft Client ID 必须是 UUID 格式的应用 ID');
  }
  return normalized;
}

function microsoftClientConfiguration({ settings = {}, environmentClientId = process.env.MELODY_MICROSOFT_CLIENT_ID } = {}) {
  const environment = normalizeConfiguredClientId(environmentClientId ?? '');
  const custom = normalizeConfiguredClientId(settings.microsoftClientId ?? '');
  const source = environment ? 'environment' : custom ? 'custom' : 'bundled';
  return {
    // Settings validation must not load an optional authentication resource.
    clientId: environment || custom || require('./microsoft-client-id.json').clientId,
    source,
    // An OAuth ID being configured is not evidence of Minecraft Services approval.
    approvalStatus: 'unknown'
  };
}

module.exports = { CLIENT_ID_PATTERN, normalizeConfiguredClientId, microsoftClientConfiguration };
