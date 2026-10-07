// Tests for repeated timing runs (--runs) and whyts compare.
// The compiler is a fake tsc that prints scripted Check time values and logs how it was started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { analyze } from '../src/analyze.js';
import { compareProjects, compareReports, checkCompatibility, diffFindings } from '../src/compare.js';
import { renderComparison, renderReport } from '../src/report.js';
import { median, summarize, runSchedule, judge, separationChance, diffEntries } from '../src/timing.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'src/cli.js');
const realCompiler = createRequire(import.meta.url).resolve('typescript');
const options = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };

function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A project whose fake compiler run number n prints the n-th value of `times` (Check time in seconds).
function project(t, times, files = 3) {
  const dir = temp(t, 'whyts-cmp-');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: options, files: ['main.ts'] }));
  fs.writeFileSync(path.join(dir, 'main.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify({ times, files }));
  return dir;
}
// A typescript package that exposes the real compiler API and runs a scripted tsc.js.
function fakeCompiler(t) {
  const dir = temp(t, 'whyts-cmp-ts-');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/typescript.js'), `module.exports = require(${JSON.stringify(realCompiler)});`);
  fs.writeFileSync(path.join(dir, 'lib/tsc.js'), `const fs = require('fs'), path = require('path');
const cwd = process.cwd();
const { times, files } = JSON.parse(fs.readFileSync(path.join(cwd, 'times.json'), 'utf8'));
const counter = path.join(cwd, 'count.txt');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
fs.appendFileSync(process.env.WHYTS_FAKE_LOG, JSON.stringify({ project: path.basename(cwd), args: process.argv.slice(2) }) + '\\n');
const check = times[n % times.length];
const exit = process.env['WHYTS_FAKE_EXIT_' + path.basename(cwd).replace(/\\W/g, '_')];
process.stdout.write('Files: ' + files + '\\nCheck time: ' + check.toFixed(2) + 's\\nTotal time: ' + (check + 0.5).toFixed(2) + 's\\n');
if (exit) process.exitCode = Number(exit);
`);
  return dir;
}
function log(t) {
  const file = path.join(temp(t, 'whyts-cmp-log-'), 'log.jsonl');
  fs.writeFileSync(file, '');
  process.env.WHYTS_FAKE_LOG = file;
  t.after(() => { delete process.env.WHYTS_FAKE_LOG; });
  return () => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('median and summary statistics', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(summarize([1.0, 1.1, 1.2, 1.3, 1.4]), { runs: 5, values: [1, 1.1, 1.2, 1.3, 1.4], median: 1.2, min: 1, max: 1.4, spreadPercent: 33.3 });
  assert.equal(summarize([2, 2, 2]).spreadPercent, 0);
  assert.equal(summarize([]), null);
  assert.equal(summarize([1, NaN]), null);
  // The caller's array is not reordered or shared.
  const values = [3, 1, 2];
  summarize(values).values.sort();
  assert.deepEqual(values, [3, 1, 2]);
});

test('run schedule: two warm-up runs first, then pairs whose order flips', () => {
  const text = steps => steps.map(s => (s.side === 'baseline' ? 'A' : 'B') + (s.warmup ? 'w' : '')).join(' ');
  assert.equal(text(runSchedule(4)), 'Aw Bw A B B A A B B A');
  assert.equal(text(runSchedule(3)), 'Aw Bw A B B A A B');
  assert.equal(text(runSchedule(1)), 'Aw Bw A B');
  for (const runs of [2, 4, 6, 10]) {
    const measured = runSchedule(runs).filter(s => !s.warmup);
    assert.equal(measured.filter(s => s.side === 'baseline').length, runs);
    assert.equal(measured.filter(s => s.side === 'candidate').length, runs);
    // With an even count, each side runs first in half of the pairs.
    const firsts = measured.filter((_, i) => i % 2 === 0).filter(s => s.side === 'baseline').length;
    assert.equal(firsts, runs / 2);
  }
});

test('noise rule: overlapping ranges are noise, separate ranges are a difference', () => {
  const side = values => summarize(values);
  assert.equal(judge(side([1, 1.1, 1.2]), side([1.15, 1.3, 1.4])).verdict, 'within-noise');
  // Ranges that only touch overlap.
  assert.equal(judge(side([1, 1.1, 1.2]), side([1.2, 1.3, 1.4])).verdict, 'within-noise');
  const slower = judge(side([1, 1.1, 1.2]), side([1.3, 1.4, 1.5]));
  assert.deepEqual([slower.verdict, slower.direction, slower.deltaMilliseconds, slower.deltaPercent], ['separated', 'slower', 300, 27.3]);
  const faster = judge(side([1.3, 1.4, 1.5]), side([1, 1.1, 1.2]));
  assert.deepEqual([faster.verdict, faster.direction, faster.deltaMilliseconds], ['separated', 'faster', -300]);
  // Fewer than three runs per side gives no verdict, even for far apart values.
  assert.equal(judge(side([1, 1.1]), side([5, 5.1])).verdict, 'insufficient-runs');
  assert.equal(judge(side([1, 1.1, 1.2]), side([5])).verdict, 'insufficient-runs');
  assert.equal(judge(null, side([1, 2, 3])).verdict, 'unavailable');
  // The chance of a split by luck: 2 / C(2n, n).
  assert.equal(separationChance(3, 3), 0.1);
  assert.equal(Math.round(separationChance(5, 5) * 10000) / 10000, 0.0079);
  assert.equal(judge(summarize([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9]), summarize([3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9])).rule.chanceWithoutDifference, 0.000011);
  assert.equal(judge(side([1, 1.1, 1.2]), side([1.3, 1.4, 1.5])).rule.chanceWithoutDifference, 0.1);
});

test('entries: new, gone, grown, shrunk and unchanged use a size and a percent threshold', () => {
  const e = (key, milliseconds) => ({ key, milliseconds });
  const diff = diffEntries([e('a', 100), e('b', 100), e('c', 100), e('d', 100), e('e', 5), e('g', 200)], [e('a', 150), e('b', 60), e('c', 105), e('f', 40), e('e', 9), e('g', 215)]);
  assert.deepEqual(Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.map(x => x.key)])),
    { new: ['f'], gone: ['d'], grown: ['a'], shrunk: ['b'], unchanged: ['c', 'e', 'g'] });
  assert.equal(diff.grown[0].deltaMilliseconds, 50);
  assert.equal(diff.grown[0].deltaPercent, 50);
  // 4 ms of 5 ms is 80 percent, but 4 ms is below the 10 ms threshold. 15 ms of 200 ms passes 10 ms but is only 7.5 percent.
  assert.equal(diff.unchanged.find(x => x.key === 'e').deltaPercent, 80);
});

