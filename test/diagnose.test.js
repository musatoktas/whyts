// Tests for the diagnosis layer (0.7).
// test/fixtures/diagnose/*-recursion.json are trimmed real traces of one repro, captured on 2026-10-07 with typescript 5.9.3,
// 6.0.3 and 7.0.2 (linux-x64, --checkers 1). The repro is DeepKeys<{ name: string; data: JsonData }> from TanStack/form issue 1474.
// util-types.ts.txt is packages/form-core/src/util-types.ts of TanStack/form commit 2216fde (MIT, Copyright (c) 2021-present Tanner Linsley).
// The fixtures keep three depth-limit events per type id and use {{base}} for the project directory.
// ts56-variance.json holds real getVariancesWorker events of drizzle-orm 15454db (TypeScript 5.6.3). The type descriptors are written below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { buildGraph, readProject, parseCompilerErrors } from '../src/analyze.js';
import { typeDescriber } from '../src/trace.js';
import { collectSignals, signalTypeIds, buildDiagnoses } from '../src/diagnose.js';
import { renderReport } from '../src/report.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, 'test/fixtures/diagnose');
// The base is escaped for JSON: a Windows path has backslashes.
const jsonText = value => JSON.stringify(value).slice(1, -1);
const readFixture = (name, base) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8').replaceAll('{{base}}', jsonText(base)));
const error = 'k.ts(4,17): error TS2589: Type instantiation is excessively deep and possibly infinite.';

function recursionProject(t, { text = fs.readFileSync(path.join(fixtures, 'util-types.ts.txt'), 'utf8') } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-diag-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'src')); fs.mkdirSync(path.join(base, 'repro-project'));
  fs.writeFileSync(path.join(base, 'src/util-types.ts'), text);
  fs.writeFileSync(path.join(base, 'repro-project/k.ts'), [
    'import type { DeepKeys, DeepValue } from "../src/util-types"',
    'type JsonData = string | number | boolean | null | JsonData[] | { [k: string]: JsonData }',
    'type Values = { name: string; data: JsonData }',
    'export type K = DeepKeys<Values>',
    'export type V = DeepValue<Values, "data.a[0].b">', ''].join('\n'));
  fs.writeFileSync(path.join(base, 'repro-project/tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true,
    skipLibCheck: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['k.ts'] }));
  const project = path.join(base, 'repro-project');
  return { base, project, graph: buildGraph(ts, readProject(project, ts)) };
}

function diagnoseRecursion(t, name, { native = false } = {}) {
  const { base, project, graph } = recursionProject(t);
  const fixture = readFixture(`${name}-recursion.json`, base);
  // The native compiler writes lower case declaration paths into types_0.json.
  const types = native ? JSON.parse(JSON.stringify(fixture.types).replaceAll(jsonText(base), jsonText(base.toLowerCase()))) : fixture.types;
  const traceGraph = native ? Object.assign(Object.create(graph), { native: { identifierKind: 79 } }) : graph;
  const signals = collectSignals(fixture.events);
  const describe = typeDescriber(types, project, traceGraph);
  const diagnoses = buildDiagnoses({ signals, describe, checkSeconds: 10, graph: traceGraph, base: project,
    compilerErrors: parseCompilerErrors(error, 5, project),
    intervals: { sourceGroups: [], projectHotspots: [{ file: 'k.ts', milliseconds: 9000 }] } });
  return { signals, diagnoses, fixture };
}

