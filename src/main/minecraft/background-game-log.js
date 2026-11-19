const path = require('node:path');
const { ModuleProcess } = require('../module-process');

async function createBackgroundGameLog(gameDirectory, profileId, account) {
  const client = new ModuleProcess({ moduleName: 'game-log',
    modulePath: path.join(__dirname, '../worker-modules/game-log.js'), options: { gameDirectory, profileId, account } });
  let filePath;
  try { filePath = await client.invoke('getPath'); }
  catch (error) { await client.dispose(); throw error; }
  let batch = [], bufferedBytes = 0, discard = false, timer, pending, closing, failed = false, writeError;
  const dropping = new Set();
  function fail(error) {
    failed = true;
    writeError ??= error.code ?? 'LOG_WRITE_FAILED';
    batch = []; bufferedBytes = 0; discard = false;
    clearTimeout(timer); timer = undefined;
  }
  client.on('stopped', (error) => { if (!closing) fail(error); });
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (failed) return pending ?? Promise.resolve();
    if (pending) return pending.then(flush);
    if (!batch.length && !discard) return Promise.resolve();
    const items = batch, omitted = discard;
    batch = []; bufferedBytes = 0; discard = false;
    pending = client.invoke('writeBatch', [items, omitted])
      .then((code) => { if (code) writeError = code; }).catch(fail).finally(() => { pending = undefined; });
    return pending;
  }
  function enqueue(item, size) {
    if (closing || failed) return;
    if (bufferedBytes + size > 1024 * 1024) {
      batch = []; bufferedBytes = 0; discard = true;
      dropping.add('stdout'); dropping.add('stderr');
      return;
    }
    batch.push(item); bufferedBytes += size;
    timer ??= setTimeout(() => { void flush(); }, 50);
    timer.unref?.();
  }
  return {
    filePath,
    get writeError() { return writeError; },
    write(channel, chunk) {
      if (closing || failed) return;
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (dropping.has(channel)) {
        const boundary = bytes.indexOf(10);
        if (boundary < 0) return;
        bytes = bytes.subarray(boundary + 1);
        dropping.delete(channel);
      }
      enqueue({ channel, data: bytes.toString('base64') }, bytes.length);
    },
    append(message) { enqueue({ channel: 'launcher', message }, Buffer.byteLength(message)); },
    close(message) {
      if (!closing) closing = (async () => {
        await flush();
        if (!failed) await client.invoke('close', [message])
          .then((code) => { if (code) writeError = code; }).catch(fail);
        await client.dispose();
      })();
      return closing;
    }
  };
}

module.exports = { createBackgroundGameLog };
