import path from 'node:path';
import { traceSpans, findSource } from './trace.js';
import { explainFile } from './analyze.js';

const display = (base, file) => clean(path.relative(base, file).split(path.sep).join('/') || '.');
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

// The node with type arguments that starts at an error position, and helpers that resolve names with the checker of the
// graph program. The checker only resolves names here.
function siteNode(graph, base, error, accept) {
  if (!error?.file || !error.line || !graph.program) return null;
  const source = findSource(path.resolve(base, error.file), graph);
  if (!source) return null;
  const { ts } = graph;
  const pos = source.getPositionOfLineAndCharacter(error.line - 1, Math.max(0, (error.character ?? 1) - 1));
  const site = nodeAt(ts, source, pos).reverse().find(n => accept(n) && n.typeArguments?.length && n.getStart(source) === pos);
  if (!site) return null;
  const checker = graph.checker ??= graph.program.getTypeChecker();
  const declarationsOf = name => {
    const id = ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name;
    let symbol = checker.getSymbolAtLocation(id);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  const text = node => clean(node.getText().replace(/\s+/g, ' ').trim().slice(0, 120));
  const where = node => {
    const file = node.getSourceFile(), at = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { file: display(base, path.resolve(file.fileName)), line: at.line + 1, character: at.character + 1 };
  };
  return { ts, site, declarationsOf, text, where };
}

// Type parameters of the declaration named at an error position whose constraint gives a generic type fewer type arguments
// than it declares. The omitted ones take their defaults.
function partialConstraints(graph, base, error) {
  const at = siteNode(graph, base, error, n => graph.ts.isTypeReferenceNode(n) || graph.ts.isExpressionWithTypeArguments(n) || graph.ts.isTypeQueryNode(n));
  if (!at) return [];
  const { ts, site, declarationsOf, text, where } = at;
  const found = [];
  const name = ts.isTypeReferenceNode(site) ? site.typeName : ts.isTypeQueryNode(site) ? site.exprName : site.expression;
  for (const decl of declarationsOf(name)) {
    // A generic function type in a variable declaration: declare const f: <T extends X>(...) => R.
    for (const parameter of decl.typeParameters ?? decl.type?.typeParameters ?? []) {
      const constraint = parameter.constraint;
      if (!constraint || !ts.isTypeReferenceNode(constraint)) continue;
      const given = constraint.typeArguments?.length ?? 0;
      for (const target of declarationsOf(constraint.typeName)) {
        if (!(ts.isClassDeclaration(target) || ts.isInterfaceDeclaration(target) || ts.isTypeAliasDeclaration(target)) || !target.name) continue;
        const declared = target.typeParameters ?? [];
        const missing = declared.slice(given);
        if (!missing.length || missing.some(p => !p.default)) continue;
        found.push({ expression: text(site), typeParameter: clean(parameter.name.text), constraint: text(constraint), location: where(constraint),
          generic: clean(target.name.text), genericLocation: where(target), given, declared: declared.length,
          missing: missing.map(p => ({ name: clean(p.name.text), default: text(p.default),
            modifiers: (p.modifiers ?? []).map(m => m.getText()).filter(m => m === 'in' || m === 'out') })) });
      }
    }
  }
  return found.slice(0, 3);
}

function partialConstraintDiagnosis({ site, siteLocation, partial, owners, depth, milliseconds, share }) {
  const { expression, typeParameter, generic, given, declared, location } = partial;
  const names = partial.missing.map(m => m.name);
  const atLimit = owners.filter(o => o.alias === generic).map(o => o.typeName);
  const inDependency = location.file.split('/').includes('node_modules');
  const summary = [`${site.code} at this place: ${site.message}`,
    `The constraint of ${typeParameter} is ${partial.constraint} (${location.file}:${location.line}). ${generic} declares ${declared} type parameters. The constraint gives ${given}.`,
    `The omitted ${names.join(', ')} take${names.length === 1 ? 's its default' : ' their defaults'}: ${partial.missing.map(m => `${m.name} = ${m.default}${m.modifiers.length ? ` (${m.modifiers.join(' ')})` : ''}`).join(', ')}.`,
    `The compiler hit the instantiation limit inside ${generic}${atLimit.length ? `, at ${[...new Set(atLimit)].join(', ')}` : ''}.`].map(clean);
  const details = [...summary, ...owners.map(o => `type #${o.typeId} ${o.typeName}: ${o.events} limit events, depth ${o.maxDepth}${o.alias ? `, inside ${o.alias}` : ''}`),
    ...(depth?.maxInstantiationCount ? [`largest instantiation count in the events: ${depth.maxInstantiationCount}`] : [])];
  return { pattern: 'partial-constraint', confidence: 'measured',
    title: `Constraint gives ${given} of ${declared} type arguments to ${generic}: ${expression}`,
    location: siteLocation, milliseconds, checkTimeShareUpperBoundPercent: share,
    evidence: { event: depth?.events ? depth.event : null, compilerError: site, expression, typeParameter, constraint: partial.constraint,
      location, generic, genericLocation: partial.genericLocation, given, declared, missing: partial.missing,
      limitEvents: depth?.events ?? 0, maxInstantiationCount: depth?.maxInstantiationCount ?? 0, types: owners, milliseconds, summary, details },
    remedy: `Give all ${declared} type arguments of ${generic} in the constraint of ${typeParameter}, for example any for each. ` +
      `The constraint is at ${location.file}:${location.line}. ` +
      (inDependency ? 'It is in a dependency, so tell its maintainers. ' : '') + 'Measure again after the change.',
    docs: PERFORMANCE_DOCS };
}

// Type arguments at an error position that are instantiation expressions (typeof f<T>, directly or through a type alias),
// given to a type alias whose body is a conditional type, such as ReturnType or Parameters.
function instantiationExpressionArguments(graph, base, error) {
  const at = siteNode(graph, base, error, n => graph.ts.isTypeReferenceNode(n));
  if (!at) return [];
  const { ts, site, declarationsOf, text, where } = at;
  const query = node => {
    if (ts.isTypeQueryNode(node)) return node.typeArguments?.length ? node : null;
    if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length) return null;
    const alias = declarationsOf(node.typeName).find(d => ts.isTypeAliasDeclaration(d) && !d.typeParameters);
    return alias && ts.isTypeQueryNode(alias.type) && alias.type.typeArguments?.length ? alias.type : null;
  };
  const found = [];
  for (const decl of declarationsOf(site.typeName)) {
    if (!ts.isTypeAliasDeclaration(decl) || !ts.isConditionalTypeNode(decl.type) || !decl.typeParameters) continue;
    site.typeArguments.forEach((argument, i) => {
      const parameter = decl.typeParameters[i], expression = parameter && query(argument);
      if (!expression) return;
      const fn = declarationsOf(expression.exprName)[0];
      const returnType = fn && (ts.isVariableDeclaration(fn) ? fn.type && ts.isFunctionTypeNode(fn.type) ? fn.type.type : null : fn.type ?? null);
      found.push({ expression: text(site), argument: text(argument), instantiation: text(expression), generic: clean(decl.name.text),
        genericLocation: where(decl), typeParameter: clean(parameter.name.text), inline: inlineConditional(ts, decl, parameter.name.text, argument),
        function: text(expression.exprName), returnType: returnType ? text(returnType) : null, returnTypeLocation: returnType ? where(returnType) : null });
    });
  }
  return found.slice(0, 3);
}

