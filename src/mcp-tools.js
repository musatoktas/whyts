// The tools of the whyts MCP server, without the MCP SDK. This file turns whyts results into compact JSON
// for an AI coding agent and runs one tool call at a time. It adds no analysis: every number comes from
// analyze(), compareProjects() and explain().
import path from 'node:path';
import { analyze, explain, toolVersion } from './analyze.js';
import { compareProjects } from './compare.js';

// Claude Code warns above 10,000 tokens per tool result and cuts off at 25,000 by default. A compact result
// stays far below both. The limit is in characters of JSON text.
export const MAX_RESULT_CHARS = 12000;
export const MAX_DIAGNOSES = 5;
export const MAX_FINDINGS = 5;
export const MAX_TEXT = 240;
export const PROGRESS_HEARTBEAT_MS = 15000;
export const DEFAULT_COMPARE_RUNS = 5;

const clip = (value, limit = MAX_TEXT) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
};
const at = location => location?.file ? `${location.file}${location.line ? `:${location.line}${location.character ? `:${location.character}` : ''}` : ''}` : null;
const round = (value, digits = 3) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
// whyts prints project paths relative to its working directory. An agent needs a path it can open.
const absolute = p => (p && !path.isAbsolute(p) ? path.resolve(process.cwd(), p) : p);
const stat = s => s ? { runs: s.runs, median: s.median, min: s.min, max: s.max, spreadPercent: s.spreadPercent } : null;

// ---- Compact results ----------------------------------------------------------------------------------

function compactDiagnosis(d, { full = true } = {}) {
  const lines = (d.evidence?.summary ?? d.evidence?.details ?? []).map(line => clip(line));
  return {
    pattern: d.pattern, confidence: d.confidence, title: clip(d.title),
    location: at(d.location) ?? at(d.evidence?.location),
    evidence: full ? lines.slice(0, 6) : lines.slice(0, 2),
    ...(d.checkTimeShareUpperBoundPercent != null ? { checkTimeShareUpperBoundPercent: d.checkTimeShareUpperBoundPercent } : {}),
    remedy: clip(d.remedy, 400), docs: d.docs
  };
}

function compactFinding(f, { full = true } = {}) {
  const e = f.evidence ?? {};
  const out = { rule: f.rule, confidence: f.confidence, title: clip(f.title), location: at(e),
    milliseconds: round(e.milliseconds, 1), checkTimeShareUpperBoundPercent: e.checkTimeShareUpperBoundPercent ?? null };
  if (full) {
    if (e.snippet) out.snippet = clip(e.snippet, 160);
    if (e.memberCount) out.sourceChecksInChain = e.memberCount;
    const comparisons = (e.comparisons ?? []).slice(0, 2).map(c => ({ milliseconds: round(c.milliseconds, 1), source: clip(c.source?.label, 100), target: clip(c.target?.label, 100) }));
    if (comparisons.length) out.typeComparisons = comparisons;
    out.suggestion = clip(f.suggestion, 300);
  }
  return out;
}

// How much of the report each step keeps. The first step that fits the character limit wins.
const STEPS = [
  { diagnoses: MAX_DIAGNOSES, findings: MAX_FINDINGS, structural: 5, warnings: 6, errors: 3, form: 'full' },
  { diagnoses: 3, findings: 3, structural: 2, warnings: 3, errors: 1, form: 'brief' },
  { diagnoses: 2, findings: 2, structural: 0, warnings: 2, errors: 1, form: 'short' },
  { diagnoses: 1, findings: 1, structural: 0, warnings: 1, errors: 0, form: 'short' },
  { diagnoses: 1, findings: 0, structural: 0, warnings: 0, errors: 0, form: 'short' }
];
const shortDiagnosis = d => ({ pattern: d.pattern, confidence: d.confidence, title: clip(d.title, 120), location: d.location, remedy: clip(d.remedy, 200) });
const shortFinding = f => ({ rule: f.rule, title: clip(f.title, 120), location: f.location, milliseconds: f.milliseconds });

