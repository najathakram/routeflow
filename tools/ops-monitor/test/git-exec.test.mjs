import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createLimiter, runGit, gitLimiter } from "../lib/git-exec.mjs";
import { exec } from "../lib/store.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("Dockerfile runs the server under tini (PID 1 reaps orphaned git children)", () => {
  const df = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  assert.match(df, /apk add[^\n]*\btini\b/);
  assert.match(df, /^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m);
  assert.match(df, /^CMD \["node", "tools\/ops-monitor\/server\.mjs", "--cloud"\]$/m);
});

test("runGit: a hung child is killed at the timeout and the call rejects", async () => {
  const t0 = Date.now();
  await assert.rejects(
    runGit(["-e", "setTimeout(()=>{},1e9)"], { cmd: process.execPath, timeoutMs: 300 }),
    (e) => e.code === "GIT_TIMEOUT" && /git timed out/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 10000);
});

test("runGit: GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never on every call", async () => {
  const r = await runGit(
    [
      "-e",
      "process.stdout.write(process.env.GIT_TERMINAL_PROMPT+'/'+process.env.GCM_INTERACTIVE+'/'+process.env.X)",
    ],
    { cmd: process.execPath, env: { X: "1" } },
  );
  assert.equal(r.stdout, "0/never/1");
});

test("runGit: stdin input and exit code are passed through", async () => {
  const r = await runGit(
    ["-e", "process.stdin.on('data',d=>{process.stdout.write(String(d));process.exit(3)})"],
    { cmd: process.execPath, input: "hello" },
  );
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "hello");
});

test("runGit: EAGAIN / ENOMEM at spawn is reported as 'git spawn failed: <code>'", async () => {
  const spawn = () => {
    const ee = new EventEmitter();
    queueMicrotask(() =>
      ee.emit("error", Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" })),
    );
    return ee;
  };
  await assert.rejects(
    runGit(["status"], { spawn }),
    (e) => e.code === "GIT_SPAWN" && e.message === "git spawn failed: EAGAIN",
  );
});

test("store.exec turns a git spawn failure into a result with the clear text (never rejects)", async () => {
  const r = await exec("git", ["--version"], {
    gitRun: () =>
      Promise.reject(Object.assign(new Error("git timed out after 5ms"), { code: "GIT_TIMEOUT" })),
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /git timed out/);
});

test("limiter never runs more than 2 tasks at once", async () => {
  const lim = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
  };
  await Promise.all(Array.from({ length: 12 }, () => lim.run(task)));
  assert.equal(peak, 2);
  assert.equal(lim.active, 0);
});

test("limiter: a rejected task frees its slot; the shared git limiter is capped at 2", async () => {
  const lim = createLimiter(1);
  await assert.rejects(lim.run(() => Promise.reject(new Error("x"))));
  assert.equal(await lim.run(async () => 7), 7);
  assert.equal(gitLimiter.max, 2);
});

test("limiter warns once when the backlog exceeds the threshold", async () => {
  const warns = [];
  const lim = createLimiter(1, { warnAt: 3, warn: (m) => warns.push(m) });
  await Promise.all(
    Array.from({ length: 8 }, () => lim.run(() => new Promise((r) => setTimeout(r, 5)))),
  );
  assert.equal(warns.length, 1);
  assert.match(warns[0], /git/);
});