// The conditional body of a type alias with the type parameter replaced by the text of the type argument.
function inlineConditional(ts, decl, name, argument) {
  const file = decl.getSourceFile(), body = decl.type, start = body.getStart(file);
  const uses = [];
  const visit = node => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === name && !node.typeArguments) uses.push(node);
    else ts.forEachChild(node, visit);
  };
  visit(body);
  let out = file.text.slice(start, body.end);
  const replacement = argument.getText();
  for (const use of uses.sort((a, b) => b.getStart(file) - a.getStart(file))) {
    out = out.slice(0, use.getStart(file) - start) + replacement + out.slice(use.end - start);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length <= 160 ? clean(out) : null;
}

// A TypeScript library file is named without its path: the path is the one of the compiler install.
const libFile = file => /(^|\/)typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(file) ? file.split('/').pop() : file;

function instantiationExpressionDiagnosis({ site, siteLocation, found, owners, depth, milliseconds, share }) {
  const { expression, argument, instantiation, generic, genericLocation, inline } = found;
  const files = [...new Set(owners.map(o => o.location?.file).filter(Boolean))].slice(0, 3);
  const summary = [`${site.code} at this place: ${site.message}`,
    `The type argument ${argument} is an instantiation expression${argument === instantiation ? '' : ` (${instantiation})`}. ` +
      `${generic} is a conditional type (${libFile(genericLocation.file)}:${genericLocation.line}).`,
    `The compiler hit the instantiation limit in types that the expression brings, not in ${generic}${files.length ? `: types from ${files.join(', ')}` : ''}.`].map(clean);
  const details = [...summary, ...owners.map(o => `type #${o.typeId} ${o.typeName}: ${o.events} limit events, depth ${o.maxDepth}${o.alias ? `, inside ${o.alias}` : ''}`),
    ...(depth?.maxInstantiationCount ? [`largest instantiation count in the events: ${depth.maxInstantiationCount}`] : [])];
  const direct = generic === 'ReturnType' && found.returnType
    ? `Or use the type that ${found.function} returns, ${found.returnType}, from ${found.returnTypeLocation.file}:${found.returnTypeLocation.line}. ` : '';
  return { pattern: 'instantiation-expression', confidence: 'measured',
    title: `Instantiation expression given to a conditional type: ${expression}`,
    location: siteLocation, milliseconds, checkTimeShareUpperBoundPercent: share,
    evidence: { event: depth?.events ? depth.event : null, compilerError: site, expression, argument, instantiation, generic, genericLocation,
      typeParameter: found.typeParameter, inline, function: found.function, returnType: found.returnType, returnTypeLocation: found.returnTypeLocation,
      limitEvents: depth?.events ?? 0, maxInstantiationCount: depth?.maxInstantiationCount ?? 0, types: owners, milliseconds, summary, details },
    remedy: (inline ? `Write the conditional type of ${generic} in place: ${inline}. ` : `Write the conditional type of ${generic} in place, with ${argument} as the checked type. `) +
      direct + 'Measure again after the change.',
    docs: PERFORMANCE_DOCS };
}

