const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
// Keep this list aligned with src/shared/website-cdn-config.json. The public R2
// download origin is deliberately excluded: it cannot enforce signed permits.
const VERIFIED_BASES = [
  'https://verified-downloads.melodyoblivion.xyz',
  'https://www.melodyoblivion.xyz/verified-downloads',
  'https://melodyoblivion.xyz/verified-downloads'
];
let turnstileLoading;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkCancelled(signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Download cancelled'), { name: 'AbortError' });
}

export function loadTurnstile() {
  if (typeof globalThis.turnstile?.render === 'function') return Promise.resolve(globalThis.turnstile);
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let finished = false;
    const timer = setTimeout(() => finish(failure('VERIFICATION_UNAVAILABLE', 'Human verification could not load')), 15000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(globalThis.turnstile);
    }
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => finish(typeof globalThis.turnstile?.render === 'function'
      ? null : failure('VERIFICATION_UNAVAILABLE', 'Human verification could not load'));
    script.onerror = () => finish(failure('VERIFICATION_UNAVAILABLE', 'Human verification could not load'));
    document.head.append(script);
  }).catch(error => { turnstileLoading = undefined; throw error; });
  return turnstileLoading;
}

async function jsonRequest(fetchImpl, path, options, signal) {
  checkCancelled(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(failure('VERIFICATION_UNAVAILABLE', 'Human verification timed out')), 10000);
  try {
    const response = await fetchImpl(path, {
      ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error'
    });
    let result;
    try { result = await response.json(); } catch { throw failure('VERIFICATION_UNAVAILABLE', 'Human verification returned an invalid response'); }
    checkCancelled(signal);
    if (!response.ok) throw failure(result?.code || 'VERIFICATION_UNAVAILABLE', 'Human verification failed; please try again');
    return result;
  } catch (error) {
    checkCancelled(signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function validatedDownloadBaseUrl(value) {
  try {
    const base = new URL(value);
    const canonical = `${base.origin}${base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')}`;
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash
      || !VERIFIED_BASES.includes(canonical) || ![canonical, `${canonical}/`].includes(value)) {
      throw new Error('Untrusted download base');
    }
    return canonical;
  } catch { throw failure('INVALID_AUTHORIZATION', 'Download configuration is invalid'); }
}

function expectedObjectUrl(expectedUrl, tag, asset) {
  const path = `/releases/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
  const fallback = `${VERIFIED_BASES[0]}${path}`;
  try {
    const expected = new URL(expectedUrl || fallback);
    if (expected.search || expected.hash || expected.username || expected.password || expected.port
      || !expected.pathname.endsWith(path)) {
      throw new Error('Invalid expected download URL');
    }
    validatedDownloadBaseUrl(`${expected.origin}${expected.pathname.slice(0, -path.length)}`);
    return expected;
  } catch { throw failure('INVALID_AUTHORIZATION', 'Download authorization is invalid'); }
}

export function validatedDownloadAuthorization(value, tag, asset, expectedUrl, now = Date.now()) {
  const expected = expectedObjectUrl(expectedUrl, tag, asset);
  try {
    if (typeof value?.url !== 'string') throw new Error('Missing authorized URL');
    const candidate = new URL(value.url);
    const samePath = candidate.protocol === expected.protocol && candidate.hostname === expected.hostname
      && candidate.port === expected.port && candidate.pathname === expected.pathname
      && !candidate.username && !candidate.password && !candidate.hash;
    if (!samePath) throw new Error('Unexpected download origin');
    const keys = [...candidate.searchParams.keys()];
    if (keys.some(key => !['expires', 'signature'].includes(key))
      || candidate.searchParams.getAll('expires').length !== 1 || candidate.searchParams.getAll('signature').length !== 1) {
      throw new Error('Unexpected download parameters');
    }
    const expiresText = candidate.searchParams.get('expires');
    const expires = Number(expiresText);
    if (!/^\d{10,12}$/.test(expiresText ?? '') || !Number.isSafeInteger(expires)
      || expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + 3600
      || !/^[A-Za-z\d_-]{43}$/.test(candidate.searchParams.get('signature') ?? '')
      || typeof value.expiresAt !== 'string' || Date.parse(value.expiresAt) !== expires * 1000) {
      throw new Error('Invalid or expired authorization');
    }
    return { url: candidate.href, expiresAt: value.expiresAt };
  } catch { throw failure('INVALID_AUTHORIZATION', 'Download authorization is invalid or expired'); }
}

export async function authorizeWebsiteDownload({ tag, asset, expectedUrl, container, signal,
  fetchImpl = globalThis.fetch, loadTurnstile: loadWidget = loadTurnstile } = {}) {
  checkCancelled(signal);
  const name = typeof asset === 'string' ? asset : asset?.name;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || typeof name !== 'string' || !container) {
    throw failure('INVALID_ASSET', 'Choose a release asset before verifying');
  }
  const config = await jsonRequest(fetchImpl, '/api/download-config', { method: 'GET' }, signal);
  if (config?.enabled !== true || typeof config.siteKey !== 'string' || !config.siteKey || config.action !== 'download') {
    throw failure('DOWNLOAD_NOT_CONFIGURED', 'Verified downloads are temporarily unavailable');
  }
  const baseUrl = validatedDownloadBaseUrl(config.baseUrl);
  const authorizedObjectUrl = `${baseUrl}/releases/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  if (expectedUrl && expectedObjectUrl(expectedUrl, tag, name).href !== authorizedObjectUrl) {
    throw failure('INVALID_AUTHORIZATION', 'Download configuration changed; please try again');
  }
  const turnstile = await loadWidget();
  checkCancelled(signal);
  let widgetId;
  let abortListener;
  try {
    const token = await new Promise((resolve, reject) => {
      abortListener = () => reject(signal.reason ?? Object.assign(new Error('Download cancelled'), { name: 'AbortError' }));
      signal?.addEventListener('abort', abortListener, { once: true });
      widgetId = turnstile.render(container, {
        sitekey: config.siteKey, action: 'download', theme: 'auto', size: 'flexible',
        callback: value => typeof value === 'string' && value.length > 0 && value.length <= 2048
          ? resolve(value) : reject(failure('VERIFICATION_FAILED', 'Human verification failed')),
        'expired-callback': () => reject(failure('VERIFICATION_EXPIRED', 'Human verification expired; please try again')),
        'error-callback': () => { reject(failure('VERIFICATION_FAILED', 'Human verification failed; please try again')); return true; },
        'timeout-callback': () => reject(failure('VERIFICATION_EXPIRED', 'Human verification timed out; please try again'))
      });
    });
    checkCancelled(signal);
    const result = await jsonRequest(fetchImpl, '/api/download-authorization', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, asset: name, turnstileToken: token })
    }, signal);
    if (result?.authorized === false || result?.success === false) {
      throw failure(result?.code || 'VERIFICATION_FAILED', 'Human verification failed; please try again');
    }
    return validatedDownloadAuthorization(result, tag, name, authorizedObjectUrl);
  } finally {
    signal?.removeEventListener('abort', abortListener);
    if (widgetId !== undefined) {
      try { turnstile.remove?.(widgetId); } catch { /* A removed widget cannot authorize another download. */ }
    }
    container.replaceChildren();
  }
}
