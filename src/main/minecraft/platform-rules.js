const os = require('node:os');

function platformName(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

function architectureName(arch = process.arch) {
  return arch === 'ia32' ? 'x86' : arch;
}

function matches(pattern, value) {
  try { return new RegExp(pattern).test(value); } catch { return false; }
}

function ruleMatches(rule, features = {}, environment = {}) {
  if (!rule || typeof rule !== 'object') return false;
  const platform = environment.platform ?? process.platform;
  const arch = environment.arch ?? process.arch;
  if (rule.os) {
    if (rule.os.name && rule.os.name !== platformName(platform)) return false;
    if (rule.os.arch) {
      const aliases = arch === 'ia32' ? ['x86', 'ia32']
        : arch === 'x64' ? ['x86_64', 'amd64', 'x64']
          : arch === 'arm64' ? ['aarch64', 'arm64'] : [arch];
      // Mojang architecture rules are regular expressions over the JVM's
      // os.arch value, whose spelling varies between Java distributions.
      if (!aliases.some((name) => matches(`^(?:${rule.os.arch})$`, name))) return false;
    }
    if (rule.os.version && !matches(rule.os.version, environment.release ?? os.release())) return false;
  }
  return !rule.features || Object.entries(rule.features).every(
    ([name, required]) => Boolean(features[name]) === Boolean(required)
  );
}

function rulesAllow(rules, features = {}, environment = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features, environment)) allowed = rule.action === 'allow';
  }
  return allowed;
}

module.exports = { platformName, architectureName, ruleMatches, rulesAllow };
