# whyts instructions for AI coding agents

Copy these rules into `AGENTS.md`, `CLAUDE.md` or the rules file of your agent. They assume the whyts MCP server is set up. The command is `npx -y -p whyts@0.8.0 -p @modelcontextprotocol/server@2 -p zod@4 whyts mcp`. See the README, "Use with AI coding agents".

1. Call `analyze` first, with an absolute path, to find where the check time goes.
2. Before you change types, copy the project. Use a git worktree, so `compare` has a baseline.
3. After a type change, run `compare` with the baseline and the changed copy.
4. Trust only the `decision`. `separated` is a measured change; read `direction`. `within-noise` is no change.
5. If `diagnoses` has entries, apply the `remedy` of the first entry. Then run `compare` again.
6. If `compilerErrors` has entries, or the `decision` is `not-comparable`, fix the errors first. Timings with errors do not compare.
7. Before you change `include` or imports, run `explain` for the file. It shows the import chain.
8. Do not report a time saving from two `analyze` results. Only `compare` proves a change.

Each call takes as long as a type check, or longer. Wait for the result. whyts runs one call at a time.