function assertRecursion({ signals, diagnoses, fixture }) {
  assert.equal(diagnoses.length, 1);
  const d = diagnoses[0];
  assert.equal(d.pattern, 'recursive-type-instantiation');
  assert.equal(d.confidence, 'measured');
  assert.deepEqual(d.location, { file: 'k.ts', line: 4, character: 17 });
  assert.equal(d.evidence.expression, 'DeepKeys<Values>');
  assert.equal(d.evidence.compilerError.code, 'TS2589');
  assert.equal(d.evidence.typeAlias, 'DeepKeysAndValuesImpl');
  assert.deepEqual(d.evidence.location, { file: '../src/util-types.ts', line: 151, character: 1 });
  assert.deepEqual(d.evidence.cycle, ['DeepKeysAndValuesImpl', 'DeepKeyAndValueArray', 'DeepKeysAndValuesImpl']);
  assert.equal(d.evidence.selfContainingArguments.length, 1);
  assert.deepEqual(d.evidence.selfContainingArguments[0], { name: 'JsonData', location: { file: 'k.ts', line: 2, character: 1 }, cycle: ['JsonData', 'JsonData'] });
  assert.equal(d.milliseconds, 9000);
  assert.equal(d.checkTimeShareUpperBoundPercent, 90);
  assert.match(d.remedy, /DeepKeysAndValuesImpl/);
  assert.match(d.docs, /^https:\/\//);
  assert.equal(signals.depth.event, 'instantiateType_DepthLimit');
  assert.equal(signals.depth.events, fixture.events.filter(e => e.name === 'instantiateType_DepthLimit').length);
  assert.equal(signals.depth.maxInstantiationCount, 5000000);
}

test('TypeScript 5.9 trace: a depth-limit trace and a TS2589 error give the recursive alias, the cycle and the self-containing argument', t => {
  assertRecursion(diagnoseRecursion(t, 'ts59'));
});

test('TypeScript 6.0 trace: the same diagnosis', t => {
  assertRecursion(diagnoseRecursion(t, 'ts60'));
});

test('TypeScript 7 trace: type ids differ, lower case declaration paths, same diagnosis', t => {
  const result = diagnoseRecursion(t, 'ts7', { native: true });
  assertRecursion(result);
  assert.ok(result.fixture.events.some(e => e.args?.checkerId === 0), 'the native events carry a checkerId');
});

test('depth-limit events are counted per type id and sorted by count', () => {
  const event = (typeId, depth, count) => ({ ph: 'I', pid: 1, tid: 1, ts: 1, name: 'instantiateType_DepthLimit', args: { typeId, instantiationDepth: depth, instantiationCount: count } });
  const { depth } = collectSignals([event(7, 100, 10), event(9, 100, 11), event(9, 99, 12), event(9, 98, 5000000), event(3, 5, 13),
    { ph: 'I', pid: 1, tid: 1, ts: 1, name: 'other', args: { typeId: 1 } }]);
  assert.equal(depth.events, 5);
  assert.equal(depth.maxInstantiationCount, 5000000);
  assert.deepEqual(depth.types.map(x => [x.typeId, x.events, x.maxDepth]), [[9, 3, 100], [3, 1, 5], [7, 1, 100]]);
});

test('no TS2589 error and no depth-limit event: no recursion diagnosis', t => {
  const { project, graph } = recursionProject(t);
  const diagnoses = buildDiagnoses({ signals: collectSignals([]), describe: typeDescriber([], project, graph), checkSeconds: 1, graph, base: project,
    compilerErrors: parseCompilerErrors('', 5, project), intervals: {} });
  assert.deepEqual(diagnoses, []);
});

test('a type alias that does not refer to itself gets no cycle claim', t => {
  const { base, project, graph } = recursionProject(t, { text: 'export type DeepKeys<T> = keyof T\nexport type DeepValue<T, K> = T\n' });
  const fixture = readFixture('ts59-recursion.json', base);
  const describe = typeDescriber([], project, graph);
  const [d] = buildDiagnoses({ signals: collectSignals(fixture.events), describe, checkSeconds: 10, graph, base: project,
    compilerErrors: parseCompilerErrors(error, 5, project), intervals: {} });
  assert.equal(d.evidence.cycle, null);
  assert.equal(d.evidence.typeAlias, null);
  assert.equal(d.evidence.expression, 'DeepKeys<Values>');
  assert.equal(d.evidence.selfContainingArguments[0].name, 'JsonData', 'the argument still refers to itself');
  assert.equal(d.checkTimeShareUpperBoundPercent, null, 'no matching interval, no share');
});

test('parseCompilerErrors lists TS2589 sites for the diagnosis, even beyond the first errors', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `a${i}.ts(1,1): error TS2322: bad`);
  const parsed = parseCompilerErrors([...lines, error, 'no-location: error TS2589: nothing'].join('\n'), 5);
  assert.equal(parsed.first.length, 5);
  assert.deepEqual(parsed.excessiveDepth, [{ file: 'k.ts', line: 4, character: 17, code: 'TS2589', message: 'Type instantiation is excessively deep and possibly infinite.' }]);
});

