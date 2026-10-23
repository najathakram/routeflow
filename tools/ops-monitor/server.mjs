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
import { randomBytes } from "node:crypto";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_S,
  authFromEnv,
  clearCookie,
  clientIp,
  createFailureLimiter,
  parseCookies,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from "./lib/auth.mjs";
import { renderIcon } from "./lib/icon.mjs";
import { describeSyncOutcome } from "./lib/sync.mjs";
import {
  createNameLoader,
  emptyListReason,
  fallbackMaskDeep,
  fallbackMaskText,
  maskDeep,
  maskText,
} from "./lib/mask.mjs";
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
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
};
// PWA icons are generated at runtime (no images in git): path -> [size, full-bleed].
const ICONS = {
  "/icon-192.png": [192, false],
  "/icon-512.png": [512, false],
  "/apple-touch-icon.png": [180, true],
};
const iconCache = new Map();
const LOGIN_FILE = "login.html";
const ORIGIN_REFUSED =
  "This sign-in came from somewhere the monitor doesn&#39;t recognise. Open the monitor&#39;s address directly and try again.";
const ERROR_MARKER = "<!--login-error-->";
const LOGIN_ERRORS = {
  1: "Incorrect password. Try again.",
  2: "Too many attempts. Try again in a few minutes.",
};
// Reachable without a session (GET).
const OPEN_GET = new Set([
  "/login",
  "/api/health",
  "/app.css",
  "/robots.txt",
  "/manifest.webmanifest",
  ...Object.keys(ICONS),
]);
const SESSION_REFRESH_BELOW_MS = (SESSION_MAX_AGE_S * 1000) / 2; // sliding: re-issue under 15 days left

