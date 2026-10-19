#!/usr/bin/env node
// Ops monitor server: serves the single-page UI, the snapshot JSON and a Server-Sent-Events
// stream. Read-only (GET) except the login/logout forms and the signed GitHub webhook. With
// OPS_PASSWORD_HASH set (always in cloud) every route but /login, /api/health, /robots.txt,
// /app.css and /hooks/github needs a valid session. The collector, snapshot builder and views
// writer are imported dynamically inside main() so this module (and its tests) load without them.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_S,
  clearCookie,
  clientIp,
  createFailureLimiter,
  parseCookies,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from "./lib/auth.mjs";
import { verifyGithubSignature } from "./lib/webhooks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4317;
const VIEWS_DEBOUNCE_MS = 120_000;
const PING_MS = 15_000;
const LOGIN_BODY_MAX = 4 * 1024;
const WEBHOOK_BODY_MAX = 1024 * 1024;

// Fixed allow-list: URL path -> [file name inside publicDir, content type]. No path joins from
// the URL ever happen, so traversal is impossible by construction.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const LOGIN_FILE = "login.html";
const ERROR_MARKER = "<!--login-error-->";
const LOGIN_ERRORS = {
  1: "Incorrect password. Try again.",
  2: "Too many attempts. Try again in a few minutes.",
};
// Reachable without a session (GET).
const OPEN_GET = new Set(["/login", "/api/health", "/app.css", "/robots.txt"]);

export const CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'";

/**
 * @param {{ getSnapshot: () => object, subscribe: (fn: (snap: object) => void) => (() => void) | void,
 *           publicDir?: string,
 *           auth?: { passwordHash: string, sessionSecret: string, now?: () => number,
 *                    rateLimiter?: object, globalLimiter?: object } | null,
 *           webhook?: { secret: string, onEvent: (name: string, payload: object) => void } | null,
 *           cloud?: boolean }} deps
 * @returns {http.Server}
 */