// A chain of calls that starts at an error position, followed through variables that hold the chain before it. The method called
// most often must return the class that it is called on and take an instance of that class, as a plugin method of a builder does.
export const BUILDER_CHAIN = {
  minCalls: 32,   // fewer calls than this are not reported as a long chain
  groupSize: 32   // largest group in the remedy
};

function builderChain(graph, base, error) {
  if (!error?.file || !error.line || !graph.program) return null;
  const source = findSource(path.resolve(base, error.file), graph);
  if (!source) return null;
  const { ts } = graph;
  const pos = source.getPositionOfLineAndCharacter(error.line - 1, Math.max(0, (error.character ?? 1) - 1));
  const top = nodeAt(ts, source, pos).find(n => ts.isCallExpression(n) && n.getStart(source) === pos);
  if (!top) return null;
  const checker = graph.checker ??= graph.program.getTypeChecker();
  const calls = new Map();
  let node = top, statements = 1;
  for (let steps = 0; node && steps < 10000; steps++) {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) { node = node.expression; continue; }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const entry = calls.get(name) ?? { name, calls: 0, access: node.expression };
      entry.calls++; calls.set(name, entry);
      node = node.expression.expression;
      continue;
    }
    const decl = ts.isIdentifier(node) && statements < 50 ? checker.getSymbolAtLocation(node)?.valueDeclaration : null;
    if (!decl || !ts.isVariableDeclaration(decl) || decl.type || !decl.initializer) break;
    node = decl.initializer; statements++;
  }
  const lead = [...calls.values()].sort((a, b) => b.calls - a.calls)[0];
  if (!lead || lead.calls < BUILDER_CHAIN.minCalls) return null;
  const methods = checker.getSymbolAtLocation(lead.access.name)?.declarations ?? [];
  const nameOf = typeName => ts.isQualifiedName(typeName) ? typeName.right.text : typeName.text;
  // A type node that is the class, a type parameter of the method constrained to it, or an alias of it.
  const names = (type, method, className, depth = 0) => {
    if (!type || depth > 3) return false;
    if (ts.isUnionTypeNode(type)) return type.types.some(t => names(t, method, className, depth + 1));
    if (!ts.isTypeReferenceNode(type)) return false;
    const name = nameOf(type.typeName);
    if (name === className) return true;
    const parameter = method.typeParameters?.find(p => p.name.text === name);
    if (parameter) return names(parameter.constraint, method, className, depth + 1);
    let symbol = checker.getSymbolAtLocation(ts.isQualifiedName(type.typeName) ? type.typeName.right : type.typeName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).some(d => ts.isTypeAliasDeclaration(d) && names(d.type, method, className, depth + 1));
  };
  for (const method of methods) {
    const owner = method.parent;
    if (!(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || !owner.name) continue;
    const className = owner.name.text;
    const own = methods.filter(m => m.parent === owner);
    if (!own.some(m => m.type && ts.isTypeReferenceNode(m.type) && nameOf(m.type.typeName) === className)) continue;
    const takes = own.find(m => m.parameters?.some(p => names(p.type, m, className)));
    if (!takes) continue;
    const file = takes.getSourceFile(), at = file.getLineAndCharacterOfPosition(takes.getStart(file));
    return { method: clean(lead.name), calls: lead.calls, statements, className: clean(className),
      methodLocation: { file: display(base, path.resolve(file.fileName)), line: at.line + 1, character: at.character + 1 } };
  }
  return null;
}

