import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadCompiler, readProject, timedRun, timingFlags } from './analyze.js';
import { summarize, judge, runSchedule, diffEntries, TIMINGS_MODE } from './timing.js';

const require = createRequire(import.meta.url);
const toolVersion = require('../package.json').version;
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What decides whether two timing series can be compared. Errors stop the comparison. Warnings stay in the result.
// A side is { typescriptVersion, compiler: 'native' | 'javascript', checkers, flags, timingMode, programFiles, exitCodes, toolVersion }.
export function checkCompatibility(a, b) {
  const errors = [], warnings = [];
  if (a.compiler !== b.compiler) errors.push(`One side uses the ${a.compiler} compiler and the other uses the ${b.compiler} compiler (TypeScript ${a.typescriptVersion} and ${b.typescriptVersion}). Their timings are not comparable.`);
  if ((a.checkers ?? null) !== (b.checkers ?? null)) errors.push(`The checker count differs (${a.checkers ?? 'default'} and ${b.checkers ?? 'default'}). Their timings are not comparable.`);
  if (a.timingMode !== b.timingMode) errors.push(`The timing modes differ (${a.timingMode} and ${b.timingMode}). Timings from a traced run and an untraced run are not comparable.`);
  if (a.flags && b.flags && !sameList(a.flags, b.flags)) errors.push(`The compiler flags of the timing runs differ (${a.flags.join(' ')} and ${b.flags.join(' ')}).`);
  if (a.typescriptVersion !== b.typescriptVersion && a.compiler === b.compiler) warnings.push(`The TypeScript versions differ (${a.typescriptVersion} and ${b.typescriptVersion}). A difference in time can come from the compiler and not from the code.`);
  if (a.programFiles != null && b.programFiles != null && a.programFiles !== b.programFiles) warnings.push(`The programs have different file counts (${a.programFiles} and ${b.programFiles}). The two sides check different sets of files.`);
  if (a.toolVersion && b.toolVersion && a.toolVersion !== b.toolVersion) warnings.push(`The reports come from different whyts versions (${a.toolVersion} and ${b.toolVersion}). The timing procedure may differ.`);
  for (const [name, side] of [['baseline', a], ['candidate', b]]) {
    const failed = (side.exitCodes ?? []).filter(code => code !== 0).length;
    if (failed) warnings.push(`COMPILER ERRORS: ${failed} of ${side.exitCodes.length} compiler runs of the ${name} reported errors. Fix errors before you trust these timings.`);
  }
  return { errors, warnings };
}

function assemble(mode, a, b, extra = {}) {
  const compatibility = checkCompatibility(a, b);
  if (compatibility.errors.length) throw new Error(`These two sides cannot be compared.\n${compatibility.errors.map(e => `  ${e}`).join('\n')}`);
  const metric = key => ({ unit: 's', baseline: a[key], candidate: b[key], ...judge(a[key], b[key]) });
  const warnings = [...compatibility.warnings, ...(extra.warnings ?? [])];
  const strip = side => ({ typescriptVersion: side.typescriptVersion, compiler: side.compiler, checkers: side.checkers ?? null, project: side.project,
    programFiles: side.programFiles ?? null, flags: side.flags ?? null, timingMode: side.timingMode, compilerExitCodes: side.exitCodes ?? [] });
  return { schemaVersion: 1, kind: 'comparison', toolVersion, mode, baseline: strip(a), candidate: strip(b),
    checkTime: metric('checkTime'), totalTime: metric('totalTime'), ...extra.fields, warnings };
}

// ---- Offline: two whyts JSON reports -----------------------------------------------------------------

function checkReport(report, name) {
  if (!report || typeof report !== 'object' || report.kind === 'comparison' || !report.diagnostics || typeof report.diagnostics !== 'object' ||
    !report.toolVersion || !report.typescriptVersion || !report.summary) throw new Error(`The ${name} file is not a whyts report. Create it with: whyts --project <path> --json`);
  if (report.schemaVersion !== 1) throw new Error(`The ${name} report has schema version ${clean(report.schemaVersion)}. This whyts version reads schema version 1.`);
}

