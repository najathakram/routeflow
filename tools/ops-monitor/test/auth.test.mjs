import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_S,
  clearCookie,
  clientIp,
  createFailureLimiter,
  createRateLimiter,
  hashPassword,
  authFromEnv,
  hashPasswordCli,
  isWellFormedHash,
  parseCookies,
  sessionCookie,
  signSession,
  verifyPassword,
  verifySession,
} from "../lib/auth.mjs";

const SECRET = "ab".repeat(32);
const NOW = Date.parse("2026-10-19T12:00:00Z");

test("hashPassword / verifyPassword round trip", () => {
  const h = hashPassword("correct horse battery", { salt: Buffer.alloc(16, 7) });
  const [alg, salt, hash] = h.split("$");
  assert.equal(alg, "scrypt");
  assert.equal(Buffer.from(salt, "base64").length, 16);
  assert.equal(Buffer.from(hash, "base64").length, 64);
  assert.equal(verifyPassword("correct horse battery", h), true);
  assert.equal(verifyPassword("wrong", h), false);
  assert.equal(verifyPassword("", h), false);
});

test("hashPassword uses a random salt by default", () => {
  assert.notEqual(hashPassword("same password"), hashPassword("same password"));
});

test("verifyPassword: malformed stored hashes are false, never throw", () => {
  for (const bad of [
    undefined,
    null,
    "",
    "plain",
    "scrypt$",
    "scrypt$a",
    "scrypt$a$b$c",
    "md5$a$b",
    "scrypt$!!$??",
    "scrypt$AAAA$AAAA",
  ]) {
    assert.equal(verifyPassword("pw", bad), false, String(bad));
  }
  assert.equal(isWellFormedHash(hashPassword("pw-long-enough")), true);
  assert.equal(isWellFormedHash("scrypt$AAAA$AAAA"), false);
  assert.equal(isWellFormedHash(""), false);
});

