const { serializeTaskError } = require('../../shared/task-errors');

const controller = new AbortController();
let started = false;

function send(message, callback) {
  if (process.connected) process.send(message, callback ?? (() => {}));
  else callback?.();
}

process.on('disconnect', () => controller.abort());
process.on('message', async (message) => {
  if (message?.type === 'cancel') { controller.abort(); return; }
  if (message?.type !== 'install' || started) return;
  started = true;
  let response;
  try {
    const { MinecraftLoaderManager } = require('./loader-manager');
    const { MinecraftSourceManager } = require('./source-manager');
    const { MinecraftDownloader } = require('./downloader');
    const { runJavaInstaller } = require('./java-runtime');
    const { spawn } = require('node:child_process');
    const sourceManager = new MinecraftSourceManager();
    sourceManager.setDownloadPreference(message.options.downloadSource ?? 'auto');
    const downloader = new MinecraftDownloader({ ...message.options, sourceManager });
    const manager = new MinecraftLoaderManager({ ...message.options, sourceManager, downloader,
      runInstaller: (options) => runJavaInstaller({ ...options,
        spawnProcess: (...args) => {
          const child = spawn(...args);
          if (child.pid) {
            send({ type: 'child-started', pid: child.pid });
            child.once('close', () => send({ type: 'child-closed', pid: child.pid }));
          }
          return child;
        }
      })
    });
    manager.javaPath = message.options.javaPath;
    const result = await manager.installLoader(message.request,
      (value) => send({ type: 'progress', value }), { signal: controller.signal });
    response = { type: 'result', value: result };
  } catch (error) {
    response = { type: 'error', value: serializeTaskError(error) };
  }
  // All installer handles and logs are closed before returning. Explicit exit
  // avoids waiting for HTTP keep-alive sockets after the operation has ended.
  send(response, () => process.exit(0));
});
