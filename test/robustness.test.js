import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { analyze, loadCompiler, compilerCrashMessage, stderrTail, DEFAULT_TIMEOUT_SECONDS } from '../src/analyze.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'src/cli.js');
const realCompiler = createRequire(import.meta.url).resolve('typescript');
const options = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };
function fixture(t, config, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-rob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}
// A typescript package directory that exposes the real compiler API but runs a custom tsc.js.
function fakeCompiler(t, tscSource, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-fake-ts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/typescript.js'), version
    ? `module.exports = { version: ${JSON.stringify(version)}, createProgram() {} };`
    : `module.exports = require(${JSON.stringify(realCompiler)});`);
  fs.writeFileSync(path.join(dir, 'lib/tsc.js'), tscSource);
  return dir;
}
const simple = t => fixture(t, { compilerOptions: options, files: ['main.ts'] }, { 'main.ts': 'export const x = 1;' });
const emptyReport = (findings, extra = {}) => ({ typescriptVersion: '5', project: 'p', diagnostics: {},
  summary: { compilerExitCode: 0, programFiles: 1 }, hotspots: [], warnings: [], findings, ...extra });

test('crash messages include stderr tail, heap diagnosis and a max-old-space-size hint', () => {
  const stderr = ['noise', ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', '\u001b[31m'].join('\n');
  const heap = compilerCrashMessage('SIGABRT', stderr);
  assert.match(heap, /^Compiler terminated by SIGABRT\./);
  assert.match(heap, /ran out of JavaScript heap memory/);
  assert.match(heap, /--max-old-space-size <MB>/);
  assert.match(heap, /JavaScript heap out of memory/);
  assert.ok(!heap.includes('line 0'), 'only the last lines are shown');
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(heap));
  assert.match(compilerCrashMessage('SIGABRT', ''), /out-of-memory killer or a native crash/);
  assert.match(compilerCrashMessage('SIGABRT', stderr, 4096), /already limited to --max-old-space-size 4096/);
  assert.doesNotMatch(compilerCrashMessage('SIGTERM', ''), /max-old-space-size/);
  assert.equal(stderrTail('a\n\n  b  \n').join('|'), 'a|b');
});

test('a compiler that aborts is reported with its stderr and the heap option is passed to the process', { skip: process.platform === 'win32' }, async t => {
  const tsc = fakeCompiler(t, 'console.error("argv " + JSON.stringify(process.execArgv));\n' +
    'console.error("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");\nprocess.kill(process.pid, "SIGABRT");');
  const dir = simple(t);
  await assert.rejects(analyze({ project: dir, typescript: tsc, maxOldSpaceMb: 321 }), error => {
    assert.match(error.message, /Compiler terminated by SIGABRT/);
    assert.match(error.message, /heap memory/);
    assert.match(error.message, /--max-old-space-size=321/);
    assert.match(error.message, /already limited to --max-old-space-size 321/);
    return true;
  });
  await assert.rejects(analyze({ project: dir, typescript: tsc }), /Retry with --max-old-space-size <MB>/);
});

test('long compiler runs report progress and the timeout message explains the type dump', async t => {
  const tsc = fakeCompiler(t, 'setTimeout(() => console.log("Total time: 1.50s"), 450);');
  const dir = simple(t);
  const ticks = [];
  await analyze({ project: dir, typescript: tsc, progressIntervalMs: 100, onProgress: s => ticks.push(s) });
  assert.ok(ticks.length >= 2, `progress ticks: ${ticks.length}`);
  const slow = fakeCompiler(t, 'setTimeout(() => {}, 5000);');
  await assert.rejects(analyze({ project: dir, typescript: slow, timeoutMs: 100 }), /exceeded 0\.1s.*type dump.*Total time.*Increase --timeout/);
});

test('default timeout covers the slowest measured run, and the CLI default matches', () => {
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 900);
  assert.ok(DEFAULT_TIMEOUT_SECONDS > 267);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /default: 900/);
  assert.match(help, /--max-old-space-size <MB>/);
  assert.match(help, /--typescript <path>/);
});

test('--max-old-space-size and --typescript are validated by the CLI', t => {
  const dir = simple(t);
  const run = args => spawnSync(process.execPath, [cli, '-p', dir, ...args], { encoding: 'utf8' });
  assert.match(run(['--max-old-space-size', 'abc']).stderr, /between 256 and 1048576/);
  assert.match(run(['--max-old-space-size', '64']).stderr, /between 256 and 1048576/);
  assert.match(run(['--max-old-space-size']).stderr, /requires a value/);
  assert.match(run(['--typescript', path.join(dir, 'nowhere')]).stderr, /--typescript path not found/);
  const ok = run(['--typescript', path.dirname(path.dirname(realCompiler)), '--max-old-space-size', '1024', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).typescriptVersion, ts.version);
});

test('--typescript selects the compiler and keeps the 5.x/6.x check', t => {
  const packageDir = path.dirname(path.dirname(realCompiler));
  for (const value of [packageDir, realCompiler, path.dirname(realCompiler)]) {
    const compiler = loadCompiler(os.tmpdir(), value);
    assert.equal(compiler.ts.version, ts.version);
    assert.equal(compiler.tscPath, path.join(path.dirname(realCompiler), 'tsc.js'));
  }
  const seven = fakeCompiler(t, '', '7.0.2');
  assert.throws(() => loadCompiler(os.tmpdir(), seven), /TypeScript 7\.0\.2 is unsupported.*--typescript <path>/);
  assert.throws(() => loadCompiler(os.tmpdir(), os.tmpdir()), /must be a typescript package directory/);
  const native = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-ts7-'));
  t.after(() => fs.rmSync(native, { recursive: true, force: true }));
  fs.writeFileSync(path.join(native, 'package.json'), '{"name":"typescript","version":"7.0.2"}');
  assert.throws(() => loadCompiler(os.tmpdir(), native), /TypeScript 7\.0\.2 is unsupported.*native compiler.*5\.x or 6\.x/);
  const broken = fakeCompiler(t, '');
  fs.writeFileSync(path.join(broken, 'lib/typescript.js'), 'throw new Error("cannot start");');
  assert.throws(() => loadCompiler(os.tmpdir(), broken), /Could not load the TypeScript compiler.*cannot start/);
});

