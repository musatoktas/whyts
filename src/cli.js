#!/usr/bin/env node
import { analyze, explain, toolVersion } from './analyze.js';
import { renderReport, renderExplanation } from './report.js';

const help = `whyts: find out why your TypeScript project is slow.

Usage:
  whyts [--project <directory|tsconfig>] [--json] [--timeout <seconds>]
        [--max-old-space-size <MB>] [--typescript <path>]
  whyts explain <file> [--project <directory|tsconfig>] [--typescript <path>] [--json]

Options:
  -p, --project   Project to inspect (default: current directory)
      --json      Machine-readable output; progress stays on stderr
      --timeout   Compiler timeout in seconds (default: 900)
      --max-old-space-size <MB>
                  Heap limit for the compiler process (node --max-old-space-size)
      --typescript <path>
                  TypeScript package directory or its lib/typescript.js to use
                  instead of the project's own (must be 5.x or 6.x)
      --no-color  Disable ANSI styling
  -h, --help     Show help
  -v, --version  Show version

Paths for explain are relative to the tsconfig directory.
No source edits, network calls, lifecycle scripts, or emitted build outputs.
Supports the TypeScript 5.x and 6.x JavaScript compiler.
`;

function parse(args) {
  const options = { project: '.', timeoutMs: 900000, json: false, color: !!process.stdout.isTTY && !('NO_COLOR' in process.env) };
  if (args[0] === 'explain') {
    args.shift(); options.file = args.shift();
    if (!options.file || options.file.startsWith('-')) throw new Error('explain requires a file path.');
  }
  while (args.length) {
    const arg = args.shift();
    if (['-h', '--help'].includes(arg)) return { help: true };
    if (['-v', '--version'].includes(arg)) return { version: true };
    if (arg === '--json') options.json = true;
    else if (arg === '--no-color') options.color = false;
    else if (['-p', '--project', '--timeout', '--max-old-space-size', '--typescript'].includes(arg)) {
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
      } else if (arg === '--typescript') options.typescript = value;
      else options.project = value;
    } else throw new Error(`Unknown argument: ${arg}. Use --help.`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) process.stdout.write(help);
  else if (options.version) process.stdout.write(`${toolVersion}\n`);
  else {
    if (!options.file && process.stderr.isTTY) process.stderr.write('Inspecting the TypeScript program and running a fresh traced check…\n');
    // Long checks are silent otherwise; tsc prints nothing until it finishes.
    if (!options.file) options.onProgress = seconds => process.stderr.write(`whyts: compiler still running after ${seconds}s (timeout ${options.timeoutMs / 1000}s). Large projects can spend minutes writing the trace type dump.\n`);
    const result = options.file ? explain(options) : await analyze(options);
    process.stdout.write(options.json ? JSON.stringify(result, null, 2) + '\n' :
      options.file ? renderExplanation(result) : renderReport(result, options.color));
    if (!options.file && result.summary.compilerExitCode !== 0) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`whyts: ${error.message.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')}\n`);
  process.exitCode = 1;
}
