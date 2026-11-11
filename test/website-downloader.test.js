const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const downloader = import('../website-downloader.mjs');
const contents = Buffer.from('abcdefghijklmnop');
const source = id => ({ id, label: `Line ${id}`, url: `https://${id}.example/launcher.exe` });
const assetFor = bytes => ({ name: 'launcher.exe', size: bytes.length,
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });

function rangeOf(options, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range ?? '');
  return match ? { start: Number(match[1]), end: Number(match[2]) } : { start: 0, end: size - 1 };
}

function part(bytes, options, { hidden = false, body, extraHeaders = {} } = {}) {
  const { start, end } = rangeOf(options, bytes.length);
  const data = body ?? bytes.subarray(start, end + 1);
  return new Response(data, { status: 206, headers: {
    ...(!hidden ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    'Content-Length': String(end - start + 1), ...extraHeaders
  } });
}

async function download(options = {}) {
  const { downloadReleaseAsset } = await downloader;
  return downloadReleaseAsset({ asset: assetFor(contents), sources: [source('one')], autoSelect: false,
    segmentBytes: 4, concurrency: 1, connectTimeoutMs: 200, stallTimeoutMs: 200, retryDelayMs: 5, ...options });
}

test('automatic selection picks the faster readable source and reports its label', async () => {
  const calls = [];
  const progress = [];
  const result = await download({ autoSelect: true, probeBytes: 2, probeTimeoutMs: 200,
    sources: [source('slow'), source('fast')], onProgress: event => progress.push(event),
    fetchImpl: async (url, options) => {
      calls.push({ url, range: options.headers.Range });
      if (url.includes('slow')) await new Promise(resolve => setTimeout(resolve, 25));
      return part(contents, options);
    }
  });
  assert.equal(result.source, 'Line fast');
  assert.equal(result.filename, 'launcher.exe');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.ok(calls.slice(2).every(call => call.url.includes('fast')));
  assert.ok(progress.some(event => event.phase === 'testing'));
  assert.ok(progress.some(event => event.phase === 'verifying' && event.source === 'Line fast'));
});

test('Blob-style CORS supports Range without exposing Content-Range', async () => {
  const result = await download({ fetchImpl: async (_url, options) => part(contents, options, { hidden: true }) });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
});

test('a successful Range probe starts later segments before the first segment completes', async () => {
  let releaseFirst;
  let firstReleased = false;
  let parallel = false;
  const firstBody = new ReadableStream({ start(controller) {
    releaseFirst = () => {
      firstReleased = true;
      controller.enqueue(contents.subarray(0, 4));
      controller.close();
    };
  } });
  const result = await download({ autoSelect: true, probeBytes: 2, concurrency: 2,
    fetchImpl: async (_url, options) => {
      const { start, end } = rangeOf(options, contents.length);
      if (start === 0 && end === 3) return part(contents, options, { body: firstBody });
      if (start === 4) { parallel = !firstReleased; releaseFirst(); }
      return part(contents, options);
    }
  });
  assert.equal(parallel, true);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
});

for (const failureMode of ['truncated', 'disconnected']) {
  test(`${failureMode} downloads switch source and reuse only complete segments`, async () => {
    const calls = [];
    const progress = [];
    const result = await download({ sources: [source('broken'), source('healthy')],
      onProgress: event => progress.push(event), fetchImpl: async (url, options) => {
        const { start } = rangeOf(options, contents.length);
        calls.push({ url, start });
        if (url.includes('broken') && start === 4) {
          if (failureMode === 'truncated') return part(contents, options, { body: contents.subarray(4, 6) });
          return part(contents, options, { body: new ReadableStream({
            start(controller) { controller.enqueue(contents.subarray(4, 6)); },
            pull(controller) { controller.error(new Error('connection reset')); }
          }) });
        }
        return part(contents, options);
      }
    });
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
    assert.deepEqual(calls.filter(call => call.url.includes('healthy')).map(call => call.start), [4, 8, 12]);
    assert.ok(progress.some(event => event.phase === 'switching' && event.loaded === 4));
  });
}

test('parallel failure retains completed parts while cancelling another partial reader', async () => {
  const healthyStarts = [];
  let partialCancelled = false;
  const result = await download({ sources: [source('broken'), source('healthy')], concurrency: 3,
    fetchImpl: async (url, options) => {
      const { start } = rangeOf(options, contents.length);
      if (url.includes('healthy')) { healthyStarts.push(start); return part(contents, options); }
      if (start === 8) {
        await new Promise(resolve => setTimeout(resolve, 10));
        return part(contents, options, { body: contents.subarray(8, 9) });
      }
      if (start === 12) return part(contents, options, { body: new ReadableStream({
        start(controller) { controller.enqueue(contents.subarray(12, 13)); },
        cancel() { partialCancelled = true; }
      }) });
      return part(contents, options);
    }
  });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.deepEqual(healthyStarts, [8, 12]);
  assert.equal(partialCancelled, true);
});

test('a readable source recovers one transient part failure without cancelling healthy parts', async () => {
  for (const mode of ['disconnected', 'stalled', 'short-eof', 'http-503']) {
    const starts = [];
    const progress = [];
    let failedAttempts = 0;
    let fallbackRequests = 0;
    const result = await download({ sources: [source('original'), source('fallback')], concurrency: 2,
      stallTimeoutMs: 25, onProgress: event => progress.push(event),
      fetchImpl: async (url, options) => {
        const { start } = rangeOf(options, contents.length);
        if (url.includes('fallback')) { fallbackRequests++; return part(contents, options); }
        starts.push(start);
        if (start === 4 && failedAttempts++ === 0) {
          if (mode === 'http-503') return new Response('temporarily unavailable', { status: 503 });
          if (mode === 'short-eof') return part(contents, options, { body: contents.subarray(4, 5) });
          return part(contents, options, { body: new ReadableStream({
            start(controller) { controller.enqueue(contents.subarray(4, 5)); },
            pull(controller) { if (mode === 'disconnected') controller.error(new Error('reset')); }
          }) });
        }
        return part(contents, options);
      }
    });
    assert.equal(result.source, 'Line original', mode);
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents, mode);
    assert.equal(starts.filter(start => start === 4).length, 2, mode);
    assert.equal(starts.filter(start => start === 8).length, 1, mode);
    assert.equal(starts.filter(start => start === 12).length, 1, mode);
    assert.equal(fallbackRequests, 0, mode);
    assert.ok(progress.some(event => event.phase === 'downloading' && event.loaded === 12), mode);
  }
});

