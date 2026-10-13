function acquireSingleInstance(app, BrowserWindow, onMissingWindow) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) {
      if (onMissingWindow) void app.whenReady().then(() => {
        if (!BrowserWindow.getAllWindows().some((candidate) => !candidate.isDestroyed())) onMissingWindow();
      });
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}

module.exports = { acquireSingleInstance };
