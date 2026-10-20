const { redactError } = require('../main/error-log');

function createTaskError(code, message, options = {}) {
  return Object.assign(new Error(message), { code, ...options });
}

function cleanDetails(value, depth = 0) {
  if (depth > 3 || value == null) return undefined;
  if (typeof value === 'string') return redactError(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => cleanDetails(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
    key, /token|password|authorization|device.?code|user.?code/i.test(key)
      ? '[REDACTED]' : cleanDetails(item, depth + 1)
  ]));
}

function serializeTaskError(error, context = {}) {
  const message = redactError(error?.message ?? String(error));
  let code = error?.code;
  if (error?.name === 'AbortError' || code === 'ABORT_ERR' || /^下载已取消$/.test(message)) code = 'TASK_CANCELLED';
  if (!code && /ENOSPC|空间不足|磁盘已满/.test(message)) code = 'ENOSPC';
  if (!code && /EACCES|EPERM|EROFS|权限不足|拒绝访问/.test(message)) code = 'EACCES';
  if (!code && /校验.*(?:失败|不符)|SHA-?\d+.*(?:mismatch|failed)/i.test(message)) code = 'CHECKSUM_MISMATCH';
  if (!code && /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|连接.*(?:失败|超时)|HTTP \d{3}/i.test(message)) code = 'NETWORK_ERROR';
  if (!code && /不安全|压缩.*损坏|清单.*(?:无效|损坏)|不支持.*(?:ZIP|加载器)/i.test(message)) code = 'INVALID_MODPACK';
  code = typeof code === 'string' ? code.slice(0, 80) : 'TASK_FAILED';
  const retryable = error?.retryable ?? ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'NETWORK_ERROR',
    'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'CHECKSUM_MISMATCH'].includes(code);
  return { code, message, phase: String(error?.phase ?? context.phase ?? '').slice(0, 100),
    retryable: Boolean(retryable), details: cleanDetails(error?.details) };
}

function taskFailure(error, context) {
  return { __launcherTaskError: serializeTaskError(error, context) };
}

// Electron invoke rejections retain a message but discard custom Error fields.
// Only failures use an envelope, preserving the existing successful return types.
function registerTaskHandler(ipcMain, channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try { return await handler(...args); }
    catch (error) { return taskFailure(error, { phase: channel.split(':').at(-1) }); }
  });
}

module.exports = { createTaskError, serializeTaskError, taskFailure, registerTaskHandler };