test('retry backoff remains immediately cancellable and never launches another request', async () => {
  const controller = new AbortController();
  const starts = [];
  let failed = false;
  await assert.rejects(download({ signal: controller.signal, retryDelayMs: 500,
    onProgress(event) { if (failed && event.loaded === 4) controller.abort(); },
    fetchImpl: async (_url, options) => {
      const { start } = rangeOf(options, contents.length);
      starts.push(start);
      if (start === 4) { failed = true; throw new Error('temporary reset'); }
      return part(contents, options);
    }
  }), error => error.name === 'AbortError');
  assert.deepEqual(starts, [0, 4]);
});

test('retry exhaustion advances to fallback once and corrupt ranges are never retried', async () => {
  let failedAttempts = 0;
  const result = await download({ sources: [source('broken'), source('healthy')],
    fetchImpl: async (url, options) => {
      if (url.includes('broken') && rangeOf(options, contents.length).start === 4) {
        failedAttempts++;
        throw new Error('connection reset');
      }
      return part(contents, options);
    }
  });
  assert.equal(failedAttempts, 2);
  assert.equal(result.source, 'Line healthy');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  for (const mode of ['oversized', 'wrong-header']) {
    let downloadRequests = 0;
    await assert.rejects(download({ autoSelect: true, probeBytes: 2,
      fetchImpl: async (_url, options) => {
        if (options.headers.Range === 'bytes=0-1') return part(contents, options);
        downloadRequests++;
        return part(contents, options, mode === 'oversized' ? { body: Buffer.alloc(5) }
          : { extraHeaders: { 'Content-Range': 'bytes 1-4/16' } });
      }
    }), error => error.code === 'SIZE_MISMATCH');
    assert.equal(downloadRequests, 1, mode);
  }
});

test('mixed-source digest mismatch clears poisoned parts before retrying the healthy source', async () => {
  const healthyStarts = [];
  const corrupted = Buffer.from(contents);
  corrupted[0] ^= 255;
  const result = await download({ sources: [source('poisoned'), source('healthy')],
    fetchImpl: async (url, options) => {
      const { start } = rangeOf(options, contents.length);
      if (url.includes('poisoned')) {
        if (start > 0) throw new Error('connection lost');
        return part(corrupted, options);
      }
      healthyStarts.push(start);
      return part(contents, options);
    }
  });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.deepEqual(healthyStarts, [4, 8, 12, 0, 4, 8, 12]);
});

