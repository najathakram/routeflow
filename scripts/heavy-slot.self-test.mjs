#!/usr/bin/env node
// Self-test for scripts/lib/heavy-slot.mjs + scripts/heavy-slot.mjs.
//
// Everything runs in throwaway directories under the OS temp dir (RF_HEAVY_SLOT_DIR / `dir`), never
// the real ~/.routeflow/heavy-slot, and spawns no verify, no turbo, no docker: pure functions,
// in-process holders with short poll/heartbeat knobs, and four tiny `node` children.
// L-165: assertions read the slot's OWN records (history.jsonl, lock/queue files), never wall-clock.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { main as cliMain } from "./heavy-slot.mjs";
import {
  DEFAULT_SLOTS,
  HISTORY_MAX_LINES,
  HeavySlotTimeout,
  STALE_MS,
  formatStatus,
  formatWaitLine,
  historyRecord,
  nextGrant,
  orderTickets,
  parseMaxWaitMs,
  parseSlots,
  pidAlive,
  resolveDir,
  staleReason,
  ticketName,
  trimHistoryText,
  withHeavySlot,
} from "./lib/heavy-slot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "heavy-slot.mjs");
const LIB_URL = pathToFileURL(path.join(HERE, "lib", "heavy-slot.mjs")).href;

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const HOST = os.hostname();
const tmpDirs = [];
const mkTmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "heavy-slot-"));
  tmpDirs.push(d);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
};
const FAST = { pollMs: 10, heartbeatMs: 20 };
const history = (dir) => {
  try {
    return readFileSync(path.join(dir, "history.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const lockFile = (dir, i = 0) => path.join(dir, `slot-${i}.lock`);
const queued = (dir) => {
  try {
    return readdirSync(path.join(dir, "queue")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};
const ghost = (dir, over = {}, i = 0) => {
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    lockFile(dir, i),
    JSON.stringify({
      pid: process.pid,
      host: HOST,
      label: "ghost",
      branch: "feat/ghost",
      cwd: dir,
      queuedAt: now,
      startedAt: now,
      heartbeatAt: now,
      token: "ghost-token",
      slot: i,
      ...over,
    }),
  );
};
const deadPid = (() => {
  const r = spawnSync(process.execPath, ["-e", "0"]);
  return r.pid;
})();
const NO_LOG = { log: () => {} };
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ["CI", "RF_HEAVY_SLOT", "RF_HEAVY_SLOT_TOKEN", "RF_HEAVY_SLOTS"]) delete env[k];
  return env;
};

// ---- P: pure helpers ----------------------------------------------------------------------------
check(
  "P1 parseSlots: default 1; positive ints only",
  [
    DEFAULT_SLOTS,
    parseSlots(undefined),
    parseSlots("2"),
    parseSlots("0"),
    parseSlots("-1"),
    parseSlots("x"),
    parseSlots("1.5"),
    parseSlots(""),
  ],
  [1, 1, 2, 1, 1, 1, 1, 1],
);
check(
  "P2 parseMaxWaitMs: default 120 min; fractions allowed; junk and negatives fall back",
  [undefined, "0.02", "5", "-1", "abc", ""].map(parseMaxWaitMs),
  [7_200_000, 1200, 300_000, 7_200_000, 7_200_000, 7_200_000],
);
check(
  "P3 resolveDir: RF_HEAVY_SLOT_DIR wins, else <home>/.routeflow/heavy-slot",
  [resolveDir({ RF_HEAVY_SLOT_DIR: "/x/y" }, "/home/u"), resolveDir({}, path.join("/home", "u"))],
  ["/x/y", path.join("/home", "u", ".routeflow", "heavy-slot")],
);
const t9 = ticketName(9, 1, "aa");
const t10 = ticketName(10, 1, "aa");
check(
  "P4 ticket names are zero padded, so they sort by enqueue time (9 before 10)",
  [t9 < t10, orderTickets([{ name: t10 }, { name: t9 }]).map((t) => t.name)],
  [true, [t9, t10]],
);
check(
  "P5 pidAlive: ESRCH dead, EPERM alive, junk dead, own pid alive, a reaped child dead",
  [
    pidAlive(1, () => {
      throw Object.assign(new Error("x"), { code: "ESRCH" });
    }),
    pidAlive(1, () => {
      throw Object.assign(new Error("x"), { code: "EPERM" });
    }),
    pidAlive(0),
    pidAlive(Number.NaN),
    pidAlive(process.pid),
    pidAlive(deadPid),
  ],
  [false, true, false, false, true, false],
);
const NOW = 1_000_000_000;
const live = { pid: process.pid, host: "h", heartbeatAt: NOW - 1000 };
const ctx = { now: NOW, hostname: "h", alive: () => true };
check(
  "P6 staleReason: live, heartbeat, other host, dead pid, unreadable fresh/old, missing",
  [
    staleReason(live, ctx),
    staleReason({ ...live, heartbeatAt: NOW - STALE_MS - 1 }, ctx),
    staleReason({ ...live, heartbeatAt: NOW - STALE_MS }, ctx),
    staleReason({ ...live, host: "other" }, ctx),
    staleReason(live, { ...ctx, alive: () => false }),
    staleReason({ unreadable: true, mtimeMs: NOW - 1000 }, ctx),
    staleReason({ unreadable: true, mtimeMs: NOW - STALE_MS - 1 }, ctx),
    staleReason(null, ctx),
  ],
  [null, "heartbeat", null, "other-host", "dead-pid", null, "unreadable", "missing"],
);
check(
  "P7 nextGrant: only the oldest ticket with a free slot is granted",
  [
    nextGrant({ order: ["a", "b"], myName: "a", freeSlots: 1 }),
    nextGrant({ order: ["a", "b"], myName: "a", freeSlots: 0 }),
    nextGrant({ order: ["a", "b"], myName: "b", freeSlots: 1 }),
    nextGrant({ order: ["a"], myName: "z", freeSlots: 1 }),
  ],
  [
    { position: 1, total: 2, grant: true },
    { position: 1, total: 2, grant: false },
    { position: 2, total: 2, grant: false },
    { position: 0, total: 1, grant: false },
  ],
);
const many = Array.from({ length: 7 }, (_, i) => JSON.stringify({ i })).join("\n");
check(
  "P8 trimHistoryText: untouched at/under the cap, last N lines above it",
  [
    trimHistoryText(many, 7),
    trimHistoryText(many, 5)
      ?.trim()
      .split("\n")
      .map((l) => JSON.parse(l).i),
    HISTORY_MAX_LINES,
  ],
  [null, [2, 3, 4, 5, 6], 500],
);
const waitLine = formatWaitLine({
  position: 2,
  total: 3,
  holder: { label: "verify", branch: "feat/x", pid: 42, startedAt: NOW - 150_000 },
  now: NOW,
});
check(
  "P9 waiting line names position, holder label/branch/pid and minutes",
  waitLine,
  "heavy-slot: waiting (position 2 of 3) — held by verify on feat/x, pid 42, 2.5 min",
);
check(
  "P10 historyRecord carries the contract fields with waitSec/heldSec",
  historyRecord(
    { label: "l", branch: "b", host: "h", pid: 1, queuedAt: 1000, startedAt: 3500 },
    5000,
    0,
  ),
  {
    label: "l",
    branch: "b",
    host: "h",
    pid: 1,
    queuedAt: new Date(1000).toISOString(),
    startedAt: new Date(3500).toISOString(),
    endedAt: new Date(5000).toISOString(),
    waitSec: 2.5,
    heldSec: 1.5,
    exit: 0,
  },
);

// ---- I: in-process behaviour against throwaway slot dirs ---------------------------------------
{
  const dir = mkTmp();
  const seen = {};
  const tokenBefore = process.env.RF_HEAVY_SLOT_TOKEN;
  const out = await withHeavySlot(
    { label: "basic", branch: "b", dir, env: {}, ...FAST },
    async (c) => {
      seen.token = c.token;
      seen.lockExists = existsSync(lockFile(dir));
      seen.envToken = process.env.RF_HEAVY_SLOT_TOKEN;
      return "value";
    },
  );
  const h = history(dir);
  check(
    "I1 holds the slot while fn runs, returns its value, then releases and records history",
    [
      out,
      seen.lockExists,
      seen.envToken === seen.token && Boolean(seen.token),
      existsSync(lockFile(dir)),
      queued(dir),
      h.length,
      h[0]?.label,
      h[0]?.exit,
      h[0]?.waitSec >= 0 && h[0]?.heldSec >= 0,
      process.env.RF_HEAVY_SLOT_TOKEN === tokenBefore,
    ],
    ["value", true, true, false, [], 1, "basic", 0, true, true],
  );
}
{
  const dir = mkTmp();
  const r = await withHeavySlot(
    { label: "num", dir, branch: "b", env: {}, ...FAST },
    async () => 3,
  );
  let thrown = null;
  try {
    await withHeavySlot({ label: "boom", dir, branch: "b", env: {}, ...FAST }, async () => {
      throw new Error("boom");
    });
  } catch (e) {
    thrown = e.message;
  }
  check(
    "I2 a numeric result is the recorded exit code; a throw is recorded as 1, rethrown, and releases",
    [r, thrown, history(dir).map((x) => [x.label, x.exit]), existsSync(lockFile(dir))],
    [
      3,
      "boom",
      [
        ["num", 3],
        ["boom", 1],
      ],
      false,
    ],
  );
}
for (const [name, over] of [
  ["dead pid", { pid: deadPid }],
  ["old heartbeat", { heartbeatAt: Date.now() - STALE_MS - 5000 }],
  ["another host", { host: `${HOST}-other` }],
]) {
  const dir = mkTmp();
  ghost(dir, over);
  let ran = false;
  let err = null;
  try {
    await withHeavySlot(
      { label: "reclaimer", branch: "b", dir, env: {}, maxWaitMs: 5000, ...FAST, ...NO_LOG },
      async () => {
        ran = true;
      },
    );
  } catch (e) {
    err = e.message;
  }
  check(
    `I3 stale reclaim (${name}): the ghost lock is reclaimed and the job runs`,
    [ran, err, history(dir).map((x) => x.label), existsSync(lockFile(dir))],
    [true, null, ["reclaimer"], false],
  );
}
{
  const dir = mkTmp();
  ghost(dir, {});
  const file = lockFile(dir);
  writeFileSync(file, "{not json");
  const old = new Date(Date.now() - STALE_MS - 60_000);
  utimesSync(file, old, old);
  let ran = false;
  await withHeavySlot(
    { label: "r", branch: "b", dir, env: {}, maxWaitMs: 5000, ...FAST, ...NO_LOG },
    async () => {
      ran = true;
    },
  );
  check("I4 a corrupt lock with an old mtime is reclaimed", ran, true);
}
{
  const dir = mkTmp();
  ghost(dir, {});
  let ran = false;
  let err = null;
  try {
    await withHeavySlot(
      { label: "late", branch: "b", dir, env: {}, maxWaitMs: 40, ...FAST, ...NO_LOG },
      async () => {
        ran = true;
      },
    );
  } catch (e) {
    err = e;
  }
  check(
    "I5 fail closed: past the max wait it throws HeavySlotTimeout naming the holder, never runs fn, " +
      "leaves the holder's lock alone and withdraws its own ticket",
    [
      ran,
      err instanceof HeavySlotTimeout,
      /ghost on feat\/ghost \(pid \d+/.test(err?.message ?? ""),
      existsSync(lockFile(dir)),
      queued(dir),
      history(dir).length,
    ],
    [false, true, true, true, [], 0],
  );
}
{
  const dir = mkTmp();
  ghost(dir, { token: "T-held" });
  let ctxSeen = null;
  await withHeavySlot(
    {
      label: "child",
      branch: "b",
      dir,
      env: { RF_HEAVY_SLOT_TOKEN: "T-held" },
      maxWaitMs: 40,
      ...FAST,
    },
    async (c) => {
      ctxSeen = c;
    },
  );
  check(
    "I6 re-entrant: a nested acquire carrying the live holder's token runs at once and touches nothing",
    [
      ctxSeen?.reentrant,
      ctxSeen?.token,
      existsSync(lockFile(dir)),
      history(dir).length,
      queued(dir),
    ],
    [true, "T-held", true, 0, []],
  );
  // The same, nested for real: outer holds, inner (given the outer's token) does not wait for it.
  const dir2 = mkTmp();
  let inner = null;
  await withHeavySlot({ label: "outer", branch: "b", dir: dir2, env: {}, ...FAST }, async (o) => {
    await withHeavySlot(
      {
        label: "inner",
        branch: "b",
        dir: dir2,
        env: { RF_HEAVY_SLOT_TOKEN: o.token },
        maxWaitMs: 40,
        ...FAST,
      },
      async (c) => {
        inner = c;
      },
    );
  });
  check(
    "I6b nested for real: inner is re-entrant, only the outer is recorded",
    [inner?.reentrant, history(dir2).map((x) => x.label)],
    [true, ["outer"]],
  );
  // A token whose lock is gone (parent killed) is NOT a free pass.
  const dir3 = mkTmp();
  let ran3 = false;
  await withHeavySlot(
    {
      label: "orphan",
      branch: "b",
      dir: dir3,
      env: { RF_HEAVY_SLOT_TOKEN: "dead-token" },
      ...FAST,
    },
    async (c) => {
      ran3 = !c.reentrant && Boolean(c.token);
    },
  );
  check("I6c an env token with no live lock behind it still takes a real slot", ran3, true);
}
{
  const dir = path.join(mkTmp(), "never-created");
  const logs = [];
  let ctxSeen = null;
  await withHeavySlot(
    { label: "off", branch: "b", dir, env: { RF_HEAVY_SLOT: "off" }, log: (m) => logs.push(m) },
    async (c) => {
      ctxSeen = c;
    },
  );
  check(
    "I7 RF_HEAVY_SLOT=off: runs without a slot, prints one loud WARNING, touches no files",
    [logs.length, /WARNING/.test(logs[0] ?? ""), ctxSeen?.token, existsSync(dir)],
    [1, true, null, false],
  );
  const dir2 = path.join(mkTmp(), "never-created");
  const logs2 = [];
  let ran = false;
  await withHeavySlot(
    {
      label: "ci",
      branch: "b",
      dir: dir2,
      env: { CI: "true", RF_HEAVY_SLOT: "off" },
      log: (m) => logs2.push(m),
    },
    async () => {
      ran = true;
    },
  );
  check(
    "I8 CI: no slot, nothing printed (even next to RF_HEAVY_SLOT=off), no files",
    [ran, logs2, existsSync(dir2)],
    [true, [], false],
  );
}
{
  // FIFO: H holds; W1 then W2 queue; releasing H must run W1 before W2.
  const dir = mkTmp();
  let openGate;
  const gate = new Promise((r) => (openGate = r));
  const opts = (label) => ({ label, branch: "b", dir, env: {}, ...FAST, ...NO_LOG });
  const started = [];
  const H = withHeavySlot(opts("H"), async () => {
    started.push("H");
    await gate;
  });
  await until(() => existsSync(lockFile(dir)));
  const W1 = withHeavySlot(opts("W1"), async () => void started.push("W1"));
  await until(() => queued(dir).length === 1);
  await sleep(5); // distinct enqueue millisecond
  const W2 = withHeavySlot(opts("W2"), async () => void started.push("W2"));
  await until(() => queued(dir).length === 2);
  const statusWhileQueued = formatStatus(dir);
  const midStarted = [...started];
  openGate();
  await Promise.all([H, W1, W2]);
  const h = history(dir);
  check(
    "I9 FIFO: waiters are granted in enqueue order, one at a time, and the records agree",
    [
      midStarted,
      started,
      h.map((x) => x.label),
      Date.parse(h[1].startedAt) >= Date.parse(h[0].endedAt),
      Date.parse(h[2].startedAt) >= Date.parse(h[1].endedAt),
      h[1].waitSec > 0 && h[2].waitSec > 0,
    ],
    [["H"], ["H", "W1", "W2"], ["H", "W1", "W2"], true, true, true],
  );
  check(
    "I10 status shows the holder, the queue positions and (after) the last runs",
    [
      /holder: H on b/.test(statusWhileQueued),
      /queue 1 of 2: W1/.test(statusWhileQueued),
      /queue 2 of 2: W2/.test(statusWhileQueued),
      /W2 on b: waited .* held .* exit 0/.test(formatStatus(dir)),
      /holder: none \(slot free\)/.test(formatStatus(dir)),
    ],
    [true, true, true, true, true],
  );
}
{
  // RF_HEAVY_SLOTS=2: two holders at once, the third waits for the first release.
  const dir = mkTmp();
  const gates = [];
  const gate = () => new Promise((r) => gates.push(r));
  const opts = (label) => ({ label, branch: "b", dir, env: {}, slots: 2, ...FAST, ...NO_LOG });
  const A = withHeavySlot(opts("A"), () => gate());
  await until(() => existsSync(lockFile(dir, 0)));
  const B = withHeavySlot(opts("B"), () => gate());
  await until(() => existsSync(lockFile(dir, 1)));
  let cStarted = false;
  const C = withHeavySlot(opts("C"), async () => void (cStarted = true));
  await until(() => queued(dir).length === 1);
  await sleep(40);
  const blocked = !cStarted;
  gates[0]();
  await C;
  gates[1]();
  await Promise.all([A, B]);
  const h = history(dir);
  const by = Object.fromEntries(h.map((x) => [x.label, x]));
  check(
    "I11 two slots: A and B overlap, C waits behind them and starts only after one of them ended",
    [
      blocked,
      Date.parse(by.B.startedAt) < Date.parse(by.A.endedAt),
      Date.parse(by.C.startedAt) >= Math.min(Date.parse(by.A.endedAt), Date.parse(by.B.endedAt)),
    ],
    [true, true, true],
  );
}
{
  // The holder heartbeats: heartbeatAt moves past startedAt while the job runs.
  const dir = mkTmp();
  let moved = false;
  await withHeavySlot({ label: "hb", branch: "b", dir, env: {}, ...FAST }, async () => {
    const first = JSON.parse(readFileSync(lockFile(dir), "utf8"));
    moved = await until(() => {
      try {
        return JSON.parse(readFileSync(lockFile(dir), "utf8")).heartbeatAt > first.startedAt;
      } catch {
        return false;
      }
    });
  });
  check("I12 the holder's heartbeat advances while it works", moved, true);
}
{
  // N2: a lease whose lock file is deleted warns exactly once, however many heartbeats follow.
  const dir = mkTmp();
  const logs = [];
  await withHeavySlot(
    {
      label: "lost",
      branch: "b",
      dir,
      env: {},
      pollMs: 10,
      heartbeatMs: 15,
      log: (m) => logs.push(m),
    },
    async () => {
      rmSync(lockFile(dir), { force: true });
      await until(() => logs.length > 0);
      await sleep(120); // many more 15 ms heartbeats with the lock still gone
    },
  );
  check(
    "I12b a lease whose lock vanished logs the warning exactly once across many heartbeats",
    [logs.length, /WARNING our slot lock vanished/.test(logs[0] ?? "")],
    [1, true],
  );
}
{
  const dir = mkTmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "history.jsonl"),
    `${Array.from({ length: 600 }, (_, i) => JSON.stringify({ label: `old${i}` })).join("\n")}\n`,
  );
  await withHeavySlot({ label: "newest", branch: "b", dir, env: {}, ...FAST }, async () => {});
  const h = history(dir);
  check(
    "I13 history is capped at 500 lines, newest kept",
    [h.length, h.at(-1).label, h[0].label],
    [500, "newest", "old101"],
  );
}

// ---- C: real child processes (tiny `node` children, temp slot dir) -----------------------------
const childEnv = (dir, extra = {}) => ({
  ...cleanEnv(),
  RF_HEAVY_SLOT_DIR: dir,
  RF_HEAVY_SLOT_POLL_MS: "20",
  RF_HEAVY_SLOT_HEARTBEAT_MS: "200",
  ...extra,
});
const runCli = (dir, label, cmdArgs, extra) => {
  const child = spawn(
    process.execPath,
    [CLI, "run", "--label", label, "--branch", "t", "--", process.execPath, ...cmdArgs],
    { env: childEnv(dir, extra), stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((r) => child.on("close", (code) => r({ code, out })));
  return { child, done };
};
{
  // Serialization through the real CLI. A's job lingers until B's ticket is visible in the queue
  // (deterministic: no sleeping for a fixed time), so B provably had to wait.
  const dir = mkTmp();
  const waitForQueue = `const fs=require("fs"),q=${JSON.stringify(path.join(dir, "queue"))};const end=Date.now()+5000;
const t=setInterval(()=>{let n=[];try{n=fs.readdirSync(q)}catch{}if(n.length||Date.now()>end){clearInterval(t)}},10)`;
  const A = runCli(dir, "A", ["-e", waitForQueue]);
  const gotLock = await until(() => existsSync(lockFile(dir)));
  const B = runCli(dir, "B", ["-e", "process.exit(7)"]);
  const [ra, rb] = await Promise.all([A.done, B.done]);
  const h = history(dir);
  const a = h.find((x) => x.label === "A");
  const b = h.find((x) => x.label === "B");
  console.log(`  info serialization history line A: ${JSON.stringify(a)}`);
  console.log(`  info serialization history line B: ${JSON.stringify(b)}`);
  check(
    "C1 two concurrent `heavy-slot run` children serialize: B.startedAt >= A.endedAt and B.waitSec > 0",
    [
      gotLock,
      ra.code,
      Boolean(a && b) && Date.parse(b.startedAt) >= Date.parse(a.endedAt),
      b?.waitSec > 0,
      /waiting \(position 1 of 1\)/.test(rb.out),
    ],
    [true, 0, true, true, true],
  );
  check(
    "C2 the CLI exits with the child's code, and history records it",
    [rb.code, b?.exit, a?.exit, existsSync(lockFile(dir)), queued(dir)],
    [7, 7, 0, false, []],
  );
}
{
  // The 'exit' path: a job that calls process.exit() mid-hold still releases and records.
  const dir = mkTmp();
  const code = `import(${JSON.stringify(LIB_URL)}).then(m=>m.withHeavySlot({label:"exiter",branch:"t",dir:${JSON.stringify(dir)},env:{},pollMs:10},async()=>{process.exit(3)}))`;
  const r = spawnSync(process.execPath, ["-e", code], { env: cleanEnv(), encoding: "utf8" });
  check(
    "C3 process.exit() inside the job releases the lock and records the exit code",
    [r.status, existsSync(lockFile(dir)), history(dir).map((x) => [x.label, x.exit])],
    [3, false, [["exiter", 3]]],
  );
}
{
  // Fail closed through the CLI entry point (in-process: its real env knobs, no extra node start).
  const dir = mkTmp();
  ghost(dir, {});
  const marker = path.join(dir, "ran.txt");
  const saved = { ...process.env };
  const errs = [];
  const realErr = console.error;
  delete process.env.CI;
  delete process.env.RF_HEAVY_SLOT;
  delete process.env.RF_HEAVY_SLOT_TOKEN;
  Object.assign(process.env, {
    RF_HEAVY_SLOT_DIR: dir,
    RF_HEAVY_SLOT_POLL_MS: "10",
    RF_HEAVY_SLOT_MAX_WAIT_MIN: "0.0005",
  });
  console.error = (m) => errs.push(String(m));
  let code;
  try {
    code = await cliMain([
      "run",
      "--label",
      "blocked",
      "--branch",
      "t",
      "--",
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`,
    ]);
  } finally {
    console.error = realErr;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  check(
    "C4 max wait (RF_HEAVY_SLOT_MAX_WAIT_MIN) fails closed: exit 75, holder named, command never ran",
    [
      code,
      errs.some((m) => m.includes("ghost on feat/ghost")),
      existsSync(marker),
      existsSync(lockFile(dir)),
    ],
    [75, true, false, true],
  );
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`heavy-slot self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
