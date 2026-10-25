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
  bareNpmReason,
  HISTORY_MAX_LINES,
  HOLD_CAP_EXIT_CODE,
  HeavySlotTimeout,
  STALE_MS,
  activeChildCount,
  spawnAsync,
  formatStatus,
  formatWaitLine,
  historyRecord,
  nextGrant,
  isCappedLabel,
  parseCappedMax,
  inspectSlotsFile,
  readSlotsFile,
  cpuPctFromTimes,
  loadOverReason,
  parseLoadPct,
  parseVmStat,
  sampleMachineLoad,
  orderTickets,
  holderOverCap,
  parseMaxHoldMs,
  parseMaxWaitMs,
  parseSlots,
  pidAlive,
  resolveDir,
  staleReason,
  ticketName,
  trimHistoryText,
  withHeavySlot as realWithHeavySlot,
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

// The owner's load cap reads the real machine; the older cases are about queueing, so they run with the sampler
// stubbed idle (and the child CLIs with the cap disabled). The K cases inject their own sampler.
process.env.RF_HEAVY_SLOT_MAX_CPU_PCT = "100";
process.env.RF_HEAVY_SLOT_MAX_MEM_PCT = "100";
const IDLE = async () => ({ cpuPct: 0, memPct: 0 });
const withHeavySlot = (opts, fn) => realWithHeavySlot({ sampleLoad: IDLE, ...opts }, fn);

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
  "P2 parseMaxWaitMs: default 720 min (12 h backstop); fractions allowed; junk and negatives fall back",
  [undefined, "0.02", "5", "-1", "abc", ""].map(parseMaxWaitMs),
  [43_200_000, 1200, 300_000, 43_200_000, 43_200_000, 43_200_000],
);
check(
  "P2b parseMaxHoldMs: default 90 min; fractions allowed; junk and negatives fall back",
  [undefined, "0.02", "5", "-1", "abc", ""].map(parseMaxHoldMs),
  [5_400_000, 1200, 300_000, 5_400_000, 5_400_000, 5_400_000],
);
check(
  "P2c holderOverCap: strictly longer than the cap; no holder is never over",
  [
    holderOverCap({ startedAt: 1000 }, 1000 + 500, 500),
    holderOverCap({ startedAt: 1000 }, 1000 + 501, 500),
    holderOverCap(undefined, 1e12, 500),
  ],
  [false, true, false],
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
  // A long queue behind a HEALTHY holder keeps waiting past the old 120 min total-wait point: the
  // clock is injected (skewed by 130 min) so the proof is on the slot's own decision, not on time.
  const dir = mkTmp();
  ghost(dir, { startedAt: Date.now() - 60_000 });
  let skew = 0;
  const clock = () => Date.now() + skew;
  let ran = false;
  let err = null;
  const waiter = withHeavySlot(
    // default caps from env {}: 720 min total wait, 90 min hold (+5 min grace). staleMs huge: the
    // ghost has no heartbeat timer, and the skew would otherwise make it look dead.
    { label: "patient", branch: "b", dir, env: {}, now: clock, staleMs: 1e12, ...FAST, ...NO_LOG },
    async () => {
      ran = true;
    },
  ).catch((e) => {
    err = e;
  });
  await sleep(60);
  skew = 60 * 60_000; // the holder is at ~61 min, under the 90 min hold cap
  await sleep(100);
  const stillWaiting =
    !ran && err === null && existsSync(lockFile(dir)) && queued(dir).length === 1;
  rmSync(lockFile(dir), { force: true }); // the healthy holder finishes
  await waiter;
  check(
    "I5b a healthy holder under the hold cap: the waiter is still queued 60 min in, then gets the slot",
    [stillWaiting, ran, err],
    [true, true, null],
  );
}
{
  // A holder past the hold cap that is still heartbeating (wedged but alive) makes the waiter fail
  // closed, naming the holder and its hold age; the holder's lock is left alone.
  const dir = mkTmp();
  ghost(dir, { startedAt: Date.now() - 200 * 60_000 });
  let ran = false;
  let err = null;
  try {
    await withHeavySlot(
      { label: "impatient", branch: "b", dir, env: {}, ...FAST, ...NO_LOG },
      async () => {
        ran = true;
      },
    );
  } catch (e) {
    err = e;
  }
  check(
    "I5c a holder over the hold cap and its grace (200 min > 95) fails the waiter closed: names the holder and its " +
      "hold age, never runs fn, keeps the holder's lock, withdraws the ticket",
    [
      ran,
      err instanceof HeavySlotTimeout,
      (err?.message ?? "").includes("held by ghost on feat/ghost"),
      /for 200\.\d min, over the 90\.00 min hold cap/.test(err?.message ?? ""),
      existsSync(lockFile(dir)),
      queued(dir),
    ],
    [false, true, true, true, true, []],
  );
  check(
    "I5d status flags a holder over the hold cap, and only that one",
    [
      formatStatus(dir).includes("OVER HOLD CAP"),
      formatStatus(dir, { maxHoldMs: 300 * 60_000 }).includes("OVER HOLD CAP"),
    ],
    [true, false],
  );
  // The env knob reaches the decision: a 1 s old holder is over a 0.0005 min (30 ms) cap.
  const dir2 = mkTmp();
  ghost(dir2, { startedAt: Date.now() - 1000 });
  let err2 = null;
  try {
    await withHeavySlot(
      {
        label: "knob",
        branch: "b",
        dir: dir2,
        env: { RF_HEAVY_SLOT_MAX_HOLD_MIN: "0.0005" },
        holdGraceMs: 0, // no grace: the knob alone decides
        ...FAST,
        ...NO_LOG,
      },
      async () => {},
    );
  } catch (e) {
    err2 = e;
  }
  check(
    "I5e RF_HEAVY_SLOT_MAX_HOLD_MIN is honoured",
    err2 instanceof HeavySlotTimeout && /hold cap/.test(err2.message),
    true,
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
    RF_HEAVY_SLOTS: "1", // the host may export 2; the ghost holds the only slot here
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

{
  // W-679: a bare `npm ci` (or any alias of it) runs lifecycle scripts (husky `prepare`) that
  // rewrite core.hooksPath; the guard refuses it and lets `--ignore-scripts` through.
  // Pure-function cases first (injected argv/env), then the CLI against a stub that is a node script.
  const refused = (cmd, args, env = {}) => bareNpmReason(cmd, args, env) !== null;
  const verbs = [
    ...[
      "ci",
      "clean-install",
      "ic",
      "install-clean",
      "isntall-clean",
      "cit",
      "it",
      "install-ci-test",
    ],
    ...["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal"],
    ...["isntall", "install-test", "clean-install-test", "sit"],
  ];
  check(
    "W1 every npm install/ci alias is refused (npm 11 cmd-list.js + npm help install/ci)",
    verbs.filter((v) => !refused("npm", [v])),
    [],
  );
  check(
    "W2 verb is found after npm global options (value-taking options consume the next arg)",
    [
      refused("npm", ["--prefix", "apps/api", "ci"]),
      refused("npm", ["-w", "apps/web", "install"]),
      refused("npm", ["--workspace", "web", "--loglevel", "error", "isntall"]),
      refused("npm", ["-C", "x", "-s", "-d", "i"]),
      refused("npm", ["--prefix=apps/api", "--silent", "ic"]),
      refused("npm.cmd", ["--loglevel=warn", "ci"]),
    ],
    [true, true, true, true, true, true],
  );
  check(
    "W3 non-install npm verbs and a value that merely looks like a verb are allowed",
    [
      refused("npm", ["run", "lint"]),
      refused("npm", ["--prefix", "ci", "run", "build"]),
      refused("npm", ["-w", "install", "test"]),
      refused("npm", []),
      refused("node", ["ci"]),
    ],
    [false, false, false, false, false],
  );
  check(
    "W4 a single shell-string argument is parsed and refused",
    [
      refused("npm ci", []),
      refused("npm --prefix x install", []),
      refused("sh", ["-c", "npm ci"]),
      refused("bash", ["-lc", "cd x && npm i"]),
      refused("cmd", ["/c", "npm ci"]),
      refused("sh", ["-c", "echo hi"]),
      refused("sh", ["-c", "npm ci --ignore-scripts"]),
    ],
    [true, true, true, true, true, false, false],
  );
  check(
    "W5 --ignore-scripts / =true / env true allow; =false, --no-ignore-scripts, env false do not",
    [
      refused("npm", ["ci", "--ignore-scripts"]),
      refused("npm", ["ci", "--ignore-scripts=true"]),
      refused("npm", ["ci"], { npm_config_ignore_scripts: "true" }),
      refused("npm", ["ci"], { NPM_CONFIG_IGNORE_SCRIPTS: "true" }),
      refused("npm", ["ci", "--ignore-scripts=false"]),
      refused("npm", ["ci", "--no-ignore-scripts"]),
      refused("npm", ["ci"], { npm_config_ignore_scripts: "false" }),
      refused("npm", ["ci"], { NPM_CONFIG_IGNORE_SCRIPTS: "false" }),
      refused("npm", ["ci", "--ignore-scripts", "--ignore-scripts=false"]),
    ],
    [false, false, false, false, true, true, true, true, true],
  );

  // CLI: the stub `npm` is a node script (stub.mjs) reached through a sh shim (unix) / .cmd twin
  // (win32). PATH is ONLY the stub dir, so no real npm can be found, and the CLI runs in a temp cwd;
  // the test also asserts no node_modules appeared there and that the marker came from the stub.
  const bin = mkTmp();
  const work = mkTmp();
  const marker = path.join(bin, "npm-ran.txt");
  const stubJs = path.join(bin, "stub.mjs");
  writeFileSync(
    stubJs,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(path.join(bin, "npm.cmd"), `@"${process.execPath}" "${stubJs}" %*\r\n`);
  const runNpm = (...args) => {
    const dir = mkTmp();
    const r = spawnSync(
      process.execPath,
      [CLI, "run", "--label", "w679", "--branch", "t", "--", "npm", ...args],
      {
        cwd: work,
        env: { ...cleanEnv(), RF_HEAVY_SLOT_DIR: dir, PATH: bin },
        encoding: "utf8",
      },
    );
    const ran = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
    rmSync(marker, { force: true });
    return [r.status, ran, /--ignore-scripts/.test(r.stderr)];
  };
  check(
    "W6 CLI: bare `npm ci` / aliased forms refused: exit 2, stub never ran, message names --ignore-scripts",
    [runNpm("ci"), runNpm("--prefix", "x", "isntall")],
    [
      [2, null, true],
      [2, null, true],
    ],
  );
  check(
    "W7 CLI: `npm ci --ignore-scripts` runs the stub (marker written by the stub)",
    runNpm("ci", "--ignore-scripts"),
    [0, "ci --ignore-scripts", false],
  );
  check("W8 CLI: other npm commands run the stub", runNpm("run", "lint"), [0, "run lint", false]);
  check(
    "W9 nothing reached a real npm: temp cwd has no node_modules / package-lock",
    readdirSync(work),
    [],
  );
}

// ---- J: W-759 the holder enforces its own hold cap ----------------------------------------------
{
  // J1: a live, heartbeating holder whose job hangs is ended at the cap (its OWN child tree), the slot is released and the run
  // is recorded as capped (exit 76, capped: true). Without the cap this child would sleep 60 s.
  const dir = mkTmp();
  let childResult = null;
  let during = -1;
  const out = await withHeavySlot(
    { label: "hung", branch: "b", dir, env: {}, maxHoldMs: 400, ...FAST, ...NO_LOG },
    async () => {
      const p = spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
      during = activeChildCount();
      childResult = await p;
      return childResult.status;
    },
  );
  const h = history(dir);
  check(
    "J1 a holder that hangs past the cap is ended: HOLD_CAP_EXIT_CODE, lock released, history exit 76 and capped",
    [out, existsSync(lockFile(dir)), h.length, h[0]?.exit, h[0]?.capped],
    [HOLD_CAP_EXIT_CODE, false, 1, HOLD_CAP_EXIT_CODE, true],
  );
  check(
    "J1b the guarded child was tracked while it ran, was terminated (not a normal exit), and leaves no tracked child behind",
    [during, childResult?.status === 0, activeChildCount()],
    [1, false, 0],
  );

  // J2: a job that finishes inside the cap is untouched: its own exit code, no capped marker
  const dir2 = mkTmp();
  const ok = await withHeavySlot(
    { label: "fine", branch: "b", dir: dir2, env: {}, maxHoldMs: 60_000, ...FAST, ...NO_LOG },
    async () => (await spawnAsync(process.execPath, ["-e", "0"])).status,
  );
  check(
    "J2 a job inside the cap keeps its own exit code and is not marked capped",
    [ok, history(dir2)[0]?.exit, history(dir2)[0]?.capped],
    [0, 0, undefined],
  );

  // J3 (a): a QUEUED waiter runs once the capped holder releases. Waiters give up only at cap + grace, so this one is not
  // failed at the very moment the slot frees (the #3688 review's probe p3: both waiters threw and nobody got the slot).
  const dir3 = mkTmp();
  let waiterRan = false;
  let waiterErr = null;
  const holder = withHeavySlot(
    {
      label: "capped",
      branch: "b",
      dir: dir3,
      env: {},
      maxHoldMs: 400,
      holdKillMs: 300,
      ...FAST,
      ...NO_LOG,
    },
    async () => (await spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"])).status,
  );
  await sleep(100); // the holder has the slot
  const waiter = withHeavySlot(
    { label: "queued", branch: "b", dir: dir3, env: {}, maxHoldMs: 400, ...FAST, ...NO_LOG },
    async () => {
      waiterRan = true;
    },
  ).catch((e) => {
    waiterErr = e;
  });
  const holderOut = await holder;
  await waiter;
  check(
    "J3 a queued waiter gets the slot after the holder is capped: it runs, never times out",
    [holderOut, waiterRan, waiterErr],
    [HOLD_CAP_EXIT_CODE, true, null],
  );

  // J4 (c): a job that never returns (it ignores the killed child) still loses the slot at the hard deadline
  const dir4 = mkTmp();
  const hung = await withHeavySlot(
    {
      label: "stuck",
      branch: "b",
      dir: dir4,
      env: {},
      maxHoldMs: 150,
      holdKillMs: 150,
      ...FAST,
      ...NO_LOG,
    },
    () => new Promise(() => {}),
  );
  check(
    "J4 a job that never returns is released at the hard deadline: capped history, lock gone",
    [hung, existsSync(lockFile(dir4)), history(dir4)[0]?.capped],
    [HOLD_CAP_EXIT_CODE, false, true],
  );
}

// K: owner cap (10-25): the slot also waits while the machine's CPU or memory is above a threshold.
// Every case injects the sampler (cfg.sampleLoad); none reads the real machine.
check(
  "K1 parseLoadPct: unset/invalid/out of range -> 80; a valid percent is kept",
  [
    parseLoadPct(undefined),
    parseLoadPct(""),
    parseLoadPct("abc"),
    parseLoadPct("0"),
    parseLoadPct("-5"),
    parseLoadPct("101"),
    parseLoadPct("70"),
    parseLoadPct("92.5"),
    parseLoadPct("100"),
  ],
  [80, 80, 80, 80, 80, 80, 70, 92.5, 100],
);
check(
  "K2 loadOverReason: names the metric above its limit; at the limit is fine",
  [
    loadOverReason({ cpuPct: 80, memPct: 80 }, { maxCpuPct: 80, maxMemPct: 80 }),
    loadOverReason({ cpuPct: 81, memPct: 10 }, { maxCpuPct: 80, maxMemPct: 80 }),
    loadOverReason({ cpuPct: 10, memPct: 85.4 }, { maxCpuPct: 80, maxMemPct: 80 }),
    loadOverReason({ cpuPct: 99, memPct: 99 }, { maxCpuPct: 100, maxMemPct: 100 }),
  ],
  [null, "cpu 81% > 80%", "memory 85% > 80%", null],
);
check(
  "K3 cpuPctFromTimes: busy share of the total tick delta, across cores; no delta -> 0",
  [
    cpuPctFromTimes(
      [
        { idle: 100, total: 200 },
        { idle: 100, total: 200 },
      ],
      [
        { idle: 150, total: 300 },
        { idle: 100, total: 300 },
      ],
    ),
    cpuPctFromTimes([{ idle: 5, total: 10 }], [{ idle: 5, total: 10 }]),
  ],
  [75, 0],
);
{
  const cpus = (idle, total) => [{ times: { idle, user: total - idle, nice: 0, sys: 0, irq: 0 } }];
  const snaps = [cpus(0, 100), cpus(50, 200)]; // 50 idle of 100 ticks -> 50% busy
  let i = 0;
  const waited = [];
  const r = await sampleMachineLoad({
    cpus: () => snaps[i++],
    freemem: () => 25,
    totalmem: () => 100,
    sleep: async (ms) => waited.push(ms),
    sampleMs: 3000,
    platform: "linux", // the host's own platform would pick the macOS vm_stat path on a Mac
  });
  check(
    "K4 sampleMachineLoad: CPU over the sample window, memory used share, injected clock",
    [r, waited],
    [{ cpuPct: 50, memPct: 75 }, [3000]],
  );
}
{
  // K5: over the cap -> no grant even with a free slot; under it -> runs; ONE wait line while it waits
  const dir = mkTmp();
  const readings = [
    { cpuPct: 95, memPct: 40 },
    { cpuPct: 90, memPct: 40 },
    { cpuPct: 30, memPct: 40 },
  ];
  let n = 0;
  const lines = [];
  let ranAfter = -1;
  const out = await withHeavySlot(
    {
      label: "capped",
      branch: "b",
      dir,
      env: {},
      ...FAST,
      waitLogMs: 1e9,
      log: (m) => lines.push(m),
      sampleLoad: async () => readings[Math.min(n++, readings.length - 1)],
    },
    async () => {
      ranAfter = n;
      return 7;
    },
  );
  check(
    "K5 over the cap it waits (one wait line), under it runs and the result passes through",
    [
      out,
      ranAfter,
      lines.length,
      /cpu 95% > 80%/.test(lines[0] ?? ""),
      /load|machine/i.test(lines[0] ?? ""),
    ],
    [7, 3, 1, true, true],
  );
}
{
  // K6: sustained overload ends by the existing max wait: HeavySlotTimeout, nothing run, ticket gone
  const dir = mkTmp();
  let ran = false;
  let err = null;
  await withHeavySlot(
    {
      label: "hot",
      branch: "b",
      dir,
      env: {},
      ...FAST,
      maxWaitMs: 150,
      ...NO_LOG,
      sampleLoad: async () => ({ cpuPct: 99, memPct: 99 }),
    },
    async () => {
      ran = true;
    },
  ).catch((e) => {
    err = e;
  });
  check(
    "K6 sustained overload hits the max wait: HeavySlotTimeout, fn never ran, no ticket or lock left",
    [err instanceof HeavySlotTimeout, ran, queued(dir).length, existsSync(lockFile(dir))],
    [true, false, 0, false],
  );
}
{
  // K7: a sampler that throws must not wedge the slot (fail open: the owner cap is a guard, not a gate on correctness)
  const dir = mkTmp();
  let ran = false;
  await withHeavySlot(
    {
      label: "blind",
      branch: "b",
      dir,
      env: {},
      ...FAST,
      ...NO_LOG,
      sampleLoad: async () => {
        throw new Error("no counters");
      },
    },
    async () => {
      ran = true;
    },
  );
  check("K7 a sampler that throws fails open: the job runs", ran, true);
}
{
  // K8: env knobs reach the decision; a holder waiting behind another job is not sampled until it is first in line
  const dir = mkTmp();
  let calls = 0;
  let ran = false;
  await withHeavySlot(
    {
      label: "env",
      branch: "b",
      dir,
      env: { RF_HEAVY_SLOT_MAX_CPU_PCT: "95", RF_HEAVY_SLOT_MAX_MEM_PCT: "90" },
      ...FAST,
      ...NO_LOG,
      sampleLoad: async () => {
        calls++;
        return { cpuPct: 92, memPct: 89 };
      },
    },
    async () => {
      ran = true;
    },
  );
  check(
    "K8 RF_HEAVY_SLOT_MAX_CPU_PCT / _MEM_PCT raise the limits: 92% cpu / 89% mem passes at 95 / 90",
    [ran, calls],
    [true, 1],
  );
  const dirQ = mkTmp();
  ghost(dirQ, { startedAt: Date.now() - 1000 });
  let sampledWhileBlocked = 0;
  const w = withHeavySlot(
    {
      label: "queued",
      branch: "b",
      dir: dirQ,
      env: {},
      ...FAST,
      ...NO_LOG,
      sampleLoad: async () => {
        sampledWhileBlocked++;
        return { cpuPct: 1, memPct: 1 };
      },
    },
    async () => {},
  );
  await sleep(80);
  const whileBlocked = sampledWhileBlocked;
  rmSync(lockFile(dirQ), { force: true });
  await w;
  check(
    "K9 no sample is taken while the slot is held by someone else (sampling costs ~3 s)",
    [whileBlocked, sampledWhileBlocked >= 1],
    [0, true],
  );
}

// K10-K14: hardening after review A on the load wait (darwin memory, a hung sampler, the clock read order).
const VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 10 bytes)",
  "Pages free:                               10.",
  "Pages active:                            500.",
  "Pages inactive:                           40.",
  "Pages speculative:                        10.",
  "Pages wired down:                        100.",
].join("\n");
check(
  "K10 parseVmStat: (free + inactive + speculative) pages x page size; unparseable -> null",
  [parseVmStat(VM_STAT), parseVmStat("nonsense"), parseVmStat(""), parseVmStat(undefined)],
  [600, null, null, null],
);
{
  const cpus = (idle, total) => [{ times: { idle, user: total - idle, nice: 0, sys: 0, irq: 0 } }];
  const mk = (over) => {
    let i = 0;
    const snaps = [cpus(0, 100), cpus(100, 200)];
    return { cpus: () => snaps[i++], totalmem: () => 1000, sleep: async () => {}, ...over };
  };
  const mac = await sampleMachineLoad(
    mk({ platform: "darwin", freemem: () => 100, vmStat: () => VM_STAT }),
  );
  const linux = await sampleMachineLoad(
    mk({ platform: "linux", freemem: () => 100, vmStat: () => VM_STAT }),
  );
  const macBroken = await sampleMachineLoad(
    mk({
      platform: "darwin",
      freemem: () => 100,
      vmStat: () => {
        throw new Error("no vm_stat");
      },
    }),
  );
  check(
    "K11 darwin counts reclaimable pages (60% free -> 40% used); other hosts keep os.freemem; a vm_stat failure falls back to it",
    [mac.memPct, linux.memPct, macBroken.memPct],
    [40, 90, 90],
  );
}
{
  // K12: a sampler that never answers must not wedge the slot: the race times out and the wait fails open
  const dir = mkTmp();
  let ran = false;
  await withHeavySlot(
    {
      label: "hung-sampler",
      branch: "b",
      dir,
      env: {},
      ...FAST,
      ...NO_LOG,
      sampleTimeoutMs: 60,
      sampleLoad: () => new Promise(() => {}),
    },
    async () => {
      ran = true;
    },
  );
  check("K12 a sampler that never resolves times out and fails open: the job runs", ran, true);
}
{
  // K13: the clock is read AFTER the ~3 s sample, so the max-wait check sees the time the sample took
  const dir = mkTmp();
  let t = 1_000_000;
  let calls = 0;
  let err = null;
  await withHeavySlot(
    {
      label: "late-clock",
      branch: "b",
      dir,
      env: {},
      ...FAST,
      ...NO_LOG,
      now: () => t,
      staleMs: 1e12,
      maxWaitMs: 300,
      sampleLoad: async () => {
        calls++;
        t += 400;
        return { cpuPct: 99, memPct: 99 };
      },
    },
    async () => {},
  ).catch((e) => {
    err = e;
  });
  check(
    "K13 max wait is judged on the clock after the sample: one sample, then HeavySlotTimeout",
    [err instanceof HeavySlotTimeout, calls],
    [true, 1],
  );
}

{
  // L1-L4: a machine-wide <dir>/slots file overrides every waiter's own RF_HEAVY_SLOTS, re-read each poll.
  const dir = mkTmp();
  const f = path.join(dir, "slots");
  writeFileSync(f, "4");
  const a = readSlotsFile(dir);
  writeFileSync(f, "abc");
  const b = readSlotsFile(dir);
  writeFileSync(f, "0");
  const c = readSlotsFile(dir);
  rmSync(f);
  check(
    "L1 readSlotsFile: a positive integer is read, junk / zero / no file is null",
    [a, b, c, readSlotsFile(dir)],
    [4, null, null, null],
  );
}
{
  // A slots=2 waiter at the head, both slots held, file says 4 -> it takes slot 2 (no file: it blocks).
  const dir = mkTmp();
  const gates = [];
  const gate = () => new Promise((r) => gates.push(r));
  const opts = (label) => ({ label, branch: "b", dir, env: {}, slots: 2, ...FAST, ...NO_LOG });
  const A = withHeavySlot(opts("A"), () => gate());
  await until(() => existsSync(lockFile(dir, 0)));
  const B = withHeavySlot(opts("B"), () => gate());
  await until(() => existsSync(lockFile(dir, 1)));
  let wStarted = false;
  const W = withHeavySlot(opts("W"), async () => void (wStarted = true));
  await until(() => queued(dir).length === 1);
  await sleep(60);
  const blockedWithoutFile = !wStarted;
  writeFileSync(path.join(dir, "slots"), "4");
  const wRan = await until(() => wStarted, 5000); // fail, never hang, if the file is not honoured
  if (!wRan) gates.forEach((g) => g());
  await Promise.race([W.catch(() => {}), sleep(5000)]);
  check(
    "L2 a slots=2 waiter at the head blocks with both slots held, and takes slot 2 once the file says 4",
    [blockedWithoutFile, wStarted, existsSync(lockFile(dir, 0)), existsSync(lockFile(dir, 1))],
    [true, true, true, true],
  );
  gates[0]();
  gates[1]();
  await Promise.all([A, B]);
}
{
  // A junk file changes nothing: the waiter keeps its env/opts slot count.
  const dir = mkTmp();
  writeFileSync(path.join(dir, "slots"), "lots");
  const gates = [];
  const gate = () => new Promise((r) => gates.push(r));
  const opts = (label) => ({ label, branch: "b", dir, env: {}, slots: 1, ...FAST, ...NO_LOG });
  const A = withHeavySlot(opts("A"), () => gate());
  await until(() => existsSync(lockFile(dir, 0)));
  let bStarted = false;
  const B = withHeavySlot(opts("B"), async () => void (bStarted = true));
  await until(() => queued(dir).length === 1);
  await sleep(60);
  const blocked = !bStarted;
  gates[0]();
  await Promise.all([A, B]);
  check(
    "L3 a junk slots file is ignored: slots=1 still serialises",
    [blocked, bStarted],
    [true, true],
  );
}
{
  // L4: status prints the slots file (value, invalid, none); a waiter logs an invalid file once and keeps its own count.
  const dir = mkTmp();
  const none = formatStatus(dir);
  writeFileSync(path.join(dir, "slots"), "3");
  const ok = formatStatus(dir);
  writeFileSync(path.join(dir, "slots"), "99");
  const bad = formatStatus(dir);
  const lines = [];
  await withHeavySlot(
    { label: "w", branch: "b", dir, env: {}, slots: 1, ...FAST, log: (l) => lines.push(l) },
    async () => {},
  );
  check(
    "L4 status shows the slots file, and an invalid one is ignored with ONE warning",
    [
      /slots file: none/.test(none),
      ok.includes(" = 3 (overrides"),
      bad.includes("INVALID (99 is outside 1..16)"),
      lines.filter((l) => /ignoring .*slots/.test(l)).length,
    ],
    [true, true, true, 1],
  );
}
{
  // L5: a malformed slots file never throws out of the reader (it would reject every waiter and status).
  const dir = mkTmp();
  const f = path.join(dir, "slots");
  const bytes = Buffer.from([0xfe, 0xff, 0x00, 0x34, 0x0a]); // UTF-16 BE BOM + odd-length body
  writeFileSync(f, bytes);
  let threw = null;
  let r = null;
  try {
    r = inspectSlotsFile(dir);
  } catch (e) {
    threw = e.message;
  }
  check("L5 odd-length UTF-16 BE is invalid, not a throw", [threw, r?.state], [null, "invalid"]);
  let thrown = 0;
  let rng = 12345;
  const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) >>> 8; // high bits: the low bits of this LCG cycle
  const heads = [[], [0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff]];
  const names = ["none", "utf8-bom", "utf16le-bom", "utf16be-bom"];
  const seen = { none: 0, "utf8-bom": 0, "utf16le-bom": 0, "utf16be-bom": 0 };
  const oddBody = { "utf16le-bom": 0, "utf16be-bom": 0 };
  for (let i = 0; i < 400; i++) {
    const cls = i % 4; // each BOM class by construction, never left to the generator
    const body = Array.from({ length: rnd() % 9 }, () => rnd() & 0xff);
    seen[names[cls]]++;
    if (cls >= 2 && body.length % 2 === 1) oddBody[names[cls]]++;
    writeFileSync(f, Buffer.from([...heads[cls], ...body]));
    try {
      inspectSlotsFile(dir);
      readSlotsFile(dir);
      formatStatus(dir);
    } catch {
      thrown++;
    }
  }
  check("L5b fuzz: 400 files of 0-8 random bytes under each BOM class never throw", thrown, 0);
  check(
    "L5c the fuzz exercised every BOM class, and odd-length UTF-16 bodies in both byte orders",
    [Object.values(seen).every((n) => n > 0), Object.values(oddBody).every((n) => n > 0)],
    [true, true],
  );
}

{
  // M1-M3: a verify / pre-push job takes at most RF_HEAVY_SLOT_CAPPED_MAX (default 2) of the slots.
  check(
    "M1 isCappedLabel: verify and pre-push labels are capped, everything else is not",
    [
      "verify",
      "wt-verify-3",
      "pre-push",
      "prepush-3801",
      "VERIFY",
      "wt-db-3801",
      "jest",
      "",
      undefined,
    ].map(isCappedLabel),
    [true, true, true, true, true, false, false, false, false],
  );
  check(
    "M2 parseCappedMax: a positive integer, else the default 2",
    [
      parseCappedMax("3"),
      parseCappedMax(undefined),
      parseCappedMax("0"),
      parseCappedMax("x"),
      parseCappedMax("-1"),
    ],
    [3, 2, 2, 2, 2],
  );
  const capped = new Set(["a"]);
  check(
    "M3 nextGrant: a capped head at its cap is skipped, the next uncapped ticket is granted; under the cap it is first again",
    [
      nextGrant({
        order: ["a", "b"],
        myName: "b",
        freeSlots: 1,
        capped,
        cappedHeld: 2,
        cappedMax: 2,
      }),
      nextGrant({
        order: ["a", "b"],
        myName: "a",
        freeSlots: 1,
        capped,
        cappedHeld: 2,
        cappedMax: 2,
      }),
      nextGrant({
        order: ["a", "b"],
        myName: "a",
        freeSlots: 1,
        capped,
        cappedHeld: 1,
        cappedMax: 2,
      }),
      nextGrant({
        order: ["a", "b"],
        myName: "b",
        freeSlots: 1,
        capped,
        cappedHeld: 1,
        cappedMax: 2,
      }),
      nextGrant({
        order: ["a", "c", "b"],
        myName: "c",
        freeSlots: 1,
        capped: new Set(["a", "c"]),
        cappedHeld: 2,
        cappedMax: 2,
      }),
    ].map((g) => g.grant),
    [true, false, true, false, false],
  );
}
{
  // M4: 3 slots, two verify holders; a third verify queues FIRST, a db job behind it. The db job must not wait on
  // the capped verify (no head-of-line block); the verify takes the free slot only after a verify releases.
  const dir = mkTmp();
  const gates = [];
  const gate = () => new Promise((r) => gates.push(r));
  const opts = (label) => ({ label, branch: "b", dir, env: {}, slots: 3, ...FAST, ...NO_LOG });
  const V1 = withHeavySlot(opts("wt-verify-1"), () => gate());
  await until(() => existsSync(lockFile(dir, 0)));
  const V2 = withHeavySlot(opts("wt-verify-2"), () => gate());
  await until(() => existsSync(lockFile(dir, 1)));
  let v3Started = false;
  let dbStarted = false;
  const V3 = withHeavySlot(opts("wt-verify-3"), async () => void (v3Started = true));
  await until(() => queued(dir).length === 1);
  const DB = withHeavySlot(opts("wt-db-1"), async () => void (dbStarted = true));
  const dbRan = await until(() => dbStarted, 5000);
  await sleep(60);
  const v3WaitedWhileDbRan = dbRan && !v3Started;
  gates[0]();
  const v3Ran = await until(() => v3Started, 5000);
  if (!v3Ran) gates[1]();
  await Promise.race([V3.catch(() => {}), sleep(5000)]);
  check(
    "M4 a capped head at its cap does not block an uncapped job behind it, and runs once a capped holder releases",
    [dbRan, v3WaitedWhileDbRan, v3Ran],
    [true, true, true],
  );
  gates[1]();
  await Promise.all([V1, V2, DB, V3]);
}

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
console.log(`heavy-slot self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