test('live comparison runs in balanced order and leaves the warm-up runs out of the numbers', async t => {
  const calls = log(t);
  const tsc = fakeCompiler(t);
  // The first run of each side is a warm-up with a very different value.
  const baseline = project(t, [9, 1.0, 1.1, 1.2, 1.3, 1.4]), candidate = project(t, [7, 2.0, 2.1, 2.2, 2.3, 2.4]);
  const progress = [];
  const result = await compareProjects({ baseline, candidate, runs: 5, typescript: tsc, onRun: p => progress.push(p) });
  assert.equal(calls().map(c => c.project === path.basename(baseline) ? 'A' : 'B').join(''), 'ABABBAABBAAB');
  assert.equal(result.order, 'ABBAABBAAB');
  assert.equal(progress.length, 12);
  assert.deepEqual(progress.slice(0, 2).map(p => [p.side, p.warmup]), [['baseline', true], ['candidate', true]]);
  assert.deepEqual(result.checkTime.baseline.values, [1, 1.1, 1.2, 1.3, 1.4]);
  assert.deepEqual(result.checkTime.candidate.values, [2, 2.1, 2.2, 2.3, 2.4]);
  assert.deepEqual(result.warmup, { baseline: { checkTime: 9, totalTime: 9.5, compilerExitCode: 0 }, candidate: { checkTime: 7, totalTime: 7.5, compilerExitCode: 0 } });
  assert.equal(result.checkTime.verdict, 'separated');
  assert.equal(result.checkTime.direction, 'slower');
  assert.equal(result.checkTime.deltaMilliseconds, 1000);
  assert.equal(result.totalTime.verdict, 'separated');
  assert.equal(result.baseline.programFiles, 3);
  // Every run uses the same flags, no trace, and its own new cache file.
  const runs = calls();
  assert.equal(runs.length, 12);
  assert.ok(runs.every(r => !r.args.includes('--generateTrace')));
  assert.equal(new Set(runs.map(r => r.args[r.args.indexOf('--tsBuildInfoFile') + 1])).size, 12);
  assert.ok(runs.every(r => r.args.includes('--incremental') && r.args.includes('--noEmit')));
  assert.deepEqual(result.baseline.flags, result.candidate.flags);
  assert.match(renderComparison(result), /RANGES DO NOT OVERLAP: the candidate is slower/);
  assert.match(renderComparison(result), /do not overlap if both sides were the same: 0\.79% \(assumes/);
});

test('live comparison of a project with itself stays within noise when the values overlap', async t => {
  log(t);
  const tsc = fakeCompiler(t);
  const a = project(t, [5, 1.0, 1.1, 1.0, 1.1, 1.0]), b = project(t, [5, 1.1, 1.0, 1.1, 1.0, 1.1]);
  const result = await compareProjects({ baseline: a, candidate: b, runs: 5, typescript: tsc });
  assert.equal(result.checkTime.verdict, 'within-noise');
  assert.equal(result.checkTime.direction, null);
  assert.match(renderComparison(result), /WITHIN NOISE/);
});

test('live comparison warns about file counts, compiler errors and different compiler options', async t => {
  const calls = log(t);
  const tsc = fakeCompiler(t);
  const a = project(t, [1, 1, 1, 1], 10), b = project(t, [1, 1, 1, 1], 12);
  fs.writeFileSync(path.join(b, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...options, strict: false }, files: ['main.ts'] }));
  process.env[`WHYTS_FAKE_EXIT_${path.basename(b).replace(/\W/g, '_')}`] = '2';
  t.after(() => { delete process.env[`WHYTS_FAKE_EXIT_${path.basename(b).replace(/\W/g, '_')}`]; });
  const result = await compareProjects({ baseline: a, candidate: b, runs: 2, typescript: tsc });
  assert.ok(calls().length > 0);
  const warnings = result.warnings.join('\n');
  assert.match(warnings, /different file counts \(10 and 12\)/);
  assert.match(warnings, /COMPILER ERRORS: 2 of 2 compiler runs of the candidate/);
  assert.match(warnings, /different compiler options \(strict\)/);
  assert.deepEqual(result.candidate.compilerExitCodes, [2, 2]);
  assert.equal(result.checkTime.verdict, 'insufficient-runs');
  assert.match(renderComparison(result), /WARNING: COMPILER ERRORS/);
});

