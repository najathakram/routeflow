/**
 * T38-T41 (R21): auth, cookie, CSRF primitives, headers, rate limit. Unit tests of the verbatim
 * auth.ts / csrf.ts / headers.ts / ratelimit.ts code, then the same rules over real HTTP.
 */
import { startServer, PASSWORD, SESSION_SECRET } from "./helpers/start-server";
import type { Harness } from "./helpers/start-server";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const auth = (): any => require("../src/http/auth");
const csrf = (): any => require("../src/http/csrf");
const headersMod = (): any => require("../src/http/headers");
const rl = (): any => require("../src/http/ratelimit");

const SECRET = "k".repeat(40);
const NOW_MS = Date.parse("2026-01-12T10:00:00Z");
const form = (pw: string) => ({
  "content-type": "application/x-www-form-urlencoded",
  body: `password=${encodeURIComponent(pw)}`,
});

describe("auth.ts primitives", () => {
  it("scrypt hash verifies the right password and rejects any other", () => {
    const h = auth().hashPassword("hunter2 hunter2");
    expect(h.salt.length).toBe(16);
    expect(h.hash.length).toBe(32);
    expect(auth().verifyPassword("hunter2 hunter2", h)).toBe(true);
    expect(auth().verifyPassword("hunter2 hunter3", h)).toBe(false);
    expect(auth().verifyPassword("", h)).toBe(false);
  });
  it("two hashes of one password get different salts", () => {
    const a = auth().hashPassword("pw");
    const b = auth().hashPassword("pw");
    expect(a.salt.equals(b.salt)).toBe(false);
  });
  it("a session expires exactly 12 h after issue and reads back before that", () => {
    const c = auth().signSession(SECRET, NOW_MS);
    const s = auth().readSession(SECRET, c, NOW_MS + 1000);
    expect(s.exp - s.iat).toBe(12 * 3600_000);
    expect(typeof s.nonce).toBe("string");
    expect(auth().readSession(SECRET, c, NOW_MS + 12 * 3600_000 - 1)).not.toBeNull();
    expect(auth().readSession(SECRET, c, NOW_MS + 12 * 3600_000 + 1)).toBeNull();
  });
  it("tampering one char of payload or signature, a wrong secret, or junk yields null", () => {
    const c: string = auth().signSession(SECRET, NOW_MS);
    const [p, sig] = c.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(auth().readSession(SECRET, `${flip(p)}.${sig}`, NOW_MS)).toBeNull();
    expect(auth().readSession(SECRET, `${p}.${flip(sig)}`, NOW_MS)).toBeNull();
    expect(auth().readSession("z".repeat(40), c, NOW_MS)).toBeNull();
    for (const j of [undefined, "", "abc", "a.b", ".", "a.b.c"]) {
      expect(auth().readSession(SECRET, j, NOW_MS)).toBeNull();
    }
  });
  it("COOKIE carries HttpOnly, SameSite=Strict, Path=/, Max-Age=43200 and Secure only when asked", () => {
    const sec: string = auth().COOKIE("v", true);
    expect(sec).toMatch(/^ctl_session=v;/);
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) {
      expect(sec).toContain(f);
    }
    expect(auth().COOKIE("v", false)).not.toContain("Secure");
  });
});

describe("csrf.ts primitives", () => {
  const session = { nonce: "n0nce" };
  const good = (over: Record<string, any> = {}) => ({
    headers: {
      origin: "https://ctl.example",
      "x-control-token": csrf().csrfFor(SECRET, "n0nce"),
      "content-type": "application/json",
      ...over,
    },
  });
  it("csrfFor is deterministic per (secret, nonce) and differs across both", () => {
    const a = csrf().csrfFor(SECRET, "n1");
    expect(csrf().csrfFor(SECRET, "n1")).toBe(a);
    expect(csrf().csrfFor(SECRET, "n2")).not.toBe(a);
    expect(csrf().csrfFor("j".repeat(40), "n1")).not.toBe(a);
  });
  it("checkWrite returns 0 / 401 / 403 / 403 / 415 in the documented order", () => {
    const o = "https://ctl.example";
    expect(csrf().checkWrite(good(), session, o, SECRET)).toBe(0);
    expect(csrf().checkWrite(good(), null, o, SECRET)).toBe(401);
    expect(csrf().checkWrite(good({ origin: "https://evil.example" }), session, o, SECRET)).toBe(
      403,
    );
    expect(csrf().checkWrite(good({ origin: undefined }), session, o, SECRET)).toBe(403);
    expect(csrf().checkWrite(good({ "x-control-token": "nope" }), session, o, SECRET)).toBe(403);
    expect(csrf().checkWrite(good({ "x-control-token": undefined }), session, o, SECRET)).toBe(403);
    expect(csrf().checkWrite(good({ "content-type": "text/plain" }), session, o, SECRET)).toBe(415);
    expect(
      csrf().checkWrite(
        good({ "content-type": "application/json; charset=utf-8" }),
        session,
        o,
        SECRET,
      ),
    ).toBe(0);
  });
});

