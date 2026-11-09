const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
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
    const timer = setTimeout(() => finish(failure('VERIFICATION_UNAVAILABLE', 'Human verification could not load')), 15000);
    function finish(error) {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve(globalThis.turnstile);
    }
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => finish(typeof globalThis.turnstile?.render === 'function' ? null
      : failure('VERIFICATION_UNAVAILABLE', 'Human verification could not load'));
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
    const response = await fetchImpl(path, { ...options, signal: controller.signal,
      credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const result = await response.json();
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

export function validatedDownloadAuthorization(value, tag, asset, now = Date.now()) {
  const name = typeof asset === 'string' ? asset : asset?.name;
  try {
    const url = new URL(value?.url);
    const expires = Date.parse(value?.expiresAt);
    const expiry = Number(url.searchParams.get('expires'));
    if (url.protocol !== 'https:' || url.hostname !== 'downloads.melodyoblivion.xyz'
      || url.port || url.username || url.password || url.hash
      || url.pathname !== `/releases/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
      || url.searchParams.size !== 2 || !/^[A-Za-z\d_-]{43}$/.test(url.searchParams.get('signature') ?? '')
      || !/^\d+$/.test(url.searchParams.get('expires') ?? '') || !Number.isSafeInteger(expiry)
      || Math.abs(expires - expiry * 1000) > 1000
      || !Number.isFinite(expires) || expires <= now + 5000 || expires > now + 3600000) throw new Error('Invalid authorization');
    return { url: url.href, expiresAt: new Date(expires).toISOString() };
  } catch { throw failure('INVALID_AUTHORIZATION', 'Download authorization is invalid or expired'); }
}

/** Verify one download, then return a short-lived authenticated Worker URL. */
export async function authorizeWebsiteDownload({ tag, asset, container, signal,
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
        callback: token => typeof token === 'string' && token.length > 0 && token.length <= 2048
          ? resolve(token) : reject(failure('VERIFICATION_FAILED', 'Human verification failed')),
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
    return validatedDownloadAuthorization(result, tag, name);
  } finally {
    signal?.removeEventListener('abort', abortListener);
    if (widgetId !== undefined) {
      try { turnstile.remove(widgetId); } catch { /* A removed widget cannot authorize another download. */ }
    }
    container.replaceChildren();
  }
}