test('a live comparison between a native and a JavaScript compiler is rejected before any run', async t => {
  const calls = log(t);
  const native = temp(t, 'whyts-cmp-native-');
  fs.mkdirSync(path.join(native, 'lib')); fs.mkdirSync(path.join(native, 'bin'));
  fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', exports: { '.': './lib/version.cjs' } }));
  fs.writeFileSync(path.join(native, 'lib/version.cjs'), 'exports.version = "7.0.2";');
  fs.writeFileSync(path.join(native, 'bin/tsc'), 'process.stdout.write("Files: 1\\nCheck time: 1.00s\\nTotal time: 1.50s\\n");');
  const js = fakeCompiler(t);
  const a = project(t, [1]), b = project(t, [1]);
  // Both sides use --typescript, so a mixed pair needs two different packages: use a project-local compiler for one side.
  fs.mkdirSync(path.join(b, 'node_modules'));
  fs.cpSync(native, path.join(b, 'node_modules/typescript'), { recursive: true });
  fs.mkdirSync(path.join(a, 'node_modules'));
  fs.cpSync(js, path.join(a, 'node_modules/typescript'), { recursive: true });
  fs.writeFileSync(path.join(a, 'node_modules/typescript/package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3', main: './lib/typescript.js' }));
  await assert.rejects(compareProjects({ baseline: a, candidate: b, runs: 3 }), /cannot be compared[\s\S]*javascript compiler[\s\S]*native compiler/);
  assert.equal(calls().length, 0);
});