describe("headers.ts", () => {
  it("is the exact spec §6 header set", () => {
    const h = headersMod().securityHeaders();
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v);
    expect(lower["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(lower["cache-control"]).toBe("no-store");
    expect(lower["content-security-policy"].replace(/\s+/g, " ")).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    );
    expect(lower["x-content-type-options"]).toBe("nosniff");
    expect(lower["referrer-policy"]).toBe("no-referrer");
    expect(lower["x-frame-options"]).toBe("DENY");
    expect(lower["strict-transport-security"]).toBeDefined();
  });
});

describe("ratelimit.ts", () => {
  const make = (now: () => number) => rl().createLimiter({ now });
  it("blocks an IP after 5 failures in 15 min, not before", () => {
    const t = { v: NOW_MS };
    const l = make(() => t.v);
    for (let i = 0; i < 5; i++) {
      expect(l.blocked("1.1.1.1")).toBe(false);
      l.fail("1.1.1.1");
    }
    expect(l.blocked("1.1.1.1")).toBe(true);
    expect(l.blocked("2.2.2.2")).toBe(false);
  });
  it("the window is 15 min: the block lifts after it", () => {
    const t = { v: NOW_MS };
    const l = make(() => t.v);
    for (let i = 0; i < 5; i++) l.fail("1.1.1.1");
    t.v += 15 * 60_000 - 1;
    expect(l.blocked("1.1.1.1")).toBe(true);
    t.v += 2;
    expect(l.blocked("1.1.1.1")).toBe(false);
  });
  it("30 failures across different IPs block everyone (global cap)", () => {
    const l = make(() => NOW_MS);
    for (let i = 0; i < 30; i++) l.fail(`10.0.0.${i}`);
    expect(l.blocked("9.9.9.9")).toBe(true);
  });
  it("29 global failures do not", () => {
    const l = make(() => NOW_MS);
    for (let i = 0; i < 29; i++) l.fail(`10.0.0.${i}`);
    expect(l.blocked("9.9.9.9")).toBe(false);
  });
});

