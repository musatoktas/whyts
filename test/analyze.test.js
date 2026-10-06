import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { analyze, readProject, buildGraph, explainFile, inspectProject, parseDiagnostics, traceHotspots, reachable, readTrace, toolVersion, measuredFindings, CHAIN_COVERAGE_THRESHOLD } from '../src/analyze.js';
import { renderReport } from '../src/report.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'src/cli.js');
function fixture(t, config, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}
const options = { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' };

test('diagnostics retain units and ignore unrelated compiler messages', () => {
  assert.deepEqual(parseDiagnostics('Files: 83\nCheck time: 1.25s\nMemory used: 99123K\nsrc/a.ts(1,2): error TS1234: bad\n'), {
    Files: { value: 83, unit: 'count' }, 'Check time': { value: 1.25, unit: 's' }, 'Memory used': { value: 99123, unit: 'K' }
  });
});

test('trace parser merges overlapping intervals and supports nested begin/end', () => {
  const events = [
    { ph: 'B', pid: 1, tid: 1, name: 'checkSourceFile', ts: 0, args: { path: '/repo/a.ts' } },
    { ph: 'B', pid: 1, tid: 1, name: 'checkExpression', ts: 1000 },
    { ph: 'E', pid: 1, tid: 1, ts: 3000 },
    { ph: 'E', pid: 1, tid: 1, ts: 10000 },
    { ph: 'X', name: 'checkSourceFile', ts: 5000, dur: 10000, args: { path: '/repo/a.ts' } },
    { ph: 'X', name: 'checkSourceFile', ts: 20000, dur: 5000, args: { path: '/repo/a.ts' } }
  ];
  assert.deepEqual(traceHotspots(events, '/repo'), [{ file: 'a.ts', milliseconds: 20 }]);
});

test('import graph handles paths aliases, reexports, dynamic imports, and cycles', t => {
  const dir = fixture(t, { compilerOptions: { ...options, baseUrl: '.', paths: { '@shared/*': ['shared/*'] } }, files: ['src/main.ts'] }, {
    'src/main.ts': 'import { value } from "@shared/index"; void import("../lazy.js"); console.log(value);',
    'shared/index.ts': 'export { value } from "./value"; export * from "./a"; export * from "./b";',
    'shared/value.ts': 'import "./index"; export const value = 1;',
    'shared/a.ts': 'export const a = 1;', 'shared/b.ts': 'export const b = 1;',
    'lazy.ts': 'export const lazy = 1;'
  });
  const project = readProject(dir, ts);
  const graph = buildGraph(ts, project);
  const why = explainFile(graph, 'shared/value.ts', dir);
  assert.deepEqual(why.chain, ['src/main.ts', 'shared/index.ts', 'shared/value.ts']);
  assert.equal(why.configuredRoot, false);
  assert.ok(reachable(graph.edges, path.join(dir, 'src/main.ts')).has(path.join(dir, 'lazy.ts')));
  assert.equal(reachable(graph.edges, path.join(dir, 'shared/index.ts')).size, 3);
  assert.ok(inspectProject(graph, project).some(f => f.rule === 'barrel-reach'));
});

test('inherited JSONC configs preserve broad inclusion and root explanations', t => {
  const dir = fixture(t, { extends: './base.json' }, {
    'base.json': '{ // inherited configuration\n "compilerOptions": {"strict":true}, "include":["**/*"] }',
    'generated/unused.ts': 'export const unused = 1;'
  });
  const project = readProject(dir, ts), graph = buildGraph(ts, project);
  assert.ok(inspectProject(graph, project).some(f => f.rule === 'broad-include'));
  assert.ok(inspectProject(graph, project).some(f => f.rule === 'review-root-files'));
  assert.equal(explainFile(graph, 'generated/unused.ts', dir).configuredRoot, true);
});

test('only multiple versions actually loaded in the program count as duplicate types', t => {
  const dir = fixture(t, { compilerOptions: { ...options, types: ['fake'] }, files: ['main.ts'] }, {
    'main.ts': 'import "dep";',
    'node_modules/@types/fake/package.json': '{"name":"@types/fake","version":"1.0.0","types":"index.d.ts"}',
    'node_modules/@types/fake/index.d.ts': 'declare namespace Fake { type A = string; }',
    'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","types":"index.d.ts"}',
    'node_modules/dep/index.d.ts': 'import "fake"; export {};',
    'node_modules/dep/node_modules/@types/fake/package.json': '{"name":"@types/fake","version":"2.0.0","types":"index.d.ts"}',
    'node_modules/dep/node_modules/@types/fake/index.d.ts': 'export interface Other { x: string; }',
    'node_modules/unused/node_modules/@types/fake/package.json': '{"name":"@types/fake","version":"3.0.0"}'
  });
  const project = readProject(dir, ts);
  const duplicate = inspectProject(buildGraph(ts, project), project).find(f => f.rule === 'duplicate-types');
  assert.equal(duplicate.evidence.name, '@types/fake');
  assert.deepEqual(duplicate.evidence.copies.map(c => c.version).sort(), ['1.0.0', '2.0.0']);
});

test('solution configs are rejected with actionable instructions', t => {
  const dir = fixture(t, { files: [], references: [{ path: './sub' }] }, {});
  assert.throws(() => readProject(dir, ts), /referenced leaf project/);
});

test('real traced check produces measurements without changing project files or existing cache', async t => {
  const dir = fixture(t, { compilerOptions: { ...options, incremental: true, skipLibCheck: true, lib: ['ES2022'] }, include: ['**/*'] }, {
    'main.ts': 'export const hello: string = "world";',
    'generated/unused.ts': 'export const unused = 1;',
    'tsconfig.tsbuildinfo': 'existing cache must survive'
  });
  const before = fs.readdirSync(dir).sort();
  const report = await analyze({ project: dir });
  assert.equal(report.summary.compilerExitCode, 0);
  assert.ok(report.diagnostics['Total time'].value >= 0);
  assert.equal(report.summary.rootFiles, 2);
  assert.ok(report.hotspots.some(h => h.file === 'main.ts'));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.readFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), 'utf8'), 'existing cache must survive');
  assert.match(renderReport(report), /Fresh cache/);
});

