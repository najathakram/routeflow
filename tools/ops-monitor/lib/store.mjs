// IO for the ops monitor: child processes, the tool-owned routeflow-specs clone, the lock, and
// appending events (one commit per call, push with rebase retry, item-id collision repair).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { BUG_ID_RE, validateEvent } from "./schema.mjs";
import { fold } from "./fold.mjs";
import { nextItemId, utcDate } from "./ids.mjs";
import { REPO_ROOT, opsHome, specsDir } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command without a shell. Never rejects; a missing binary resolves to code 127. */
export function exec(cmd, args = [], { cwd, timeoutMs = 60000, env, input } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        cmd,
        args,
        {
          cwd,
          timeout: timeoutMs,
          env: env ? { ...process.env, ...env } : process.env,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
          if (err.code === "ENOENT")
            return resolve({ code: 127, stdout: "", stderr: String(err.message) });
          resolve({
            code: typeof err.code === "number" ? err.code : 1,
            stdout: stdout ?? "",
            stderr: stderr || String(err.message),
          });
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    } catch (e) {
      resolve({
        code: e?.code === "ENOENT" ? 127 : 1,
        stdout: "",
        stderr: String(e?.message ?? e),
      });
    }
  });
}

const git = (dir, args, opts = {}) =>
  exec("git", args, { ...opts, cwd: dir, env: { GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) } });

const HEARTBEAT_MS = 15000;

function readOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Milliseconds since the holder last proved it is alive (owner.json mtime, else the dir's). */
function lockAgeMs(lock) {
  for (const p of [join(lock, "owner.json"), lock]) {
    try {
      return Date.now() - statSync(p).mtimeMs;
    } catch {
      /* try the next one */
    }
  }
  return null; // vanished
}

/**
 * Takes <home>/specs.lock (a mkdir lock owned via owner.json {token,pid,host,at}, kept alive by a
 * heartbeat, stale after staleMs without one). Returns a release function that deletes the lock
 * only while owner.json still carries our token; null when `tryOnly` and the lock is busy.
 */
async function acquireLock(home, { staleMs, waitMs, pollMs, heartbeatMs, tryOnly }) {
  mkdirSync(home, { recursive: true });
  const lock = join(home, "specs.lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      const age = lockAgeMs(lock);
      if (age === null) continue; // vanished between mkdir and stat: retry now
      if (age > staleMs) {
        // Atomic rename so only one waiter reclaims a stale lock.
        const trash = `${lock}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lock, trash);
          rmSync(trash, { recursive: true, force: true });
        } catch {
          /* someone else reclaimed it */
        }
        continue;
      }
      if (tryOnly) return null;
      if (Date.now() - start > waitMs)
        throw new Error(`could not acquire specs lock ${lock} within ${waitMs} ms`);
      await sleep(pollMs);
    }
  }
  const token = randomUUID();
  const ownerPath = join(lock, "owner.json");
  try {
    writeFileSync(
      ownerPath,
      JSON.stringify({ token, pid: process.pid, host: hostname(), at: new Date().toISOString() }),
    );
  } catch (e) {
    rmSync(lock, { recursive: true, force: true });
    throw e;
  }
  const beat = setInterval(() => {
    try {
      if (readOwner(lock)?.token !== token) return clearInterval(beat); // no longer ours
      const now = new Date();
      utimesSync(ownerPath, now, now);
    } catch {
      /* the next beat retries */
    }
  }, heartbeatMs);
  beat.unref?.();
  return () => {
    clearInterval(beat);
    if (readOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  };
}

/**
 * Runs `fn` while holding <home>/specs.lock. The lock is released in a finally, whatever fn does,
 * and only if it is still ours (a late release never deletes a newer holder's lock).
 */
export async function withSpecsLock(
  fn,
  { home, staleMs = 120000, waitMs = 30000, pollMs = 100, heartbeatMs = HEARTBEAT_MS } = {},
) {
  const release = await acquireLock(home ?? opsHome(), {
    staleMs,
    waitMs,
    pollMs,
    heartbeatMs,
    tryOnly: false,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Like withSpecsLock but never waits: `{ ran: false }` at once when busy, else `{ ran: true, value }`. */
export async function tryWithSpecsLock(
  fn,
  { home, staleMs = 120000, heartbeatMs = HEARTBEAT_MS } = {},
) {
  const release = await acquireLock(home ?? opsHome(), {
    staleMs,
    waitMs: 0,
    pollMs: 0,
    heartbeatMs,
    tryOnly: true,
  });
  if (!release) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    release();
  }
}

/** Clones the specs repo to `dir` when `<dir>/.git` is missing. */
export async function ensureClone({ dir, remote }) {
  if (existsSync(join(dir, ".git"))) return { cloned: false };
  mkdirSync(dirname(dir), { recursive: true });
  const r = await git(dirname(dir), ["clone", "--quiet", remote, dir]);
  if (r.code !== 0) throw new Error(`git clone ${remote} failed: ${r.stderr.trim()}`);
  return { cloned: true };
}

async function abortRebase(dir) {
  const g = join(dir, ".git");
  if (existsSync(join(g, "rebase-merge")) || existsSync(join(g, "rebase-apply"))) {
    await git(dir, ["rebase", "--abort"]);
  }
}

/** Subject prefix of the disposable commit that holds only regenerated view files. */
export const VIEWS_COMMIT_PREFIX = "ops(views):";
// View files a generated-mode views commit may hold. backfill.json is deliberately absent: it is
// not regenerable, so a commit carrying it is never dropped.
const DROPPABLE_VIEW_PATHS = new Set(["register/WORK-REGISTER.md", "DASHBOARD.md"]);

/**
 * Drops the unpushed tip commits that hold only regenerated view files (subject `ops(views): …`),
 * so event commits can be rebased or rewritten without them. Only on an otherwise clean tree;
 * never drops an events commit. Returns true when at least one commit was dropped. Callers hold
 * the specs lock.
 */
export async function dropViewsTip(dir) {
  let dropped = false;
  for (let i = 0; i < 5; i++) {
    const ahead = await git(dir, ["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) === 0) break;
    const subject = await git(dir, ["log", "-1", "--format=%s"]);
    if (subject.code !== 0 || !subject.stdout.startsWith(VIEWS_COMMIT_PREFIX)) break;
    const files = await git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"]);
    const names = files.stdout.split(/\r?\n/).filter(Boolean);
    if (files.code !== 0 || names.length === 0 || !names.every((f) => DROPPABLE_VIEW_PATHS.has(f)))
      break;
    const clean = await git(dir, ["status", "--porcelain", "--untracked-files=no"]);
    if (clean.code !== 0 || clean.stdout.trim()) break;
    const reset = await git(dir, ["reset", "--hard", "--quiet", "HEAD~1"]);
    if (reset.code !== 0) break;
    dropped = true;
  }
  return dropped;
}

/**
 * `git pull --rebase` then, when ahead, reconcile the unpushed events against what upstream now
 * holds and `git push`. Never throws; reports { ok, pulled, pushed, error, reconciled }. Callers
 * hold the specs lock. `afterCommit(dir)` (generated register mode) first drops a leftover
 * unpushed views commit and, after the pull, regenerates the views into a fresh views-only commit
 * that rides along with the push.
 */
export async function syncSpecs(dir, { bugIds = new Set(), afterCommit } = {}) {
  let error = null;
  if (afterCommit) await dropViewsTip(dir);
  const pull = await git(dir, ["pull", "--rebase", "--quiet"]);
  if (pull.code !== 0) {
    await abortRebase(dir);
    error = pull.stderr.trim() || `git pull exited ${pull.code}`;
  }
  let pushed = false;
  let reconciled = null;
  const aheadCount = async () => {
    const r = await git(dir, ["rev-list", "--count", "@{u}..HEAD"]);
    return r.code === 0 ? Number(r.stdout.trim()) : 0;
  };
  let canPush = true;
  if (pull.code === 0 && (await aheadCount()) > 0) {
    try {
      reconciled = await reconcileUnpushed(dir, { bugIds });
    } catch (e) {
      canPush = false;
      error ??= `reconcile before push failed: ${e.message}`;
    }
  }
  if (canPush && afterCommit && pull.code === 0) {
    try {
      await afterCommit(dir);
    } catch (e) {
      error ??= `views regeneration failed: ${e.message}`;
    }
  }
  if (canPush && (await aheadCount()) > 0) {
    const p = await git(dir, ["push", "--quiet"]);
    pushed = p.code === 0;
    if (!pushed && !error) error = p.stderr.trim() || `git push exited ${p.code}`;
  }
  return { ok: error === null, pulled: pull.code === 0, pushed, error, reconciled };
}

/** Every events/<machine>/*.jsonl line; unparseable lines come back as `{ __invalid: true, … }`. */
export function readAllEvents(dir) {
  const root = join(dir, "events");
  const out = [];
  if (!existsSync(root)) return out;
  for (const m of readdirSync(root).sort()) {
    const mdir = join(root, m);
    let files;
    try {
      files = readdirSync(mdir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {
      continue; // a stray file in events/
    }
    for (const f of files) {
      const rel = `events/${m}/${f}`;
      const lines = readFileSync(join(mdir, f), "utf8").split(/\r?\n/);
      lines.forEach((raw, i) => {
        if (raw.trim() === "") return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
          else out.push({ __invalid: true, raw, file: rel, line: i + 1 });
        } catch {
          out.push({ __invalid: true, raw, file: rel, line: i + 1 });
        }
      });
    }
  }
  return out;
}

/** Bug ids in the registry on origin/master (empty set when git fails). */
export async function loadBugIds(repoRoot = REPO_ROOT) {
  const r = await git(repoRoot, [
    "ls-tree",
    "--name-only",
    "origin/master",
    ".claude/campaign/bugs/",
  ]);
  const ids = new Set();
  if (r.code !== 0) return ids;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /(?:^|\/)(B\d{1,5})\.[^/]+$/.exec(line.trim());
    if (m) ids.add(m[1]);
  }
  return ids;
}

export class RefusedError extends Error {
  constructor(errors) {
    super(errors.join("; "));
    this.refused = true;
    this.errors = errors;
  }
}

/** Semantic checks against the current state. Returns an array of error strings. */
export function validateAgainstState(ev, state, { bugIds = new Set() } = {}) {
  const errors = [];
  const known = (id) => state.items.has(id) || bugIds.has(id);
  const checkRefs = (fields, self) => {
    if (fields.parent !== undefined && fields.parent !== null) {
      if (fields.parent === self) errors.push("an item cannot be its own parent");
      else if (!known(fields.parent)) errors.push(`parent ${fields.parent} does not exist`);
    }
    if (fields.train !== undefined && fields.train !== null) {
      const t = state.items.get(fields.train);
      if (!t || t.type !== "release")
        errors.push(`train ${fields.train} must be an existing release item`);
    }
  };
  if (ev.kind === "item.new") {
    if (BUG_ID_RE.test(ev.item))
      errors.push(`item id ${ev.item} is a registry bug id; bugs come from the registry`);
    else if (state.items.has(ev.item)) errors.push(`item ${ev.item} already exists`);
    checkRefs(ev.data, ev.item);
  } else if (typeof ev.item === "string") {
    if (!known(ev.item)) errors.push(`unknown item ${ev.item}`);
    else {
      if (ev.kind === "item.edit") checkRefs(ev.data.fields ?? {}, ev.item);
      if (ev.kind === "claim") {
        const held = state.items.get(ev.item)?.claimedBy;
        if (held && held !== ev.lane && !ev.data.steal) {
          const since = new Date(state.items.get(ev.item).claimedAt).toISOString();
          errors.push(`item ${ev.item} is held by ${held} since ${since}; pass --steal to take it`);
        }
      }
    }
  }
  return errors;
}

const fileFor = (ev) => `events/${ev.machine}/${utcDate(Date.parse(ev.ts))}.jsonl`;

function commitMessage(events) {
  const first = events[0];
  const more = events.length > 1 ? ` +${events.length - 1}` : "";
  return `ops(${first.machine}): ${first.kind} ${first.item ?? "-"}${more}`;
}

/** `git commit` with the local-identity fallback. `files` null commits the whole index. */
export async function runCommit(dir, message, files) {
  const commitArgs = [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
    ...(files ? ["--", ...files] : []),
  ];
  let c = await git(dir, commitArgs);
  if (c.code !== 0 && /who you are|empty ident|unable to auto-detect/i.test(c.stderr)) {
    // Tool-owned clone without a git identity: set a local one and retry once.
    await git(dir, ["config", "user.email", "ops-monitor@localhost"]);
    await git(dir, ["config", "user.name", "RouteFlow ops monitor"]);
    c = await git(dir, commitArgs);
  }
  if (c.code !== 0) throw new Error(`git commit failed: ${c.stderr.trim() || c.stdout.trim()}`);
}

async function commitFiles(dir, events, files) {
  const add = await git(dir, ["add", "--", ...files]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  await runCommit(dir, commitMessage(events), files);
}

const REJECTED_RE =
  /\[rejected\]|non-fast-forward|fetch first|stale info|remote contains work|cannot lock ref|failed to update ref|remote rejected/i;

const REF_FIELDS = ["parent", "train"];

/** Applies an id renumbering to one event's item and parent/train references. True when changed. */
function remapRefs(ev, remap) {
  let touched = false;
  if (typeof ev.item === "string" && remap.has(ev.item)) {
    ev.item = remap.get(ev.item);
    touched = true;
  }
  const fields =
    ev.kind === "item.edit" ? ev.data?.fields : ev.kind === "item.new" ? ev.data : null;
  if (fields) {
    for (const k of REF_FIELDS) {
      if (typeof fields[k] === "string" && remap.has(fields[k])) {
        fields[k] = remap.get(fields[k]);
        touched = true;
      }
    }
  }
  return touched;
}

/** The events added by our unpushed commits (`@{u}...HEAD`), in ts order. */
async function unpushedEvents(dir) {
  const d = await git(dir, ["diff", "--unified=0", "--no-color", "@{u}...HEAD", "--", "events"]);
  if (d.code !== 0) throw new Error(`git diff @{u}...HEAD failed: ${d.stderr.trim()}`);
  const ours = [];
  let file = null;
  for (const line of d.stdout.split(/\r?\n/)) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = m[1];
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      try {
        const ev = JSON.parse(line.slice(1));
        if (ev && typeof ev === "object" && !Array.isArray(ev) && typeof ev.id === "string")
          ours.push({ ev, file });
      } catch {
        /* an invalid line is the fold's problem, not ours */
      }
    }
  }
  return ours
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => (Date.parse(a.ev.ts) || 0) - (Date.parse(b.ev.ts) || 0) || a.i - b.i);
}

/**
 * Pre-push integrity pass over EVERY unpushed commit (not just the latest append): re-validates
 * our unpushed events against the working tree minus those events (which, right after a
 * `pull --rebase`, is exactly upstream). An item.new whose id another machine took is renumbered
 * (and same-batch references follow); a claim another lane now holds is dropped. Because nothing
 * is pushed yet, a rewrite is `reset --soft @{u}` plus one re-commit. Callers hold the specs lock.
 * Returns { rewrote, changes: Map old->new, edited: Map eventId->event, dropped: [eventId],
 * refused: [{ event, error }] }.
 */
export async function reconcileUnpushed(dir, { bugIds = new Set() } = {}) {
  const out = { rewrote: false, changes: new Map(), edited: new Map(), dropped: [], refused: [] };
  const ours = await unpushedEvents(dir);
  if (ours.length === 0) return out;
  const ourIds = new Set(ours.map((o) => o.ev.id));
  const others = readAllEvents(dir).filter((e) => !e.__invalid && !ourIds.has(e.id));
  let state = fold(others);
  const kept = [];
  for (const o of ours) {
    const ev = structuredClone(o.ev);
    let touched = remapRefs(ev, out.changes);
    if (ev.kind === "item.new" && state.items.has(ev.item)) {
      const next = nextItemId(state);
      out.changes.set(ev.item, next);
      ev.item = next;
      touched = true;
    }
    const held = validateAgainstState(ev, state, { bugIds }).filter((m) => /is held by/.test(m));
    if (ev.kind === "claim" && held.length) {
      out.dropped.push(ev.id);
      out.refused.push({ event: ev, error: held.join("; ") });
      continue;
    }
    if (touched) out.edited.set(ev.id, ev);
    kept.push(ev);
    state = fold([...others, ...kept]);
  }
  if (out.edited.size === 0 && out.dropped.length === 0) return out;

  const reset = await git(dir, ["reset", "--soft", "@{u}"]);
  if (reset.code !== 0)
    throw new Error(`could not rewind to repair events: ${reset.stderr.trim()}`);
  const dropIds = new Set(out.dropped);
  const files = [...new Set(ours.map((o) => o.file))];
  for (const f of files) {
    const abs = join(dir, f);
    if (!existsSync(abs)) continue;
    const next = [];
    for (const line of readFileSync(abs, "utf8").split("\n")) {
      if (line.trim()) {
        let id = null;
        try {
          id = JSON.parse(line)?.id ?? null;
        } catch {
          /* keep unparseable lines as they are */
        }
        if (id !== null && dropIds.has(id)) continue;
        if (id !== null && out.edited.has(id)) {
          next.push(JSON.stringify(out.edited.get(id)));
          continue;
        }
      }
      next.push(line);
    }
    const text = next.join("\n");
    if (text.trim() === "") rmSync(abs, { force: true });
    else writeFileSync(abs, text);
  }
  const add = await git(dir, ["add", "-A", "--", ...files]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const staged = await git(dir, ["diff", "--cached", "--quiet"]);
  if (staged.code !== 0)
    await runCommit(dir, commitMessage(kept.length ? kept : ours.map((o) => o.ev)), null);
  out.rewrote = true;
  return out;
}

function noteReconciled(rec, warnings) {
  for (const [from, to] of rec.changes)
    warnings.push(`item id ${from} was taken by another machine; re-allocated to ${to}`);
  for (const r of rec.refused)
    warnings.push(`dropped ${r.event.kind} ${r.event.item ?? "-"} (${r.event.id}): ${r.error}`);
}

async function doAppend(events, { dir, push, retries, bugIds, _beforePush, afterCommit }) {
  const warnings = [];
  const refused = []; // our events dropped after the rebase: another lane holds the claim
  const sync = await syncSpecs(dir, { bugIds, afterCommit });
  if (!sync.ok) warnings.push(`sync: ${sync.error}`);
  if (sync.reconciled?.rewrote) noteReconciled(sync.reconciled, warnings);

  const current = readAllEvents(dir);
  let state = fold(current);
  const accepted = [];
  const errors = [];
  for (const input of events) {
    const ev = structuredClone(input);
    if (ev.kind === "item.new" && (ev.item === null || ev.item === undefined))
      ev.item = nextItemId(state);
    const errs = [...validateEvent(ev).errors, ...validateAgainstState(ev, state, { bugIds })];
    if (errs.length) {
      errors.push(...errs.map((m) => `${ev.kind}${ev.item ? ` ${ev.item}` : ""}: ${m}`));
      continue;
    }
    accepted.push(ev);
    state = fold([...current, ...accepted]);
  }
  if (errors.length) throw new RefusedError(errors);

  const files = new Map(); // relative file -> text to append
  for (const ev of accepted) {
    const f = fileFor(ev);
    files.set(f, (files.get(f) ?? "") + JSON.stringify(ev) + "\n");
  }
  for (const [f, text] of files) {
    const abs = join(dir, f);
    mkdirSync(dirname(abs), { recursive: true });
    let prefix = "";
    if (existsSync(abs)) {
      const cur = readFileSync(abs, "utf8");
      if (cur.length > 0 && !cur.endsWith("\n")) prefix = "\n";
    }
    appendFileSync(abs, prefix + text);
  }
  await commitFiles(dir, accepted, [...files.keys()]);
  // Generated register mode: the views go into a SECOND, views-only commit above the events.
  const regenerate = async () => {
    if (!afterCommit) return;
    try {
      await afterCommit(dir);
    } catch (e) {
      warnings.push(`views regeneration failed (events kept): ${e.message}`);
    }
  };
  await regenerate();

  let pushed = false;
  let attempts = 0;
  if (push) {
    if (_beforePush) await _beforePush();
    for (attempts = 1; attempts <= retries; attempts++) {
      const p = await git(dir, ["push", "--quiet", "origin", "HEAD"]);
      if (p.code === 0) {
        pushed = true;
        break;
      }
      if (!REJECTED_RE.test(p.stderr)) {
        warnings.push(`push failed (kept local): ${p.stderr.trim().split("\n").pop()}`);
        break;
      }
      await sleep(50 + Math.floor(Math.random() * 250));
      // A rejected push with a views-only commit on top: drop it (disposable, regenerated below)
      // so the events replay on their own. Only an otherwise clean tree is touched.
      if (afterCommit) await dropViewsTip(dir);
      const pl = await git(dir, ["pull", "--rebase", "--quiet"]);
      if (pl.code !== 0) {
        await abortRebase(dir);
        throw new Error(`pull --rebase failed after a rejected push: ${pl.stderr.trim()}`);
      }
      let rec;
      try {
        rec = await reconcileUnpushed(dir, { bugIds });
      } catch (e) {
        warnings.push(`push skipped (kept local): ${e.message}`);
        break;
      }
      if (rec.rewrote) {
        noteReconciled(rec, warnings);
        for (let i = accepted.length - 1; i >= 0; i--) {
          const ev = accepted[i];
          if (rec.edited.has(ev.id)) accepted[i] = rec.edited.get(ev.id);
          if (rec.dropped.includes(ev.id)) accepted.splice(i, 1);
        }
        const mine = new Set(events.map((e) => e.id));
        for (const r of rec.refused) if (mine.has(r.event.id)) refused.push(r);
      }
      await regenerate();
    }
    if (!pushed && attempts > retries)
      warnings.push(`push still rejected after ${retries} attempts (kept local)`);
  }
  return { events: accepted, pushed, attempts: Math.min(attempts, retries), warnings, refused };
}

/**
 * Validates, writes, commits and (by default) pushes events to the specs clone, under the lock.
 * An item.new with a null `item` gets the next free numeric id. Throws RefusedError (all-or-nothing)
 * when any event fails validation.
 */
export async function appendEvents(
  events,
  {
    dir = specsDir(),
    push = true,
    retries = 5,
    home,
    bugIds = new Set(),
    _beforePush,
    afterCommit,
  } = {},
) {
  if (!events || events.length === 0)
    return { events: [], pushed: false, attempts: 0, warnings: [], refused: [] };
  return withSpecsLock(
    () => doAppend(events, { dir, push, retries, bugIds, _beforePush, afterCommit }),
    { home },
  );
}
