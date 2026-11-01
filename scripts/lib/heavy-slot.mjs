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
// RF_HEAVY_SLOT_TOKEN. A waiter FAILS CLOSED (nothing runs without the slot, no test is skipped) in
// two cases: the current holder has held the slot past MAX_HOLD while still heartbeating (wedged but
// alive), or the total wait passed the long MAX_WAIT backstop. A queue of several healthy jobs is
// NOT a reason to give up.
//
// Knobs (env): RF_HEAVY_SLOT_DIR, RF_HEAVY_SLOTS (default 1), RF_HEAVY_SLOT_MAX_WAIT_MIN (default
// 720), RF_HEAVY_SLOT_MAX_HOLD_MIN (default 90; the HOLDER enforces it too, W-759: at the cap it ends its own job's
// process tree and releases the slot with exit 76 and `capped: true` in history; waiters give up only HOLD_GRACE after the cap, so a
// queued job gets the slot the holder just freed), RF_HEAVY_SLOT=off (owner/lead escape hatch, loud), CI (no slot, silent). Test-only timing
// knobs: RF_HEAVY_SLOT_POLL_MS, RF_HEAVY_SLOT_HEARTBEAT_MS.
//
// Node's spawnSync blocks the event loop, so the heartbeat could never fire: callers must run the
// guarded work with `spawnAsync` below (or any awaited async spawn).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SLOTS = 1;
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
export const DEFAULT_MAX_WAIT_MIN = 720;
export const DEFAULT_MAX_HOLD_MIN = 90;
export const HOLD_GRACE_MS = 5 * 60_000; // waiters give up at cap + this, never at the cap itself
export const HOLD_KILL_MS = 15_000; // after the cap's SIGTERM the holder releases the slot regardless of fn
export const HOLD_CAP_EXIT_CODE = 76; // the job was ended at the hold cap
export const POLL_MS = 1_000;
export const WAIT_LOG_MS = 60_000;
export const HISTORY_MAX_LINES = 500;
export const TIMEOUT_EXIT_CODE = 75;
/**
 * Version of the grant rule (who is first in line) a waiter applies. Every ticket records it; bump it when nextGrant
 * changes what a waiter does, so a fresh waiter can tell a ticket whose waiter follows an older rule (or none: tickets
 * written before this field) and not queue behind it. See ticketStale / formatStatus.
 */
export const GRANT_RULE = 1;

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

/** Largest slot count the machine-wide slots file may set; a bigger number is a typo, not a plan. */
export const MAX_SLOTS_FILE = 16;

/**
 * Decode a slots file's bytes: UTF-8 (BOM allowed) or UTF-16 LE/BE with a BOM (PowerShell 5.1 `echo 4 > slots`).
 * Returns null for a UTF-16 body with an odd byte count (a torn or foreign file), never throws on its own.
 */
function decodeSlotsBytes(buf) {
  const le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const be = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
  if (le || be) {
    const body = buf.subarray(2);
    if (body.length % 2 !== 0) return null;
    return le ? body.toString("utf16le") : Buffer.from(body).swap16().toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString("utf8");
  return buf.toString("utf8");
}

/**
 * The machine-wide slot count file `<dir>/slots`: { state: "absent" } | { state: "ok", value } |
 * { state: "invalid", reason }. A plain decimal integer 1..MAX_SLOTS_FILE, in UTF-8 or BOM'd UTF-16;
 * anything else (0, 17, 0x10, 4.5, words, a BOM-less UTF-16 file) is invalid and the waiter keeps its own count.
 */
export function inspectSlotsFile(dir) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, "slots"));
  } catch {
    return { state: "absent" };
  }
  let raw;
  try {
    const text = decodeSlotsBytes(buf);
    if (text === null) return { state: "invalid", reason: "UTF-16 body has an odd byte count" };
    raw = text.trim();
  } catch (e) {
    return {
      state: "invalid",
      reason: `unreadable: ${e instanceof Error ? e.message : "decode error"}`,
    };
  }
  if (!/^[0-9]+$/.test(raw)) {
    return {
      state: "invalid",
      reason: `not a plain decimal integer: ${JSON.stringify(raw.slice(0, 20))}`,
    };
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_SLOTS_FILE) {
    return { state: "invalid", reason: `${n} is outside 1..${MAX_SLOTS_FILE}` };
  }
  return { state: "ok", value: n };
}

