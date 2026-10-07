#!/usr/bin/env node
// whyts-mcp: starts the whyts MCP server on stdio. The server code is in the whyts package (whyts/mcp).
// This package adds the MCP SDK as a dependency and loads it here, so the server finds it in every install layout.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { serve } from 'whyts/mcp';

if (process.argv.length > 2) {
  process.stderr.write('whyts-mcp takes no arguments. It starts the whyts MCP server on stdio. See https://github.com/musatoktas/whyts#use-with-ai-coding-agents\n');
  process.exit(process.argv.slice(2).every(a => a === '-h' || a === '--help') ? 0 : 1);
}
await serve({ McpServer, serveStdio, z });
