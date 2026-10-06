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
