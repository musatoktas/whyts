import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { traceDetails, selectedTypeIds, resolveTraceTypes } from './trace.js';
import { readTypeDescriptors } from './types.js';
export { traceHotspots } from './trace.js';

const require = createRequire(import.meta.url);
export const toolVersion = require('../package.json').version;
const slash = p => p.split(path.sep).join('/');
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const display = (base, p) => clean(slash(path.relative(base, p)) || '.');
const errorSummary = error => clean(String(error?.message ?? error).split('\n')[0].trim().slice(0, 200)) || 'unknown error';

// Resolve an explicit --typescript value to the package's lib/typescript.js.
function explicitCompilerPath(value) {
  const target = path.resolve(value);
  if (!fs.existsSync(target)) throw new Error(`--typescript path not found: ${clean(target)}`);
  const candidates = fs.statSync(target).isDirectory()
    ? [path.join(target, 'lib', 'typescript.js'), path.join(target, 'typescript.js')]
    : [target];
  const found = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile() && path.basename(file) === 'typescript.js');
  if (!found) {
    let version;
    try { version = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version; } catch { /* Not a package directory. */ }
    // TypeScript 7 ships a native compiler and no lib/typescript.js JavaScript API.
    if (Number(String(version).split('.')[0]) >= 7) throw new Error(`TypeScript ${clean(version)} is unsupported. It ships a native compiler without the JavaScript API (lib/typescript.js) whyts uses. Point --typescript at a TypeScript 5.x or 6.x package.`);
    throw new Error(`--typescript must be a typescript package directory or its lib/typescript.js: ${clean(target)}`);
  }
  return found;
}

export function loadCompiler(base, explicit) {
  let compilerPath;
  if (explicit) compilerPath = explicitCompilerPath(explicit);
  else {
    try { compilerPath = createRequire(path.join(base, 'package.json')).resolve('typescript'); }
    catch { compilerPath = require.resolve('typescript'); }
  }
  let ts;
  try { ts = require(compilerPath); }
  catch (error) { throw new Error(`Could not load the TypeScript compiler at ${clean(compilerPath)} (${errorSummary(error)}).`); }
  const major = Number(ts.version?.split('.')[0]);
  if (major < 5 || major >= 7 || !ts.createProgram) {
    throw new Error(`TypeScript ${ts.version ?? 'unknown'} is unsupported. Use TypeScript 5.x or 6.x; native TypeScript 7 is not supported yet. Point to another compiler with --typescript <path>.`);
  }
  return { ts, compilerPath, tscPath: path.join(path.dirname(compilerPath), 'tsc.js') };
}

export function readProject(project, ts) {
  let configPath = path.resolve(project);
  if (!fs.existsSync(configPath)) throw new Error(`Project not found: ${clean(configPath)}`);
  if (fs.statSync(configPath).isDirectory()) {
    configPath = ts.findConfigFile(configPath, ts.sys.fileExists);
    if (!configPath) throw new Error('No tsconfig.json found. Pass --project path/to/tsconfig.json.');
  }
  const errors = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: error => errors.push(error)
  });
  errors.push(...(parsed?.errors ?? []));
  if (errors.length || !parsed) {
    throw new Error(clean(ts.formatDiagnostics(errors, {
      getCanonicalFileName: x => x, getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => '\n'
    })));
  }
  if (!parsed.fileNames.length && parsed.projectReferences?.length) {
    throw new Error('This is a solution config. Select a referenced leaf project with --project; whyts does not build project references.');
  }
  return { configPath, base: path.dirname(configPath), parsed };
}

