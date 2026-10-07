import path from 'node:path';

const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const display = (base, file) => clean(path.relative(base, file).split(path.sep).join('/') || '.');
const sourceChecks = new Set(['checkExpression', 'checkVariableDeclaration']);
const names = new Set(['checkSourceFile', 'structuredTypeRelatedTo', ...sourceChecks]);

// Complete events can be written at the end of a span, out of timestamp order.
// Begin/end stacks belong to a process/thread, never to the whole trace.
export function traceSpans(events, wanted = names) {
  const stacks = new Map(), spans = [];
  // endArgs: native (TypeScript 7) traces write some results on the end event.
  const record = (event, end, endArgs) => {
    if (wanted.has(event.name) && Number.isFinite(event.ts) && Number.isFinite(end) && end >= event.ts) {
      spans.push({ ...event, end, ...(endArgs ? { endArgs } : {}), thread: `${event.pid}:${event.tid}` });
    }
  };
  for (const event of events) {
    const thread = `${event.pid}:${event.tid}`;
    if (event.ph === 'X' && Number.isFinite(event.dur)) record(event, event.ts + event.dur);
    else if (event.ph === 'B') {
      if (!stacks.has(thread)) stacks.set(thread, []);
      stacks.get(thread).push(event);
    } else if (event.ph === 'E') {
      const start = stacks.get(thread)?.pop();
      if (start) record(start, event.ts, event.args);
    }
  }
  return spans;
}

// Inclusive samples cannot be added together when they overlap.
function milliseconds(ranges) {
  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0, left = ranges[0][0], right = ranges[0][1];
  for (let i = 1; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    if (a <= right) right = Math.max(right, b);
    else { total += right - left; left = a; right = b; }
  }
  return (total + right - left) / 1000;
}

function fileIntervals(spans, base, graph, include = () => true) {
  const files = new Map();
  for (const span of spans) {
    if (span.name !== 'checkSourceFile' || typeof span.args?.path !== 'string') continue;
    const recordedFile = path.resolve(base, span.args.path);
    const source = graph ? findSource(recordedFile, graph) : null;
    const file = source ? path.resolve(source.fileName) : recordedFile;
    if (!include(file)) continue;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push([span.ts, span.end]);
  }
  return [...files].map(([file, ranges]) => ({ file: display(base, file), milliseconds: milliseconds(ranges) }))
    .sort((a, b) => b.milliseconds - a.milliseconds || a.file.localeCompare(b.file));
}

export function traceHotspots(events, base) {
  return fileIntervals(traceSpans(events), base);
}

// TypeScript trace paths can use canonical casing on case-insensitive hosts.
export const findSource = (file, graph) => graph?.files.get(file) ?? graph?.program.getSourceFile(file) ??
  (graph?.native ? graph.lowerFiles?.get(file.toLowerCase()) : undefined);

// Native (Go) trace offsets are UTF-8 byte offsets; 5.x/6.x and this tool's AST use UTF-16 code units.
const byteMaps = new WeakMap();
function utf16Offset(source, byteOffset) {
  const text = source.text;
  let map = byteMaps.get(source);
  if (map === undefined) {
    map = null;
    if (Buffer.byteLength(text) !== text.length) {
      map = new Map(); let bytes = 0;
      for (let i = 0; i < text.length; i++) {
        map.set(bytes, i);
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1; else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) { bytes += 4; i++; } else bytes += 3;
      }
      map.set(bytes, text.length);
    }
    byteMaps.set(source, map);
  }
  return map === null ? byteOffset : (map.get(byteOffset) ?? -1);
}

