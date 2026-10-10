// A machine-wide FIFO slot for heavy local jobs (verify, docker image builds, Playwright, DB specs).
//
// WHY (lead ruling 2026-10-10): on a shared dev host 3-4 heavy jobs ran at once, the CPU sat at
// 100% for hours, a ~15 min verify took 2 h+ and tests that pass alone timed out under load. Telling
// lanes to throttle by hand does not hold, so the scripts that start heavy work take this slot
// themselves. Files only, no daemon:
//
//   <dir>/queue/<zero-padded ms>-<pid>-<rand>.json   a waiter's ticket (heartbeat rewritten every 30 s)
//   <dir>/slot-<i>.lock                              the holder (created with the atomic `wx` flag)
//   <dir>/history.jsonl                              one line per finished hold, last 500 kept
//
// A ticket is granted only when it is the OLDEST live ticket AND a slot file can be created.
// An entry is STALE when its pid is dead, its heartbeat is older than STALE_MS, or it was written by
// another host; whoever sees a stale entry removes it. A hard kill therefore frees the slot ~2 min
// later. Nested use (`heavy-slot run -- git push` -> pre-push -> verify) is a no-op through
// RF_HEAVY_SLOT_TOKEN. The wait is capped; on expiry the caller FAILS CLOSED (nothing runs without
// the slot, no test is skipped).
//
// Knobs (env): RF_HEAVY_SLOT_DIR, RF_HEAVY_SLOTS (default 1), RF_HEAVY_SLOT_MAX_WAIT_MIN (default
// 120), RF_HEAVY_SLOT=off (owner/lead escape hatch, loud), CI (no slot, silent). Test-only timing
// knobs: RF_HEAVY_SLOT_POLL_MS, RF_HEAVY_SLOT_HEARTBEAT_MS.
//
// Node's spawnSync blocks the event loop, so the heartbeat could never fire: callers must run the
// guarded work with `spawnAsync` below (or any awaited async spawn).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SLOTS = 1;
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
export const DEFAULT_MAX_WAIT_MIN = 120;
export const POLL_MS = 1_000;
export const WAIT_LOG_MS = 60_000;
export const HISTORY_MAX_LINES = 500;
export const TIMEOUT_EXIT_CODE = 75;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the self-test; no fs, no clock unless passed in)
// ---------------------------------------------------------------------------------------------

/** RF_HEAVY_SLOTS -> a positive integer, else DEFAULT_SLOTS. */
export function parseSlots(raw) {
  const n = Number(raw);
  return typeof raw === "string" && raw.trim() !== "" && Number.isInteger(n) && n > 0
    ? n
    : DEFAULT_SLOTS;
}

/** RF_HEAVY_SLOT_MAX_WAIT_MIN (minutes, fractions allowed) -> ms; unset/invalid -> 120 min. */
export function parseMaxWaitMs(raw) {
  const m = Number(raw);
  const ok = typeof raw === "string" && raw.trim() !== "" && Number.isFinite(m) && m >= 0;
  return (ok ? m : DEFAULT_MAX_WAIT_MIN) * 60_000;
}