/**
 * The machine-wide slot count: an optional `<dir>/slots` file. When valid it overrides every waiter's own
 * RF_HEAVY_SLOTS / opts.slots (strict FIFO means one waiter started with a smaller count at the head would
 * otherwise block the whole queue while higher slots sit free). Absent or invalid -> null.
 */
export function readSlotsFile(dir) {
  const f = inspectSlotsFile(dir);
  return f.state === "ok" ? f.value : null;
}

function parseMinutesMs(raw, fallbackMin) {
  const m = Number(raw);
  const ok = typeof raw === "string" && raw.trim() !== "" && Number.isFinite(m) && m >= 0;
  return (ok ? m : fallbackMin) * 60_000;
}

/** RF_HEAVY_SLOT_MAX_WAIT_MIN (minutes, fractions allowed) -> ms; unset/invalid -> 720 min. */
export function parseMaxWaitMs(raw) {
  return parseMinutesMs(raw, DEFAULT_MAX_WAIT_MIN);
}

/** RF_HEAVY_SLOT_MAX_HOLD_MIN (minutes, fractions allowed) -> ms; unset/invalid -> 90 min. */
export function parseMaxHoldMs(raw) {
  return parseMinutesMs(raw, DEFAULT_MAX_HOLD_MIN);
}

// Owner cap (2026-10-25: "keep the CPU usage less than 80% and memory less than 80% too"): a job that
// is first in line and has a free slot still waits while the MACHINE is above either threshold.
export const DEFAULT_MAX_LOAD_PCT = 80;
export const LOAD_SAMPLE_MS = 3_000;

/** RF_HEAVY_SLOT_MAX_CPU_PCT / _MEM_PCT -> a percent in (0, 100], else 80. 100 never blocks (both at 100 skips the ~3 s sample). */
export function parseLoadPct(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 && n <= 100
    ? n
    : DEFAULT_MAX_LOAD_PCT;
}

/** Why the machine is too busy to start a heavy job, or null. `load` is { cpuPct, memPct }. */
export function loadOverReason({ cpuPct, memPct }, { maxCpuPct, maxMemPct }) {
  if (cpuPct > maxCpuPct) return `cpu ${Math.round(cpuPct)}% > ${maxCpuPct}%`;
  if (memPct > maxMemPct) return `memory ${Math.round(memPct)}% > ${maxMemPct}%`;
  return null;
}

/** Busy share (0-100) between two per-core `{ idle, total }` tick snapshots; no elapsed ticks -> 0. */
export function cpuPctFromTimes(before, after) {
  let idle = 0;
  let total = 0;
  after.forEach((a, i) => {
    idle += a.idle - (before[i]?.idle ?? 0);
    total += a.total - (before[i]?.total ?? 0);
  });
  return total > 0 ? Math.round(((total - idle) / total) * 1000) / 10 : 0;
}

const cpuTicks = (cpus) =>
  cpus.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });

/**
 * Reclaimable bytes from `vm_stat` text: (free + inactive + speculative) pages x page size, or null when it
 * does not parse. macOS keeps most RAM in inactive/cached pages, so os.freemem() alone reads "full" there.
 */
export function parseVmStat(text) {
  const size = /page size of (\d+) bytes/.exec(text ?? "")?.[1];
  const pages = (name) =>
    Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text ?? "")?.[1]);
  const [free, inactive, speculative] = [pages("free"), pages("inactive"), pages("speculative")];
  if (!size || [free, inactive, speculative].some(Number.isNaN)) return null;
  return (free + inactive + speculative) * Number(size);
}

function vmStatText() {
  return execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 });
}

/**
 * One machine-wide reading: CPU busy share over `sampleMs`, and the used share of memory (reclaimable pages count
 * as free on darwin, falling back to os.freemem). Everything is injectable.
 */
export async function sampleMachineLoad({
  cpus = os.cpus,
  freemem = os.freemem,
  totalmem = os.totalmem,
  platform = process.platform,
  vmStat = vmStatText,
  sleep: wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  sampleMs = LOAD_SAMPLE_MS,
} = {}) {
  const before = cpuTicks(cpus());
  await wait(sampleMs);
  const cpuPct = cpuPctFromTimes(before, cpuTicks(cpus()));
  const total = totalmem();
  let free = freemem();
  if (platform === "darwin") {
    try {
      free = parseVmStat(vmStat()) ?? free;
    } catch {
      /* keep os.freemem() */
    }
  }
  return { cpuPct, memPct: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0 };
}

