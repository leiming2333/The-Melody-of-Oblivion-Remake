const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { redactError } = require('./error-log');
const { redactGameOutput } = require('./minecraft/game-log');

const MAX_RECORD_BYTES = 512 * 1024;

function diagnosticText(value, homeDirectory = '') {
  let text = redactError(redactGameOutput(String(value ?? '').slice(0, 8000)))
    .replace(/((?:client[_-]?secret|api[_-]?key|id[_-]?token|deviceCode|userCode)["']?\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(\bauthorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi, '$1[REDACTED]')
    .replace(/(\btoken["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|sig|code)=)[^&\s"']+/gi, '$1[REDACTED]');
  if (homeDirectory) {
    const variants = new Set([String(homeDirectory), String(homeDirectory).replaceAll('\\', '/'),
      String(homeDirectory).replaceAll('\\', '\\\\')]);
    for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'gi'), '[HOME]');
    }
  }
  return text;
}

async function readRecord(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_RECORD_BYTES) return { unavailable: 'RECORD_TOO_LARGE' };
    try { return { value: JSON.parse(bytes.subarray(0, size).toString('utf8')) }; }
    catch { return { unavailable: 'INVALID_JSON' }; }
  } catch (error) {
    return { unavailable: error.code ?? 'READ_FAILED' };
  } finally {
    await handle?.close();
  }
}

function safeSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { unavailable: 'INVALID_SETTINGS' };
  const result = { javaSelection: settings.javaPath ? 'manual' : 'auto',
    javaRuntimeMajors: [...new Set((Array.isArray(settings.javaRuntimes) ? settings.javaRuntimes : [])
      .map((entry) => entry?.majorVersion).filter((major) => Number.isInteger(major) && major > 0 && major < 1000))],
    recoveredFromBackup: Boolean(settings.recovery) };
  for (const key of ['version', 'wallpaperIndex', 'downloadConcurrency', 'memoryMb']) {
    if (typeof settings[key] === 'number' && Number.isFinite(settings[key])) result[key] = settings[key];
  }
  for (const key of ['isolateProfiles', 'autoUpdate']) {
    if (typeof settings[key] === 'boolean') result[key] = settings[key];
  }
  for (const [key, allowed] of Object.entries({ gameDirectoryMode: ['local', 'system'],
    downloadSource: ['auto', 'bmclapi', 'official'], launcherUpdatePolicy: ['auto', 'notify', 'off'] })) {
    if (allowed.includes(settings[key])) result[key] = settings[key];
  }
  return result;
}

function startupRecords(record, clean) {
  if (record.unavailable) return record;
  const value = record.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { unavailable: 'INVALID_SCHEMA' };
  const entries = (values, kind) => (Array.isArray(values) ? values : []).slice(-100).map((entry) => {
    const result = { [kind]: clean(typeof entry?.[kind] === 'string' ? entry[kind] : '') };
    if (typeof entry?.service === 'string') result.service = clean(entry.service);
    for (const key of ['elapsedMs', 'processUptimeMs']) {
      if (typeof entry?.[key] === 'number' && Number.isFinite(entry[key])) result[key] = entry[key];
    }
    return result;
  });
  return { startedAt: clean(typeof value.startedAt === 'string' ? value.startedAt : ''),
    stages: entries(value.stages, 'stage'), events: entries(value.events, 'event') };
}

async function createDiagnosticsReport({ app, getSettings, message = '', now = new Date(),
  userDataDirectory = app.getPath('userData'), homeDirectory = app.getPath('home') }) {
  const clean = (value) => diagnosticText(value, homeDirectory);
  const records = await Promise.all([
    readRecord(path.join(userDataDirectory, 'logs', 'errors-latest.json')),
    readRecord(path.join(userDataDirectory, 'logs', 'startup-latest.json'))
  ]);
  let settings;
  try { settings = safeSettings(await getSettings()); }
  catch (error) { settings = { unavailable: error.code ?? 'SETTINGS_READ_FAILED', message: clean(error.message) }; }
  const errors = records[0].unavailable ? records[0] : Array.isArray(records[0].value)
    ? { entries: records[0].value.slice(-50).map((entry) => ({
      at: clean(typeof entry?.at === 'string' ? entry.at : ''),
      message: clean(typeof entry?.message === 'string' ? entry.message : '')
    })) } : { unavailable: 'INVALID_SCHEMA' };
  return { schemaVersion: 1, generatedAt: now.toISOString(),
    application: { version: clean(app.getVersion?.() ?? require('../../package.json').version), packaged: Boolean(app.isPackaged) },
    runtime: Object.fromEntries(['node', 'electron', 'chrome', 'v8'].filter((key) => process.versions[key])
      .map((key) => [key, process.versions[key]])),
    system: { platform: process.platform, arch: process.arch, release: os.release() },
    settings, problem: clean(message), errors, startup: startupRecords(records[1], clean) };
}

async function exportDiagnosticsReport({ app, dialog, ownerWindow, ...options }) {
  const selectionOptions = { title: '导出诊断报告', buttonLabel: '保存诊断报告',
    defaultPath: 'Melody-diagnostics.json', filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }] };
  const selected = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, selectionOptions)
    : await dialog.showSaveDialog(selectionOptions);
  if (selected.canceled || !selected.filePath) return { canceled: true };
  const report = await createDiagnosticsReport({ app, ...options });
  const temporary = `${selected.filePath}.part-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, selected.filePath);
  } catch (cause) {
    throw Object.assign(new Error(`诊断报告保存失败：${cause.code ?? 'WRITE_FAILED'}`, { cause }),
      { code: cause.code ?? 'WRITE_FAILED' });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { canceled: false, filePath: selected.filePath };
}

module.exports = { createDiagnosticsReport, diagnosticText, exportDiagnosticsReport };
