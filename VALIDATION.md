# v0.8.0 validation

0.8.0 adds `whyts mcp`, a Model Context Protocol server with the tools `analyze`, `compare` and `explain`, and a short instruction file for agents (`docs/agents.md`). It changes no analysis. The tools call the same functions as the CLI and shorten the JSON.

Done on 2026-10-07 (Dubai time), from about 14:55 to 16:15, with Node.js 24.21.0 on Linux x64. The bench had other jobs, and 20 GB of memory was available at the start. Output files are on the bench in `/opt/whyts-v08-out`. The times of the real runs are Check times of untraced runs, unless the text says traced.

## Dependency decision

We measured ways to add the official MCP SDK. Installs went into clean directories with `--ignore-scripts`. The counts come from `npm ls --all --parseable` (the whyts package is counted).

| Install | Packages | Unpacked on disk |
| --- | --- | --- |
| whyts 0.7.1 | 2 | 23,648 KB |
| whyts 0.8.0 (the packed tarball) | 2 | 23,680 KB (+32 KB) |
| An earlier try: whyts with the MCP packages as optional dependencies | 5 | 39,944 KB (+69%) |
| `typescript` and `@modelcontextprotocol/sdk` 1.32.1 (no whyts) | 95 | 52,496 KB (typescript alone: 1 package, 23,464 KB) |
| `typescript`, `@modelcontextprotocol/server` 2.3.1 and `zod` 4.6.5 (no whyts) | 4 | 39,728 KB |

Decision (Musa Toktas, 2026-10-07): the MCP packages are not in `package.json` at all, neither as dependencies nor as optional dependencies. The lock file holds only `typescript`, as in 0.7.1. `whyts mcp` loads `@modelcontextprotocol/server` and `zod` with a dynamic `import()`. If it cannot find them, it prints one line with the command that works: `npx -y -p whyts@0.8.0 -p @modelcontextprotocol/server@2 -p zod@4 whyts mcp`. The README and the client setups use that command. `npx -p` installs the three packages into one directory, so the import finds them next to whyts.

- `npm install whyts` from the tarball: 2 packages and 23,680 KB, the same as 0.7.1 (the 32 KB are the new files of whyts). The tarball grows from 47,297 bytes to 57.0 kB (the size that `npm pack` prints).
- The SDK 1.x package would add 94 packages, so we use 2.x. The npm `latest` tag of `@modelcontextprotocol/server` is 2.3.1, the SDK documentation calls 2.x the stable line, and its `serveStdio` serves clients of both protocol revisions (2025-11-25 and 2026-07-28). The command pins the major versions (`@2` and `zod@4`) that we tested.
- The cost moves to the first start of `whyts mcp`: `npx` downloads `server` (1,537,977 bytes), `core` (154,829 bytes) and `zod` (1,052,733 bytes), and installs about 16 MB. `npx` keeps them in its cache. A client with a short start timeout (Codex: 10 seconds) needs a longer one for the first start. The README says so.
- The layout was checked with the packed tarball and a new npm cache: `npx -y -p whyts-0.8.0.tgz -p @modelcontextprotocol/server@2 -p zod@4 whyts mcp` made `_npx/<hash>/node_modules` with `whyts`, `typescript`, `zod` and `@modelcontextprotocol/{core,server}` side by side. The server started and answered `initialize`. We did not need a different way to resolve the packages (`createRequire(process.cwd())` or `import.meta.resolve`).

## Facts from the documentation

- MCP specification, lifecycle, timeouts: "Implementations SHOULD establish timeouts for all sent requests". A client MAY reset the clock on a progress notification, and SHOULD always enforce a maximum timeout.
- MCP specification, progress: the server MAY send `notifications/progress` for a request that carries a `progressToken`; `progress` MUST increase with each notification. whyts drops a value that does not increase.
- Claude Code documentation: the per-server `timeout` is a hard wall-clock limit, and progress notifications do not extend it. Its output limit is 25,000 tokens by default, with a warning at 10,000.
- Codex documentation: `tool_timeout_sec` is 60 seconds and `startup_timeout_sec` is 10 seconds by default. The README tells users to raise both.
- Cursor documentation names no tool timeout. The documentation of VS Code names none either.
- The client configuration forms in the README are copied from the documentation of each client (Claude Code `claude mcp add`, Cursor `.cursor/mcp.json`, VS Code `.vscode/mcp.json`, Codex `codex mcp add` and `config.toml`).

## Tests

| Compiler | Result |
| --- | --- |
| TypeScript 5.9.3 | 120 tests, 119 passed, 1 skipped (the real TypeScript 7 test) |
| TypeScript 5.9.3 and `WHYTS_TS7` (7.0.2) | 120 tests, 120 passed |
| TypeScript 6.0.3 and `WHYTS_TS7` (7.0.2) | 120 tests, 120 passed |

The 95 tests of 0.7.1 pass without change. We added 25 tests in `test/mcp.test.js`. They cover the compact result shape, the cap of 5 diagnoses and 5 measured findings, the character limit, the three decisions of `compare`, the error kinds, one call at a time, progress values that grow, cancellation, and a raw stdio client against `whyts mcp` (a client of 2025-11-25 and a client of 2026-07-28 without a handshake). The error paths run through the real server: a missing project, an unsupported TypeScript (a fake 4.9.5 package) and a timeout (`timeoutSeconds` 0.05). One test starts a copy of whyts in a directory without `node_modules` and checks that `whyts mcp` prints one line with the `npx -p` command and exits with 1. Without the two MCP packages (`npm ci` only), the 9 server tests skip and the other 16 pass. CI installs the two packages with `npm install --no-save` after `npm ci`, so the matrix runs all 25.

Mutation check (made before the change of the dependency decision; the loading code is not covered by it). We changed `src/mcp-tools.js` or `src/mcp.js` 14 times and ran `test/mcp.test.js`. Each change was reverted.

| Change | Failed tests |
| --- | --- |
| Calls do not wait for each other | 2 (one of them hung until the test timeout in the first run) |
| No limit on the result size | 2 |
| 50 diagnoses instead of 5 | 1 |
| 50 findings instead of 5 | 1 |
| A result with compiler errors counts as comparable | 1 |
| The timeout error has no own kind | 2 |
| The progress value of a compare run does not stay below the next step | 1 |
| A cancelled running call does not stop the compiler | 1 |
| A cancelled waiting call stops the running compiler | 1 |
| The abort signal is not connected | 2 (the cancel test and the stdin test) |
| The result keeps the relative project path | 1 |
| Progress notifications without a progress token | 1 |
| `compare` accepts 1 run | 1 |
| The result has no `direction` | 2 |

