// Tests for the native TypeScript 7 compiler.
// test/fixtures/ts7/trace.json and types_0.json are trimmed output of `tsc --generateTrace --checkers 1` from
// typescript@7.0.2 (linux-x64), captured on 2026-10-07 for the project that nativeProject() writes below.
// The checkVariableDeclaration event of d.ts comes from a second run of the same project, with its timestamps moved into the d.ts file check.
// The fixtures use {{base}} for the project directory. Set WHYTS_TS7 to a typescript@7 package directory
// to also run the real native compiler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { analyze, buildGraph, readProject, loadCompiler, fileCountWarning, explain,
  NATIVE_EXPERIMENTAL_WARNING, NATIVE_ONE_CHECKER_WARNING, NATIVE_HEAP_WARNING } from '../src/analyze.js';
import { traceDetails, resolveTraceTypes } from '../src/trace.js';
import { renderReport } from '../src/report.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, 'test/fixtures/ts7');
const realTs7 = process.env.WHYTS_TS7;

const core = [
  '// A small, valid client assignment with 676 structurally compared properties.',
  '// Timings and sampled trace events vary across machines and compiler versions.',
  "type Letter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j'",
  "  | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u'",
  "  | 'v' | 'w' | 'x' | 'y' | 'z';",
  'type Route = `${Letter}${Letter}`;',
  '',
  'type FullClient = {',
  '  [K in Route]: { route: K; response: { id: K; metadata: K } };',
  '};',
  'type PublicClient = {',
  '  [K in Route]: { route: K; response: { id: K } };',
  '};',
  '',
  'declare const fullClient: FullClient;',
  'export const publicClient: PublicClient = fullClient;',
  ''].join('\n');
const multibyte = '// Türkçe 日本語 \u{1F600}\n';
const sameLine = 'export const label = "Türkçe 日本語 \u{1F600}"; type FullClient = {';

// Six files: plain ASCII, multibyte text, BOM, CRLF, an upper case directory, and multibyte text before a type on the same line.
const projectFiles = {
  'a.ts': '// plain\n' + core,
  'b.ts': multibyte + core,
  'c.ts': '﻿' + multibyte + core,
  'd.ts': (multibyte + core).replaceAll('\n', '\r\n'),
  'Src/Upper.ts': core,
  'e.ts': core.replace('type FullClient = {', sameLine)
};
const tsconfig = { compilerOptions: { strict: true, target: 'ES2022', skipLibCheck: true, lib: ['ES2022'], noEmit: true }, files: Object.keys(projectFiles) };

function nativeProject(t, config = tsconfig, files = projectFiles) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-native-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const diagnostics = files => `Files:              ${files}\nLines:           10631\nTypes:            3554\nInstantiations:   5408\nMemory used:     8895K\n` +
  'Config time:    0.010s\nParse time:     0.032s\nBind time:      0.006s\nCheck time:     0.100s\nEmit time:      0.000s\nTotal time:     0.150s\n';

