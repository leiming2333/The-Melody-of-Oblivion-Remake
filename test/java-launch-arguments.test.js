const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const iconv = require('iconv-lite');
const { commandLength, quoteArgument, prepareJavaArguments, encodeArgumentFile } = require('../src/main/minecraft/java-launch-arguments');

async function temporaryDirectory(t, prefix = 'melody-arguments-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('short Windows commands and other platforms retain their original argument array', async () => {
  const args = ['-cp', '中文 路径.jar', 'Main'];
  assert.equal(await prepareJavaArguments({ javaExecutable: 'java', argumentsList: args, platform: 'win32' }), args);
  const long = ['a'.repeat(50000)];
  assert.equal(await prepareJavaArguments({ javaExecutable: 'java', argumentsList: long, platform: 'linux' }), long);
});

test('modern Windows Java uses the native code page without changing the original mod loader classpath', async (t) => {
  const root = await temporaryDirectory(t, '旋律 参数 ');
  const classpath = Array(600).fill(path.join(root, '中文 模组.jar')).join(';');
  const jvm = ['-DlegacyClassPath=' + classpath, '-cp', classpath, 'mod.loader.Main'];
  const game = ['--accessToken', 'private-token-stays-in-memory', '中文 参数'];
  const args = await prepareJavaArguments({ javaExecutable: 'java.exe', argumentsList: [...jvm, ...game],
    requiredJavaVersion: 17, platform: 'win32', directory: root, jvmArgumentCount: jvm.length,
    javaDetails: { nativeEncoding: 'GBK', fileEncoding: 'UTF-8' } });
  assert.deepEqual(args.slice(1), game);
  assert.equal(args[0], '@' + path.join(root, 'arguments.txt'));
  const bytes = await fs.readFile(path.join(root, 'arguments.txt'));
  const content = iconv.decode(bytes, 'GBK');
  assert.equal(content, jvm.map(quoteArgument).join('\n') + '\n');
  assert.ok(content.includes(classpath.replace(/\\/g, '\\\\')));
  assert.doesNotMatch(content, /private-token|--accessToken/);
  assert.ok(commandLength('java.exe', args) < 30000);
  assert.deepEqual((await fs.readdir(root)).sort(), ['arguments.txt']);
});

test('ASCII argument files need no guessed locale and lossy code-page conversion is rejected', async (t) => {
  const root = await temporaryDirectory(t);
  const content = '"Main"\n"' + 'a'.repeat(31000) + '"\n';
  assert.equal(encodeArgumentFile(content, path.join(root, 'arguments.txt')).toString(), content);
  assert.throws(() => encodeArgumentFile('"中文"\n', 'arguments.txt', { nativeEncoding: 'Cp1252' }),
    { code: 'ARGUMENT_ENCODING_UNSUPPORTED' });
  assert.throws(() => encodeArgumentFile('"Main"\n', '中文/arguments.txt', { nativeEncoding: 'Cp1252' }),
    { code: 'ARGUMENT_ENCODING_UNSUPPORTED' });
  assert.throws(() => encodeArgumentFile('"中文"\n', 'arguments.txt', {}), { code: 'ARGUMENT_ENCODING_UNSUPPORTED' });
  assert.equal(iconv.decode(encodeArgumentFile('"café"\n', 'arguments.txt', { nativeEncoding: 'Cp1252' }), 'Cp1252'), '"café"\n');
});

test('Java argument quoting preserves Windows slashes, quotes and control characters and rejects NUL', () => {
  assert.equal(quoteArgument('C:\\中文 path\\'), '"C:\\\\中文 path\\\\"');
  assert.equal(quoteArgument('a"b\n\r\t'), '"a\\"b\\n\\r\\t"');
  assert.throws(() => quoteArgument('bad\0arg'), /无效字符/);
});

