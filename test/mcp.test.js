// Tests for the MCP server: the compact results, the error paths, and a raw stdio client against `whyts mcp`.
// The raw client speaks newline-delimited JSON-RPC, so the tests do not depend on an MCP client library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { compactReport, compactComparison, compactExplanation, describeError, runTool, MAX_RESULT_CHARS } from '../src/mcp-tools.js';
import { compareReports } from '../src/compare.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'src/cli.js');
const realCompiler = createRequire(import.meta.url).resolve('typescript');
const sdk = await import('@modelcontextprotocol/server').then(() => true, () => false);
const needsSdk = { skip: sdk ? false : 'the optional MCP dependencies are not installed' };

function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function project(t, files = { 'main.ts': 'export const x: number = 1;\n' }) {
  const dir = temp(t, 'whyts-mcp-');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, files: ['main.ts'] }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
// A typescript package with the real compiler API and a scripted tsc.js: run n prints the n-th Check time of times.json.
function scriptedCompiler(t) {
  const dir = temp(t, 'whyts-mcp-ts-');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/typescript.js'), `module.exports = require(${JSON.stringify(realCompiler)});`);
  fs.writeFileSync(path.join(dir, 'lib/tsc.js'), `const fs = require('fs'), path = require('path');
const { times, errors, delay } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'times.json'), 'utf8'));
fs.writeFileSync(path.join(process.cwd(), 'pid.txt'), String(process.pid));
const counter = path.join(process.cwd(), 'count.txt');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const check = times[n % times.length];
setTimeout(() => {
  if (errors) process.stdout.write('main.ts(1,1): error ' + errors + ': scripted\\n');
  process.stdout.write('Files: 3\\nCheck time: ' + check.toFixed(2) + 's\\nTotal time: ' + (check + 0.5).toFixed(2) + 's\\n');
  if (errors) process.exitCode = 2;
}, delay || 0);
`);
  return dir;
}
function scriptedProject(t, times, errors = null, delay = 0) {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify({ times, errors, delay }));
  return dir;
}

