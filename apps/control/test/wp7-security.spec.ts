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
  CONTROL_DEPLOY_KEY_B64: "dGVzdA==",
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
    const { CONTROL_PUBLIC_URL: _u, ...rest } = FULL;
    void _u;
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
  it("the deploy key setup pins GitHub host keys (no accept-new) and writes the key 0600", () => {
    const { setupDeployKey } = require("../src/http/deploykey");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-"));
    try {
      const cmd: string = setupDeployKey(Buffer.from("KEYDATA").toString("base64"), dir);
      expect(cmd).toContain("StrictHostKeyChecking=yes");
      expect(cmd).not.toContain("accept-new");
      expect(cmd).toContain("IdentitiesOnly=yes");
      const files = fs.readdirSync(dir);
      const key = files.find((f) => f.includes("key"));
      expect(fs.statSync(path.join(dir, key as string)).mode & 0o777).toBe(0o600);
      expect(read(path.join(dir, "known_hosts"))).toMatch(/^github\.com ssh-ed25519 AAAA/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("README documents stateless logout and the global-limit lockout", () => {
    const t = read(path.join(CONTROL, "README.md"));
    expect(t).toMatch(/stateless/i);
    expect(t).toMatch(/global.*(limit|lockout)|lockout/i);
  });
});

void rawRequest;
