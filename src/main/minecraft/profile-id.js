// Accept existing localized profile names while retaining Windows portability.
const PROFILE_ID_PATTERN = /^(?!\.{1,2}$)(?!(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$))(?!.*[ .]$)[^<>:"/\\|?*\u0000-\u001f]{1,120}$/iu;

function validateProfileId(profileId) {
  const normalized = String(profileId ?? '');
  if (!PROFILE_ID_PATTERN.test(normalized)) throw new Error('游戏版本 ID 格式无效');
  return normalized;
}

module.exports = { PROFILE_ID_PATTERN, validateProfileId };