class Client {
  constructor(t, args = [], env = {}) {
    this.child = spawn(process.execPath, [cli, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.next = 1; this.pending = new Map(); this.notifications = []; this.stderr = ''; this.buffer = '';
    this.exited = new Promise(resolve => this.child.on('close', (code, signal) => resolve({ code, signal })));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line); // Every stdout line must be JSON-RPC.
        if (message.id !== undefined && this.pending.has(message.id)) { this.pending.get(message.id)(message); this.pending.delete(message.id); }
        else this.notifications.push(message);
      }
    });
    t.after(() => { this.child.kill('SIGKILL'); });
  }
  send(message) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params, timeoutMs = 120000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${method} in ${timeoutMs} ms. stderr: ${this.stderr}`)), timeoutMs);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.send({ id, method, params });
    });
  }
  async start() {
    const init = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'whyts-test', version: '0' } });
    this.send({ method: 'notifications/initialized' });
    return init.result;
  }
  async call(name, args, extra = {}) {
    const response = await this.request('tools/call', { name, arguments: args, ...extra });
    assert.ok(response.result, JSON.stringify(response));
    const text = response.result.content[0].text;
    return { isError: !!response.result.isError, text, json: JSON.parse(text) };
  }
}

// ---- Compact results (no SDK needed) -------------------------------------------------------------------

const diagnosis = n => ({ pattern: 'recursive-type-instantiation', confidence: 'measured', title: `Recursive type instantiation ${n} ${'x'.repeat(400)}`,
  location: { file: 'src/a.ts', line: 3, character: 5 }, evidence: { summary: Array.from({ length: 10 }, (_, i) => `line ${i} ${'y'.repeat(500)}`) },
  checkTimeShareUpperBoundPercent: 12, remedy: `Stop the expansion. ${'z'.repeat(800)}`, docs: 'https://example.test/docs' });
const chain = n => ({ rule: 'source-check-chain', confidence: 'measured', title: `chain ${n}`, suggestion: 'Inspect it.', evidence: { file: `f${n}.ts`, line: n, character: 1, milliseconds: 100 - n,
  checkTimeShareUpperBoundPercent: 5, snippet: 'const a = b', memberCount: 2, members: new Array(400).fill({ x: 1 }), comparisons: [{ milliseconds: 3, source: { label: 'A' }, target: { label: 'B' } }] } });
const report = (extra = {}) => ({ schemaVersion: 1, toolVersion: '0.8.0', typescriptVersion: '5.9.3', project: 'tsconfig.json',
  summary: { programFiles: 12, compilerExitCode: 0, errorCount: 0 }, diagnostics: { 'Check time': { value: 1.5 }, 'Total time': { value: 2.5 } },
  compilerErrors: { total: 0, first: [], codes: [] }, findings: [], diagnoses: [], warnings: ['Tracing adds overhead.'], ...extra });

test('compact analyze result has the agreed shape', () => {
  const out = compactReport(report({ diagnoses: [diagnosis(1)], findings: [chain(1), { rule: 'broad-include', confidence: 'review', title: 'broad', evidence: {}, suggestion: 's' }] }));
  assert.deepEqual(Object.keys(out), ['tool', 'toolVersion', 'mode', 'typescriptVersion', 'project', 'summary', 'compilerErrors', 'diagnoses', 'findings', 'structuralFindings', 'warnings', 'truncated']);
  assert.equal(out.summary.checkTime.seconds, 1.5);
  assert.match(out.summary.checkTime.source, /traced/);
  assert.equal(out.summary.comparableWithCompare, true);
  assert.equal(out.diagnoses[0].pattern, 'recursive-type-instantiation');
  assert.equal(out.diagnoses[0].location, 'src/a.ts:3:5');
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].location, 'f1.ts:1:1');
  assert.deepEqual(out.structuralFindings, ['broad-include: broad']);
  assert.equal('members' in out.findings[0], false);
  assert.ok(JSON.stringify(out).length < MAX_RESULT_CHARS);
});

test('compact analyze result keeps at most 5 diagnoses and 5 measured findings and says so', () => {
  const out = compactReport(report({ diagnoses: [1, 2, 3, 4, 5, 6, 7].map(diagnosis), findings: [1, 2, 3, 4, 5, 6, 7, 8].map(chain) }));
  assert.ok(out.diagnoses.length <= 5);
  assert.ok(out.findings.length <= 5);
  assert.ok(out.truncated);
  assert.ok(out.truncated.omitted.measuredFindings >= 3);
  assert.match(out.truncated.fullReport, /--json/);
  assert.ok(JSON.stringify(out).length <= MAX_RESULT_CHARS, `${JSON.stringify(out).length} characters`);
});

test('compact analyze result keeps exactly 5 diagnoses and 5 measured findings when they are small', () => {
  const small = n => ({ ...diagnosis(n), title: `d${n}`, evidence: { summary: ['one'] }, remedy: 'Fix it.' });
  const tiny = n => ({ ...chain(n), evidence: { file: `f${n}.ts`, line: n, character: 1, milliseconds: 20 } });
  const out = compactReport(report({ diagnoses: [1, 2, 3, 4, 5, 6, 7].map(small), findings: [1, 2, 3, 4, 5, 6, 7, 8].map(tiny) }));
  assert.equal(out.diagnoses.length, 5);
  assert.equal(out.findings.length, 5);
  assert.deepEqual(out.truncated.omitted.diagnoses, 2);
  assert.deepEqual(out.truncated.omitted.measuredFindings, 3);
  assert.match(out.truncated.reason, /at most 5 diagnoses/);
});

test('compact analyze result shrinks to the character limit and reports the cut', () => {
  const big = report({ diagnoses: [1, 2, 3, 4, 5].map(diagnosis), findings: [1, 2, 3, 4, 5].map(chain), warnings: new Array(20).fill('w'.repeat(400)) });
  for (const maxChars of [6000, 3000, 1800]) {
    const out = compactReport(big, { maxChars });
    assert.ok(JSON.stringify(out).length <= maxChars, `limit ${maxChars}: ${JSON.stringify(out).length}`);
    assert.ok(out.truncated, `limit ${maxChars}`);
  }
});

test('compact analyze result shows compiler errors and blocks comparison', () => {
  const out = compactReport(report({ summary: { programFiles: 3, compilerExitCode: 2, errorCount: 4 },
    compilerErrors: { total: 4, codes: [{ code: 'TS2307', count: 4 }], first: [{ file: 'a.ts', line: 1, character: 2, code: 'TS2307', message: 'Cannot find module' }], missingDependencyErrors: 4, measurementMayBeInvalid: true } }));
  assert.equal(out.summary.comparableWithCompare, false);
  assert.equal(out.compilerErrors.total, 4);
  assert.deepEqual(out.compilerErrors.codes, ['TS2307 x4']);
  assert.equal(out.compilerErrors.first[0].at, 'a.ts:1:2');
  assert.ok(out.compilerErrors.measurementMayBeInvalid);
});

test('compact analyze result prefers the median of untraced runs', () => {
  const timings = { runs: 3, checkTime: { runs: 3, median: 0.9, min: 0.8, max: 1, spreadPercent: 22.2 }, totalTime: { runs: 3, median: 1.4, min: 1, max: 2, spreadPercent: 10 } };
  const out = compactReport(report({ timings }));
  assert.equal(out.summary.checkTime.seconds, 0.9);
  assert.match(out.summary.checkTime.source, /median of 3 untraced runs/);
  assert.equal(out.summary.checkTime.min, 0.8);
});

const sideReport = (values, errors = 0) => ({ schemaVersion: 1, toolVersion: '0.8.0', typescriptVersion: '5.9.3', project: 'tsconfig.json',
  summary: { programFiles: 3, compilerExitCode: errors ? 2 : 0, errorCount: errors }, diagnostics: { 'Check time': { value: values[0] }, 'Total time': { value: values[0] + 1 } },
  compilerErrors: { total: errors, codes: errors ? [{ code: 'TS2322', count: errors }] : [], first: [] },
  timings: { mode: 'm', runs: values.length, flags: ['f'], compilerFiles: 3, compilerExitCodes: values.map(() => (errors ? 2 : 0)),
    checkTime: { unit: 's', runs: values.length, values, median: values[1], min: Math.min(...values), max: Math.max(...values), spreadPercent: 1 },
    totalTime: { unit: 's', runs: values.length, values, median: values[1], min: Math.min(...values), max: Math.max(...values), spreadPercent: 1 } },
  findings: [], sourceGroups: [], hotspots: [], projectHotspots: [], warnings: [] });

test('compact comparison decides separated, within-noise and not-comparable', () => {
  const separated = compactComparison(compareReports(sideReport([2.0, 2.1, 2.2]), sideReport([1.0, 1.1, 1.2])));
  assert.equal(separated.decision, 'separated');
  assert.equal(separated.direction, 'faster');
  assert.match(separated.rationale, /faster/);
  assert.match(separated.rationale, /do not overlap/);
  assert.ok(separated.checkTime.deltaMilliseconds < 0);
  const noise = compactComparison(compareReports(sideReport([1.0, 1.1, 1.2]), sideReport([1.05, 1.15, 1.25])));
  assert.equal(noise.decision, 'within-noise');
  assert.match(noise.rationale, /overlap/);
  assert.equal('direction' in noise, false);
  const blocked = compactComparison(compareReports(sideReport([1.0, 1.1, 1.2]), sideReport([0.5, 0.6, 0.7], 2)));
  assert.equal(blocked.decision, 'not-comparable');
  assert.match(blocked.rationale, /compiler error/);
  assert.equal(blocked.candidate.compilerErrors, 2);
});

test('compact explanation shortens long chains and says so', () => {
  const out = compactExplanation({ file: 'z.ts', configuredRoot: false, chain: Array.from({ length: 60 }, (_, i) => `f${i}.ts`), importedBy: Array.from({ length: 30 }, (_, i) => `i${i}.ts`), note: null });
  assert.equal(out.importChain.length, 30);
  assert.equal(out.directImporters.length, 20);
  assert.equal(out.directImporterCount, 30);
  assert.deepEqual(out.truncated.omitted, { chain: 30, importedBy: 10 });
  assert.equal(compactExplanation({ file: 'a.ts', configuredRoot: true, chain: ['a.ts'], importedBy: [], note: null }).truncated, false);
});

test('errors are sorted into kinds with a hint', () => {
  const kind = message => describeError(new Error(message)).kind;
  assert.equal(kind('Project not found: /nope'), 'not-found');
  assert.equal(kind('No tsconfig.json found. Pass --project path/to/tsconfig.json.'), 'not-found');
  assert.equal(kind('TypeScript 4.9.0 is unsupported. Use TypeScript 5.x, 6.x or 7.x; point to another compiler with --typescript <path>.'), 'typescript-unsupported');
  assert.equal(kind('Type checking exceeded 0.05s. tsc writes a trace'), 'timeout');
  assert.equal(kind('Analysis cancelled.'), 'cancelled');
  assert.equal(kind('These two sides cannot be compared.\n  x'), 'not-comparable');
  assert.equal(kind('File is not in this TypeScript program: x.ts'), 'not-in-program');
  assert.equal(kind('something odd'), 'internal');
  assert.ok(describeError(new Error('Project not found: x')).hint.length > 10);
});

// ---- Running tools with a fake engine ---------------------------------------------------------------------

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('tool calls run one at a time', async () => {
  let active = 0, peak = 0;
  const engine = { analyze: async () => { active++; peak = Math.max(peak, active); await wait(30); active--; return report(); } };
  const results = await Promise.all([1, 2, 3].map(() => runTool('analyze', { project: 'p' }, {}, engine)));
  assert.equal(peak, 1);
  assert.ok(results.every(r => r.ok));
});

test('a failed call does not block the next call', async () => {
  const engine = { analyze: async () => { throw new Error('Project not found: /x'); }, explain: () => ({ file: 'a.ts', configuredRoot: true, chain: ['a.ts'], importedBy: [], note: null }) };
  const failed = await runTool('analyze', { project: '/x' }, {}, engine);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.kind, 'not-found');
  assert.equal((await runTool('explain', { project: 'p', file: 'a.ts' }, {}, engine)).ok, true);
});

test('progress values grow and compare reports a total', async () => {
  const seen = [];
  const engine = { compareProjects: async options => {
    for (let step = 1; step <= 4; step++) { options.onRun({ step, steps: 4, side: step % 2 ? 'baseline' : 'candidate', warmup: step < 3 }); await wait(25); }
    return compareReports(sideReport([2, 2.1, 2.2]), sideReport([1, 1.1, 1.2]));
  } };
  const result = await runTool('compare', { baseline: 'a', candidate: 'b' }, { progress: p => seen.push(p), heartbeatMs: 10 }, engine);
  assert.ok(result.ok);
  assert.ok(seen.length >= 4, `${seen.length} notifications`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].progress > seen[i - 1].progress, `${seen[i - 1].progress} then ${seen[i].progress}`);
  assert.ok(seen.every(p => p.total === 4 || p.total === undefined));
  assert.ok(seen.every(p => p.progress < 4));
});

test('analyze progress grows with a heartbeat while the engine works', async () => {
  const seen = [];
  const engine = { analyze: async () => { await wait(120); return report(); } };
  await runTool('analyze', { project: 'p' }, { progress: p => seen.push(p), heartbeatMs: 20 }, engine);
  assert.ok(seen.length >= 3, `${seen.length} notifications`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].progress > seen[i - 1].progress);
  assert.ok(seen.every(p => typeof p.message === 'string' && p.message.length));
});

test('a cancelled running call stops the compiler, and a cancelled waiting call does not', async () => {
  let stops = 0;
  const spy = () => { stops++; };
  process.on('SIGTERM', spy);
  try {
    let finish;
    const engine = { analyze: () => new Promise(resolve => { finish = () => resolve(report()); }) };
    const first = new AbortController(), second = new AbortController();
    const running = runTool('analyze', { project: 'p' }, { signal: first.signal }, engine);
    await wait(10);
    const waiting = runTool('analyze', { project: 'q' }, { signal: second.signal }, engine);
    second.abort();
    await wait(10);
    assert.equal(stops, 0, 'a waiting call must not stop the running compiler');
    first.abort();
    assert.equal(stops, 1);
    finish();
    await running;
    const late = await waiting;
    assert.equal(late.ok, false);
    assert.equal(late.error.kind, 'cancelled');
  } finally { process.off('SIGTERM', spy); }
});

// ---- The server over stdio ----------------------------------------------------------------------------------

test('whyts mcp lists three tools with schemas and clear descriptions', needsSdk, async t => {
  const client = new Client(t);
  const init = await client.start();
  assert.equal(init.serverInfo.name, 'whyts');
  assert.match(init.instructions, /compare/);
  const { result } = await client.request('tools/list', {});
  assert.deepEqual(result.tools.map(x => x.name).sort(), ['analyze', 'compare', 'explain']);
  const by = Object.fromEntries(result.tools.map(x => [x.name, x]));
  assert.deepEqual(by.analyze.inputSchema.required, ['project']);
  assert.deepEqual(by.compare.inputSchema.required.sort(), ['baseline', 'candidate']);
  assert.deepEqual(by.explain.inputSchema.required.sort(), ['file', 'project']);
  assert.deepEqual(Object.keys(by.analyze.inputSchema.properties).sort(), ['maxOldSpaceMb', 'project', 'runs', 'timeoutSeconds', 'typescript']);
  assert.equal(by.compare.inputSchema.properties.runs.minimum, 3);
  assert.match(by.analyze.description, /as long as a full type check/);
  assert.match(by.compare.description, /\(2 x runs \+ 2\) type checks/);
  assert.match(by.explain.description, /does not run the type checker/);
  for (const tool of result.tools) assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(client.stderr.includes('ready on stdio'), true);
});

test('whyts mcp rejects input that does not match the schema', needsSdk, async t => {
  const client = new Client(t);
  await client.start();
  const response = await client.request('tools/call', { name: 'analyze', arguments: { runs: 0 } });
  const failed = response.error ?? (response.result?.isError ? response.result : null);
  assert.ok(failed, JSON.stringify(response));
  const compare = await client.request('tools/call', { name: 'compare', arguments: { baseline: 'a', candidate: 'b', runs: 2 } });
  assert.ok(compare.error || compare.result?.isError, JSON.stringify(compare));
});

test('analyze over stdio returns compact JSON and progress notifications', needsSdk, async t => {
  const dir = project(t);
  const client = new Client(t);
  await client.start();
  const out = await client.call('analyze', { project: dir, runs: 2 }, { _meta: { progressToken: 'tok-1' } });
  assert.equal(out.isError, false);
  assert.ok(out.text.length < MAX_RESULT_CHARS, `${out.text.length} characters`);
  assert.equal(out.json.mode, 'analyze');
  assert.equal(path.isAbsolute(out.json.project), true, out.json.project);
  assert.equal(out.json.summary.errorCount, 0);
  assert.equal(out.json.summary.files > 0, true);
  assert.match(out.json.summary.checkTime.source, /median of 2 untraced runs/);
  assert.ok(Array.isArray(out.json.diagnoses));
  assert.ok(Array.isArray(out.json.warnings));
  assert.ok('truncated' in out.json);
  const progress = client.notifications.filter(n => n.method === 'notifications/progress' && n.params.progressToken === 'tok-1');
  assert.ok(progress.length >= 2, `${progress.length} progress notifications`);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].params.progress > progress[i - 1].params.progress);
});

test('analyze sends no progress notification without a progress token', needsSdk, async t => {
  const client = new Client(t);
  await client.start();
  await client.call('analyze', { project: project(t) });
  assert.equal(client.notifications.filter(n => n.method === 'notifications/progress').length, 0);
});

test('error paths over stdio: missing project, unsupported TypeScript, timeout', needsSdk, async t => {
  const client = new Client(t);
  await client.start();
  const missing = await client.call('analyze', { project: path.join(os.tmpdir(), 'whyts-mcp-does-not-exist') });
  assert.equal(missing.isError, true);
  assert.equal(missing.json.error.kind, 'not-found');
  const old = temp(t, 'whyts-mcp-old-ts-');
  fs.mkdirSync(path.join(old, 'lib'));
  fs.writeFileSync(path.join(old, 'lib/typescript.js'), "module.exports = { version: '4.9.5', createProgram() {} };");
  const unsupported = await client.call('analyze', { project: project(t), typescript: old });
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.json.error.kind, 'typescript-unsupported');
  assert.match(unsupported.json.error.message, /4\.9\.5/);
  const slow = await client.call('analyze', { project: project(t), timeoutSeconds: 0.05 });
  assert.equal(slow.isError, true);
  assert.equal(slow.json.error.kind, 'timeout');
  // The server still works after errors.
  assert.equal((await client.call('analyze', { project: project(t) })).isError, false);
});

test('explain over stdio returns the import chain', needsSdk, async t => {
  const dir = project(t, { 'main.ts': "import { a } from './a.js';\nexport const x = a;\n", 'a.ts': 'export const a = 1;\n' });
  const client = new Client(t);
  await client.start();
  const out = await client.call('explain', { project: dir, file: 'a.ts' });
  assert.equal(out.isError, false);
  assert.equal(out.json.mode, 'explain');
  assert.equal(out.json.file, 'a.ts');
  const missing = await client.call('explain', { project: dir, file: 'nope.ts' });
  assert.equal(missing.json.error.kind, 'not-in-program');
});

test('compare over stdio separates a faster candidate and blocks a candidate with errors', needsSdk, async t => {
  const compiler = scriptedCompiler(t);
  const baseline = scriptedProject(t, [2.0, 2.1, 2.2]), fast = scriptedProject(t, [1.0, 1.1, 1.2]), broken = scriptedProject(t, [0.5, 0.6, 0.7], 'TS2322');
  const client = new Client(t);
  await client.start();
  const progressToken = 'cmp-1';
  const win = await client.call('compare', { baseline, candidate: fast, runs: 3, typescript: compiler }, { _meta: { progressToken } });
  assert.equal(win.isError, false);
  assert.equal(win.json.decision, 'separated');
  assert.equal(win.json.direction, 'faster');
  assert.equal(win.json.runsPerSide, 3);
  assert.ok(win.json.checkTime.deltaMilliseconds < 0);
  const progress = client.notifications.filter(n => n.method === 'notifications/progress' && n.params.progressToken === progressToken);
  assert.equal(progress.length >= 8, true, `${progress.length} progress notifications`);
  assert.ok(progress.every(n => n.params.total === 8));
  const blocked = await client.call('compare', { baseline, candidate: broken, runs: 3, typescript: compiler });
  assert.equal(blocked.json.decision, 'not-comparable');
  assert.match(blocked.json.rationale, /TS2322/);
});

test('whyts mcp stops a running compiler and exits when the client closes stdin', needsSdk, async t => {
  // The scripted compiler needs 60 s. Without the stop, its process would stay behind for that long.
  const slow = scriptedProject(t, [1], null, 60000);
  const client = new Client(t);
  await client.start();
  client.send({ id: 99, method: 'tools/call', params: { name: 'analyze', arguments: { project: slow, typescript: scriptedCompiler(t) } } });
  const pidFile = path.join(slow, 'pid.txt');
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await wait(100);
  const compilerPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(compilerPid, 0), 'the compiler runs before the client closes stdin');
  client.child.stdin.end();
  const result = await Promise.race([client.exited, wait(20000).then(() => 'hung')]);
  assert.notEqual(result, 'hung', 'the server did not exit within 20 seconds');
  await wait(300);
  assert.throws(() => process.kill(compilerPid, 0), { code: 'ESRCH' }, 'the compiler process stayed behind');
});

test('whyts mcp serves a 2026-07-28 client that sends no initialize handshake', needsSdk, async t => {
  const dir = project(t, { 'main.ts': "import { a } from './a.js';\nexport const x = a;\n", 'a.ts': 'export const a = 1;\n' });
  const client = new Client(t);
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'whyts-test', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const list = await client.request('tools/list', { _meta: envelope });
  assert.deepEqual(list.result.tools.map(x => x.name).sort(), ['analyze', 'compare', 'explain']);
  const call = await client.request('tools/call', { name: 'explain', arguments: { project: dir, file: 'a.ts' }, _meta: { ...envelope, progressToken: 'modern-1' } });
  assert.equal(call.result.isError ?? false, false, JSON.stringify(call));
  assert.equal(JSON.parse(call.result.content[0].text).file, 'a.ts');
  assert.equal(client.notifications.some(n => n.method === 'notifications/progress' && n.params.progressToken === 'modern-1'), true);
});

test('whyts mcp answers --help and refuses extra arguments', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args]); let out = '', err = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out, err }));
  });
  const help = await run(['mcp', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /whyts mcp/);
  const bad = await run(['mcp', '--project', 'x']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /mcp takes no arguments/);
});
