const { createGameLog } = require('../minecraft/game-log');

async function createModule({ options }) {
  const log = await createGameLog(options.gameDirectory, options.profileId, options.account);
  return {
    getPath: () => log.filePath,
    writeBatch: (batch, discard) => {
      if (discard) {
        log.streams.clear();
        log.append('[launcher] Output omitted while the game was producing logs faster than they could be saved.');
      }
      for (const item of batch) {
        if (item.channel === 'launcher') log.append(item.message);
        else log.write(item.channel, Buffer.from(item.data, 'base64'));
      }
      return log.writeError;
    },
    close: async (message) => { await log.close(message); return log.writeError; }
  };
}

module.exports = { createModule };