test("sessions: sign, verify, expired, tampered, wrong secret, malformed", () => {
  const t = signSession({ exp: NOW + 1000 }, SECRET);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(verifySession(t, SECRET, NOW), true);
  assert.equal(verifySession(t, SECRET, NOW + 1000), false, "expired at exp");
  assert.equal(verifySession(t, SECRET, NOW + 5000), false);
  assert.equal(verifySession(t, "cd".repeat(32), NOW), false);
  const [p, s] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ exp: NOW + 9e9 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${s}`, SECRET, NOW), false);
  assert.equal(verifySession(`${p}.${s.slice(0, -2)}AA`, SECRET, NOW), false);
  for (const bad of [undefined, null, "", "abc", "a.b.c", ".", `${p}.`, `.${s}`, 42]) {
    assert.equal(verifySession(bad, SECRET, NOW), false, String(bad));
  }
  assert.equal(verifySession(t, "", NOW), false, "empty secret never verifies");
  assert.equal(verifySession(t, undefined, NOW), false);
  assert.equal(verifySession(signSession({}, SECRET), SECRET, NOW), false, "no numeric exp");
});

test("cookies: parse, set (Secure only over https/cloud), clear", () => {
  assert.deepEqual(parseCookies("a=1; ops_session=tok.en; b=x%20y"), {
    a: "1",
    ops_session: "tok.en",
    b: "x y",
  });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("junk; =; k="), { k: "" });
  assert.equal(COOKIE_NAME, "ops_session");
  assert.equal(SESSION_MAX_AGE_S, 2592000);
  const c = sessionCookie("tok", { secure: false });
  assert.equal(c, "ops_session=tok; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
  assert.equal(sessionCookie("tok", { secure: true }), `${c}; Secure`);
  assert.match(clearCookie({ secure: true }), /^ops_session=; .*Max-Age=0.*; Secure$/);
  assert.match(clearCookie({ secure: false }), /Max-Age=0/);
  assert.doesNotMatch(clearCookie({ secure: false }), /Secure/);
});

test("rate limiter: 11th attempt blocked, other keys unaffected, window resets", () => {
  const rl = createRateLimiter({ max: 10, windowMs: 900000 });
  for (let i = 0; i < 10; i++) assert.equal(rl.hit("1.2.3.4", NOW + i), true, `attempt ${i + 1}`);
  assert.equal(rl.hit("1.2.3.4", NOW + 10), false);
  assert.equal(rl.hit("1.2.3.4", NOW + 899999), false);
  assert.equal(rl.hit("5.6.7.8", NOW + 11), true);
  assert.equal(rl.hit("1.2.3.4", NOW + 900000), true, "window elapsed");
  const defaults = createRateLimiter();
  for (let i = 0; i < 10; i++) defaults.hit("k", NOW);
  assert.equal(defaults.hit("k", NOW), false);
});

test("clientIp: cloud uses x-real-ip, else the LAST x-forwarded-for hop; local uses the socket", () => {
  const fwd = {
    headers: { "x-forwarded-for": "6.6.6.6, 9.9.9.9" },
    socket: { remoteAddress: "::1" },
  };
  assert.equal(clientIp(fwd, { cloud: true }), "9.9.9.9", "spoofed first hop is ignored");
  assert.equal(
    clientIp({ ...fwd, headers: { ...fwd.headers, "x-real-ip": "5.5.5.5" } }, { cloud: true }),
    "5.5.5.5",
  );
  assert.equal(clientIp(fwd), "::1", "local: headers never trusted");
  assert.equal(
    clientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }, { cloud: true }),
    "::ffff:127.0.0.1",
  );
  assert.equal(
    clientIp(
      { headers: { "x-forwarded-for": "" }, socket: { remoteAddress: "7.7.7.7" } },
      { cloud: true },
    ),
    "7.7.7.7",
  );
  assert.equal(clientIp({ headers: {}, socket: {} }), "unknown");
});

test("createFailureLimiter: blocks after max failures, success resets, window expires, map is capped", () => {
  const rl = createFailureLimiter({ max: 3, windowMs: 1000, maxBuckets: 5 });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.blocked("a", NOW), false);
    rl.fail("a", NOW);
  }
  assert.equal(rl.blocked("a", NOW), true);
  assert.equal(rl.blocked("b", NOW), false, "other keys unaffected");
  rl.reset("a");
  assert.equal(rl.blocked("a", NOW), false);
  for (let i = 0; i < 3; i++) rl.fail("a", NOW);
  assert.equal(rl.blocked("a", NOW + 1000), false, "window elapsed");
  for (let i = 0; i < 20; i++) rl.fail(`k${i}`, NOW);
  assert.ok(rl.size() <= 5, `size ${rl.size()}`);
  assert.equal(rl.blocked("k19", NOW), false);
});

test("hashPasswordCli: reads stdin, prints only the hash, rejects short passwords", async () => {
  const out = [];
  const err = [];
  const h = await hashPasswordCli({
    stdin: Readable.from([Buffer.from("a long enough pw\n")]),
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  assert.match(h, /^scrypt\$/);
  assert.equal(out.join(""), `${h}\n`);
  assert.equal(verifyPassword("a long enough pw", h), true);
  assert.deepEqual(err, []);

  const out2 = [];
  const err2 = [];
  const prevExit = process.exitCode;
  const none = await hashPasswordCli({
    stdin: Readable.from([Buffer.from("short\n")]),
    stdout: { write: (s) => out2.push(s) },
    stderr: { write: (s) => err2.push(s) },
  });
  process.exitCode = prevExit;
  assert.equal(none, null);
  assert.deepEqual(out2, []);
  assert.match(err2.join(""), /at least 8/);
  assert.doesNotMatch(err2.join(""), /short/);
});

// A TTY stand-in: each time a hidden prompt starts listening it "types" the next line.
function fakeTty(lines) {
  const e = new EventEmitter();
  e.isTTY = true;
  e.setRawMode = () => {};
  e.resume = () => {};
  e.pause = () => {};
  e.setEncoding = () => {};
  const on = e.on.bind(e);
  e.on = (ev, fn) => {
    on(ev, fn);
    if (ev === "data") setImmediate(() => e.emit("data", lines.shift() + "\r"));
    return e;
  };
  return e;
}
const sink = () => {
  const o = [];
  return { o, write: (s) => o.push(s) };
};

test("hashPasswordCli (TTY): asks twice, a mismatch is refused with a non-zero exit", async () => {
  const out = sink();
  const err = sink();
  const prev = process.exitCode;
  const h = await hashPasswordCli({
    stdin: fakeTty(["a long enough pw", "a long enough pW"]),
    stdout: out,
    stderr: err,
  });
  const code = process.exitCode;
  process.exitCode = prev;
  assert.equal(h, null);
  assert.equal(code, 1);
  assert.deepEqual(out.o, []);
  assert.match(err.o.join(""), /Password:/);
  assert.match(err.o.join(""), /Again:/);
  assert.match(err.o.join(""), /do not match/);
  assert.doesNotMatch(err.o.join(""), /long enough/);
});

test("hashPasswordCli (TTY): matching entries produce a hash that verifies; empty is refused", async () => {
  const out = sink();
  const h = await hashPasswordCli({
    stdin: fakeTty(["a long enough pw", "a long enough pw"]),
    stdout: out,
    stderr: sink(),
  });
  assert.match(h, /^scrypt[$]/);
  assert.equal(out.o.join(""), h + "\n");
  assert.equal(verifyPassword("a long enough pw", h), true);

  const err = sink();
  const prev = process.exitCode;
  const none = await hashPasswordCli({ stdin: fakeTty(["", ""]), stdout: sink(), stderr: err });
  const code = process.exitCode;
  process.exitCode = prev;
  assert.equal(none, null);
  assert.equal(code, 1);
  assert.match(err.o.join(""), /empty/);
});

test("authFromEnv trims env whitespace; the typed password is never trimmed", () => {
  const h = hashPassword(" spaced pass ");
  const a = authFromEnv({
    OPS_PASSWORD_HASH: h + "\r\n",
    OPS_SESSION_SECRET: "  " + SECRET + "\n",
  });
  assert.equal(a.sessionSecret, SECRET);
  assert.equal(verifyPassword(" spaced pass ", a.passwordHash), true);
  assert.equal(verifyPassword("spaced pass", a.passwordHash), false);
  assert.equal(authFromEnv({}), null);
});

test("hashPasswordCli: a multi-line piped paste is refused, not hashed", async () => {
  const out = sink();
  const err = sink();
  const prev = process.exitCode;
  const h = await hashPasswordCli({
    stdin: Readable.from([
      Buffer.from(
        "first line pw" + String.fromCharCode(10) + "second line" + String.fromCharCode(10),
      ),
    ]),
    stdout: out,
    stderr: err,
  });
  const code = process.exitCode;
  process.exitCode = prev;
  assert.equal(h, null);
  assert.equal(code, 1);
  assert.deepEqual(out.o, []);
  assert.match(err.o.join(""), /more than one line/);
});