// Partial constraint. ts59-partial-constraint.json holds the depth-limit events and their descriptors from a real trace of an
// Elysia 2.0.0-beta.30 app with 64 plugins and Treaty.Create<App> of @elysia/eden 2.0.0-beta.6 (elysiajs/eden issue 274,
// typescript 5.9.3, captured on 2026-10-19). The declaration positions are rewritten to the stub files below.
const elysiaBase = `type DefaultEphemeral = { derive: {} }
type DefaultMetadata = { macro: {} }
declare class Elysia<const in out BasePath extends string = '', const in out Scope extends string = 'local', const in out Singleton = {}, const in out Definitions = {},
  const in out Metadata = DefaultMetadata, const in out Routes = {}, const in out Ephemeral = DefaultEphemeral, const in out Volatile = DefaultEphemeral> {
  '~Routes': Routes;
  '~Ephemeral': Ephemeral;
  use<const NewElysia extends Elysia<any, any, any, any, any, any, any, any>>(plugin: NewElysia): Elysia<BasePath, Scope, Singleton, Definitions, Metadata,
    Routes & NewElysia['~Routes'], Ephemeral, Volatile & NewElysia['~Ephemeral']>;
}
export { Elysia }
`;
const edenIndex = anys => `import type { Elysia } from 'elysia';
export declare namespace Treaty {
    type Create<App extends Elysia<${anys}>> = App extends { '~Routes': infer Schema } ? Schema : never;
}
export declare const treaty: <const App extends Elysia<${anys}>>(domain: string) => Treaty.Create<App>;
`;

function partialProject(t, { anys = 7, client = 'export declare const client: Treaty.Create<App>', at = '3,30', fixture: fixtureName = 'ts59-partial-constraint.json', files: extra = {} } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-partial-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const files = {
    'node_modules/elysia/package.json': '{ "name": "elysia", "version": "0.0.0", "types": "dist/index.d.ts" }',
    'node_modules/elysia/dist/index.d.ts': "export { Elysia } from './base'\n",
    'node_modules/elysia/dist/base.d.ts': elysiaBase,
    'node_modules/@elysia/eden/package.json': '{ "name": "@elysia/eden", "version": "0.0.0", "types": "dist/index.d.ts" }',
    'node_modules/@elysia/eden/dist/index.d.ts': edenIndex(Array(anys).fill('any').join(', ')),
    'src/api.ts': "import { Elysia } from 'elysia'\nexport declare const app: Elysia<'/api/v1'>\nexport type App = typeof app\n",
    'src/client.ts': `import { treaty, type Treaty } from '@elysia/eden'\nimport type { App } from './api'\n${client}\n`,
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext',
      moduleResolution: 'Bundler', types: [] }, include: ['src'] }),
    ...extra
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
    fs.writeFileSync(path.join(base, name), text);
  }
  const graph = buildGraph(ts, readProject(base, ts));
  const fixture = readFixture(fixtureName, base);
  return buildDiagnoses({ signals: collectSignals(fixture.events), describe: typeDescriber(fixture.types, base, graph), checkSeconds: 4, graph, base,
    compilerErrors: parseCompilerErrors(`src/client.ts(${at}): error TS2589: Type instantiation is excessively deep and possibly infinite.`, 5, base),
    intervals: { sourceGroups: [{ file: 'src/client.ts', line: 3, milliseconds: 136 }], projectHotspots: [] } });
}

test('partial constraint: the constraint at the TS2589 site names 7 of the 8 type parameters of the class at the limit', t => {
  const diagnoses = partialProject(t);
  assert.equal(diagnoses.length, 1);
  const d = diagnoses[0];
  assert.equal(d.pattern, 'partial-constraint');
  assert.equal(d.confidence, 'measured');
  assert.deepEqual(d.location, { file: 'src/client.ts', line: 3, character: 30 });
  assert.equal(d.title, 'Constraint gives 7 of 8 type arguments to Elysia: Treaty.Create<App>');
  assert.equal(d.evidence.typeParameter, 'App');
  assert.equal(d.evidence.constraint, 'Elysia<any, any, any, any, any, any, any>');
  assert.deepEqual(d.evidence.location, { file: 'node_modules/@elysia/eden/dist/index.d.ts', line: 3, character: 29 });
  assert.deepEqual(d.evidence.genericLocation, { file: 'node_modules/elysia/dist/base.d.ts', line: 3, character: 1 });
  assert.deepEqual(d.evidence.missing, [{ name: 'Volatile', default: 'DefaultEphemeral', modifiers: ['in', 'out'] }]);
  assert.equal(d.evidence.limitEvents, 6);
  assert.ok(d.evidence.types.some(o => o.typeName === 'Volatile' && o.alias === 'Elysia'));
  assert.match(d.evidence.summary.join('\n'), /The omitted Volatile takes its default: Volatile = DefaultEphemeral \(in out\)\./);
  assert.match(d.remedy, /^Give all 8 type arguments of Elysia in the constraint of App, for example any for each\. /);
  assert.match(d.remedy, /node_modules\/@elysia\/eden\/dist\/index\.d\.ts:3\. It is in a dependency, so tell its maintainers\./);
  assert.equal(d.milliseconds, 136);
  assert.equal(d.checkTimeShareUpperBoundPercent, 3.4);
});

