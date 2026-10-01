/** WP7 fix round 2 (Opus security review): image denylist, limiter race, rebinding, ledger, webhook. */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { createHmac } from "crypto";
import { startServer, rawRequest, WEBHOOK_SECRET, FIXTURE } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";

jest.setTimeout(60_000);
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

const boot = (env: Record<string, string>) =>
  spawnSync("node", [path.join(CONTROL, "dist", "main.js")], {
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
  it("dist is built", () =>
    expect(fs.existsSync(path.join(CONTROL, "dist", "main.js"))).toBe(true));
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
      setTimeout(() => resolve(-1), 3000); // no body is ever sent: a read-first server would hang
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
      setTimeout(() => resolve(-1), 3000);
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
  it("200 concurrent fake-signature 1 MB uploads grow memory < 50 MB; a signed delivery still works", async () => {
    h = await startServer({ webhook: true });
    const MB = Buffer.alloc(1024 * 1024, 97);
    if (global.gc) global.gc();
    const mem = (): number => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const base = mem();
    let peak = base;
    const t = setInterval(() => (peak = Math.max(peak, mem())), 5);
    const port = h.port;
    const codes = await Promise.all(
      Array.from(
        { length: 200 },
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
                `POST /api/github-webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nx-hub-signature-256: sha256=${"0".repeat(64)}\r\nContent-Length: ${MB.length}\r\n\r\n`,
              );
              s.write(MB);
            });
          }),
      ),
    );
    clearInterval(t);
    expect(codes.every((c) => c === 401)).toBe(true);
    expect(peak - base).toBeLessThan(50 * 1024 * 1024);
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
    h = await startServer();
    await h.app.tick();
    const s = await h.session();
    const st = (await h.stateJson(s)).state;
    const prev = st.tasks["RF-1"].priority.value;
    await h.postEvent(s, {
      type: "task.priority",
      task: "RF-1",
      priority: prev === "P1" ? "P2" : "P1",
      prev,
      expectedVersion: st.version,
    });
    const last = h.ownerLines().pop();
    expect(last.ts).toMatch(CANON);
    const rows = h.world
      .remoteFile("derived/prs.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.at).toMatch(CANON);
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