/** A (live, heartbeating) holder that has held its slot longer than the hold cap. */
export function holderOverCap(holder, now, maxHoldMs) {
  return Boolean(holder) && now - holder.startedAt > maxHoldMs;
}

/** A positive-number env knob in ms (test-only timing knobs), else the default. */
export function parseMs(raw, fallback) {
  const n = Number(raw);
  return typeof raw === "string" && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Every npm verb (and alias) that runs lifecycle scripts on install. Source: npm 11.9
 * `lib/utils/cmd-list.js` (`shorthands`/`aliases`) plus `npm help install` / `npm help ci`.
 */
export const NPM_INSTALL_VERBS = new Set([
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
  "install",
  "i",
  "add",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "it",
  "install-test",
  "cit",
  "install-ci-test",
  "clean-install-test",
  "sit",
]);

/** npm global/config options that consume the NEXT arg unless written `--opt=value`. */
const NPM_VALUE_OPTS = new Set([
  "--prefix",
  "-C",
  "-w",
  "--workspace",
  "--loglevel",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--cache",
  "--include",
  "--omit",
  "--tag",
  "--otp",
  "--install-strategy",
  "--before",
  "--scope",
  "--omit-lockfile-disabled",
  "--lockfile-version",
  "--audit-level",
  "--fetch-retries",
  "--logs-dir",
  "--logs-max",
  "--script-shell",
  "--node-options",
  "--cafile",
  "--ca",
  "--proxy",
  "--https-proxy",
  "--noproxy",
  "--auth-type",
  "--package",
  "-c",
  "--call",
  "--json-pointer",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);

/** The words after each `npm` inside a shell command string among `args` (`sh -c 'a && npm ci'`). */
function* npmCallsInShell(args) {
  for (const a of args.map(String)) {
    if (!/\s/.test(a)) continue;
    for (const seg of a.split(/&&|\|\||[;|\n]/)) {
      const w = seg
        .replace(/['"`()]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (let i = 0; i < w.length; i++) {
        const name = path.basename(w[i]).replace(/\.(cmd|exe)$/i, "");
        if (name.toLowerCase() === "npm") yield w.slice(i + 1);
      }
    }
  }
}

function npmVerbIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith("-")) return i;
    if (NPM_VALUE_OPTS.has(a)) i++; // `--prefix dir`: skip the value too
  }
  return -1;
}

/** Last of --ignore-scripts / --ignore-scripts=<v> / --no-ignore-scripts wins; null = not given. */
function argIgnoreScripts(args) {
  let v = null;
  for (const a of args.map(String)) {
    if (a === "--ignore-scripts" || a === "--ignore-scripts=true") v = true;
    else if (a === "--no-ignore-scripts" || a === "--ignore-scripts=false") v = false;
  }
  return v;
}

function envIgnoreScripts(env) {
  for (const k of ["npm_config_ignore_scripts", "NPM_CONFIG_IGNORE_SCRIPTS"]) {
    if (String(env[k]).toLowerCase() === "true") return true;
  }
  return false;
}

/** True when `cmd args` is an npm install-family verb (`ci`, `install`, aliases; shell-string form too). */
export function isNpmInstall(cmd, args = []) {
  const c = String(cmd ?? "").trim();
  if (/\s/.test(c)) {
    const words = c.split(/\s+/);
    return isNpmInstall(words[0], [...words.slice(1), ...args]);
  }
  const base = path
    .basename(c)
    .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();
  if (SHELLS.has(base)) return [...npmCallsInShell(args)].some((w) => isNpmInstall("npm", w));
  if (base !== "npm") return false;
  const list = args.map(String);
  const at = npmVerbIndex(list);
  return at >= 0 && NPM_INSTALL_VERBS.has(list[at].toLowerCase());
}