Two changes were not caught at first. A cap of 50 diagnoses and a cap of 50 findings passed, because the size limit shortened the result to 3 anyway. We added a test with small entries, and both are caught now. A stop of the compiler in the stdin handler also passed: the SDK already aborts the running requests when stdin closes. We removed that duplicate code. The stdin test now checks that the compiler process is gone.

## Real MCP client: MCP Inspector

Client: `@modelcontextprotocol/inspector` 2.9.0, CLI mode. The 2.x package has the binary `mcp-inspector`. The server was started by the `npx -p` command above, with the packed `whyts-0.8.0.tgz` in place of `whyts@0.8.0` (0.8.0 is not published) and a new npm cache. The Inspector reads `-y` and `-p` as its own options when the server command is on its command line, so the command went into a config file: `mcp-inspector --cli --config mcp-npx.json --server whyts --method tools/call --tool-name <name> --tool-arg key=value ...`.

| Call | Result |
| --- | --- |
| `tools/list` | `analyze`, `compare`, `explain`, 6,048 bytes with the schemas |
| `analyze` on `examples/type-comparison`, `runs=3` | 1,608 characters, wall 3.2 s, Check 0.04 s (median of 3 untraced runs), 1 measured finding, `diagnoses: []` |
| `analyze` on `examples/barrel` | 965 characters, wall 2.7 s, 0 measured findings, 3 structural findings (`barrel-reach`, `broad-include`, `review-root-files`) |
| `analyze` on the TanStack Form 1474 reproduction | 2,051 characters, wall 15.0 s |
| `compare`, synthetic pair, `runs=5` | `separated`, `faster`, 1,169 characters, wall 5.6 s |
| `explain` on `examples/barrel`, `src/shared/clamp.ts` | 261 characters, wall 1.5 s, chain `src/shared/clamp.ts`, importer `src/shared/index.ts` |
| `analyze` on a missing project | `isError`, kind `not-found` (this call ran in the first Inspector run, with the packed tarball started directly: the Inspector exits with 5) |

The TanStack reproduction (the `k.ts` of the earlier work, with `util-types.ts` of form-core commit 2216fde) gave the diagnosis in the MCP answer:

```
"summary":{"checkTime":{"seconds":10.38,"source":"one traced run (tracing inflates it)"},"files":65,"compilerExitCode":2,"errorCount":1,"comparableWithCompare":false}
"diagnoses":[{"pattern":"recursive-type-instantiation","confidence":"measured","title":"Recursive type instantiation: DeepKeys<Values>","location":"k.ts:4:17",
 "evidence":["TS2589 at this place: ...","It hit the instantiation limit inside DeepKeysAndValuesImpl (../src/util-types.ts:151).",
 "DeepKeysAndValuesImpl refers to itself: DeepKeysAndValuesImpl -> DeepKeyAndValueArray -> DeepKeysAndValuesImpl.","Type argument JsonData (k.ts:2): JsonData refers to itself."],
 "remedy":"Stop the expansion of DeepKeysAndValuesImpl when it meets a type it already visited. ..."}]
```

The `compare` call used two synthetic projects that we wrote for this check: the same assignment of a 20-letter route type, with three-letter routes (8,000 properties) as the baseline and two-letter routes (400 properties) as the candidate. It is not a fix of a real bug. The answer:

```
"decision":"separated","direction":"faster","runsPerSide":5,"order":"ABBAABBAAB",
"checkTime":{"baseline":{"median":0.21,"min":0.2,"max":0.22},"candidate":{"median":0.03,"min":0.03,"max":0.04},"deltaMilliseconds":-180,"deltaPercent":-85.7,"verdict":"separated","direction":"faster"}
```

The `compare` over stdio with the scripted compiler (a fast candidate, and a candidate with TS2322) returned `separated` and `not-comparable` in the tests.

## Not verified

- We did not run Claude Code, Cursor, Codex or GitHub Copilot against the server. The setup forms in the README come from their documentation.
- We do not know which clients show progress notifications, or which of them reset a timeout on progress. The Inspector CLI shows none. The progress notifications were checked with a raw client in the tests, in both protocol eras.
- No real run lasted longer than 15 seconds, so we did not see a heartbeat notification from a real compiler. The heartbeat is tested with a 10 to 20 ms interval and a fake engine.
- Client cancellation (`notifications/cancelled`) was tested through the abort signal of `runTool` and through a closed stdin, not through a real client. The stop of the compiler uses the SIGTERM listener that the engine adds while a compiler runs.
- The first start of `npx -p` on a machine with an empty cache was run on the bench only (a new cache directory, a fast network). We did not time it or try a slow network.
- We did not run a multi-minute project through the server, and we did not run a native TypeScript 7 project through the MCP tools. The server tests use the 5.9.3 and 6.0.3 compilers and a fake compiler.
- We measured the result size in characters (at most 12,000), not in tokens.
- CI: see the pull request. The first version of this change passed all 11 jobs with the packages as optional dependencies. CI for the change to `npx -p` is recorded in the pull request text.

# v0.7.1 validation

0.7.1 fixes one fault of `whyts compare`. A side with compiler errors can stop early, and its time is then short. 0.7.0 showed this as a speed difference. 0.7.1 calls the sides not comparable. It adds no feature.

Done on 2026-10-07 (Dubai time) with Node.js 24.21.0 on Linux x64. The live runs started at 14:37, 14:37 and 14:38. The bench had other jobs, with a load average below 2 at the start. All times are Check times of untraced runs. Output files are on the bench in `/opt/whyts-v071-out`.

## Tests

| Compiler | Result |
| --- | --- |
| TypeScript 5.9.3 | 95 tests, 94 passed, 1 skipped (the real TypeScript 7 test) |
| TypeScript 5.9.3 and `WHYTS_TS7` (7.0.2) | 95 tests, 95 passed |
| TypeScript 6.0.3 and `WHYTS_TS7` (7.0.2) | 95 tests, 95 passed |

The 90 tests of 0.7.0 pass without change in their meaning. Two of them changed: they used a failing side and a clean side, and they now expect `not-comparable`. We added 5 tests: a failing baseline with a clean candidate, the same errors on both sides, two clean sides, the offline rule, and the rule as a pure function.

Mutation check (made before the change of the dependency decision; the loading code is not covered by it). We changed `src/compare.js` three times and ran all tests. Each change was reverted.

| Change | Failed tests |
| --- | --- |
| The sides are always comparable | 5 |
| Equal errors count as different errors | 4 |
| Only the error count is compared, not the error codes | 1 |

## Real projects

Compiler: TypeScript 5.9.3. Ten measured runs for each side, order ABBA. The baseline has one TS2589 error. The candidate has none.

