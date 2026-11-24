const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { platformSigningArguments, sanitizeSigningEnvironment } = require('../scripts/platform-signing.cjs');

test('unset CI signing secrets become absent environment variables without modifying the caller', () => {
  const environment = Object.freeze({
    CSC_LINK: '', CSC_KEY_PASSWORD: ' \t', WIN_CSC_LINK: '\n', WIN_CSC_KEY_PASSWORD: '\r\n ',
    APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '\t', APPLE_TEAM_ID: ' ',
    APPLE_API_KEY: '', APPLE_API_KEY_ID: ' ', APPLE_API_ISSUER: '\n',
    APPLE_KEYCHAIN: '', APPLE_KEYCHAIN_PROFILE: '\t',
    MELODY_REQUIRE_CODE_SIGNING: 'false', OTHER_SETTING: ''
  });
  const cleaned = sanitizeSigningEnvironment(environment);
  assert.deepEqual(cleaned, { MELODY_REQUIRE_CODE_SIGNING: 'false', OTHER_SETTING: '' });
  assert.equal(environment.CSC_LINK, '');
  assert.equal(environment.APPLE_TEAM_ID, ' ');
});

test('configured certificate and notarization values keep their exact bytes', () => {
  const environment = {
    CSC_LINK: '  base64-certificate==\n', CSC_KEY_PASSWORD: ' password with spaces ',
    WIN_CSC_LINK: ' certificate.pfx ', WIN_CSC_KEY_PASSWORD: '\tpassword\n',
    APPLE_ID: ' developer@example.test ', APPLE_APP_SPECIFIC_PASSWORD: ' app-specific-password ',
    APPLE_TEAM_ID: ' TEAM123 ', APPLE_API_KEY: ' /private/key.p8 ',
    APPLE_API_KEY_ID: ' KEY123 ', APPLE_API_ISSUER: ' ISSUER123 '
  };
  assert.deepEqual(sanitizeSigningEnvironment(environment), environment);
});

test('required signing rejects whitespace-only certificates and notarization credentials', () => {
  const required = { MELODY_REQUIRE_CODE_SIGNING: 'true', CSC_LINK: ' \t' };
  assert.throws(() => platformSigningArguments('win32', required), /CSC_LINK/);
  assert.throws(() => platformSigningArguments('darwin', required), /CSC_LINK/);
  const mac = { ...required, CSC_LINK: 'certificate.p12', APPLE_ID: 'developer@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'TEAM123' };
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.throws(() => platformSigningArguments('darwin', { ...mac, [name]: ' \n' }), /notarization credentials/);
  }
  assert.deepEqual(platformSigningArguments('darwin', mac), ['--config.forceCodeSigning=true']);
});

test('electron-builder sees no certificate path for empty CI secrets and retains an explicitly configured Windows fallback', async () => {
  const script = `
    const assert = require('node:assert/strict');
    require('app-builder-lib');
    const { PlatformPackager } = require('app-builder-lib/out/platformPackager');
    const packager = { info: { config: {} }, platformSpecificBuildOptions: {} };
    const getLink = name => PlatformPackager.prototype.getCscLink.call(packager, name);
    if (process.env.EXPECT_WINDOWS_FALLBACK) assert.equal(getLink('WIN_CSC_LINK'), 'fixture-certificate.pfx');
    else {
      assert.ok(getLink() == null);
      assert.ok(getLink('WIN_CSC_LINK') == null);
    }
  `;
  const environment = { ...process.env, CSC_LINK: '', CSC_KEY_PASSWORD: '', WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '',
    APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '', EXPECT_WINDOWS_FALLBACK: '' };
  const options = { cwd: path.join(__dirname, '..'), windowsHide: true };
  await promisify(execFile)(process.execPath, ['-e', script], { ...options, env: sanitizeSigningEnvironment(environment) });
  await promisify(execFile)(process.execPath, ['-e', script], {
    ...options, env: sanitizeSigningEnvironment({ ...environment, CSC_LINK: 'fixture-certificate.pfx', EXPECT_WINDOWS_FALLBACK: '1' })
  });
});