function collectSpecifiers(ts, source) {
  const specs = new Map();
  let reexports = 0;
  const add = node => {
    if (node && ts.isStringLiteralLike(node)) {
      let mode;
      try { mode = ts.getModeForUsageLocation(source, node); }
      catch { mode = undefined; /* Unknown usage mode: resolve with the compiler default. */ }
      specs.set(`${node.text}:${mode}`, { spec: node.text, mode });
    }
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) reexports++;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
       (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { specs, reexports };
}

export function buildGraph(ts, project) {
  const { parsed, base } = project;
  const options = { ...parsed.options, noEmit: true, generateTrace: undefined, generateCpuProfile: undefined };
  // Parent pointers are required by getModeForUsageLocation for require()/import() arguments.
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options, host, projectReferences: parsed.projectReferences });
  const sources = program.getSourceFiles();
  const files = new Map(sources.map(s => [path.resolve(s.fileName), s]));
  const edges = new Map();
  const incoming = new Map();
  const barrels = [];
  const skipped = [];
  const cache = ts.createModuleResolutionCache(base, x => x, parsed.options);
  for (const [file, source] of files) {
    let collected;
    // One unreadable file must not discard the analysis of the rest of the program.
    try { collected = collectSpecifiers(ts, source); }
    catch (error) { skipped.push({ file: display(base, file), reason: errorSummary(error) }); collected = { specs: new Map(), reexports: 0 }; }
    const { specs, reexports } = collected;
    const deps = new Set();
    for (const { spec, mode } of specs.values()) {
      // Resolve each import using its actual ESM/CJS usage mode, including dynamic import.
      const resolved = ts.resolveModuleName(spec, file, parsed.options, ts.sys, cache,
        undefined, mode).resolvedModule;
      if (resolved) {
        const dep = path.resolve(resolved.resolvedFileName);
        if (files.has(dep)) deps.add(dep);
      }
    }
    for (const ref of source.referencedFiles) {
      const dep = path.resolve(path.dirname(file), ref.fileName);
      if (files.has(dep)) deps.add(dep);
    }
    edges.set(file, deps);
    for (const dep of deps) {
      if (!incoming.has(dep)) incoming.set(dep, new Set());
      incoming.get(dep).add(file);
    }
    if (reexports >= 3 && !file.includes(`${path.sep}node_modules${path.sep}`)) {
      barrels.push({ file, reexports });
    }
  }
  return { ts, program, files, edges, incoming, barrels, skipped, roots: new Set(parsed.fileNames.map(f => path.resolve(f))) };
}

export function reachable(edges, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) for (const next of edges.get(stack.pop()) ?? []) {
    if (!seen.has(next)) { seen.add(next); stack.push(next); }
  }
  seen.delete(start);
  return seen;
}

export function explainFile(graph, target, base) {
  const file = path.resolve(base, target);
  if (!graph.files.has(file)) throw new Error(`File is not in this TypeScript program: ${clean(target)}`);
  const queue = [...graph.roots];
  const previous = new Map(queue.map(root => [root, null]));
  // A configured root is already an inclusion reason, even if also imported.
  for (let i = 0; i < queue.length && !previous.has(file); i++) {
    for (const dep of graph.edges.get(queue[i]) ?? []) if (!previous.has(dep)) {
      previous.set(dep, queue[i]); queue.push(dep);
    }
  }
  const chain = [];
  if (previous.has(file)) {
    for (let at = file; at !== null; at = previous.get(at)) chain.unshift(display(base, at));
  }
  return {
    file: display(base, file), configuredRoot: graph.roots.has(file), chain,
    importedBy: [...(graph.incoming.get(file) ?? [])].map(p => display(base, p)).sort(),
    note: chain.length ? null : 'Included through libraries, type directives, or reference resolution. Use tsc --explainFiles for the complete compiler explanation.'
  };
}

export function parseDiagnostics(output) {
  const result = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z /]*):\s+([\d.]+)\s*(s|K|M)?\s*$/);
    if (match) result[match[1].trim()] = { value: Number(match[2]), unit: match[3] ?? 'count' };
  }
  return result;
}

// Default compiler timeout. The slowest successful traced run measured while preparing 0.4
// (drizzle-orm type-tests) took 267 s, mostly in the type dump that tsc excludes from Total time.
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const PROGRESS_INTERVAL_MS = 30000;
const nativeCrashSignals = new Set(['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGKILL', 'SIGILL']);