| Project | 0.7.0 | 0.7.1 |
| --- | --- | --- |
| typeorm 8559 reproduction (baseline: master c64a1f0; candidate: the fix commit 238041f) | Check 0.05 s and 0.13 s: "+160%, the candidate is slower" | `not-comparable`, Check 0.05 s and 0.13 s shown, exit code 1 |
| TanStack Form 1474 reproduction (baseline: 2216fde; candidate: the fix commit 4fa8090) | Check 7.415 s and 0.06 s: "-99.2%, the candidate is faster" | `not-comparable`, Check 7.415 s and 0.06 s shown, exit code 1 |

The 0.7.1 text for both is: `NOT COMPARABLE: The baseline stopped with 1 compiler error (TS2589). Timings are not comparable.`

We built the typeorm reproduction again for this check. It has 166 files. The reproduction of the 0.7.0 work had 231 files, so its times differ. A clean project compared with itself gave `within-noise`.

## Not verified

- A pair where both sides have different errors was tested only with the fake compiler, not with a real project.
- A report from before 0.7 may have no error data. Then a clean side still decides, and two failing sides stay comparable. We did not test an old report file.
- We did not test TypeScript 7 for the live comparison of failing sides.

# v0.7.0 validation

Done on 2026-10-07 (Dubai time), from about 11:30 to 12:45, with Node.js 24.21.0 on Linux x64. The bench has 16 cores. Other jobs ran on it all the time. The load average was between 40 and 96 during part of the runs. All the times below are traced times. They are upper bounds and not benchmarks. This release makes no speed claim. Output files are on the bench in `/opt/whyts-v07-out`.

## What this release checks

0.7 adds two diagnoses with a remedy: recursive type instantiation and variance computation. It also changes the default terminal output. Each diagnosis was first seen in a real project:

1. TanStack Form issue 1474 (form-core commit 2216fde): `DeepKeys<{ name: string; data: JsonData }>`, where `JsonData` contains itself. TS2589, 5,001,167 instantiations.
2. drizzle-orm commit 15454db with TypeScript 5.6.3: the `getVariancesWorker` events for five dialects, 405 ms to 473 ms each.

## Trace events in each compiler

We looked at the trace of each compiler before we wrote the code.

| Event | 5.6.3 | 5.9.3 | 6.0.3 | 7.0.2 (`--checkers 1`) |
| --- | --- | --- | --- | --- |
| `instantiateType_DepthLimit` (`typeId`, `instantiationDepth`, `instantiationCount`) | not in the drizzle-orm trace (no TS2589 there) | present, 402,173 events for the repro | present, 402,173 events | present, 402,176 events, plus `checkerId` |
| `getVariancesWorker` (`id`, `arity`) | present (165 events in drizzle-orm) | present | present (43 events in tRPC server) | present as begin and end events, and the variances are on the end event |

- One compiler hit of the limit writes hundreds of thousands of events. whyts counts them for each type id and keeps three type ids.
- The events name type parameters, for example `T`, `TAllKeys`, `TParent`. whyts goes from the declaration of a type parameter to the type alias that owns it. The `types.json` of 5.9.3 has no alias name for these types.
- The TS2589 error line gives the place (`k.ts(4,17)`). TypeScript 5.9.3, 6.0.3 and 7.0.2 print the same line.
- The native `types_0.json` has the same fields. Its declaration paths are in lower case.

## Example 1: recursive type (TanStack Form issue 1474)

Project: the repro from the issue, `DeepKeys<Values>` with `util-types.ts` of commit 2216fde. Compiler: TypeScript 5.9.3.

Before (0.6.0, whole report, shortened):

```text
Error codes: TS2589 x1
   k.ts:4:17  TS2589  Type instantiation is excessively deep and possibly infinite.
1. [measured] k.ts: 10582.2 ms recorded check intervals
   at most 99.6% of Check time
   Inspect types and declarations in this file.
```

After (0.7.0, default output):

```text
1. [measured] Recursive type instantiation: DeepKeys<Values>
   Where: k.ts:4:17
   It hit the instantiation limit inside DeepKeysAndValuesImpl (../src/util-types.ts:151).
   DeepKeysAndValuesImpl refers to itself: DeepKeysAndValuesImpl -> DeepKeyAndValueArray -> DeepKeysAndValuesImpl.
   Type argument JsonData (k.ts:2): JsonData refers to itself.
   Fix: Stop the expansion of DeepKeysAndValuesImpl when it meets a type it already visited. Or add a depth limit to it.
   Cost: 10875.5 ms, at most 99.4% of Check time (upper bound, not a saving)
```

The same diagnosis came out of the real runs with TypeScript 6.0.3 (10564.7 ms, 99.6%) and 7.0.2 (55076.7 ms, 99.9%, one checker). The TypeScript 7 time is much larger because of the trace of 402,176 events. We did not investigate the difference.

## Example 2: variance computation (drizzle-orm 15454db)

Project: `drizzle-orm/tsconfig.json`, TypeScript 5.6.3, 1627 files, 6 compiler errors (TS2305 and TS7006, as in 0.4).

Before (0.6.0): the first finding was `db.ts:147:10`, 487.9 ms, with the comparison `SingleStoreSession` to `SingleStoreSession`. The report did not say that variance was the cost.

After (0.7.0, default output, run 2):

```text
1. [measured] Variance computation for 9 generic types, led by GelSelectBuilder
   Where: src/gel-core/query-builders/select.ts:60:1
   TypeScript spent 2705.4 ms to compute how GelSelectBuilder, SQLiteSession, SingleStoreSession and others relate when type arguments differ.
   Fix: Reduce the type parameters of GelSelectBuilder and SQLiteSession. Simplify their return types. An in or out annotation is not a guaranteed fix. Measure again after each change.
   Cost: 2705.4 ms, at most 36.7% of Check time (upper bound, not a saving)
```

- Run 1 of 0.7 gave 2535.1 ms and 36.9% with `SQLiteSession` first. The lead type changes between runs because five types are within 10% of each other. The count of 9 types and the union time are stable.
- `--verbose` lists the five largest outer types with their nested types, for example `SingleStoreSession` 469.3 ms with `SingleStoreTransaction`, `SingleStoreSelectBuilder` and `CreateSingleStoreSelectFromBuilderMode`.
- The chains of 0.6 at `db.ts:147` and `query.ts:45` are not listed again in the compact report, because their comparisons name types of this list.
- The remedy does not promise a result. We know from earlier work on drizzle-orm that `in` and `out` annotations on `SingleStoreSession` gave no measurable change. That work is not part of this release. We did not run it again, and we did not test any remedy here.