// Convert a native span's byte offsets in place; spans whose offsets are not on a character boundary are dropped.
function normalizeNative(spans, base, graph) {
  if (!graph?.native) return spans;
  const kept = [];
  for (const span of spans) {
    if (!sourceChecks.has(span.name)) { kept.push(span); continue; }
    const source = typeof span.args?.path === 'string' ? findSource(path.resolve(base, span.args.path), graph) : null;
    if (!source) { kept.push(span); continue; }
    const pos = utf16Offset(source, span.args.pos), end = utf16Offset(source, span.args.end);
    if (pos < 0 || end < 0) continue;
    kept.push({ ...span, args: { ...span.args, pos, end } });
  }
  return kept;
}
const identifierKind = graph => graph?.native?.identifierKind ?? graph?.ts?.SyntaxKind.Identifier ?? 80;

// The native package bundles its own lib.*.d.ts files, which are not in the JavaScript API's program.
const nativeLib = /\/@typescript\/typescript-[^/]+\/lib\/lib\.[^/]*\.d\.ts$/i;

function scope(file, graph) {
  const source = findSource(file, graph);
  if (!source) return graph?.native && nativeLib.test(file.split(path.sep).join('/')) ? 'dependency' : 'unknown';
  return graph.program.isSourceFileDefaultLibrary(source) || graph.program.isSourceFileFromExternalLibrary(source)
    ? 'dependency' : 'project';
}

function sourceLocation(span, base, graph) {
  if (!sourceChecks.has(span.name) || typeof span.args?.path !== 'string') return null;
  const file = path.resolve(base, span.args.path), source = findSource(file, graph);
  const { pos, end } = span.args;
  if (!source) return { file: display(base, file), line: null, character: null, pos, end,
    syntaxKind: span.args.kind, scope: 'unknown', snippet: null, locationAvailable: false };
  if (!Number.isInteger(pos) || !Number.isInteger(end) || pos < 0 || end <= pos || end > source.text.length) return null;
  // Trace offsets include trivia. Use the matching AST node's real start when possible.
  let start = pos;
  const visit = node => {
    if (node.pos === pos && node.end === end) { start = node.getStart(source); return true; }
    if (node.pos <= pos && node.end >= end) return node.forEachChild(visit);
    return false;
  };
  visit(source);
  const location = source.getLineAndCharacterOfPosition(start);
  const text = source.text.slice(start, end).replace(/\s+/g, ' ').trim();
  return { file: display(base, path.resolve(source.fileName)), line: location.line + 1, character: location.character + 1,
    pos, end, syntaxKind: span.args.kind, scope: scope(file, graph),
    snippet: clean(text.slice(0, 240)) + (text.length > 240 ? '…' : '') };
}

function describeType(id, types, base, graph) {
  const type = types.get(id);
  if (!type) return { id, label: `type #${id} (unavailable)` };
  const name = ['__type', '__object'].includes(type.symbolName) ? type.display ?? type.symbolName : type.symbolName;
  const result = { id, label: clean(String(name ?? type.display ?? type.intrinsicName ?? `type #${id}`).slice(0, 160)),
    flags: Array.isArray(type.flags) ? type.flags.filter(f => typeof f === 'string').map(clean) : [] };
  if (Array.isArray(type.unionTypes)) result.unionMembers = type.unionTypes.length;
  if (Array.isArray(type.intersectionTypes)) result.intersectionMembers = type.intersectionTypes.length;
  const declaration = type.firstDeclaration ?? type.referenceLocation;
  if (typeof declaration?.path === 'string' && Number.isInteger(declaration.start?.line) && declaration.start.line > 0 &&
    Number.isInteger(declaration.start?.character) && declaration.start.character > 0) {
    const file = path.resolve(base, declaration.path), source = findSource(file, graph);
    let line = declaration.start.line, character = declaration.start.character;
    // Declaration offsets include comments as well as whitespace. Use the project's scanner.
    if (source && line <= source.getLineStarts().length) {
      let pos = source.getLineStarts()[line - 1] + character - 1;
      const endLine = declaration.end?.line, endCharacter = declaration.end?.character;
      const end = Number.isInteger(endLine) && endLine > 0 && endLine <= source.getLineStarts().length && Number.isInteger(endCharacter)
        ? source.getLineStarts()[endLine - 1] + endCharacter - 1 : pos;
      if (graph.ts) {
        const scanner = graph.ts.createScanner(graph.ts.ScriptTarget.Latest, true, source.languageVariant, source.text);
        scanner.setTextPos(pos); scanner.scan();
        if (scanner.getTokenStart() >= pos && scanner.getTokenStart() < end) pos = scanner.getTokenStart();
      } else while (pos < end && /\s/.test(source.text[pos] ?? '')) pos++;
      const location = source.getLineAndCharacterOfPosition(Math.min(pos, source.text.length));
      line = location.line + 1; character = location.character + 1;
    }
    result.declaration = { file: display(base, source ? path.resolve(source.fileName) : file), line, character, scope: scope(file, graph) };
    if (!source) result.declaration.locationKind = 'trace';
  }
  return result;
}

