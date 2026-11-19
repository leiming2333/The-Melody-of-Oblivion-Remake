async function prepareStore(store) {
  return store.storage.runExclusive(async () => {
    const state = await store.read();
    const primary = await store.storage.snapshot(store.filePath);
    if (primary.missing) await store.write(state);
    else if ((await store.storage.snapshot(store.storage.backupPath)).missing) {
      await store.storage.atomicWrite(store.storage.backupPath, primary.bytes, primary.mode);
    }
    return state;
  });
}

module.exports = { prepareStore };