## False-positive check

| Project | Compiler | Result |
| --- | --- | --- |
| TanStack Form `form-core`, fixed branch (commit 4fa8090), 501 files | 5.9.3 | 0 diagnoses |
| The repro with the fixed `util-types.ts` | 5.9.3 | 0 diagnoses. Check time 0.06 s |
| tRPC `packages/server` (main at d756e59), 942 files | 7.0.2 and 6.0.3 | 0 diagnoses |

- The first tRPC run with 7.0.2 gave one variance diagnosis. It was for `FastifyInstance`, a type of the `fastify` package: 134.5 ms, 26.8% of a Check time of 0.50 s. The project cannot change that type. We added a rule: only types declared in the project get a variance diagnosis. After that change, tRPC gave 0 diagnoses with both compilers.
- The compact report of tRPC still lists one or two slow checks without a known pattern (`fastifyTRPCPlugin.ts:66:3`: 143.5 ms, 29.8% with 7.0.2). These are the measured chains of earlier versions. They have no remedy.
- Other test projects of the earlier versions (zod, router-core, typespec, playwright, mbd-v3) were not run again with 0.7.

## Tests

- The syntax check passed for all source modules. The new module is `src/diagnose.js`.
- Version 0.6.0 had 72 tests. This release has 90. The 18 new tests are in `test/diagnose.test.js`.
- Results of `node --test`, run with a clean `TMPDIR`:

| Bundled TypeScript | Without `WHYTS_TS7` | With `WHYTS_TS7` (typescript@7.0.2) |
| --- | --- | --- |
| 5.9.3 | 89 passed, 1 skipped | 90 passed |
| 6.0.3 (`npm install --no-save typescript@6.0.3`) | 89 passed, 1 skipped | not run |

- We changed 11 lines of existing tests: ten calls of `renderReport` now pass `{ verbose: true }`, because they check the full report, and one expected object of `parseCompilerErrors` has the new field `excessiveDepth`. No assertion was removed or weakened.
- The new tests use trimmed real traces: the repro with 5.9.3, 6.0.3 and 7.0.2, drizzle-orm variance events (5.6.3), and TypeScript 7 begin and end variance events. `util-types.ts.txt` is the file of TanStack Form commit 2216fde (MIT). The tests cover:
  - the alias, the cycle, the self-referencing type argument and the place for the three compilers,
  - the counts of limit events for each type id,
  - the TS2589 sites, also beyond the first five errors,
  - no diagnosis without an error and without limit events, and no cycle claim for an alias that does not refer to itself,
  - outer and nested variance events, the union time, the share of Check time, and the TypeScript 7 begin and end events,
  - no variance diagnosis below 50 ms and none for a type outside the project,
  - at most 20 words in each sentence of every remedy,
  - the compact output (three items, one summary line, the 3% rule, no list of a chain that a diagnosis explains), `--verbose`, reports without `diagnoses`, and the CLI in compact and full mode.
- We changed the sources one way at a time in a copy and ran `test/diagnose.test.js`. Each of the 9 changes turned at least one test red, and the unmodified copy passed all 18 tests. The changes: no scope filter, no counting of limit events, no cycle search, no name filter for trace spans, a limit of 4 items, no collection of TS2589 sites, no signal check, no end-event arguments, and no total-time threshold. The last change is red because the code then fails on an empty list, so it does not show the threshold alone.

## Not verified

- We did not measure any remedy on a project. The reports say what the trace shows, and they name a direction.
- We did not run 0.7 on the full set of projects of the earlier versions. The only projects run with 0.7 are in this section.
- The syntax-based search for cycles matches type names. It can miss a cycle through names that exist twice in the program. It can also show a cycle that the compiler does not follow.
- The variance remedy is the same for each variance diagnosis. We know of no case where the `in` and `out` annotation has a measurable effect.
- The CI result of the pull request is not part of this record.

## Candidate patterns, not added

We found no real project that shows these patterns, so they have no remedy in 0.7:

- A comparison of a large union. The saved reports of the test set (0.3.1 to 0.4 JSON files) have no comparison of 100 ms or more with a union of 50 or more members, or an intersection of 4 or more members.
- An intersection that an interface could replace.
- A deep conditional type. The saved react-router report has three comparisons of 100 ms or more with a conditional type. We did not look at their source.

# v0.6.0 validation

Done on 2026-10-07 (Dubai time) with Node.js 24.21.0 on Linux x64. The machine has 16 cores. Another job used about two cores during the series. Series ran from 08:05 to 09:18, and the other experiments ran at 08:04 and from 09:20 to 09:40. All output files are on the bench in `/opt/whyts-v06-out`.

## Tests

- The syntax check passed for all source modules. The new modules are `src/timing.js` and `src/compare.js`.
- Version 0.5.0 had 56 tests. This release has 72. The 16 new tests are in `test/compare.test.js`.
- Results of `node --test`, run with a clean `TMPDIR`:

| Bundled TypeScript | Without `WHYTS_TS7` | With `WHYTS_TS7` (typescript@7.0.2) |
| --- | --- | --- |
| 5.9.3 | 71 passed, 1 skipped | 72 passed |
| 6.0.3 (`npm install --no-save typescript@6.0.3`) | 71 passed, 1 skipped | 72 passed |

- The new tests use a fake `tsc` that prints scripted Check time values and records its arguments. They cover:
  - the run order (A B, B A, A B, B A) and the equal count of runs for each side,
  - the exclusion of the warm-up runs from the numbers,
  - the median, the minimum, the maximum and the spread,
  - the noise rule: overlap, ranges that touch, both directions, fewer than 3 runs, and the chance value,
  - the untraced runs: no `--generateTrace`, a new cache file for each run, one checker for the native compiler,
  - the checks before a comparison: compiler kind, checker count, flags, measurement mode and the warnings,
  - the offline match of chains by file and position, and the limits for a grown or shrunk entry,
  - the JSON fields, the text output, the exit codes and the argument errors of the CLI.
- We changed the sources one way at a time in a copy and ran `test/compare.test.js`. Each of the 18 changes turned at least one test red. The unmodified copy passed all 16 tests.
  - Do not flip the order inside a pair: 2 tests failed.
  - Add the warm-up runs to the numbers: 2 failed.
  - Use the upper middle value as the median: 1 failed.
  - Divide the spread by the minimum: 2 failed.
  - Count ranges that touch as separated: 1 failed.
  - Remove the overlap check, so every difference is separated: 4 failed.
  - Remove the minimum of 3 runs: 3 failed.
  - Remove the percent limit for a grown or shrunk entry: 1 failed (see below).
  - Match chains by file only: 2 failed.
  - Write a trace in an untraced run: 2 failed.
  - Share one cache file between the runs: 2 failed.
  - Do not pass `--checkers 1` to an untraced native run: 1 failed.
  - Remove the `timings` field: 2 failed.
  - Accept a native side with a JavaScript side: 3 failed.
  - Accept different flags: 2 failed.
  - Remove the file count warning: 3 failed.
  - Remove the compiler error warning: 4 failed.
  - Return exit code 2 when a side has compiler errors: 1 failed.
