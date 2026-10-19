/**
 * Minimal TCP client for the opt-in signal hook (spec 04).
 * Length-prefixed JSON frames: 4-byte big-endian length + UTF-8 JSON. Localhost only.
 */
import { connect, Socket } from 'net';

const MAX_FRAME = 4 * 1024 * 1024;

export function parseHookPort(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /\[SIGNAL-PORT\]\s*(\d+)/.exec(lines[i]);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

export function sendHookRequest(port: number, payload: unknown, timeoutMs = 10000): Promise<any> {
  const conn = new HookConnection(port);
  return conn.request(payload, timeoutMs).finally(() => conn.close());
}

/**
 * Persistent hook connection: one TCP socket, many framed requests.
 * This is the primary usage — the hook server holds the socket open and
 * answers each request in turn. One-shot sockets per request are NOT used:
 * the server cannot reliably distinguish an idle peer from a closed one.
 */
export class HookConnection {
  private sock: Socket;
  private buf = Buffer.alloc(0);
  private pending: Array<{
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private opened: Promise<void>;
  private closed = false;

  constructor(private port: number) {
    this.sock = connect(port, '127.0.0.1');
    this.opened = new Promise((resolve, reject) => {
      this.sock.on('connect', () => resolve());
      this.sock.on('error', (err: Error) => {
        if (!this.connectedOnce) reject(err);
        else this.failAll(err);
      });
    });
    this.sock.on('data', (chunk: Buffer) => this.onData(chunk));
    this.sock.on('close', () => this.failAll(new Error('hook connection closed')));
  }

  private connectedOnce = false;

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4 && this.pending.length > 0) {
      const len = this.buf.readUInt32BE(0);
      if (len <= 0 || len > MAX_FRAME) {
        this.failAll(new Error('hook response too large or invalid'));
        this.sock.destroy();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const text = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      const p = this.pending.shift()!;
      clearTimeout(p.timer);
      try {
        p.resolve(JSON.parse(text));
      } catch {
        p.reject(new Error('hook returned invalid JSON'));
      }
    }
  }

  async request(payload: unknown, timeoutMs = 10000): Promise<any> {
    await this.opened;
    this.connectedOnce = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === resolve);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error('hook request timed out'));
      }, timeoutMs);
      this.pending.push({ resolve, reject, timer });
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32BE(body.length, 0);
      body.copy(frame, 4);
      this.sock.write(frame);
    });
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
    }
    this.sock.destroy();
  }
}
