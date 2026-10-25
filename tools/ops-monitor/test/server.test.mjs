import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFailureLimiter, hashPassword, signSession } from "../lib/auth.mjs";
import { createMonitorServer, resolveListenOptions } from "../server.mjs";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const NOW = "2026-10-19T12:00:00.000Z";

function harness() {
  let snap = { generatedAt: NOW, machine: "pc", items: [], marker: 1 };
  const subs = new Set();
  const server = createMonitorServer({
    getSnapshot: () => snap,
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    publicDir,
  });
  return {
    server,
    subs,
    set: (s) => {
      snap = s;
      for (const fn of [...subs]) fn(snap);
    },
  };
}

function listen(server) {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
}

function request(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("serves the static allow-list with content types", async () => {
  const h = harness();
  const port = await listen(h.server);
  try {
    const idx = await request(port, "/");
    assert.equal(idx.status, 200);
    assert.match(idx.headers["content-type"], /text\/html/);
    assert.match(idx.body, /RouteFlow ops/);
    const js = await request(port, "/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /javascript/);
    const css = await request(port, "/app.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /text\/css/);
  } finally {
    h.server.close();
    h.server.closeAllConnections?.();
  }
});

test("api endpoints", async () => {
  const h = harness();
  const port = await listen(h.server);
  try {
    const s = await request(port, "/api/snapshot");
    assert.equal(s.status, 200);
    assert.match(s.headers["content-type"], /application\/json/);
    assert.equal(s.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(s.body).marker, 1);
    const hl = await request(port, "/api/health");
    assert.deepEqual(JSON.parse(hl.body), { ok: true, generatedAt: NOW });
  } finally {
    h.server.close();
    h.server.closeAllConnections?.();
  }
});

test("non-GET is 405; unknown and traversal paths are 404", async () => {
  const h = harness();
  const port = await listen(h.server);
  try {
    assert.equal((await request(port, "/", "POST")).status, 405);
    assert.equal((await request(port, "/api/snapshot", "DELETE")).status, 405);
    assert.equal((await request(port, "/nope")).status, 404);
    assert.equal((await request(port, "/../package.json")).status, 404);
    assert.equal((await request(port, "/public/../server.mjs")).status, 404);
    assert.equal((await request(port, "/%2e%2e/server.mjs")).status, 404);
    assert.equal((await request(port, "/server.mjs")).status, 404);
  } finally {
    h.server.close();
    h.server.closeAllConnections?.();
  }
});

test("/sse sends the initial snapshot and another after subscribe fires", async () => {
  const h = harness();
  const port = await listen(h.server);
  let req;
  try {
    const events = [];
    let gotRes;
    await new Promise((resolve, reject) => {
      req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (r) => {
        gotRes = r;
        assert.match(r.headers["content-type"], /text\/event-stream/);
        r.setEncoding("utf8");
        let buf = "";
        r.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith("event: snapshot")) {
              const data = block.split("\n").find((l) => l.startsWith("data: "));
              events.push(JSON.parse(data.slice(6)));
              if (events.length === 1) setTimeout(() => h.set({ generatedAt: NOW, marker: 2 }), 10);
              if (events.length === 2) resolve();
            }
          }
        });
      });
      req.on("error", reject);
    });
    assert.equal(events[0].marker, 1);
    assert.equal(events[1].marker, 2);
    assert.ok(gotRes);
    req.destroy();
    for (let i = 0; i < 40 && h.subs.size; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(h.subs.size, 0, "subscription cleaned up on close");
  } finally {
    req?.destroy();
    h.server.close();
    h.server.closeAllConnections?.();
  }
});

