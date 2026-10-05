# v0.1.0 validation

Performed on 2026-10-05 with Node.js 24.19.0 on Linux.

- Syntax checks passed for all three source modules.
- All 10 tests passed with TypeScript 5.9.3.
- The same 10 tests passed in a separate checkout with TypeScript 6.0.3.
- The packaged CLI was installed into a separate directory, printed its version, and produced valid JSON with a successful compiler check and a barrel-reach finding on the included example.
- A real compiler run preserved an existing tsbuildinfo cache and did not add build outputs to the project.
- Compiler errors, invalid arguments, missing projects/files, and a compiler timeout were exercised.

The GitHub Actions workflow is configured for Linux, Windows, and macOS on Node 20, 22, and 24, plus a TypeScript 6 job. Those hosted jobs have not run yet. Local validation does not establish performance gains on any third-party repository.
