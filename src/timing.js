// Statistics and comparison rules for repeated timing runs. Pure functions; no compiler or file access.

export const TIMINGS_MODE = 'untraced, fresh incremental cache for each run, no emit';
// A verdict needs at least this many measured runs on each side.
export const MIN_RUNS_FOR_VERDICT = 3;
// A finding counts as grown or shrunk only when it changes by at least this much. These are display thresholds, not statistics.
export const FINDING_CHANGE_MIN_MS = 10;
export const FINDING_CHANGE_MIN_PERCENT = 10;

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Spread is (max - min) as a percentage of the median.
export function summarize(values) {
  if (!values?.length || values.some(v => !Number.isFinite(v))) return null;
  const mid = median(values), min = Math.min(...values), max = Math.max(...values);
  return { runs: values.length, values: [...values], median: round(mid, 4), min, max, spreadPercent: mid > 0 ? round((max - min) / mid * 100, 1) : null };
}

// Order of the runs for two sides. Each side first runs once as a warm-up. The measured runs then follow in
// pairs, and the order inside a pair flips every time: A B, B A, A B, B A. This keeps a slow drift of the
// machine (thermal state, background load, file cache) from favouring one side.
export function runSchedule(runs, first = 'baseline', second = 'candidate') {
  const steps = [{ side: first, warmup: true }, { side: second, warmup: true }];
  for (let i = 0; i < runs; i++) {
    const pair = i % 2 === 0 ? [first, second] : [second, first];
    steps.push({ side: pair[0], warmup: false }, { side: pair[1], warmup: false });
  }
  return steps;
}

// Chance that every run of one side is slower than every run of the other side, if both sides have the same
// timing distribution: 2 / C(n + m, n). It assumes independent runs. It does not hold under a drift or a load spike.
export function separationChance(n, m) {
  let combinations = 1;
  for (let i = 1; i <= n; i++) combinations = combinations * (m + i) / i;
  return 2 / combinations;
}

// The noise rule. The ranges (min to max) of the two sides either overlap or they do not.
export function judge(baseline, candidate) {
  const delta = baseline && candidate ? {
    deltaMilliseconds: round((candidate.median - baseline.median) * 1000, 0),
    deltaPercent: baseline.median > 0 ? round((candidate.median - baseline.median) / baseline.median * 100, 1) : null
  } : { deltaMilliseconds: null, deltaPercent: null };
  const rule = { name: 'range-overlap', minimumRuns: MIN_RUNS_FOR_VERDICT };
  if (!baseline || !candidate) return { ...delta, verdict: 'unavailable', direction: null, rule };
  if (baseline.runs < MIN_RUNS_FOR_VERDICT || candidate.runs < MIN_RUNS_FOR_VERDICT) return { ...delta, verdict: 'insufficient-runs', direction: null, rule };
  rule.chanceWithoutDifference = Number(separationChance(baseline.runs, candidate.runs).toPrecision(2));
  if (baseline.min <= candidate.max && candidate.min <= baseline.max) return { ...delta, verdict: 'within-noise', direction: null, rule };
  return { ...delta, verdict: 'separated', direction: candidate.median < baseline.median ? 'faster' : 'slower', rule };
}

export function buildTimings({ checkValues, totalValues, exitCodes, files, flags, checkers }) {
  return { mode: TIMINGS_MODE, runs: checkValues.length, checkers: checkers ?? null, flags, compilerFiles: files ?? null,
    compilerExitCodes: exitCodes, checkTime: { unit: 's', ...summarize(checkValues) }, totalTime: { unit: 's', ...summarize(totalValues) } };
}

// Compare two lists of recorded entries ({ key, milliseconds }). A key on one side only is new or gone.
export function diffEntries(baseline, candidate, { minMs = FINDING_CHANGE_MIN_MS, minPercent = FINDING_CHANGE_MIN_PERCENT } = {}) {
  const before = new Map(baseline.map(e => [e.key, e])), after = new Map(candidate.map(e => [e.key, e]));
  const result = { new: [], gone: [], grown: [], shrunk: [], unchanged: [] };
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b) { result.gone.push({ ...a, baselineMilliseconds: a.milliseconds, candidateMilliseconds: null }); continue; }
    const change = b.milliseconds - a.milliseconds;
    const percent = a.milliseconds > 0 ? Math.abs(change) / a.milliseconds * 100 : Infinity;
    const entry = { ...a, baselineMilliseconds: a.milliseconds, candidateMilliseconds: b.milliseconds, deltaMilliseconds: round(change, 1),
      deltaPercent: a.milliseconds > 0 ? round(change / a.milliseconds * 100, 1) : null };
    result[Math.abs(change) >= minMs && percent >= minPercent ? (change > 0 ? 'grown' : 'shrunk') : 'unchanged'].push(entry);
  }
  for (const [key, b] of after) if (!before.has(key)) result.new.push({ ...b, baselineMilliseconds: null, candidateMilliseconds: b.milliseconds });
  const bySize = field => (x, y) => Math.abs(y[field] ?? 0) - Math.abs(x[field] ?? 0);
  result.grown.sort(bySize('deltaMilliseconds')); result.shrunk.sort(bySize('deltaMilliseconds'));
  result.new.sort(bySize('candidateMilliseconds')); result.gone.sort(bySize('baselineMilliseconds'));
  return result;
}
