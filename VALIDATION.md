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
