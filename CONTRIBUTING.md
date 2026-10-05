# Contributing

Keep whyts small and evidence-based. A finding needs an observable compiler or graph signal, a clear confidence label, and a reproduction. A heuristic must not claim measured savings or causal attribution.

Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, and `npm pack --dry-run` before sending a change. Add a small fixture for resolution or parser behavior that changes. Do not add automatic source edits, network telemetry, or package script execution to the diagnostic path.

For issues, include Node and TypeScript versions, the selected tsconfig, and a minimal sanitized reproduction. A full private repository or trace is usually unnecessary.