export function createMonitorServer({
  getSnapshot,
  subscribe,
  publicDir = join(HERE, "public"),
  auth = null,
  webhook = null,
  cloud = false,
}) {
  const now = auth?.now ?? Date.now;
  // Failures only: 10 per client IP per 15 min, plus a coarse global cap of 300 in case the
  // client key is spoofed. A success resets that client's bucket.
  const limiter = auth?.rateLimiter ?? createFailureLimiter({ max: 10, windowMs: 900000 });
  const globalLimiter = auth?.globalLimiter ?? createFailureLimiter({ max: 300, windowMs: 900000 });

  const isHttps = (req) =>
    cloud ||
    String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim() === "https";
  const authed = (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return verifySession(token, auth.sessionSecret, now());
  };

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
    res.end(body);
  };
  const redirect = (res, status, location, extra = {}) => {
    res.writeHead(status, { location, "cache-control": "no-store", ...extra });
    res.end();
  };
  const text = (res, status, msg, extra) =>
    send(res, status, "text/plain; charset=utf-8", msg, extra);

  // Reads a request body up to `limit` bytes. Past the limit it keeps draining (so the client can
  // read our 413) without storing, and gives up on the connection beyond 16x the limit.
  const readBody = (req, limit) =>
    new Promise((resolveBody) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          tooLarge = true;
          chunks.length = 0;
          if (size > limit * 16) req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolveBody({ tooLarge, body: Buffer.concat(chunks) }));
      req.on("error", () => resolveBody({ tooLarge: true, body: Buffer.alloc(0) }));
      req.on("close", () => resolveBody({ tooLarge: true, body: Buffer.alloc(0) }));
    });

  // Cross-site form posts: if the browser sent an Origin it must be this host.
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  async function handleLogin(req, res) {
    if (!sameOrigin(req)) return text(res, 403, "forbidden");
    const { tooLarge, body } = await readBody(req, LOGIN_BODY_MAX);
    if (tooLarge) return text(res, 413, "request too large", { connection: "close" });
    const t = now();
    const ip = clientIp(req, { cloud });
    // A blocked client never reaches scrypt; only failures are counted.
    if (limiter.blocked(ip, t) || globalLimiter.blocked("*", t)) {
      return redirect(res, 303, "/login?e=2");
    }
    const password = new URLSearchParams(body.toString("utf8")).get("password") ?? "";
    if (!verifyPassword(password, auth.passwordHash)) {
      limiter.fail(ip, t);
      globalLimiter.fail("*", t);
      return redirect(res, 303, "/login?e=1");
    }
    limiter.reset(ip);
    const token = signSession({ exp: t + SESSION_MAX_AGE_S * 1000 }, auth.sessionSecret);
    return redirect(res, 303, "/", {
      "set-cookie": sessionCookie(token, { secure: isHttps(req) }),
    });
  }

  async function handleWebhook(req, res) {
    const { tooLarge, body } = await readBody(req, WEBHOOK_BODY_MAX);
    if (tooLarge) return text(res, 413, "payload too large", { connection: "close" });
    if (!verifyGithubSignature(body, req.headers["x-hub-signature-256"], webhook.secret)) {
      return text(res, 401, "bad signature");
    }
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return text(res, 400, "bad json");
    }
    send(res, 202, "application/json; charset=utf-8", '{"ok":true}');
    try {
      webhook.onEvent(String(req.headers["x-github-event"] ?? ""), payload);
    } catch {
      /* the response is already sent; the polls are the backstop */
    }
    return undefined;
  }

  async function loginPage(res, query) {
    const e = new URLSearchParams(query).get("e");
    let html = await readFile(join(publicDir, LOGIN_FILE), "utf8");
    const msg = Object.hasOwn(LOGIN_ERRORS, e) ? LOGIN_ERRORS[e] : null;
    html = html.replace(ERROR_MARKER, msg ? `<p class="login-error" role="alert">${msg}</p>` : "");
    return send(res, 200, "text/html; charset=utf-8", html);
  }

  return http.createServer(async (req, res) => {
    try {
      // Headers on every response; writeHead later merges its own on top.
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", CSP);
      res.setHeader("x-robots-tag", "noindex, nofollow");
      if (isHttps(req)) res.setHeader("strict-transport-security", "max-age=31536000");

      const url = req.url ?? "/";
      const q = url.indexOf("?");
      const path = q < 0 ? url : url.slice(0, q);
      const query = q < 0 ? "" : url.slice(q + 1);

      // HTTPS only online. The platform healthcheck is exempt.
      if (
        cloud &&
        String(req.headers["x-forwarded-proto"] ?? "")
          .split(",")[0]
          .trim() === "http" &&
        path !== "/api/health"
      ) {
        const host = String(req.headers.host ?? "");
        if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) || !url.startsWith("/")) {
          return text(res, 400, "bad request");
        }
        return redirect(res, 301, `https://${host}${url}`);
      }

      if (req.method === "POST") {
        if (path === "/hooks/github" && webhook) return await handleWebhook(req, res);
        if (path === "/login" && auth) return await handleLogin(req, res);
        if (path === "/logout" && auth) {
          if (!sameOrigin(req)) return text(res, 403, "forbidden");
          req.resume();
          return redirect(res, 303, "/login", {
            "set-cookie": clearCookie({ secure: isHttps(req) }),
          });
        }
      }
      if (req.method !== "GET") {
        return text(res, 405, "method not allowed", { allow: "GET" });
      }

      if (path === "/robots.txt") return text(res, 200, "User-agent: *\nDisallow: /\n");

      if (auth && !OPEN_GET.has(path) && !authed(req)) {
        if (path.startsWith("/api/") || path === "/sse" || path === "/app.js") {
          return text(res, 401, "login required");
        }
        return redirect(res, 302, "/login");
      }

      if (path === "/login") {
        if (!auth || authed(req)) return redirect(res, 302, "/");
        return await loginPage(res, query);
      }
      if (Object.hasOwn(STATIC, path)) {
        const [file, type] = STATIC[path];
        const body = await readFile(join(publicDir, file));
        return send(res, 200, type, body);
      }
      if (path === "/api/snapshot") {
        // authEnabled lets the page hide "Log out" when there is no login (local, no hash).
        return send(
          res,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({ ...getSnapshot(), authEnabled: Boolean(auth) }),
        );
      }
      if (path === "/api/health") {
        // Public: liveness and per-source ok flags only, never errors or data.
        const snap = getSnapshot();
        const out = { ok: true, generatedAt: snap?.generatedAt ?? null };
        if (snap?.sources && typeof snap.sources === "object") {
          out.sources = Object.fromEntries(
            Object.entries(snap.sources).map(([k, v]) => [k, Boolean(v?.ok)]),
          );
        }
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify(out));
      }
      if (path === "/sse") return handleSse(req, res, { getSnapshot, subscribe });
      return text(res, 404, "not found");
    } catch {
      if (!res.headersSent) text(res, 500, "server error");
      else res.end();
    }
  });
}