test('partial constraint: a generic function type in a variable declaration (typeof treaty<App>)', t => {
  const [d] = partialProject(t, { client: 'export type C = typeof treaty<App>', at: '3,17' });
  assert.equal(d.pattern, 'partial-constraint');
  assert.equal(d.title, 'Constraint gives 7 of 8 type arguments to Elysia: typeof treaty<App>');
  assert.deepEqual(d.evidence.location, { file: 'node_modules/@elysia/eden/dist/index.d.ts', line: 5, character: 49 });
});

test('partial constraint: a constraint with all type arguments keeps the recursion diagnosis', t => {
  const [d] = partialProject(t, { anys: 8 });
  assert.equal(d.pattern, 'recursive-type-instantiation');
  assert.equal(d.evidence.typeAlias, 'Elysia');
});

// Instantiation expression. ts59-instantiation-expression.json holds depth-limit events and their descriptors from a real trace of
// the same Elysia app with 90 plugins, with the Eden constraints given 8 type arguments, and the type
// ReturnType<typeof wrap<App>> where wrap is declare function wrap<A>(a: A): { app: A } (typescript 5.9.3, captured on 2026-10-20).
// In that app ReturnType<typeof wrap<App>> hit TS2589 and the same conditional type written in place did not.
// The limit events are on hook objects of src/p0.ts and on type parameters of Elysia, as in the trace.
const wrap = 'declare function wrap<A>(a: A): { app: A }';
const hookFile = { 'src/p0.ts': "import type { Elysia } from 'elysia'\nexport declare const p0: Elysia<'/p0'>\nexport const hooks = [{ params: 'id' },\n  { body: 'name' }]\n" };
const expressionProject = (t, client, at, options = {}) =>
  partialProject(t, { anys: 8, client, at, fixture: 'ts59-instantiation-expression.json', files: hookFile, ...options });

test('instantiation expression: ReturnType<typeof wrap<App>> gets the conditional type in place, not a recursion remedy', t => {
  const diagnoses = expressionProject(t, `${wrap}\nexport type W = ReturnType<typeof wrap<App>>`, '4,17');
  assert.equal(diagnoses.length, 1);
  const d = diagnoses[0];
  assert.equal(d.pattern, 'instantiation-expression');
  assert.equal(d.confidence, 'measured');
  assert.deepEqual(d.location, { file: 'src/client.ts', line: 4, character: 17 });
  assert.equal(d.title, 'Instantiation expression given to a conditional type: ReturnType<typeof wrap<App>>');
  assert.equal(d.evidence.argument, 'typeof wrap<App>');
  assert.equal(d.evidence.generic, 'ReturnType');
  assert.match(d.evidence.genericLocation.file, /lib\.es5\.d\.ts$/);
  assert.match(d.evidence.summary[1], /ReturnType is a conditional type \(lib\.es5\.d\.ts:\d+\)\.$/);
  assert.equal(d.evidence.inline, 'typeof wrap<App> extends (...args: any) => infer R ? R : any');
  assert.equal(d.evidence.returnType, '{ app: A }');
  assert.deepEqual(d.evidence.returnTypeLocation, { file: 'src/client.ts', line: 3, character: 33 });
  assert.equal(d.evidence.limitEvents, 7);
  assert.ok(d.evidence.types.some(o => o.alias === 'Elysia'), 'the limit events are inside Elysia, as in the trace');
  assert.match(d.evidence.summary.join('\n'), /not in ReturnType: types from node_modules\/elysia\/dist\/base\.d\.ts, src\/p0\.ts\./);
  assert.equal(d.remedy, 'Write the conditional type of ReturnType in place: typeof wrap<App> extends (...args: any) => infer R ? R : any. ' +
    'Or use the type that wrap returns, { app: A }, from src/client.ts:3. Measure again after the change.');
});

