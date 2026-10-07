/** WP7 fix round 2 (Opus security review): image denylist, limiter race, rebinding, ledger, webhook. */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { createHmac } from "crypto";
import { startServer, rawRequest, WEBHOOK_SECRET, FIXTURE } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { buildPrivateDist } from "./helpers/build-dist";
import type { PrivateDist } from "./helpers/build-dist";
import { scaled } from "./helpers/platform";
import { emptyHistogram, uploadWithRetry } from "./helpers/upload-retry";

jest.setTimeout(scaled(60_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const CONTROL = path.join(__dirname, "..");
const read = (p: string): string => fs.readFileSync(p, "utf8");
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("1 the image carries the denylist, and boot refuses without it", () => {
  it("Dockerfile COPYs exactly scripts/campaign/plane-denylist.json to its repo-relative path", () => {
    const df = read(path.join(CONTROL, "Dockerfile"));
    expect(df).toMatch(
      /^COPY\s+scripts\/campaign\/plane-denylist\.json\s+(\.\/)?scripts\/campaign\/plane-denylist\.json\s*$/m,
    );
  });
  it("railway.toml watches apps/control/** plus exactly that file", () => {
    const toml = read(path.join(CONTROL, "railway.toml"));
    const m = /watchPatterns\s*=\s*\[([^\]]*)\]/.exec(toml);
    expect(m).not.toBeNull();
    const pats = [...(m as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect(pats).toEqual(["apps/control/**", "scripts/campaign/plane-denylist.json"]);
  });
  it("denylistAvailable() is false for a missing file, true for the shipped one", () => {
    const { denylistAvailable } = require("../src/sources/denylist");
    const old = process.env.CONTROL_DENYLIST;
    try {
      process.env.CONTROL_DENYLIST = path.join(os.tmpdir(), "no-such-denylist.json");
      expect(denylistAvailable()).toBe(false);
      delete process.env.CONTROL_DENYLIST;
      expect(denylistAvailable()).toBe(true);
    } finally {
      if (old === undefined) delete process.env.CONTROL_DENYLIST;
      else process.env.CONTROL_DENYLIST = old;
    }
  });
});

// B1: built, not assumed: `turbo test` does not build dist/, so a fresh checkout has none. The build
// is the once-per-run one from test/global-setup.ts (a private build when run outside it).
let dist: PrivateDist;
beforeAll(() => {
  dist = buildPrivateDist("wp7");
});
afterAll(() => dist?.cleanup());

const boot = (env: Record<string, string>) =>
  spawnSync("node", [dist.main], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
const LOCAL = {
  CONTROL_LOCAL: "1",
  CONTROL_FIXTURE: FIXTURE,
};
const FULL = {
  CONTROL_FIXTURE: FIXTURE,
  CONTROL_PASSWORD: "a-long-enough-password",
  CONTROL_SESSION_SECRET: "s".repeat(40),
  CONTROL_GITHUB_TOKEN: "ghp_x",
  CONTROL_STATE_REPO: "acme/acme-control-state",
  CONTROL_REPO: "acme/acme",
  CONTROL_PUBLIC_URL: "https://control.example.test",
};
describe("boot refusals (exit 1 with a clear message)", () => {
  it("the private build exists (a fresh checkout has no dist/)", () =>
    expect(fs.existsSync(dist.main)).toBe(true));
  it("a denylist that fails to load", () => {
    const r = boot({ ...LOCAL, CONTROL_DENYLIST: "/nonexistent/denylist.json" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/denylist/i);
  });
  it("CONTROL_LOCAL=1 on Railway", () => {
    const r = boot({ ...LOCAL, RAILWAY_ENVIRONMENT: "production" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CONTROL_LOCAL/);
  });
  it("a password under 16 characters", () => {
    const r = boot({ ...FULL, CONTROL_PASSWORD: "short-pass" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CONTROL_PASSWORD/);
    expect(r.stderr).not.toContain("short-pass");
  });
  it("non-local without CONTROL_PUBLIC_URL", () => {
    // fixture mode is exempt (its origin is the random local port), so test the real shape
    const { CONTROL_PUBLIC_URL: _u, CONTROL_FIXTURE: _f, ...rest } = FULL;
    void _u;
    void _f;
    const r = boot(rest);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CONTROL_PUBLIC_URL/);
  });
});

describe("2 the login limiter counts an attempt before its body arrives", () => {
  it("100 sockets with slow bodies: at most 5 are answered other than 429", async () => {
    h = await startServer();
    const port = h.port;
    const body = "password=wrong-wrong-wrong";
    const results = await Promise.all(
      Array.from(
        { length: 100 },
        () =>
          new Promise<number>((resolve) => {
            const s = net.connect(port, "127.0.0.1");
            let buf = "";
            s.on("data", (d) => {
              buf += d.toString();
              const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
              if (m) {
                s.destroy();
                resolve(Number(m[1]));
              }
            });
            s.on("error", () => resolve(0));
            s.on("connect", () => {
              s.write(
                `POST /login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\n` +
                  `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
              );
              setTimeout(() => s.write(body), 1000);
            });
          }),
      ),
    );
    expect(results.filter((c) => c !== 429).length).toBeLessThanOrEqual(5);
  });
});

describe("3 local mode refuses a foreign Host (DNS rebinding)", () => {
  it("421 for any other Host, on every route; loopback names work", async () => {
    h = await startServer({ local: true });
    for (const p of ["/", "/api/state.json", "/api/health?public=1", "/robots.txt", "/login"]) {
      const r = await h.req("GET", p, { headers: { host: "evil.example" } });
      expect([p, r.status]).toEqual([p, 421]);
      const r2 = await h.req("GET", p, { headers: { host: `evil.example:${h.port}` } });
      expect([p, r2.status]).toEqual([p, 421]);
    }
    const ok1 = await h.req("GET", "/api/health?public=1", {
      headers: { host: `localhost:${h.port}` },
    });
    const ok2 = await h.req("GET", "/api/health?public=1");
    expect([ok1.status, ok2.status]).toEqual([200, 200]);
    const wrongPort = await h.req("GET", "/", { headers: { host: "127.0.0.1:1" } });
    expect(wrongPort.status).toBe(421);
  });
});

describe("4 ledger rows pass the denylist (fields redacted, the row kept)", () => {
  it("a branch name holding a denylisted slug is written as [redacted]", async () => {
    const dl = path.join(os.tmpdir(), `dl-${process.pid}.json`);
    fs.writeFileSync(
      dl,
      JSON.stringify({ patterns: [{ name: "synthetic-slug", regex: "zzsynth-slug" }] }),
    );
    const old = process.env.CONTROL_DENYLIST;
    process.env.CONTROL_DENYLIST = dl;
    try {
      h = await startServer({
        writeback: true, // the ledger is persisted (pushed) only with write-back on
        depsOver: {
          github: {
            poll: async () => ({
              prs: [
                {
                  number: 777,
                  title: "t",
                  state: "OPEN",
                  headRefName: "feat/zzsynth-slug",
                  headRefOid: "a".repeat(40),
                  baseRefName: "master",
                  createdAt: "2026-01-10T08:00:00Z",
                  updatedAt: "2026-01-11T09:00:00Z",
                  body: "",
                },
              ],
              branches: [],
              files: {},
            }),
            state: { rateLimit: { remaining: 4000, resetAt: null } },
          },
        },
      });
      await h.app.tick();
      const text = h.world.remoteFile("derived/prs.jsonl");
      expect(text).not.toContain("zzsynth-slug");
      const row = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((r) => r.pr === 777);
      expect(row).toBeDefined();
      expect(row.headRef).toBe("[redacted]");
      expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(1024);
    } finally {
      if (old === undefined) delete process.env.CONTROL_DENYLIST;
      else process.env.CONTROL_DENYLIST = old;
      fs.rmSync(dl, { force: true });
    }
  });
});

describe("5 webhook hardening", () => {
  const BODY = JSON.stringify({ action: "closed" });
  const sign = (b: string): string =>
    "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(b).digest("hex");
  const post = (extra: Record<string, string>, body = BODY) =>
    h!.req("POST", "/api/github-webhook", {
      headers: { "content-type": "application/json", "x-github-event": "push", ...extra },
      body,
    });

  it("a missing signature is answered 401 without the body being read", async () => {
    h = await startServer({ webhook: true });
    const code = await new Promise<number>((resolve) => {
      const s = net.connect(h!.port, "127.0.0.1");
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
        if (m) {
          s.destroy();
          resolve(Number(m[1]));
        }
      });
      s.on("error", () => resolve(0));
      s.on("connect", () =>
        s.write(
          `POST /api/github-webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500000\r\n\r\n`,
        ),
      );
      setTimeout(() => resolve(-1), scaled(3000)); // no body is ever sent: a read-first server would hang
    });
    expect(code).toBe(401);
  });
  it("no secret configured: 401 before reading the body", async () => {
    h = await startServer({ webhook: false });
    const code = await new Promise<number>((resolve) => {
      const s = net.connect(h!.port, "127.0.0.1");
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
        if (m) {
          s.destroy();
          resolve(Number(m[1]));
        }
      });
      s.on("error", () => resolve(0));
      s.on("connect", () =>
        s.write(
          `POST /api/github-webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nx-hub-signature-256: sha256=${"0".repeat(64)}\r\nContent-Length: 500000\r\n\r\n`,
        ),
      );
      setTimeout(() => resolve(-1), scaled(3000));
    });
    expect(code).toBe(401);
  });
  it("a repeated X-GitHub-Delivery is acknowledged as a duplicate and schedules nothing", async () => {
    h = await startServer({ webhook: true });
    const hd = { "x-hub-signature-256": sign(BODY), "x-github-delivery": "d-1" };
    const a = await post(hd);
    expect(a.status).toBe(202);
    const b = await post(hd);
    expect(b.status).toBe(202);
    expect(b.json().duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.refreshCalls).toBe(1);
  });
  it("two different deliveries inside 10 s run one refresh now (the other waits)", async () => {
    h = await startServer({ webhook: true });
    await post({ "x-hub-signature-256": sign(BODY), "x-github-delivery": "d-a" });
    await new Promise((r) => setTimeout(r, 100));
    await post({ "x-hub-signature-256": sign(BODY), "x-github-delivery": "d-b" });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.refreshCalls).toBe(1);
  });
});

describe("5b webhook bodies are streamed into the HMAC, never buffered", () => {
  /**
   * B941. Live memory is measured while every upload is held open mid-body. A streamed body is
   * hashed as it arrives and kept nowhere (a few MB of socket buffers in all); a buffered body would
   * hold ~900 KB x 200 = 180 MB at that moment. Holding the sockets open removes the race a
   * peak sampler had (bodies finished before it looked), and a forced collection before each reading
   * leaves only what the server still references, so the result no longer depends on test order or load.
   */
  const post = (): string =>
    `POST /api/github-webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nx-hub-signature-256: sha256=${"0".repeat(64)}\r\nContent-Length: ${1024 * 1024}\r\n\r\n`;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("200 concurrent half-sent 1 MB uploads leave live memory < 50 MB (the body is streamed, never buffered)", async () => {
    h = await startServer({ webhook: true });
    require("v8").setFlagsFromString("--expose-gc");
    const gc: () => void = global.gc ?? require("vm").runInNewContext("gc");
    const live = (): number => {
      gc();
      gc();
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const part = Buffer.alloc(900 * 1024, 97);
    const port = h.port;
    live();
    const base = live();
    const socks: net.Socket[] = [];
    const hist = emptyHistogram();
    const head = post();
    await Promise.all(
      Array.from({ length: 200 }, async () => {
        const s = await uploadWithRetry(port, head, part, hist);
        if (s) socks.push(s);
      }),
    );
    const sent = socks.length;
    await sleep(500); // let the server read everything the kernel buffered
    const grown = live() - base;
    socks.forEach((s) => s.destroy());
    if (sent !== 200) console.error("B941 upload failures by class:", JSON.stringify(hist));
    else if (Object.keys(hist["retried-client-transient"]).length)
      console.log(
        "B941 retried client-transient:",
        JSON.stringify(hist["retried-client-transient"]),
      );
    expect(sent).toBe(200); // every upload really reached the server, so the reading means something
    expect(grown).toBeLessThan(50 * 1024 * 1024);
  });

  /**
   * B950. The old test mapped any client socket error to 0 and demanded a 401 from every socket, and
   * failed deterministically on macOS while passing on Linux. The exact macOS mechanism was not
   * reproduced (a flood with a well-formed signature streams the whole 1 MiB and is answered 401
   * on a live connection here), but the assertion was on the CLIENT's view of an event whose delivery
   * the OS controls: when a server answers and closes while the client is still writing, whether
   * the client reads the 401 or only an EPIPE/ECONNRESET is platform- and timing-dependent. So the
   * proof is made on the SERVER side: a spy on ServerResponse (scoped by the server's own address)
   * records every status sent, and the harness counts how often the webhook handler's work ran. A
   * client either reads a 401 or sees a reset: both are "rejected". The cap is proven by its own
   * over-cap test, "never buffered" by the live-memory test.
   */
  // every code a client sees when the SERVER closed first (the last two are Node's own, raised when
  // the peer's FIN already ended or destroyed our socket); ENOBUFS, EADDRNOTAVAIL, timeouts etc. stay
  // `other` so an environmental failure is red, not silently "rejected"
  const RESET_CODES = new Set([
    "EPIPE",
    "ECONNRESET",
    "ECONNABORTED",
    "ERR_STREAM_WRITE_AFTER_END",
    "ERR_STREAM_DESTROYED",
  ]);
  type Outcome =
    | { status: number; head?: string; port?: number; written?: number }
    | { reset: string }
    | { other: string };
  const classifyError = (code: string): Outcome =>
    RESET_CODES.has(code) ? { reset: code } : { other: code };
  /** Rejected = the client read a 401, or its socket was reset (the server closed first). */
  const isRejected = (o: Outcome): boolean => ("status" in o && o.status === 401) || "reset" in o;
  const headWith = (sig: string, len: number): string =>
    `POST /api/github-webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nx-hub-signature-256: ${sig}\r\nContent-Length: ${len}\r\n\r\n`;
  /** Raw-socket upload: header, then `chunks` (optionally paced); never throws, always an Outcome. */
  const upload = (
    port: number,
    head: string,
    chunks: Buffer[],
    o: { pauseReads?: boolean; chunkDelayMs?: number; maxMs?: number } = {},
  ): Promise<Outcome> =>
    new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      let buf = "";
      let done = false;
      const end = (r: Outcome): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        s.destroy();
        resolve(r);
      };
      const t = setTimeout(() => end({ other: "TIMEOUT" }), o.maxMs ?? 20_000);
      if (o.pauseReads) s.pause();
      s.on("data", (d) => {
        buf += d.toString();
        const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
        // keep the whole header block so a status that is NOT a 401 can be diagnosed (B950: a 400 on macOS)
        if (m) {
          end({
            status: Number(m[1]),
            head: buf.split("\r\n\r\n")[0].slice(0, 2000),
            port: s.localPort, // pairs this client with its server-side socket (that socket's remotePort)
            written: s.bytesWritten, // what this client really wrote (the MacBook: exactly head + Content-Length)
          });
        }
      });
      s.on("error", (e: NodeJS.ErrnoException) => {
        const code = e.code ?? "UNKNOWN";
        end(classifyError(code));
      });
      s.on("connect", () => {
        s.write(head);
        const send = (i: number): void => {
          if (done || i >= chunks.length) return;
          s.write(chunks[i]);
          if (o.chunkDelayMs) setTimeout(() => send(i + 1), o.chunkDelayMs);
          else send(i + 1);
        };
        send(0);
      });
    });
  /** Every status the server sends, with the bytes its connection had read by then. */
  type Seen = { status: number; bytesRead: number; destroyed: boolean; sock?: number };
  type ClientErr = {
    code?: string;
    message: string;
    /** the bytes AT the parse error (Node's `bytesParsed` offset into its `rawPacket`) */
    raw?: string;
    at?: number;
    chunk?: number;
    bytesRead?: number;
    /** which server-side connection (ids are assigned as connections arrive) */
    sock?: number;
  };
  const spyResponses = (port: number) => {
    const http = require("http");
    const orig = http.ServerResponse.prototype.end;
    const origEmit = http.Server.prototype.emit;
    const seen: Seen[] = [];
    const clientErrors: ClientErr[] = [];
    const sockIds = new WeakMap<object, number>();
    const remotePorts = new Map<number, number>();
    let nextSock = 0;
    http.ServerResponse.prototype.end = function (this: any, ...a: unknown[]) {
      // scoped by the SERVER's own address: `socket.localPort` is cleared once a socket is destroyed,
      // which would hide exactly the responses sent on reset connections (the macOS shape), and an
      // earlier test's server may still be draining in the same process
      const sock = this.socket;
      if (sock?.server?.address?.()?.port === port) {
        seen.push({
          status: this.statusCode,
          bytesRead: sock.bytesRead ?? -1,
          destroyed: Boolean(sock.destroyed),
          sock: sockIds.get(sock),
        });
      }
      return orig.apply(this, a);
    };
    // Node answers a request its parser rejects with a bare `400 Bad Request` written straight to the
    // socket (the default `clientError` handling), which never passes through ServerResponse: only
    // this event shows that the SERVER sent such a 400
    http.Server.prototype.emit = function (this: any, ev: string, ...a: any[]) {
      if (ev === "connection" && this.address?.()?.port === port && a[0]) {
        sockIds.set(a[0], ++nextSock);
        if (typeof a[0].remotePort === "number") remotePorts.set(nextSock, a[0].remotePort);
      }
      if (ev === "clientError" && this.address?.()?.port === port) {
        // diagnostics must never break the server's own event chain: swallow anything odd
        try {
          // the bytes the parser rejected: Node attaches the whole chunk as `rawPacket` and the offset
          // of the error as `bytesParsed` (HPE errors only), so this shows WHAT the parser choked on
          // (body bytes? a second request line?) and how much of the connection it had read
          const rawPacket: Buffer | undefined = a[0]?.rawPacket;
          const at: number | undefined = rawPacket ? (a[0]?.bytesParsed ?? 0) : undefined;
          clientErrors.push({
            code: a[0]?.code,
            message: String(a[0]?.message ?? a[0]),
            raw:
              rawPacket && at !== undefined
                ? Buffer.from(rawPacket)
                    .subarray(at, at + 48)
                    .toString("latin1")
                : undefined,
            at,
            chunk: rawPacket?.length,
            bytesRead: a[1]?.bytesRead,
            sock: a[1] ? sockIds.get(a[1]) : undefined,
          });
        } catch {
          clientErrors.push({ message: "clientError capture failed" });
        }
      }
      return origEmit.call(this, ev, ...a);
    };
    return {
      seen,
      clientErrors,
      remotePorts,
      stop: (): void => {
        http.ServerResponse.prototype.end = orig;
        http.Server.prototype.emit = origEmit;
      },
    };
  };
  /** Parser rejections only: Node also emits `clientError` for ECONNRESET and timeouts, which are not. */
  const parserErrors = (errs: ClientErr[]): ClientErr[] =>
    errs.filter((e) => e.code?.startsWith("HPE_"));
  /**
   * Lead ruling B950: a 400 read by a client is accepted ONLY when the SERVER explains it on that
   * socket. The MacBook showed Node's bare parser 400 (HPE_INVALID_METHOD) when the server-side
   * connection had read MORE than head + Content-Length, while the server's own answer to every
   * request was a 401 and the handler never ran. The client had written EXACTLY head + Content-Length
   * on every such socket (1048749 bytes, measured by `written`), so the surplus bytes appear on the
   * SERVER side of the connection: the parser was fed buffered bytes after the message it had already
   * completed. Why (a macOS/Node read-path quirk is the working hypothesis) is unproven. A 400 is explained
   * when: the server recorded a 401 for that socket (it cannot mean "before": on the MacBook the
   * parser error came first and the handler's 401 followed), the parser error is HPE_INVALID_METHOD,
   * the socket had read more than head + Content-Length, and the handler's work never ran.
   * Anything else is a problem. Returns the problems (empty = fine).
   */
  const BARE_400 = "HTTP/1.1 400 Bad Request\r\nConnection: close";
  /** The server sockets whose parser error is explained: HPE_INVALID_METHOD, a 401 recorded for the
   * socket, and more bytes read than head + Content-Length. */
  const explainedSockets = (seen: Seen[], errs: ClientErr[], limit: number): Set<number> => {
    const answered401 = new Set(
      seen.filter((x) => x.status === 401 && x.sock !== undefined).map((x) => x.sock),
    );
    const out = new Set<number>();
    for (const e of parserErrors(errs)) {
      if (
        e.code === "HPE_INVALID_METHOD" &&
        e.sock !== undefined &&
        answered401.has(e.sock) &&
        (e.bytesRead ?? 0) > limit
      ) {
        out.add(e.sock);
      }
    }
    return out;
  };
  /** The most bytes any server socket had read when it answered, EXCLUDING the explained sockets
   * (which legitimately read past head + Content-Length before the handler's 401 was recorded). */
  const maxBytesReadOutside = (seen: Seen[], explained: Set<number>): number =>
    Math.max(
      0,
      ...seen.filter((x) => x.sock === undefined || !explained.has(x.sock)).map((x) => x.bytesRead),
    );
  const assessFlood = (a: {
    outcomes: Outcome[];
    seen: Seen[];
    clientErrors: ClientErr[];
    remotePorts: Map<number, number>;
    declared: number;
    headLen: number;
    refreshCalls: number;
  }): string[] => {
    const problems: string[] = [];
    const explained = explainedSockets(a.seen, a.clientErrors, a.declared + a.headLen);
    for (const e of parserErrors(a.clientErrors)) {
      if (e.sock === undefined || !explained.has(e.sock)) {
        problems.push(
          `parser error ${e.code} on socket ${e.sock} is not explained (bytesRead ${e.bytesRead}, limit ${a.declared + a.headLen})`,
        );
      }
    }
    // a client-read 400 must be Node's bare parser reply AND be paired with ITS OWN explained socket
    // (the client's local port is that server socket's remote port)
    let unpaired = 0;
    for (const o of a.outcomes) {
      if (!("status" in o) || o.status !== 400) continue;
      // the client's local port is its server socket's remote port; a port held by MORE than one
      // server socket (ephemeral port reuse) is ambiguous and never pairs
      const holders =
        o.port === undefined ? [] : [...a.remotePorts].filter(([, rp]) => rp === o.port);
      const id = holders.length === 1 ? holders[0][0] : undefined;
      if (o.head !== BARE_400 || id === undefined || !explained.has(id)) unpaired++;
    }
    if (unpaired > 0) {
      problems.push(`${unpaired} uploads read a 400 that no explained socket accounts for`);
    }
    const bad = a.outcomes.filter((o) => !isRejected(o) && !("status" in o && o.status === 400));
    if (bad.length > 0) {
      problems.push(`${bad.length} uploads were neither a 401, a reset nor an explained 400`);
    }
    if (a.refreshCalls !== 0) problems.push("the webhook handler's work ran");
    return problems;
  };
  /** What the sockets did, for a failure message and for CONTROL_TEST_VERBOSE. */
  const floodReport = (outcomes: Outcome[], seen: Seen[], clientErrors: ClientErr[]) => {
    const tally: Record<string, number> = {};
    for (const o of outcomes) {
      const k =
        "status" in o
          ? `status ${o.status}`
          : "reset" in o
            ? `reset ${o.reset}`
            : `other ${o.other}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    const statuses: Record<string, number> = {};
    for (const x of seen) statuses[String(x.status)] = (statuses[String(x.status)] ?? 0) + 1;
    const bad = outcomes.filter((o) => !isRejected(o));
    return {
      node: process.version,
      tally,
      notRejectedCount: bad.length,
      notRejected: bad.slice(0, 5),
      answered: seen.length,
      destroyed: seen.filter((x) => x.destroyed).length,
      statuses,
      clientErrors: clientErrors.slice(0, 5),
    };
  };

  it("isRejected: a read 401 or a reset is a rejection; any other status or error is not", () => {
    expect(isRejected({ status: 401 })).toBe(true);
    for (const reset of ["EPIPE", "ECONNRESET", "ECONNABORTED"]) {
      expect(isRejected({ reset })).toBe(true);
    }
    for (const status of [200, 202, 400, 403, 413, 500]) expect(isRejected({ status })).toBe(false);
    for (const other of ["ECONNREFUSED", "ETIMEDOUT", "TIMEOUT", "UNKNOWN"]) {
      expect(isRejected({ other })).toBe(false);
    }
  });

  it("floodReport says what the sockets did: tally, the first non-rejected outcomes with their response head, the server's statuses and parser-level client errors", () => {
    const rep = floodReport(
      [
        { status: 401 },
        { reset: "EPIPE" },
        { status: 400, head: "HTTP/1.1 400 Bad Request" },
        { other: "TIMEOUT" },
      ],
      [{ status: 401, bytesRead: 1, destroyed: false }],
      [
        {
          code: "HPE_INVALID_METHOD",
          message: "Parse Error",
          raw: "aaaaaaaa",
          at: 0,
          chunk: 65536,
          bytesRead: 1048749,
        },
      ],
    );
    expect(rep.tally).toEqual({
      "status 401": 1,
      "reset EPIPE": 1,
      "status 400": 1,
      "other TIMEOUT": 1,
    });
    expect(rep.notRejectedCount).toBe(2);
    expect(rep.notRejected).toEqual([
      { status: 400, head: "HTTP/1.1 400 Bad Request" },
      { other: "TIMEOUT" },
    ]);
    expect(rep.answered).toBe(1);
    expect(rep.statuses).toEqual({ "401": 1 });
    expect(rep.clientErrors).toEqual([
      {
        code: "HPE_INVALID_METHOD",
        message: "Parse Error",
        raw: "aaaaaaaa",
        at: 0,
        chunk: 65536,
        bytesRead: 1048749,
      },
    ]);
  });

  it("a rejected delivery closes its connection: bytes sent after the 401 are never parsed as a new request (no HPE clientError)", async () => {
    h = await startServer({ webhook: true });
    const spy = spyResponses(h.port);
    let head = "";
    let timedOut = false;
    try {
      await new Promise<void>((resolve) => {
        const s = net.connect(h!.port, "127.0.0.1");
        let buf = "";
        let junk = false;
        const t = setTimeout(() => {
          timedOut = true; // the server never closed the connection
          s.destroy();
          resolve();
        }, scaled(3000));
        s.on("data", (d) => {
          buf += d.toString();
          if (!junk && /^HTTP\/1\.1 401/.test(buf)) {
            junk = true;
            head = buf;
            // the delivery was rejected; whatever the client sends NOW must not be parsed as a new
            // request (the MacBook's HPE_INVALID_METHOD: leftover bytes read as a request line)
            s.write("XXXXXXXX\r\n\r\n");
          }
        });
        s.on("error", () => {}); // the junk write may EPIPE once the server has closed
        s.on("close", () => {
          clearTimeout(t);
          resolve();
        });
        s.on("connect", () => {
          s.write(headWith(`sha256=${"0".repeat(64)}`, 5));
          s.write("hello");
        });
      });
      await sleep(200);
    } finally {
      spy.stop();
    }
    expect(head).toMatch(/^HTTP\/1\.1 401/);
    expect(head.toLowerCase()).toContain("connection: close"); // the server announces the close
    expect(timedOut).toBe(false); // ...and really closes the connection after the response
    expect(parserErrors(spy.clientErrors)).toEqual([]); // so nothing is ever parsed as a new request
    expect(h.refreshCalls).toBe(0);
  });

  it("the EARLY 401 (a malformed signature, refused before the body is read) also announces Connection: close and closes", async () => {
    h = await startServer({ webhook: true });
    let head = "";
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const s = net.connect(h!.port, "127.0.0.1");
      const t = setTimeout(() => {
        timedOut = true;
        s.destroy();
        resolve();
      }, scaled(3000));
      s.on("data", (d) => (head += d.toString()));
      s.on("error", () => {});
      s.on("close", () => {
        clearTimeout(t);
        resolve();
      });
      s.on("connect", () => {
        s.write(headWith("sha256=zz", 5));
        s.write("hello");
      });
    });
    expect(head).toMatch(/^HTTP\/1\.1 401/);
    expect(head.toLowerCase()).toContain("connection: close");
    expect(timedOut).toBe(false);
  });

  /** Everything a forged-delivery flood must satisfy: shared by the 200-upload test and the test that
   * makes some sockets' connections read bytes beyond Content-Length (the MacBook shape). Throws with
   * the whole report. */
  const checkFlood = (a: {
    spy: ReturnType<typeof spyResponses>;
    outcomes: Outcome[];
    uploads: number;
    declared: number;
    refreshCalls: number;
  }): void => {
    const { spy, outcomes, declared } = a;
    const headLen = headWith(`sha256=${"0".repeat(64)}`, declared).length;
    // what the sockets did, built BEFORE any assertion so a failing run still reports it
    const report = floodReport(outcomes, spy.seen, spy.clientErrors);
    if (process.env.CONTROL_TEST_VERBOSE) console.info("B950 flood", JSON.stringify(report));
    // client side + parser: every upload is a 401, a reset, or a 400 the SERVER explains on that
    // socket (assessFlood); anything else is red and the failure carries the whole report
    const problems = assessFlood({
      outcomes,
      seen: spy.seen,
      clientErrors: spy.clientErrors,
      remotePorts: spy.remotePorts,
      declared,
      headLen,
      refreshCalls: a.refreshCalls,
    });
    if (problems.length > 0) {
      throw new Error(`B950 flood: ${problems.join("; ")}: ${JSON.stringify(report)}`);
    }
    // server side (the platform-independent proof): it sent no 2xx, answered every live connection
    // 401, and the handler's work (a refresh) never ran for a forged delivery. The cap itself is
    // proven by the over-cap test, "never buffered" by the live-memory test.
    const seen = spy.seen;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(a.uploads);
    // never a 2xx; a live connection is answered 401; a connection that was reset first may carry
    // the 401, or a 413 for the body its client abandoned
    expect(seen.filter((x) => x.status >= 200 && x.status < 300)).toEqual([]);
    expect(seen.filter((x) => !x.destroyed && x.status !== 401)).toEqual([]);
    expect(seen.filter((x) => x.destroyed && ![401, 413].includes(x.status))).toEqual([]);
    // sanity: a connection with no parser error never read more than the declared body (the explained
    // sockets legitimately read past it before their 401 was recorded: assessFlood covers those)
    const explainedSocks = explainedSockets(seen, spy.clientErrors, declared + headLen);
    expect(maxBytesReadOutside(seen, explainedSocks)).toBeLessThanOrEqual(declared + 4096);
    expect(outcomes.filter((o) => "status" in o).length).toBeLessThanOrEqual(seen.length);
    expect(a.refreshCalls).toBe(0);
  };

  it("a flood where some connections read bytes beyond Content-Length (the MacBook shape, simulated by over-sending clients) passes the SAME checks", async () => {
    h = await startServer({ webhook: true });
    const MB = Buffer.alloc(1024 * 1024, 97);
    const extra = Buffer.alloc(65363, 97);
    const spy = spyResponses(h.port);
    let outcomes: Outcome[];
    try {
      outcomes = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          upload(
            h!.port,
            headWith(`sha256=${"0".repeat(64)}`, MB.length),
            i % 5 === 0 ? [MB, extra] : [MB],
          ),
        ),
      );
      await sleep(300);
    } finally {
      spy.stop();
    }
    // the mini cannot make the server re-read bytes, so these clients really over-send: the server
    // side sees the same thing as on the MacBook, a connection that read past the message it completed
    expect(parserErrors(spy.clientErrors).length).toBeGreaterThan(0);
    checkFlood({ spy, outcomes, uploads: 40, declared: MB.length, refreshCalls: h.refreshCalls });
  });

  it("bytes read beyond the declared Content-Length reproduce the MacBook shape: a bare 400 first, a clientError with the offending bytes, the server's 401 recorded on a destroyed socket", async () => {
    h = await startServer({ webhook: true });
    const spy = spyResponses(h.port);
    let out: Outcome;
    try {
      // declares 5 body bytes, sends them plus junk in the same write: the parser reads the junk as
      // the start of a NEW request (HPE_INVALID_METHOD) while the first request's handler is still
      // awaiting its body, so Node's default clientError reply (a bare 400) can beat the 401
      out = await upload(
        h.port,
        headWith(`sha256=${"0".repeat(64)}`, 5),
        [Buffer.from("helloXXXXXXXXXXXX\r\n\r\n")],
        { maxMs: 8000 },
      );
      await sleep(300);
    } finally {
      spy.stop();
    }
    expect(spy.clientErrors.length).toBeGreaterThan(0);
    expect(spy.clientErrors[0].code).toBe("HPE_INVALID_METHOD");
    expect(spy.clientErrors[0].raw).toContain("XXXX"); // the exact bytes the parser choked on
    expect(spy.clientErrors[0].bytesRead).toBeGreaterThan(0);
    // the server's own answer was exactly one 401, recorded on a socket Node had already destroyed
    expect(spy.seen.map((x) => x.status)).toEqual([401]);
    expect(spy.seen[0].destroyed).toBe(true);
    expect(h.refreshCalls).toBe(0);
    // the SAME rule the flood applies explains this real shape end to end: a 401 on that socket, an
    // HPE_INVALID_METHOD, more bytes read than head + Content-Length, the handler never ran
    expect(
      assessFlood({
        outcomes: [out],
        seen: spy.seen,
        clientErrors: spy.clientErrors,
        remotePorts: spy.remotePorts,
        declared: 5,
        headLen: headWith(`sha256=${"0".repeat(64)}`, 5).length,
        refreshCalls: h.refreshCalls,
      }),
    ).toEqual([]);
    // the client read Node's bare parser 400 (no app security headers, `Connection: close` only) or,
    // depending on the OS, only a reset: whichever the OS delivers (the lesson of B950), never the 401
    expect(
      "reset" in out ||
        (out as { status: number; head?: string }).head ===
          "HTTP/1.1 400 Bad Request\r\nConnection: close",
    ).toBe(true);
  });

  describe("assessFlood: a client-read 400 is accepted ONLY when the server explains it ON THAT SOCKET (lead ruling B950)", () => {
    const DECLARED = 1048576;
    const HEAD = 173;
    const LIMIT = DECLARED + HEAD; // a request that is complete is exactly this many bytes
    const BARE = "HTTP/1.1 400 Bad Request\r\nConnection: close";
    const ok401 = (sock: number): Seen => ({
      status: 401,
      bytesRead: LIMIT,
      destroyed: true,
      sock,
    });
    const hpe = (sock: number, extra: Partial<ClientErr> = {}): ClientErr => ({
      code: "HPE_INVALID_METHOD",
      message: "Parse Error: Invalid method encountered",
      sock,
      bytesRead: LIMIT + 65363,
      ...extra,
    });
    // client port 1001 <-> server socket 1 (read a 401), client port 1002 <-> server socket 2 (read a
    // bare 400 and the parser rejected extra bytes on it)
    const base = {
      outcomes: [
        { status: 401, port: 1001 },
        { status: 400, head: BARE, port: 1002 },
      ] as Outcome[],
      seen: [ok401(1), ok401(2)],
      clientErrors: [hpe(2)],
      remotePorts: new Map<number, number>([
        [1, 1001],
        [2, 1002],
      ]),
      declared: DECLARED,
      headLen: HEAD,
      refreshCalls: 0,
    };
    it("accepts a 400 when THAT socket got a 401, the parser error is HPE_INVALID_METHOD, it read more than head + Content-Length, and the handler never ran", () => {
      expect(assessFlood(base)).toEqual([]);
    });
    it("rejects a 400 on a socket the server never answered with a 401", () => {
      expect(assessFlood({ ...base, seen: [ok401(1)] }).length).toBeGreaterThan(0);
    });
    it("rejects a different HPE code", () => {
      for (const code of [
        "HPE_INVALID_CONSTANT",
        "HPE_INVALID_HEADER_TOKEN",
        "HPE_UNEXPECTED_CONTENT_LENGTH",
      ]) {
        expect(assessFlood({ ...base, clientErrors: [hpe(2, { code })] }).length).toBeGreaterThan(
          0,
        );
      }
    });
    it("rejects bytesRead at or below head + Content-Length (no extra bytes), accepts one byte more", () => {
      expect(
        assessFlood({ ...base, clientErrors: [hpe(2, { bytesRead: LIMIT })] }).length,
      ).toBeGreaterThan(0);
      expect(
        assessFlood({ ...base, clientErrors: [hpe(2, { bytesRead: LIMIT - 1 })] }).length,
      ).toBeGreaterThan(0);
      expect(assessFlood({ ...base, clientErrors: [hpe(2, { bytesRead: LIMIT + 1 })] })).toEqual(
        [],
      );
    });
    it("rejects a 400 with no parser error behind it, and a parser error on a socket nobody answered", () => {
      expect(assessFlood({ ...base, clientErrors: [] }).length).toBeGreaterThan(0);
      expect(assessFlood({ ...base, clientErrors: [hpe(9)] }).length).toBeGreaterThan(0);
    });
    it("rejects a 400 read on socket X when only socket Y has the explained parser error", () => {
      // client port 1002 read the 400, but the parser error sits on server socket 1 (client port 1001)
      expect(assessFlood({ ...base, clientErrors: [hpe(1)] }).length).toBeGreaterThan(0);
    });
    it("rejects a 400 whose head is not Node's bare parser reply (an app 400 carries security headers)", () => {
      const app400 = "HTTP/1.1 400 Bad Request\r\nX-Robots-Tag: noindex, nofollow, noarchive";
      const outcomes = [
        { status: 401, port: 1001 },
        { status: 400, head: app400, port: 1002 },
      ] as Outcome[];
      expect(assessFlood({ ...base, outcomes }).length).toBeGreaterThan(0);
    });
    it("rejects a 400 that carries no client port (it cannot be paired with a server socket)", () => {
      const outcomes = [{ status: 401 }, { status: 400, head: BARE }] as Outcome[];
      expect(assessFlood({ ...base, outcomes }).length).toBeGreaterThan(0);
    });
    it("rejects a 400 whose client port is held by more than one server socket (ephemeral port reuse is ambiguous)", () => {
      const remotePorts = new Map<number, number>([
        [1, 1001],
        [2, 1002],
        [3, 1002], // a second server socket with the same remote port
      ]);
      expect(assessFlood({ ...base, remotePorts }).length).toBeGreaterThan(0);
    });
    it("rejects when the webhook handler's work ran", () => {
      expect(assessFlood({ ...base, refreshCalls: 1 }).length).toBeGreaterThan(0);
    });
    it("rejects any outcome that is neither a 401, a reset nor an explained 400", () => {
      expect(
        assessFlood({ ...base, outcomes: [{ other: "ETIMEDOUT" }, { status: 401, port: 1001 }] })
          .length,
      ).toBeGreaterThan(0);
      expect(
        assessFlood({
          ...base,
          outcomes: [
            { status: 202, port: 1001 },
            { status: 401, port: 1002 },
          ],
        }).length,
      ).toBeGreaterThan(0);
    });
    it("ignores a clientError that is not a parser error (ECONNRESET)", () => {
      const reset: ClientErr = { code: "ECONNRESET", message: "read ECONNRESET", sock: 5 };
      expect(
        assessFlood({
          ...base,
          outcomes: [{ status: 401, port: 1001 }, { reset: "EPIPE" }],
          clientErrors: [reset],
        }),
      ).toEqual([]);
    });
    it("explainedSockets names the sockets with an explained parser error; the over-read bound applies only to the others", () => {
      const explained = explainedSockets(base.seen, base.clientErrors, LIMIT);
      expect([...explained]).toEqual([2]);
      // socket 2 legitimately read past head + Content-Length before its 401 was recorded
      const seen = [ok401(1), { ...ok401(2), bytesRead: LIMIT + 65363 }];
      expect(maxBytesReadOutside(seen, explained)).toBe(LIMIT);
      expect(maxBytesReadOutside(seen, new Set())).toBe(LIMIT + 65363);
    });
  });

  it("classifyError pins the reset codes: the server-closed-first codes are resets, environmental ones are not", () => {
    for (const code of [
      "EPIPE",
      "ECONNRESET",
      "ECONNABORTED",
      "ERR_STREAM_WRITE_AFTER_END",
      "ERR_STREAM_DESTROYED",
    ]) {
      expect(classifyError(code)).toEqual({ reset: code });
    }
    for (const code of [
      "ENOBUFS",
      "EADDRNOTAVAIL",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EMFILE",
      "UNKNOWN",
    ]) {
      expect(classifyError(code)).toEqual({ other: code });
    }
  });

  it("a client that keeps writing after the server's EARLY 401 and is reset still counts as rejected", async () => {
    h = await startServer({ webhook: true });
    const spy = spyResponses(h.port);
    let out: Outcome;
    try {
      // a malformed signature is refused before a byte of the body is read ("Connection: close");
      // the client reads nothing and keeps writing after the server closed: EPIPE/ECONNRESET on
      // any OS, the exact shape macOS produced for the flood test
      out = await upload(
        h.port,
        headWith("sha256=zz", 1024 * 1024),
        Array.from({ length: 80 }, () => Buffer.alloc(256 * 1024, 97)),
        { pauseReads: true, chunkDelayMs: 25, maxMs: 8000 },
      );
    } finally {
      spy.stop();
    }
    // paused reads plus a paced write normally surface a reset, but whether the client reads the
    // buffered 401 or only a reset is exactly what the OS decides: either is a rejection
    expect(isRejected(out)).toBe(true);
    expect(spy.seen.map((x) => x.status)).toEqual([401]); // the server did answer, once, 401
    expect(h.refreshCalls).toBe(0); // the webhook handler's work never ran
  });

  it("a body over the 1 MiB cap is refused 413 EVEN WITH a valid signature, and the handler never runs", async () => {
    h = await startServer({ webhook: true });
    const CAP = 1024 * 1024;
    const body = Buffer.alloc(2 * CAP, 97);
    // a signature that is valid for the WHOLE body: a server that hashed past the cap, or whose cap
    // was lifted, would accept this delivery; the real one drops everything past the cap unhashed
    const sig = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const spy = spyResponses(h.port);
    let out: Outcome;
    try {
      out = await upload(
        h.port,
        headWith(sig, body.length),
        Array.from({ length: 32 }, (_, i) => body.subarray(i * 65536, (i + 1) * 65536)),
        { maxMs: 10_000 },
      );
    } finally {
      spy.stop();
    }
    expect("status" in out ? out.status === 413 : "reset" in out).toBe(true);
    if ("status" in out) expect((out.head ?? "").toLowerCase()).toContain("connection: close");
    expect(spy.seen.map((x) => x.status)).toEqual([413]);
    expect(parserErrors(spy.clientErrors)).toEqual([]);
    expect(h.refreshCalls).toBe(0);
  });

  it("200 concurrent fake-signature 1 MB uploads are all rejected (401 or a reset), a signed delivery still works", async () => {
    h = await startServer({ webhook: true });
    const MB = Buffer.alloc(1024 * 1024, 97);
    const spy = spyResponses(h.port);
    let outcomes: Outcome[];
    try {
      outcomes = await Promise.all(
        Array.from({ length: 200 }, () =>
          upload(h!.port, headWith(`sha256=${"0".repeat(64)}`, MB.length), [MB]),
        ),
      );
    } finally {
      spy.stop();
    }
    checkFlood({
      spy,
      outcomes,
      uploads: 200,
      declared: MB.length,
      refreshCalls: h.refreshCalls,
    });
    const body = JSON.stringify({ a: 1 });
    const ok = await h.req("POST", "/api/github-webhook", {
      headers: {
        "x-hub-signature-256":
          "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
        "x-github-delivery": "after-flood",
        "x-github-event": "push",
      },
      body,
    });
    expect(ok.status).toBe(202);
    await sleep(100);
    expect(h.refreshCalls).toBeGreaterThan(0); // control: a SIGNED delivery does run the handler's work
  });
});

describe("production guards live in createControlServer", () => {
  const make = (config: Record<string, unknown>) => {
    const { makeWorld } = require("./helpers/temp-repo");
    const { createControlServer } = require("../src/http/server");
    const world = makeWorld();
    try {
      return createControlServer({
        config: { local: false, host: "0.0.0.0", port: 0, ...config },
        env: world.env("g"),
        github: {
          poll: async () => ({ prs: [], branches: [], files: {} }),
          state: { rateLimit: { remaining: 1 } },
        },
      });
    } finally {
      world.cleanup();
    }
  };
  const ok = {
    password: "a-long-enough-password",
    sessionSecret: "s".repeat(40),
    publicOrigin: "https://control.example.test",
  };
  const RAIL = ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID"];
  const clean = (): void => RAIL.forEach((k) => delete process.env[k]);
  afterEach(clean);

  it("a valid production config is accepted", () => {
    expect(() => make(ok)).not.toThrow();
  });
  it("a password under 16 characters", () => {
    expect(() => make({ ...ok, password: "short-pass" })).toThrow(/CONTROL_PASSWORD/);
  });
  it("no public origin outside local/fixture mode", () => {
    expect(() => make({ ...ok, publicOrigin: undefined })).toThrow(/CONTROL_PUBLIC_URL/);
  });
  it.each(RAIL)("local mode on Railway (%s)", (k) => {
    process.env[k] = "x";
    expect(() => make({ local: true, host: "127.0.0.1" })).toThrow(/CONTROL_LOCAL/);
  });
  it("an unloadable denylist", () => {
    const old = process.env.CONTROL_DENYLIST;
    process.env.CONTROL_DENYLIST = "/nonexistent/dl.json";
    try {
      expect(() => make(ok)).toThrow(/denylist/i);
    } finally {
      if (old === undefined) delete process.env.CONTROL_DENYLIST;
      else process.env.CONTROL_DENYLIST = old;
    }
  });
});

describe("final: refused boot leaves nothing behind, ts is canonical UTC ISO", () => {
  it("a refused boot removes everything it created under TMPDIR", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
    try {
      const { CONTROL_PUBLIC_URL: _u, CONTROL_FIXTURE: _f, ...rest } = FULL;
      void _u;
      void _f;
      const r = boot({ ...rest, TMPDIR: tmp });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/CONTROL_PUBLIC_URL/);
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const V: any = require("../src/domain/validate");
  const line = (seq: number, ts: string) =>
    JSON.stringify({ seq, ts, lane: "lane-u", type: "lane.note", by: "agent", note: "n" });
  const check = (...ts: string[]) =>
    V.validateEvents(
      [{ file: "lane-u.jsonl", text: ts.map((t, i) => line(i + 1, t)).join("\n") + "\n" }],
      { tasks: [], releaseIds: [] },
    ).filter((e: { reason: string }) => /^ts\b/.test(e.reason)) as Array<{ reason: string }>;
  it("rejects an offset, a short fraction, a missing Z; accepts seconds or milliseconds", () => {
    expect(check("2026-01-12T10:00:00+02:00")).not.toEqual([]);
    expect(check("2026-01-12T10:00:00.5Z")).not.toEqual([]);
    expect(check("2026-01-12T10:00:00")).not.toEqual([]);
    expect(check("2026-01-12T10:00:00Z")).toEqual([]);
    expect(check("2026-01-12T10:00:00.123Z")).toEqual([]);
  });
  it("rejects mixed precision (it would break the string-ordered ts compare)", () => {
    expect(check("2026-01-12T10:00:00Z", "2026-01-12T10:00:01.500Z")).not.toEqual([]);
    expect(check("2026-01-12T10:00:00.100Z", "2026-01-12T10:00:01Z")).not.toEqual([]);
  });
  const CANON = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  it("server write-back and the ledger emit canonical ts", async () => {
    h = await startServer({ writeback: true });
    await h.app.tick();
    const s = await h.session();
    const st = (await h.stateJson(s)).state;
    const prev = st.tasks["RF-1"].priority.value;
    const before = h.ownerLines().length;
    const r = await h.postEvent(s, {
      type: "task.priority",
      task: "RF-1",
      priority: prev === "P1" ? "P2" : "P1",
      prev,
      expectedVersion: st.version,
    });
    expect(r.status).toBe(200); // the write really happened (not a 403 nobody looked at)
    const lines = h.ownerLines();
    expect(lines.length).toBe(before + 1); // exactly one MORE owner line, not the fixture's seed
    const last = lines[lines.length - 1];
    expect(last.type).toBe("task.priority");
    expect(last.ts).toMatch(CANON);
    const rows = h.world
      .remoteFile("derived/prs.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const r2 of rows) expect(r2.at).toMatch(CANON);
  });
  it("the ctl CLI (real clock) and main's clock emit canonical ts", async () => {
    const { makeWorld, baseState } = require("./helpers/temp-repo");
    const { runCli } = require("./helpers/spawn-cli");
    const world = makeWorld();
    try {
      world.seedBranch("ctl/state", baseState(2));
      const r = await runCli(world, ["note", "hello"]);
      expect(r.code).toBe(0);
      const lines = world.remoteLines("lane-u");
      expect(lines[lines.length - 1].ts).toMatch(CANON);
    } finally {
      world.cleanup();
    }
    const main = read(path.join(CONTROL, "src", "main.ts"));
    expect(main).toMatch(/new Date\(\)\.toISOString\(\)\.replace\(\/\\\.\\d\{3\}Z\$\/, "Z"\)/);
  });
});

describe("minors", () => {
  it("git children never see CONTROL_* variables", () => {
    const { gitTry } = require("../src/sources/git");
    process.env.CONTROL_SECRET_PROBE = "leak-me-please";
    try {
      const r = gitTry(os.tmpdir(), ["-c", "alias.e=!env", "e"]);
      expect(r.out + r.err).not.toContain("leak-me-please");
    } finally {
      delete process.env.CONTROL_SECRET_PROBE;
    }
  });
  it("README documents stateless logout and the global-limit lockout", () => {
    const t = read(path.join(CONTROL, "README.md"));
    expect(t).toMatch(/stateless/i);
    expect(t).toMatch(/global.*(limit|lockout)|lockout/i);
  });
});

void rawRequest;
