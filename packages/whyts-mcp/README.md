# whyts-mcp

The MCP (Model Context Protocol) server of [whyts](https://github.com/musatoktas/whyts). It gives AI coding agents three tools, `analyze`, `compare` and `explain`, that measure why a TypeScript project is slow.

Start it over stdio:

```sh
npx -y whyts-mcp
```

Claude Code:

```sh
claude mcp add --transport stdio whyts -- npx -y whyts-mcp
```

For Cursor, VS Code, Codex, the tool list and the rules for agents, see [Use with AI coding agents](https://github.com/musatoktas/whyts#use-with-ai-coding-agents).

This package contains only a start script. The server code is in the `whyts` package, which this package pins to the same version. The version of `whyts-mcp` always equals the version of `whyts`.