/** The `--prefix`/`-C` value of the LAST npm install call in `cmd args` (raw, unresolved), or null. */
export function npmInstallPrefix(cmd, args = []) {
  const c = String(cmd ?? "").trim();
  if (/\s/.test(c)) {
    const words = c.split(/\s+/);
    return npmInstallPrefix(words[0], [...words.slice(1), ...args]);
  }
  const base = path
    .basename(c)
    .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();
  const lists = SHELLS.has(base) ? [...npmCallsInShell(args)] : base === "npm" ? [args] : [];
  let found = null;
  for (const list of lists.map((l) => l.map(String))) {
    if (!isNpmInstall("npm", list)) continue;
    found = null;
    for (let i = 0; i < list.length; i++) {
      const m = /^--prefix=(.*)$/.exec(list[i]);
      if (m) found = m[1];
      else if ((list[i] === "--prefix" || list[i] === "-C") && i + 1 < list.length)
        found = list[++i];
    }
  }
  return found || null;
}

/**
 * Why `cmd args` must not run under the slot, or null. A bare `npm ci` / `npm install` (or any alias
 * of them, after npm's own global options) runs the lifecycle scripts (husky `prepare`), which
 * rewrite core.hooksPath and silently turn the worktree's pre-push hooks off (W-679); it must carry
 * `--ignore-scripts` (or npm_config_ignore_scripts=true). Shell-string forms (`"npm ci"`,
 * `sh -c 'npm ci'`) are parsed too, so they cannot sidestep the guard.
 */
