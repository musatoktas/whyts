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


export function loadCompiler(base) {
  let compilerPath;
  try { compilerPath = createRequire(path.join(base, 'package.json')).resolve('typescript'); }
  catch { compilerPath = require.resolve('typescript'); }
  const ts = require(compilerPath);
  const major = Number(ts.version?.split('.')[0]);
  if (major < 5 || major >= 7 || !ts.createProgram) {
    throw new Error(`TypeScript ${ts.version ?? 'unknown'} is unsupported. Use TypeScript 5.x or 6.x; native TypeScript 7 is not supported yet.`);
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
  const skipped = [];
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

function runCompiler(tscPath, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', size = 0, failure;
    const stop = message => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => stop(`Type checking exceeded ${timeoutMs / 1000}s. Increase --timeout.`), timeoutMs);
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
      clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (signal) reject(new Error(`Compiler terminated by ${signal}.`));
      else resolve({ stdout, stderr, exitCode: code });
    });
  });
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
  const candidates = [...graph.roots].filter(file => /(^|\/)(generated|dist|build|coverage|__tests__|tests?)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/.test(slash(path.relative(base, file))))
    .filter(file => !graph.incoming.get(file)?.size);
  if (candidates.length) findings.push({ rule: 'review-root-files', confidence: 'review', title: `${candidates.length} generated, output, or test roots have no observed importers`,
    evidence: { count: candidates.length, files: candidates.slice(0, 20).map(p => display(base, p)) },
    suggestion: 'Confirm whether these files belong in this check. Use a separate test config or narrower include where appropriate. Unimported roots may still be intentional.' });
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
  const compiler = loadCompiler(compilerBase);
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
    const run = await runCompiler(compiler.tscPath, args, project.base, options.timeoutMs ?? 120000);
    const wallMilliseconds = performance.now() - started;
    const diagnostics = parseDiagnostics(run.stdout);
    if (!Object.keys(diagnostics).length) throw new Error(`Compiler produced no diagnostics. ${clean((run.stderr || run.stdout).slice(0, 2000))}`);
    const traceFile = path.join(temporary, 'trace.json');
    const trace = await readTrace(traceFile, temporary, project, graph);
    const { hotspots, sourceHotspots, sourceGroups, typeHotspots, projectHotspots, typeDescriptors } = trace;
    const traceWarnings = trace.warnings;
    findings.push(...measuredFindings({ hotspots, projectHotspots, sourceGroups }));
    const confidenceRank = { measured: 0, observed: 1, review: 2 };
    findings.sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence]);
    return { schemaVersion: 1, toolVersion, typescriptVersion: compiler.ts.version,
      project: display(process.cwd(), project.configPath),
      summary: { programFiles: graph.files.size, rootFiles: graph.roots.size, compilerExitCode: run.exitCode,
        errorCount: (run.stdout.match(/\berror TS\d+:/g) ?? []).length, wallMilliseconds,
        mode: 'fresh-cache, no-emit, tracing enabled', analysisOverheadExcluded: true },
      diagnostics, findings, hotspots, projectHotspots, sourceHotspots, sourceGroups, typeHotspots, typeDescriptors, warnings: [...traceWarnings,
        project.parsed.projectReferences?.length ? 'Referenced projects are not built; existing declaration outputs may be required.' : null,
        'Tracing adds overhead. Compare timings using the same compiler, cache mode, and tracing settings.'
      ].filter(Boolean) };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function explain(options) {
  const input = path.resolve(options.project ?? '.');
  const base = fs.existsSync(input) && fs.statSync(input).isDirectory() ? input : path.dirname(input);
  const compiler = loadCompiler(base);
  const project = readProject(input, compiler.ts);
  return explainFile(buildGraph(compiler.ts, project), options.file, project.base);
}
