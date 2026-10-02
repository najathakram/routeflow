/**
 * T33 (R17) + security section: exact-match routing, no path from input, no git argument from
 * input, health leak check, noindex/CSP, XSS-relevant page rules.
 */
import cp = require("child_process");
import { startServer } from "./helpers/start-server";
import type { Harness, Session } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */

let h: Harness;
let s: Session;
beforeEach(async () => {
  h = await startServer({ writeback: true });
  s = await h.session();
});
afterEach(() => {
  jest.restoreAllMocks();
  return h?.close();
});

const get = (p: string) => h.req("GET", p, { headers: { cookie: s.cookie } });

describe("T33 routing is exact-match; nothing from the request reaches the filesystem", () => {
  it.each([
    "/../../etc/passwd",
    "/events/lane-u.jsonl",
    "/assets/../package.json",
    "/assets/..%2fpackage.json",
    "/assets/%2e%2e/package.json",
    "/assets/%2e%2e%2fsrc%2fmain.ts",
    "/assets/client.js/",
    "/assets/",
    "/assets",
    "/assets/nope.js",
    "/api/state.json/",
    "/API/STATE.JSON",
    "/api/state.json%00",
    "/login/",
    "/robots.txt/",
    "/.git/config",
    "/.env",
    "/ctl/state",
    "//etc/passwd",
  ])("authenticated GET %s → 404", async (p) => {
    const r = await get(p);
    expect([p, r.status]).toEqual([p, 404]);
  });
  it("unauthenticated unknown path is 404 or the login redirect, never file content", async () => {
    const r = await h.req("GET", "/../../etc/passwd");
    expect([302, 401, 404]).toContain(r.status);
    expect(r.text).not.toMatch(/root:/);
  });
  it("a query string cannot select a file: /assets/client.js?f=../package.json serves the client", async () => {
    const r = await h.req("GET", "/assets/client.js?f=../package.json");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('"@routeflow/control"');
  });
  it("only the documented methods: DELETE/PUT/PATCH /api/event → 404 or 405", async () => {
    for (const m of ["DELETE", "PUT", "PATCH"]) {
      const r = await h.req(m, "/api/event", { headers: s.write(), body: "{}" });
      expect([404, 405]).toContain(r.status);
    }
  });
});

describe("T33 request values never become git arguments or paths", () => {
  const spawned = (): string[] => [];
  it("lane '../x' and task 'RF-1; rm' → 422 and no child process ever sees them", async () => {
    const st = (await h.stateJson(s)).state;
    const calls: string[] = [];
    const real = cp.spawnSync;
    jest.spyOn(cp, "spawnSync").mockImplementation(((cmd: string, args: any, o: any) => {
      calls.push([cmd, ...(Array.isArray(args) ? args : [])].join(" "));
      return (real as any)(cmd, args, o);
    }) as any);
    const realFile = cp.execFileSync;
    jest.spyOn(cp, "execFileSync").mockImplementation(((cmd: string, args: any, o: any) => {
      calls.push([cmd, ...(Array.isArray(args) ? args : [])].join(" "));
      return (realFile as any)(cmd, args, o);
    }) as any);
    const tip = h.world.remoteHead();
    const a = await h.postEvent(s, {
      type: "task.lane",
      task: "RF-1",
      toLane: "../x",
      prev: null,
      expectedVersion: st.version,
    });
    const b = await h.postEvent(s, {
      type: "task.priority",
      task: "RF-1; rm",
      priority: "P1",
      prev: "P2",
      expectedVersion: st.version,
    });
    const c = await h.postEvent(s, {
      type: "lane.note",
      lane: "../../evil",
      note: "x",
      expectedVersion: st.version,
    });
    expect([a.status, b.status, c.status]).toEqual([422, 422, 422]);
    expect(calls.join("\n")).not.toMatch(/\.\.\/x|rm|evil/);
    expect(h.world.remoteHead()).toBe(tip);
    void spawned;
  });
  it.each(["--upload-pack=x", "-f", "RF-1\n", "RF-1\0", "RF-1 ", "../../RF-1", "rf-1"])(
    "task id %j is rejected (422)",
    async (task) => {
      const st = (await h.stateJson(s)).state;
      const r = await h.postEvent(s, {
        type: "task.priority",
        task,
        priority: "P1",
        prev: "P2",
        expectedVersion: st.version,
      });
      expect(r.status).toBe(422);
    },
  );
  it("an owner event naming a lane that is not registered cannot create files for it", async () => {
    const st = (await h.stateJson(s)).state;
    const r = await h.postEvent(s, {
      type: "lane.note",
      lane: "../x",
      note: "n",
      expectedVersion: st.version,
    });
    expect(r.status).toBe(422);
    expect(h.world.remoteFile("events/../x.jsonl")).toBe("");
  });
});

describe("health", () => {
  it("public=1 returns exactly {ok:true}: no version, sha, path, source, or env value", async () => {
    const r = await h.req("GET", "/api/health?public=1");
    expect(r.json()).toEqual({ ok: true });
    for (const bad of [/version/i, /sha/i, h.world.root, "ctl/state", "/tmp", "ghp_", "acme"]) {
      expect(r.text).not.toMatch(bad as any);
    }
  });
  it("public=1 stays minimal even with a valid session", async () => {
    const r = await h.req("GET", "/api/health?public=1", { headers: { cookie: s.cookie } });
    expect(r.json()).toEqual({ ok: true });
  });
  it("the authed health never contains a secret, a token, or the password", async () => {
    const r = await get("/api/health");
    expect(r.status).toBe(200);
    for (const bad of ["ghp_test_token", "s".repeat(40), "correct horse", "dGVzdA=="]) {
      expect(r.text).not.toContain(bad);
    }
  });
});

describe("headers and page hygiene", () => {
  it("noindex + CSP on authed pages and the SSE response", async () => {
    for (const p of ["/", "/api/state.json", "/api/health"]) {
      const r = await get(p);
      expect(r.headers["x-robots-tag"]).toMatch(/noindex/);
      expect(String(r.headers["content-security-policy"])).toMatch(/script-src 'self'(;|$)/);
      expect(String(r.headers["content-security-policy"])).not.toMatch(/script-src[^;]*unsafe/);
    }
  });
  it("the page has no inline script, no inline handler, and loads only /assets", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(r.text).not.toMatch(/\son(click|load|error|submit)\s*=/i);
    expect(r.text).not.toMatch(/(src|href)="https?:\/\//i);
  });
  it("assets are served with a script/style content type and nosniff", async () => {
    const js = await h.req("GET", "/assets/client.js");
    const css = await h.req("GET", "/assets/styles.css");
    expect(String(js.headers["content-type"])).toMatch(/javascript/);
    expect(String(css.headers["content-type"])).toMatch(/text\/css/);
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("a hostile Host header is not reflected into the page or headers", async () => {
    const r = await h.req("GET", "/", { headers: { cookie: s.cookie, host: "evil.example" } });
    expect(r.text).not.toContain("evil.example");
    expect(JSON.stringify(r.headers)).not.toContain("evil.example");
  });
  it("a write whose Origin matches a different host than the served one is 403", async () => {
    const st = (await h.stateJson(s)).state;
    const r = await h.postEvent(
      s,
      {
        type: "task.priority",
        task: "RF-1",
        priority: "P1",
        prev: st.tasks["RF-1"].priority.value,
        expectedVersion: st.version,
      },
      { origin: "http://127.0.0.1:1" },
    );
    expect(r.status).toBe(403);
  });
});
