const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let click, resolve, reject;
  const requested = [], problems = [];
  const response = new Promise((fulfilled, failed) => { resolve = fulfilled; reject = failed; });
  const context = {
    versionDownloadActive: true, downloadCancelRequested: false, downloadCancellable: true,
    activeTaskId: 'old-task',
    cancelDownloadButton: { disabled: false, addEventListener(_event, listener) { click = listener; } },
    homeCancelDownloadButton: { disabled: false, hidden: false },
    downloadMessage: { textContent: 'Old task downloading' }, statusBadge: { textContent: 'DOWNLOAD' },
    minecraft: { cancelDownload(options) { requested.push(options.taskId); return response; } },
    showProblem(error) { problems.push(error); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("cancelDownloadButton.addEventListener('click'"),
    source.indexOf('if (minecraft?.onDownloadProgress)')), context);
  const nextTask = () => Object.assign(context, {
    activeTaskId: 'new-task', versionDownloadActive: true,
    downloadCancelRequested: true, downloadCancellable: true,
    downloadMessage: { textContent: 'Cancelling new task' },
    cancelDownloadButton: { disabled: true }, homeCancelDownloadButton: { disabled: true, hidden: false }
  });
  return { click, context, requested, problems, resolve, reject, nextTask };
}

for (const outcome of ['accepted', 'not-found', 'committing', 'failed']) {
  test(`an old cancellation ${outcome} response cannot change the next game task`, async () => {
    const f = fixture();
    const pending = f.click();
    assert.deepEqual(f.requested, ['old-task']);
    f.nextTask();
    if (outcome === 'failed') f.reject(new Error('Old IPC failure'));
    else f.resolve(outcome === 'accepted' ? { cancelled: 1 }
      : outcome === 'committing' ? { cancelled: 0, committing: true } : { cancelled: 0 });
    await pending;
    assert.equal(f.context.downloadCancelRequested, true);
    assert.equal(f.context.downloadCancellable, true);
    assert.equal(f.context.cancelDownloadButton.disabled, true);
    assert.equal(f.context.homeCancelDownloadButton.hidden, false);
    assert.equal(f.context.downloadMessage.textContent, 'Cancelling new task');
    assert.deepEqual(f.problems, []);
  });
}

test('a cancellation reply after the task finishes retains its terminal feedback', async () => {
  const f = fixture();
  const pending = f.click();
  Object.assign(f.context, { activeTaskId: '', versionDownloadActive: false, downloadCancelRequested: false });
  f.context.downloadMessage.textContent = 'Download cancelled';
  f.resolve({ cancelled: 0 });
  await pending;
  assert.equal(f.context.downloadMessage.textContent, 'Download cancelled');
});

test('an active cancellation failure restores both cancellation controls', async () => {
  const f = fixture();
  const pending = f.click();
  assert.equal(f.context.cancelDownloadButton.disabled, true);
  assert.equal(f.context.homeCancelDownloadButton.disabled, true);
  f.reject(new Error('IPC failure'));
  await pending;
  assert.equal(f.context.downloadCancelRequested, false);
  assert.equal(f.context.cancelDownloadButton.disabled, false);
  assert.equal(f.context.homeCancelDownloadButton.disabled, false);
  assert.equal(f.context.downloadMessage.textContent, 'Old task downloading');
  assert.equal(f.context.statusBadge.textContent, 'DOWNLOAD');
  assert.equal(f.problems.length, 1);
});

test('the current task can retry cancellation when the backend has not found a task', async () => {
  const f = fixture();
  const pending = f.click();
  f.resolve({ cancelled: 0 });
  await pending;
  assert.equal(f.context.downloadCancelRequested, false);
  assert.equal(f.context.cancelDownloadButton.disabled, false);
  assert.equal(f.context.homeCancelDownloadButton.disabled, false);
});

test('the current commit boundary disables both cancellation controls', async () => {
  const f = fixture();
  const pending = f.click();
  f.resolve({ cancelled: 0, committing: true });
  await pending;
  assert.equal(f.context.downloadCancellable, false);
  assert.equal(f.context.cancelDownloadButton.disabled, true);
  assert.equal(f.context.homeCancelDownloadButton.disabled, true);
  assert.equal(f.context.homeCancelDownloadButton.hidden, true);
});