function builderChainDiagnosis({ site, siteLocation, chain, owners, depth, milliseconds, share }) {
  const { method, calls, statements, className, methodLocation } = chain;
  const groups = Math.ceil(calls / BUILDER_CHAIN.groupSize), size = Math.ceil(calls / groups);
  const summary = [`${site.code} at this place: ${site.message}`,
    `The chain at this place calls .${method}() ${calls} times${statements > 1 ? `, across ${statements} statements` : ''}. ` +
      `${method} takes and returns ${className} (${methodLocation.file}:${methodLocation.line}).`,
    `Each call builds its ${className} type from the one before it. The compiler hit the instantiation limit inside ${className}.`].map(clean);
  const details = [...summary, ...owners.map(o => `type #${o.typeId} ${o.typeName}: ${o.events} limit events, depth ${o.maxDepth}${o.alias ? `, inside ${o.alias}` : ''}`),
    ...(depth?.maxInstantiationCount ? [`largest instantiation count in the events: ${depth.maxInstantiationCount}`] : [])];
  return { pattern: 'builder-chain', confidence: 'measured',
    title: `${calls} calls of .${method}() build one ${className} type`,
    location: siteLocation, milliseconds, checkTimeShareUpperBoundPercent: share,
    evidence: { event: depth?.events ? depth.event : null, compilerError: site, method, calls, statements, className, methodLocation,
      limitEvents: depth?.events ?? 0, maxInstantiationCount: depth?.maxInstantiationCount ?? 0, types: owners, milliseconds, summary, details },
    remedy: `Build the ${calls} calls as ${groups} separate ${className} values of at most ${size} calls each. ` +
      `Then join those values with .${method}() on one ${className}. ` +
      'Cutting the chain into variables is not enough: the type is still one chain. Measure again after the change.',
    docs: PERFORMANCE_DOCS };
}

// A value declared with a written type in a declaration file, reached from the type at an error position through type aliases
// and typeof, whose type nests one of the types at the limit many levels deep. A declaration file writes an inferred type out in
// full; read back, the levels are expanded one inside the other in one instantiation.
export const NESTED_DECLARATION = {
  minLevels: 8   // fewer levels than this are not reported
};

