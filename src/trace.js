import path from 'node:path';

const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const display = (base, file) => clean(path.relative(base, file).split(path.sep).join('/') || '.');
const sourceChecks = new Set(['checkExpression', 'checkVariableDeclaration']);
const names = new Set(['checkSourceFile', 'structuredTypeRelatedTo', ...sourceChecks]);

// Complete events can be written at the end of a span, out of timestamp order.
// Begin/end stacks belong to a process/thread, never to the whole trace.
export function traceSpans(events) {
  const stacks = new Map(), spans = [];
  const record = (event, end) => {
    if (names.has(event.name) && Number.isFinite(event.ts) && Number.isFinite(end) && end >= event.ts) {
      spans.push({ ...event, end, thread: `${event.pid}:${event.tid}` });
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
      if (start) record(start, event.ts);
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
const findSource = (file, graph) => graph.files.get(file) ?? graph.program.getSourceFile(file);

function scope(file, graph) {
  const source = findSource(file, graph);
  if (!source) return 'unknown';
  return graph.program.isSourceFileDefaultLibrary(source) || graph.program.isSourceFileFromExternalLibrary(source)
    ? 'dependency' : 'project';
}

function sourceLocation(span, base, graph) {
  if (!sourceChecks.has(span.name) || typeof span.args?.path !== 'string') return null;
  const file = path.resolve(base, span.args.path), source = findSource(file, graph);
  const { pos, end } = span.args;
  if (!source || !Number.isInteger(pos) || !Number.isInteger(end) || pos < 0 || end <= pos || end > source.text.length) return null;
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
    // Declaration locations also include trivia. Skip whitespace only within the reported span.
    if (source && line <= source.getLineStarts().length) {
      let pos = source.getLineStarts()[line - 1] + character - 1;
      const endLine = declaration.end?.line, endCharacter = declaration.end?.character;
      const end = Number.isInteger(endLine) && endLine > 0 && endLine <= source.getLineStarts().length && Number.isInteger(endCharacter)
        ? source.getLineStarts()[endLine - 1] + endCharacter - 1 : pos;
      while (pos < end && /\s/.test(source.text[pos] ?? '')) pos++;
      const location = source.getLineAndCharacterOfPosition(Math.min(pos, source.text.length));
      line = location.line + 1; character = location.character + 1;
    }
    result.declaration = { file: display(base, source ? path.resolve(source.fileName) : file), line, character, scope: scope(file, graph) };
  }
  return result;
}

const priority = value => value.scope === 'project' ? 0 : value.scope === 'dependency' ? 1 : 2;
const rank = (a, b) => priority(a) - priority(b) || b.milliseconds - a.milliseconds;

// A contained comparison is context, not proof that its types cause a slowdown.
export function traceDetails(events, descriptors, base, graph) {
  const spans = traceSpans(events), sources = new Map(), comparisons = new Map(), contexts = new Map();
  spans.sort((a, b) => a.ts - b.ts || b.end - a.end || Number(sourceChecks.has(b.name)) - Number(sourceChecks.has(a.name)));
  for (const span of spans) {
    const stack = contexts.get(span.thread) ?? [];
    contexts.set(span.thread, stack);
    while (stack.length && (stack.at(-1).span.end < span.end || stack.at(-1).span.end <= span.ts)) stack.pop();
    if (sourceChecks.has(span.name) && typeof span.args?.path === 'string') {
      const { pos, end } = span.args;
      const file = path.resolve(base, span.args.path), source = findSource(file, graph);
      if (!source || !Number.isInteger(pos) || !Number.isInteger(end) || pos < 0 || end <= pos || end > source.text.length) continue;
      const key = JSON.stringify([file, pos, end, span.name]);
      if (!sources.has(key)) sources.set(key, { span, ranges: [], comparisons: new Map(), scope: scope(file, graph) });
      const group = sources.get(key);
      group.ranges.push([span.ts, span.end]);
      stack.push({ span, group });
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
  const files = fileIntervals(spans, base, graph);
  return { hotspots: files.slice(0, 5),
    projectHotspots: fileIntervals(spans, base, graph, file => scope(file, graph) === 'project').slice(0, 5), sourceHotspots, typeHotspots };
}