/** A positive-number env knob in ms (test-only timing knobs), else the default. */
export function parseMs(raw, fallback) {
  const n = Number(raw);
  return typeof raw === "string" && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveDir(env = process.env, home = os.homedir()) {
  return env.RF_HEAVY_SLOT_DIR || path.join(home, ".routeflow", "heavy-slot");
}

/** `queue/` file name: sorts lexicographically == by enqueue time (ms is zero padded). */
export function ticketName(ms, pid, rand) {
  return `${String(ms).padStart(15, "0")}-${pid}-${rand}.json`;
}

/** Oldest first. Entries are `{ name, ... }`. Does not mutate. */
export function orderTickets(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `process.kill(pid, 0)`: ESRCH = dead, EPERM = alive (just not ours to signal). */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Why an entry is stale, or null when it is live. `entry` is the parsed ticket/lock JSON, or
 * `{ unreadable: true, mtimeMs }` for a file caught mid-write or corrupt (judged on its mtime).
 */
export function staleReason(
  entry,
  { now, hostname, staleMs = STALE_MS, alive = pidAlive } = { now: Date.now() },
) {
  if (!entry) return "missing";
  if (entry.unreadable) return now - entry.mtimeMs > staleMs ? "unreadable" : null;
  if (entry.host !== hostname) return "other-host";
  if (!alive(entry.pid)) return "dead-pid";
  if (!(now - entry.heartbeatAt <= staleMs)) return "heartbeat";
  return null;
}

/** The grant decision for the ticket `myName` given the live, ordered ticket names and free slots. */
export function nextGrant({ order, myName, freeSlots }) {
  const idx = order.indexOf(myName);
  return {
    position: idx + 1, // 0 = my ticket is not in the list
    total: order.length,
    grant: idx === 0 && freeSlots > 0,
  };
}

export function formatWaitLine({ position, total, holder, now }) {
  const held = holder
    ? `held by ${holder.label} on ${holder.branch || "?"}, pid ${holder.pid}, ${(
        Math.max(0, now - (holder.startedAt ?? now)) / 60_000
      ).toFixed(1)} min`
    : "held by (none yet)";
  return `heavy-slot: waiting (position ${position} of ${total}) — ${held}`;
}

/** Keep the last `max` non-empty lines of a history file's text. */
export function trimHistoryText(text, max = HISTORY_MAX_LINES) {
  const lines = text.split("\n").filter(Boolean);
  return lines.length <= max ? null : `${lines.slice(-max).join("\n")}\n`;
}

/** One history record (ISO times; waitSec/heldSec to the millisecond). */
export function historyRecord(lease, endedAt, exit) {
  return {
    label: lease.label,
    branch: lease.branch,
    host: lease.host,
    pid: lease.pid,
    queuedAt: new Date(lease.queuedAt).toISOString(),
    startedAt: new Date(lease.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    waitSec: Math.round(lease.startedAt - lease.queuedAt) / 1000,
    heldSec: Math.round(endedAt - lease.startedAt) / 1000,
    exit,
  };
}

// ---------------------------------------------------------------------------------------------
// Filesystem layer
// ---------------------------------------------------------------------------------------------

const lockPath = (dir, i) => path.join(dir, `slot-${i}.lock`);
const queueDir = (dir) => path.join(dir, "queue");
const historyPath = (dir) => path.join(dir, "history.jsonl");

/** Parsed JSON, `{ unreadable, mtimeMs }` when it won't parse, null when the file is gone. */
function readEntry(file) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { unreadable: true, mtimeMs };
  } catch {
    return { unreadable: true, mtimeMs };
  }
}

const sameEntry = (a, b) =>
  a && b && (a.unreadable || b.unreadable ? a.unreadable === b.unreadable : a.token === b.token);

/** Removes `file` only if it still holds the entry we judged stale (narrows the reap race). */
function reap(file, judged) {
  const again = readEntry(file);
  if (!again) return;
  if (judged.token !== undefined && !sameEntry(judged, again)) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* someone else removed it first */
  }
}

/** Locks and tickets as they are right now, stale ones removed (`reapStale`) or just flagged. */
export function readState(dir, { now, hostname, staleMs = STALE_MS, alive = pidAlive }, reapStale) {
  const ctx = { now, hostname, staleMs, alive };
  const holders = [];
  const tickets = [];
  const stale = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no dir yet */
  }
  for (const n of names) {
    const m = /^slot-(\d+)\.lock$/.exec(n);
    if (!m) continue;
    const file = path.join(dir, n);
    const entry = readEntry(file);
    if (!entry) continue;
    const reason = staleReason(entry, ctx);
    if (reason) {
      stale.push({ kind: "lock", name: n, entry, reason });
      if (reapStale) reap(file, entry);
    } else holders.push({ index: Number(m[1]), name: n, entry });
  }
  try {
    names = fs.readdirSync(queueDir(dir));
  } catch {
    names = [];
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const file = path.join(queueDir(dir), n);
    const entry = readEntry(file);
    if (!entry) continue;
    const reason = staleReason(entry, ctx);
    if (reason) {
      stale.push({ kind: "ticket", name: n, entry, reason });
      if (reapStale) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* gone */
        }
      }
    } else tickets.push({ name: n, entry });
  }
  holders.sort((a, b) => (a.entry.startedAt ?? 0) - (b.entry.startedAt ?? 0));
  return { holders, tickets: orderTickets(tickets), stale };
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj));
}

