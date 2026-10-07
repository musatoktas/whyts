#!/usr/bin/env node
import { analyze, explain, toolVersion } from './analyze.js';
import { renderReport, renderExplanation, renderComparison } from './report.js';
import { compareProjects, compareReports, readReportFile } from './compare.js';

const help = `whyts: find out why your TypeScript project is slow.

Usage:
  whyts [--project <directory|tsconfig>] [--json] [--timeout <seconds>]
        [--max-old-space-size <MB>] [--typescript <path>] [--runs <N>] [--verbose]
  whyts explain <file> [--project <directory|tsconfig>] [--typescript <path>] [--json]
  whyts compare --baseline <directory|tsconfig> --candidate <directory|tsconfig> [--runs <N>]
        [--timeout <seconds>] [--max-old-space-size <MB>] [--typescript <path>] [--json]
  whyts compare <baseline.json> <candidate.json> [--json]

Options:
  -p, --project   Project to inspect (default: current directory)
      --json      Machine-readable output; progress stays on stderr
      --timeout   Compiler timeout in seconds (default: 900)
      --max-old-space-size <MB>
                  Heap limit for the compiler process (node --max-old-space-size);
                  ignored with a TypeScript 7 compiler
      --typescript <path>
                  TypeScript package directory or its lib/typescript.js to use
                  instead of the project's own (5.x, 6.x or 7.x)
      --runs <N>  Number of untraced timing runs for Check time and Total time (default: 1).
                  With 2 or more, the report adds a timings summary. For compare, the
                  default is 5 measured runs per side.
      --baseline, --candidate
                  The two projects for a live comparison (compare only)
      --verbose   Print the full report. The default prints at most three actions.
      --no-color  Disable ANSI styling
  -h, --help     Show help
  -v, --version  Show version

Paths for explain are relative to the tsconfig directory.
compare exit codes: 0 when the comparison finished, 1 on a failure, a rejected comparison, or sides that are not comparable (compiler errors that differ between the sides).
No source edits, network calls, lifecycle scripts, or emitted build outputs.
Supports TypeScript 5.x and 6.x, and the native TypeScript 7 compiler (experimental;
the traced run uses one checker, so type ids stay unambiguous).
`;

function parse(args) {
  const options = { project: '.', timeoutMs: 900000, json: false, color: !!process.stdout.isTTY && !('NO_COLOR' in process.env) };
  if (args[0] === 'explain') {
    args.shift(); options.file = args.shift();
    if (!options.file || options.file.startsWith('-')) throw new Error('explain requires a file path.');
  } else if (args[0] === 'compare') {
    args.shift(); options.compare = true; options.files = [];
    while (args.length && !args[0].startsWith('-')) options.files.push(args.shift());
  }
  while (args.length) {
    const arg = args.shift();
    if (['-h', '--help'].includes(arg)) return { help: true };
    if (['-v', '--version'].includes(arg)) return { version: true };
    if (arg === '--json') options.json = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--verbose') options.verbose = true;
    else if (['-p', '--project', '--timeout', '--max-old-space-size', '--typescript', '--runs', '--baseline', '--candidate'].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value.`);
      if (arg === '--timeout') {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('--timeout must be between 0 and 86400 seconds.');
        options.timeoutMs = seconds * 1000;
      } else if (arg === '--max-old-space-size') {
        const megabytes = Number(value);
        if (!Number.isInteger(megabytes) || megabytes < 256 || megabytes > 1048576) throw new Error('--max-old-space-size must be a whole number of megabytes between 256 and 1048576.');
        options.maxOldSpaceMb = megabytes;
      } else if (arg === '--runs') {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error('--runs must be a whole number between 1 and 100.');
        options.runs = runs;
      } else if (arg === '--baseline') options.baseline = value;
      else if (arg === '--candidate') options.candidate = value;
      else if (arg === '--typescript') options.typescript = value;
      else options.project = value;
    } else throw new Error(`Unknown argument: ${arg}. Use --help.`);
  }
  if (options.compare) {
    const live = options.baseline !== undefined || options.candidate !== undefined;
    if (live && options.files.length) throw new Error('compare takes either two report files or --baseline and --candidate, not both.');
    if (live && (!options.baseline || !options.candidate)) throw new Error('A live comparison needs both --baseline and --candidate.');
    if (!live && options.files.length !== 2) throw new Error('compare needs two report files, or --baseline and --candidate.');
    if (!live && options.runs !== undefined) throw new Error('--runs applies to a live comparison. Report files already hold their runs.');
  } else if (options.baseline !== undefined || options.candidate !== undefined) throw new Error('--baseline and --candidate belong to the compare command.');
  else if (options.file && options.runs !== undefined) throw new Error('--runs does not apply to explain.');
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else if (options.version) process.stdout.write(`${toolVersion}\n`);
  else if (options.compare) {
    let result;
    if (options.files.length) result = compareReports(readReportFile(options.files[0], 'baseline'), readReportFile(options.files[1], 'candidate'));
    else {
      options.onRun = ({ step, steps, side, warmup }) => process.stderr.write(`whyts: timing run ${step} of ${steps} (${side}${warmup ? ', warm-up' : ''})\n`);
      result = await compareProjects(options);
    }
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' : renderComparison(result, options.color));
    if (result.comparable === false) process.exitCode = 1;
  } else {
    if (options.runs > 1) options.onRun = ({ run, runs }) => process.stderr.write(`whyts: untraced timing run ${run} of ${runs}\n`);
    if (!options.file && process.stderr.isTTY) process.stderr.write('Inspecting the TypeScript program and running a fresh traced check…\n');
    // Long checks are silent otherwise; tsc prints nothing until it finishes.
    if (!options.file) options.onProgress = seconds => process.stderr.write(`whyts: compiler still running after ${seconds}s (timeout ${options.timeoutMs / 1000}s). Large projects can spend minutes writing the trace type dump.\n`);
    const result = options.file ? explain(options) : await analyze(options);
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' :
      options.file ? renderExplanation(result) : renderReport(result, options.color, { verbose: !!options.verbose }));
    if (!options.file && result.summary.compilerExitCode !== 0) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`whyts: ${error.message.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')}\n`);
  process.exitCode = 1;
}
