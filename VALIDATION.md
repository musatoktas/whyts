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