test('compatibility: errors for compiler kind, checkers, timing mode and flags; warnings for versions, files, exit codes', () => {
  const side = extra => ({ typescriptVersion: '5.9.3', compiler: 'javascript', checkers: null, flags: ['--noEmit'], timingMode: 'm', programFiles: 10, exitCodes: [0], ...extra });
  assert.deepEqual(checkCompatibility(side(), side()), { errors: [], warnings: [] });
  assert.match(checkCompatibility(side(), side({ compiler: 'native', typescriptVersion: '7.0.2' })).errors[0], /javascript compiler and the other uses the native/);
  assert.match(checkCompatibility(side({ checkers: 1 }), side({ checkers: null })).errors[0], /checker count differs \(1 and default\)/);
  assert.match(checkCompatibility(side({ timingMode: 'traced single run' }), side()).errors[0], /timing modes differ/);
  assert.match(checkCompatibility(side(), side({ flags: ['--noEmit', '--max-old-space-size=8192'] })).errors[0], /flags .* differ/);
  const warned = checkCompatibility(side(), side({ typescriptVersion: '6.0.3', programFiles: 11, exitCodes: [0, 2], toolVersion: '0.6.0' })).warnings.join('\n');
  assert.match(warned, /TypeScript versions differ \(5.9.3 and 6.0.3\)/);
  assert.match(warned, /different file counts \(10 and 11\)/);
  assert.match(warned, /COMPILER ERRORS: 1 of 2 compiler runs of the candidate/);
  // Reports from one whyts version do not warn about the version.
  assert.equal(checkCompatibility(side({ toolVersion: '0.6.0' }), side({ toolVersion: '0.6.0' })).warnings.length, 0);
});

// ---- Offline: whyts JSON reports ----

function report(extra = {}) {
  const chain = (file, line, character, milliseconds) => ({ rule: 'source-check-chain', confidence: 'measured', evidence: { file, line, character, milliseconds } });
  return { schemaVersion: 1, toolVersion: '0.6.0', typescriptVersion: '5.9.3', project: 'tsconfig.json',
    summary: { programFiles: 100, compilerExitCode: 0 }, diagnostics: { 'Check time': { value: 2, unit: 's' }, 'Total time': { value: 3, unit: 's' } },
    timings: { mode: 'untraced, fresh incremental cache for each run, no emit', runs: 3, checkers: null, flags: ['--noEmit'], compilerFiles: 100, compilerExitCodes: [0, 0, 0],
      checkTime: { unit: 's', ...summarize([1, 1.1, 1.2]) }, totalTime: { unit: 's', ...summarize([2, 2.1, 2.2]) } },
    findings: [chain('a.ts', 3, 5, 100), chain('b.ts', 1, 1, 80), chain('c.ts', 7, 2, 50), chain('d.ts', 1, 1, 40), { rule: 'check-hotspot', evidence: { file: 'e.ts', milliseconds: 200 } }],
    sourceGroups: [{ file: 'a.ts', line: 3, character: 5, milliseconds: 100 }, { file: 'b.ts', line: 1, character: 1, milliseconds: 80 },
      { file: 'c.ts', line: 7, character: 2, milliseconds: 50 }, { file: 'd.ts', line: 1, character: 1, milliseconds: 40 }],
    hotspots: [{ file: 'e.ts', milliseconds: 200 }], projectHotspots: [], ...extra };
}

test('offline comparison matches chains by file and position', () => {
  const baseline = report();
  const candidate = report({
    findings: [{ rule: 'source-check-chain', evidence: { file: 'a.ts', line: 3, character: 5 } },
      { rule: 'source-check-chain', evidence: { file: 'b.ts', line: 2, character: 1 } },
      { rule: 'source-check-chain', evidence: { file: 'c.ts', line: 7, character: 2 } },
      { rule: 'check-hotspot', evidence: { file: 'e.ts' } }, { rule: 'source-check-chain', evidence: { file: 'f.ts', line: 9, character: 9 } }],
    sourceGroups: [{ file: 'a.ts', line: 3, character: 5, milliseconds: 160 }, { file: 'b.ts', line: 2, character: 1, milliseconds: 80 },
      { file: 'c.ts', line: 7, character: 2, milliseconds: 20 }, { file: 'f.ts', line: 9, character: 9, milliseconds: 70 }],
    hotspots: [{ file: 'e.ts', milliseconds: 203 }]
  });
  const diff = diffFindings(baseline, candidate);
  const keys = list => list.map(e => `${e.file}${e.line ? `:${e.line}:${e.character}` : ''}`).sort();
  assert.deepEqual(keys(diff.grown), ['a.ts:3:5']);
  assert.deepEqual(keys(diff.shrunk), ['c.ts:7:2']);
  assert.deepEqual(keys(diff.unchanged), ['e.ts']);
  // The same file at another line is a different chain: b.ts:1:1 is gone and b.ts:2:1 is new.
  assert.deepEqual(keys(diff.gone), ['b.ts:1:1', 'd.ts:1:1']);
  assert.deepEqual(keys(diff.new), ['b.ts:2:1', 'f.ts:9:9']);
  const result = compareReports(baseline, candidate);
  assert.deepEqual(result.findings.counts, { new: 2, gone: 2, grown: 1, shrunk: 1, unchanged: 1 });
  assert.equal(result.mode, 'offline');
  assert.equal(result.checkTime.verdict, 'within-noise');
  assert.match(renderComparison(result), /new 2, gone 2, grown 1, shrunk 1, unchanged 1/);
});

