const crypto = require('node:crypto');

const SIGNATURE_MAX_BYTES = 16 * 1024;
const DOMAIN = 'melody-of-oblivion/release-asset/v1\n';

function signatureError(message) {
  return Object.assign(new Error(`更新签名校验失败：${message}`), { code: 'UPDATE_SIGNATURE_INVALID' });
}

function keyFingerprint(publicKey) {
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw signatureError('公钥必须为 Ed25519');
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function payload(value) {
  if (value?.schemaVersion !== 1 || value.algorithm !== 'Ed25519'
    || !/^[a-f\d]{64}$/.test(value.keyId ?? '')
    || !/^v\d+\.\d+\.\d+$/.test(value.tag ?? '')
    || typeof value.name !== 'string' || !value.name || value.name.length > 255
    || value.name === '.' || value.name === '..' || /[\\/\u0000-\u001f]/.test(value.name)
    || !Number.isSafeInteger(value.size) || value.size <= 0
    || !/^[a-f\d]{64}$/.test(value.sha256 ?? '')) throw signatureError('签名元数据无效');
  return Buffer.from(DOMAIN + JSON.stringify({ schemaVersion: 1, algorithm: 'Ed25519',
    keyId: value.keyId, tag: value.tag, name: value.name, size: value.size, sha256: value.sha256 }));
}

function signAsset(metadata, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw signatureError('私钥必须为 Ed25519');
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const { tag, name, size, sha256 } = metadata;
  const value = { schemaVersion: 1, algorithm: 'Ed25519', keyId: keyFingerprint(publicKey), tag, name, size, sha256 };
  return { ...value, signature: crypto.sign(null, payload(value), key).toString('base64') };
}

function verifyAssetSignature(text, expected, trustedKeys) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SIGNATURE_MAX_BYTES) throw signatureError('签名文件过大或无效');
  let value;
  try { value = JSON.parse(text); } catch { throw signatureError('签名文件不是有效 JSON'); }
  const message = payload(value);
  const trustedKey = trustedKeys?.find(key => key.keyId === value.keyId);
  if (!trustedKey || keyFingerprint(trustedKey.publicKey) !== value.keyId) throw signatureError('签名密钥不受信任');
  if (value.tag !== expected.tag || value.name !== expected.name
    || (expected.size !== undefined && value.size !== expected.size)) throw signatureError('签名与版本、文件名或大小不一致');
  if (typeof value.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)
    || !crypto.verify(null, message, trustedKey.publicKey, Buffer.from(value.signature, 'base64'))) throw signatureError('数字签名不匹配');
  return value;
}

async function readBoundedText(response, maxBytes = SIGNATURE_MAX_BYTES) {
  if (Number(response.headers?.get('content-length')) > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw signatureError('校验文件超过大小限制');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw signatureError('校验文件超过大小限制');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw signatureError('校验文件超过大小限制');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { reader.releaseLock(); }
}

module.exports = { SIGNATURE_MAX_BYTES, keyFingerprint, signAsset, verifyAssetSignature, signatureError, readBoundedText };
