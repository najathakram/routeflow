/**
 * T28 (R15): boot, bind, health, graceful shutdown, config. Modules are required lazily so a
 * missing module fails each test on its own assertion (RED), not as a suite import error.
 */
import * as os from "os";
import * as net from "net";
import { startServer, openSse } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = (): any => require("../src/config");

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("T28 config: loadConfig", () => {
  const FULL = {
    CONTROL_PASSWORD: "pw-pw-pw-pw",
    CONTROL_SESSION_SECRET: "x".repeat(40),
    CONTROL_GITHUB_TOKEN: "ghp_x",
    CONTROL_STATE_REPO: "acme/acme-control-state",
    CONTROL_REPO: "acme/acme",
    CONTROL_PORT: "8080",
  };
  it("local mode needs none of the secrets, binds 127.0.0.1:4317 by default", () => {
    const c = cfg().loadConfig({ CONTROL_LOCAL: "1" });
    expect(c.local).toBe(true);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(4317);
  });
  it("non-local binds 0.0.0.0 on CONTROL_PORT", () => {
    const c = cfg().loadConfig(FULL);
    expect(c.local).toBe(false);
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(8080);
  });
  it.each([
    "CONTROL_PASSWORD",
    "CONTROL_SESSION_SECRET",
    "CONTROL_GITHUB_TOKEN",
    "CONTROL_STATE_REPO",
    "CONTROL_REPO",
  ])(
    "non-local without %s throws an error that names the variable (never a default password)",
    (name) => {
      const env: Record<string, string> = { ...FULL };
      delete env[name];
      expect(() => cfg().loadConfig(env)).toThrow(new RegExp(name));
    },
  );
  it("a session secret shorter than 32 bytes is refused", () => {
    expect(() => cfg().loadConfig({ ...FULL, CONTROL_SESSION_SECRET: "short" })).toThrow(
      /CONTROL_SESSION_SECRET/,
    );
  });
  it("the thrown message never echoes a secret value", () => {
    const env = { ...FULL, CONTROL_SESSION_SECRET: "tiny-secret-value" };
    const { loadConfig } = cfg();
    try {
      loadConfig(env);
    } catch (e: any) {
      expect(String(e.message)).not.toContain("tiny-secret-value");
      return;
    }
    throw new Error("loadConfig did not throw");
  });
  it("optional vars (webhook secret, railway token) are not required", () => {
    expect(() => cfg().loadConfig(FULL)).not.toThrow();
  });
});

describe("T28 server: local fixture mode", () => {
  it("serves /api/health?public=1 as {ok:true} and the authed health lists sources", async () => {
    h = await startServer({ local: true });
    const pub = await h.req("GET", "/api/health?public=1");
    expect(pub.status).toBe(200);
    expect(pub.json()).toEqual({ ok: true });
    const full = await h.req("GET", "/api/health");
    expect(full.status).toBe(200);
    const j = full.json();
    expect(j.sources).toBeDefined();
    expect(JSON.stringify(j)).toMatch(/github/i);
    expect(JSON.stringify(j)).toMatch(/rate/i);
    expect(typeof (j.version ?? j.state?.version)).toBe("string");
  });

  it("listens on loopback only: a connection via a LAN address is refused", async () => {
    h = await startServer({ local: true });
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no LAN interface in this sandbox: nothing to prove
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: lan.address, port: h!.port });
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it("close() with open SSE streams drains and resolves within 5 s (SIGTERM path)", async () => {
    h = await startServer({ local: true });
    const a = await openSse(h.port, {});
    const b = await openSse(h.port, {});
    expect(a.status).toBe(200);
    expect(h.app.sseCount()).toBe(2);
    const t0 = Date.now();
    await h.app.close();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(h.app.sseCount()).toBe(0);
    a.destroy();
    b.destroy();
  });

  it("after close() the port refuses new connections", async () => {
    h = await startServer({ local: true });
    const port = h.port;
    await h.app.close();
    const refused = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});
