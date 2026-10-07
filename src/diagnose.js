import path from 'node:path';
import { traceSpans, findSource } from './trace.js';

const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

export const PERFORMANCE_DOCS = 'https://github.com/microsoft/TypeScript/wiki/Performance';
// Variance work below these values stays in the recorded data and does not become a diagnosis.
export const VARIANCE_EVENT_MIN_MS = 50;
export const VARIANCE_TOTAL_MIN_MS = 100;
export const MAX_DIAGNOSES = 10;

const varianceEvent = 'getVariancesWorker';
const depthEvents = new Set(['instantiateType_DepthLimit']);

// Union of intervals in milliseconds: nested inclusive spans must not be added.
function unionMilliseconds(ranges) {
  if (!ranges.length) return 0;
  const sorted = ranges.map(r => [...r]).sort((a, b) => a[0] - b[0]);
  let total = 0, [left, right] = sorted[0];
  for (const [a, b] of sorted.slice(1)) {
    if (a <= right) right = Math.max(right, b); else { total += right - left; left = a; right = b; }
  }
  return (total + right - left) / 1000;
}

// Outermost getVariancesWorker spans per thread, each with its largest nested spans.
function outerVariances(spans) {
  const threads = new Map();
  for (const span of spans) {
    if (!Number.isInteger(span.args?.id)) continue;
    if (!threads.has(span.thread)) threads.set(span.thread, []);
    threads.get(span.thread).push(span);
  }
  const outer = [];
  for (const list of threads.values()) {
    list.sort((a, b) => a.ts - b.ts || b.end - a.end);
    let current = null;
    for (const span of list) {
      if (current && span.end <= current.span.end) { current.inner.push(span); continue; }
      current = { span, inner: [] }; outer.push(current);
    }
  }
  const shape = span => ({ id: span.args.id, arity: Number.isInteger(span.args.arity) ? span.args.arity : null,
    variances: [span.args.results?.variances, span.endArgs?.variances, span.endArgs?.results?.variances].find(Array.isArray)?.filter(v => typeof v === 'string').map(clean) ?? [],
    milliseconds: (span.end - span.ts) / 1000, ts: span.ts, end: span.end });
  return outer.map(({ span, inner }) => {
    const seen = new Set([span.args.id]), nested = [];
    for (const item of inner.sort((a, b) => (b.end - b.ts) - (a.end - a.ts))) {
      if (!seen.has(item.args.id) && nested.length < 3) { seen.add(item.args.id); nested.push(shape(item)); }
    }
    return { ...shape(span), nested };
  }).sort((a, b) => b.milliseconds - a.milliseconds);
}

// Raw trace signals that need type descriptors. Kept small: only ids and numbers.
export function collectSignals(events) {
  const variances = outerVariances(traceSpans(events, new Set([varianceEvent])));
  // One compiler hit of the instantiation limit can write hundreds of thousands of events. Keep counts per type id.
  const byType = new Map();
  let total = 0, maxCount = 0;
  for (const e of events) {
    if (!depthEvents.has(e.name) || !Number.isInteger(e.args?.typeId)) continue;
    total++;
    const entry = byType.get(e.args.typeId) ?? { typeId: e.args.typeId, events: 0, maxDepth: 0 };
    entry.events++; entry.maxDepth = Math.max(entry.maxDepth, e.args.instantiationDepth ?? 0);
    byType.set(e.args.typeId, entry);
    if (Number.isFinite(e.args.instantiationCount)) maxCount = Math.max(maxCount, e.args.instantiationCount);
  }
  const depth = { event: 'instantiateType_DepthLimit', events: total, maxInstantiationCount: maxCount,
    types: [...byType.values()].sort((a, b) => b.events - a.events || a.typeId - b.typeId).slice(0, 3) };
  return { variances, depth };
}