// A fake typescript@7 package. Its bin/tsc replays the fixtures instead of compiling and records how it was started.
function fakeNative(t, { base, files = 63, enumKind = 79, version = '7.0.2', bin = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-fake-ts7-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version,
    exports: { './package.json': './package.json', '.': './lib/version.cjs' } }));
  fs.writeFileSync(path.join(dir, 'lib/version.cjs'), `exports.version = ${JSON.stringify(version)};`);
  if (enumKind !== null) {
    fs.mkdirSync(path.join(dir, 'dist/enums'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist/enums/syntaxKind.enum.js'), `SyntaxKind[SyntaxKind["Identifier"] = ${enumKind}] = "Identifier";`);
  }
  if (bin) {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin/tsc'), `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, 'started.json'), JSON.stringify({ args, execArgv: process.execArgv }));
const trace = args[args.indexOf('--generateTrace') + 1];
const read = name => fs.readFileSync(path.join(${JSON.stringify(fixtures)}, name), 'utf8');
const base = ${JSON.stringify((base ?? '').split(path.sep).join('/'))};
fs.writeFileSync(path.join(trace, 'trace.json'), read('trace.json').replaceAll('{{base}}', base));
fs.writeFileSync(path.join(trace, 'types_0.json'), read('types_0.json').replaceAll('{{base}}', base.toLowerCase()));
process.stdout.write(${JSON.stringify(diagnostics(files))});
`);
  }
  return dir;
}
const started = dir => JSON.parse(fs.readFileSync(path.join(dir, 'bin/started.json'), 'utf8'));
const graphFiles = dir => buildGraph(ts, readProject(dir, ts)).files.size;

test('native package detection: --typescript directory, project resolution, version and package name', t => {
  const dir = fakeNative(t);
  const compiler = loadCompiler(os.tmpdir(), dir);
  assert.equal(compiler.native.version, '7.0.2');
  assert.equal(compiler.tscPath, path.join(dir, 'bin/tsc'));
  assert.equal(compiler.ts.version, ts.version, 'the import graph uses the JavaScript API of whyts');
  // A project that resolves "typescript" to the 7.x package selects the native compiler without --typescript.
  const project = nativeProject(t, tsconfig, projectFiles);
  fs.mkdirSync(path.join(project, 'node_modules'));
  fs.cpSync(dir, path.join(project, 'node_modules/typescript'), { recursive: true });
  const resolved = loadCompiler(project);
  assert.equal(resolved.native.version, '7.0.2');
  assert.equal(resolved.tscPath, path.join(project, 'node_modules/typescript/bin/tsc'));
  // A 6.x package or a package with another name is not a native compiler.
  const other = fakeNative(t, { version: '6.0.3' });
  assert.throws(() => loadCompiler(os.tmpdir(), other), /--typescript must be a typescript package directory/);
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'not-typescript', version: '7.0.2' }));
  assert.throws(() => loadCompiler(os.tmpdir(), other), /--typescript must be a typescript package directory/);
  // A package without bin/tsc is an incomplete install.
  assert.throws(() => loadCompiler(os.tmpdir(), fakeNative(t, { bin: false })), /has no bin\/tsc/);
});

test('the syntax kind of Identifier is read from the native package, with 79 as the measured fallback', t => {
  assert.equal(loadCompiler(os.tmpdir(), fakeNative(t, { enumKind: 123 })).native.identifierKind, 123);
  assert.equal(loadCompiler(os.tmpdir(), fakeNative(t, { enumKind: null })).native.identifierKind, 79);
});

test('native Identifier kind: the chain focus skips Identifier of the native numbering, not of the bundled compiler', t => {
  const base = nativeProject(t);
  const graph = buildGraph(ts, readProject(base, ts));
  const file = path.join(base, 'a.ts');
  const span = (name, pos, end, kind, start, dur) => ({ ph: 'X', pid: 1, tid: 2, name, ts: start, dur, args: { path: file, pos, end, kind } });
  const events = [span('checkVariableDeclaration', 10, 200, 261, 0, 20000), span('checkExpression', 20, 150, 80, 100, 19000),
    span('checkExpression', 30, 100, 79, 200, 18000)];
  const focus = g => traceDetails(events, [], base, g).sourceGroups[0];
  const native = Object.assign(Object.create(graph), { native: { identifierKind: 79 } });
  assert.equal(ts.SyntaxKind.Identifier, 80, 'the bundled compiler numbers Identifier 80');
  // Native: kind 79 is Identifier, so the focus is the kind 80 member. Bundled numbering: the focus is the kind 79 member.
  assert.equal(focus(native).pos, 20);
  assert.equal(focus(graph).pos, 30);
});

test('native replay: BOM, CRLF and multibyte positions, lowercased declaration paths, experimental marks', async t => {
  const base = nativeProject(t);
  const native = fakeNative(t, { base, files: graphFiles(base) });
  const report = await analyze({ project: base, typescript: native });
  assert.equal(report.typescriptVersion, '7.0.2');
  assert.equal(report.compiler, 'native');
  assert.equal(report.experimental, true);
  assert.equal(report.checkers, 1);
  assert.equal(report.graphTypescriptVersion, ts.version);
  assert.ok(report.warnings.includes(NATIVE_EXPERIMENTAL_WARNING));
  assert.ok(report.warnings.includes(NATIVE_ONE_CHECKER_WARNING));
  assert.match(NATIVE_ONE_CHECKER_WARNING, /Check time was measured with one checker \(`--checkers 1`\); do not compare it with a default parallel `tsc` run\./);
  const run = started(native);
  assert.equal(run.args[run.args.indexOf('--checkers') + 1], '1');
  // The multibyte, BOM and CRLF files report the same line and column as the plain layout. The fixture has no events for a.ts:
  // the report shows at most five chains.
  const where = Object.fromEntries(report.sourceGroups.map(g => [g.file, `${g.line}:${g.character}`]));
  assert.deepEqual(where, { 'b.ts': '17:14', 'c.ts': '17:14', 'd.ts': '17:14', 'Src/Upper.ts': '16:14', 'e.ts': '16:14' });
  for (const group of report.sourceGroups) assert.equal(group.snippet, 'publicClient: PublicClient = fullClient');
  // types_0.json paths are lower case, even for the directory "Src". Columns there are UTF-16 and need no conversion.
  const declarations = report.sourceGroups.flatMap(g => g.comparisons).map(c => c.source.declaration)
    .map(d => `${d.file}:${d.line}:${d.character}:${d.scope}`).sort();
  assert.deepEqual(declarations, ['Src/Upper.ts:8:1:project', 'b.ts:9:1:project', 'c.ts:9:1:project', 'e.ts:8:39:project']);
  const text = renderReport(report);
  assert.match(text, /TypeScript 7\.0\.2 \(native, EXPERIMENTAL\)/);
  assert.match(text, /Note: Check time was measured with one checker/);
  assert.doesNotMatch(text, /null|undefined|NaN/);
  assert.doesNotMatch(text, /Trace type dump/);
  assert.equal(report.summary.dumpTypesSeconds, null);
  assert.equal(report.warnings.some(w => /import graph has/.test(w)), false);
});

test('declarations in the lib files bundled with the native package are dependencies, not unknown', t => {
  const base = nativeProject(t);
  const graph = Object.assign(Object.create(buildGraph(ts, readProject(base, ts))), { native: { identifierKind: 79 } });
  const lib = path.join(base, 'node_modules/@typescript/typescript-linux-x64/lib/lib.es5.d.ts').toLowerCase();
  const details = { typeHotspots: [{ milliseconds: 1, source: { id: 1 }, target: { id: 1 } }], sourceHotspots: [], sourceGroups: [] };
  const descriptor = { id: 1, symbolName: 'Array', flags: ['Object'], firstDeclaration: { path: lib, start: { line: 10, character: 1 } } };
  assert.equal(resolveTraceTypes(details, [descriptor], base, graph).typeHotspots[0].source.declaration.scope, 'dependency');
});

test('--max-old-space-size is ignored with a warning for the native compiler', async t => {
  const base = nativeProject(t);
  const native = fakeNative(t, { base, files: graphFiles(base) });
  const report = await analyze({ project: base, typescript: native, maxOldSpaceMb: 4096 });
  assert.ok(report.warnings.includes(NATIVE_HEAP_WARNING));
  assert.equal(started(native).execArgv.some(a => a.includes('max-old-space-size')), false);
  const quiet = await analyze({ project: base, typescript: native });
  assert.equal(quiet.warnings.includes(NATIVE_HEAP_WARNING), false);
});

test('a large gap between the graph file count and the native Files count warns', async t => {
  const base = nativeProject(t);
  const graph = graphFiles(base);
  const matching = await analyze({ project: base, typescript: fakeNative(t, { base, files: graph + 3 }) });
  assert.equal(matching.warnings.some(w => /import graph has/.test(w)), false);
  const gap = await analyze({ project: base, typescript: fakeNative(t, { base, files: graph + 400 }) });
  const warning = gap.warnings.find(w => /import graph has/.test(w));
  assert.match(warning, new RegExp(`import graph has ${graph} files, and the native compiler reports ${graph + 400} files`));
  assert.match(warning, /Module resolution may differ/);
  // Unit boundaries: an absolute allowance for small projects, a relative one for large projects.
  assert.equal(fileCountWarning(100, 125), null);
  assert.ok(fileCountWarning(100, 126));
  assert.equal(fileCountWarning(5000, 5400), null);
  assert.ok(fileCountWarning(5000, 5600));
  assert.equal(fileCountWarning(100, undefined), null);
});

test('a tsconfig that the bundled compiler cannot read gives a clear error with a native compiler', async t => {
  const config = { compilerOptions: { module: 'a-setting-only-typescript-7-knows' }, files: ['a.ts'] };
  const base = nativeProject(t, config, { 'a.ts': 'export {};\n' });
  const native = fakeNative(t, { base });
  await assert.rejects(analyze({ project: base, typescript: native }), /own TypeScript .*cannot read it.*only TypeScript 7/s);
  assert.throws(() => explain({ project: base, file: 'a.ts', typescript: native }), /cannot read it.*only TypeScript 7/s);
  // With a JavaScript compiler the plain compiler message stays unchanged.
  await assert.rejects(analyze({ project: base }), error => /a-setting-only-typescript-7-knows|module/i.test(error.message) && !/only TypeScript 7/.test(error.message));
});

test('the CLI accepts a TypeScript 7 package directory and marks the JSON as experimental', t => {
  const base = nativeProject(t);
  const native = fakeNative(t, { base, files: graphFiles(base) });
  const run = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '--project', base, '--typescript', native, '--json',
    '--max-old-space-size', '1024'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.experimental, true);
  assert.ok(report.warnings.includes(NATIVE_HEAP_WARNING));
  assert.match(spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '--help'], { encoding: 'utf8' }).stdout, /7\.x/);
});

test('real typescript@7: traced check with one checker maps positions to the right lines', { skip: !realTs7 && 'set WHYTS_TS7 to a typescript@7 package directory' }, async t => {
  const base = nativeProject(t);
  const report = await analyze({ project: base, typescript: realTs7 });
  assert.equal(report.compiler, 'native');
  assert.match(report.typescriptVersion, /^7\./);
  assert.equal(report.summary.compilerExitCode, 0);
  const where = Object.fromEntries(report.sourceHotspots.map(h => [h.file, `${h.line}:${h.character}`]));
  // The native compiler may drop a very short check. Every file that is reported must be at the right position.
  assert.ok(Object.keys(where).length >= 3, JSON.stringify(where));
  const expected = { 'a.ts': '17:14', 'b.ts': '17:14', 'c.ts': '17:14', 'd.ts': '17:14', 'Src/Upper.ts': '16:14', 'e.ts': '16:14' };
  for (const [file, position] of Object.entries(where)) assert.equal(position, expected[file], file);
  assert.ok(report.warnings.includes(NATIVE_ONE_CHECKER_WARNING));
  assert.equal(report.warnings.some(w => /import graph has/.test(w)), false, 'file counts should agree for this project');
});