// Last non-empty lines of compiler stderr, sanitized and clipped.
export function stderrTail(text, lines = 8) {
  return text.split(/\r?\n/).map(l => clean(l.trim()).slice(0, 240)).filter(Boolean).slice(-lines);
}

export function compilerCrashMessage(signal, stderr, maxOldSpaceMb) {
  const tail = stderrTail(stderr);
  const heap = /heap out of memory|Reached heap limit|Allocation failed/i.test(stderr);
  let message = `Compiler terminated by ${signal}.`;
  if (heap) message += ' The compiler ran out of JavaScript heap memory.';
  if (heap || nativeCrashSignals.has(signal)) {
    message += maxOldSpaceMb
      ? ` It was already limited to --max-old-space-size ${maxOldSpaceMb}; try a larger value if the machine has the memory.`
      : ' Retry with --max-old-space-size <MB> (for example 8192) to raise the compiler heap limit.';
    if (!heap) message += ' SIGABRT/SIGSEGV/SIGKILL without a heap message can also come from the operating system out-of-memory killer or a native crash.';
  }
  if (tail.length) message += `\nLast compiler stderr lines:\n${tail.map(l => `  ${l}`).join('\n')}`;
  return message;
}

function runCompiler(tscPath, args, cwd, { timeoutMs, maxOldSpaceMb, onProgress, progressIntervalMs = PROGRESS_INTERVAL_MS }) {
  return new Promise((resolve, reject) => {
    const nodeArgs = maxOldSpaceMb ? [`--max-old-space-size=${maxOldSpaceMb}`] : [];
    const child = spawn(process.execPath, [...nodeArgs, tscPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', size = 0, failure;
    const started = performance.now();
    const stop = message => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => stop(`Type checking exceeded ${timeoutMs / 1000}s. tsc writes a trace type dump after checking that is not part of its reported Total time, so large projects can run much longer than Total time. Increase --timeout.`), timeoutMs);
    const progress = onProgress ? setInterval(() => onProgress(Math.round((performance.now() - started) / 1000)), progressIntervalMs) : null;
    const cancel = () => stop('Analysis cancelled.');
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const collect = which => chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { stop('Compiler output exceeded 16 MiB. Fix excessive diagnostics before profiling.'); return; }
      if (which === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const cleanup = () => {
      clearTimeout(timer); if (progress) clearInterval(progress);
      process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (signal) reject(new Error(compilerCrashMessage(signal, stderr, maxOldSpaceMb)));
      else resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// tsc --pretty false prints "file(line,col): error TS1234: message"; some errors have no location.
const moduleErrorCodes = new Set(['TS2307', 'TS2792', 'TS2688', 'TS7016', 'TS6053']);
export function parseCompilerErrors(output, limit = 5, base = null) {
  // tsc prints paths relative to its own cwd, which is the real path; a symlinked base (macOS /var) breaks naive relative paths.
  let realBase = base;
  if (base) { try { realBase = fs.realpathSync(base); } catch { /* Keep the given base. */ } }
  const locate = file => {
    if (!realBase) return clean(slash(file));
    const absolute = path.resolve(realBase, file);
    let real = absolute;
    try { real = fs.realpathSync(absolute); } catch { /* A file that no longer exists keeps its resolved path. */ }
    return display(realBase, real);
  };
  const first = [], counts = new Map();
  let total = 0, missingDependencyErrors = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(?:(.+?)\((\d+),(\d+)\): )?error (TS\d+): (.*)$/);
    if (!match) continue;
    total++;
    counts.set(match[4], (counts.get(match[4]) ?? 0) + 1);
    if (moduleErrorCodes.has(match[4])) missingDependencyErrors++;
    if (first.length < limit) first.push({ file: match[1] ? locate(match[1]) : null, line: match[2] ? Number(match[2]) : null,
      character: match[3] ? Number(match[3]) : null, code: match[4], message: clean(match[5].trim().slice(0, 200)) });
  }
  const codes = [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 10);
  // Half or more of all errors being unresolved modules/types means dependencies are probably missing or unbuilt.
  const measurementMayBeInvalid = total > 0 && missingDependencyErrors * 2 >= total;
  return { total, first, codes, missingDependencyErrors, measurementMayBeInvalid };
}

function duplicateTypes(graph, base) {
  const packages = new Map();
  const visited = new Set();
  for (const file of graph.files.keys()) {
    const match = slash(file).match(/^(.*\/node_modules\/@types\/[^/]+)\//);
    if (!match || visited.has(match[1])) continue;
    visited.add(match[1]);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(match[1], 'package.json'), 'utf8'));
      if (!pkg.name?.startsWith('@types/') || !pkg.version) continue;
      if (!packages.has(pkg.name)) packages.set(pkg.name, []);
      packages.get(pkg.name).push({ version: pkg.version, path: display(base, match[1]) });
    } catch { /* A missing package manifest cannot establish version duplication. */ }
  }
  return [...packages].filter(([, entries]) => new Set(entries.map(e => e.version)).size > 1)
    .map(([name, copies]) => ({ name, copies }));
}

export function inspectProject(graph, project) {
  const { base, parsed } = project;
  const findings = [];
  const include = parsed.raw.include;
  if (!parsed.raw.files && (!include || include.some(p => ['**/*', '**', '.'].includes(p)))) {
    findings.push({ rule: 'broad-include', confidence: 'review', title: 'Project uses broad file inclusion',
      evidence: { include: include ?? ['**/* (default)'], rootFiles: graph.roots.size },
      suggestion: 'Review whether include can target source directories. A broad pattern alone does not prove wasted work.' });
  }
  const unimported = [...graph.roots].filter(file => !graph.incoming.get(file)?.size);
  const isTest = file => /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(slash(path.relative(base, file)));
  const isOutput = file => /(^|\/)(generated|dist|build|coverage)(\/|\.)/.test(slash(path.relative(base, file)));
  // Tests are entry points by nature and are never imported, so they are counted instead of listed.
  const testRoots = unimported.filter(isTest).length;
  const candidates = unimported.filter(file => !isTest(file) && isOutput(file));
  if (candidates.length) findings.push({ rule: 'review-root-files', confidence: 'review', title: `${candidates.length} generated or output roots have no observed importers`,
    evidence: { count: candidates.length, files: candidates.slice(0, 20).map(p => display(base, p)), testRootsExcluded: testRoots },
    suggestion: 'Confirm whether these files belong in this check. Use a narrower include where appropriate. Unimported roots may still be intentional.' });
  for (const { name, copies } of duplicateTypes(graph, base)) {
    findings.push({ rule: 'duplicate-types', confidence: 'observed', title: `Multiple loaded versions of ${clean(name)}`,
      evidence: { name: clean(name), copies }, suggestion: 'Inspect your package manager dependency tree and align compatible versions. Multiple versions may be required; do not deduplicate blindly.' });
  }
  // Bound graph traversals for large repositories. Candidates ranked by export count.
  const barrels = graph.barrels.sort((a, b) => b.reexports - a.reexports).slice(0, 40)
    .map(barrel => {
      const files = reachable(graph.edges, barrel.file);
      return { ...barrel, reachableFiles: files.size, alreadyRootFiles: [...files].filter(f => graph.roots.has(f)).length };
    })
    .sort((a, b) => b.reachableFiles - a.reachableFiles);
  for (const barrel of barrels.slice(0, 5)) findings.push({ rule: 'barrel-reach', confidence: 'observed',
    title: `${display(base, barrel.file)} reaches ${barrel.reachableFiles} files`,
    evidence: { file: display(base, barrel.file), reexports: barrel.reexports, reachableFiles: barrel.reachableFiles,
      directImporters: graph.incoming.get(barrel.file)?.size ?? 0, alreadyRootFiles: barrel.alreadyRootFiles },
    suggestion: barrel.alreadyRootFiles === barrel.reachableFiles
      ? 'All reached files are already configured roots. Changing this barrel import alone will not remove them from the program. Reach is structural context, not measured cost.'
      : !graph.incoming.get(barrel.file)?.size
        ? 'No direct importers were observed. Review why this barrel is included before proposing direct imports. Reach is structural context, not measured cost.'
        : 'Try importing the needed module directly, then compare fresh checks. Other roots and importers may still load these files; reach does not measure exclusive cost or runtime bundle size.' });
  return findings;
}

// A file whose recorded check time is mostly covered by one chain is already explained by that chain.
export const CHAIN_COVERAGE_THRESHOLD = 0.8;

export async function readTrace(traceFile, temporary, project, graph) {
  const result = { hotspots: [], sourceHotspots: [], sourceGroups: [], typeHotspots: [], projectHotspots: [], typeDescriptors: null, warnings: [] };
  if (!fs.existsSync(traceFile)) result.warnings.push('Compiler did not emit a trace; no hotspot measurements are available.');
  else if (fs.statSync(traceFile).size > 128 * 1024 * 1024) result.warnings.push('Trace exceeds 128 MiB; hotspot parsing skipped to bound memory usage.');
  else {
    try {
      const details = traceDetails(JSON.parse(fs.readFileSync(traceFile, 'utf8')), [], project.base, graph);
      const loaded = await readTypeDescriptors(path.join(temporary, 'types.json'), selectedTypeIds(details));
      result.typeDescriptors = loaded.stats; result.warnings.push(...loaded.warnings);
      Object.assign(result, resolveTraceTypes(details, loaded.descriptors, project.base, graph));
    } catch (error) { result.warnings.push(`Trace could not be parsed (${errorSummary(error)}). Other diagnostics remain available.`); }
  }
  return result;
}

// Inclusive interval as a percentage of tsc's Check time. An upper bound, never a predicted saving:
// intervals are inclusive samples recorded while tracing, which itself slows the check.
export function withCheckShare(list, checkSeconds) {
  return list.map(item => ({ ...item, checkTimeShareUpperBoundPercent: checkSeconds > 0
    ? Math.round(item.milliseconds / (checkSeconds * 1000) * 1000) / 10 : null }));
}

export function measuredFindings({ hotspots, projectHotspots, sourceGroups }) {
  const findings = [];
  for (const hotspot of sourceGroups.filter(h => h.milliseconds >= 10)) findings.push({
    rule: 'source-check-chain', confidence: 'measured', title: `${hotspot.file}:${hotspot.line}:${hotspot.character}: ${hotspot.milliseconds.toFixed(1)} ms recorded check chain (${hotspot.memberCount} source checks)`,
    evidence: hotspot, suggestion: hotspot.comparisons.length
      ? 'Inspect the focus expression, related checks and listed type declarations. Comparisons were recorded inside this chain; inclusive samples do not prove a cause or predict savings. Validate behavior and remeasure any change.'
      : 'Inspect the focus expression and related checks. No type comparison was recorded inside this sampled chain; the trace does not establish the expensive type. Validate behavior and remeasure any change.'
  });
  const coveredByChain = file => sourceGroups.some(g => g.file === file.file && g.milliseconds >= file.milliseconds * CHAIN_COVERAGE_THRESHOLD);
  const filesToReview = [...projectHotspots, ...hotspots.filter(h => !projectHotspots.some(p => p.file === h.file))].slice(0, 5);
  for (const hotspot of filesToReview.filter(h => h.milliseconds >= 100 && !coveredByChain(h))) findings.push({
    rule: 'check-hotspot', confidence: 'measured', title: `${hotspot.file}: ${hotspot.milliseconds.toFixed(1)} ms recorded check intervals`,
    evidence: hotspot, suggestion: 'Inspect types and declarations in this file. Trace intervals are inclusive samples, not a complete attribution of total check time.'
  });
  return findings;
}

export async function analyze(options = {}) {
  const projectInput = path.resolve(options.project ?? '.');
  const compilerBase = fs.existsSync(projectInput) && fs.statSync(projectInput).isDirectory() ? projectInput : path.dirname(projectInput);
  const compiler = loadCompiler(compilerBase, options.typescript);
  const project = readProject(projectInput, compiler.ts);
  const graph = buildGraph(compiler.ts, project);
  const findings = inspectProject(graph, project);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-'));
  try {
    const started = performance.now();
    // Keep project incremental/composite semantics; isolate cache and all trace output.
    const args = ['--project', project.configPath, '--noEmit', '--emitDeclarationOnly', 'false',
      '--incremental', '--tsBuildInfoFile', path.join(temporary, 'cache.tsbuildinfo'),
      '--extendedDiagnostics', '--pretty', 'false', '--generateTrace', temporary];
    const run = await runCompiler(compiler.tscPath, args, project.base, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000, maxOldSpaceMb: options.maxOldSpaceMb, onProgress: options.onProgress, progressIntervalMs: options.progressIntervalMs });
    const wallMilliseconds = performance.now() - started;
    const diagnostics = parseDiagnostics(run.stdout);
    const compilerErrors = parseCompilerErrors(run.stdout, 5, project.base);
    if (!Object.keys(diagnostics).length) throw new Error(`Compiler produced no diagnostics. ${clean((run.stderr || run.stdout).slice(0, 2000))}`);
    const traceFile = path.join(temporary, 'trace.json');
    const trace = await readTrace(traceFile, temporary, project, graph);
    const checkSeconds = diagnostics['Check time']?.value;
    const hotspots = withCheckShare(trace.hotspots, checkSeconds), projectHotspots = withCheckShare(trace.projectHotspots, checkSeconds),
      sourceHotspots = withCheckShare(trace.sourceHotspots, checkSeconds), sourceGroups = withCheckShare(trace.sourceGroups, checkSeconds);
    const { typeHotspots, typeDescriptors } = trace;
    const traceWarnings = trace.warnings;
    findings.push(...measuredFindings({ hotspots, projectHotspots, sourceGroups }));
    const confidenceRank = { measured: 0, observed: 1, review: 2 };
    findings.sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence]);
    return { schemaVersion: 1, toolVersion, typescriptVersion: compiler.ts.version,
      project: display(process.cwd(), project.configPath),
      summary: { programFiles: graph.files.size, rootFiles: graph.roots.size, compilerExitCode: run.exitCode,
        errorCount: compilerErrors.total, wallMilliseconds, dumpTypesSeconds: diagnostics['Dump types time']?.value ?? null,
        mode: 'fresh-cache, no-emit, tracing enabled', analysisOverheadExcluded: true },
      diagnostics, compilerErrors, findings, hotspots, projectHotspots, sourceHotspots, sourceGroups, typeHotspots, typeDescriptors, warnings: [...traceWarnings,
        project.parsed.projectReferences?.length ? 'Referenced projects are not built; existing declaration outputs may be required.' : null,
        graph.skipped.length ? `Import analysis skipped ${graph.skipped.length} file${graph.skipped.length === 1 ? '' : 's'} (${graph.skipped.slice(0, 3).map(f => f.file).join(', ')}${graph.skipped.length > 3 ? ', ...' : ''}); import graph findings may be incomplete.` : null,
        compilerErrors.measurementMayBeInvalid ? `${compilerErrors.missingDependencyErrors} of ${compilerErrors.total} compiler errors are unresolved modules or type declarations (${[...moduleErrorCodes].join(', ')}). Dependencies may be missing or not built, so these timings may not represent a healthy build.` : null,
        'Tracing adds overhead. Compare timings using the same compiler, cache mode, and tracing settings.',
        'Types, Instantiations and Memory counters in diagnostics come from the traced run; tracing inflates them. Do not compare them with plain tsc --extendedDiagnostics output.'
      ].filter(Boolean) };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function explain(options) {
  const input = path.resolve(options.project ?? '.');
  const base = fs.existsSync(input) && fs.statSync(input).isDirectory() ? input : path.dirname(input);
  const compiler = loadCompiler(base, options.typescript);
  const project = readProject(input, compiler.ts);
  return explainFile(buildGraph(compiler.ts, project), options.file, project.base);
}
