const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { safePath } = require('./installation-files');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const activeLogs = new Set();
const TRUNCATED_MESSAGE = Buffer.from('[launcher] Earlier output omitted because the log reached its size limit.\n');

function gameLogSecrets(account) {
  return ['accessToken', 'refreshToken', 'clientToken']
    .map((field) => account?.[field]).filter((value) => typeof value === 'string' && value && value !== '0')
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])
    .sort((left, right) => right.length - left.length);
}

function redactGameOutput(value, secrets = []) {
  let output = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret && secret !== '0') {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  return output
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|clientToken|password|device_code|user_code)["']?\s*(?:[:=]\s*|\s+))(?:("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|([^\s,;]+))/gi, '$1[REDACTED]')
    .replace(/\btoken:[^:\s]+:/gi, 'token:[REDACTED]:')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
}

async function pruneLogs(directory, maximumFiles) {
  const names = (await fs.readdir(directory))
    .filter((name) => /^game-.*\.log$/.test(name)).sort().reverse();
  let retained = [...activeLogs].filter((filePath) => path.dirname(filePath) === directory).length;
  for (const name of names) {
    const filePath = path.join(directory, name);
    if (activeLogs.has(filePath)) continue;
    if (retained < maximumFiles) retained += 1;
    else await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

class GameLog {
  constructor(filePath, secrets, options = {}) {
    this.filePath = filePath;
    this.secrets = secrets;
    this.maxBytes = Math.max(512, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxLineBytes = Math.min(64 * 1024, Math.floor(this.maxBytes / 2));
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.content = Buffer.alloc(0);
    this.streams = new Map();
    this.truncated = false;
    this.dirty = false;
    this.closed = false;
    this.writeError = undefined;
  }

  append(line) {
    const entry = Buffer.from(`${redactGameOutput(line, this.secrets)}\n`);
    this.content = Buffer.concat([this.content, entry]);
    if (this.content.length > this.maxBytes - (this.truncated ? TRUNCATED_MESSAGE.length : 0)) {
      this.truncated = true;
      const overflow = this.content.length - (this.maxBytes - TRUNCATED_MESSAGE.length);
      // Drop entire old lines so both UTF-8 and the last error remain readable.
      const boundary = this.content.indexOf(10, overflow - 1);
      this.content = this.content.subarray(boundary + 1);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.closed || this.timer || this.flushing || this.writeError) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  write(channel, chunk) {
    if (this.closed) return;
    let stream = this.streams.get(channel);
    if (!stream) {
      stream = { decoder: new StringDecoder('utf8'), pending: '', bytes: 0, dropping: false };
      this.streams.set(channel, stream);
    }
    this.consume(channel, stream, stream.decoder.write(chunk));
  }

  consume(channel, stream, text) {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const part = text.slice(offset, newline < 0 ? text.length : newline);
      if (!stream.dropping) {
        stream.bytes += Buffer.byteLength(part);
        if (stream.bytes > this.maxLineBytes) {
          // Never flush a partial credential: discard oversized lines in full.
          stream.pending = '';
          stream.dropping = true;
        } else stream.pending += part;
      }
      if (newline < 0) break;
      this.finishLine(channel, stream);
      offset = newline + 1;
    }
  }

  finishLine(channel, stream) {
    this.append(`[${channel}] ${stream.dropping
      ? '[Oversized output line omitted]'
      : stream.pending.replace(/\r$/, '')}`);
    stream.pending = '';
    stream.bytes = 0;
    stream.dropping = false;
  }

  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.dirty || this.writeError) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const contents = this.truncated
      ? Buffer.concat([TRUNCATED_MESSAGE, this.content]) : this.content;
    this.dirty = false;
    this.flushing = fs.writeFile(this.filePath, contents).catch((error) => {
      this.writeError = error.code ?? 'LOG_WRITE_FAILED';
    });
    await this.flushing;
    this.flushing = undefined;
    if (this.dirty) this.scheduleFlush();
  }

  close(message) {
    if (!this.closing) this.closing = this.finish(message);
    return this.closing;
  }

  async finish(message) {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [channel, stream] of this.streams) {
      this.consume(channel, stream, stream.decoder.end());
      if (stream.pending || stream.dropping) this.finishLine(channel, stream);
    }
    if (message) this.append(`[launcher] ${message}`);
    await this.flushing;
    await this.flush();
    activeLogs.delete(this.filePath);
    await pruneLogs(path.dirname(this.filePath), this.maxFiles).catch(() => {});
  }
}

async function createGameLog(gameDirectory, profileId, account, options = {}) {
  const directory = safePath(gameDirectory, 'launcher-cache', 'game-logs');
  await fs.mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = safePath(directory, `game-${stamp}-${process.pid}-${crypto.randomUUID()}.log`);
  await fs.writeFile(filePath, '', { flag: 'wx', mode: 0o600 });
  const log = new GameLog(filePath, gameLogSecrets(account), options);
  activeLogs.add(filePath);
  log.append(`[launcher] Game ${profileId}; started ${new Date().toISOString()}`);
  await log.flush();
  await pruneLogs(directory, log.maxFiles).catch(() => {});
  return log;
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, createGameLog, gameLogSecrets, redactGameOutput };