test('oversized game arguments are never persisted in an argument file', async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(prepareJavaArguments({ javaExecutable: 'java.exe', argumentsList: ['Main', '--accessToken', 'a'.repeat(40000)],
    jvmArgumentCount: 1, requiredJavaVersion: 21, directory: root, platform: 'win32', javaDetails: { nativeEncoding: 'UTF-8' } }),
  { code: 'COMMAND_LINE_TOO_LONG' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('a path outside the Windows GBK repertoire fails without leaving a lossy argument file', async (t) => {
  const root = await temporaryDirectory(t, '旋律-😀-');
  await assert.rejects(prepareJavaArguments({ javaExecutable: 'java.exe', argumentsList: ['-Dlarge=' + 'a'.repeat(31000), 'Main'],
    requiredJavaVersion: 17, directory: root, platform: 'win32', javaDetails: { nativeEncoding: 'GBK' } }),
  { code: 'ARGUMENT_ENCODING_UNSUPPORTED' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('Java 8 reports remaining oversized non-classpath arguments clearly', async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(prepareJavaArguments({ javaExecutable: 'java.exe', argumentsList: ['-Dlarge=' + 'a'.repeat(40000), 'Main'],
    requiredJavaVersion: 8, directory: root, platform: 'win32' }), { code: 'COMMAND_LINE_TOO_LONG' });
});

// Enable explicitly for a native Windows JDK, e.g. JDK 17 under a GBK system.
// The probe has no network, authentication, native libraries or game data.
test('native Java executes Unicode long classpaths through both argfiles and Java 8 manifest JARs', {
  skip: process.platform !== 'win32' || !process.env.MELODY_JAVA_TEST_HOME
}, async (t) => {
  const run = promisify(execFile);
  const root = await temporaryDirectory(t, '旋律 Java 验收 ');
  const home = process.env.MELODY_JAVA_TEST_HOME;
  const java = path.join(home, 'bin', 'java.exe');
  const javac = path.join(home, 'bin', 'javac.exe');
  const jarTool = path.join(home, 'bin', 'jar.exe');
  const source = path.join(root, 'ArgumentProbe.java');
  const classes = path.join(root, 'classes');
  await fs.mkdir(classes);
  await fs.writeFile(source, `import java.util.Base64;
import java.nio.charset.StandardCharsets;
public class ArgumentProbe {
  private static String encoded(String value) { return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
  public static void main(String[] args) {
    System.out.println("PROPERTY=" + encoded(System.getProperty("probe.path")));
    System.out.println("ARG=" + encoded(args[0]));
    System.out.println("TOKEN=" + encoded(args[2]));
    System.out.println("CLASSPATH=" + encoded(System.getProperty("java.class.path")));
  }
}`);
  await run(javac, ['--release', '8', '-encoding', 'UTF8', '-d', classes, source], { windowsHide: true });
  const jar = path.join(root, '中文 类库 空格.jar');
  await run(jarTool, ['--create', '--file', jar, '-C', classes, '.'], { windowsHide: true });
  const details = await require('../src/main/minecraft/java-runtime').javaRuntimeDetails(java);
  const classpath = Array(600).fill(jar).join(';');
  const gameArgument = '中文 参数';
  const token = 'probe-token-native-only';
  const original = ['-Dprobe.path=中文 空格', '-cp', classpath, 'ArgumentProbe', gameArgument, '--accessToken', token];
  for (const mode of [8, details.majorVersion]) {
    const directory = path.join(root, `mode-${mode}`);
    await fs.mkdir(directory);
    const args = await prepareJavaArguments({ javaExecutable: java, argumentsList: original,
      requiredJavaVersion: mode, javaDetails: details, jvmArgumentCount: 4, directory, platform: 'win32' });
    const executable = mode === 8 && process.env.MELODY_JAVA8_TEST_HOME
      ? path.join(process.env.MELODY_JAVA8_TEST_HOME, 'bin', 'java.exe') : java;
    const { stdout } = await run(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.ok(stdout.includes('PROPERTY=' + Buffer.from('中文 空格').toString('base64')));
    assert.ok(stdout.includes('ARG=' + Buffer.from(gameArgument).toString('base64')));
    assert.ok(stdout.includes('TOKEN=' + Buffer.from(token).toString('base64')));
    if (mode >= 9) {
      assert.ok(stdout.includes('CLASSPATH=' + Buffer.from(classpath).toString('base64')),
        'modern mod loaders observe the exact original java.class.path');
      assert.ok(!(await fs.readFile(path.join(directory, 'arguments.txt'))).includes(Buffer.from(token)), 'credentials never enter the argument file');
    }
  }
});
