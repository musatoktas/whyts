// Smoke test for the packed packages: install the two tarballs in an empty directory, start the `whyts-mcp` bin,
// and check that `initialize` and `tools/list` answer. Usage: node scripts/smoke-whyts-mcp.mjs <whyts.tgz> <whyts-mcp.tgz>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [whytsTgz, mcpTgz] = process.argv.slice(2).map(p => path.resolve(p));
if (!whytsTgz || !mcpTgz) { console.error('Usage: node scripts/smoke-whyts-mcp.mjs <whyts.tgz> <whyts-mcp.tgz>'); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whyts-mcp-smoke-'));
const done = code => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(code); };
fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"smoke","private":true}');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', whytsTgz, mcpTgz], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
if (install.status !== 0) { console.error(install.stdout, install.stderr); done(1); }

const bin = path.join(dir, 'node_modules', 'whyts-mcp', 'bin', 'whyts-mcp.js');
const child = spawn(process.execPath, [bin], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', stderr = '';
const waiting = new Map();
child.stderr.on('data', c => { stderr += c; });
child.stdout.on('data', c => {
  buffer += c;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  }
});
const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const request = (id, method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`No answer to ${method}. stderr: ${stderr}`)), 60000);
  waiting.set(id, m => { clearTimeout(timer); resolve(m); });
  send({ id, method, params });
});
try {
  const init = await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  send({ method: 'notifications/initialized' });
  const list = await request(2, 'tools/list', {});
  const names = list.result.tools.map(t => t.name).sort();
  if (names.join() !== 'analyze,compare,explain') throw new Error(`Unexpected tools: ${names}`);
  console.log(JSON.stringify({ server: init.result.serverInfo, tools: names }));
  child.kill();
  done(0);
} catch (error) {
  console.error(error.message);
  child.kill('SIGKILL');
  done(1);
}
