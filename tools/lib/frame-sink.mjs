// A loopback endpoint the page streams raw frame bytes to over a WebSocket (binary messages: 4-byte LE frame
// index + pixels). Measured at 1080p RGBA (8.3 MB/frame): fetch POST of an ArrayBuffer ~170 ms, of a Blob
// ~40 ms, base64 over CDP ~125 ms, WebSocket ~45 ms (Chromium-side ~185 MB/s, not helped by more sockets).
// WebSocket keeps one ordered stream with cheap acks; capture.mjs sends yuv420p (3.1 MB) to cut the bytes.
//
// Frames are written to `sink` strictly in index order, with backpressure: each message is acknowledged
// ("ok <i>") only once its bytes were accepted by the sink, and the page keeps at most a couple of frames in
// flight, so it can never run ahead of the encoder.
import http from 'node:http';
import { acceptWebSocket } from './ws-lite.mjs';

/**
 * @param {{ write(buf: Buffer, index: number): Promise<void> }} sink
 * @param {number} frameBytes expected size of every frame (asserted)
 */
export async function createFrameSink(sink, frameBytes) {
  let next = 0; // next frame index to hand to the sink
  const pending = new Map(); // index -> { buf, ack }
  let failed = null;
  let writing = false;
  const sockets = new Set();

  const pump = async () => {
    if (writing) return;
    writing = true;
    try {
      while (pending.has(next) && !failed) {
        const job = pending.get(next);
        pending.delete(next);
        try {
          await sink.write(job.buf, next);
          job.ack(`ok ${next}`);
        } catch (e) {
          failed = e;
          job.ack(`err ${String(e.message ?? e).slice(0, 100)}`);
        }
        next++;
      }
    } finally {
      writing = false;
    }
  };

  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') return socket.destroy();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const ws = acceptWebSocket(req, socket);
    ws.onMessage((msg) => {
      const index = msg.readUInt32LE(0);
      const buf = msg.subarray(4);
      const ack = (s) => { try { ws.send(s); } catch {} };
      if (failed) return ack(`err ${failed.message}`.slice(0, 120));
      if (buf.length !== frameBytes) {
        failed = new Error(`frame ${index}: got ${buf.length} bytes, expected ${frameBytes}`);
        return ack(`err ${failed.message}`.slice(0, 120));
      }
      if (index < next || pending.has(index)) {
        failed = new Error(`frame ${index} delivered twice`);
        return ack(`err ${failed.message}`.slice(0, 120));
      }
      pending.set(index, { buf, ack });
      pump();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    /** frames handed to the sink so far (= index of the next expected frame) */
    get written() {
      return next;
    },
    get error() {
      return failed;
    },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
