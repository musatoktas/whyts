// Tests for the program-load diagnosis (0.8.4).
// The project is a small copy of the shape measured in vuetifyjs/vuetify issue 23005: one import of a package whose
// framework.d.ts names every component with typeof import('pkg/components')['Name'], so one barrel brings hundreds of files.
// The counters below are the ones measured for vuetify 4.2.4 (Check 0.01 s, Total 4.19 s) and for an empty project (Total 0.61 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { buildGraph, readProject, explainFile } from '../src/analyze.js';
import { programLoadDiagnosis, buildDiagnoses, collectSignals, PROGRAM_LOAD } from '../src/diagnose.js';
import { renderReport } from '../src/report.js';
import { compactReport } from '../src/mcp-tools.js';

const COMPONENTS = 260;
const counters = (total, check, extra = {}) => ({ 'Total time': { value: total, unit: 's' }, 'Check time': { value: check, unit: 's' },
  'Memory used': { value: 535184, unit: 'K' }, ...extra });

function project(t, { components = COMPONENTS, frameworkImport = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-load-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (name, text) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const pkg = 'node_modules/bigpkg';
  write(`${pkg}/package.json`, JSON.stringify({ name: 'bigpkg', version: '1.0.0', types: 'lib/index.d.ts' }));
  write(`${pkg}/lib/index.d.ts`, 'export { create } from "./framework";\n');
  write(`${pkg}/lib/framework.d.ts`, ['export declare function create(): void;',
    frameworkImport ? 'export interface GlobalComponents {' + Array.from({ length: 3 }, (_, i) => ` C${i}: typeof import("./components/index")["c${i}"];`).join('') + ' }' : 'export interface GlobalComponents {}', ''].join('\n'));
  write(`${pkg}/lib/components/index.d.ts`, Array.from({ length: components }, (_, i) => `export * from "./c${i}";`).join('\n') + '\n');
  for (let i = 0; i < components; i++) write(`${pkg}/lib/components/c${i}.d.ts`, `export declare const c${i}: number;\n`);
  write('src/index.ts', 'import { create } from "bigpkg";\nexport const plugin = create();\n');
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['src'] }));
  return { base, graph: buildGraph(ts, readProject(base, ts)) };
}

test('typeof import("pkg") in a declaration file is an edge of the import graph', t => {
  const { base, graph } = project(t);
  const why = explainFile(graph, 'node_modules/bigpkg/lib/components/index.d.ts', base);
  assert.deepEqual(why.chain, ['src/index.ts', 'node_modules/bigpkg/lib/index.d.ts', 'node_modules/bigpkg/lib/framework.d.ts', 'node_modules/bigpkg/lib/components/index.d.ts']);
});

test('a big program with a cheap check names the file that brings the files and the chain to it', t => {
  const { base, graph } = project(t);
  const d = programLoadDiagnosis({ graph, base, diagnostics: counters(4.19, 0.01, { 'Parse time': { value: 1.5, unit: 's' } }) });
  assert.equal(d.pattern, 'program-load');
  assert.equal(d.confidence, 'measured');
  assert.equal(d.evidence.dependencyFiles, COMPONENTS + 3);
  assert.equal(d.evidence.projectFiles, 1);
  assert.equal(d.evidence.lead.file, 'node_modules/bigpkg/lib/components/index.d.ts');
  assert.equal(d.evidence.lead.filesOnlyThroughIt, COMPONENTS + 1);
  assert.deepEqual(d.evidence.lead.importedBy, ['node_modules/bigpkg/lib/framework.d.ts']);
  assert.deepEqual(d.evidence.lead.chain.slice(0, 3), ['src/index.ts', 'node_modules/bigpkg/lib/index.d.ts', 'node_modules/bigpkg/lib/framework.d.ts']);
  const types = d.evidence.lead.importTypeReferences;
  assert.equal(types.file, 'node_modules/bigpkg/lib/framework.d.ts');
  assert.equal(types.references, 3);
  assert.equal(types.filesOnlyThroughThem, COMPONENTS + 1);
  assert.deepEqual(types.targets.map(t => [t.file, t.references, t.filesOnlyThroughIt]), [['node_modules/bigpkg/lib/components/index.d.ts', 3, COMPONENTS + 1]]);
  assert.match(d.remedy, /opt-in entry point/);
  assert.deepEqual(d.evidence.packages[0].name, 'bigpkg');
  assert.equal(d.evidence.memoryMegabytes, 523);
  assert.ok(d.evidence.summary.some(l => l.includes('Parse 1.5s')));
  assert.equal(d.checkTimeShareUpperBoundPercent, null);
  assert.ok(Math.abs(d.milliseconds - 4180) < 1e-6);
  assert.match(d.remedy, /skipLibCheck/);
  assert.ok(d.evidence.summary.length <= 6);
});

