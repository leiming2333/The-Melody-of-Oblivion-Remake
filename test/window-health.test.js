const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowHealth } = require('../src/main/window-health');

const expectedUrl = 'file:///launcher/index.html';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ isEligible = () => true, onHealthy } = {}) {
  const window = new EventEmitter(), contents = new EventEmitter();
  let url = expectedUrl, destroyed = false, visible = false, confirmed = 0;
  window.webContents = contents; window.isDestroyed = () => destroyed; window.isVisible = () => visible;
  contents.mainFrame = { url: expectedUrl }; contents.getURL = () => url;
  const errors = [];
  const health = createWindowHealth({ BrowserWindow: { fromWebContents: sender => sender === contents ? window : null },
    expectedUrl, isEligible, onHealthy: onHealthy ?? (async () => { confirmed++; }), onError: error => errors.push(error) });
  health.track(window);
  const ready = () => health.ready({ sender: contents, senderFrame: contents.mainFrame });
  return { window, contents, health, ready, errors, confirmed: () => confirmed,
    setUrl(value) { url = value; contents.mainFrame.url = value; },
    destroy() { destroyed = true; },
    async fire(name) {
      if (name === 'renderer') await ready();
      else if (name === 'loaded') contents.emit('did-finish-load');
      else { if (name === 'show') visible = true; window.emit(name); }
      await tick();
    } };
}

test('health confirmation requires a loaded main document, ready-to-show, actual show and renderer readiness in any order', async () => {
  const orders = [
    ['loaded', 'ready-to-show', 'show', 'renderer'],
    ['renderer', 'loaded', 'ready-to-show', 'show'],
    ['ready-to-show', 'show', 'renderer', 'loaded'],
    ['loaded', 'renderer', 'show', 'ready-to-show']
  ];
  for (const order of orders) {
    const f = fixture();
    for (let index = 0; index < order.length; index++) {
      await f.fire(order[index]);
      assert.equal(f.confirmed(), index === order.length - 1 ? 1 : 0, order.join(', '));
    }
  }
});

test('subframes, wrong URLs, untracked senders and destroyed windows cannot confirm health', async () => {
  const f = fixture(); await f.fire('loaded'); await f.fire('ready-to-show'); await f.fire('show');
  assert.equal(await f.health.ready({ sender: f.contents, senderFrame: { url: expectedUrl } }), false);
  f.setUrl('https://unexpected.example');
  assert.equal(await f.ready(), false);
  f.setUrl(expectedUrl);
  assert.equal(await f.health.ready({ sender: new EventEmitter(), senderFrame: {} }), false);
  f.destroy(); await f.ready();
  assert.equal(f.confirmed(), 0);
});

test('ineligible dev, smoke and non-owner launches never confirm a healthy update', async () => {
  for (const eligibility of [{ packaged: false, smoke: false, owner: true },
    { packaged: true, smoke: true, owner: true }, { packaged: true, smoke: false, owner: false }]) {
    const f = fixture({ isEligible: () => eligibility.packaged && !eligibility.smoke && eligibility.owner });
    await f.fire('loaded'); await f.fire('ready-to-show'); await f.fire('show');
    assert.equal(await f.ready(), false);
    assert.equal(f.confirmed(), 0);
  }
});

test('a new main-frame navigation requires fresh renderer readiness at the expected URL', async () => {
  const f = fixture(); await f.fire('loaded'); await f.fire('renderer'); await f.fire('ready-to-show');
  f.contents.emit('did-start-navigation', {}, 'https://unexpected.example', false, true);
  f.setUrl('https://unexpected.example');
  await f.fire('show'); assert.equal(f.confirmed(), 0);
  f.contents.emit('did-start-navigation', {}, expectedUrl, false, true);
  f.setUrl(expectedUrl); await f.fire('loaded');
  assert.equal(f.confirmed(), 0);
  await f.fire('renderer'); assert.equal(f.confirmed(), 1);
});

test('duplicate readiness events do not race or repeat an in-flight health confirmation', async () => {
  let attempts = 0, finish;
  const f = fixture({ onHealthy: () => { attempts++; return new Promise(resolve => { finish = resolve; }); } });
  await f.fire('loaded'); await f.fire('ready-to-show'); await f.fire('show');
  const pending = f.ready();
  await tick();
  await f.ready(); f.contents.emit('did-finish-load'); f.window.emit('show');
  assert.equal(attempts, 1);
  finish(); await pending; await f.ready(); await tick();
  assert.equal(attempts, 1);
});

test('a failing onHealthy callback leaves health unconfirmed and permits a later valid retry', async () => {
  let attempts = 0;
  const f = fixture({ onHealthy: async () => { if (++attempts === 1) throw new Error('journal locked'); } });
  await f.fire('loaded'); await f.fire('ready-to-show'); await f.fire('show');
  await f.ready(); assert.equal(f.errors.length, 1);
  await f.ready(); assert.equal(attempts, 2);
  await f.ready(); assert.equal(attempts, 2);
});
