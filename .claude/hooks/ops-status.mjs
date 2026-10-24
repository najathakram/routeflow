#!/usr/bin/env node
/**
 * Ops-monitor lane STATUS FILE (session -> monitor). Registered under Stop and SessionStart.
 * Writes <opsHome>/status/<sessionId>.json with deterministic facts only (branch, head, open PR,
 * last assistant message first 300 chars, masked). `rf status-sync` (run by `rf brief --refresh`
 * and the views writer) turns changed files into `heartbeat` events.
 *
 * SessionStart also prints a short orientation: the lane brief (only when RF_STATUS_BRIEF=1) and
 * one line per status file on this machine, so a new session or account switch resumes where the
 * old one stopped.
 *
 * FAIL OPEN and FAST: any error -> exit 0, nothing on stdout for Stop, hard 2 s budget.
 * CI and RF_OPS_GATE=off skip it.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BUDGET_MS = 2000;
const PR_CACHE_MS = 60_000;
const LAST_MAX = 300;
const TAIL_BYTES = 262_144;
const ORIENT_MAX_AGE_MS = 3 * 86_400_000;
const PRUNE_AGE_MS = 7 * 86_400_000;

const lib = (name) => pathToFileURL(join(ROOT, "tools", "ops-monitor", "lib", name)).href;

export const safeSessionId = (id) =>
  String(id ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80);

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /whsec_[A-Za-z0-9]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, // JWT (always starts eyJ)
  /\b[0-9a-fA-F]{32,}\b/g,
];
const HOME_RE = /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"'`]+/gi;
const ENV_PAIR_RE = /\b([A-Z][A-Z0-9_]{2,})=(\S+)/g;
const B64_RE = /[A-Za-z0-9+/_=-]{40,}/g;

/**
 * Pure: strips what must not leave the machine from free text: the home dir ("~"), token/key-like
 * strings and env-pair values ("[redacted]"). Long base64 runs are redacted only when mixed-case
 * with a digit, so lowercase paths and branch names survive.
 */
export function scrubText(text, home = homedir()) {
  if (typeof text !== "string") return text;
  let t = text;
  if (home && home.length > 1) {
    const esc = home.replace(/[\\/]/g, "[\\\\/]").replace(/[.*+?^${}()|[\]]/g, "\\$&");
    t = t.replace(new RegExp(esc, "gi"), "~");
  }
  t = t.replace(HOME_RE, "~");
  for (const re of SECRET_PATTERNS) t = t.replace(re, "[redacted]");
  t = t.replace(B64_RE, (m) =>
    /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? "[redacted]" : m,
  );
  return t.replace(ENV_PAIR_RE, "$1=[redacted]");
}

/** Text of the last assistant message in a JSONL transcript tail; malformed lines are ignored. */
export function lastAssistantText(jsonl) {
  const lines = String(jsonl ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = o?.message ?? o;
    if ((o?.type ?? msg?.role) !== "assistant" && msg?.role !== "assistant") continue;
    const c = msg?.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("\n")
          : "";
    if (text.trim()) return text.trim();
  }
  return null;
}

/** Reads the last TAIL_BYTES of a file as text (null when unreadable). */
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Relative age: 45s, 12m, 3h, 2d. */
export function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** PR number for a branch from the cache when fresh (<= 60 s), else undefined. */
export function cachedPr(cache, branch, now) {
  const e = cache?.[branch];
  return e && typeof e.at === "number" && now - e.at <= PR_CACHE_MS
    ? (e.number ?? null)
    : undefined;
}

/**
 * Builds the status record. Pure: every fact is passed in.
 * facts = { worktree, branch, head: {sha, at}|null, pr: number|null, lastText: string|null }
 * mask = (text) => text, or null when the client-name list is unreadable (lastMessage -> null).
 */