// What an agent needs from a full whyts report. `truncated` says what was cut, or is false.
export function compactReport(report, { maxChars = MAX_RESULT_CHARS } = {}) {
  const timings = report.timings;
  const traced = report.diagnostics ?? {};
  const check = timings?.checkTime ? { seconds: timings.checkTime.median, source: `median of ${timings.runs} untraced runs`, ...stat(timings.checkTime) }
    : { seconds: traced['Check time']?.value ?? null, source: 'one traced run (tracing inflates it)' };
  const total = timings?.totalTime ? { seconds: timings.totalTime.median, source: `median of ${timings.runs} untraced runs` }
    : { seconds: traced['Total time']?.value ?? null, source: 'one traced run (tracing inflates it)' };
  const errors = report.compilerErrors ?? { total: 0, codes: [], first: [] };
  const measured = (report.findings ?? []).filter(f => f.confidence === 'measured');
  const structural = (report.findings ?? []).filter(f => f.confidence !== 'measured');
  const diagnoses = report.diagnoses ?? [];
  const build = (step, index) => {
    const out = {
      tool: 'whyts', toolVersion, mode: 'analyze', typescriptVersion: report.typescriptVersion, project: absolute(report.project),
      ...(report.compiler === 'native' ? { compiler: 'native (experimental)' } : {}),
      summary: { checkTime: check, totalTime: total, files: report.summary?.programFiles, compilerExitCode: report.summary?.compilerExitCode, errorCount: errors.total,
        comparableWithCompare: (errors.total ?? 0) === 0 },
      compilerErrors: errors.total ? { total: errors.total, codes: (errors.codes ?? []).slice(0, 5).map(c => `${c.code} x${c.count}`),
        first: (errors.first ?? []).slice(0, step.errors).map(e => ({ at: at(e), code: e.code, message: clip(e.message, 160) })),
        ...(errors.measurementMayBeInvalid ? { measurementMayBeInvalid: 'Most errors are unresolved modules. Dependencies may be missing, so timings may not represent a healthy build.' } : {}) } : null,
      diagnoses: diagnoses.slice(0, step.diagnoses).map(d => step.form === 'short' ? shortDiagnosis(compactDiagnosis(d)) : compactDiagnosis(d, { full: step.form === 'full' })),
      findings: measured.slice(0, step.findings).map(f => step.form === 'short' ? shortFinding(compactFinding(f, { full: false })) : compactFinding(f, { full: step.form === 'full' })),
      structuralFindings: structural.slice(0, step.structural).map(f => `${f.rule}: ${clip(f.title, 120)}`),
      warnings: (report.warnings ?? []).slice(0, step.warnings).map(w => clip(w, 220))
    };
    const omitted = { diagnoses: diagnoses.length - out.diagnoses.length, measuredFindings: measured.length - out.findings.length,
      structuralFindings: structural.length - out.structuralFindings.length, warnings: (report.warnings ?? []).length - out.warnings.length };
    const cut = Object.values(omitted).some(n => n > 0);
    out.truncated = !cut && index === 0 ? false : { reason: index === 0 ? `The result lists at most ${MAX_DIAGNOSES} diagnoses, ${MAX_FINDINGS} measured findings and 5 structural findings.` : `The result was shortened to fit ${maxChars} characters.`,
      omitted, fullReport: 'Run `whyts --project <path> --json` for the complete report.' };
    return out;
  };
  let out;
  for (const [index, step] of STEPS.entries()) {
    out = build(step, index);
    if (JSON.stringify(out).length <= maxChars) break;
  }
  return out;
}

const sideSummary = side => ({ typescriptVersion: side.typescriptVersion, files: side.programFiles, compilerErrors: side.compilerErrors?.count ?? 0, project: absolute(side.project) });

function rationale(result) {
  const m = result.checkTime;
  if (!result.comparable) return result.reason;
  const n = `${result.runs ?? '?'} runs per side`;
  if (m.verdict === 'separated') return `Every run of the ${m.direction === 'faster' ? 'candidate was faster' : 'candidate was slower'} than every baseline run (${n}; the min-max ranges do not overlap). The chance of this without a real difference is about ${m.rule?.chanceWithoutDifference ?? 'unknown'} if runs are independent.`;
  if (m.verdict === 'within-noise') return `The min-max ranges of the two sides overlap (${n}). The difference of the medians is within run-to-run noise. Do not claim a change.`;
  if (m.verdict === 'insufficient-runs') return `A verdict needs at least ${m.rule?.minimumRuns ?? 3} runs per side.`;
  return 'No verdict is available.';
}