test('a chain below the finding threshold on the other side is a change, not a gone entry', () => {
  const baseline = report();
  const candidate = report({ findings: [], sourceGroups: baseline.sourceGroups.map(g => g.file === 'a.ts' ? { ...g, milliseconds: 6 } : g), hotspots: [] });
  const diff = diffFindings(baseline, candidate);
  assert.deepEqual(diff.shrunk.map(e => [e.file, e.baselineMilliseconds, e.candidateMilliseconds]), [['a.ts', 100, 6]]);
});

test('offline comparison gives the timing verdict and rejects reports that cannot be compared', () => {
  const slow = report({ timings: { ...report().timings, checkTime: { unit: 's', ...summarize([2, 2.1, 2.2]) }, totalTime: { unit: 's', ...summarize([3, 3.1, 3.2]) } } });
  const result = compareReports(report(), slow);
  assert.equal(result.checkTime.verdict, 'separated');
  assert.equal(result.checkTime.direction, 'slower');
  assert.equal(result.checkTime.deltaMilliseconds, 1000);
  assert.deepEqual(result.baseline.compilerExitCodes, [0, 0, 0]);
  // Rejections.
  assert.throws(() => compareReports(report(), { nope: true }), /candidate file is not a whyts report/);
  assert.throws(() => compareReports(report({ schemaVersion: 2 }), report()), /schema version 2/);
  assert.throws(() => compareReports(report(), report({ compiler: 'native', checkers: 1, typescriptVersion: '7.0.2' })), /native compiler/);
  assert.throws(() => compareReports(report(), report({ timings: { ...report().timings, flags: ['--noEmit', '--max-old-space-size=8192'] } })), /flags of the timing runs differ/);
  assert.throws(() => compareReports(report(), report({ timings: undefined })), /timing modes differ/);
  // Warnings.
  const warned = compareReports(report(), report({ typescriptVersion: '6.0.3', summary: { programFiles: 100, compilerExitCode: 0 },
    timings: { ...report().timings, compilerFiles: 105, compilerExitCodes: [0, 2, 0] } }));
  assert.match(warned.warnings.join('\n'), /TypeScript versions differ/);
  assert.match(warned.warnings.join('\n'), /different file counts \(100 and 105\)/);
  assert.match(warned.warnings.join('\n'), /COMPILER ERRORS: 1 of 3/);
  // Two reports without timings use the single traced Check time and give no verdict.
  const single = compareReports(report({ timings: undefined }), report({ timings: undefined }));
  assert.equal(single.checkTime.verdict, 'insufficient-runs');
  assert.match(single.warnings.join('\n'), /no `timings` field/);
});