function nestedDeclaration(graph, base, error, aliases) {
  if (!error?.file || !error.line || !graph.program || !aliases.size) return null;
  const source = findSource(path.resolve(base, error.file), graph);
  if (!source) return null;
  const { ts } = graph;
  const pos = source.getPositionOfLineAndCharacter(error.line - 1, Math.max(0, (error.character ?? 1) - 1));
  const site = nodeAt(ts, source, pos).reverse().find(n => (ts.isTypeReferenceNode(n) || ts.isTypeQueryNode(n)) && n.getStart(source) === pos);
  if (!site) return null;
  const checker = graph.checker ??= graph.program.getTypeChecker();
  const declarationsOf = name => {
    let symbol = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  const nameOf = typeName => ts.isQualifiedName(typeName) ? typeName.right.text : typeName.text;
  const levels = (node, name) => {
    let deepest = 0;
    ts.forEachChild(node, child => { deepest = Math.max(deepest, levels(child, name)); });
    return deepest + (ts.isTypeReferenceNode(node) && nameOf(node.typeName) === name ? 1 : 0);
  };
  const queue = [site], seen = new Set();
  let best = null;
  for (let i = 0; i < queue.length && i < 500; i++) {
    const node = queue[i];
    if (ts.isTypeQueryNode(node)) {
      for (const decl of declarationsOf(node.exprName)) {
        const file = decl.getSourceFile();
        if (seen.has(decl) || !ts.isVariableDeclaration(decl) || !decl.type || !file.isDeclarationFile || graph.program.isSourceFileDefaultLibrary(file)) continue;
        seen.add(decl);
        for (const generic of aliases) {
          const n = levels(decl.type, generic);
          if (n >= NESTED_DECLARATION.minLevels && n > (best?.levels ?? 0)) best = { decl, generic, levels: n };
        }
      }
      continue;
    }
    if (ts.isTypeReferenceNode(node)) {
      for (const decl of declarationsOf(node.typeName)) if (ts.isTypeAliasDeclaration(decl) && !seen.has(decl)) { seen.add(decl); queue.push(decl.type); }
    }
    ts.forEachChild(node, child => { queue.push(child); });
  }
  if (!best) return null;
  const file = best.decl.getSourceFile(), at = file.getLineAndCharacterOfPosition(best.decl.getStart(file));
  return { name: clean(best.decl.name.getText(file)), generic: clean(best.generic), levels: best.levels,
    location: { file: display(base, path.resolve(file.fileName)), line: at.line + 1, character: at.character + 1 } };
}

function nestedDeclarationDiagnosis({ site, siteLocation, nested, owners, depth, milliseconds, share }) {
  const { name, generic, levels, location } = nested;
  const inDependency = location.file.split('/').includes('node_modules');
  const summary = [`${site.code} at this place: ${site.message}`,
    `The type at this place comes from ${name} (${location.file}:${location.line}). Its declared type nests ${generic} ${levels} levels deep.`,
    `A declaration file writes an inferred type out in full. The compiler hit the instantiation limit inside ${generic} when it read the levels back.`].map(clean);
  const details = [...summary, ...owners.map(o => `type #${o.typeId} ${o.typeName}: ${o.events} limit events, depth ${o.maxDepth}${o.alias ? `, inside ${o.alias}` : ''}`),
    ...(depth?.maxInstantiationCount ? [`largest instantiation count in the events: ${depth.maxInstantiationCount}`] : [])];
  return { pattern: 'nested-declaration', confidence: 'measured',
    title: `${generic} nested ${levels} levels deep in the declared type of ${name}`,
    location: siteLocation, milliseconds, checkTimeShareUpperBoundPercent: share,
    evidence: { event: depth?.events ? depth.event : null, compilerError: site, name, generic, levels, location,
      limitEvents: depth?.events ?? 0, maxInstantiationCount: depth?.maxInstantiationCount ?? 0, types: owners, milliseconds, summary, details },
    remedy: `Write the data type of ${name} by hand as named interfaces. In the source, annotate ${name} with a type that names them. ` +
      `Then ${location.file} refers to the names and does not write out the ${levels} levels. ` +
      (inDependency ? 'The declaration is in a dependency, so tell its maintainers. ' : '') + 'Measure again after the change.',
    docs: PERFORMANCE_DOCS };
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
  // The limit was hit inside the generic type that a constraint at the error site names with too few type arguments.
  const partial = graph ? partialConstraints(graph, base, site).find(p => owners.some(o => o.alias === p.generic &&
    o.aliasLocation?.file === p.genericLocation.file)) : null;
  if (partial) return partialConstraintDiagnosis({ site, siteLocation, partial, owners, depth, milliseconds,
    share: interval ? share(milliseconds, checkSeconds) : null });
  // The limit was hit outside the conditional type alias that gets an instantiation expression as a type argument.
  const expression = graph ? instantiationExpressionArguments(graph, base, site).find(e => !owners.some(o => o.alias === e.generic)) : null;
  if (expression) return instantiationExpressionDiagnosis({ site, siteLocation, found: expression, owners, depth, milliseconds,
    share: interval ? share(milliseconds, checkSeconds) : null });
  // The limit was hit inside the class that a long chain of plugin calls at the error site builds.
  const chain = graph ? builderChain(graph, base, site) : null;
  if (chain && owners.some(o => o.alias === chain.className)) return builderChainDiagnosis({ site, siteLocation, chain, owners, depth, milliseconds,
    share: interval ? share(milliseconds, checkSeconds) : null });
  // The limit was hit inside a type that the declaration file of a value at the error site writes out many levels deep.
  const nested = graph ? nestedDeclaration(graph, base, site, new Set(owners.map(o => o.alias).filter(Boolean))) : null;
  if (nested) return nestedDeclarationDiagnosis({ site, siteLocation, nested, owners, depth, milliseconds,
    share: interval ? share(milliseconds, checkSeconds) : null });
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

// ---- Program load ------------------------------------------------------------------------------------
// A program can be large while the check is cheap: one import pulls hundreds of declaration files, and the compiler
// spends its time and memory on reading, parsing and binding them. The signal is the program itself, not the trace.
// All limits must hold. They keep the diagnosis away from small programs and from programs whose time is the check.
export const PROGRAM_LOAD = {
  minDependencyFiles: 200,   // files under node_modules, without the compiler library files
  minTotalSeconds: 1,        // Total time of the traced run
  maxCheckShare: 0.1,        // Check time as a share of Total time
  maxCheckSeconds: 1,        // and in absolute terms
  minLeadFiles: 100,         // files that only the lead file brings into the program
  minLeadShare: 0.25,        // and as a share of all dependency files
  descendShare: 0.8          // a child file continues the walk down when it brings at least this share of its parent
};

const slashed = file => file.split(path.sep).join('/');
const isDependencyFile = file => slashed(file).includes('/node_modules/');

function packageName(file) {
  const parts = slashed(file).split('/node_modules/').pop().split('/');
  return parts[0].startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

// Immediate dominators over the import graph, with a virtual root before all configured roots (Cooper, Harvey, Kennedy).
// A file dominates another when every import path from the roots to the other file passes through it.
function dominatorTree(edges, rootFiles) {
  const ids = new Map(), files = [null];
  const idOf = file => { if (!ids.has(file)) { ids.set(file, files.length); files.push(file); } return ids.get(file); };
  const successors = [rootFiles.map(idOf)];
  // Iterative depth-first search from the virtual root: reverse post order is the visit order of the iteration below.
  const order = [], state = [];
  const stack = [[0, 0]];
  state[0] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const list = successors[top[0]] ??= [...(edges.get(files[top[0]]) ?? [])].map(idOf);
    if (top[1] < list.length) {
      const next = list[top[1]++];
      if (!state[next]) { state[next] = 1; stack.push([next, 0]); }
    } else { order.push(top[0]); stack.pop(); }
  }
  const post = new Array(files.length).fill(-1);
  order.forEach((id, i) => { post[id] = i; });
  const predecessors = files.map(() => []);
  for (const id of order) for (const next of successors[id] ?? []) if (post[next] >= 0) predecessors[next].push(id);
  const idom = new Array(files.length).fill(-1);
  idom[0] = 0;
  const meet = (a, b) => { while (a !== b) { while (post[a] < post[b]) a = idom[a]; while (post[b] < post[a]) b = idom[b]; } return a; };
  for (let changed = true; changed;) {
    changed = false;
    for (let i = order.length - 2; i >= 0; i--) {
      const id = order[i];
      let best = -1;
      for (const p of predecessors[id]) if (idom[p] !== -1) best = best === -1 ? p : meet(p, best);
      if (best !== idom[id]) { idom[id] = best; changed = true; }
    }
  }
  return { files, order, idom };
}

function megabytes(bytes) { return Number((bytes / 1048576).toFixed(1)); }
const secondsText = value => Number(Number(value).toFixed(2));

// How many files, and how many bytes, enter the program only through each file.
function programLoadLead(graph, sizes, dependencyTotal) {
  const roots = [...graph.roots].filter(file => graph.files.has(file));
  const { files, order, idom } = dominatorTree(graph.edges, roots);
  const own = files.map(file => file ? sizes.get(file) : null);
  const subtree = files.map((file, id) => ({ files: file && own[id]?.kind === 'dependency' ? 1 : 0, bytes: file && own[id]?.kind === 'dependency' ? own[id].bytes : 0 }));
  for (const id of order) if (id !== 0 && idom[id] > 0) { subtree[idom[id]].files += subtree[id].files; subtree[idom[id]].bytes += subtree[id].bytes; }
  const children = files.map(() => []);
  for (const id of order) if (id !== 0) children[idom[id]].push(id);
  const dependency = id => own[id]?.kind === 'dependency';
  // The start is the dependency entry that brings the most files. Then walk down while one child brings almost all of them.
  let current = order.filter(id => id !== 0 && dependency(id) && !dependency(idom[id]))
    .sort((a, b) => subtree[b].files - subtree[a].files || a - b)[0];
  if (current === undefined) return null;
  const entry = current;
  for (;;) {
    const next = children[current].filter(dependency).sort((a, b) => subtree[b].files - subtree[a].files || a - b)[0];
    if (next === undefined || subtree[next].files < PROGRAM_LOAD.descendShare * subtree[current].files) break;
    current = next;
  }
  if (subtree[current].files < PROGRAM_LOAD.minLeadFiles || subtree[current].files < PROGRAM_LOAD.minLeadShare * dependencyTotal) return null;
  return { file: files[current], entry: files[entry], files: subtree[current].files, bytes: subtree[current].bytes };
}

// Dependency files that stop being reachable from the roots when the edges from one file to some targets are removed.
function filesLostWithout(graph, sizes, from, targets) {
  const roots = [...graph.roots].filter(file => graph.files.has(file));
  const walk = skip => {
    const seen = new Set(roots), stack = [...roots];
    while (stack.length) {
      const file = stack.pop();
      for (const next of graph.edges.get(file) ?? []) {
        if (seen.has(next) || (skip && file === from && targets.has(next))) continue;
        seen.add(next); stack.push(next);
      }
    }
    return seen;
  };
  const before = walk(false), after = walk(true);
  let files = 0, bytes = 0;
  for (const file of before) if (!after.has(file) && sizes.get(file)?.kind === 'dependency') { files++; bytes += sizes.get(file).bytes; }
  return { files, bytes };
}

// typeof import('pkg') references in the files on the chain to the lead file: how many, and how many files only they bring.
// The file with the largest set wins.
function importTypeCost(graph, sizes, base, chain) {
  let best = null;
  for (const name of chain) {
    const file = path.resolve(base, name);
    const counts = graph.importTypes?.get(file);
    if (!counts?.size || sizes.get(file)?.kind !== 'dependency') continue;
    const group = filesLostWithout(graph, sizes, file, new Set(counts.keys()));
    if (group.files >= PROGRAM_LOAD.minLeadFiles && (!best || group.files > best.group.files)) best = { file, counts, group };
  }
  if (!best) return null;
  const targets = [...best.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([target, references]) => {
    const own = filesLostWithout(graph, sizes, best.file, new Set([target]));
    return { file: display(base, target), references, filesOnlyThroughIt: own.files, megabytesOnlyThroughIt: megabytes(own.bytes) };
  });
  return { file: display(base, best.file), references: [...best.counts.values()].reduce((a, b) => a + b, 0),
    filesOnlyThroughThem: best.group.files, megabytesOnlyThroughThem: megabytes(best.group.bytes), targets };
}

function chainSummary(chain) {
  return chain.length > 6 ? [...chain.slice(0, 2), '...', ...chain.slice(-3)].join(' -> ') : chain.join(' -> ');
}

export function programLoadDiagnosis({ graph, base, diagnostics }) {
  const total = diagnostics?.['Total time']?.value, check = diagnostics?.['Check time']?.value;
  if (!graph || !Number.isFinite(total) || !Number.isFinite(check)) return null;
  if (total < PROGRAM_LOAD.minTotalSeconds || check > PROGRAM_LOAD.maxCheckSeconds || check > PROGRAM_LOAD.maxCheckShare * total) return null;
  const sizes = new Map(), packages = new Map();
  let libraryFiles = 0, projectFiles = 0, dependencyFiles = 0, dependencyBytes = 0;
  for (const [file, source] of graph.files) {
    if (graph.program.isSourceFileDefaultLibrary(source)) { libraryFiles++; sizes.set(file, { kind: 'library' }); continue; }
    if (!isDependencyFile(file)) { projectFiles++; sizes.set(file, { kind: 'project' }); continue; }
    const bytes = Buffer.byteLength(source.text);
    dependencyFiles++; dependencyBytes += bytes; sizes.set(file, { kind: 'dependency', bytes });
    const entry = packages.get(packageName(file)) ?? { name: packageName(file), files: 0, bytes: 0 };
    entry.files++; entry.bytes += bytes; packages.set(entry.name, entry);
  }
  if (dependencyFiles < PROGRAM_LOAD.minDependencyFiles) return null;
  const lead = programLoadLead(graph, sizes, dependencyFiles);
  if (!lead) return null;
  const leadName = display(base, lead.file), entryName = display(base, lead.entry);
  const chain = explainFile(graph, lead.file, base).chain;
  const importedBy = [...(graph.incoming.get(lead.file) ?? [])].map(f => display(base, f)).sort().slice(0, 5);
  const top = [...packages.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, 5)
    .map(p => ({ name: clean(p.name), files: p.files, megabytes: megabytes(p.bytes) }));
  const memory = diagnostics['Memory used'];
  const memoryMegabytes = memory ? Math.round(memory.unit === 'K' ? memory.value / 1024 : memory.unit === 'M' ? memory.value : memory.value / 1048576) : null;
  const phases = ['I/O Read time', 'Parse time', 'Bind time', 'ResolveModule time'].filter(k => diagnostics[k]).map(k => `${k.replace(' time', '')} ${secondsText(diagnostics[k].value)}s`);
  const typeCost = importTypeCost(graph, sizes, base, chain);
  const loadSeconds = total - check;
  const programFiles = graph.files.size;
  const summary = [
    `The program has ${programFiles} files: ${dependencyFiles} in node_modules (${megabytes(dependencyBytes)} MB of source), ${libraryFiles} compiler library files and ${projectFiles} of your own. Check time is ${secondsText(check)}s of ${secondsText(total)}s.` +
      `${memoryMegabytes != null ? ` Memory used ${memoryMegabytes} MB in the traced run.` : ''}${phases.length ? ` Phases: ${phases.join(', ')}.` : ''}`,
    `Largest packages by files: ${top.map(p => `${p.name} ${p.files} (${p.megabytes} MB)`).join(', ')}.`,
    `${leadName} is the file that brings ${lead.files} of these files (${megabytes(lead.bytes)} MB). No other import reaches them.` + (importedBy.length ? ` Imported by ${importedBy.join(', ')}.` : ''),
    ...(typeCost ? [`${typeCost.filesOnlyThroughThem} of them (${typeCost.megabytesOnlyThroughThem} MB) come only through ${typeCost.references} typeof import() type references in ${typeCost.file}, to ${typeCost.targets.map(t => `${t.file} (${t.references})`).join(', ')}.`] : []),
    `Shortest import chain: ${chainSummary(typeCost && !chain.includes(typeCost.targets[0].file) ? [...chain, typeCost.targets[0].file] : chain)}`
  ].map(clean);
  return { pattern: 'program-load', confidence: 'measured',
    title: `Program load: ${dependencyFiles} dependency files, ${top[0].name} has ${top[0].files}; Check time is ${secondsText(check)}s of ${secondsText(total)}s`,
    location: { file: leadName, line: 1, character: 1 }, milliseconds: loadSeconds * 1000, checkTimeShareUpperBoundPercent: null,
    evidence: { programFiles, dependencyFiles, libraryFiles, projectFiles, dependencyMegabytes: megabytes(dependencyBytes),
      checkSeconds: check, totalSeconds: total, memoryMegabytes, packages: top, entry: entryName,
      lead: { file: leadName, filesOnlyThroughIt: lead.files, megabytesOnlyThroughIt: megabytes(lead.bytes), importedBy, chain,
        ...(typeCost ? { importTypeReferences: typeCost } : {}) },
      location: { file: leadName }, thresholds: { ...PROGRAM_LOAD }, summary,
      details: [...summary, ...chain.map((f, i) => `chain ${i + 1}: ${f}`)] },
    remedy: (typeCost
      ? `Each typeof import() reference in ${typeCost.file} loads its target for every project that imports the package. Ask the maintainers to move them to an opt-in entry point. `
      : `The files of ${leadName} enter the program only through it. See why ${top[0].name} needs that file. Use a narrower entry point of the package if it has one, or tell its maintainers about the chain. `) +
      'skipLibCheck skips checking these files, not loading them. Measure Files and Memory used again after each change.',
    docs: PERFORMANCE_DOCS };
}

export function buildDiagnoses(context) {
  const list = [];
  // Program load needs no trace signal: it reads the import graph and the compiler counters.
  if (context.graph && context.diagnostics) list.push(programLoadDiagnosis(context));
  if (context.signals) list.push(recursionDiagnosis(context), varianceDiagnosis(context.signals, context.describe, context.checkSeconds));
  // A diagnosis of a TS2589 error comes first: the compiler already reported an error for it.
  const first = d => ['recursive-type-instantiation', 'partial-constraint', 'instantiation-expression', 'builder-chain', 'nested-declaration'].includes(d.pattern);
  return list.filter(Boolean).sort((a, b) => first(b) - first(a) || b.milliseconds - a.milliseconds).slice(0, MAX_DIAGNOSES);
}