- The first mutation run found a gap. The change for the percent limit left all tests green. We added a case (15 ms of 200 ms) and ran all mutations again. The second run turned that change red.

## How the series were measured

- Each series is one `whyts compare` of a baseline and a candidate with `--runs 10` (22 runs: 2 warm-up and 20 measured). The runs `--runs 20` use 42 runs. The compiler came from `--typescript`, so both sides used one compiler.
- Before and after each series, a script read the 1-minute load average and looked for `/tmp/KAPI-KILIDI` (a poll every second during the series). It discarded the series when the lock appeared or when the load was above 4 at the start or at the end.
- The lock never appeared. The script discarded 21 attempts for load above 4 and repeated them. It kept 47 series, with a load of 0.72 to 3.73 at the start and 2.16 to 3.96 at the end. The series `aa-trpc-t5-5` had no valid attempt in 6 attempts and has no result. No series was kept with a load above 4.
- All compiler runs in the kept series exited with code 0.

## Test projects

- `examples/type-comparison` of this repository: 58 files, Check time 0.04 s with TypeScript 5.9.3. The compiler prints 10 ms steps, so its values and spreads are coarse.
- tRPC (`trpc/trpc`, commit `d756e59`), project `packages/server/tsconfig.json`: 944 files. `pnpm install --ignore-scripts --frozen-lockfile` (pnpm 12.4.1) worked. All runs had 0 compiler errors. TypeScript 5.9.3 gave a Check time of about 1.4 s, 6.0.3 about 1.5 s and 7.0.2 (one checker) about 0.4 s.
- We did not use zod. Its repository selects the package manager `nub`, which pnpm cannot provide, and npm cannot install its `workspace:` dependencies.
- Candidates with a known slowdown:
  - `tc-4` and `tc-10`: a copy of the example where `Route` has a third part of 4 or 10 digits. This gives 2704 or 6760 routes in place of 676.
  - `trpc-small`, `trpc-medium`, `trpc-big`: a hard-link copy of the checkout with one new file, `src/whyts-slowdown.ts`. The file has one client of 2704 routes (small), one of 6760 routes (medium) or three of 6760 routes (big). The candidate program has 945 files. whyts printed the file count warning for these series.

## A with A

Both sides are the same project directory. The verdict is for Check time. The Total time verdict was the same in every series.

| Project and compiler | Runs | Series | Verdict | Difference of medians | Spread of one side |
| --- | --- | --- | --- | --- | --- |
| type-comparison, 5.9.3 | 10 | 10 | 10 within noise | 0 ms in all | 0% to 50% |
| tRPC server, 5.9.3 | 10 | 4 | 4 within noise | -15 to 45 ms (-1.0% to 3.0%) | 6.1% to 15.5% |
| tRPC server, 5.9.3 | 20 | 2 | 2 within noise | -25 to 20 ms (-1.7% to 1.4%) | 11.1% to 16.4% |
| tRPC server, 6.0.3 | 10 | 5 | 5 within noise | -45 to 35 ms (-2.9% to 2.3%) | 6.4% to 15.4% |
| tRPC server, 7.0.2 | 10 | 5 | 5 within noise | -4 to 7 ms (-1.0% to 1.6%) | 10.4% to 24.7% |

No A with A series was `separated` (0 of 26, for Check time and for Total time). With 10 runs for each side and equal distributions, the chance of a split is 0.0011% for each metric. These series do not prove that the assumption holds. They show that no split appeared in 26 series on this machine.

An early probe (`--runs 3`, TypeScript 7.0.2, tRPC server) gave `separated: the candidate is faster` for the Total time of an A with A comparison. The chance of such a result is 10% with 3 runs. The probe output is not saved. The default of `compare` is 5 runs, and a verdict needs at least 3 runs for each side.

## A with B

The verdict is for Check time. The medians are in the last column (baseline, then candidate).

| Candidate | Compiler | Runs | Series | Increase of the median | Separated | Medians |
| --- | --- | --- | --- | --- | --- | --- |
| tc-4 | 5.9.3 | 10 | 3 | +50 to +55 ms (+125% to +137.5%) | 3 of 3 | 0.04 s, 0.09 to 0.095 s |
| tc-10 | 5.9.3 | 10 | 3 | +140 to +160 ms (+350% to +400%) | 3 of 3 | 0.04 s, 0.18 to 0.2 s |
| trpc-big | 5.9.3 | 10 | 2 | +450 to +475 ms (+31.5% to +33.5%) | 2 of 2 | 1.42 to 1.43 s, 1.88 to 1.895 s |
| trpc-medium | 5.9.3 | 10 | 3 | +115 to +185 ms (+7.9% to +13.0%) | 1 of 3 | 1.41 to 1.455 s, 1.57 to 1.605 s |
| trpc-medium | 5.9.3 | 20 | 2 | +150 to +175 ms (+10.4% to +12.3%) | 1 of 2 | 1.42 to 1.445 s, 1.595 s |
| trpc-medium | 6.0.3 | 10 | 2 | +155 to +160 ms (+10.2% to +10.6%) | 2 of 2 | 1.51 to 1.515 s, 1.67 s |
| trpc-medium | 7.0.2 | 10 | 2 | +71 to +82 ms (+17.7% to +20.7%) | 2 of 2 | 0.398 to 0.4005 s, 0.4715 to 0.4805 s |
| trpc-small | 5.9.3 | 10 | 2 | +65 to +110 ms (+4.6% to +7.7%) | 1 of 2 | 1.42 to 1.425 s, 1.49 to 1.53 s |
| trpc-small | 7.0.2 | 10 | 2 | +25 to +34 ms (+6.0% to +8.7%) | 0 of 2 | 0.396 to 0.4085 s, 0.4305 to 0.433 s |

- All 10 series with an increase of 17.7% or more were `separated`. Of the 11 series with an increase of 4.6% to 13.0%, 5 were `separated`.
- The rule is conservative. A change smaller than the spread of one side can be `within noise`. More runs did not help: with 20 runs, 1 of 2 series separated, as with 10 runs. More runs widen the ranges.
- The Total time verdict was different in some series. It separated 3 of 3 for tc-10, 2 of 2 for big, 2 of 2 for medium with 6.0.3, and 0 of 3 for tc-4, 0 of 5 for medium with 5.9.3, 0 of 2 for medium with 7.0.2, and 0 of 4 for small. The Total time includes parse and library work that the candidate does not change, so the relative change is smaller.
- The compiler files of all candidate series: the baseline had 944 files and the candidate had 945, except for tc-4 and tc-10 (58 files on both sides).