function readHistoryLines(dir) {
  try {
    return fs.readFileSync(historyPath(dir), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function appendHistory(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(historyPath(dir), `${JSON.stringify(record)}\n`);
    const trimmed = trimHistoryText(fs.readFileSync(historyPath(dir), "utf8"));
    if (trimmed) fs.writeFileSync(historyPath(dir), trimmed);
  } catch {
    /* history is a convenience; never fail the job over it */
  }
}

export class HeavySlotTimeout extends Error {
  constructor(message, holder) {
    super(message);
    this.name = "HeavySlotTimeout";
    this.holder = holder;
  }
}

function describeHolder(holder) {
  return holder
    ? `${holder.label} on ${holder.branch || "?"} (pid ${holder.pid}, host ${holder.host}, cwd ${holder.cwd})`
    : "nobody (slot files not yet free)";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Child tracking (signals are forwarded to the child first)
// ---------------------------------------------------------------------------------------------

const activeChildren = new Set();
let interruptedBy = null;

/** Awaited async spawn with the heartbeat free to run. Resolves `{ status, signal, error }`. */
export function spawnAsync(cmd, args = [], options = {}) {
  return new Promise((resolve) => {
    if (interruptedBy) {
      resolve({ status: interruptedBy === "SIGINT" ? 130 : 143, signal: interruptedBy });
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: "inherit", ...options });
    } catch (error) {
      resolve({ status: null, signal: null, error });
      return;
    }
    activeChildren.add(child);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      activeChildren.delete(child);
      resolve(r);
    };
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (code, signal) => finish({ status: code, signal }));
  });
}

