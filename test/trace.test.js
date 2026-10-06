import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { analyze, buildGraph, inspectProject, readProject } from '../src/analyze.js';
import { traceDetails, traceSpans, selectedTypeIds, resolveTraceTypes } from '../src/trace.js';
import { renderReport } from '../src/report.js';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-trace-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const text = 'type Source = { value: string };\ntype Target = { value: string };\n\nconst result: Target = {} as Source;\n';
  fs.writeFileSync(path.join(base, 'main.ts'), text);
  fs.writeFileSync(path.join(base, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true }, files: ['main.ts'] }));
  const graph = buildGraph(ts, readProject(base, ts));
  const file = path.join(base, 'main.ts');
  let declaration;
  graph.files.get(file).forEachChild(node => {
    if (ts.isVariableStatement(node)) declaration = node.declarationList.declarations[0];
  });
  const args = { path: file, pos: declaration.pos, end: declaration.end, kind: declaration.kind };
  const descriptors = [
    { id: 1, symbolName: 'Source', flags: ['Object'], firstDeclaration: { path: file, start: { line: 1, character: 1 } } },
    { id: 2, symbolName: 'Target', flags: ['Union'], unionTypes: [3, 4, 5],
      firstDeclaration: { path: file, start: { line: 1, character: text.indexOf('\n') + 1 }, end: { line: 2, character: 32 } } }
  ];
  const event = (name, start, duration, eventArgs = args, tid = 1) => ({ ph: 'X', pid: 1, tid, name, ts: start, dur: duration, args: eventArgs });
  return { base, graph, args, descriptors, event };
}

test('out-of-order complete spans locate source and resolve contained type declarations', t => {
  const { base, graph, args, descriptors, event } = fixture(t);
  const result = traceDetails([
    event('structuredTypeRelatedTo', 2000, 20000, { sourceId: 1, targetId: 2 }),
    event('checkVariableDeclaration', 1000, 30000),
    event('checkSourceFile', 0, 40000, { path: args.path })
  ], descriptors, base, graph);
  const hotspot = result.sourceHotspots[0];
  assert.equal(hotspot.file, 'main.ts');
  assert.equal(hotspot.line, 4);
  assert.equal(hotspot.character, 7);
  assert.equal(hotspot.snippet, 'result: Target = {} as Source');
  assert.equal(hotspot.milliseconds, 30);
  const comparison = hotspot.comparisons[0];
  assert.equal(comparison.milliseconds, 20);
  assert.equal(comparison.source.label, 'Source');
  assert.equal(comparison.target.unionMembers, 3);
  assert.deepEqual(comparison.target.declaration, { file: 'main.ts', line: 2, character: 1, scope: 'project' });
});

test('nested checks use the innermost same-thread context and merge repeated ranges', t => {
  const { base, graph, args, descriptors, event } = fixture(t);
  const source = graph.files.get(args.path);
  const innerPos = source.text.indexOf('{} as Source');
  const inner = { ...args, pos: innerPos - 1 };
  const result = traceDetails([
    event('checkVariableDeclaration', 0, 50000),
    event('checkExpression', 5000, 30000, inner),
    event('structuredTypeRelatedTo', 10000, 15000, { sourceId: 1, targetId: 2 }),
    event('structuredTypeRelatedTo', 20000, 10000, { sourceId: 1, targetId: 2 }),
    event('structuredTypeRelatedTo', 10000, 5000, { sourceId: 9, targetId: 10 }, 2),
    event('structuredTypeRelatedTo', 79000, 2000, { sourceId: 11, targetId: 12 }),
    event('checkVariableDeclaration', 25000, 50000)
  ], descriptors, base, graph);
  const outer = result.sourceHotspots.find(h => h.event === 'checkVariableDeclaration');
  const expression = result.sourceHotspots.find(h => h.event === 'checkExpression');
  assert.equal(outer.milliseconds, 75);
  assert.equal(outer.comparisons.length, 0);
  assert.equal(expression.milliseconds, 30);
  assert.equal(expression.comparisons.length, 1);
  assert.equal(expression.comparisons[0].milliseconds, 20);
  assert.equal(result.typeHotspots.find(c => c.source.id === 9).source.label, 'type #9 (unavailable)');
  assert.equal(result.typeHotspots.find(c => c.source.id === 11).milliseconds, 2);
});