function sessionExp(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8")).exp;
  } catch {
    return null;
  }
}

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
  log = (m) => console.error(`[ops-monitor] ${m}`),
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

  // Cross-site form posts. An Origin must name this host. "Origin: null" (what browsers send for a
  // same-origin POST under Referrer-Policy: no-referrer) is accepted only when the browser-set
  // Sec-Fetch-Site says same-origin. A request with no Origin at all (curl, tests) is allowed
  // unless a browser's Sec-Fetch-Site marks it as coming from elsewhere. That allowance is safe
  // only because the session cookie is SameSite=Lax (pinned by a test): do not loosen the cookie
  // to None without tightening this check.
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (origin === undefined)
      return site === undefined || site === "same-origin" || site === "none";
    if (origin === "null") return site === "same-origin";
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  // One line per login attempt. The client tag is a short non-reversible hash of the IP with a
  // per-boot random salt; nothing else about the request (and never the password) is logged.
  const loginSalt = randomBytes(16);
  const clientTag = (ip) =>
    createHash("sha256").update(loginSalt).update(String(ip)).digest("hex").slice(0, 8);
  const loginLog = (outcome, ip) => log(`login ${outcome} client ${clientTag(ip)}`);

  async function handleLogin(req, res) {
    const ip = clientIp(req, { cloud });
    if (!sameOrigin(req)) {
      loginLog("bad-request origin-mismatch", ip);
      return loginPage(res, "", { status: 403, message: ORIGIN_REFUSED });
    }
    const { tooLarge, body } = await readBody(req, LOGIN_BODY_MAX);
    if (tooLarge) {
      loginLog("bad-request", ip);
      return text(res, 413, "request too large", { connection: "close" });
    }
    const t = now();
    // A blocked client never reaches scrypt; only failures are counted.
    if (limiter.blocked(ip, t) || globalLimiter.blocked("*", t)) {
      loginLog("rate-limited", ip);
      return redirect(res, 303, "/login?e=2");
    }
    const password = new URLSearchParams(body.toString("utf8")).get("password") ?? "";
    if (!verifyPassword(password, auth.passwordHash)) {
      limiter.fail(ip, t);
      globalLimiter.fail("*", t);
      loginLog("wrong", ip);
      return redirect(res, 303, "/login?e=1");
    }
    limiter.reset(ip);
    loginLog("ok", ip);
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

  async function loginPage(res, query, { status = 200, message } = {}) {
    const e = new URLSearchParams(query).get("e");
    let html = await readFile(join(publicDir, LOGIN_FILE), "utf8");
    const msg = message ?? (Object.hasOwn(LOGIN_ERRORS, e) ? LOGIN_ERRORS[e] : null);
    html = html.replace(ERROR_MARKER, msg ? `<p class="login-error" role="alert">${msg}</p>` : "");
    return send(res, status, "text/html; charset=utf-8", html);
  }

  return http.createServer(async (req, res) => {
    try {
      // Headers on every response; writeHead later merges its own on top.
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "same-origin");
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

      if (auth && !OPEN_GET.has(path)) {
        // Sliding session: re-issue the cookie once less than half its life remains.
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        const exp = sessionExp(token);
        if (typeof exp === "number" && exp - now() < SESSION_REFRESH_BELOW_MS) {
          const fresh = signSession({ exp: now() + SESSION_MAX_AGE_S * 1000 }, auth.sessionSecret);
          res.setHeader("set-cookie", sessionCookie(fresh, { secure: isHttps(req) }));
        }
      }
      if (Object.hasOwn(ICONS, path)) {
        if (!iconCache.has(path)) {
          const [size, full] = ICONS[path];
          iconCache.set(path, renderIcon(size, { full }));
        }
        return send(res, 200, "image/png", iconCache.get(path), {
          "cache-control": "public, max-age=86400",
        });
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
 * A rate-limited step for the collector's specs pass (`afterSpecsPull`): the first `run()` is due
 * `firstMs` after creation, then every `intervalMs`; calls in between return at once. `onDone`
 * gets a result that appended events; errors are logged and never thrown (the step is retried
 * after the next interval). `now` is injectable for tests.
 */
export function makeSpecsPassStep({
  run,
  onDone = () => {},
  log = () => {},
  firstMs = REGISTER_SYNC_FIRST_MS,
  intervalMs = REGISTER_SYNC_MS,
  now = Date.now,
}) {
  let due = now() + firstMs;
  return async () => {
    if (now() < due) return false;
    due = now() + intervalMs;
    try {
      const res = await run();
      if (res?.appended > 0) onDone(res);
    } catch (err) {
      log(`register sync failed: ${err?.message ?? err}`);
    }
    return true;
  };
}

// At most one "lock starved the syncs" line per this window.
export const SYNC_STARVATION_LOG_MS = 600_000;

/**
 * The collector's specs-pass hooks for the register + status syncs. `afterPull` (inside the lock
 * hold, right after the pull) runs each step in order, each only when due, then logs one timing
 * line; a failed pull skips them all for this pass with one log line. `onBusy` (the pass found the specs lock held and
 * skipped) logs, at most once per `throttleMs`, how long since the last pass that ran the syncs.
 */
export function makeSpecsPassHook({
  steps,
  log = () => {},
  now = Date.now,
  throttleMs = SYNC_STARVATION_LOG_MS,
}) {
  const startedAt = now();
  let lastOkAt = null;
  let lastBusyLogAt = null;
  return {
    async afterPull({ pullOk = true, pullError = null, pullMs = 0, lockStartedAt = now() } = {}) {
      if (pullOk === false) {
        log(`specs pull failed, register and status sync skipped this pass: ${pullError}`);
        return;
      }
      lastOkAt = now();
      const took = {};
      for (const { name, run } of steps) {
        const t0 = now();
        took[name] = (await run()) === false ? "skip" : now() - t0;
      }
      log(
        `specs pass: lock ${now() - lockStartedAt} ms (pull ${pullMs}, register ${took.register ?? "skip"}, status ${took.status ?? "skip"})`,
      );
    },
    onBusy() {
      if (lastBusyLogAt !== null && now() - lastBusyLogAt < throttleMs) return;
      lastBusyLogAt = now();
      const mins = Math.floor((now() - (lastOkAt ?? startedAt)) / 60000);
      log(
        `specs lock busy, register and status sync skipped: no sync for ${mins} min` +
          (lastOkAt === null ? " (since start)" : ""),
      );
    },
  };
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

/**
 * The register-sync log line for one pass. Every pass that appends nothing says why (busy lock,
 * pull error, generated mode, no changes), plus a refused register or refused rows, logged once per
 * change of that text so a stalled sync is never silent and a steady state never spams. A busy
 * streak logs at its first pass and then every BUSY_LOG_EVERY-th. Returns `{ note, log }`: `note`
 * is the new last-logged text, `log` the line to print or null.
 */
export const BUSY_LOG_EVERY = 6;
export function registerSyncLog(lastNote, res, { busyRuns = 0, mask = (t) => t } = {}) {
  if (busyRuns > 1 && busyRuns % BUSY_LOG_EVERY !== 0) return { note: lastNote, log: null };
  const note = [
    describeSyncOutcome(res, { busyRuns, mask }),
    res?.refused ? `register refused: ${res.refused}` : null,
    res?.collisions?.length
      ? `register rows refused (id shared with a monitor item): ${res.collisions.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  return note === lastNote ? { note, log: null } : { note, log: note || null };
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
  const check = checkCloudEnv(env, {
    cloud: opts.cloud,
    views: opts.views,
    lan: opts.host !== "127.0.0.1" && opts.host !== "localhost",
  });
  if (!check.ok) throw new StartupError(check.errors.join("\n"));
  const auth = authFromEnv(env);

  // Client names are masked in every snapshot (SSE, /api/snapshot, last-snapshot.json, views).
  const nameLoader = createNameLoader({ env });
  {
    // Plain localhost still runs without a list, but says so once (cloud, --lan and --views refused above).
    nameLoader.get();
    const problem = nameLoader.error();
    if (problem || nameLoader.get().length === 0) {
      console.error(
        `[ops-monitor] warning: ${problem ?? emptyListReason(env)} - the board is not masked; fill client-names.json in the ops home or set CLIENT_NAMES_JSON.`,
      );
    }
  }
  // Fail closed: with no readable names list the fallback masker runs on every snapshot and the
  // snapshot says so (maskStatus), so the page can show a banner.
  const maskState = () => {
    const names = nameLoader.get();
    const problem = nameLoader.error();
    const ok = !problem && names.length > 0;
    return {
      names,
      fallback: !ok,
      status: ok
        ? { ok: true, reason: null }
        : { ok: false, reason: problem ?? emptyListReason(env) },
    };
  };
  const maskOne = (t) => {
    const m = maskState();
    return m.fallback ? fallbackMaskText(maskText(t, m.names)) : maskText(t, m.names);
  };
  const maskAll = (obj) => {
    const m = maskState();
    const once = maskDeep(obj, m.names);
    return m.fallback ? fallbackMaskDeep(once) : once;
  };
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
    const fx = JSON.parse(await readFile(resolve(opts.fixture), "utf8"));
    const status = maskState().status;
    snapshot = maskAll({
      ...fx,
      maskStatus: status,
      alarms: status.ok
        ? fx.alarms
        : [
            {
              id: "mask-list-missing:mask",
              kind: "mask-list-missing",
              severity: "error",
              message: "client-name mask list missing — tenant names hidden by fallback",
              suggest: null,
              item: null,
              lane: null,
              pr: null,
              branch: null,
              source: "mask",
            },
            ...(fx.alarms ?? []),
          ],
    });
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
    let pullHook = null; // (collector hooks) set once the register/status syncs are wired (local --views only)
    let lastViewsHash = null;
    let collector = null;
    const rebuild = () => {
      const config = cfg.loadConfig(specs);
      // Mask the raw inputs BEFORE the snapshot is built (a name cut in half by a clip or a slice
      // would no longer match), and the finished snapshot again below.
      const snap = buildSnapshot({
        sources: maskAll(withMergedDeploys(collector.sources, mergeDeploys)),
        config,
        now: Date.now(),
        machine: cfg.machineId(config, env),
        mask: maskOne,
        maskStatus: maskState().status,
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
      return maskAll(snap);
    };
    const persistSnapshot = () => {
      if (opts.cloud || opts.once || snapTimer) return;
      snapTimer = setTimeout(
        () => {
          snapTimer = null;
          writeLastSnapshot(cfg.opsHome(env), snapshot);
        },
        Number(env.RF_PERSIST_MS) || 30_000,
      );
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
            clientNames: nameLoader.get(),
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
      mask: maskOne,
      log: (m) => console.error(`[ops-monitor] ${m}`),
      afterSpecsPull: (a) => pullHook?.afterPull(a),
      onSpecsBusy: () => pullHook?.onBusy(),
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
      // Both syncs ride the collector's specs pass: it already holds the specs lock and has just
      // pulled, so they can never lose the lock to their own process (a timer did, on a slow box).
      // The pass re-reads the events right after the hook, so appended events show up at once.
      const { runStatusSync } = await import("./lib/status-sync.mjs");
      const { runSync } = await import("./lib/sync.mjs");
      const { loadBugIds } = await import("./lib/store.mjs");
      const home = cfg.opsHome(env);
      // Same fail-closed masker as the snapshot (falls back when the client-name list is missing).
      const mask = maskOne;
      const say = (m) => console.error(`[ops-monitor] ${m}`);
      let lastStatusNote = "";
      const statusStep = makeSpecsPassStep({
        firstMs: 30_000,
        intervalMs: 120_000,
        run: async () => {
          const res = await runStatusSync({ dir: specs, home, env, lockHeld: true });
          const step = registerSyncLog(lastStatusNote, res);
          lastStatusNote = step.note;
          if (step.log)
            say(
              step.log
                .replace("register sync", "status sync")
                .replace("register and events agree", "no heartbeat changes"),
            );
          if (res?.capped) say(`status sync capped: ${res.capped} left for the next pass`);
          return res;
        },
        onDone: (res) => say(`status sync appended ${res.appended} heartbeat(s)`),
        log: (m) => say(m.replace("register sync", "status sync")),
      });
      let lastRegisterNote = "";
      const registerStep = makeSpecsPassStep({
        run: async () => {
          const res = await runSync({
            dir: specs,
            home,
            env,
            mask,
            bugIds: await loadBugIds(repoRoot),
            lockHeld: true,
          });
          const step = registerSyncLog(lastRegisterNote, res, { mask });
          lastRegisterNote = step.note;
          if (step.log) say(step.log);
          return res;
        },
        onDone: (res) => say(`register sync appended ${res.appended} event(s)`),
        log: say,
      });
      say(
        `register sync on: inside the specs pass (holds the specs lock already), first in ${REGISTER_SYNC_FIRST_MS / 1000} s, then every ${REGISTER_SYNC_MS / 60000} min`,
      );
      pullHook = makeSpecsPassHook({
        steps: [
          { name: "status", run: statusStep },
          { name: "register", run: registerStep },
        ],
        log: say,
      });
    }
    stopCollector = () => {
      collector.stop();
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
