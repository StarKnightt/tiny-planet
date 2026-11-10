// Minimal WebSocket server endpoint (RFC 6455), just enough for one trusted local client (our own headless
// page) to stream large binary messages to this process: handshake, client->server masked binary/continuation
// frames, server->client short text frames, close. No extensions, no compression. Node has no built-in
// WebSocket server and the project must not add dependencies.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Accept an 'upgrade' request. Returns { send(text), close(), onMessage(cb(Buffer)) }.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 */
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);

  let listeners = [];
  let chunks = [];
  let have = 0;
  let parts = []; // fragments of the current message
  let partsLen = 0;

  const take = (n) => {
    // remove and return the first n bytes of the receive queue
    if (chunks[0].length >= n) {
      const c = chunks[0];
      const out = c.subarray(0, n);
      if (c.length === n) chunks.shift();
      else chunks[0] = c.subarray(n);
      have -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = chunks[0];
      const k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k);
      o += k;
      if (k === c.length) chunks.shift();
      else chunks[0] = c.subarray(k);
    }
    have -= n;
    return out;
  };
  // first n bytes without consuming them (only concatenates as many chunks as needed: a header is <= 14 bytes)
  const peek = (n) => {
    if (chunks[0].length >= n) return chunks[0].subarray(0, n);
    const parts = [];
    let got = 0;
    for (const c of chunks) {
      parts.push(c);
      got += c.length;
      if (got >= n) break;
    }
    return Buffer.concat(parts, got).subarray(0, n);
  };
  let needed = 0; // bytes the frame being received needs in total; skip parsing until they are all here

  const unmask = (buf, mask) => {
    // 32-bit words first (fast), then the tail
    const n4 = buf.length >> 2;
    const m = mask.readUInt32LE(0);
    if (buf.byteOffset % 4 === 0) {
      const u = new Uint32Array(buf.buffer, buf.byteOffset, n4);
      for (let i = 0; i < n4; i++) u[i] ^= m;
    } else {
      for (let i = 0; i < n4 * 4; i++) buf[i] ^= mask[i & 3];
    }
    for (let i = n4 * 4; i < buf.length; i++) buf[i] ^= mask[i & 3];
  };

  const parse = () => {
    for (;;) {
      if (have < 2) return;
      const h = peek(Math.min(have, 14));
      const fin = (h[0] & 0x80) !== 0;
      const op = h[0] & 0x0f;
      const masked = (h[1] & 0x80) !== 0;
      let len = h[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (have < 4) return; len = h.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (have < 10) return; len = Number(h.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (have < need) {
        needed = need;
        return;
      }
      needed = 0;
      take(off);
      const mask = masked ? Buffer.from(take(4)) : null;
      // copy the payload into its own aligned buffer so unmasking can use 32-bit words
      const payload = Buffer.alloc(len);
      if (len) take(len).copy(payload);
      if (mask) unmask(payload, mask);
      if (op === 0x8) { // close
        try { socket.end(Buffer.from([0x88, 0])); } catch {}
        return;
      }
      if (op === 0x9) { // ping -> pong
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        parts.push(payload);
        partsLen += payload.length;
        if (fin) {
          const msg = parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLen);
          parts = [];
          partsLen = 0;
          for (const l of listeners) l(msg);
        }
      }
    }
  };
  socket.on('data', (d) => {
    chunks.push(d);
    have += d.length;
    if (have >= needed) parse();
  });
  socket.on('error', () => {});
  return {
    onMessage(cb) { listeners.push(cb); },
    send(text) {
      const p = Buffer.from(text);
      if (p.length > 125) throw new Error('ws-lite: short messages only');
      socket.write(Buffer.concat([Buffer.from([0x81, p.length]), p]));
    },
    close() { try { socket.end(Buffer.from([0x88, 0])); socket.destroy(); } catch {} },
  };
}
