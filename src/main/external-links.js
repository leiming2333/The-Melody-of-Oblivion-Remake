'use strict';

// These hosts back links exposed by the launcher UI. Authentication providers
// open their validated device-code URL through the account service separately.
const EXTERNAL_LINK_HOSTS = new Set([
  'bmclapi2.bangbang93.com',
  'mcimirror.top',
  'space.bilibili.com',
  'www.curseforge.com',
  'github.com',
  'microsoft.com',
  'www.microsoft.com',
  'login.microsoftonline.com',
  'login.live.com',
  'aka.ms',
  'littleskin.cn',
  'www.littleskin.cn'
]);

function externalLinkTarget(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !EXTERNAL_LINK_HOSTS.has(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function createExternalLinkHandler({ shell, BrowserWindow, rendererUrl }) {
  return async (event, value) => {
    if (event.senderFrame !== event.sender.mainFrame
        || event.sender.getURL() !== rendererUrl
        || !BrowserWindow.fromWebContents(event.sender)) return false;
    const target = externalLinkTarget(value);
    if (!target) return false;
    await shell.openExternal(target);
    return true;
  };
}

module.exports = { externalLinkTarget, createExternalLinkHandler };