export function buildStatusRecord({
  payload,
  env,
  now,
  machine,
  facts,
  mask,
  normalizeLane,
  home,
}) {
  const sc = (t) => (t == null ? t : scrubText(t, home));
  const title = env.CLAUDE_SESSION_TITLE?.trim() || null;
  const lane =
    env.RF_LANE?.trim() || (title && normalizeLane ? normalizeLane(title) : null) || null;
  const m = mask ?? ((t) => t);
  return {
    v: 1,
    sessionId: safeSessionId(payload.session_id),
    machine,
    title: title && mask ? m(sc(title)) : null,
    lane,
    cwd: sc(payload.cwd ?? null),
    worktree: sc(facts.worktree ?? null),
    branch: facts.branch ? m(sc(facts.branch)) : null,
    head: facts.head ?? null,
    pr: Number.isInteger(facts.pr) ? facts.pr : null,
    lastActiveAt: new Date(now).toISOString(),
    event: payload.hook_event_name === "SessionStart" ? "SessionStart" : "Stop",
    lastMessage:
      mask && facts.lastText ? m(sc(facts.lastText)).replace(/\s+/g, " ").slice(0, LAST_MAX) : null,
  };
}

/** One orientation line per status record (newest first, <= 3 days old, max 8). */
export function orientationLines(records, now, max = 8) {
  return records
    .filter((r) => r && Date.parse(r.lastActiveAt) > now - ORIENT_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .slice(0, max)
    .map((r) => {
      const who = r.lane ?? r.title ?? r.sessionId;
      const pr = r.pr ? ` PR #${r.pr}` : "";
      return `[ops status] ${who} · ${r.branch ?? "no branch"}${pr} · ${formatAge(now - Date.parse(r.lastActiveAt))} ago`;
    });
}

let T0 = Date.now();
function git(args, cwd, timeout) {
  if (Date.now() - T0 > 1300) return ""; // sync spawns block the event loop: keep inside the budget
  try {
    return execFileSync("git", args, {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function gatherFacts(cwd, statusDir, now, t0) {
  const worktree = git(["rev-parse", "--show-toplevel"], cwd, 400) || null;
  const branch = git(["branch", "--show-current"], cwd, 400) || null;
  const [sha, at] = git(["log", "-1", "--format=%h%x09%cI"], cwd, 400).split("\t");
  const head = sha ? { sha, at: at ?? null } : null;
  let pr = null;
  if (branch && branch !== "master" && branch !== "main") {
    const cacheFile = join(statusDir, ".pr-cache.json");
    const cache = readJson(cacheFile) ?? {};
    const hit = cachedPr(cache, branch, now);
    if (hit !== undefined) pr = hit;
    else if (Date.now() - t0 < 1000) {
      try {
        const out = execFileSync(
          "gh",
          ["pr", "list", "--head", branch, "--json", "number,url", "--limit", "1"],
          { cwd, timeout: 700, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        pr = JSON.parse(out)?.[0]?.number ?? null;
        cache[branch] = { at: now, number: pr };
        writeAtomic(cacheFile, cache);
      } catch {
        pr = null;
      }
    }
  }
  return { worktree, branch, head, pr };
}

function readStatusFiles(dir) {
  const out = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      const r = readJson(join(dir, f));
      if (r && typeof r === "object") out.push(r);
    }
  } catch {
    // none yet
  }
  return out;
}

/** Drops status files and .pr-cache.json entries older than 7 days. Never throws. */
export function prune(dir, now) {
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || !f.endsWith(".json")) continue;
      const file = join(dir, f);
      if (now - statSync(file).mtimeMs > PRUNE_AGE_MS) unlinkSync(file);
    }
    const cacheFile = join(dir, ".pr-cache.json");
    const cache = readJson(cacheFile);
    if (cache && typeof cache === "object") {
      const keep = Object.entries(cache).filter(([, e]) => now - (e?.at ?? 0) <= PRUNE_AGE_MS);
      if (keep.length !== Object.keys(cache).length)
        writeAtomic(cacheFile, Object.fromEntries(keep));
    }
  } catch {
    // best effort
  }
}

// Status sync on EVERY machine (not only a local --views monitor): the hook writes the status file, then, at most every
// STATUS_SYNC_EVERY_MS, hands it to `rf status-sync` in a detached process so heartbeats reach the specs repo and the
// shared board. Only where a specs clone exists; never blocks or fails the hook.
export const STATUS_SYNC_EVERY_MS = 120_000;
export function statusSyncDue({ home, specs, env, now, exists = existsSync, mtimeMs }) {
  if (env.RF_NO_SYNC || env.RF_OPS_GATE === "off" || env.CI) return false;
  if (!exists(join(specs, ".git"))) return false;
  const last = mtimeMs ? mtimeMs(join(home, "status-sync.stamp")) : null;
  return last === null || last === undefined || now - last >= STATUS_SYNC_EVERY_MS;
}
function spawnStatusSync(home, specs, env, now) {
  const stamp = join(home, "status-sync.stamp");
  const due = statusSyncDue({
    home,
    specs,
    env,
    now,
    mtimeMs: (f) => {
      try {
        return statSync(f).mtimeMs;
      } catch {
        return null;
      }
    },
  });
  if (!due) return false;
  writeFileSync(stamp, String(now)); // claim the slot first, so a second hook in the same minute does not spawn too
  const child = spawn(
    process.execPath,
    [join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs"), "status-sync"],
    {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    },
  );
  child.on("error", () => {});
  child.unref();
  return true;
}

async function main(t0) {
  T0 = t0;
  if (process.env.RF_OPS_GATE === "off" || process.env.CI) return;
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || !payload.session_id) return;
  const env = process.env;
  const config = await import(lib("config.mjs"));
  const maskMod = await import(lib("mask.mjs"));
  const home = config.opsHome(env);
  const statusDir = join(home, "status");
  const now = Date.now();
  const cwd = payload.cwd || process.cwd();
  const loaded = maskMod.loadClientNames({ env, home });
  const names = Array.isArray(loaded) ? loaded : (loaded.names ?? []);
  const mask = !Array.isArray(loaded) && loaded.error ? null : (t) => maskMod.maskText(t, names);
  const facts = gatherFacts(cwd, statusDir, now, t0);
  const tail = payload.transcript_path ? readTail(payload.transcript_path) : null;
  facts.lastText = tail ? lastAssistantText(tail) : null;
  const rec = buildStatusRecord({
    payload,
    env,
    now,
    machine: config.machineId(config.DEFAULT_CONFIG, env),
    facts,
    mask,
    normalizeLane: (t) => config.normalizeLane(t),
  });
  if (!rec.sessionId) return;
  writeAtomic(join(statusDir, `${rec.sessionId}.json`), rec);
  prune(statusDir, now);
  try {
    spawnStatusSync(home, config.specsDir(env), env, now);
  } catch {
    // best effort
  }

  if (rec.event !== "SessionStart") return;
  const parts = [];
  if (rec.lane && env.RF_STATUS_BRIEF === "1" && Date.now() - t0 < 1000) {
    try {
      const brief = execFileSync(
        process.execPath,
        [join(ROOT, "tools", "ops-monitor", "bin", "rf.mjs"), "brief", "--lane", rec.lane],
        {
          cwd: ROOT,
          timeout: Math.max(300, BUDGET_MS - 300 - (Date.now() - t0)),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...env, RF_NO_SYNC: "1" },
        },
      ).trim();
      if (brief) parts.push(brief);
    } catch {
      // no brief
    }
  }
  const others = readStatusFiles(statusDir).filter((r) => r.sessionId !== rec.sessionId);
  parts.push(...orientationLines(others, now));
  if (parts.length) process.stdout.write(`${parts.join("\n")}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const t0 = Date.now();
  setTimeout(() => process.exit(0), BUDGET_MS).unref();
  try {
    await main(t0);
  } catch {
    // fail open and silent
  }
  process.exitCode = 0;
}