const priority = value => value.scope === 'project' ? 0 : value.scope === 'dependency' ? 1 : 2;
const rank = (a, b) => priority(a) - priority(b) || b.milliseconds - a.milliseconds;

// A contained comparison is context, not proof that its types cause a slowdown.
export function traceDetails(events, descriptors, base, graph = null) {
  const spans = normalizeNative(traceSpans(events), base, graph), sources = new Map(), comparisons = new Map(), contexts = new Map(), chains = new Map();
  spans.sort((a, b) => a.ts - b.ts || b.end - a.end || Number(sourceChecks.has(b.name)) - Number(sourceChecks.has(a.name)));
  for (const span of spans) {
    const stack = contexts.get(span.thread) ?? [];
    contexts.set(span.thread, stack);
    while (stack.length && (stack.at(-1).span.end < span.end || stack.at(-1).span.end <= span.ts)) stack.pop();
    if (sourceChecks.has(span.name) && typeof span.args?.path === 'string') {
      const { pos, end } = span.args;
      const file = path.resolve(base, span.args.path), source = findSource(file, graph);
      if ((graph && !source) || !Number.isInteger(pos) || !Number.isInteger(end) || pos < 0 || end <= pos || (source && end > source.text.length)) continue;
      const key = JSON.stringify([file, pos, end, span.name]);
      if (!sources.has(key)) sources.set(key, { span, ranges: [], comparisons: new Map(), scope: scope(file, graph) });
      const group = sources.get(key);
      group.ranges.push([span.ts, span.end]);
      const parent = stack.at(-1);
      const parentFile = parent && path.resolve(base, parent.span.args.path);
      let chain;
      if (parentFile === file) chain = parent.chain;
      else {
        // Temporal containment, not AST containment: deferred checks can visit earlier lines.
        const chainKey = `${span.thread}:${key}`;
        if (!chains.has(chainKey)) chains.set(chainKey, { span, ranges: [], members: new Map(), comparisons: new Map(), scope: group.scope });
        chain = chains.get(chainKey); chain.ranges.push([span.ts, span.end]);
      }
      const depth = parent?.chain === chain ? parent.depth + 1 : 0;
      if (!chain.members.has(key)) chain.members.set(key, { span, ranges: [], depth });
      const member = chain.members.get(key);
      member.ranges.push([span.ts, span.end]); member.depth = Math.max(member.depth, depth);
      stack.push({ span, group, chain, depth });
    } else if (span.name === 'structuredTypeRelatedTo') {
      const { sourceId, targetId } = span.args ?? {};
      if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) continue;
      const key = `${sourceId}:${targetId}`;
      if (!comparisons.has(key)) comparisons.set(key, { sourceId, targetId, ranges: [] });
      comparisons.get(key).ranges.push([span.ts, span.end]);
      const context = stack.at(-1)?.group;
      if (context) {
        if (!context.comparisons.has(key)) context.comparisons.set(key, { sourceId, targetId, ranges: [] });
        context.comparisons.get(key).ranges.push([span.ts, span.end]);
        const chain = stack.at(-1).chain;
        if (!chain.comparisons.has(key)) chain.comparisons.set(key, { sourceId, targetId, ranges: [] });
        chain.comparisons.get(key).ranges.push([span.ts, span.end]);
      }
    }
  }
  const types = new Map(descriptors.filter(t => Number.isInteger(t?.id)).map(t => [t.id, t]));
  const describeComparison = group => ({ milliseconds: group.milliseconds,
    source: describeType(group.sourceId, types, base, graph), target: describeType(group.targetId, types, base, graph) });
  const orderedComparisons = groups => [...groups.values()].map(g => ({ ...g, milliseconds: milliseconds(g.ranges) }))
    .sort((a, b) => b.milliseconds - a.milliseconds);
  const sourceHotspots = [...sources.values()].map(group => ({ ...group, milliseconds: milliseconds(group.ranges) }))
    .sort(rank).slice(0, 5).map(group => ({ ...sourceLocation(group.span, base, graph), event: group.span.name,
      milliseconds: group.milliseconds, comparisons: orderedComparisons(group.comparisons).slice(0, 3).map(describeComparison) }));
  const typeHotspots = orderedComparisons(comparisons).slice(0, 5).map(describeComparison);
  const sourceGroups = [...chains.values()].map(chain => ({ ...chain, milliseconds: milliseconds(chain.ranges) }))
    .sort(rank).slice(0, 5).map(chain => {
      const members = [...chain.members.values()].map(m => ({ ...m, milliseconds: milliseconds(m.ranges) }))
        .sort((a, b) => b.milliseconds - a.milliseconds);
      // Focus on a specific non-identifier check still covering most of this chain's interval.
      const useful = members.filter(m => m.milliseconds >= chain.milliseconds * 0.8 &&
        m.span.args.kind !== identifierKind(graph));
      const focus = useful.sort((a, b) => b.depth - a.depth || b.milliseconds - a.milliseconds)[0] ?? members[0];
      const shown = [focus, ...members.filter(m => m !== focus)].slice(0, 5);
      return { ...sourceLocation(focus.span, base, graph), event: focus.span.name, milliseconds: chain.milliseconds,
        focusMilliseconds: focus.milliseconds, memberCount: members.length, relationship: 'same-thread temporal containment',
        root: { ...sourceLocation(chain.span, base, graph), event: chain.span.name },
        members: shown.map(m => ({ ...sourceLocation(m.span, base, graph), event: m.span.name, milliseconds: m.milliseconds, depth: m.depth })),
        comparisons: orderedComparisons(chain.comparisons).slice(0, 3).map(describeComparison) };
    });
  const files = fileIntervals(spans, base, graph);
  return { hotspots: files.slice(0, 5),
    projectHotspots: fileIntervals(spans, base, graph, file => scope(file, graph) === 'project').slice(0, 5), sourceHotspots, sourceGroups, typeHotspots };
}