test("resolveListenOptions defaults to loopback", () => {
  assert.deepEqual(resolveListenOptions([], {}), {
    host: "127.0.0.1",
    port: 4317,
    views: false,
    once: false,
    fixture: null,
    cloud: false,
  });
  assert.equal(resolveListenOptions(["--views"], {}).views, true, "--views turns the writer on");
  assert.equal(resolveListenOptions(["--views", "--no-views"], {}).views, false);
  const o = resolveListenOptions(["--lan", "--port", "5000", "--no-views", "--once"], {});
  assert.equal(o.host, "0.0.0.0");
  assert.equal(o.port, 5000);
  assert.equal(o.views, false);
  assert.equal(o.once, true);
  assert.equal(resolveListenOptions(["--port=4400"], {}).port, 4400);
  assert.equal(resolveListenOptions(["--fixture", "x.json"], {}).fixture, "x.json");
  assert.equal(resolveListenOptions(["--port", "abc"], {}).port, 4317);
});

// ---------- P6: login, security headers, webhooks, cloud ----------

const PASSWORD = "correct horse battery";
const SECRET = "ab".repeat(32);
const HASH = hashPassword(PASSWORD);
const CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'";
const WH_SECRET = "whsec-test";

function authHarness(opts = {}) {
  let snap = {
    generatedAt: NOW,
    machine: "cloud",
    marker: 1,
    sources: { specs: { ok: true }, github: { ok: false, error: "private detail" } },
  };
  const events = [];
  const server = createMonitorServer({
    getSnapshot: () => snap,
    subscribe: () => () => {},
    publicDir,
    auth: { passwordHash: HASH, sessionSecret: SECRET, ...(opts.auth ?? {}) },
    webhook: { secret: WH_SECRET, onEvent: (name, payload) => events.push([name, payload]) },
    cloud: opts.cloud ?? false,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { server, events };
}

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (r) => {
      let data = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (data += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const form = (fields) => new URLSearchParams(fields).toString();
const formHeaders = (body, extra = {}) => ({
  "content-type": "application/x-www-form-urlencoded",
  "content-length": String(Buffer.byteLength(body)),
  ...extra,
});

async function withServer(h, fn) {
  const port = await listen(h.server);
  try {
    await fn(port);
  } finally {
    h.server.close();
    h.server.closeAllConnections?.();
  }
}

async function login(port, password = PASSWORD, extra = {}) {
  const body = form({ password });
  return call(port, "/login", { method: "POST", headers: formHeaders(body, extra), body });
}

const cookieOf = (r) => r.headers["set-cookie"][0].split(";")[0];

test("auth: no session -> HTML routes 302 /login, API and SSE 401, open routes stay open", async () => {
  await withServer(authHarness(), async (port) => {
    for (const p of ["/", "/nope"]) {
      const r = await call(port, p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.location, "/login");
    }
    for (const p of ["/api/snapshot", "/sse", "/app.js"]) {
      assert.equal((await call(port, p)).status, 401, p);
    }
    const lg = await call(port, "/login");
    assert.equal(lg.status, 200);
    assert.match(lg.headers["content-type"], /text\/html/);
    assert.match(lg.body, /<form[^>]*method="post"[^>]*action="\/login"/i);
    assert.match(lg.body, /name="password"/);
    assert.doesNotMatch(lg.body, /login-error/);
    assert.equal((await call(port, "/app.css")).status, 200);
    const robots = await call(port, "/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.body, /Disallow: \//);
    const hl = await call(port, "/api/health");
    assert.equal(hl.status, 200);
    const health = JSON.parse(hl.body);
    assert.deepEqual(health, {
      ok: true,
      generatedAt: NOW,
      sources: { specs: true, github: false },
    });
    assert.ok(!hl.body.includes("private detail"));
  });
});

test("login: wrong password -> 303 /login?e=1 and no cookie; right -> cookie + 303 /", async () => {
  await withServer(authHarness(), async (port) => {
    const bad = await login(port, "nope-nope");
    assert.equal(bad.status, 303);
    assert.equal(bad.headers.location, "/login?e=1");
    assert.equal(bad.headers["set-cookie"], undefined);
    const page = await call(port, "/login?e=1");
    assert.match(page.body, /login-error/);
    assert.match(page.body, /Incorrect password/);
    assert.doesNotMatch(page.body, /nope-nope/);

    const ok = await login(port);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, "/");
    const sc = ok.headers["set-cookie"][0];
    assert.match(sc, /^ops_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    assert.doesNotMatch(sc, /Secure/);
    const ck = { cookie: cookieOf(ok) };
    assert.equal((await call(port, "/api/snapshot", { headers: ck })).status, 200);
    assert.equal(JSON.parse((await call(port, "/api/snapshot", { headers: ck })).body).marker, 1);
    assert.equal((await call(port, "/", { headers: ck })).status, 200);
    assert.equal((await call(port, "/app.js", { headers: ck })).status, 200);
    const again = await call(port, "/login", { headers: ck });
    assert.equal(again.status, 302);
    assert.equal(again.headers.location, "/");
  });
});

test("login: a forged or expired cookie is rejected; /sse needs a valid session", async () => {
  await withServer(authHarness(), async (port) => {
    const forged = {
      cookie: `ops_session=${signSession({ exp: Date.now() + 9e6 }, "ff".repeat(32))}`,
    };
    assert.equal((await call(port, "/api/snapshot", { headers: forged })).status, 401);
    const expired = { cookie: `ops_session=${signSession({ exp: Date.now() - 1 }, SECRET)}` };
    assert.equal((await call(port, "/api/snapshot", { headers: expired })).status, 401);
    assert.equal((await call(port, "/sse", { headers: forged })).status, 401);

    const ok = await login(port);
    const req = await new Promise((resolve, reject) => {
      const r = http.get(
        { host: "127.0.0.1", port, path: "/sse", headers: { cookie: cookieOf(ok) } },
        (res) => resolve({ r, res }),
      );
      r.on("error", reject);
    });
    assert.equal(req.res.statusCode, 200);
    assert.match(req.res.headers["content-type"], /text\/event-stream/);
    assert.equal(req.res.headers["content-security-policy"], CSP);
    req.r.destroy();
  });
});

test("login: 11th attempt is blocked (even with the right password), then the window resets", async () => {
  let t = Date.parse("2026-10-19T12:00:00Z");
  const h = authHarness({ auth: { now: () => t } });
  await withServer(h, async (port) => {
    for (let i = 0; i < 10; i++)
      assert.equal((await login(port, "wrong-pass")).headers.location, "/login?e=1");
    const blocked = await login(port);
    assert.equal(blocked.status, 303);
    assert.equal(blocked.headers.location, "/login?e=2");
    assert.equal(blocked.headers["set-cookie"], undefined);
    assert.match((await call(port, "/login?e=2")).body, /Too many attempts/);
    t += 900001;
    const ok = await login(port);
    assert.equal(ok.headers.location, "/");
  });
});

test("login (cloud): attempts are keyed by the LAST x-forwarded-for hop, not a spoofed first one", async () => {
  await withServer(authHarness({ cloud: true }), async (port) => {
    // The attacker rotates the client-supplied first hop; the proxy-appended last hop is fixed.
    for (let i = 0; i < 10; i++)
      await login(port, "wrong-pass", { "x-forwarded-for": `1.1.1.${i}, 9.9.9.9` });
    const blocked = await login(port, PASSWORD, { "x-forwarded-for": "2.2.2.2, 9.9.9.9" });
    assert.equal(blocked.headers.location, "/login?e=2");
    const other = await login(port, PASSWORD, { "x-forwarded-for": "9.9.9.9, 8.8.8.8" });
    assert.equal(other.headers.location, "/");
  });
});

test("login (cloud): x-real-ip wins over x-forwarded-for", async () => {
  await withServer(authHarness({ cloud: true }), async (port) => {
    const hdr = (n) => ({ "x-real-ip": "7.7.7.7", "x-forwarded-for": `3.3.3.${n}, 4.4.4.${n}` });
    for (let i = 0; i < 10; i++) await login(port, "wrong-pass", hdr(i));
    assert.equal((await login(port, PASSWORD, hdr(99))).headers.location, "/login?e=2");
  });
});

test("login (local): forwarded headers are ignored, the socket address keys the limiter", async () => {
  await withServer(authHarness(), async (port) => {
    for (let i = 0; i < 10; i++)
      await login(port, "wrong-pass", {
        "x-forwarded-for": `1.1.1.${i}`,
        "x-real-ip": `5.5.5.${i}`,
      });
    const blocked = await login(port, PASSWORD, { "x-forwarded-for": "8.8.8.8" });
    assert.equal(blocked.headers.location, "/login?e=2");
  });
});

test("login: a success resets that client's failures", async () => {
  await withServer(authHarness(), async (port) => {
    for (let i = 0; i < 9; i++) await login(port, "wrong-pass");
    assert.equal((await login(port)).headers.location, "/");
    for (let i = 0; i < 9; i++)
      assert.equal((await login(port, "wrong-pass")).headers.location, "/login?e=1");
    assert.equal((await login(port)).headers.location, "/", "still under the cap after the reset");
  });
});

test("login: the global cap counts failures only", async () => {
  const globalLimiter = createFailureLimiter({ max: 3, windowMs: 900000 });
  await withServer(authHarness({ cloud: true, auth: { globalLimiter } }), async (port) => {
    // Many successes from different clients never count.
    for (let i = 0; i < 6; i++) {
      const r = await login(port, PASSWORD, { "x-real-ip": `10.0.0.${i}` });
      assert.equal(r.headers.location, "/", `success ${i}`);
    }
    for (let i = 0; i < 3; i++) await login(port, "wrong-pass", { "x-real-ip": `10.0.1.${i}` });
    const blocked = await login(port, PASSWORD, { "x-real-ip": "10.0.2.1" });
    assert.equal(blocked.headers.location, "/login?e=2");
  });
});

test("/api/snapshot carries authEnabled (true with a login, false without)", async () => {
  await withServer(authHarness(), async (port) => {
    const ok = await login(port);
    const r = await call(port, "/api/snapshot", { headers: { cookie: cookieOf(ok) } });
    assert.equal(JSON.parse(r.body).authEnabled, true);
  });
  const h = harness();
  const port = await listen(h.server);
  try {
    const s = await request(port, "/api/snapshot");
    assert.equal(JSON.parse(s.body).authEnabled, false);
  } finally {
    h.server.close();
    h.server.closeAllConnections?.();
  }
});

test("run-all.mjs exits non-zero when a test fails, zero when they pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-runall-"));
  const runner = join(dirname(fileURLToPath(import.meta.url)), "run-all.mjs");
  const run = () =>
    spawnSync(process.execPath, [runner], {
      // A parent `node --test` run sets NODE_TEST_CONTEXT, which would make the child exit 0.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, OPS_TEST_DIR: dir },
      encoding: "utf8",
    });
  writeFileSync(
    join(dir, "good.test.mjs"),
    'import { test } from "node:test"; test("ok", () => {});\n',
  );
  assert.equal(run().status, 0);
  writeFileSync(
    join(dir, "bad.test.mjs"),
    'import { test } from "node:test"; import assert from "node:assert"; test("no", () => assert.equal(1, 2));\n',
  );
  assert.notEqual(run().status, 0);
});

test("login: body over 4 KB is refused; cross-origin POST is refused", async () => {
  await withServer(authHarness(), async (port) => {
    const big = form({ password: "x".repeat(5000) });
    const r = await call(port, "/login", { method: "POST", headers: formHeaders(big), body: big });
    assert.equal(r.status, 413);
    const body = form({ password: PASSWORD });
    const x = await call(port, "/login", {
      method: "POST",
      headers: formHeaders(body, { origin: "https://evil.example", host: "ops.example" }),
      body,
    });
    assert.equal(x.status, 403);
    assert.equal(x.headers["set-cookie"], undefined);
  });
});

test("logout clears the cookie", async () => {
  await withServer(authHarness(), async (port) => {
    const ok = await login(port);
    const out = await call(port, "/logout", { method: "POST", headers: { cookie: cookieOf(ok) } });
    assert.equal(out.status, 303);
    assert.equal(out.headers.location, "/login");
    assert.match(out.headers["set-cookie"][0], /^ops_session=;.*Max-Age=0/);
  });
});

test("cookie is Secure in cloud and behind x-forwarded-proto: https", async () => {
  await withServer(authHarness({ cloud: true }), async (port) => {
    const ok = await login(port, PASSWORD, { "x-forwarded-proto": "https" });
    assert.match(ok.headers["set-cookie"][0], /; Secure$/);
  });
  await withServer(authHarness(), async (port) => {
    const plain = await login(port);
    assert.doesNotMatch(plain.headers["set-cookie"][0], /Secure/);
    const behind = await login(port, PASSWORD, { "x-forwarded-proto": "https" });
    assert.match(behind.headers["set-cookie"][0], /; Secure$/);
  });
});

test("security headers on every response, including redirects, errors and the SSE stream", async () => {
  await withServer(authHarness(), async (port) => {
    const ok = await login(port);
    const ck = { cookie: cookieOf(ok) };
    const responses = [
      await call(port, "/"),
      await call(port, "/login"),
      await call(port, "/nope", { headers: ck }),
      await call(port, "/api/snapshot"),
      await call(port, "/api/snapshot", { headers: ck }),
      await call(port, "/api/health"),
      await call(port, "/app.css"),
      await call(port, "/robots.txt"),
      await call(port, "/", { method: "PUT" }),
      ok,
      await call(port, "/hooks/github", { method: "POST", body: "{}" }),
    ];
    for (const r of responses) {
      assert.equal(r.headers["x-content-type-options"], "nosniff", String(r.status));
      assert.equal(r.headers["referrer-policy"], "same-origin");
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal(r.headers["content-security-policy"], CSP);
      assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
    }
    for (const p of ["/", "/api/snapshot"]) {
      assert.equal((await call(port, p, { headers: ck })).headers["cache-control"], "no-store");
    }
  });
});

test("the shipped pages work under the CSP: no inline script, style or handlers", () => {
  for (const f of ["index.html", "login.html"]) {
    const html = readFileSync(join(publicDir, f), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${f}: <style>`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${f}: style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f}: inline handler`);
  }
  const login = readFileSync(join(publicDir, "login.html"), "utf8");
  assert.match(login, /<meta name="robots" content="noindex,nofollow"/);
  assert.match(login, /href="\/app\.css"/);
  assert.doesNotMatch(login, /\/app\.js/);
});

test("no auth configured: everything stays open (local default) and /login goes home", async () => {
  const h = harness();
  await withServer(h, async (port) => {
    assert.equal((await call(port, "/api/snapshot")).status, 200);
    assert.equal((await call(port, "/login")).status, 302);
    assert.equal((await call(port, "/login", { method: "POST" })).status, 405);
  });
});

test("webhook: 401 on bad or missing signature, 400 on bad JSON, 202 and the event is delivered", async () => {
  const h = authHarness();
  await withServer(h, async (port) => {
    const payload = JSON.stringify({ repository: { name: "routeflow" }, ref: "refs/heads/master" });
    const sign = (b, s = WH_SECRET) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;
    const hdr = (b, sig, ev = "push") => ({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(b)),
      "x-github-event": ev,
      ...(sig ? { "x-hub-signature-256": sig } : {}),
    });
    const post = (b, sig, ev) =>
      call(port, "/hooks/github", { method: "POST", headers: hdr(b, sig, ev), body: b });

    assert.equal((await post(payload, undefined)).status, 401);
    assert.equal((await post(payload, sign(payload, "other"))).status, 401);
    assert.equal((await post(payload, "sha256=zz")).status, 401);
    assert.deepEqual(h.events, []);
    assert.equal((await post("{not json", sign("{not json"))).status, 400);
    assert.deepEqual(h.events, []);
    const ok = await post(payload, sign(payload));
    assert.equal(ok.status, 202);
    assert.deepEqual(h.events, [["push", JSON.parse(payload)]]);
    assert.equal((await post("{}", sign("{}"), "ping")).status, 202);
    assert.equal(
      (await call(port, "/hooks/github")).status,
      302,
      "GET without a session is not served",
    );
  });
});

test("webhook: body over 1 MB is refused before verification", async () => {
  const h = authHarness();
  await withServer(h, async (port) => {
    const big = JSON.stringify({ pad: "x".repeat(1_100_000) });
    const r = await call(port, "/hooks/github", {
      method: "POST",
      headers: { "content-length": String(Buffer.byteLength(big)), "x-github-event": "push" },
      body: big,
    });
    assert.equal(r.status, 413);
    assert.deepEqual(h.events, []);
  });
});

test("cloud: plain http is redirected to https (health exempt); https gets HSTS", async () => {
  await withServer(authHarness({ cloud: true }), async (port) => {
    const r = await call(port, "/api/snapshot?x=1", {
      headers: { "x-forwarded-proto": "http", host: "ops.example" },
    });
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, "https://ops.example/api/snapshot?x=1");
    const bad = await call(port, "/", {
      headers: { "x-forwarded-proto": "http", host: "evil.example/x y" },
    });
    assert.equal(bad.status, 400);
    const hl = await call(port, "/api/health", { headers: { "x-forwarded-proto": "http" } });
    assert.equal(hl.status, 200);
    const sec = await call(port, "/login", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(sec.status, 200);
    assert.equal(sec.headers["strict-transport-security"], "max-age=31536000");
    const post = await call(port, "/login", {
      method: "POST",
      headers: { "x-forwarded-proto": "http", host: "ops.example" },
    });
    assert.equal(post.status, 301);
  });
  await withServer(authHarness(), async (port) => {
    const r = await call(port, "/login", { headers: { "x-forwarded-proto": "http" } });
    assert.equal(r.status, 200, "not cloud: no redirect");
    assert.equal(r.headers["strict-transport-security"], undefined);
  });
});

test("resolveListenOptions: --cloud binds 0.0.0.0:$PORT and hard-disables the views writer", () => {
  const o = resolveListenOptions(["--cloud"], { PORT: "8080" });
  assert.equal(o.cloud, true);
  assert.equal(o.host, "0.0.0.0");
  assert.equal(o.port, 8080);
  assert.equal(o.views, false);
  const e = resolveListenOptions([], { RF_CLOUD: "1", PORT: "9000" });
  assert.equal(e.cloud, true);
  assert.equal(e.port, 9000);
  assert.equal(resolveListenOptions(["--cloud", "--views"], { PORT: "1" }).views, false);
  assert.equal(resolveListenOptions(["--cloud", "--port", "5555"], { PORT: "1" }).port, 5555);
  assert.equal(resolveListenOptions(["--cloud"], { PORT: "junk" }).port, 4317);
  assert.equal(resolveListenOptions([], { PORT: "9000" }).port, 4317, "PORT only matters in cloud");
});

function runServer(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(publicDir, "..", "server.mjs"), ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test("cloud boot refuses to start with an empty client-name list (exit 1), names never printed", async () => {
  const home = mkdtempSync(join(tmpdir(), "rf-srv-cn-"));
  const base = { RF_OPS_HOME: home, OPS_PASSWORD_HASH: HASH, OPS_SESSION_SECRET: SECRET };
  const a = await runServer(["--cloud", "--port", "0"], { ...base, GITHUB_TOKEN: "x" });
  assert.equal(a.code, 1);
  assert.match(a.out, /CLIENT_NAMES_JSON/);
  assert.doesNotMatch(a.out, /listening/);
  const b = await runServer(["--cloud", "--port", "0"], {
    ...base,
    GITHUB_TOKEN: "x",
    CLIENT_NAMES_JSON: "[]",
  });
  assert.equal(b.code, 1);
  assert.match(b.out, /CLIENT_NAMES_JSON/);
  // with a list it gets past this check (and stops later, at the GitHub clone)
  const c = await runServer(["--cloud", "--port", "0"], {
    ...base,
    CLIENT_NAMES_JSON: '["acme-secret-name"]',
  });
  assert.equal(c.code, 1);
  assert.doesNotMatch(c.out, /CLIENT_NAMES_JSON/);
  assert.doesNotMatch(c.out, /acme-secret-name/);
});

test("cloud boot refuses to start without OPS_PASSWORD_HASH or OPS_SESSION_SECRET (exit 1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "rf-srv-"));
  const a = await runServer(["--cloud", "--port", "0"], { RF_OPS_HOME: home, GITHUB_TOKEN: "x" });
  assert.equal(a.code, 1);
  assert.match(a.out, /OPS_PASSWORD_HASH/);
  assert.match(a.out, /OPS_SESSION_SECRET/);
  const b = await runServer(["--port", "0"], {
    RF_CLOUD: "1",
    RF_OPS_HOME: home,
    OPS_PASSWORD_HASH: HASH,
  });
  assert.equal(b.code, 1);
  assert.match(b.out, /OPS_SESSION_SECRET/);
  assert.doesNotMatch(b.out, new RegExp(HASH.slice(8, 30).replace(/[+/]/g, ".")));
  const c = await runServer(["--cloud", "--port", "0"], {
    RF_OPS_HOME: home,
    OPS_PASSWORD_HASH: HASH,
    OPS_SESSION_SECRET: SECRET,
    CLIENT_NAMES_JSON: '["acme"]',
  });
  assert.equal(c.code, 1);
  assert.match(c.out, /GITHUB_TOKEN/);
  assert.doesNotMatch(c.out, /RouteFlow ops monitor: http/);
  // a local run that sets a hash but no secret is refused too
  const d = await runServer(["--port", "0", "--once"], {
    RF_OPS_HOME: home,
    OPS_PASSWORD_HASH: HASH,
  });
  assert.equal(d.code, 1);
  assert.match(d.out, /OPS_SESSION_SECRET/);
  // a short secret is refused, and its value is never printed
  const e = await runServer(["--port", "0", "--once"], {
    RF_OPS_HOME: home,
    OPS_PASSWORD_HASH: HASH,
    OPS_SESSION_SECRET: "tooshort-secret-xyz",
  });
  assert.equal(e.code, 1);
  assert.match(e.out, /OPS_SESSION_SECRET/);
  assert.doesNotMatch(e.out, /tooshort-secret-xyz/);
});

// ---------- PWA: manifest, generated icons, sliding session ----------

test("pwa: manifest and icons are open without a session, with right types and a real PNG", async () => {
  await withServer(authHarness(), async (port) => {
    const m = await call(port, "/manifest.webmanifest");
    assert.equal(m.status, 200);
    assert.match(m.headers["content-type"], /application\/manifest\+json/);
    assert.equal(JSON.parse(m.body).short_name, "RF ops");
    for (const p of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]) {
      const r = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: p }, (x) => {
            const chunks = [];
            x.on("data", (c) => chunks.push(c));
            x.on("end", () =>
              resolve({ status: x.statusCode, headers: x.headers, buf: Buffer.concat(chunks) }),
            );
          })
          .on("error", reject);
      });
      assert.equal(r.status, 200, p);
      assert.equal(r.headers["content-type"], "image/png");
      assert.equal(r.headers["content-security-policy"], CSP);
      assert.equal(r.buf.subarray(1, 4).toString("latin1"), "PNG");
      assert.equal(r.buf.subarray(r.buf.length - 8, r.buf.length - 4).toString("latin1"), "IEND");
    }
  });
});