## Offline comparison

We made reports with `--runs 10 --json` (traced run plus 10 untraced runs) and compared them with `whyts compare`.

- tc-4 against the example (5.9.3): Check time 0.04 s to 0.09 s (+50 ms, +125%), `separated`, slower. Total time 0.145 s to 0.2 s (+55 ms, +37.9%), `separated`. For the same change, the live series left Total time `within noise` three times. The verdict of a borderline case can change from one series to the next.
- The chains: `client.ts:16:14` (28.5 ms) is gone and `client.ts:17:14` (81.4 ms) is new. The candidate has one more line above the chain, so the line moved. The file interval of `client.ts` grew from 40.0 ms to 104.6 ms.
- trpc-medium against the checkout (5.9.3): Check time 1.47 s to 1.655 s (+185 ms, +12.6%), `separated`. Total time 2.525 s to 2.74 s (+215 ms, +8.5%), `separated`. The new chain `src/whyts-slowdown.ts:8:14` (137.3 ms) is listed as new. The result has 3 new, 3 gone, 1 grown and 2 unchanged entries. whyts printed the file count warning (944 and 945).
- A report of TypeScript 5.9.3 against a report of 7.0.2: whyts stopped with exit code 1. It named three reasons: the compiler kinds, the checker counts and the flags.
- A report of 5.9.3 against a report of 6.0.3: exit code 0 and a warning that the TypeScript versions differ.

## Warm-up

We evicted the project files and the compiler files from the page cache (`posix_fadvise`), then ran `whyts compare` of the tRPC server with itself (`--runs 3`). This was done 4 times.

| Trial | First baseline run, Check | First baseline run, Total | Median of measured baseline runs, Check | Median of measured baseline runs, Total |
| --- | --- | --- | --- | --- |
| 1 | 1.43 s | 2.87 s | 1.41 s | 2.49 s |
| 2 | 1.44 s | 2.77 s | 1.41 s | 2.45 s |
| 3 | 1.49 s | 2.86 s | 1.41 s | 2.49 s |
| 4 | 1.41 s | 2.75 s | 1.42 s | 2.50 s |

A cold first run added 0.25 to 0.38 s to the Total time (10% to 15%). The Check time of the cold run was 1.41 to 1.49 s, and the measured medians were 1.41 to 1.42 s. In the normal series, the cache was already warm. The warm-up Check time was between -11% and +9% of the median for the tRPC series.

## TypeScript 7 checker count

We ran the native compiler 15 times for each mode on the tRPC server project. The two modes ran in turns.

| Mode | Check median | Check spread | Total median | Total spread |
| --- | --- | --- | --- | --- |
| `--checkers 1` | 0.398 s | 18.1% | 0.688 s | 15.3% |
| default checkers | 0.24 s | 19.2% | 0.494 s | 13.8% |

The spread is about equal, so the default mode gives no gain in stability. We chose one checker for the untraced runs because the flags equal the traced run, so a chain time and a Check time describe the same work. The default mode is out of scope for this release.

## Not verified

- We ran the series on one machine (Linux x64, Node.js 24.21.0) that another job shared. We did not test Windows, macOS or a quiet machine. CI runs the unit tests on those systems, not the series.
- One real project (tRPC) and one example. The slowdowns are files that we added. We did not test a real regression from a project history.
- We tested compiler errors on one side only with a fake `tsc`, not with a real project with errors.
- We tested 10 and 20 runs for the series, and 3 runs in an early probe. We did not measure the behavior of the rule with 5 runs.
- TypeScript 7.0.2 only. We did not test other 7.x versions.
- The chance value assumes independent runs. We did not test this assumption.
- The sensitivity numbers apply to this machine and these projects. Another project or machine can have a different spread.

# v0.5.0 validation

Done on 2026-10-07 (Dubai time) with Node.js 24.21.0 on Linux x64. All TypeScript 7.0.2 runs used the `linux-x64` native package.

## Tests

- The syntax check passed for all source modules.
- Version 0.4.0 had 45 tests. This release has 56: one new trace test and ten tests in `test/native.test.js`.
- Results of `node --test`, run with a clean `TMPDIR`:

| Bundled TypeScript | Without `WHYTS_TS7` | With `WHYTS_TS7` (typescript@7.0.2) |
| --- | --- | --- |
| 5.9.3 | 55 passed, 1 skipped | 56 passed |
| 6.0.3 (`npm install --no-save typescript@6.0.3`) | 55 passed, 1 skipped | 56 passed |

- The skipped test runs the real native compiler. It needs `WHYTS_TS7`. The other nine native tests replay trimmed `types_0.json` and `trace.json` files from typescript@7.0.2 through a fake package, so they do not need TypeScript 7.
- The fixtures come from the project that `test/native.test.js` writes: BOM, CRLF, multibyte text, an upper case directory, and multibyte text before a type on the same line. One `checkVariableDeclaration` event (d.ts) comes from a second run of the same project, with its timestamps moved into the d.ts file check.
- Measured on typescript@7.0.2: the trace offsets are UTF-8 byte offsets that do not count a BOM. A BOM file has the same offsets as the same file without a BOM. The declaration columns in `types_0.json` are UTF-16 columns. The declaration paths are lower case, including directory names.
- We reverted each new behavior in turn and ran the whole suite. Each revert turned at least one test red. We then restored the code. The runs used a copy of the sources.
  - Do not convert UTF-8 byte offsets to UTF-16: the replay, the trace test and the real-compiler test failed.
  - Do not map lower case paths: the replay and the trace test failed.
  - Take the `Identifier` kind from the bundled compiler: the kind test failed.
  - Do not read the `Identifier` kind from the package: the package kind test failed.
  - Do not pass `--checkers 1`: the replay failed.
  - Remove the heap warning: the heap test and the CLI test failed. Pass the heap option to the native compiler: the heap test failed.
  - Remove the file count warning: the file count test failed.
  - Print the plain tsconfig error for a native run: the tsconfig test failed.
  - Remove the experimental and one-checker notes: the replay failed. Remove `experimental` from the JSON: the replay and the CLI test failed. Remove `EXPERIMENTAL` from the header: the replay failed.
  - Do not detect a native package through project resolution: the detection test failed. Do not accept a package directory in `--typescript`: nine tests failed.
  - Print the dump line without a value: the replay and the dump report test failed.
  - Mark lib files of the native package as unknown: the lib test failed.