// A compact comparison. `decision` is separated, within-noise or not-comparable.
export function compactComparison(result) {
  const m = result.checkTime, t = result.totalTime;
  const decision = result.comparable ? (m.verdict === 'separated' || m.verdict === 'within-noise' ? m.verdict : m.verdict) : 'not-comparable';
  const metric = x => ({ baseline: stat(x.baseline), candidate: stat(x.candidate), deltaMilliseconds: x.deltaMilliseconds, deltaPercent: x.deltaPercent, verdict: x.verdict, ...(x.direction ? { direction: x.direction } : {}) });
  return { tool: 'whyts', toolVersion, mode: 'compare', decision, ...(result.comparable && m.direction ? { direction: m.direction } : {}),
    rationale: clip(rationale(result), 500), runsPerSide: result.runs ?? null, order: result.order ?? null,
    checkTime: metric(m), totalTime: metric(t),
    baseline: sideSummary(result.baseline), candidate: sideSummary(result.candidate),
    warnings: (result.warnings ?? []).map(w => clip(w, 260)).slice(0, 6), truncated: false };
}

export function compactExplanation(result) {
  const chain = result.chain ?? [], importers = result.importedBy ?? [];
  const cut = { chain: Math.max(0, chain.length - 30), importedBy: Math.max(0, importers.length - 20) };
  return { tool: 'whyts', toolVersion, mode: 'explain', file: result.file, configuredRoot: result.configuredRoot,
    importChain: chain.length > 30 ? [...chain.slice(0, 15), '...', ...chain.slice(-14)] : chain,
    directImporters: importers.slice(0, 20), directImporterCount: importers.length, note: result.note,
    truncated: cut.chain || cut.importedBy ? { reason: 'Long lists are shortened.', omitted: cut } : false };
}

// ---- Errors -------------------------------------------------------------------------------------------

// Sort an error of the engine into a kind that an agent can act on.
export function describeError(error) {
  const message = clip(error?.message ?? error, 1500);
  const rule = [
    [/^Project not found|No tsconfig\.json found|--typescript path not found|^explain requires/, 'not-found', 'Check the path. Pass an absolute path to a directory with a tsconfig.json, or to a tsconfig file.'],
    [/is unsupported\. Use TypeScript|must be a typescript package directory|bundled TypeScript 5\.x|not a 5\.x or 6\.x|Could not load the TypeScript compiler/, 'typescript-unsupported', 'whyts supports TypeScript 5.x, 6.x and 7.x. Install a supported typescript in the project, or pass `typescript` with the path to a typescript package.'],
    [/exceeded \d+(?:\.\d+)?s|Type checking exceeded/, 'timeout', 'Raise `timeoutSeconds`. Large projects can need minutes. The MCP client may have its own tool timeout.'],
    [/Analysis cancelled/, 'cancelled', 'The request was cancelled.'],
    [/cannot be compared|not comparable/i, 'not-comparable', 'The two sides use different compilers, flags or checker counts. Use the same TypeScript for both.'],
    [/File is not in this TypeScript program/, 'not-in-program', 'The file must be part of the TypeScript program. Pass a path relative to the tsconfig directory.'],
    [/Compiler terminated by|ran out of JavaScript heap|Compiler produced no/, 'compiler-failed', 'The compiler crashed or gave no timing. See the message.'],
    [/solution config|reads the tsconfig|tsconfig|error TS\d+/i, 'invalid-project', 'Fix the tsconfig, or choose a leaf project that holds source files.']
  ].find(([pattern]) => pattern.test(String(error?.message ?? error)));
  return { kind: rule ? rule[1] : 'internal', message, hint: rule ? rule[2] : 'This is an unexpected failure of whyts.' };
}

// ---- Running ------------------------------------------------------------------------------------------

const defaultEngine = { analyze, explain, compareProjects };

