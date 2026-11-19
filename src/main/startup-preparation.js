const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { serializeTaskError } = require('../shared/task-errors');

const REQUIRED_STARTUP_RESOURCES = Object.freeze([
  'package.json',
  'src/preload/preload.js',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/renderer.js',
  'src/renderer/modules/module-controller.js',
  'src/shared/task-errors.js',
  'src/shared/build-info.js'
]);

// A broken optional feature must be reported without disabling the launcher.
const MODULE_STARTUP_RESOURCES = Object.freeze({
  account: Object.freeze(['src/renderer/modules/account-ui.mjs', 'src/main/accounts/microsoft-client-id.json']),
  modpack: Object.freeze(['src/renderer/modules/modpack-ui.mjs']),
  updater: Object.freeze(['src/renderer/modules/launcher-update-ui.mjs',
    'src/shared/release-metadata.js', 'src/shared/website-cdn-config.json']),
  'fabric-api': Object.freeze(['src/renderer/modules/fabric-api-ui.mjs']),
  download: Object.freeze(['src/renderer/modules/download-ui.js']),
  catalog: Object.freeze(['src/renderer/modules/version-catalog-ui.js']),
  appearance: Object.freeze([
    'src/renderer/assets/app-icon.ico',
    'src/renderer/assets/app-icon.png',
    'src/renderer/assets/app-icon.icns',
    'src/renderer/assets/backgrounds/wp15225187.jpg',
    'src/renderer/assets/backgrounds/wp15225191.jpg',
    'src/renderer/assets/backgrounds/NjGW245.jpg',
    'src/renderer/assets/backgrounds/640c286f00c515f0fe1c0bc0415bae64~tplv-a9rns2rl98-pc_smart_face_crop-v1_512_384.jpg'
  ])
});

function createStartupPreparation({ app, onProgress, fileSystem = fs } = {}) {
  let pending;
  let latestProgress;
  const listeners = new Set();

  function send(listener, state) {
    try { listener?.(state); } catch { /* A closed window must not interrupt disk preparation. */ }
  }

  function report(phase, message, progress) {
    latestProgress = { phase, message, progress };
    send(onProgress, latestProgress);
    for (const listener of listeners) send(listener, latestProgress);
  }

  async function run() {
    report('checking-resources', '正在检查启动器文件…', 10);
    const root = app.getAppPath();
    const moduleErrors = [];
    async function checkResource(resource) {
      const filename = path.join(root, resource);
      try {
        const stat = await fileSystem.stat(filename);
        if (!stat.isFile() || stat.size === 0) {
          throw Object.assign(new Error('文件为空或不是普通文件'), { code: 'INVALID_RESOURCE' });
        }
        await fileSystem.access(filename, constants.R_OK);
      } catch (cause) {
        throw Object.assign(new Error(`启动器文件缺失或无法读取：${resource}。请重新下载完整启动器后重试。`, { cause }), {
          code: 'STARTUP_RESOURCE_MISSING', resource
        });
      }
    }
    for (const resource of REQUIRED_STARTUP_RESOURCES) await checkResource(resource);
    for (const [module, resources] of Object.entries(MODULE_STARTUP_RESOURCES)) {
      for (const resource of resources) {
        try { await checkResource(resource); }
        catch (error) { moduleErrors.push({ module, ...serializeTaskError(error), resource }); }
      }
    }

    report('ready', '启动器准备完成', 100);
    return { ready: true, ...(moduleErrors.length ? { moduleErrors } : {}) };
  }

  function prepare(listener) {
    if (typeof listener === 'function') {
      listeners.add(listener);
      if (pending && latestProgress) send(listener, latestProgress);
    }
    if (!pending) {
      latestProgress = undefined;
      // Defer work until pending is assigned, including callbacks that retry.
      pending = Promise.resolve().then(run).finally(() => {
        pending = undefined;
        listeners.clear();
      });
    }
    return pending;
  }

  return { prepare };
}

module.exports = { createStartupPreparation, REQUIRED_STARTUP_RESOURCES, MODULE_STARTUP_RESOURCES };