test('begin/end pairing is isolated per thread and invalid or unfinished spans are ignored', t => {
  const { base, graph, args } = fixture(t);
  const events = [
    { ph: 'B', pid: 1, tid: 1, name: 'checkVariableDeclaration', ts: 0, args },
    { ph: 'B', pid: 1, tid: 2, name: 'structuredTypeRelatedTo', ts: 1000, args: { sourceId: 7, targetId: 8 } },
    { ph: 'E', pid: 1, tid: 1, ts: 20000 },
    { ph: 'E', pid: 1, tid: 2, ts: 30000 },
    { ph: 'E', pid: 1, tid: 3, ts: 50000 },
    { ph: 'B', pid: 1, tid: 1, name: 'checkExpression', ts: 50000, args },
    { ph: 'X', name: 'checkExpression', ts: 1, dur: -1, args },
    { ph: 'X', name: 'checkExpression', ts: 1, dur: 1000, args: { ...args, pos: -1 } },
    { ph: 'X', name: 'checkExpression', ts: 1, dur: 1000, args: { ...args, end: 10000 } }
  ];
  assert.equal(traceSpans(events).filter(s => s.end < s.ts).length, 0);
  const result = traceDetails(events, [], base, graph);
  assert.equal(result.sourceHotspots.length, 1);
  assert.equal(result.sourceHotspots[0].milliseconds, 20);
  assert.equal(result.sourceHotspots[0].comparisons.length, 0);
  assert.equal(result.typeHotspots[0].milliseconds, 29);
});

test('one temporal chain leaves room for other hotspots and focuses a costly deferred expression', t => {
  const { base, graph, args, event } = fixture(t);
  const events = [event('checkVariableDeclaration', 0, 100000)];
  // Temporal nesting can visit earlier offsets: it does not imply AST nesting.
  for (let i = 0; i < 6; i++) events.push(event('checkExpression', 100 + i * 100, 99000 - i * 100,
    { ...args, pos: 7 - i, end: 12 - i, kind: i === 5 ? ts.SyntaxKind.Identifier : ts.SyntaxKind.CallExpression }));
  events.push(event('checkExpression', 150000, 60000, { ...args, pos: 32, end: 40 }),
    event('checkExpression', 250000, 40000, { ...args, pos: 41, end: 45 }));
  const details = traceDetails(events.reverse(), [], base, graph);
  assert.equal(details.sourceHotspots.length, 5);
  assert.equal(details.sourceGroups.length, 3);
  const chain = details.sourceGroups[0];
  assert.equal(chain.memberCount, 7);
  assert.equal(chain.milliseconds, 100);
  assert.equal(chain.root.pos, args.pos);
  assert.equal(chain.pos, 3);
  assert.equal(chain.focusMilliseconds, 98.6);
  assert.equal(chain.members.length, 5);
  assert.ok(chain.members.reduce((sum, m) => sum + m.milliseconds, 0) > chain.milliseconds);
});