describe("T38 unauthenticated access over HTTP", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer();
  });
  afterEach(() => h?.close());

  it("GET / → 302 /login", async () => {
    const r = await h.req("GET", "/");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/login");
  });
  it.each([
    ["GET", "/api/state.json"],
    ["GET", "/api/stream"],
    ["POST", "/api/event"],
    ["GET", "/api/health"],
    ["POST", "/logout"],
  ])("%s %s without a cookie is refused (401 or redirect to /login)", async (m, p) => {
    const r = await h.req(m, p, {
      headers: { "content-type": "application/json" },
      body: m === "POST" ? "{}" : undefined,
    });
    expect(r.status === 401 || (r.status === 302 && r.headers.location === "/login")).toBe(true);
  });
  it("public routes need no cookie: /login, /robots.txt, /api/health?public=1, /assets/*", async () => {
    for (const p of [
      "/login",
      "/robots.txt",
      "/api/health?public=1",
      "/assets/client.js",
      "/assets/styles.css",
    ]) {
      const r = await h.req("GET", p);
      expect([p, r.status]).toEqual([p, 200]);
    }
  });
  it("/robots.txt disallows everything and sets no cookie", async () => {
    const r = await h.req("GET", "/robots.txt");
    expect(r.text.trim()).toBe("User-agent: *\nDisallow: /");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
  it("every response carries the security headers (200, 302, 401, 404, assets)", async () => {
    const rs = await Promise.all([
      h.req("GET", "/robots.txt"),
      h.req("GET", "/"),
      h.req("GET", "/api/state.json"),
      h.req("GET", "/nope"),
      h.req("GET", "/assets/client.js"),
      h.req("GET", "/login"),
    ]);
    for (const r of rs) {
      expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(String(r.headers["content-security-policy"])).toContain("script-src 'self'");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
    }
  });
  it("the login page has no inline script and no inline event handlers", async () => {
    const r = await h.req("GET", "/login");
    expect(r.text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(r.text).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe("T39 login rate limit", () => {
  it("5 wrong passwords → 401 each, the 6th → 429, and the right one on the 7th → still 429", async () => {
    const h = await startServer();
    try {
      for (let i = 0; i < 5; i++) {
        const r = await h.req("POST", "/login", {
          headers: { origin: h.origin, ...form("wrong" + i) },
          body: form("wrong" + i).body,
        });
        expect(r.status).toBe(401);
        expect(r.headers["set-cookie"]).toBeUndefined();
      }
      const sixth = await h.req("POST", "/login", {
        headers: { origin: h.origin, ...form("wrong6") },
        body: form("wrong6").body,
      });
      expect(sixth.status).toBe(429);
      const right = await h.req("POST", "/login", {
        headers: { origin: h.origin, ...form(PASSWORD) },
        body: form(PASSWORD).body,
      });
      expect(right.status).toBe(429);
      expect(right.headers["set-cookie"]).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("with the default delay a 429 is answered ≥ 2 s after the request", async () => {
    const h = await startServer({ depsOver: { rateLimitDelayMs: undefined } });
    try {
      // fill the bucket (these 401s are not delayed)
      for (let i = 0; i < 5; i++) {
        await h.req("POST", "/login", {
          headers: { origin: h.origin, ...form("bad") },
          body: form("bad").body,
        });
      }
      const t0 = Date.now();
      const r = await h.req("POST", "/login", {
        headers: { origin: h.origin, ...form("bad") },
        body: form("bad").body,
      });
      expect(r.status).toBe(429);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);
    } finally {
      await h.close();
    }
  });

  it("no password (right or wrong) ever reaches stdout/stderr/console", async () => {
    const seen: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      jest
        .spyOn(console, k)
        .mockImplementation((...a: unknown[]) => void seen.push(a.map(String).join(" "))),
    );
    const so = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: any) => (seen.push(String(c)), true)) as any);
    const se = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(((c: any) => (seen.push(String(c)), true)) as any);
    const h = await startServer();
    try {
      await h.req("POST", "/login", {
        headers: { origin: h.origin, ...form("Tr0ub4dor-WRONG") },
        body: form("Tr0ub4dor-WRONG").body,
      });
      await h.req("POST", "/login", {
        headers: { origin: h.origin, ...form(PASSWORD) },
        body: form(PASSWORD).body,
      });
    } finally {
      await h.close();
      spies.forEach((s) => s.mockRestore());
      so.mockRestore();
      se.mockRestore();
    }
    const all = seen.join("\n");
    expect(all).not.toContain("Tr0ub4dor-WRONG");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(encodeURIComponent(PASSWORD));
  });
});

describe("T40 session cookie", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer();
  });
  afterEach(() => h?.close());

  const login = () =>
    h.req("POST", "/login", {
      headers: { origin: h.origin, ...form(PASSWORD) },
      body: form(PASSWORD).body,
    });

  it("a correct login sets ctl_session with HttpOnly; Secure; SameSite=Strict; Path=/", async () => {
    const r = await login();
    expect([302, 303]).toContain(r.status);
    const sc = ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith("ctl_session="));
    expect(sc).toBeDefined();
    for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"])
      expect(sc).toContain(f);
  });
  it("the payload says exp − iat == 12 h and the cookie opens the app", async () => {
    const r = await login();
    const cookie = ([] as string[]).concat(r.headers["set-cookie"] ?? [])[0].split(";")[0];
    const payload = JSON.parse(
      Buffer.from(cookie.slice("ctl_session=".length).split(".")[0], "base64url").toString(),
    );
    expect(payload.exp - payload.iat).toBe(12 * 3600_000);
    expect((await h.req("GET", "/api/state.json", { headers: { cookie } })).status).toBe(200);
  });
  it("tampering one char of the cookie → 401", async () => {
    const r = await login();
    const cookie = ([] as string[]).concat(r.headers["set-cookie"] ?? [])[0].split(";")[0];
    const last = cookie.slice(-1) === "A" ? "B" : "A";
    const bad = cookie.slice(0, -1) + last;
    expect((await h.req("GET", "/api/state.json", { headers: { cookie: bad } })).status).toBe(401);
  });
  it("a cookie signed with another secret → 401", async () => {
    const forged = auth().signSession("q".repeat(40), Date.now());
    expect(
      (await h.req("GET", "/api/state.json", { headers: { cookie: `ctl_session=${forged}` } }))
        .status,
    ).toBe(401);
  });
  it("an expired cookie → 401", async () => {
    const old = auth().signSession(SESSION_SECRET, Date.now() - 13 * 3600_000);
    expect(
      (await h.req("GET", "/api/state.json", { headers: { cookie: `ctl_session=${old}` } })).status,
    ).toBe(401);
  });
  it("POST /logout clears the cookie", async () => {
    const s = await h.session();
    const r = await h.req("POST", "/logout", { headers: { cookie: s.cookie, origin: h.origin } });
    const sc = ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith("ctl_session="));
    expect(sc).toBeDefined();
    expect(sc).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970|ctl_session=;/);
  });
});

describe("T41 CONTROL_LOCAL=1", () => {
  it("/ is 200 without a cookie, and API reads work without login", async () => {
    const h = await startServer({ local: true });
    try {
      expect((await h.req("GET", "/")).status).toBe(200);
      expect((await h.req("GET", "/api/state.json")).status).toBe(200);
      expect((await h.req("GET", "/api/health")).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
