# whyts

**Find out why your TypeScript project is slow.**

A small CLI that turns compiler diagnostics, traces, and import relationships into evidence you can act on. No account, API key, or LLM required.

![whyts terminal report](docs/demo.svg)

## Try it

Requires Node.js 20+ and a TypeScript project with dependencies installed.

```sh
npx --yes github:musatoktas/whyts --project .
```

The npm package has not been published yet. Install from GitHub or run a checkout:

```sh
git clone https://github.com/musatoktas/whyts.git
cd whyts
npm ci --ignore-scripts
npm run demo
node src/cli.js --project /path/to/your/tsconfig.json
```

For a repeatable GitHub install, pin a commit rather than the moving default branch.

## What it finds

| Finding | Evidence | What it does **not** claim |
| --- | --- | --- |
| Broad inclusion | Effective `include` and configured root count | That every broadly included file is unnecessary |
| Roots worth reviewing | Generated/output/test roots with no observed importers | That unimported files are safe to delete |
| Duplicate type versions | Multiple versions of an `@types` package loaded into the program | That all duplicate versions can safely be aligned |
| Barrel reach | Reexport count, importers, transitive file reach | Exclusive check cost, bundler behavior, or guaranteed savings |
| Slow file checks | Recorded `checkSourceFile` trace intervals | Complete attribution of total time or the exact expensive type |

Findings are labeled **measured**, **observed**, or **review**. Suggested changes require a fresh measurement. whyts never invents a predicted speedup.

## Explain a file

```sh
node src/cli.js explain src/shared/value.ts --project /path/to/project
```

File paths are relative to the selected tsconfig directory. The result shows a configured-root reason or one shortest observed import/reference chain, plus direct importers. Import resolution respects TypeScript `paths`, reexports, dynamic imports, and ESM/CJS usage modes.

This is a compact explanation, not a complete implementation of `tsc --explainFiles`. Library inclusion, ambient type directives, symlinks, and project-reference redirection can require the compiler's own explanation.

## JSON and automation

```sh
node src/cli.js --project apps/web/tsconfig.json --json > report.json
node src/cli.js --project apps/web --timeout 300 --no-color
```

JSON has `schemaVersion`, compiler version, summary, diagnostics with units, findings with evidence, hotspots, and warnings. Progress goes to stderr. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Analysis completed and type checking succeeded |
| `1` | Tool/configuration failure, unsupported compiler, or timeout |
| `2` | Report available, but the compiler reported errors |

Findings alone do not fail CI. This release diagnoses; it does not enforce a performance budget.

## How it works

1. Resolve the project's installed TypeScript compiler, falling back to the bundled 5.9 compiler.
2. Read the effective config using the compiler API, including JSONC and `extends`.
3. Build a source/import graph and inspect the loaded type packages.
4. Run that compiler with `--noEmit`, `--extendedDiagnostics`, and `--generateTrace`.
5. Interpret measurements and structural findings, then delete temporary trace/cache files.

The compiler receives a new temporary incremental cache. Your existing build cache is neither read nor overwritten. Source files and normal build outputs are unchanged. No package lifecycle scripts are invoked and the CLI makes no network requests. Installing dependencies or fetching the CLI can, of course, access the network.

## Measurement boundaries

- Measures a **fresh-cache, traced type check**. It is not a timer for Next.js builds, bundling, tests, or the language server.
- Trace generation and an empty cache affect timings. Compare runs with the same compiler, flags, hardware, and tracing mode. The report's wall timer excludes the earlier graph analysis.
- Recorded file-check intervals are inclusive and may be sampled. Overlapping intervals for the same file are merged. The top five are reported; they are not a breakdown that sums to total compiler time.
- Barrel reach counts observed source edges, including type-only edges. Files may already be configured roots, and a direct import may leave the program size unchanged.
- To bound graph traversal, at most 40 barrel candidates are checked, ranked first by reexport count; five are reported. Traces over 128 MiB are not parsed. Compiler output is bounded at 16 MiB.
- Select a **leaf tsconfig** in a monorepo. whyts does not run `tsc --build` or build referenced projects. Missing/stale referenced declaration outputs can affect results.
- Supports the JavaScript TypeScript compiler in **5.x and 6.x**. Native TypeScript 7 and `tsgo` are outside this release's scope. Plugins used by an IDE or a separate build framework are not profiled.
- Static graph heuristics cannot establish that a type or file causes a particular slowdown. No automatic edits or fixes are performed.

For deeper type-level attribution, use Microsoft's [analyze-trace](https://github.com/microsoft/typescript-analyze-trace). Compiler documentation: [extendedDiagnostics](https://www.typescriptlang.org/tsconfig/extendedDiagnostics.html), [generateTrace](https://www.typescriptlang.org/tsconfig/generateTrace.html), and [performance guidance](https://github.com/microsoft/TypeScript/wiki/Performance).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests cover import chains, path aliases, cycles, dynamic imports, inherited configs, actually loaded duplicate types, trace interval handling, a real traced check, cache preservation, compiler errors, JSON output, and timeouts. GitHub Actions runs Node 20/22/24 on Linux, Windows, and macOS.

The implementation is plain ESM JavaScript so a checkout runs without a build step. TypeScript is the only runtime dependency.

Bug reports are most useful with a tiny reproduction, Node/TypeScript versions, and expected versus actual output. Reports and traces may contain private filenames; review them before sharing.

MIT license. Created by [Musa Toktas](https://github.com/musatoktas).