export function signalTypeIds(signals) {
  const ids = new Set();
  for (const v of signals?.variances ?? []) if (v.milliseconds >= VARIANCE_EVENT_MIN_MS) {
    ids.add(v.id); for (const n of v.nested) ids.add(n.id);
  }
  for (const d of signals?.depth?.types ?? []) ids.add(d.typeId);
  return ids;
}

const share = (milliseconds, checkSeconds) => checkSeconds > 0 ? Math.round(milliseconds / (checkSeconds * 1000) * 1000) / 10 : null;

function location(type) {
  const d = type?.declaration;
  return d ? { file: d.file, line: d.line, character: d.character, scope: d.scope } : null;
}

function varianceDiagnosis(signals, describe, checkSeconds) {
  // A remedy must be something the project can change: types declared in dependencies are left out.
  const shown = signals.variances.filter(v => v.milliseconds >= VARIANCE_EVENT_MIN_MS && describe(v.id).declaration?.scope === 'project');
  const total = unionMilliseconds(shown.map(v => [v.ts, v.end]));
  if (total < VARIANCE_TOTAL_MIN_MS) return null;
  const types = shown.slice(0, 5).map(v => {
    const type = describe(v.id);
    return { typeName: type.label, typeId: v.id, location: location(type), milliseconds: v.milliseconds, arity: v.arity, variances: v.variances,
      nested: v.nested.map(n => ({ typeName: describe(n.id).label, typeId: n.id, milliseconds: n.milliseconds })) };
  });
  const lead = types[0];
  const names = types.map(t => t.typeName);
  const unreliable = shown.reduce((n, v) => n + v.variances.filter(x => x.includes('unreliable')).length, 0);
  return { pattern: 'variance-computation', confidence: 'measured',
    title: `Variance computation for ${shown.length} generic type${shown.length === 1 ? '' : 's'}, led by ${lead.typeName}`,
    location: lead.location, milliseconds: total, checkTimeShareUpperBoundPercent: share(total, checkSeconds),
    evidence: { event: varianceEvent, typeName: lead.typeName, location: lead.location, milliseconds: total, typeCount: shown.length,
      unreliableVariances: unreliable, types,
      summary: [`TypeScript spent ${Number(total.toFixed(1))} ms to compute how ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''} relate when type arguments differ.`],
      details: types.flatMap(t => [`${t.typeName}: ${Number(t.milliseconds.toFixed(1))} ms, ${t.arity ?? '?'} type parameters${t.location ? `, declared at ${t.location.file}:${t.location.line}` : ''}`,
        ...(t.nested.length ? [`   nested: ${t.nested.map(n => `${n.typeName} ${Number(n.milliseconds.toFixed(1))} ms`).join(', ')}`] : [])]) },
    remedy: `Reduce the type parameters of ${names.slice(0, 2).join(' and ')}. Simplify their return types. ` +
      'An in or out annotation is not a guaranteed fix. Measure again after each change.',
    docs: PERFORMANCE_DOCS };
}


// Type declarations by name, for a name-based reference walk. Library files are skipped.
function declarationIndex(graph) {
  const index = new Map();
  const { ts } = graph;
  for (const [file, source] of graph.files) {
    if (graph.program.isSourceFileDefaultLibrary(source)) continue;
    for (const node of source.statements) {
      if (!(ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) || !node.name) continue;
      const list = index.get(node.name.text) ?? [];
      list.push({ node, source, file, name: node.name.text });
      index.set(node.name.text, list);
    }
  }
  return index;
}

const declKey = d => `${d.file}\u0000${d.name}`;