test("session: cookie is 30 days and re-issued only once under 15 days remain", async () => {
  let t = Date.parse(NOW);
  await withServer(authHarness({ auth: { now: () => t } }), async (port) => {
    const r = await login(port);
    assert.match(r.headers["set-cookie"][0], /Max-Age=2592000/);
    const c = cookieOf(r);
    const early = await call(port, "/api/snapshot", { headers: { cookie: c } });
    assert.equal(early.status, 200);
    assert.equal(early.headers["set-cookie"], undefined, "fresh session is not re-issued");
    t += 20 * 86400_000; // 10 days left
    const late = await call(port, "/api/snapshot", { headers: { cookie: c } });
    assert.equal(late.status, 200);
    assert.match(late.headers["set-cookie"][0], /Max-Age=2592000/);
    assert.notEqual(cookieOf(late), c);
    const again = await call(port, "/api/snapshot", { headers: { cookie: cookieOf(late) } });
    assert.equal(again.status, 200);
  });
});

test("login outcomes are logged (ok | wrong | rate-limited | bad-request) without any secret", async () => {
  const lines = [];
  const h = authHarness({ log: (m) => lines.push(m) });
  await withServer(h, async (port) => {
    await login(port, "nope-nope-secret-typo");
    await login(port);
    await login(port, PASSWORD, { origin: "https://evil.example" });
    for (let i = 0; i < 10; i++) await login(port, "wrong-again-" + i);
    await login(port);
  });
  const outcomes = lines.map((l) => /login (ok|wrong|rate-limited|bad-request)/.exec(l)?.[1]);
  assert.equal(outcomes[0], "wrong");
  assert.equal(outcomes[1], "ok");
  assert.equal(outcomes[2], "bad-request");
  assert.equal(outcomes[outcomes.length - 1], "rate-limited");
  assert.match(lines[0], /client [0-9a-f]{8}/);
  const dump = lines.join("\n");
  assert.ok(!dump.includes("nope-nope-secret-typo"));
  assert.ok(!dump.includes("wrong-again-"));
  assert.ok(!dump.includes(PASSWORD));
  assert.ok(!dump.includes(HASH));
  assert.ok(!/ops_session|127.0.0.1/.test(dump));
});