function handleSse(req, res, { getSnapshot, subscribe }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (snap) => res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
  write(getSnapshot());
  const unsub = subscribe?.((snap) => write(snap ?? getSnapshot()));
  const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
  ping.unref?.();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    if (typeof unsub === "function") unsub();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

/**
 * Parses argv (without node + script) into listen options. Loopback unless --lan. The views
 * writer is OFF unless `--views` (exactly one machine, the PC monitor, runs it). `--cloud` (or
 * RF_CLOUD=1) binds 0.0.0.0:$PORT and hard-disables the views writer: the cloud never writes git.
 */
export function resolveListenOptions(argv = [], env = process.env) {
  const opts = {
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    views: false,
    once: false,
    fixture: null,
    cloud: env.RF_CLOUD === "1" || env.RF_CLOUD === "true",
  };
  let explicitPort = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => {
      if (a === name) return argv[++i];
      return a.slice(name.length + 1);
    };
    if (a === "--lan") opts.host = "0.0.0.0";
    else if (a === "--cloud") opts.cloud = true;
    else if (a === "--views") opts.views = true;
    else if (a === "--no-views") opts.views = false;
    else if (a === "--once") opts.once = true;
    else if (a === "--port" || a.startsWith("--port=")) {
      const n = validPort(val("--port"));
      if (n !== null) {
        opts.port = n;
        explicitPort = true;
      }
    } else if (a === "--fixture" || a.startsWith("--fixture=")) {
      opts.fixture = val("--fixture") ?? null;
    }
  }
  if (opts.cloud) {
    opts.host = "0.0.0.0";
    opts.views = false;
    const fromEnv = validPort(env.PORT);
    if (!explicitPort && fromEnv !== null) opts.port = fromEnv;
  }
  return opts;
}

function validPort(raw) {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : null;
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) out.push(`http://${n.address}:${port}`);
    }
  }
  return out;
}

const REGISTER_SYNC_MS = 300_000;
const REGISTER_SYNC_FIRST_MS = 60_000;

/**
 * The register sync (hand-kept register + owner queue rows -> events) runs only on the single
 * local views writer (`--views`), never in cloud, in a one-shot run or with a fixture.
 */
export function shouldRunRegisterSync(opts) {
  return Boolean(opts.views && !opts.cloud && !opts.once && !opts.fixture);
}

/**
 * Runs `run()` after `firstDelayMs`, then every `intervalMs` (never overlapping). `onDone` gets
 * the result of each pass that appended events; errors are logged and the schedule goes on.
 * Returns a stop function. `schedule`/`cancel` are injectable for tests.
 */
export function startRegisterSync({
  run,
  onDone = () => {},
  log = () => {},
  firstDelayMs = REGISTER_SYNC_FIRST_MS,
  intervalMs = REGISTER_SYNC_MS,
  schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  cancel = clearTimeout,
}) {
  let handle = null;
  let stopped = false;
  const tick = async () => {
    handle = null;
    try {
      const res = await run();
      if (res?.appended > 0) onDone(res);
    } catch (err) {
      log(`register sync failed: ${err?.message ?? err}`);
    }
    if (!stopped) handle = schedule(tick, intervalMs);
  };
  handle = schedule(tick, firstDelayMs);
  return () => {
    stopped = true;
    if (handle !== null) cancel(handle);
  };
}

/** Writes the last snapshot atomically (`rf audit` reads it). Never throws. */
export function writeLastSnapshot(home, snap) {
  try {
    mkdirSync(home, { recursive: true });
    const file = join(home, "last-snapshot.json");
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, file);
  } catch {
    /* audit falls back to the events */
  }
}

// Hash ignores fields that tick with the clock so we only broadcast real changes.
const hashSnapshot = (snap) =>
  createHash("sha1")
    .update(
      JSON.stringify(snap, (k, v) =>
        k === "generatedAt" || k === "ageSec" || k === "silentMin" ? undefined : v,
      ),
    )
    .digest("hex");

