'use strict';

const CERTIFICATE_ENVIRONMENT_NAMES = new Set([
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'
]);

function sanitizeSigningEnvironment(env = process.env) {
  const sanitized = { ...env };
  for (const [name, value] of Object.entries(sanitized)) {
    if ((CERTIFICATE_ENVIRONMENT_NAMES.has(name) || name.startsWith('APPLE_'))
      && typeof value === 'string' && !value.trim()) delete sanitized[name];
  }
  return sanitized;
}

function platformSigningArguments(platform, env = process.env) {
  env = sanitizeSigningEnvironment(env);
  if (platform === 'linux' || env.MELODY_REQUIRE_CODE_SIGNING !== 'true') return [];
  if (!env.CSC_LINK) throw new Error('Platform code signing is required but CSC_LINK is missing');
  if (platform === 'darwin' && (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD || !env.APPLE_TEAM_ID)) {
    throw new Error('Required macOS notarization credentials are missing (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)');
  }
  return ['--config.forceCodeSigning=true'];
}

module.exports = { platformSigningArguments, sanitizeSigningEnvironment };