test('a single corrupt source is never returned and the next source starts clean', async () => {
  const corrupted = Buffer.from(contents);
  corrupted[6] ^= 255;
  const starts = [];
  const result = await download({ sources: [source('bad'), source('good')], fetchImpl: async (url, options) => {
    if (url.includes('good')) starts.push(rangeOf(options, contents.length).start);
    return part(url.includes('bad') ? corrupted : contents, options);
  } });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.deepEqual(starts, [0, 4, 8, 12]);
  await assert.rejects(download({ fetchImpl: async (_url, options) => part(corrupted, options) }),
    error => error.code === 'CHECKSUM_MISMATCH');
});

test('cancellation stops readers and never returns a saveable Blob', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let saved = false;
  const pending = download({ signal: controller.signal, stallTimeoutMs: 1000,
    onProgress(event) { if (event.loaded === 1) controller.abort(); },
    fetchImpl: async (_url, options) => part(contents, options, { body: new ReadableStream({
      start(stream) { stream.enqueue(contents.subarray(0, 1)); },
      cancel() { cancelled++; }
    }) })
  }).then(() => { saved = true; });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(saved, false);
  assert.equal(cancelled, 1);
});

test('ignored Range streams the whole file once instead of duplicating full requests', async () => {
  let calls = 0;
  const result = await download({ concurrency: 4, fetchImpl: async () => { calls++; return new Response(contents); } });
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
});

test('an ignored-Range source discovered by probes uses a normal streaming GET', async () => {
  const ranges = [];
  const result = await download({ autoSelect: true, probeBytes: 2, fetchImpl: async (_url, options) => {
    ranges.push(options.headers.Range);
    return new Response(contents);
  } });
  assert.deepEqual(ranges, ['bytes=0-1', undefined]);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
});

test('a source that stops honoring Range after probing retries once as a whole stream', async () => {
  let wholeRequests = 0;
  let cancelledRanges = 0;
  const result = await download({ autoSelect: true, probeBytes: 2, concurrency: 4, fetchImpl: async (_url, options) => {
    if (options.headers.Range === 'bytes=0-1') return part(contents, options);
    if (!options.headers.Range) { wholeRequests++; return new Response(contents); }
    return new Response(new ReadableStream({ cancel() { cancelledRanges++; } }));
  } });
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.equal(wholeRequests, 1);
  assert.equal(cancelledRanges, 4);
});

test('oversized ranged and whole bodies cannot produce a saveable result', async () => {
  await assert.rejects(download({ fetchImpl: async (_url, options) => part(contents, options, {
    body: Buffer.from('too many bytes')
  }) }), error => error.code === 'SIZE_MISMATCH');
  await assert.rejects(download({ fetchImpl: async () => new Response(Buffer.concat([contents, Buffer.from('!')])) }),
    error => error.code === 'SIZE_MISMATCH');
});

test('visible mismatched Content-Range is rejected even when bytes happen to match', async () => {
  await assert.rejects(download({ fetchImpl: async (_url, options) => part(contents, options, {
    extraHeaders: { 'Content-Range': 'bytes 1-4/16' }
  }) }), error => error.code === 'SIZE_MISMATCH');
});

test('connection and stalled-body timeouts advance to a healthy fallback', async () => {
  for (const mode of ['connection', 'stall']) {
    let cancelled = false;
    const result = await download({ sources: [source('stuck'), source('healthy')],
      connectTimeoutMs: 25, stallTimeoutMs: 25, fetchImpl: async (url, options) => {
        if (url.includes('healthy')) return part(contents, options);
        if (mode === 'connection') return new Promise(() => {});
        return part(contents, options, { body: new ReadableStream({ cancel() { cancelled = true; } }) });
      }
    });
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
    if (mode === 'stall') assert.equal(cancelled, true);
  }
});

test('untrusted metadata fails before any request and cancellation interrupts verification', async () => {
  let calls = 0;
  await assert.rejects(download({ asset: { ...assetFor(contents), digest: null },
    fetchImpl: async () => { calls++; }
  }), error => error.code === 'INVALID_ASSET');
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(download({ signal: controller.signal,
    fetchImpl: async (_url, options) => part(contents, options),
    digestImpl() { controller.abort(); return new Promise(() => {}); }
  }), error => error.name === 'AbortError');
});