// A tool call needs the whole machine: two parallel type checks would distort each other's timings.
// Calls therefore wait in line.
let queue = Promise.resolve();
let running = 0;

// The compiler child process of the engine stops on SIGTERM. The engine adds that listener only while a
// compiler runs, and one call runs at a time, so this stops exactly the running call.
export function stopRunningCompiler() { process.emit('SIGTERM'); }

// Progress must grow with every notification. A value that does not grow is dropped.
function makeReporter(progress) {
  let last = -1;
  return (message, explicit = {}) => {
    if (!progress) return;
    const value = explicit.progress ?? Math.floor(last) + 1;
    if (!(value > last)) return;
    last = value;
    Promise.resolve(progress({ progress: value, ...(explicit.total ? { total: explicit.total } : {}), message })).catch(() => {});
  };
}

// Run one tool. `args` are validated by the MCP layer. `hooks.progress` takes { progress, total?, message }.
export async function runTool(name, args, hooks = {}, engine = defaultEngine) {
  const ahead = running;
  running += 1;
  const turn = queue;
  let release;
  queue = new Promise(resolve => { release = resolve; });
  const started = Date.now();
  let heartbeat = null, active = false, cancelled = false;
  const onAbort = () => { cancelled = true; if (active) stopRunningCompiler(); };
  hooks.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const report = makeReporter(hooks.progress);
    if (ahead) report(`Waiting for ${ahead} earlier whyts call${ahead === 1 ? '' : 's'}. Calls run one at a time so that timings stay valid.`);
    await turn;
    if (cancelled || hooks.signal?.aborted) throw new Error('Analysis cancelled.');
    active = true;
    const seconds = () => Math.round((Date.now() - started) / 1000);
    const ms = args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined;
    let data;
    if (name === 'analyze') {
      const runs = args.runs ?? 1;
      let phase = 'traced check';
      report(`Started: traced type check${runs > 1 ? `, then ${runs} untraced timing runs` : ''}.`);
      heartbeat = setInterval(() => report(`Still running (${phase}, ${seconds()}s).`), hooks.heartbeatMs ?? PROGRESS_HEARTBEAT_MS);
      const options = { project: args.project, typescript: args.typescript, timeoutMs: ms, runs, maxOldSpaceMb: args.maxOldSpaceMb,
        onRun: ({ run, runs: all }) => { if (cancelled) throw new Error('Analysis cancelled.'); phase = `timing run ${run} of ${all}`; report(`Timing run ${run} of ${all}.`); } };
      data = compactReport(await engine.analyze(options), { maxChars: hooks.maxChars });
    } else if (name === 'compare') {
      const runs = args.runs ?? DEFAULT_COMPARE_RUNS;
      let step = 0, steps = 0, beats = 0;
      heartbeat = setInterval(() => {
        beats += 1;
        // Stay below the next whole step while a run is in progress.
        if (steps) report(`Still running (${seconds()}s).`, { progress: step - 1 + 0.9 * (1 - 1 / (1 + beats)), total: steps });
      }, hooks.heartbeatMs ?? PROGRESS_HEARTBEAT_MS);
      const options = { baseline: args.baseline, candidate: args.candidate, runs, typescript: args.typescript, timeoutMs: ms, maxOldSpaceMb: args.maxOldSpaceMb,
        onRun: ({ step: s, steps: n, side, warmup }) => { if (cancelled) throw new Error('Analysis cancelled.'); step = s; steps = n; beats = 0; report(`Timing run ${s} of ${n} (${side}${warmup ? ', warm-up' : ''}).`, { progress: s - 1, total: n }); } };
      data = compactComparison(await engine.compareProjects(options));
    } else if (name === 'explain') {
      report('Reading the import graph.');
      data = compactExplanation(engine.explain({ project: args.project, file: args.file, typescript: args.typescript }));
    } else throw new Error(`Unknown tool: ${name}`);
    data.elapsedSeconds = round((Date.now() - started) / 1000, 1);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    hooks.signal?.removeEventListener('abort', onAbort);
    running -= 1;
    release();
  }
}

export const toText = value => JSON.stringify(value);