- The BOM and CRLF cases have no revert of their own. They guard the whole conversion path, and the byte offset revert turns them red too.

## Test projects

tRPC (`trpc/trpc`, commit `d756e59`, project `packages/server/tsconfig.json`). `pnpm install --ignore-scripts --frozen-lockfile` (pnpm 12.4.1) took 10 s. No build was needed: both runs had 0 compiler errors and no TS2307. `packages/server` resolves typescript 7.0.2. The root resolves 6.0.3, which we passed with `--typescript`. The bundled compiler of whyts was 5.9.3, so the TypeScript 7 run built its graph with 5.9.3 and the TypeScript 6 run built its graph with 6.0.3. Three runs each, same machine, `nice -n 5`. The MBD gate lock was free before each step.

| | TypeScript 7.0.2, one checker | TypeScript 6.0.3 |
| --- | --- | --- |
| Check time, 3 runs | 0.480, 0.503, 0.507 s | 1.64, 1.58, 1.58 s |
| Total time, 3 runs | 0.745, 0.750, 0.780 s | 2.75, 2.62, 2.69 s |
| Process wall time, 3 runs | 1.79, 1.76, 1.80 s | 4.42, 4.22, 4.33 s |
| Files, import graph | 944 | 944 |
| Files, compiler (`Files:`) | 944 | 944 |
| Compiler errors | 0 | 0 |
| Warnings | 4 notes: experimental, one checker, trace overhead, counters | 2 notes: trace overhead, counters |

First three findings of the first run of each compiler:

| # | TypeScript 7.0.2 | TypeScript 6.0.3 |
| --- | --- | --- |
| 1 | measured, `src/adapters/fastify/fastifyTRPCPlugin.ts:66:3`, 141.0 ms chain, 3 source checks | measured, `src/adapters/fastify/fastifyTRPCPlugin.ts:66:3`, 259.3 ms chain, 1 source check |
| 2 | measured, `src/unstable-core-do-not-import/procedureBuilder.ts:532:10`, 10.2 ms chain | measured, `src/__tests__/trpcServerResource.ts:115:13`, 42.5 ms chain |
| 3 | observed, multiple loaded versions of `@types/mime` | measured, `src/unstable-core-do-not-import/procedureBuilder.ts:532:10`, 32.5 ms chain |

- In the first run, both compilers gave the same top finding and the same top project file (`fastifyTRPCPlugin.ts`) at the same position. The millisecond values differ between runs and compilers. Do not read them as a benchmark.
- The TypeScript 7 run reported 7 findings and the TypeScript 6 run reported 12. We did not investigate the difference.
- We also ran plain `tsc --noEmit --extendedDiagnostics`, one run each, without a trace. TypeScript 7.0.2 with the default checkers: Check 0.283 s, Total 0.479 s. TypeScript 7.0.2 with `--checkers 1`: Check 0.399 s, Total 0.642 s. TypeScript 6.0.3: Check 1.52 s, Total 2.48 s. This is why the report tells you not to compare the one-checker Check time with a default run.
- The raw output files are in `/opt/whyts-v05-out` on the bench: `trpc-server-ts7*.{txt,json}` and `trpc-server-ts6*.{txt,json}`.
- The file count warning did not fire in any real run, because both counts were 944. We chose the thresholds (more than 25 files and more than 10 percent apart) without a project that disagrees. Treat them as a first guess.

## Not verified

- We did not run the native compiler on Windows, macOS or Linux arm64, and we did not test any 7.x version other than 7.0.2.
- The code of the `bin/tsc` wrapper calls `process.execve` on Node.js 22.15 and later and starts a child process on older versions. We read this code. We did not test what a whyts timeout does to the native compiler on either path.
- We did not measure how a trace changes the `Types`, `Instantiations` and `Memory used` counters of the native compiler. The report says so.
- We did not run whyts with more than one native checker. The type ids in the trace collide across checkers.
- We tried one real project with TypeScript 7 (tRPC `packages/server`, 944 files, Check time near 0.5 s). Large projects and projects with errors are untested on TypeScript 7.

# v0.4.0 validation

Done on 2026-10-06 with Node.js 24.21.0 on Linux.

## Tests

- The syntax check passed for all five source modules.
- All 45 tests passed with TypeScript 5.9.3. All 45 passed again after `npm install --no-save typescript@6.0.3`. Version 0.3.1 had 29 tests. This release adds 16.
- We ran the tests with `TMPDIR` set to a clean directory. Another process had put TypeScript 7.0.2 in `/tmp/node_modules`, and test projects in `/tmp` resolved it. This is a bench problem and not a defect in whyts.
- We reverted each fix in turn and ran the new tests. Each revert made at least one test fail. We then restored the fix.
  - Create the program without the compiler host: the `require()` test failed. It failed only with TypeScript 6.0.3. TypeScript 5.9.3 does not throw in this case.
  - Remove the guard on the usage mode, and remove the guard on the file traversal: the isolation test failed.
  - Print the old crash message, and do not pass the heap option to the process: the abort test failed.
  - Turn off the dependency warning: the error summary tests failed.
  - Remove the check-time share: the share test failed.
  - List the test roots again: the test-root test failed.
  - Set the default timeout back to 120 s: the default timeout test failed.
  - Turn off the progress note, and remove `dumpTypesSeconds`: the progress and dump tests failed.
  - Allow TypeScript 7: the `--typescript` test failed.
  - Remove the traced-counter warning: the counter test failed.
  - Print error paths without `realpath`: the symlink test failed. GitHub Actions on macOS found this defect first.
  - Replace every control character in the CLI error with a space: the CLI crash message test failed.
- `npm pack --dry-run` lists `whyts-0.4.0.tgz` with 9 files.

## Test projects

We ran the changed CLI on clones of public projects on the bench. Tools: `/usr/bin/time -v`, `nice -n 5`. The MBD gate lock was free before each step started. The output files are in `/opt/whyts-korpus/out/v04-*` on the bench. We deleted the installed dependencies after the runs.