test('instantiation expression: through a type alias, given to Parameters', t => {
  const [d] = expressionProject(t, `${wrap}\ntype F = typeof wrap<App>\nexport type P = Parameters<F>`, '5,17');
  assert.equal(d.pattern, 'instantiation-expression');
  assert.equal(d.evidence.argument, 'F');
  assert.equal(d.evidence.instantiation, 'typeof wrap<App>');
  assert.equal(d.evidence.inline, 'F extends (...args: infer P) => any ? P : never');
  assert.match(d.evidence.summary[1], /^The type argument F is an instantiation expression \(typeof wrap<App>\)\. Parameters is a conditional type/);
  assert.doesNotMatch(d.remedy, /Or use the type/, 'only ReturnType has a declared type to use instead');
});

test('instantiation expression: the Eden form ReturnType<typeof treaty<App>> names the declared return type', t => {
  const [d] = expressionProject(t, 'export type C = ReturnType<typeof treaty<App>>', '3,17');
  assert.equal(d.pattern, 'instantiation-expression');
  assert.equal(d.evidence.returnType, 'Treaty.Create<App>');
  assert.deepEqual(d.evidence.returnTypeLocation, { file: 'node_modules/@elysia/eden/dist/index.d.ts', line: 5, character: 116 });
});

test('instantiation expression: a type alias that is not a conditional type keeps the recursion diagnosis', t => {
  const [d] = expressionProject(t, `${wrap}\ntype Box<T> = { value: T }\nexport type W = Box<typeof wrap<App>>`, '5,17');
  assert.equal(d.pattern, 'recursive-type-instantiation');
});

// Variance diagnosis. The descriptors give the real type ids of the drizzle-orm trace a name and a declaration.
function varianceCase(t, { scale = 1, declare = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-var-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const names = { 355795: 'SQLiteSession', 356364: 'SQLiteTransaction', 357760: 'SQLiteSelectBuilder', 357784: 'CreateSQLiteSelectFromBuilderMode',
    299562: 'SingleStoreSession', 303717: 'SingleStoreTransaction', 305216: 'SingleStoreSelectBuilder', 305615: 'CreateSingleStoreSelectFromBuilderMode' };
  const file = path.join(base, 'session.ts');
  fs.writeFileSync(path.join(base, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true }, files: ['session.ts'] }));
  fs.writeFileSync(file, Object.values(names).map(n => `export class ${n}<A, B> { a?: A; b?: B }`).join('\n') + '\n');
  const descriptors = Object.entries(names).map(([id, symbolName], i) => ({ id: Number(id), symbolName, flags: ['Object'],
    firstDeclaration: { path: declare ? file : path.join(base, 'elsewhere.d.ts'), start: { line: i + 1, character: 1 }, end: { line: i + 1, character: 20 } } }));
  const graph = buildGraph(ts, readProject(base, ts));
  const { events } = readFixture('ts56-variance.json', base);
  const scaled = events.map(e => ({ ...e, dur: e.dur * scale }));
  const signals = collectSignals(scaled);
  return { signals, graph, base, describe: typeDescriber(descriptors, base, graph) };
}