function forwardSignal(sig) {
  for (const child of activeChildren) {
    try {
      if (process.platform === "win32" && child.pid) {
        // child.kill() only ends the shell on Windows; take the child's own tree down.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------------------------

function gitBranch(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

function resolveConfig(opts, env) {
  return {
    dir: opts.dir ?? resolveDir(env),
    slots: opts.slots ?? parseSlots(env.RF_HEAVY_SLOTS),
    maxWaitMs: opts.maxWaitMs ?? parseMaxWaitMs(env.RF_HEAVY_SLOT_MAX_WAIT_MIN),
    pollMs: opts.pollMs ?? parseMs(env.RF_HEAVY_SLOT_POLL_MS, POLL_MS),
    heartbeatMs: opts.heartbeatMs ?? parseMs(env.RF_HEAVY_SLOT_HEARTBEAT_MS, HEARTBEAT_MS),
    waitLogMs: opts.waitLogMs ?? WAIT_LOG_MS,
    staleMs: opts.staleMs ?? STALE_MS,
    hostname: opts.hostname ?? os.hostname(),
    now: opts.now ?? Date.now,
    log: opts.log ?? ((m) => console.error(m)),
    label: opts.label || "job",
    branch: opts.branch ?? gitBranch(process.cwd()),
  };
}

/** A live lock carrying this token, if any (re-entrancy check). */
function tokenHeld(cfg, token) {
  const { holders } = readState(cfg.dir, {
    now: cfg.now(),
    hostname: cfg.hostname,
    staleMs: cfg.staleMs,
  });
  return holders.some((h) => h.entry.token === token);
}

/**
 * Waits for the slot. Resolves a lease `{ token, release(exit), ... }`; throws HeavySlotTimeout when
 * the wait cap passes (ticket removed first), or `Error("heavy-slot: interrupted")` when `state`
 * was aborted by a signal.
 */
async function acquire(cfg, state) {
  fs.mkdirSync(queueDir(cfg.dir), { recursive: true });
  const queuedAt = cfg.now();
  const name = ticketName(queuedAt, process.pid, randomBytes(3).toString("hex"));
  const ticketFile = path.join(queueDir(cfg.dir), name);
  const base = {
    pid: process.pid,
    host: cfg.hostname,
    label: cfg.label,
    branch: cfg.branch,
    cwd: process.cwd(),
    queuedAt,
    heartbeatAt: queuedAt,
  };
  writeJson(ticketFile, base);
  const beat = setInterval(() => {
    try {
      writeJson(ticketFile, { ...base, heartbeatAt: cfg.now() });
    } catch {
      /* next beat */
    }
  }, cfg.heartbeatMs);
  beat.unref?.();
  state.cleanup = () => {
    clearInterval(beat);
    try {
      fs.unlinkSync(ticketFile);
    } catch {
      /* gone */
    }
  };

  let lastLog = -Infinity;
  try {
    for (;;) {
      if (state.aborted)
        throw new Error(`heavy-slot: interrupted by ${state.aborted} while waiting`);
      const now = cfg.now();
      const snap = readState(cfg.dir, { now, hostname: cfg.hostname, staleMs: cfg.staleMs }, true);
      if (!fs.existsSync(ticketFile)) writeJson(ticketFile, { ...base, heartbeatAt: now });
      const taken = new Set(snap.holders.map((h) => h.index));
      let free = -1;
      for (let i = 0; i < cfg.slots; i++) {
        if (!taken.has(i)) {
          free = i;
          break;
        }
      }
      const entries = snap.tickets.map((t) => ({ name: t.name }));
      if (!entries.some((t) => t.name === name)) entries.push({ name }); // just (re)written
      const g = nextGrant({
        order: orderTickets(entries).map((t) => t.name),
        myName: name,
        freeSlots: free < 0 ? 0 : 1,
      });
      if (g.grant) {
        let fd = null;
        try {
          fd = fs.openSync(lockPath(cfg.dir, free), "wx");
        } catch (e) {
          // Windows reports a lock that is mid-delete as EPERM/EACCES/EBUSY, not EEXIST.
          if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
        }
        if (fd !== null) {
          const startedAt = cfg.now();
          const token = randomBytes(8).toString("hex");
          const lock = { ...base, startedAt, heartbeatAt: startedAt, token, slot: free };
          fs.writeSync(fd, JSON.stringify(lock));
          fs.closeSync(fd);
          state.cleanup();
          state.cleanup = null;
          return makeLease(cfg, lock, free);
        }
      }
      if (now - queuedAt >= cfg.maxWaitMs) {
        const holder = snap.holders[0]?.entry;
        throw new HeavySlotTimeout(
          `heavy-slot: gave up after ${(cfg.maxWaitMs / 60_000).toFixed(2)} min waiting for a slot ` +
            `(position ${g.position} of ${g.total}); held by ${describeHolder(holder)}. ` +
            `Nothing was run. Retry later, or check \`node scripts/heavy-slot.mjs status\`.`,
          holder,
        );
      }
      if (now - lastLog >= cfg.waitLogMs) {
        cfg.log(
          formatWaitLine({
            position: g.position,
            total: g.total,
            holder: snap.holders[0]?.entry,
            now,
          }),
        );
        lastLog = now;
      }
      await sleep(cfg.pollMs);
    }
  } catch (e) {
    if (state.cleanup) {
      state.cleanup();
      state.cleanup = null;
    }
    throw e;
  }
}

function makeLease(cfg, lock, index) {
  const file = lockPath(cfg.dir, index);
  const beat = setInterval(() => {
    const cur = readEntry(file);
    if (cur && !cur.unreadable && cur.token === lock.token) {
      try {
        writeJson(file, { ...lock, heartbeatAt: cfg.now() });
      } catch {
        /* next beat */
      }
    } else {
      cfg.log("heavy-slot: WARNING our slot lock vanished or was taken over; continuing unguarded");
    }
  }, cfg.heartbeatMs);
  beat.unref?.();
  let released = false;
  return {
    token: lock.token,
    lock,
    release(exit = 0) {
      if (released) return;
      released = true;
      clearInterval(beat);
      const endedAt = cfg.now();
      const cur = readEntry(file);
      if (cur && !cur.unreadable && cur.token === lock.token) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* gone */
        }
      }
      appendHistory(cfg.dir, historyRecord(lock, endedAt, exit));
    },
  };
}

const NOSLOT = Object.freeze({ token: null, held: false });

/**
 * Runs `fn` while holding the heavy-job slot; always releases. `fn` receives `{ token }`
 * (null when no slot was taken: CI / off / re-entrant). Returns fn's result; a numeric result is
 * recorded as the job's exit code in history.
 *
 * opts: { label, branch?, env?, dir?, slots?, maxWaitMs?, pollMs?, heartbeatMs?, staleMs?, log?, hostname?, now? }
 */
export async function withHeavySlot(opts, fn) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.error(m));
  if (env.CI) return fn(NOSLOT);
  if (env.RF_HEAVY_SLOT === "off") {
    log(
      "heavy-slot: WARNING RF_HEAVY_SLOT=off — running WITHOUT the machine-wide heavy-job slot " +
        "(other heavy jobs on this host may run at the same time)",
    );
    return fn(NOSLOT);
  }
  const cfg = resolveConfig({ ...opts, log }, env);

  const inherited = env.RF_HEAVY_SLOT_TOKEN;
  if (inherited && tokenHeld(cfg, inherited))
    return fn({ token: inherited, held: true, reentrant: true });

  const state = { aborted: null, cleanup: null };
  let lease = null;
  const onExit = (code) => lease?.release(code ?? process.exitCode ?? 0);
  const onSignal = (sig) => {
    interruptedBy = sig;
    state.aborted = sig;
    forwardSignal(sig);
    // Another listener (e.g. a script that must drop a database first) owns the exit decision.
    if (process.listenerCount(sig) > 1) return;
    const deadline = Date.now() + 15_000;
    const t = setInterval(() => {
      if (activeChildren.size && Date.now() < deadline) return;
      clearInterval(t);
      state.cleanup?.();
      lease?.release(sig === "SIGINT" ? 130 : 143);
      process.exit(sig === "SIGINT" ? 130 : 143);
    }, 100);
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("exit", onExit);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const priorToken = process.env.RF_HEAVY_SLOT_TOKEN;
  try {
    lease = await acquire(cfg, state);
    process.env.RF_HEAVY_SLOT_TOKEN = lease.token;
    let result;
    try {
      result = await fn({ token: lease.token, held: true });
    } catch (e) {
      lease.release(1);
      throw e;
    }
    lease.release(typeof result === "number" ? result : 0);
    return result;
  } finally {
    lease?.release(1); // no-op once released; covers an exotic early exit
    if (priorToken === undefined) delete process.env.RF_HEAVY_SLOT_TOKEN;
    else process.env.RF_HEAVY_SLOT_TOKEN = priorToken;
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

const min = (ms) => (ms / 60_000).toFixed(1);

/** Human-readable snapshot (read-only: stale entries are flagged, not removed). */
export function formatStatus(dir, { now = Date.now(), hostname = os.hostname() } = {}) {
  const st = readState(dir, { now, hostname }, false);
  const out = [`heavy-slot dir: ${dir}`];
  if (!st.holders.length) out.push("holder: none (slot free)");
  for (const h of st.holders) {
    const e = h.entry;
    out.push(
      `holder: ${e.label} on ${e.branch || "?"} — pid ${e.pid}, ${min(now - e.startedAt)} min, ` +
        `heartbeat ${Math.round((now - e.heartbeatAt) / 1000)}s ago (${h.name})`,
    );
  }
  if (!st.tickets.length) out.push("queue: empty");
  st.tickets.forEach((t, i) => {
    const e = t.entry;
    out.push(
      `queue ${i + 1} of ${st.tickets.length}: ${e.label} on ${e.branch || "?"} — pid ${e.pid}, waiting ${min(now - e.queuedAt)} min`,
    );
  });
  for (const s of st.stale) {
    out.push(`stale ${s.kind} (${s.reason}): ${s.name} — will be reclaimed by the next waiter`);
  }
  const hist = readHistoryLines(dir).slice(-5);
  out.push(hist.length ? "last runs:" : "last runs: none");
  for (const line of hist) {
    try {
      const r = JSON.parse(line);
      out.push(
        `  ${r.endedAt} ${r.label} on ${r.branch || "?"}: waited ${min(r.waitSec * 1000)} min, held ${min(r.heldSec * 1000)} min, exit ${r.exit}`,
      );
    } catch {
      /* skip a torn line */
    }
  }
  return out.join("\n");
}

export { readHistoryLines };
