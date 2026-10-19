// Unit tests for the hook TCP framing client (spec 04/05). No Godot needed:
// spins up fake hook servers speaking the length-prefixed JSON protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { parseHookPort, sendHookRequest, HookConnection } from '../build/hook_client.js';

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function startFakeServer(onRequest) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const server = createServer((sock) => {
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const req = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        sock.write(frame(onRequest(req)));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('parseHookPort finds the last port line', () => {
  assert.equal(parseHookPort(['noise', '[SIGNAL-PORT] 41234', '[SIGNAL-PORT] 45678']), 45678);
  assert.equal(parseHookPort(['no ports here']), null);
  assert.equal(parseHookPort([]), null);
});

test('sendHookRequest round-trips a framed response', async () => {
  const server = await startFakeServer((req) => ({ ok: true, echo: req }));
  const port = server.address().port;
  const res = await sendHookRequest(port, { command: 'tree' });
  assert.equal(res.ok, true);
  assert.equal(res.echo.command, 'tree');
  server.close();
});

test('sendHookRequest rejects oversize frames', async () => {
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(0xffffffff, 0);
  const server = createServer((sock) => {
    sock.end(evil); // lying length prefix, then EOF: client must reject, not hang/OOM.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await assert.rejects(sendHookRequest(port, { command: 'tree' }, 5000), /too large/);
  server.close();
});

test('HookConnection serves many sequential requests on one socket', async () => {
  let connections = 0;
  const server = createServer((sock) => {
    connections += 1;
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const req = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        sock.write(frame({ ok: true, n: req.n }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const conn = new HookConnection(port);
  const a = await conn.request({ n: 1 });
  const b = await conn.request({ n: 2 });
  conn.close();
  assert.equal(a.n, 1);
  assert.equal(b.n, 2);
  assert.equal(connections, 1);
  server.close();
});

test('sendHookRequest rejects on connection refused', async () => {
  // Port 1 is (practically) never listening: fast refusal.
  await assert.rejects(sendHookRequest(1, { command: 'quit' }, 3000));
});