// ---------- login origin under Referrer-Policy: same-origin ----------

test("login: GET /login sends referrer-policy same-origin", async () => {
  const h = authHarness();
  await withServer(h, async (port) => {
    const r = await call(port, "/login");
    assert.equal(r.headers["referrer-policy"], "same-origin");
  });
});

test("login origin: null + sec-fetch-site same-origin signs in; other combinations are refused", async () => {
  const lines = [];
  const h = authHarness({ log: (m) => lines.push(m) });
  await withServer(h, async (port) => {
    const ok = await login(port, PASSWORD, { origin: "null", "sec-fetch-site": "same-origin" });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, "/");
    assert.ok(ok.headers["set-cookie"]);

    const cross = await login(port, PASSWORD, {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    assert.equal(cross.status, 403);
    assert.match(cross.headers["content-type"], /text\/html/);
    assert.match(cross.body, /somewhere the monitor doesn/);
    assert.match(cross.body, /<form/);

    const nullNoFetch = await login(port, PASSWORD, { origin: "null" });
    assert.equal(nullNoFetch.status, 403);

    const nullCross = await login(port, PASSWORD, {
      origin: "null",
      "sec-fetch-site": "cross-site",
    });
    assert.equal(nullCross.status, 403);

    const wrong = await login(port, "nope-nope", {
      origin: `http://127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
    });
    assert.equal(wrong.status, 303);
    assert.equal(wrong.headers.location, "/login?e=1");
  });
  assert.ok(lines.some((l) => /login bad-request origin-mismatch client [0-9a-f]{8}/.test(l)));
});

test("login: the no-Origin allowance relies on a SameSite=Lax session cookie", async () => {
  const h = authHarness();
  await withServer(h, async (port) => {
    const ok = await login(port);
    assert.equal(ok.status, 303); // no Origin and no Sec-Fetch-Site: allowed (non-browser client)
    assert.match(ok.headers["set-cookie"][0], /; SameSite=Lax;/);
    const cross = await login(port, PASSWORD, { "sec-fetch-site": "cross-site" });
    assert.equal(cross.status, 403);
  });
});

test("login: the no-Origin allowance relies on a SameSite=Lax session cookie", async () => {
  const h = authHarness();
  await withServer(h, async (port) => {
    const ok = await login(port);
    assert.equal(ok.status, 303); // no Origin and no Sec-Fetch-Site: allowed (non-browser client)
    assert.match(ok.headers["set-cookie"][0], /; SameSite=Lax;/);
    const cross = await login(port, PASSWORD, { "sec-fetch-site": "cross-site" });
    assert.equal(cross.status, 403);
  });
});