export function bareNpmReason(cmd, args = [], env = process.env) {
  const c = String(cmd ?? "").trim();
  if (/\s/.test(c)) {
    // one shell-string "command": split it and judge the first command word as `cmd`.
    const words = c.split(/\s+/);
    return bareNpmReason(words[0], [...words.slice(1), ...args], env);
  }
  const base = path
    .basename(c)
    .replace(/\.(cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();
  if (SHELLS.has(base)) {
    for (const w of npmCallsInShell(args)) {
      const r = bareNpmReason("npm", w, env);
      if (r) return r;
    }
    return null;
  }
  if (base !== "npm") return null;
  const list = args.map(String);
  const at = npmVerbIndex(list);
  if (at < 0) return null;
  const verb = list[at].toLowerCase();
  if (!NPM_INSTALL_VERBS.has(verb)) return null;
  const viaArg = argIgnoreScripts(list);
  if (viaArg !== null ? viaArg : envIgnoreScripts(env)) return null;
  return (
    `heavy-slot: refusing a bare \`npm ${verb}\`: its lifecycle scripts rewrite core.hooksPath and ` +
    `switch the pre-push hooks off. Re-run with \`--ignore-scripts\`. Nothing was run.`
  );
}

export function resolveDir(env = process.env, home = os.homedir()) {
  return env.RF_HEAVY_SLOT_DIR || path.join(home, ".routeflow", "heavy-slot");
}

/** `queue/` file name: sorts lexicographically == by enqueue time (ms is zero padded). */
export function ticketName(ms, pid, rand) {
  return `${String(ms).padStart(15, "0")}-${pid}-${rand}.json`;
}

/** True when a ticket was written under an older grant rule than this code applies, or under none. */
export function ticketStale(entry) {
  return !Number.isInteger(entry?.rule) || entry.rule < GRANT_RULE;
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

/** Labels of the jobs that hold a slot the longest and together exhaust memory: full `verify` runs and the pre-push gate (the runbook's `push` label). */
const CAPPED_LABEL = /verify|pre-?push|\bpush\b/i;
export const DEFAULT_CAPPED_MAX = 2;

export function isCappedLabel(label) {
  return CAPPED_LABEL.test(label ?? "");
}

/** RF_HEAVY_SLOT_CAPPED_MAX: a positive integer, else the default. */
export function parseCappedMax(raw) {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAPPED_MAX;
}

/**
 * The grant decision for the ticket `myName` given the live, ordered ticket names and free slots. Strict FIFO,
 * except that a ticket in `capped` is skipped while `cappedHeld` slots are already held by capped jobs
 * (`cappedMax`): the oldest ELIGIBLE ticket is first in line, so a capped head never blocks an uncapped job behind it.
 */
export function nextGrant({
  order,
  myName,
  freeSlots,
  capped,
  cappedHeld = 0,
  cappedMax = Infinity,
  stale,
}) {
  const idx = order.indexOf(myName);
  const atCap = cappedHeld >= cappedMax;
  // A ticket written under an older grant rule (or none) is not first in line: its waiter does not apply this rule, so
  // it may be unable to take the free slot, and everyone behind it would wait on a slot nobody takes. It keeps its
  // position (the wait line stays truthful) and still gets the slot if it wins the lock itself.
  const head = order.find((n) => !(n !== myName && stale?.has(n)) && !(atCap && capped?.has(n)));
  return {
    position: idx + 1, // 0 = my ticket is not in the list
    total: order.length,
    grant: idx !== -1 && order[idx] === head && freeSlots > 0,
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
export function historyRecord(lease, endedAt, exit, extra = {}) {
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
    ...extra,
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
let holdExpired = false; // W-759: the holder's cap fired; no further child may start under this lease

/** Awaited async spawn with the heartbeat free to run. Resolves `{ status, signal, error }`. */
export function activeChildCount() {
  return activeChildren.size;
}

export function spawnAsync(cmd, args = [], options = {}) {
  return new Promise((resolve) => {
    if (interruptedBy) {
      resolve({ status: interruptedBy === "SIGINT" ? 130 : 143, signal: interruptedBy });
      return;
    }
    if (holdExpired) {
      resolve({ status: HOLD_CAP_EXIT_CODE, signal: null });
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
    // 'exit' (not only 'close'): 'close' waits for every holder of the child's stdio, and an exited child's PID may be reused;
    // an exited child must never be a target of the cap's kill (SA review of #3688).
    child.on("exit", () => activeChildren.delete(child));
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (code, signal) => finish({ status: code, signal }));
  });
}

function forwardSignal(sig) {
  for (const child of activeChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue; // already gone: its PID may belong to someone else now
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
    maxHoldMs: opts.maxHoldMs ?? parseMaxHoldMs(env.RF_HEAVY_SLOT_MAX_HOLD_MIN),
    holdGraceMs: opts.holdGraceMs ?? HOLD_GRACE_MS,
    holdKillMs: opts.holdKillMs ?? HOLD_KILL_MS,
    pollMs: opts.pollMs ?? parseMs(env.RF_HEAVY_SLOT_POLL_MS, POLL_MS),
    heartbeatMs: opts.heartbeatMs ?? parseMs(env.RF_HEAVY_SLOT_HEARTBEAT_MS, HEARTBEAT_MS),
    waitLogMs: opts.waitLogMs ?? WAIT_LOG_MS,
    maxCpuPct: opts.maxCpuPct ?? parseLoadPct(env.RF_HEAVY_SLOT_MAX_CPU_PCT),
    cappedMax: opts.cappedMax ?? parseCappedMax(env.RF_HEAVY_SLOT_CAPPED_MAX),
    maxMemPct: opts.maxMemPct ?? parseLoadPct(env.RF_HEAVY_SLOT_MAX_MEM_PCT),
    sampleLoad: opts.sampleLoad ?? sampleMachineLoad,
    sampleTimeoutMs: opts.sampleTimeoutMs ?? 2 * LOAD_SAMPLE_MS,
    staleMs: opts.staleMs ?? STALE_MS,
    hostname: opts.hostname ?? os.hostname(),
    now: opts.now ?? Date.now,
    log: opts.log ?? ((m) => console.error(m)),
    label: opts.label || "job",
    branch: opts.branch ?? gitBranch(process.cwd()),
  };
}

/** Runs the sampler under a deadline; a sampler that never answers rejects, which the caller treats as fail-open. */
function sampleWithin(sample, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("load sampler timed out")), ms);
  });
  return Promise.race([sample(), deadline]).finally(() => clearTimeout(timer));
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
    rule: GRANT_RULE,
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
  let warnedSlots = null;
  try {
    for (;;) {
      if (state.aborted)
        throw new Error(`heavy-slot: interrupted by ${state.aborted} while waiting`);
      let now = cfg.now();
      const snap = readState(cfg.dir, { now, hostname: cfg.hostname, staleMs: cfg.staleMs }, true);
      if (!fs.existsSync(ticketFile)) writeJson(ticketFile, { ...base, heartbeatAt: now });
      const taken = new Set(snap.holders.map((h) => h.index));
      let free = -1;
      const sf = inspectSlotsFile(cfg.dir);
      if (sf.state === "invalid" && sf.reason !== warnedSlots) {
        warnedSlots = sf.reason;
        cfg.log(`heavy-slot: ignoring ${cfg.dir}/slots (${sf.reason}); using ${cfg.slots} slot(s)`);
      }
      const slotCount = sf.state === "ok" ? sf.value : cfg.slots;
      for (let i = 0; i < slotCount; i++) {
        if (!taken.has(i)) {
          free = i;
          break;
        }
      }
      const entries = snap.tickets.map((t) => ({ name: t.name }));
      const capped = new Set(
        snap.tickets.filter((t) => isCappedLabel(t.entry.label)).map((t) => t.name),
      );
      if (isCappedLabel(cfg.label)) capped.add(name);
      if (!entries.some((t) => t.name === name)) entries.push({ name }); // just (re)written
      const g = nextGrant({
        order: orderTickets(entries).map((t) => t.name),
        myName: name,
        freeSlots: free < 0 ? 0 : 1,
        capped,
        cappedHeld: snap.holders.filter((h) => isCappedLabel(h.entry.label)).length,
        cappedMax: cfg.cappedMax,
        stale: new Set(snap.tickets.filter((t) => ticketStale(t.entry)).map((t) => t.name)),
      });
      // Owner cap: first in line with a free slot, but the machine is too busy -> keep waiting. Sampled only
      // here (sampling takes ~3 s), so a job queued behind another holder costs nothing. A sampler that
      // throws fails open: the cap is a load guard, never a reason to wedge the queue.
      let busy = null;
      if (g.grant && (cfg.maxCpuPct < 100 || cfg.maxMemPct < 100)) {
        try {
          busy = loadOverReason(await sampleWithin(cfg.sampleLoad, cfg.sampleTimeoutMs), cfg);
          now = cfg.now(); // the sample took ~3 s: judge the max wait and the wait line on the clock after it
        } catch {
          busy = null;
        }
      }
      if (g.grant && !busy) {
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
      // Wedged but alive: every slot is held by a live holder past the hold cap, so waiting longer
      // cannot end by itself. (A queue of healthy jobs under the cap keeps waiting.)
      if (
        free < 0 &&
        snap.holders.length &&
        snap.holders.every((h) => holderOverCap(h.entry, now, cfg.maxHoldMs + cfg.holdGraceMs))
      ) {
        const holder = snap.holders[0].entry;
        throw new HeavySlotTimeout(
          `heavy-slot: gave up waiting for a slot (position ${g.position} of ${g.total}); ` +
            `held by ${describeHolder(holder)} for ${((now - holder.startedAt) / 60_000).toFixed(1)} min, ` +
            `over the ${(cfg.maxHoldMs / 60_000).toFixed(2)} min hold cap (RF_HEAVY_SLOT_MAX_HOLD_MIN) ` +
            `and its ${(cfg.holdGraceMs / 60_000).toFixed(2)} min grace, while still heartbeating (wedged but alive?). Nothing was run. ` +
            `Check \`node scripts/heavy-slot.mjs status\`, then retry.`,
          holder,
        );
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
      if (now - lastLog >= cfg.waitLogMs && busy) {
        cfg.log(`heavy-slot: waiting for the machine to cool (${busy}; first in line, slot free)`);
        lastLog = now;
      } else if (now - lastLog >= cfg.waitLogMs) {
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
  let warnedLost = false; // the warning is once per lease, not once per heartbeat
  const beat = setInterval(() => {
    const cur = readEntry(file);
    if (cur && !cur.unreadable && cur.token === lock.token) {
      try {
        writeJson(file, { ...lock, heartbeatAt: cfg.now() });
      } catch {
        /* next beat */
      }
    } else if (!warnedLost) {
      warnedLost = true;
      cfg.log("heavy-slot: WARNING our slot lock vanished or was taken over; continuing unguarded");
    }
  }, cfg.heartbeatMs);
  beat.unref?.();
  let released = false;
  return {
    token: lock.token,
    lock,
    release(exit = 0, extra = {}) {
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
      appendHistory(cfg.dir, historyRecord(lock, endedAt, exit, extra));
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
    holdExpired = false;
    // W-759: the holder enforces its OWN cap. A job that hangs while this process still heartbeats would otherwise stall every
    // waiter. At the cap the holder ends its own guarded children (their process tree only); if fn still has not returned
    // HOLD_KILL_MS later, the slot is released anyway and fn's late result is ignored.
    // The timers are NOT unref'd: while armed they must keep the process alive, or a job hung on a bare promise would end the
    // process with the slot never released by this path. They are cleared on release.
    let capped = false;
    let hardTimer = null;
    let hardResolve = () => {};
    const hard = new Promise((resolve) => {
      hardResolve = resolve;
    });
    const capTimer = setTimeout(() => {
      capped = true;
      holdExpired = true;
      cfg.log(
        `heavy-slot: WARNING "${cfg.label}" held the slot past the ${(cfg.maxHoldMs / 60_000).toFixed(2)} min cap ` +
          "(RF_HEAVY_SLOT_MAX_HOLD_MIN); ending its job and releasing the slot",
      );
      forwardSignal("SIGTERM");
      hardTimer = setTimeout(() => {
        forwardSignal("SIGKILL");
        hardResolve(HOLD_CAP_EXIT_CODE);
      }, cfg.holdKillMs);
    }, cfg.maxHoldMs);
    const stopTimers = () => {
      clearTimeout(capTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    let result;
    try {
      result = await Promise.race([fn({ token: lease.token, held: true }), hard]);
    } catch (e) {
      stopTimers();
      holdExpired = false;
      lease.release(capped ? HOLD_CAP_EXIT_CODE : 1, capped ? { capped: true } : {});
      throw e;
    }
    stopTimers();
    holdExpired = false;
    if (capped) {
      lease.release(HOLD_CAP_EXIT_CODE, { capped: true });
      return HOLD_CAP_EXIT_CODE;
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
export function formatStatus(
  dir,
  {
    now = Date.now(),
    hostname = os.hostname(),
    maxHoldMs = parseMaxHoldMs(process.env.RF_HEAVY_SLOT_MAX_HOLD_MIN),
    slots = parseSlots(process.env.RF_HEAVY_SLOTS),
  } = {},
) {
  const st = readState(dir, { now, hostname }, false);
  const out = [`heavy-slot dir: ${dir}`];
  const sf = inspectSlotsFile(dir);
  const slotCount = sf.state === "ok" ? sf.value : slots;
  out.push(
    sf.state === "ok"
      ? `slots file: ${path.join(dir, "slots")} = ${sf.value} (overrides every waiter's RF_HEAVY_SLOTS)`
      : sf.state === "invalid"
        ? `slots file: ${path.join(dir, "slots")} is INVALID (${sf.reason}) — ignored`
        : "slots file: none (each waiter uses its own RF_HEAVY_SLOTS)",
  );
  if (!st.holders.length) out.push("holder: none (slot free)");
  for (const h of st.holders) {
    const e = h.entry;
    out.push(
      `holder: ${e.label} on ${e.branch || "?"} — pid ${e.pid}, ${min(now - e.startedAt)} min, ` +
        `heartbeat ${Math.round((now - e.heartbeatAt) / 1000)}s ago (${h.name})` +
        (holderOverCap(e, now, maxHoldMs)
          ? ` \u2014 OVER HOLD CAP (> ${(maxHoldMs / 60_000).toFixed(0)} min; the holder ends its job at the cap, waiters give up ${HOLD_GRACE_MS / 60_000} min later)`
          : ""),
    );
  }
  if (!st.tickets.length) out.push("queue: empty");
  st.tickets.forEach((t, i) => {
    const e = t.entry;
    out.push(
      `queue ${i + 1} of ${st.tickets.length}: ${e.label} on ${e.branch || "?"} — pid ${e.pid}, waiting ${min(now - e.queuedAt)} min` +
        (ticketStale(e)
          ? ` **OLD GRANT RULE (ticket rule ${Number.isInteger(e.rule) ? e.rule : "none"}, current ${GRANT_RULE}): fresh waiters skip it; its waiter needs a restart**`
          : ""),
    );
  });
  const free = Math.max(0, slotCount - st.holders.length);
  if (free > 0 && st.tickets.length) {
    out.push(
      `**${free} of ${slotCount} slots free with ${st.tickets.length} waiting: nobody is taking them (a waiter on an old rule, or a load gate)**`,
    );
  }
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