// A report made without --runs has one traced run. Its Check time is real but inflated by the trace, and it is a single value.
function reportSide(report) {
  const timings = report.timings;
  const native = report.compiler === 'native';
  const single = key => report.diagnostics[key]?.value;
  const one = key => single(key) === undefined ? null : summarize([single(key)]);
  return {
    typescriptVersion: String(report.typescriptVersion), compiler: native ? 'native' : 'javascript', checkers: report.checkers ?? null,
    project: clean(report.project ?? ''), programFiles: timings?.compilerFiles ?? report.summary.programFiles ?? null,
    flags: timings?.flags ?? null, timingMode: timings ? timings.mode : 'traced single run', toolVersion: String(report.toolVersion),
    exitCodes: timings ? timings.compilerExitCodes : [report.summary.compilerExitCode],
    checkTime: timings ? timings.checkTime : one('Check time'), totalTime: timings ? timings.totalTime : one('Total time')
  };
}

// Recorded entries of a report: source check chains and file check intervals, keyed by file and position.
function recordedEntries(report) {
  const entries = new Map();
  const add = (key, kind, item, location) => entries.set(key, { key, kind, file: clean(item.file), ...location, milliseconds: item.milliseconds });
  for (const h of [...(report.hotspots ?? []), ...(report.projectHotspots ?? [])]) add(`file|${h.file}`, 'file-check', h, {});
  for (const g of report.sourceGroups ?? []) add(`chain|${g.file}|${g.line}|${g.character}`, 'check-chain', g, { line: g.line, character: g.character });
  return entries;
}

function findingKeys(report) {
  const keys = new Set();
  for (const f of report.findings ?? []) {
    if (f.rule === 'source-check-chain') keys.add(`chain|${f.evidence.file}|${f.evidence.line}|${f.evidence.character}`);
    else if (f.rule === 'check-hotspot') keys.add(`file|${f.evidence.file}`);
  }
  return keys;
}

// A chain that is a finding on one side is compared with the same chain on the other side, even when the other
// side lists it below the finding threshold. An entry the other side does not record at all is new or gone.
export function diffFindings(baselineReport, candidateReport) {
  const a = recordedEntries(baselineReport), b = recordedEntries(candidateReport);
  const keys = new Set([...findingKeys(baselineReport), ...findingKeys(candidateReport)]);
  const pick = map => [...keys].map(k => map.get(k)).filter(Boolean);
  return diffEntries(pick(a), pick(b));
}

export function compareReports(baselineReport, candidateReport) {
  checkReport(baselineReport, 'baseline'); checkReport(candidateReport, 'candidate');
  const a = reportSide(baselineReport), b = reportSide(candidateReport);
  const warnings = [];
  if (!baselineReport.timings || !candidateReport.timings) warnings.push('At least one report has no `timings` field. whyts used the single Check time and Total time of the traced run. Tracing inflates both, and one value gives no verdict. Create the reports with --runs 5 or more.');
  const diff = diffFindings(baselineReport, candidateReport);
  const counts = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length]));
  return assemble('offline', a, b, { warnings, fields: { findings: { note: 'Chain and file intervals come from one traced run per report. They are samples, not stable measurements.', counts, ...diff } } });
}

export function readReportFile(file, name) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`Cannot read the ${name} report ${clean(file)}: ${clean(error.code ?? error.message)}`); }
  try { return JSON.parse(text); }
  catch { throw new Error(`The ${name} report ${clean(file)} is not valid JSON.`); }
}

// ---- Live: two projects ------------------------------------------------------------------------------

function prepareSide(input, typescript) {
  const project = path.resolve(input);
  const base = fs.existsSync(project) && fs.statSync(project).isDirectory() ? project : path.dirname(project);
  const compiler = loadCompiler(base, typescript);
  return { input: project, compiler, project: readProject(project, compiler.ts, { native: !!compiler.native }) };
}

