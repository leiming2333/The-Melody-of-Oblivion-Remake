function createWindowHealth({ BrowserWindow, expectedUrl, isEligible, onHealthy, onError = () => {} }) {
  const windows = new WeakMap();
  async function confirm(window) {
    const state = windows.get(window);
    if (!state || state.confirmed || state.confirming || !state.loaded || !state.nativeReady || !state.shown || !state.renderer
        || window.isDestroyed() || window.webContents.getURL() !== expectedUrl || !isEligible()) return;
    state.confirming = true;
    try {
      await onHealthy();
      state.confirmed = true;
    } catch (error) { onError(error); }
    finally { state.confirming = false; }
  }
  return {
    track(window) {
      windows.set(window, { loaded: false, nativeReady: false, shown: false, renderer: false });
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) {
          const state = windows.get(window);
          state.loaded = false;
          state.renderer = false;
        }
      });
      window.webContents.on('did-finish-load', () => {
        const state = windows.get(window);
        state.loaded = window.webContents.getURL() === expectedUrl;
        void confirm(window);
      });
      window.once('ready-to-show', () => {
        windows.get(window).nativeReady = true;
        void confirm(window);
      });
      window.on('show', () => {
        windows.get(window).shown = true;
        void confirm(window);
      });
    },
    async ready(event) {
      const window = BrowserWindow.fromWebContents(event.sender);
      const state = window && windows.get(window);
      if (!state || !isEligible() || event.senderFrame !== event.sender.mainFrame
          || event.senderFrame?.url !== expectedUrl || event.sender.getURL() !== expectedUrl) return false;
      state.renderer = true;
      await confirm(window);
      return true;
    }
  };
}

module.exports = { createWindowHealth };