test('chains isolate files and threads, union repeated root intervals and hydrate selected comparisons', t => {
  const { base, graph, args, descriptors, event } = fixture(t);
  const other = path.join(base, 'other.ts');
  graph.files.set(other, ts.createSourceFile(other, 'const other = 1;', ts.ScriptTarget.Latest));
  const otherArgs = { ...args, path: other, pos: 0, end: 10 };
  const events = [event('checkVariableDeclaration', 0, 50000),
    event('checkExpression', 5000, 30000, { ...args, pos: 0, end: 10 }),
    event('structuredTypeRelatedTo', 10000, 20000, { sourceId: 1, targetId: 2 }),
    event('checkExpression', 6000, 25000, otherArgs, 2),
    event('structuredTypeRelatedTo', 11000, 10000, { sourceId: 3, targetId: 4 }, 2),
    event('checkExpression', 31000, 1000, otherArgs),
    event('structuredTypeRelatedTo', 31100, 500, { sourceId: 5, targetId: 6 }),
    event('checkExpression', 0, 70000, args, 3),
    event('checkVariableDeclaration', 25000, 50000),
    event('structuredTypeRelatedTo', 80000, 1000, { sourceId: 7, targetId: 8 })];
  const details = traceDetails(events, [], base, graph);
  assert.equal(details.sourceGroups.length, 4);
  const main = details.sourceGroups.find(h => h.root.event === 'checkVariableDeclaration');
  assert.equal(main.milliseconds, 75);
  assert.equal(main.memberCount, 2);
  assert.deepEqual(main.comparisons.map(c => c.source.id), [1]);
  assert.equal(details.sourceGroups.find(h => h.milliseconds === 70).comparisons.length, 0);
  assert.deepEqual([...selectedTypeIds(details)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const resolved = resolveTraceTypes(details, descriptors, base, graph);
  assert.equal(resolved.sourceGroups.find(h => h.milliseconds === 75).comparisons[0].source.label, 'Source');
  assert.equal(resolved.sourceGroups.find(h => h.milliseconds === 25).comparisons[0].source.label, 'type #3 (unavailable)');
});

test('type declarations skip leading comments and CRLF with the project compiler scanner', t => {
  const { base, graph, args, event } = fixture(t);
  const text = '\r\n/** Docs with { \\"[]\\" } */\r\n// a comment\r\n/* more */\r\n  export type Actual = string;\r\n';
  const source = ts.createSourceFile(args.path, text, ts.ScriptTarget.Latest);
  graph.files.set(args.path, source);
  const descriptor = { id: 1, symbolName: 'Actual', firstDeclaration: { path: args.path,
    start: { line: 1, character: 1 }, end: { line: 5, character: 31 } } };
  const result = traceDetails([event('structuredTypeRelatedTo', 0, 20000, { sourceId: 1, targetId: 2 })], [descriptor], base, graph);
  assert.deepEqual(result.typeHotspots[0].source.declaration, { file: 'main.ts', line: 5, character: 3, scope: 'project' });
  const replay = traceDetails([event('checkExpression', 0, 30000),
    event('structuredTypeRelatedTo', 1, 20000, { sourceId: 1, targetId: 2 })], [descriptor], base);
  assert.equal(replay.sourceGroups[0].locationAvailable, false);
  assert.equal(replay.sourceGroups[0].line, null);
  assert.equal(replay.typeHotspots[0].source.declaration.locationKind, 'trace');
  assert.equal(replay.typeHotspots[0].source.declaration.line, 1);
});

test('project files remain visible even when six dependency intervals are larger', t => {
  const { base, graph, args, descriptors, event } = fixture(t);
  const dependency = path.join(base, 'node_modules', 'package', 'index.d.ts');
  const source = ts.createSourceFile(dependency, 'declare const x: number;', ts.ScriptTarget.Latest);
  graph.files.set(dependency, source);
  const isExternal = graph.program.isSourceFileFromExternalLibrary.bind(graph.program);
  graph.program.isSourceFileFromExternalLibrary = file => file === source || isExternal(file);
  const events = [event('checkExpression', 0, 10000), event('checkSourceFile', 0, 20000, { path: args.path })];
  for (let i = 0; i < 6; i++) events.push(event('checkSourceFile', i * 100000, 50000, { path: dependency + i }));
  events.push(event('checkExpression', 0, 60000, { path: dependency, pos: 14, end: 23 }));
  const result = traceDetails(events, descriptors, base, graph);
  assert.equal(result.sourceHotspots[0].scope, 'project');
  assert.equal(result.sourceHotspots[1].scope, 'dependency');
  assert.equal(result.hotspots.some(h => h.file === 'main.ts'), false);
  assert.deepEqual(result.projectHotspots, [{ file: 'main.ts', milliseconds: 20 }]);
});

test('barrels whose dependencies are already roots do not suggest a useless direct import', t => {
  const { base } = fixture(t);
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(base, name + '.ts'), `export const ${name} = 1;`);
  fs.writeFileSync(path.join(base, 'index.ts'), 'export * from "./a"; export * from "./b"; export * from "./c";');
  fs.writeFileSync(path.join(base, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  const project = readProject(base, ts);
  const barrel = inspectProject(buildGraph(ts, project), project).find(f => f.rule === 'barrel-reach');
  assert.equal(barrel.evidence.alreadyRootFiles, 3);
  assert.match(barrel.suggestion, /already configured roots/);
  assert.doesNotMatch(barrel.suggestion, /Try importing/);
});

test('canonical trace paths are looked up through the compiler when graph casing differs', t => {
  const { base, graph, args, event } = fixture(t);
  const source = graph.files.get(args.path);
  const canonical = args.path.toUpperCase();
  const lookup = graph.program.getSourceFile.bind(graph.program);
  graph.program.getSourceFile = file => file === canonical ? source : lookup(file);
  const result = traceDetails([event('checkVariableDeclaration', 0, 30000, { ...args, path: canonical }),
    event('checkSourceFile', 0, 40000, { path: canonical }),
    event('structuredTypeRelatedTo', 1000, 20000, { sourceId: 1, targetId: 2 })],
    [{ id: 1, symbolName: 'Source', firstDeclaration: { path: canonical, start: { line: 1, character: 1 } } }], base, graph);
  assert.equal(result.sourceHotspots.length, 1);
  assert.equal(result.sourceHotspots[0].line, 4);
  assert.equal(result.sourceHotspots[0].scope, 'project');
  assert.equal(result.sourceHotspots[0].file, 'main.ts');
  assert.equal(result.projectHotspots.length, 1);
  assert.equal(result.projectHotspots[0].file, 'main.ts');
  assert.equal(result.hotspots[0].file, 'main.ts');
  assert.equal(result.sourceHotspots[0].comparisons[0].source.declaration.file, 'main.ts');
});

test('real compiler example keeps measured findings ahead of heuristics and resolves any sampled comparisons', async () => {
  const report = await analyze({ project: fileURLToPath(new URL('../examples/type-comparison/tsconfig.json', import.meta.url)) });
  assert.equal(report.toolVersion, '0.3.0');
  assert.equal(report.summary.compilerExitCode, 0);
  assert.equal(report.typeDescriptors.mode, 'selective-stream');
  assert.equal(report.typeDescriptors.selectionComplete, true);
  assert.ok(report.projectHotspots.some(h => h.file === 'client.ts'));
  // Expression/type spans are sampled: validate emitted records, without a timing threshold.
  for (const hotspot of report.sourceHotspots) {
    assert.equal(hotspot.file, 'client.ts');
    assert.ok(hotspot.line > 0 && hotspot.character > 0 && hotspot.snippet.length > 0);
    for (const comparison of hotspot.comparisons) {
      assert.ok(Number.isInteger(comparison.source.id));
      assert.doesNotMatch(comparison.source.label, /unavailable/);
      assert.doesNotMatch(comparison.target.label, /unavailable/);
    }
  }
  for (const group of report.sourceGroups) {
    assert.ok(group.members.length > 0 && group.memberCount >= group.members.length);
    assert.ok(group.root.line > 0 && group.focusMilliseconds <= group.milliseconds);
    for (const comparison of group.comparisons) {
      assert.doesNotMatch(comparison.source.label, /unavailable/);
      assert.doesNotMatch(comparison.target.label, /unavailable/);
    }
  }
  assert.deepEqual(report.findings.map(f => f.confidence), [...report.findings.map(f => f.confidence)].sort((a, b) =>
    ['measured', 'observed', 'review'].indexOf(a) - ['measured', 'observed', 'review'].indexOf(b)));
  assert.match(renderReport(report), /Largest recorded project file-check intervals/);
});

test('terminal report puts source evidence before structure and sanitizes snippets and labels', t => {
  const { base, graph, descriptors, event } = fixture(t);
  const details = traceDetails([event('checkVariableDeclaration', 0, 30000),
    event('structuredTypeRelatedTo', 1000, 20000, { sourceId: 1, targetId: 2 })], descriptors, base, graph);
  const evidence = { ...details.sourceGroups[0], snippet: '\x1b[31msecret' };
  evidence.comparisons[0].source.label = '\x1b[2JSource';
  const report = { typescriptVersion: '5.9.3', project: 'tsconfig.json', summary: { programFiles: 1, compilerExitCode: 0 },
    diagnostics: {}, findings: [{ confidence: 'review', title: 'Broad inclusion', evidence: {}, suggestion: 'Review' },
      { confidence: 'measured', title: 'main.ts:4:7', evidence, suggestion: 'Inspect' }], ...details, warnings: [] };
  const text = renderReport(report);
  assert.ok(text.indexOf('main.ts:4:7') < text.indexOf('Project structure'));
  assert.ok(text.indexOf('Project structure') < text.indexOf('Broad inclusion'));
  assert.match(text, /source: \?\[2JSource/);
  assert.match(text, /target: Target.*main.ts:2:1/);
  assert.match(text, /1 source checks in one same-thread chain; durations overlap and must not be added/);
  assert.doesNotMatch(text, /\x1b/);
});