// Compiler options of the two tsconfig files after parsing. Paths below the project directory compare as relative paths.
const ignoredOptions = new Set(['configFilePath', 'pathsBasePath', 'tsBuildInfoFile', 'generateTrace', 'generateCpuProfile']);
export function optionDifferences(a, b) {
  const normalize = ({ project }) => {
    const out = {};
    for (const [key, value] of Object.entries(project.parsed.options)) {
      if (ignoredOptions.has(key)) continue;
      out[key] = JSON.stringify(value, (_k, v) => typeof v === 'string' && path.isAbsolute(v) ? (path.relative(project.base, v) || '.') : v);
    }
    return out;
  };
  const x = normalize(a), y = normalize(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => x[k] !== y[k]).sort();
}

export async function compareProjects(options) {
  const { baseline: baselineInput, candidate: candidateInput, runs = 5 } = options;
  const sides = { baseline: prepareSide(baselineInput, options.typescript), candidate: prepareSide(candidateInput, options.typescript) };
  const describe = (side, name) => ({ typescriptVersion: String(side.compiler.native?.version ?? side.compiler.ts.version),
    compiler: side.compiler.native ? 'native' : 'javascript', checkers: side.compiler.native ? 1 : null, project: clean(path.relative(process.cwd(), side.project.configPath) || name),
    flags: timingFlags(side.compiler, options.maxOldSpaceMb), timingMode: TIMINGS_MODE });
  const described = { baseline: describe(sides.baseline, 'baseline'), candidate: describe(sides.candidate, 'candidate') };
  // Stop before the first run when the sides cannot be compared.
  const early = checkCompatibility(described.baseline, described.candidate);
  if (early.errors.length) throw new Error(`These two sides cannot be compared.\n${early.errors.map(e => `  ${e}`).join('\n')}`);
  const schedule = runSchedule(runs);
  const measured = { baseline: [], candidate: [] }, warmup = {};
  for (const [index, step] of schedule.entries()) {
    options.onRun?.({ step: index + 1, steps: schedule.length, side: step.side, warmup: step.warmup });
    const side = sides[step.side];
    const result = await timedRun(side.project, side.compiler, { timeoutMs: options.timeoutMs, maxOldSpaceMb: options.maxOldSpaceMb });
    if (step.warmup) warmup[step.side] = result; else measured[step.side].push(result);
  }
  const side = name => ({ ...described[name], programFiles: measured[name][0]?.files ?? null, exitCodes: measured[name].map(r => r.exitCode),
    checkTime: summarize(measured[name].map(r => r.checkSeconds)), totalTime: summarize(measured[name].map(r => r.totalSeconds)) });
  const warnings = [];
  const different = optionDifferences(sides.baseline, sides.candidate);
  if (different.length) warnings.push(`The two tsconfig files have different compiler options (${different.slice(0, 8).map(clean).join(', ')}${different.length > 8 ? ', ...' : ''}). A difference in time can come from these options.`);
  for (const name of ['baseline', 'candidate']) if (measured[name].some(r => r.measurementMayBeInvalid)) warnings.push(`Unresolved modules dominate the errors of the ${name} runs. Dependencies may be missing or not built, so these timings may not represent a healthy build.`);
  if (described.baseline.compiler === 'native') warnings.push('Timing runs used one checker (`--checkers 1`). Do not compare these timings with a default parallel `tsc` run.');
  const result = assemble('live', side('baseline'), side('candidate'), { warnings, fields: {
    runs, order: schedule.filter(s => !s.warmup).map(s => (s.side === 'baseline' ? 'A' : 'B')).join(''),
    warmup: Object.fromEntries(Object.entries(warmup).map(([k, r]) => [k, { checkTime: r.checkSeconds, totalTime: r.totalSeconds, compilerExitCode: r.exitCode }])),
    measuredRuns: Object.fromEntries(Object.entries(measured).map(([k, list]) => [k, list.map(r => ({ checkTime: r.checkSeconds, totalTime: r.totalSeconds, compilerExitCode: r.exitCode }))])) } });
  return result;
}
