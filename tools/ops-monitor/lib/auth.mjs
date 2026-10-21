// Password login for the ops monitor: scrypt password hashes, HMAC-signed session cookies and a
// small in-memory rate limiter. Pure + node:crypto only. Every secret comparison uses
// timingSafeEqual; nothing here ever logs or returns a secret.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "ops_session";
export const SESSION_MAX_AGE_S = 2592000; // 30 days
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_BYTES = 16;
const MIN_PASSWORD_LEN = 8;

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `scrypt$<saltB64>$<hashB64>` (N=16384 r=8 p=1 keylen 64). */
export function hashPassword(password, { salt } = {}) {
  const s = salt ?? randomBytes(SALT_BYTES);
  const h = scryptSync(String(password), s, KEYLEN, SCRYPT);
  return `scrypt$${Buffer.from(s).toString("base64")}$${h.toString("base64")}`;
}

function parseStored(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  if (!B64.test(parts[1]) || !B64.test(parts[2])) return null;
  const salt = Buffer.from(parts[1], "base64");
  const hash = Buffer.from(parts[2], "base64");
  if (salt.length < 8 || hash.length !== KEYLEN) return null;
  return { salt, hash };
}

export const isWellFormedHash = (stored) => parseStored(stored) !== null;

/**
 * The login pair from env, whitespace-trimmed (a pasted Railway value often carries a trailing
 * newline). null when no hash is set. The typed password is never trimmed.
 */
export function authFromEnv(env = process.env) {
  const passwordHash = env.OPS_PASSWORD_HASH?.trim();
  if (!passwordHash) return null;
  return { passwordHash, sessionSecret: env.OPS_SESSION_SECRET?.trim() };
}

/** Constant-time check. A malformed stored hash is simply false. */
export function verifyPassword(password, stored) {
  const p = parseStored(stored);
  if (!p || typeof password !== "string" || password === "") return false;
  try {
    return safeEqual(scryptSync(password, p.salt, KEYLEN, SCRYPT), p.hash);
  } catch {
    return false;
  }
}

const mac = (payloadB64, secret) => createHmac("sha256", secret).update(payloadB64).digest();

/** `<b64url payload>.<b64url hmac-sha256>`; payload.exp is epoch ms. */
export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret).toString("base64url")}`;
}

/** True only for a correctly signed, unexpired token. Never throws. */
export function verifySession(token, secret, now = Date.now()) {
  try {
    if (typeof token !== "string" || typeof secret !== "string" || secret === "") return false;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const given = Buffer.from(parts[1], "base64url");
    if (!safeEqual(given, mac(parts[0], secret))) return false;
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return typeof payload?.exp === "number" && Number.isFinite(payload.exp) && now < payload.exp;
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token, { secure = false } = {}) {
  const base = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}`;
  return secure ? `${base}; Secure` : base;
}

export function clearCookie({ secure = false } = {}) {
  const base = `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  return secure ? `${base}; Secure` : base;
}

/** Fixed-window limiter. hit() counts the attempt and says whether it is allowed. */
export function createRateLimiter({ max = 10, windowMs = 900000 } = {}) {
  const buckets = new Map();
  return {
    hit(key, now = Date.now()) {
      if (buckets.size > 5000) {
        for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
      }
      let b = buckets.get(key);
      if (!b || now - b.start >= windowMs) {
        b = { start: now, count: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      return b.count <= max;
    },
  };
}

/**
 * Failure-only limiter: blocked() reads, fail() counts one failed attempt, reset() forgets a key
 * (a success). Fixed window; the bucket map is capped and evicts the oldest entries first.
 */
export function createFailureLimiter({ max = 10, windowMs = 900000, maxBuckets = 5000 } = {}) {
  const buckets = new Map(); // insertion order = oldest first
  const live = (key, now) => {
    const b = buckets.get(key);
    if (b && now - b.start >= windowMs) {
      buckets.delete(key);
      return undefined;
    }
    return b;
  };
  return {
    blocked(key, now = Date.now()) {
      const b = live(key, now);
      return Boolean(b) && b.count >= max;
    },
    fail(key, now = Date.now()) {
      let b = live(key, now);
      if (!b) {
        b = { start: now, count: 0 };
        buckets.set(key, b);
        while (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
      }
      b.count += 1;
    },
    reset(key) {
      buckets.delete(key);
    },
    size: () => buckets.size,
  };
}

/**
 * Client key for rate limiting. Behind the cloud proxy: x-real-ip when present, else the LAST
 * x-forwarded-for hop (the one the proxy appended; earlier hops are client-supplied). Locally the
 * headers are never trusted: the socket address.
 */
export function clientIp(req, { cloud = false } = {}) {
  const socket = req.socket?.remoteAddress || "unknown";
  if (!cloud) return socket;
  const real = req.headers?.["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = req.headers?.["x-forwarded-for"];
  const last = typeof fwd === "string" ? fwd.split(",").at(-1).trim() : "";
  return last || socket;
}

// ── IO ───────────────────────────────────────────────────────────────────────

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

// Reads one line from a TTY without echoing it.
function readHidden(stdin, stderr, prompt = "Password: ") {
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (fn, v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      fn(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(resolve, buf);
        if (ch === "\u0003") return done(reject, new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * `rf hash-password`: reads the password from stdin (hidden on a TTY, piped otherwise), prints
 * only the hash on stdout. Returns the hash, or null (stderr message, exit code 1) when refused.
 */
export async function hashPasswordCli({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let pw;
  let again = null;
  try {
    if (stdin.isTTY) {
      pw = await readHidden(stdin, stderr, "Password: ");
      again = await readHidden(stdin, stderr, "Again: ");
    } else pw = await readAll(stdin);
  } catch (e) {
    stderr.write(`${e?.message ?? "could not read password"}\n`);
    process.exitCode = 1;
    return null;
  }
  pw = pw.replace(/\r?\n$/, "");
  if (pw === "") {
    stderr.write("Password must not be empty.\n");
    process.exitCode = 1;
    return null;
  }
  // A hidden prompt hides typos too: it is typed twice and a mismatch hashes nothing.
  if (again !== null && again.replace(/\r?\n$/, "") !== pw) {
    stderr.write("The two entries do not match; nothing was hashed. Run it again.\n");
    process.exitCode = 1;
    return null;
  }
  if (pw.length < MIN_PASSWORD_LEN) {
    stderr.write(`Password must be at least ${MIN_PASSWORD_LEN} characters.\n`);
    process.exitCode = 1;
    return null;
  }
  const hash = hashPassword(pw);
  stdout.write(`${hash}\n`);
  return hash;
}