test('a regular import of the same file is not counted as a typeof import() reference', t => {
  const { base, graph } = project(t);
  const framework = path.join(base, 'node_modules/bigpkg/lib/framework.d.ts');
  assert.ok(graph.importTypes.get(framework).size > 0);
  const mixed = project(t);
  fs.appendFileSync(path.join(mixed.base, 'node_modules/bigpkg/lib/framework.d.ts'), 'import type {} from "./components/index";\n');
  const again = buildGraph(ts, readProject(mixed.base, ts));
  assert.equal(again.importTypes.get(path.join(mixed.base, 'node_modules/bigpkg/lib/framework.d.ts')), undefined);
  const d = programLoadDiagnosis({ graph: again, base: mixed.base, diagnostics: counters(4.19, 0.01) });
  assert.equal(d.evidence.lead.importTypeReferences, undefined);
  assert.match(d.remedy, /narrower entry point/);
});

test('the same program with the barrel import removed gives no diagnosis', t => {
  const { base, graph } = project(t, { frameworkImport: false });
  assert.equal(programLoadDiagnosis({ graph, base, diagnostics: counters(0.7, 0.01) }), null);
});

test('each limit keeps the diagnosis away', t => {
  const { base, graph } = project(t);
  const run = diagnostics => programLoadDiagnosis({ graph, base, diagnostics });
  assert.ok(run(counters(4.19, 0.01)));
  assert.equal(run(counters(PROGRAM_LOAD.minTotalSeconds - 0.01, 0.01)), null, 'a short run');
  assert.equal(run(counters(10, 1.5)), null, 'a check of more than one second');
  assert.equal(run(counters(4, 0.5)), null, 'a check of more than a tenth of the run');
  assert.equal(run({ 'Total time': { value: 4, unit: 's' } }), null, 'no Check time');
  assert.equal(programLoadDiagnosis({ graph: null, base, diagnostics: counters(4, 0.01) }), null);
});

test('a package below the file limit gives no diagnosis even when the run is slow', t => {
  const { base, graph } = project(t, { components: 120 });
  assert.equal(programLoadDiagnosis({ graph, base, diagnostics: counters(6, 0.01) }), null);
});

test('buildDiagnoses returns the program-load diagnosis without trace signals, and none without counters', t => {
  const { base, graph } = project(t);
  assert.deepEqual(buildDiagnoses({ signals: null, graph, base, diagnostics: counters(4.19, 0.01) }).map(d => d.pattern), ['program-load']);
  assert.deepEqual(buildDiagnoses({ signals: collectSignals([]), describe: () => ({}), checkSeconds: 0.01, graph, base, compilerErrors: { excessiveDepth: [] }, intervals: {} }), []);
  assert.deepEqual(buildDiagnoses({ signals: null, graph, base, diagnostics: counters(4.19, 0.01) }).length, 1);
});

function reportFor(t) {
  const { base, graph } = project(t);
  const diagnoses = buildDiagnoses({ signals: null, graph, base, diagnostics: counters(4.19, 0.01) });
  return { schemaVersion: 1, toolVersion: '0.0.0', typescriptVersion: ts.version, project: 'tsconfig.json', summary: { programFiles: graph.files.size },
    diagnostics: counters(4.19, 0.01), compilerErrors: { total: 0, first: [], codes: [] }, findings: [], diagnoses, hotspots: [], projectHotspots: [], typeHotspots: [], warnings: [] };
}

test('the compact terminal report shows the lead file, the chain and the remedy', t => {
  const text = renderReport(reportFor(t));
  assert.match(text, /1\. \[measured\] Program load: 263 dependency files, bigpkg has 263/);
  assert.match(text, /Where: node_modules\/bigpkg\/lib\/components\/index\.d\.ts:1:1/);
  assert.match(text, /Shortest import chain: src\/index\.ts -> .*framework\.d\.ts -> .*components\/index\.d\.ts/);
  assert.match(text, /Fix: .*skipLibCheck/);
  assert.doesNotMatch(text, /No known slow pattern/);
});

test('the MCP result keeps the same fields as other diagnoses', t => {
  const out = compactReport(reportFor(t));
  const [d] = out.diagnoses;
  assert.deepEqual(Object.keys(d), ['pattern', 'confidence', 'title', 'location', 'evidence', 'remedy', 'docs']);
  assert.equal(d.pattern, 'program-load');
  assert.equal(d.location, 'node_modules/bigpkg/lib/components/index.d.ts:1:1');
  assert.ok(d.evidence.length >= 3 && d.evidence.length <= 6);
});
