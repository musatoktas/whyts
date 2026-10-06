import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { readProject, buildGraph } from '../src/analyze.js';

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

test('require() and dynamic import arguments do not crash graph building (TypeScript 6 needs parent pointers)', t => {
  // Under TypeScript 6 with module ESNext + bundler resolution, getModeForUsageLocation reads node.parent
  // of a require() argument; a program created without a compiler host that sets parents made it throw.
  const dir = fixture(t, { compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ES2022', noEmit: true, lib: ['ES2022'] }, files: ['main.ts'] }, {
    'main.ts': 'declare const require: any; const b = require("./b"); void import("./b"); export { b };',
    'b.ts': 'export const v = 1;'
  });
  const graph = buildGraph(ts, readProject(dir, ts));
  assert.deepEqual(graph.skipped, []);
  assert.ok(graph.edges.get(path.join(dir, 'main.ts')).has(path.join(dir, 'b.ts')));
  // The per-specifier guard would hide a missing parent pointer, so check the program itself.
  const source = graph.program.getSourceFile(path.join(dir, 'main.ts'));
  let argument;
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') argument = node.arguments[0];
    ts.forEachChild(node, visit);
  })(source);
  assert.ok(argument.parent, 'program sources carry parent pointers');
  assert.doesNotThrow(() => ts.getModeForUsageLocation(source, argument));
});

test('a failure inside one file is recorded and the rest of the program is still analyzed', t => {
  const dir = fixture(t, { compilerOptions: options, files: ['main.ts'] }, { 'main.ts': 'import "./b.js";', 'b.ts': 'export const b = 1;' });
  const project = readProject(dir, ts);
  // Mode lookup failure: the file keeps its edges using the default resolution mode.
  const modeFails = buildGraph({ ...ts, getModeForUsageLocation() { throw new Error('mode boom'); } }, project);
  assert.deepEqual(modeFails.skipped, []);
  assert.ok(modeFails.edges.get(path.join(dir, 'main.ts')).has(path.join(dir, 'b.ts')));
  // Traversal failure: files are listed as skipped instead of aborting the analysis.
  const traversalFails = buildGraph({ ...ts, isImportDeclaration() { throw new Error('visit boom'); } }, project);
  assert.ok(traversalFails.skipped.length > 0);
  assert.match(traversalFails.skipped[0].reason, /visit boom/);
  assert.equal(traversalFails.files.size, modeFails.files.size);
});