test('compiler errors are reported as exit 2 in otherwise valid JSON output', t => {
  const dir = fixture(t, { compilerOptions: options, files: ['main.ts'] }, { 'main.ts': 'const value: number = "wrong";' });
  const run = spawnSync(process.execPath, [cli, '-p', dir, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.summary.errorCount, 1);
  assert.notEqual(report.summary.compilerExitCode, 0);
});

test('CLI supports spaces in paths, explain JSON, help, and actionable failures', t => {
  const dir = fixture(t, { compilerOptions: options, files: ['has spaces.ts'] }, { 'has spaces.ts': 'export const x = 1;' });
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run(['--help']).status, 0);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(run(['--version']).stdout.trim(), packageVersion);
  assert.equal(toolVersion, packageVersion);
  const result = run(['explain', 'has spaces.ts', '-p', dir, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configuredRoot, true);
  assert.equal(run(['--timeout', 'nan']).status, 1);
  assert.equal(run(['--wat']).status, 1);
  assert.match(run(['-p', path.join(dir, 'missing')]).stderr, /Project not found/);
  assert.match(run(['explain', 'missing.ts', '-p', dir]).stderr, /not in this TypeScript program/);
});

test('timeout terminates the compiler and surfaces a tool failure', async t => {
  const dir = fixture(t, { compilerOptions: options, files: ['main.ts'] }, { 'main.ts': 'export const x = 1;' });
  await assert.rejects(analyze({ project: dir, timeoutMs: 1 }), /exceeded/);
});

test('trace parse failures put the error message in the warning', async t => {
  const dir = fixture(t, { compilerOptions: options, include: ['**/*'] }, { 'main.ts': 'export const a = 1;' });
  const project = readProject(dir, ts);
  const graph = buildGraph(ts, project);
  const traceFile = path.join(dir, 'trace.json');
  fs.writeFileSync(traceFile, '{"truncated": ');
  const result = await readTrace(traceFile, dir, project, graph);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^Trace could not be parsed \(.+\)\. Other diagnostics remain available\.$/);
  assert.match(result.warnings[0], /JSON/);
  assert.ok(!/[\n\u0000-\u001f]/.test(result.warnings[0]));
});

test('check-hotspot is skipped when one chain covers at least 80 percent of the file time', () => {
  const group = (file, milliseconds) => ({ file, line: 1, character: 1, milliseconds, memberCount: 1, comparisons: [] });
  const file = (name, milliseconds) => ({ file: name, milliseconds });
  const rules = (files, groups) => measuredFindings({ hotspots: files, projectHotspots: files, sourceGroups: groups })
    .map(f => `${f.rule}:${f.evidence.file}`);
  // 80/100 is exactly at the threshold: the chain explains the file, so only the chain is reported.
  assert.deepEqual(rules([file('a.ts', 100)], [group('a.ts', 80)]), ['source-check-chain:a.ts']);
  assert.equal(CHAIN_COVERAGE_THRESHOLD, 0.8);
  // Below the threshold both findings remain.
  assert.deepEqual(rules([file('a.ts', 100)], [group('a.ts', 79)]), ['source-check-chain:a.ts', 'check-hotspot:a.ts']);
  // Two chains that each cover less than 80 percent do not suppress the file finding.
  assert.deepEqual(rules([file('a.ts', 200)], [group('a.ts', 100), group('a.ts', 60)]),
    ['source-check-chain:a.ts', 'source-check-chain:a.ts', 'check-hotspot:a.ts']);
  // A chain in another file never suppresses this file.
  assert.deepEqual(rules([file('a.ts', 100)], [group('b.ts', 100)]), ['source-check-chain:b.ts', 'check-hotspot:a.ts']);
});