test('variance diagnosis: outer getVariancesWorker events, nested types, union time and a check share', t => {
  const { signals, graph, base, describe } = varianceCase(t);
  assert.equal(signals.variances.length, 2, 'two outer events; the nested ones are not outer');
  assert.deepEqual(signals.variances[0].nested.map(n => n.id), [356364, 357760, 357784]);
  assert.ok(signalTypeIds(signals).has(305615), 'the nested type ids of an outer event are resolved too');
  const [d] = buildDiagnoses({ signals, describe, checkSeconds: 7, graph, base });
  assert.equal(d.pattern, 'variance-computation');
  assert.equal(d.confidence, 'measured');
  assert.equal(d.evidence.event, 'getVariancesWorker');
  assert.equal(d.evidence.typeName, 'SQLiteSession');
  assert.deepEqual(d.location, { file: 'session.ts', line: 5, character: 1, scope: 'project' }, 'SQLiteSession is the fifth class: numeric keys sort first');
  assert.deepEqual(d.evidence.types.map(x => x.typeName), ['SQLiteSession', 'SingleStoreSession']);
  assert.deepEqual(d.evidence.types[0].nested.map(n => n.typeName), ['SQLiteTransaction', 'SQLiteSelectBuilder', 'CreateSQLiteSelectFromBuilderMode']);
  assert.deepEqual(d.evidence.types[0].variances, ['out', 'out', 'out', 'out']);
  assert.equal(d.evidence.types[0].arity, 4);
  // The two outer events do not overlap in time, so the union is their sum: 503.1 ms + 479.1 ms.
  assert.ok(d.milliseconds > 980 && d.milliseconds < 985, String(d.milliseconds));
  assert.equal(d.checkTimeShareUpperBoundPercent, Math.round(d.milliseconds / 7000 * 1000) / 10);
  assert.match(d.remedy, /not a guaranteed fix/, 'an in or out annotation is never presented as a guaranteed fix');
});

test('variance diagnosis: events below 50 ms, and types not declared in project code, give no diagnosis', t => {
  const small = varianceCase(t, { scale: 0.05 });
  assert.deepEqual(buildDiagnoses({ signals: small.signals, describe: small.describe, checkSeconds: 7, graph: small.graph, base: small.base }), []);
  const dependency = varianceCase(t, { declare: false });
  assert.deepEqual(buildDiagnoses({ signals: dependency.signals, describe: dependency.describe, checkSeconds: 7, graph: dependency.graph, base: dependency.base }), [],
    'a type that the project cannot change gets no remedy');
});

test('variance events that overlap are counted once', () => {
  const event = (id, ts, dur) => ({ ph: 'X', pid: 1, tid: 1, ts, dur, name: 'getVariancesWorker', args: { arity: 1, id, results: { variances: ['out'] } } });
  const { variances } = collectSignals([event(1, 0, 200000), event(2, 100000, 200000), event(3, 50000, 20000)]);
  assert.equal(variances.length, 2, 'event 3 is inside event 1; event 2 starts inside event 1 but ends later, so it is outer');
});

test('remedies follow the instruction length rule: at most 20 words per sentence', t => {
  const sentences = text => text.split(/(?<=\.)\s+/);
  const texts = [diagnoseRecursion(t, 'ts59').diagnoses[0].remedy];
  const v = varianceCase(t);
  texts.push(buildDiagnoses({ signals: v.signals, describe: v.describe, checkSeconds: 7, graph: v.graph, base: v.base })[0].remedy);
  texts.push(partialProject(t)[0].remedy);
  texts.push(expressionProject(t, `${wrap}\nexport type W = ReturnType<typeof wrap<App>>`, '4,17')[0].remedy);
  for (const text of texts) for (const sentence of sentences(text)) assert.ok(sentence.split(/\s+/).length <= 20, sentence);
});

// Terminal output.
const diagnosis = (n, extra = {}) => ({ pattern: 'variance-computation', confidence: 'measured', title: `Diagnosis ${n}`, location: { file: `f${n}.ts`, line: n, character: 1 },
  milliseconds: 100 * n, checkTimeShareUpperBoundPercent: 10, evidence: { summary: [`Summary ${n}.`], details: [`Detail ${n}.`] }, remedy: `Remedy ${n}.`, docs: 'https://example.test/docs', ...extra });
const report = (diagnoses, findings = []) => ({ toolVersion: '0.7.0', typescriptVersion: '5.9.3', project: 'tsconfig.json', diagnostics: { 'Check time': { value: 2 }, 'Total time': { value: 3 } },
  summary: { programFiles: 12, compilerExitCode: 0, errorCount: 0 }, compilerErrors: { total: 0, first: [], codes: [] }, findings, diagnoses, hotspots: [{ file: 'big.ts', milliseconds: 500 }],
  projectHotspots: [{ file: 'big.ts', milliseconds: 500 }], typeHotspots: [], warnings: ['A note.'] });
const chain = (n, share) => ({ rule: 'source-check-chain', confidence: 'measured', title: `chain ${n}`, suggestion: 's',
  evidence: { file: `c${n}.ts`, line: n, character: 2, milliseconds: 50, checkTimeShareUpperBoundPercent: share, comparisons: [] } });

