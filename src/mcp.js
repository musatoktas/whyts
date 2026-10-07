// `whyts mcp`: a Model Context Protocol server on stdio. It gives AI coding agents three tools:
// analyze, compare and explain. The MCP SDK is an optional dependency and loads only here.
import { runTool, toText, DEFAULT_COMPARE_RUNS } from './mcp-tools.js';
import { toolVersion } from './analyze.js';

export const SERVER_INSTRUCTIONS = [
  'whyts measures why a TypeScript project is slow. It runs the real compiler and returns a short JSON result.',
  'After a change to types, call `compare` with the project before and after. A decision of `separated` is a measured change; `within-noise` means no change can be claimed.',
  'If `diagnoses` is not empty, apply the `remedy` of the first one. If the result lists compiler errors, fix them first: timings with different errors are not comparable.',
  'Calls take as long as a type check, or longer. Use absolute paths.'
].join(' ');

export const TOOL_DESCRIPTIONS = {
  analyze: 'Find out why a TypeScript project is slow. Runs one traced type check of the project (plus `runs` untraced timing runs) and returns compact JSON: Check time, file count, compiler error summary, `diagnoses` (a known slow-type pattern with location, evidence and a fix), the top 5 measured findings, and warnings. Use it when type checking, the editor or CI is slow, before you change types. It takes as long as a full type check of the project (seconds to minutes), plus the extra timing runs. Do not use it to find type errors: it reports only a summary of them.',
  compare: 'Prove whether a change made type checking faster or slower. Runs the full type check `runs` times for the baseline and for the candidate project (a copy or a git worktree of the same project, before and after the change), alternating the order, and returns a decision: `separated` (the ranges do not overlap, a real change, with direction), `within-noise` (no change can be claimed) or `not-comparable` (a side has compiler errors or the compilers differ). Use it after a type change to check that it helped. It takes about (2 x runs + 2) type checks, so it is slow: use `runs` 3 for a quick answer and 5 or more for a firm one.',
  explain: 'Show why one file is in the TypeScript program: the shortest import chain from a configured root and the direct importers. Use it when `analyze` shows a file or a barrel you did not expect to be checked. It reads the import graph only and does not run the type checker, so it finishes in seconds.'
};

const hint = (name, extra = {}) => ({ title: `whyts ${name}`, readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...extra });

async function loadSdk() {
  try {
    const [server, stdio, z] = await Promise.all([import('@modelcontextprotocol/server'), import('@modelcontextprotocol/server/stdio'), import('zod/v4')]);
    return { McpServer: server.McpServer, serveStdio: stdio.serveStdio, z };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      throw new Error('whyts mcp needs the optional dependencies @modelcontextprotocol/server and zod. Install whyts again without --omit=optional.');
    }
    throw error;
  }
}

// The input schemas. `z` is the zod/v4 module.
export function inputSchemas(z) {
  const project = z.string().min(1).describe('Absolute path to a directory with a tsconfig.json, or to a tsconfig file.');
  const typescript = z.string().min(1).optional().describe('Path to a typescript package directory to use instead of the one in the project (5.x, 6.x or 7.x).');
  const timeoutSeconds = z.number().positive().max(86400).optional().describe('Compiler timeout in seconds for each type check. Default 900.');
  const maxOldSpaceMb = z.number().int().min(256).max(1048576).optional().describe('Heap limit in MB for the compiler process. Ignored with TypeScript 7.');
  return {
    analyze: z.object({ project, typescript, timeoutSeconds, maxOldSpaceMb,
      runs: z.number().int().min(1).max(100).optional().describe('Untraced timing runs for a stable Check time (default 1). Each run is one more full type check. Use 3 or more for a median.') }),
    compare: z.object({
      baseline: z.string().min(1).describe('Absolute path to the project before the change (directory with tsconfig.json, or a tsconfig file).'),
      candidate: z.string().min(1).describe('Absolute path to the project after the change. It must be a separate directory, for example a git worktree.'),
      runs: z.number().int().min(3).max(100).optional().describe(`Measured runs per side (default ${DEFAULT_COMPARE_RUNS}, minimum 3 for a verdict).`),
      typescript, timeoutSeconds, maxOldSpaceMb }),
    explain: z.object({ project, file: z.string().min(1).describe('File to explain, relative to the tsconfig directory.'), typescript })
  };
}

function progressFor(ctx) {
  const token = ctx.mcpReq?._meta?.progressToken;
  if (token === undefined) return null;
  return params => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, ...params } });
}

export function createServer(sdk, run = runTool) {
  const { McpServer, z } = sdk;
  const schemas = inputSchemas(z);
  const server = new McpServer({ name: 'whyts', version: toolVersion }, { instructions: SERVER_INSTRUCTIONS });
  for (const name of ['analyze', 'compare', 'explain']) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: schemas[name], annotations: hint(name) }, async (args, ctx) => {
      const result = await run(name, args, { signal: ctx.mcpReq?.signal, progress: progressFor(ctx) });
      return result.ok
        ? { content: [{ type: 'text', text: toText(result.data) }] }
        : { isError: true, content: [{ type: 'text', text: toText({ error: result.error }) }] };
    });
  }
  return server;
}

export async function serve() {
  const sdk = await loadSdk();
  // stdout carries the protocol. Everything else goes to stderr.
  sdk.serveStdio(() => createServer(sdk), { onerror: error => process.stderr.write(`whyts mcp: ${error.message}\n`) });
  process.stderr.write(`whyts mcp ${toolVersion}: ready on stdio\n`);
  // When the client closes stdin, the SDK aborts the running requests, and runTool stops the compiler.
  // This timer ends the process if something else keeps it alive.
  process.stdin.once('close', () => setTimeout(() => process.exit(0), 5000).unref());
}