const SOURCE_NAMES = ["specs", "github", "branches", "bugs", "areas", "railway"];

/** A startup problem to show as one clear message (no stack trace). */
export class StartupError extends Error {}

/** Collector sources with GitHub + Railway deploy rows merged (Railway wins, GitHub's kept). */
export function withMergedDeploys(sources, mergeDeploys) {
  const gh = sources.github?.data?.deploys;
  if (!gh?.length) return sources;
  const rw = sources.railway ?? {};
  return {
    ...sources,
    railway: { ...rw, data: { ...(rw.data ?? {}), deploys: mergeDeploys(gh, rw.data?.deploys) } },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = resolveListenOptions(argv, env);
  const { checkCloudEnv } = await import("./lib/cloud.mjs");
  const check = checkCloudEnv(env, { cloud: opts.cloud });
  if (!check.ok) throw new StartupError(check.errors.join("\n"));
  const auth = env.OPS_PASSWORD_HASH
    ? { passwordHash: env.OPS_PASSWORD_HASH, sessionSecret: env.OPS_SESSION_SECRET }
    : null;

  let snapshot;
  const listeners = new Set();
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const publish = (next) => {
    const changed = !snapshot || hashSnapshot(next) !== hashSnapshot(snapshot);
    snapshot = next;
    if (changed) for (const fn of [...listeners]) fn(snapshot);
  };
  let stopCollector = () => {};
  let webhook = null;

  if (opts.fixture) {
    snapshot = JSON.parse(await readFile(resolve(opts.fixture), "utf8"));
  } else {
    const cfg = await import("./lib/config.mjs");
    const { createCollector, mergeDeploys } = await import("./lib/collector.mjs");
    const { buildSnapshot } = await import("./lib/snapshot.mjs");
    const { exec } = await import("./lib/store.mjs");
    let repoRoot = cfg.repoDir(env);
    let specs = cfg.specsDir(env);
    if (opts.cloud) {
      // Clone (read-only) before listening; the healthcheck has a long timeout for this.
      const { cloudBoot, redact } = await import("./lib/cloud.mjs");
      try {
        ({ repoDir: repoRoot, specsDir: specs } = await cloudBoot({ env, exec }));
      } catch (err) {
        throw new StartupError(redact(err?.message ?? err, [env.GITHUB_TOKEN]));
      }
    }
    let refused = null;
    let viewsTimer = null;
    let snapTimer = null;
    let stopRegisterSync = () => {};
    let lastViewsHash = null;
    let collector = null;
    const rebuild = () => {
      const config = cfg.loadConfig(specs);
      const snap = buildSnapshot({
        sources: withMergedDeploys(collector.sources, mergeDeploys),
        config,
        now: Date.now(),
        machine: cfg.machineId(config, env),
      });
      if (refused) {
        snap.alarms = [
          ...snap.alarms,
          {
            id: "register-hand-edited:register",
            kind: "register-hand-edited",
            severity: "warn",
            message: `Generated register not written: ${refused}`,
            suggest: null,
            item: null,
            lane: null,
            pr: null,
            branch: null,
            source: null,
          },
        ];
      }
      return snap;
    };
    const persistSnapshot = () => {
      if (opts.cloud || opts.once || snapTimer) return;
      snapTimer = setTimeout(() => {
        snapTimer = null;
        writeLastSnapshot(cfg.opsHome(env), snapshot);
      }, 30_000);
      snapTimer.unref?.();
    };
    const scheduleViews = (snap) => {
      // The cloud service never writes git, whatever the flags say.
      if (opts.cloud || !opts.views || opts.once) return;
      if (hashSnapshot(snap) === lastViewsHash || viewsTimer) return;
      viewsTimer = setTimeout(async () => {
        viewsTimer = null;
        try {
          const { writeViews } = await import("./lib/views.mjs");
          const cur = snapshot;
          lastViewsHash = hashSnapshot(cur);
          const r = await writeViews({
            specsDir: specs,
            boardDir: cfg.boardDir(env),
            snapshot: cur,
            push: true,
            dry: false,
            registerMode:
              cfg.loadConfig(specs).registerMode === "generated" ? "generated" : "human",
          });
          const was = refused;
          refused = r?.refused ?? null;
          if (was !== refused) publish(rebuild());
        } catch (err) {
          console.error(`[ops-monitor] views failed: ${err?.message ?? err}`);
        }
      }, VIEWS_DEBOUNCE_MS);
      viewsTimer.unref?.();
    };
    collector = createCollector({
      repoRoot,
      specsDir: specs,
      exec,
      now: Date.now,
      env,
      cloud: opts.cloud,
      log: (m) => console.error(`[ops-monitor] ${m}`),
      onUpdate: () => {
        try {
          publish(rebuild());
          scheduleViews(snapshot);
          persistSnapshot();
        } catch (err) {
          console.error(`[ops-monitor] snapshot failed: ${err?.message ?? err}`);
        }
      },
    });
    snapshot = rebuild();
    if (opts.once) {
      for (const name of SOURCE_NAMES) await collector.runOnce(name);
      snapshot = rebuild();
      const s = snapshot;
      const all = Object.entries(s.sources);
      const bad = all.filter(([, v]) => !v.ok);
      console.log(
        `ops-monitor once: ${s.stats.items} items, ${s.stats.openBugs} open bugs, ` +
          `${s.prs.open.length} open PRs, ${s.alarms.length} alarms, ` +
          `sources ok ${all.length - bad.length}/${all.length}` +
          (bad.length ? ` (failing: ${bad.map(([k, v]) => `${k}: ${v.error}`).join("; ")})` : ""),
      );
      return undefined;
    }
    if (env.GITHUB_WEBHOOK_SECRET) {
      const { createWebhookDispatcher, routeWebhook } = await import("./lib/webhooks.mjs");
      const dispatcher = createWebhookDispatcher({ runOnce: (n) => collector.runOnce(n) });
      webhook = {
        secret: env.GITHUB_WEBHOOK_SECRET,
        onEvent: (name, payload) => dispatcher.dispatch(routeWebhook(name, payload)),
      };
    } else if (opts.cloud) {
      console.error("[ops-monitor] GITHUB_WEBHOOK_SECRET not set: webhooks off, polling only");
    }
    collector.start();
    if (shouldRunRegisterSync(opts)) {
      const { runSync } = await import("./lib/sync.mjs");
      const { loadBugIds } = await import("./lib/store.mjs");
      let lastRegisterNote = "";
      stopRegisterSync = startRegisterSync({
        run: async () => {
          const res = await runSync({
            dir: specs,
            home: cfg.opsHome(env),
            env,
            bugIds: await loadBugIds(repoRoot),
          });
          // A refused register (duplicate row ids) or refused rows (id collisions): log once per change.
          const note = [
            res?.refused ? `register refused: ${res.refused}` : null,
            res?.collisions?.length
              ? `register rows refused (id shared with a monitor item): ${res.collisions.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("; ");
          if (note !== lastRegisterNote) {
            lastRegisterNote = note;
            if (note) console.error(`[ops-monitor] ${note}`);
          }
          return res;
        },
        onDone: (res) => {
          console.error(`[ops-monitor] register sync appended ${res.appended} event(s)`);
          collector.runOnce("specs").catch(() => {});
        },
        log: (m) => console.error(`[ops-monitor] ${m}`),
      });
    }
    stopCollector = () => {
      collector.stop();
      stopRegisterSync();
      if (viewsTimer) clearTimeout(viewsTimer);
      if (snapTimer) clearTimeout(snapTimer);
    };
  }

  const server = createMonitorServer({
    getSnapshot: () => snapshot,
    subscribe,
    auth,
    webhook,
    cloud: opts.cloud,
  });
  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port, opts.host, res);
  });
  const port = server.address().port;
  if (opts.cloud) {
    console.log(`RouteFlow ops monitor (cloud): listening on 0.0.0.0:${port}`);
  } else {
    console.log(
      `RouteFlow ops monitor: http://127.0.0.1:${port}${auth ? " (login required)" : ""}`,
    );
    if (opts.host === "0.0.0.0") {
      for (const u of lanUrls(port)) console.log(`  LAN${auth ? "" : " (read-only)"}: ${u}`);
    }
  }
  const shutdown = () => {
    stopCollector();
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    if (err instanceof StartupError) console.error(`[ops-monitor] cannot start:\n${err.message}`);
    else console.error(err?.stack ?? err);
    process.exit(1);
  });
}
