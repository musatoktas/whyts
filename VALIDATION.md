# v0.2.0 validation

Performed on 2026-10-05 with Node.js 24.19.0 on Linux.

- Syntax checks passed for all four source modules.
- All 18 tests passed with TypeScript 5.9.3.
- The same 18 tests passed in a separate checkout with TypeScript 6.0.3.
- The packed CLI was installed separately, printed version 0.2.0, and produced valid JSON with a successful client-example check and the new source/type data.
- Parser tests cover out-of-order complete events, thread-isolated begin/end pairs, overlapping intervals, nested source context, missing type descriptors, invalid offsets, canonical path casing, and project/dependency prioritization.
- Barrel root-overlap tests prevent suggesting a direct import when every reached file is already a configured root. Terminal tests check measured-first output and control-character sanitization.
- A real compiler run preserved an existing tsbuildinfo cache and did not add build outputs to the project.
- Compiler errors, invalid arguments, missing projects/files, and a compiler timeout were exercised.

The included 16-line client example passed type checking and produced an assignment hotspot at `client.ts:16:14`. One TypeScript 5.9.3 run recorded 38.4 ms for this check and a contained 31.8 ms `FullClient` to `PublicClient` comparison, resolved to declarations at lines 8 and 11. The README image uses that run. These are inclusive sampled intervals; their sum is not total cost, and they vary between runs.

The GitHub Actions workflow is configured for Linux, Windows, and macOS on Node 20, 22, and 24, plus a TypeScript 6 job. Local validation does not establish performance gains on any third-party repository. The MBD feedback motivated this change; MBD has not been rerun with v0.2.0 in this workspace.