function referencedNames(ts, node) {
  const names = new Set();
  const visit = child => {
    if (ts.isTypeReferenceNode(child) || ts.isExpressionWithTypeArguments(child)) {
      const name = ts.isTypeReferenceNode(child) ? child.typeName : child.expression;
      const id = ts.isIdentifier(name) ? name : ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : null;
      if (id) names.add(id.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function lookup(index, name, fromFile) {
  const list = index.get(name) ?? [];
  const same = list.filter(d => d.file === fromFile);
  if (same.length === 1) return same[0];
  return !same.length && list.length === 1 ? list[0] : null;
}

// Shortest chain of name references from a declaration back to itself, or null. Bounded for large programs.
function referenceCycle(graph, index, start, limit = 4000) {
  const { ts } = graph;
  const previous = new Map([[declKey(start), null]]);
  const queue = [start];
  for (let i = 0; i < queue.length && queue.length < limit; i++) {
    const current = queue[i];
    for (const name of referencedNames(ts, current.node)) {
      const next = lookup(index, name, current.file);
      if (!next) continue;
      if (next === start) {
        const chain = [start];
        for (let at = current; at && at !== start; at = previous.get(declKey(at))) chain.splice(1, 0, at);
        return [...chain, start];
      }
      if (!previous.has(declKey(next))) { previous.set(declKey(next), current); queue.push(next); }
    }
  }
  return null;
}

function nodeAt(ts, source, pos) {
  const path = [];
  const visit = node => {
    if (node.pos > pos || node.end <= pos) return;
    path.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return path;
}

function declarationLocation(base, d) {
  const at = d.source.getLineAndCharacterOfPosition(d.node.getStart(d.source));
  return { file: path.relative(base, path.resolve(d.source.fileName)).split(path.sep).join('/'), line: at.line + 1, character: at.character + 1 };
}

// The type declaration that holds the declaration of a type id (for example the alias that owns a type parameter).
function owner(graph, base, index, type) {
  const d = type?.declaration;
  if (!d) return null;
  const source = findSource(path.resolve(base, d.file), graph);
  if (!source || d.line > source.getLineStarts().length) return null;
  const pos = source.getPositionOfLineAndCharacter(d.line - 1, Math.max(0, d.character - 1));
  const { ts } = graph;
  for (const node of nodeAt(ts, source, pos).reverse()) {
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      return (index.get(node.name.text) ?? []).find(x => x.node === node) ?? { node, source, file: path.resolve(source.fileName), name: node.name.text };
    }
  }
  return null;
}

// Aliases named in the type arguments at an error position, followed through aliases, that refer to themselves.
function selfContainingArguments(graph, base, index, error) {
  const none = { text: null, found: [] };
  if (!error?.file || !error.line) return none;
  const source = findSource(path.resolve(base, error.file), graph);
  if (!source) return none;
  const { ts } = graph;
  const pos = source.getPositionOfLineAndCharacter(error.line - 1, Math.max(0, (error.character ?? 1) - 1));
  const reference = nodeAt(ts, source, pos).reverse().find(n => ts.isTypeReferenceNode(n) && n.typeArguments?.length && n.getStart(source) === pos);
  if (!reference) return none;
  const found = [], seen = new Set();
  const queue = [...new Set(reference.typeArguments.flatMap(a => [...referencedNames(ts, a)]))]
    .map(name => lookup(index, name, path.resolve(source.fileName))).filter(Boolean);
  for (let i = 0; i < queue.length && i < 50; i++) {
    const decl = queue[i];
    if (seen.has(declKey(decl))) continue;
    seen.add(declKey(decl));
    const cycle = referenceCycle(graph, index, decl);
    if (cycle) found.push({ name: decl.name, location: declarationLocation(base, decl), cycle: cycle.map(d => d.name) });
    else for (const name of referencedNames(ts, decl.node)) { const next = lookup(index, name, decl.file); if (next) queue.push(next); }
  }
  const text = source.text.slice(reference.getStart(source), reference.end).replace(/\s+/g, ' ').trim();
  return { text: clean(text.slice(0, 120)), found: found.slice(0, 3) };
}

const chainText = names => names.join(' -> ');
const selfText = (name, cycle) => cycle.length === 2 ? `${name} refers to itself.` : `${name} refers to itself: ${chainText(cycle)}.`;

function recursionDiagnosis({ signals, describe, checkSeconds, graph, base, compilerErrors, intervals }) {
  const errors = compilerErrors?.excessiveDepth ?? [];
  const depth = signals.depth;
  if (!errors.length && !depth?.events) return null;
  const index = graph ? declarationIndex(graph) : new Map();
  const site = errors[0] ?? null;
  const siteLocation = site?.file ? { file: site.file, line: site.line, character: site.character } : null;
  const owners = [];
  for (const entry of depth?.types ?? []) {
    const type = describe(entry.typeId);
    const decl = graph ? owner(graph, base, index, type) : null;
    owners.push({ typeId: entry.typeId, typeName: type.label, events: entry.events, maxDepth: entry.maxDepth,
      location: location(type), alias: decl ? decl.name : null,
      aliasLocation: decl ? declarationLocation(base, decl) : null,
      cycle: decl && graph ? referenceCycle(graph, index, decl)?.map(d => d.name) ?? null : null });
  }
  const cyclic = owners.find(o => o.cycle) ?? null;
  const lead = cyclic ?? owners.find(o => o.alias) ?? owners[0] ?? null;
  const { text: siteText, found: args } = graph ? selfContainingArguments(graph, base, index, site) : { text: null, found: [] };
  const interval = siteLocation && ((intervals?.sourceGroups ?? []).find(g => g.file === siteLocation.file && g.line === siteLocation.line) ??
    (intervals?.projectHotspots ?? []).find(h => h.file === siteLocation.file));
  const milliseconds = interval?.milliseconds ?? 0;
  const name = lead?.alias ?? lead?.typeName ?? null;
  const summary = [];
  if (site) summary.push(`${site.code} at this place: ${site.message}`);
  if (lead?.alias) summary.push(`It hit the instantiation limit inside ${lead.alias}${lead.aliasLocation ? ` (${lead.aliasLocation.file}:${lead.aliasLocation.line})` : ''}.`);
  if (lead?.cycle) summary.push(selfText(lead.alias, lead.cycle));
  for (const a of args) summary.push(`Type argument ${a.name} (${a.location.file}:${a.location.line}): ${selfText(a.name, a.cycle)}`);
  if (!summary.length) summary.push(`The compiler recorded ${depth.events} instantiation limit events.`);
  const details = [...summary, ...owners.map(o => `type #${o.typeId} ${o.typeName}: ${o.events} limit events, depth ${o.maxDepth}${o.alias ? `, inside ${o.alias}` : ''}`),
    ...(depth?.maxInstantiationCount ? [`largest instantiation count in the events: ${depth.maxInstantiationCount}`] : [])];
  return { pattern: 'recursive-type-instantiation', confidence: 'measured',
    title: `Recursive type instantiation${siteText ? `: ${siteText}` : name ? ` in ${name}` : ''}`,
    location: siteLocation, milliseconds, checkTimeShareUpperBoundPercent: interval ? share(milliseconds, checkSeconds) : null,
    evidence: { event: depth?.events ? depth.event : null, compilerError: site, expression: siteText, typeName: name, typeAlias: lead?.alias ?? null,
      location: lead?.aliasLocation ?? lead?.location ?? null, limitEvents: depth?.events ?? 0, maxInstantiationCount: depth?.maxInstantiationCount ?? 0,
      cycle: lead?.cycle ?? null, selfContainingArguments: args, types: owners, milliseconds, summary, details },
    remedy: `Stop the expansion of ${name ?? 'the recursive type'} when it meets a type it already visited. Or add a depth limit to it. Check that the fix keeps the same results.`,
    docs: PERFORMANCE_DOCS };
}

export function buildDiagnoses(context) {
  if (!context.signals) return [];
  const list = [recursionDiagnosis(context), varianceDiagnosis(context.signals, context.describe, context.checkSeconds)].filter(Boolean);
  // A recursion diagnosis comes first: the compiler already reported an error for it.
  return list.sort((a, b) => (b.pattern === 'recursive-type-instantiation') - (a.pattern === 'recursive-type-instantiation') || b.milliseconds - a.milliseconds).slice(0, MAX_DIAGNOSES);
}