// Resolve one type id to a label and declaration, with the same rules as the comparison lists.
export function typeDescriber(descriptors, base, graph = null) {
  const types = new Map(descriptors.map(type => [type.id, type]));
  return id => describeType(id, types, base, graph);
}

export function selectedTypeIds(details) {
  const ids = new Set();
  for (const comparison of [...details.typeHotspots,
    ...details.sourceHotspots.flatMap(h => h.comparisons), ...details.sourceGroups.flatMap(h => h.comparisons)]) {
    ids.add(comparison.source.id); ids.add(comparison.target.id);
  }
  return ids;
}

// Hydration reuses the selected intervals, avoiding a second sort/scan of the trace.
export function resolveTraceTypes(details, descriptors, base, graph = null) {
  const types = new Map(descriptors.map(type => [type.id, type]));
  const comparison = value => ({ ...value, source: describeType(value.source.id, types, base, graph),
    target: describeType(value.target.id, types, base, graph) });
  return { ...details, typeHotspots: details.typeHotspots.map(comparison),
    sourceHotspots: details.sourceHotspots.map(h => ({ ...h, comparisons: h.comparisons.map(comparison) })),
    sourceGroups: details.sourceGroups.map(h => ({ ...h, comparisons: h.comparisons.map(comparison) })) };
}
