/** Server-sent events: `version` on every fold change, `ping` keep-alives, a hard connection cap. */
import type { ServerResponse } from "node:http";

export const MAX_STREAMS = 20;

export interface Sse {
  /** Attach an already-authorized response; false when the cap is reached (nothing written). */
  add(res: ServerResponse): boolean;
  broadcast(version: string): void;
  count(): number;
  closeAll(): void;
}

export function createSse(opts: { pingMs?: number; max?: number } = {}): Sse {
  const pingMs = opts.pingMs ?? 25_000;
  const max = opts.max ?? MAX_STREAMS;
  const streams = new Map<ServerResponse, NodeJS.Timeout>();
  const drop = (res: ServerResponse): void => {
    const t = streams.get(res);
    if (t) clearInterval(t);
    streams.delete(res);
  };
  const send = (res: ServerResponse, text: string): void => {
    try {
      res.write(text);
    } catch {
      drop(res);
    }
  };
  return {
    add(res) {
      if (streams.size >= max) return false;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 5000\n\n");
      const timer = setInterval(() => send(res, "event: ping\ndata: {}\n\n"), pingMs);
      timer.unref();
      streams.set(res, timer);
      res.on("close", () => drop(res));
      return true;
    },
    broadcast(version) {
      const text = `event: version\ndata: ${JSON.stringify({ version })}\n\n`;
      for (const res of [...streams.keys()]) send(res, text);
    },
    count: () => streams.size,
    closeAll() {
      for (const res of [...streams.keys()]) {
        drop(res);
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
