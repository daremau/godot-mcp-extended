// MCP protocol conformance suite (spec 05): zero-Godot, mocked CLI.
// Spawns build/index.js over stdio and asserts the anti-Fennara properties:
// version negotiation, ID echo, pipelining, notification silence, stdout purity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'build', 'index.js');
const FAKE_GODOT = join(ROOT, 'test', 'fixtures', 'fake-godot.sh');

function startServer(extraEnv = {}) {
  const child = spawn('node', [SERVER], {
    env: { ...process.env, GODOT_PATH: FAKE_GODOT, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  const lines = [];
  const pending = [];
  let waiters = [];
  child.stdout.on('data', (d) => {
    out += d.toString();
    const parts = out.split('\n');
    out = parts.pop();
    for (const p of parts) {
      if (!p.trim()) continue;
      const msg = JSON.parse(p);
      lines.push(msg);
      const w = waiters.shift();
      if (w) w(msg);
      else pending.push(msg);
    }
  });
  return {
    child,
    lines,
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + '\n');
    },
    next(timeoutMs = 10000) {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for response')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

test('initialize negotiates versions and echoes numeric IDs', async (t) => {
  for (const v of ['2024-11-05', '2025-03-26']) {
    const s = startServer();
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const res = await s.next();
    assert.equal(res.id, 1);
    assert.ok(typeof res.result.protocolVersion === 'string', 'server must declare a version');
    assert.equal(res.result.serverInfo.name, 'godot-mcp');
    await s.stop();
  }
  t.diagnostic('negotiation ok');
});

test('string IDs echo verbatim; pipelined requests answer in order', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 'a-1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 'a-2', method: 'tools/list', params: {} });
  const r1 = await s.next();
  const r2 = await s.next();
  assert.equal(r1.id, 'a-1');
  assert.equal(r2.id, 'a-2');
  assert.ok(Array.isArray(r2.result.tools) && r2.result.tools.length > 10);
  await s.stop();
});

test('notifications produce zero response bytes', async () => {
  const s = startServer();
  const before = s.lines.length;
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.lines.length, before, 'notification must not produce a response');
  await s.stop();
});

test('tools/list shape: every tool named, described, snake_case', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const res = await s.next();
  const names = res.result.tools.map((t) => t.name);
  for (const t of res.result.tools) {
    assert.ok(t.name && t.description && t.inputSchema, `tool missing fields: ${t.name}`);
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `not snake_case: ${t.name}`);
  }
  for (const expected of ['dotnet_build', 'dotnet_test', 'run_project_capture', 'hook_exec', 'get_godot_version']) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  await s.stop();
});

test('unknown tool returns MethodNotFound with matching ID', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 'z-9', method: 'tools/call', params: { name: 'nope_nothing', arguments: {} } });
  const res = await s.next();
  assert.equal(res.id, 'z-9');
  assert.equal(res.error.code, -32601);
  await s.stop();
});

test('stdout purity: every line is JSON-RPC with id or method', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await s.next();
  for (const m of s.lines) {
    assert.equal(m.jsonrpc, '2.0');
    assert.ok(m.id !== undefined || m.method !== undefined);
  }
  await s.stop();
});

test('tools/list answers in under 2s (buffering regression guard)', async () => {
  const s = startServer();
  const t0 = Date.now();
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await s.next();
  assert.ok(Date.now() - t0 < 2000, 'response slower than 2s — possible stdout buffering regression');
  await s.stop();
});

test('new-tool contracts: path traversal and missing project rejected without Godot', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dotnet_build', arguments: { projectPath: '/tmp/../etc' } } });
  const r1 = await s.next();
  assert.match(JSON.stringify(r1.result.content), /Invalid project path/);
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dotnet_build', arguments: { projectPath: '/tmp' } } });
  const r2 = await s.next();
  assert.match(JSON.stringify(r2.result.content), /Not a valid Godot project/);
  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hook_exec', arguments: { command: 'tree' } } });
  const r3 = await s.next();
  assert.match(JSON.stringify(r3.result.content), /No active Godot run/);
  await s.stop();
});

test('run_project_capture verdicts with mocked Godot CLI', async () => {
  const s = startServer();
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await s.next();
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_project_capture', arguments: { projectPath: '/tmp/sigok', durationSeconds: 10 } } });
  const res = await s.next(30000);
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.verdict, 'clean-exit');
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].kind, 'ready');
  await s.stop();
});