test('compare CLI: JSON output, text output, exit codes and argument errors', t => {
  const dir = temp(t, 'whyts-cmp-cli-');
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const a = write('a.json', report()), b = write('b.json', report());
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const json = run(['compare', a, b, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.kind, 'comparison');
  assert.equal(result.checkTime.verdict, 'within-noise');
  const text = run(['compare', a, b, '--no-color']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /whyts compare \(offline\)[\s\S]*Check time[\s\S]*WITHIN NOISE/);
  // A side with compiler errors still completes with exit 0 and a visible warning.
  const failed = run(['compare', a, write('f.json', report({ timings: { ...report().timings, compilerExitCodes: [2, 2, 2] } })), '--no-color']);
  assert.equal(failed.status, 0);
  assert.match(failed.stdout, /WARNING: COMPILER ERRORS/);
  assert.equal(run(['compare', a, write('n.json', report({ compiler: 'native', checkers: 1 }))]).status, 1);
  assert.match(run(['compare', a, write('bad.json', '{ nope')]).stderr, /not valid JSON/);
  assert.match(run(['compare', a, path.join(dir, 'missing.json')]).stderr, /Cannot read the candidate report/);
  assert.match(run(['compare', a]).stderr, /needs two report files/);
  assert.match(run(['compare', a, b, '--baseline', a, '--candidate', b]).stderr, /either two report files or/);
  assert.match(run(['compare', '--baseline', a]).stderr, /needs both --baseline and --candidate/);
  assert.match(run(['compare', a, b, '--runs', '3']).stderr, /--runs applies to a live comparison/);
  assert.match(run(['--baseline', a]).stderr, /belong to the compare command/);
  for (const bad of ['0', '101', 'x', '1.5']) assert.match(run(['--runs', bad]).stderr, /--runs must be a whole number between 1 and 100/);
  assert.match(run(['explain', 'x.ts', '--runs', '3']).stderr, /does not apply to explain/);
});

// ---- --runs ----

test('--runs adds untraced timing runs after the traced run and records them under timings', async t => {
  const calls = log(t);
  const tsc = fakeCompiler(t);
  const dir = project(t, [4, 1.0, 1.2, 1.1]);
  const progress = [];
  const result = await analyze({ project: dir, typescript: tsc, runs: 3, onRun: p => progress.push(p) });
  const all = calls();
  // One traced run, then three untraced runs.
  assert.equal(all.length, 4);
  assert.ok(all[0].args.includes('--generateTrace'));
  assert.ok(all.slice(1).every(c => !c.args.includes('--generateTrace')));
  assert.equal(new Set(all.map(c => c.args[c.args.indexOf('--tsBuildInfoFile') + 1])).size, 4);
  assert.deepEqual(progress, [{ run: 1, runs: 3 }, { run: 2, runs: 3 }, { run: 3, runs: 3 }]);
  assert.equal(result.timings.runs, 3);
  assert.deepEqual(result.timings.checkTime.values, [1, 1.2, 1.1]);
  assert.equal(result.timings.checkTime.median, 1.1);
  assert.equal(result.timings.checkTime.spreadPercent, 18.2);
  assert.deepEqual(result.timings.totalTime.values, [1.5, 1.7, 1.6]);
  assert.deepEqual(result.timings.compilerExitCodes, [0, 0, 0]);
  assert.equal(result.timings.checkers, null);
  // The traced run keeps its own diagnostics.
  assert.equal(result.diagnostics['Check time'].value, 4);
  assert.match(renderReport(result), /Untraced timing, 3 runs[\s\S]*Check time: median 1.1s, min 1s, max 1.2s, spread 18.2%/);
});

test('without --runs, or with --runs 1, the report has no timings and the compiler runs once', async t => {
  const calls = log(t);
  const tsc = fakeCompiler(t);
  const dir = project(t, [1]);
  assert.equal('timings' in await analyze({ project: dir, typescript: tsc }), false);
  assert.equal('timings' in await analyze({ project: dir, typescript: tsc, runs: 1 }), false);
  assert.equal(calls().length, 2);
});

test('native timing runs use one checker, like the traced run', async t => {
  const calls = log(t);
  const native = temp(t, 'whyts-cmp-native-');
  fs.mkdirSync(path.join(native, 'lib')); fs.mkdirSync(path.join(native, 'bin'));
  fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', exports: { '.': './lib/version.cjs' } }));
  fs.writeFileSync(path.join(native, 'lib/version.cjs'), 'exports.version = "7.0.2";');
  fs.writeFileSync(path.join(native, 'bin/tsc'), `require('fs').appendFileSync(process.env.WHYTS_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
process.stdout.write('Files: 3\\nCheck time: 0.50s\\nTotal time: 0.60s\\n');`);
  const dir = project(t, [1]);
  const result = await analyze({ project: dir, typescript: native, runs: 2 });
  const all = calls();
  assert.equal(all.length, 3);
  assert.ok(all.every(c => c.args.includes('--checkers') && c.args[c.args.indexOf('--checkers') + 1] === '1'));
  assert.equal(result.timings.checkers, 1);
  assert.ok(result.timings.flags.includes('--checkers=1'));
  assert.ok(result.warnings.some(w => /Timing runs used one checker/.test(w)));
});
