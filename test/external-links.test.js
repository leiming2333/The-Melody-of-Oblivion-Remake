const test = require('node:test');
const assert = require('node:assert/strict');
const { externalLinkTarget, createExternalLinkHandler } = require('../src/main/external-links');

test('launcher help, official mod pages, and account links use approved HTTPS hosts', () => {
  for (const url of [
    'https://bmclapi2.bangbang93.com/', 'https://mcimirror.top/',
    'https://space.bilibili.com/126269449',
    'https://www.curseforge.com/projects/123/files/456',
    'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases',
    'https://www.microsoft.com/link', 'https://aka.ms/AppRegInfo',
    'https://littleskin.cn/auth/register'
  ]) assert.equal(externalLinkTarget(url), url);
  assert.equal(externalLinkTarget('HTTPS://GITHUB.COM:443/'), 'https://github.com/');
});

test('external links reject untrusted hosts, misleading authorities, and non-web protocols', () => {
  for (const value of [
    'https://example.com/', 'http://github.com/', 'file:///tmp/test',
    'javascript:alert(1)', 'https://github.com.evil.example/',
    'https://github.com@evil.example/', 'https://evil.example@github.com/',
    'https://github.com:8443/', 'https://github.com./',
    'https://github.com\\@evil.example/', ' https://github.com/',
    'https://git\nhub.com/', null, {}, 123, '//github.com/'
  ]) assert.equal(externalLinkTarget(value), null, String(value));
});

test('external links can only open from the owned renderer main frame', async () => {
  const rendererUrl = 'file:///launcher/index.html';
  const mainFrame = {};
  const sender = { mainFrame, getURL: () => rendererUrl };
  const opened = [];
  let owned = true;
  const handle = createExternalLinkHandler({ rendererUrl,
    shell: { openExternal: async value => opened.push(value) },
    BrowserWindow: { fromWebContents: value => value === sender && owned ? {} : null }
  });
  const event = { sender, senderFrame: mainFrame };
  assert.equal(await handle(event, 'https://aka.ms/AppRegInfo'), true);
  assert.equal(await handle({ ...event, senderFrame: {} }, 'https://aka.ms/AppRegInfo'), false);
  sender.getURL = () => 'https://example.com/';
  assert.equal(await handle(event, 'https://aka.ms/AppRegInfo'), false);
  sender.getURL = () => rendererUrl;
  owned = false;
  assert.equal(await handle(event, 'https://aka.ms/AppRegInfo'), false);
  owned = true;
  assert.equal(await handle(event, 'https://example.com/'), false);
  assert.deepEqual(opened, ['https://aka.ms/AppRegInfo']);
});

test('opening a permitted browser link preserves operating system errors', async () => {
  const mainFrame = {};
  const error = new Error('browser unavailable');
  const handle = createExternalLinkHandler({ rendererUrl: 'file:///launcher/index.html',
    shell: { openExternal: async () => { throw error; } },
    BrowserWindow: { fromWebContents: () => ({}) }
  });
  await assert.rejects(handle({ senderFrame: mainFrame,
    sender: { mainFrame, getURL: () => 'file:///launcher/index.html' }
  }, 'https://github.com/'), value => value === error);
});