| Project | v0.3.1 | v0.4.0 |
| --- | --- | --- |
| playwright, root `tsconfig.json` (TypeScript 6.0.3) | Crash after 2.77 s: `Cannot read properties of undefined (reading 'kind')` | Finished. Compiler exit 2 with 13 errors, all TS2307 for generated files that were not built. Check 8.89 s, wall 19.6 s. The dependency warning showed. |
| playwright, `tests/tsconfig.json` | The same crash | Finished. 97 errors: 82 TS2307, 14 TS2305, 1 TS2345. Check 5.76 s, wall 12.1 s. |
| typespec compiler, `tsconfig.build.json`, default heap | `Compiler terminated by SIGABRT.` after 113.9 s | `Compiler terminated by SIGABRT.`, the heap diagnosis, the `--max-old-space-size` hint, and the last stderr lines. 115.9 s. |
| typespec compiler, `--max-old-space-size 10240` | Not available | Finished. Exit 2 with 1 error (TS2307). Total 6.09 s, Check 4.69 s, Dump types 114.03 s, wall 121.1 s. Peak memory 7.07 GB. |
| drizzle-orm `src` | Wall 193.9 s, Dump types 184.63 s (run with `--timeout 900`) | Default timeout. Finished. Exit 2 with 6 errors. Total 8.4 s, Check 6.74 s, Dump types 183.28 s, wall 192.3 s. |
| drizzle-orm `type-tests` | Wall 262.6 s, Total 14.38 s, Dump types 247.48 s (run with `--timeout 900`) | Default timeout. Finished. Exit 2 with 6 errors. Total 13.58 s, Check 11.87 s, Dump types 249.3 s, wall 263.5 s. Process 270.05 s. 8 progress notes. |

- The old default timeout of 120 s would have stopped both drizzle-orm runs. They needed more than 190 s.
- The report shows wall time and dump time separately. The largest `source-check-chain` finding shows an upper bound of 4.4% (playwright root), 2.9% (typespec), 7.3% (drizzle `src`) and 4.2% (drizzle `type-tests`) of Check time.
- The 6 drizzle-orm errors (TS2305 and TS7006) did not trigger the dependency warning. The warning did show for playwright and typespec, where TS2307 errors were all or most of the errors.
- The typespec default-heap run used the CLI before commit `eb8b422`. That commit keeps line breaks in the crash message. The CLI test covers it. We did not repeat the typespec run.

## Not verified

- We did not run the test-root change on the MBD project. Unit tests cover it. The drizzle-orm `src` run had no test roots without importers.
- We did not run v0.4.0 on trpc. We examined the `typescript@7.0.2` package instead (see the README).
- The typespec traced run reported 10,480,436 types. The value 135,624 for a run without a trace comes from an earlier test run. Our new run without a trace failed with TS6379 (the project is composite). We did not repeat it.
- The react-router numbers in the README (1887 errors and 4.76 s before the build, 0 errors and 12.43 s after) come from v0.3.1 runs. We did not repeat them with v0.4.0.

# v0.3.1 validation

Performed on 2026-10-06 with Node.js 24.21.0 on Linux.

- Syntax checks passed for all five source modules.
- All 29 tests passed with TypeScript 5.9.3 and, after `npm install --no-save typescript@6.0.3` in the same checkout, with TypeScript 6.0.3. v0.3.0 had 26 tests; this release adds three regression tests.
- Each new behavior test was confirmed to fail when its fix was temporarily reverted, and the revert was undone afterwards: dropping the error message from the trace parse warning, using `getTokenPos` instead of `getTokenStart` (against a scanner that lacks it), and removing the 80% chain coverage check. Hardcoding the version in `src/cli.js` fails the CLI version assertion.
- `npm pack` produced `whyts-0.3.1.tgz`. Installed offline-style with `--ignore-scripts` in a clean directory, `npx whyts --version` printed 0.3.1 and `--json` on `examples/barrel` reported `toolVersion` 0.3.1 with 3 findings.
- The version now comes from `package.json` for the CLI and the JSON report. The tests compare against `package.json` instead of a literal.

# v0.3.0 validation

Performed on 2026-10-05 with Node.js 24.19.0 on Linux.

- Syntax checks passed for all five source modules.
- All 26 tests passed with TypeScript 5.9.3 and in a separate checkout with TypeScript 6.0.3.
- The packed CLI installed successfully offline in a separate directory, printed version 0.3.0 and emitted valid JSON with the new chain and descriptor fields for the client example.
- Eight added regression tests cover same-thread temporal grouping, deferred source positions, file/thread isolation, inclusive interval unions, selected comparison hydration, leading comments/CRLF, UTF-8 chunk boundaries, missing/malformed descriptor files, and record/retention/scan budgets.
- A sparse file larger than 128 MiB resolves its selected descriptor after reading at most one 64 KiB chunk. The tail is deliberately not parsed once selection is complete.
- A file-handle lifecycle regression checks that the descriptor stream is fully closed before the reader returns, including early selection and EOF. This prevents temporary-directory removal races on Windows/Node 20.
- Existing real-compiler, config/import, canonical path casing, project/dependency prioritization, cache preservation, compiler-error, timeout, JSON and terminal-sanitization checks still pass.

## Saved real-project trace replay

The unmodified baseline trace and type-descriptor files from a private case-study archive were replayed through the v0.3 parser. Private source, filenames and raw trace/type contents are excluded from this repository.

- Trace: 6,221,754 bytes and 31,507 events.
- Type descriptors: 163,350,312 bytes. Version 0.2 skipped this file because it exceeded 128 MiB.
- All 15 selected type IDs resolved, including both sides of all five global comparisons, with no descriptor warnings.
- 46,202,880 bytes were scanned before selection completed; 5,008 bytes of descriptor JSON were retained.
- The legacy top-five individual source checks all came from one file. The new top-five chains covered three files, with 8, 2, 5, 3 and 3 recorded source members respectively.
- The largest chain's inclusive duration was 1,232.98 ms, counted once rather than summed across its eight members.

One local replay took about 581 ms for descriptor loading. Peak RSS for the whole replay process (including the parsed trace and grouping) was 148,128 KiB. These describe one parser run, not a compiler speedup, a stable benchmark or a 5 KB process-memory claim.

The full private project's source and dependencies were unavailable locally. This replay therefore verifies descriptor resolution and temporal grouping; source locations stay unavailable and declaration locations are labeled raw trace positions. Comment-aware definition normalization is verified using compiler-backed fixtures and must also be checked in the live project rerun.

A fresh live-project rerun is still required to assess actionable findings or additional compiler performance gains. The tool never edits that project. Compare candidate code against a fixed baseline using the same compiler/cache/flags and correctness checks, and counterbalance run order.

## Hosted validation

GitHub Actions is configured for Linux, Windows and macOS on Node 20, 22 and 24, plus a TypeScript 6 job. The first run exposed an asynchronous file-handle close race on Windows/Node 20; the reader now awaits closure. Hosted results for the final change are pending.

The README image retains an earlier TypeScript 5.9.3 example run: 38.4 ms for the client assignment and 31.8 ms for its contained comparison. It is an illustrative sampled result, not a v0.3 benchmark.
