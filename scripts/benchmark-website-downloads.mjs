import { createHash } from 'node:crypto';

const MIB = 1024 * 1024;
const SITE = 'https://www.melodyoblivion.xyz';
const BLOB = 'https://4rgpxcwwpeiy2uij.public.blob.vercel-storage.com';
const rounds = Number(process.argv.find(arg => arg.startsWith('--rounds='))?.split('=')[1] ?? 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Use --rounds=1 through --rounds=5');
const timeoutMs = Number(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.split('=')[1] ?? 20000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid timeout');
const sourceFilter = process.argv.find(arg => arg.startsWith('--source='))?.split('=')[1]?.toLowerCase();
if (sourceFilter && !['r2', 'blob', 'github'].includes(sourceFilter)) throw new Error('Use --source=r2, blob, or github');

async function readRange(url, start, length, size) {
  const started = performance.now();
  const end = start + length - 1;
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}`, Origin: SITE, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(timeoutMs), referrerPolicy: 'no-referrer'
  });
  const headersMs = performance.now() - started;
  try {
    if (response.status !== 206) throw new Error(`HTTP ${response.status}; Range unavailable`);
    const range = response.headers.get('content-range');
    if (range !== `bytes ${start}-${end}/${size}`) throw new Error('Incorrect Content-Range');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) throw new Error('Incorrect body length');
    return { bytes, headersMs,
      cors: response.headers.get('access-control-allow-origin'),
      exposed: response.headers.get('access-control-expose-headers'),
      cache: response.headers.get('cf-cache-status') };
  } finally {
    try { await response.body?.cancel(); } catch { /* Already consumed. */ }
  }
}

async function sample(source, start, parallel, size) {
  const started = performance.now();
  const settled = await Promise.allSettled(Array.from({ length: parallel ? 4 : 1 }, (_, index) =>
    readRange(source.url, start + index * MIB, parallel ? MIB : 4 * MIB, size)));
  const error = settled.find(result => result.status === 'rejected');
  if (error) throw error.reason;
  const results = settled.map(result => result.value);
  const durationMs = performance.now() - started;
  const digest = createHash('sha256');
  for (const result of results) digest.update(result.bytes);
  return { mibPerSecond: 4 * 1000 / durationMs, durationMs,
    firstHeadersMs: Math.min(...results.map(result => result.headersMs)),
    digest: digest.digest('hex'), cors: results[0].cors, exposed: results[0].exposed, cache: results[0].cache };
}

async function main() {
  const response = await fetch(`${SITE}/api/latest-release`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
  const release = await response.json();
  const name = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
  const asset = release.assets?.find(item => item.name === name);
  if (!asset || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Number.isSafeInteger(asset.size)
    || asset.size < rounds * 4 * MIB || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) {
    throw new Error('Cannot benchmark unverified release metadata');
  }
  const path = `/releases/${release.tag_name}/${name}`;
  const sources = [
    { label: 'R2', url: `https://downloads.melodyoblivion.xyz${path}` },
    { label: 'Blob', url: `${BLOB}${path}` },
    { label: 'GitHub', url: `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${release.tag_name}/${name}` }
  ].filter(source => !sourceFilter || source.label.toLowerCase() === sourceFilter);
  console.log(`Read-only sample benchmark: ${release.tag_name}, Windows x64, ${rounds} rounds, 4 MiB per mode/source/round.`);
  console.log('Single mode = one 4 MiB Range; parallel mode = four 1 MiB Ranges. No full installer is saved.');
  const measurements = [];
  const expectedDigests = new Map();
  for (let round = 0; round < rounds; round++) {
    for (const source of sources) {
      for (const parallel of round % 2 ? [true, false] : [false, true]) {
        const mode = parallel ? '4-way' : 'single';
        try {
          const result = await sample(source, round * 4 * MIB, parallel, asset.size);
          const previous = expectedDigests.get(round);
          if (previous && previous !== result.digest) throw new Error('Sample checksum differs between sources/modes');
          expectedDigests.set(round, result.digest);
          measurements.push({ round: round + 1, source: source.label, mode, ...result });
          console.log(`${source.label} ${mode} round ${round + 1}: ${result.mibPerSecond.toFixed(2)} MiB/s; first headers ${result.firstHeadersMs.toFixed(0)} ms; CORS ${result.cors ?? 'missing'}; cache ${result.cache ?? 'n/a'}`);
        } catch (error) {
          measurements.push({ round: round + 1, source: source.label, mode, error: error.message });
          console.log(`${source.label} ${mode} round ${round + 1}: ${error.message}`);
        }
      }
    }
  }
  const median = values => {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  };
  const summary = sources.map(source => {
    const row = { source: source.label };
    for (const mode of ['single', '4-way']) {
      const values = measurements.filter(item => item.source === source.label && item.mode === mode && !item.error);
      row[mode] = values.length ? `${median(values.map(item => item.mibPerSecond)).toFixed(2)} MiB/s (${values.length}/${rounds})` : 'unavailable';
    }
    return row;
  });
  console.table(summary);
  console.log('These short samples describe this computer/network only, not full-download speed or an undeployed Worker.');
}

await main();