function trickle(bytes, delayMs, onData) {
  let offset = 0;
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (cancelled) return;
      if (offset === bytes.length) controller.close();
      else { onData?.(); controller.enqueue(bytes.subarray(offset, ++offset)); }
    },
    cancel() { cancelled = true; }
  });
}

test('a trickling source switches only when a faster measured fallback exists', async () => {
  const progress = [];
  const healthyStarts = [];
  let probing = true;
  let probeClock = 0;
  const result = await download({ autoSelect: true, probeBytes: 2, probeTimeoutMs: 200,
    slowWindowMs: 30, slowWarmupMs: 5, sources: [source('degraded'), source('healthy')],
    nowImpl: () => probing ? probeClock : performance.now(),
    onProgress(event) { progress.push(event); if (event.phase !== 'testing') probing = false; },
    fetchImpl: async (url, options) => {
      const { start, end } = rangeOf(options, contents.length);
      if (url.includes('healthy')) {
        if (probing) { await new Promise(resolve => setTimeout(resolve, 5)); probeClock += 2; }
        else healthyStarts.push(start);
      } else if (probing) probeClock++;
      if (url.includes('degraded') && start > 0) return part(contents, options, {
        body: trickle(contents.subarray(start, end + 1), 15)
      });
      return part(contents, options);
    }
  });
  assert.equal(result.source, 'Line healthy');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), contents);
  assert.deepEqual(healthyStarts, [4, 8, 12]);
  assert.ok(progress.some(event => event.phase === 'switching' && event.loaded === 4));
  const lone = await download({ autoSelect: true, probeBytes: 2, slowWindowMs: 10, slowWarmupMs: 0,
    fetchImpl: async (_url, options) => {
      const { start, end } = rangeOf(options, contents.length);
      return part(contents, options, { body: end - start + 1 === 2 ? undefined
        : trickle(contents.subarray(start, end + 1), 3) });
    }
  });
  assert.deepEqual(Buffer.from(await lone.blob.arrayBuffer()), contents);
});

test('speed monitoring sums streams instead of rejecting individually slower parts', async () => {
  const bytes = Buffer.alloc(80, 42);
  let switched = false;
  let probing = true;
  let probeClock = 0;
  let transferClock = 0;
  const result = await download({ asset: assetFor(bytes), segmentBytes: 16, concurrency: 4,
    autoSelect: true, probeBytes: 4, probeTimeoutMs: 200, slowWindowMs: 20, slowWarmupMs: 5,
    stallTimeoutMs: 1000, sources: [source('parallel'), source('backup')],
    nowImpl: () => probing ? probeClock : transferClock,
    onProgress(event) {
      if (event.phase !== 'testing') probing = false;
      if (event.phase === 'switching') switched = true;
    },
    fetchImpl: async (url, options) => {
      const { start, end } = rangeOf(options, bytes.length);
      if (probing) {
        if (url.includes('backup')) { await new Promise(resolve => setTimeout(resolve, 4)); probeClock += 16; }
        else probeClock++;
      }
      return part(bytes, options, { body: start > 0
        ? trickle(bytes.subarray(start, end + 1), 4, () => { transferClock += 5; }) : undefined });
    }
  });
  assert.equal(result.source, 'Line parallel');
  assert.equal(switched, false);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});

test('an expired permit is fatal and never automatically falls back to a public download', async () => {
  const calls = [];
  await assert.rejects(download({ sources: [source('protected'), source('public')],
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (url.includes('protected')) return new Response('Verify again', { status: 403 });
      return part(contents, options);
    }
  }), { code: 'AUTHORIZATION_EXPIRED' });
  assert.deepEqual(calls, [source('protected').url]);
});

test('default downloader uses four workers and one-MiB parts', async () => {
  const { downloadReleaseAsset } = await downloader;
  const bytes = Buffer.alloc(1048576 * 4 + 9, 17);
  const starts = [];
  const result = await downloadReleaseAsset({ asset: assetFor(bytes), sources: [source('default')],
    fetchImpl: async (_url, options) => {
      const { start, end } = rangeOf(options, bytes.length);
      starts.push([start, end]);
      assert.ok(end - start + 1 <= 1048576);
      return part(bytes, options);
    }
  });
  assert.deepEqual(starts, [[0, 32767], [0, 1048575], [1048576, 2097151],
    [2097152, 3145727], [3145728, 4194303], [4194304, 4194312]]);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});