test('compact output shows at most three actions and one summary line; --verbose keeps the full report', () => {
  const full = report([1, 2, 3, 4].map(n => diagnosis(n)), [chain(1, 9)]);
  const compact = renderReport(full);
  assert.equal([...compact.matchAll(/^\d\. \[measured\]/gm)].length, 3);
  assert.match(compact, /1\. \[measured\] Diagnosis 1\n {3}Where: f1\.ts:1:1\n {3}Summary 1\.\n {3}Fix: Remedy 1\.\n/);
  assert.match(compact, /Docs: https:\/\/example\.test\/docs/);
  assert.match(compact, /Check 2\.00s · Total 3\.00s · 12 files · 1 finding in the full report\. Use --verbose to see them\.\n$/);
  assert.doesNotMatch(compact, /Largest recorded|Note: A note|Fresh cache/);
  const verbose = renderReport(full, false, { verbose: true });
  assert.match(verbose, /4 diagnoses/);
  assert.match(verbose, /Detail 4\./);
  assert.match(verbose, /Largest recorded project file-check intervals/);
  assert.match(verbose, /Note: A note/);
});

test('compact output fills free slots with measured chains above 3% of Check time and skips smaller ones', () => {
  const text = renderReport(report([diagnosis(1)], [chain(1, 12), chain(2, 2.9), chain(3, 3)]));
  assert.match(text, /2\. \[measured\] Slow check, no known pattern: c1\.ts:1:2/);
  assert.match(text, /3\. \[measured\] Slow check, no known pattern: c3\.ts:3:2/);
  assert.doesNotMatch(text, /c2\.ts/);
});

test('compact output without a diagnosis says so and makes no promise about speed', () => {
  const text = renderReport(report([]));
  assert.match(text, /No known slow pattern matched/);
  assert.match(text, /does not establish that the project is fast/);
});

test('a report without a diagnoses field still renders (reports from older versions)', () => {
  const old = report([]); delete old.diagnoses;
  assert.match(renderReport(old), /No known slow pattern matched/);
  assert.doesNotMatch(renderReport(old, false, { verbose: true }), /diagnoses/);
});

test('the CLI documents --verbose and the compact default, and rejects nothing else new', () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'src/cli.js'), ...args], { encoding: 'utf8' });
  assert.match(run(['--help']).stdout, /--verbose\s+Print the full report/);
  assert.equal(run(['--version']).stdout.trim(), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});

test('the CLI prints the compact report by default and the full report with --verbose; JSON always has diagnoses', () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'src/cli.js'), '--project', path.join(root, 'examples/type-comparison'), '--no-color', ...args], { encoding: 'utf8' });
  const compact = run([]);
  assert.match(compact.stdout, /Use --verbose to see them\.\n$/);
  assert.doesNotMatch(compact.stdout, /Fresh cache|Largest recorded/);
  assert.ok(compact.stdout.split('\n').length < 12, 'the compact report stays short');
  const verbose = run(['--verbose']);
  assert.match(verbose.stdout, /Fresh cache · no emit · tracing enabled/);
  const json = JSON.parse(run(['--json']).stdout);
  assert.ok(Array.isArray(json.diagnoses), 'the diagnoses field exists, empty when no pattern matched');
  assert.equal(json.schemaVersion, 1);
  assert.ok(json.findings.length > 0 && json.hotspots && json.sourceGroups, 'the existing fields stay');
});

test('TypeScript 7 variance events: begin and end events, variances on the end event, nesting by stack', () => {
  const { events } = readFixture('ts7-variance.json', '/unused');
  const { variances } = collectSignals(events);
  assert.deepEqual(variances.map(v => v.id).sort((a, b) => a - b), [2120, 3187, 17156, 28298, 28319]);
  const byId = Object.fromEntries(variances.map(v => [v.id, v]));
  assert.deepEqual(byId[28319].variances, ['out', 'out']);
  assert.deepEqual(byId[3187].variances, ['out']);
  assert.deepEqual(byId[2120].variances, [], 'an end event with an empty list gives an empty list');
  assert.equal(byId[3187].arity, 1);
  assert.deepEqual(byId[3187].nested.map(n => n.id).sort((a, b) => a - b), [744, 3987, 6086], 'the three largest nested events of the outer one');
});
