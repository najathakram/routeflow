// IO for the ops monitor: child processes, the tool-owned routeflow-specs clone, the lock, and
// appending events (one commit per call, push with rebase retry, item-id collision repair).
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Runs `fn` while holding <home>/specs.lock (a mkdir lock, stale after staleMs). The lock dir is
 * removed in a finally, whatever fn does.
 */
export async function withSpecsLock(
  fn,
  { home, staleMs = 120000, waitMs = 30000, pollMs = 100 } = {},
) {
  const h = home ?? opsHome();
  mkdirSync(h, { recursive: true });
  const lock = join(h, "specs.lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // vanished between mkdir and stat: retry now
      }
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
      if (Date.now() - start > waitMs)
        throw new Error(`could not acquire specs lock ${lock} within ${waitMs} ms`);
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
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

/** `git pull --rebase` then `git push` when ahead. Never throws; reports { ok, pulled, pushed, error }. */
export async function syncSpecs(dir) {
  let error = null;
  const pull = await git(dir, ["pull", "--rebase", "--quiet"]);
  if (pull.code !== 0) {
    await abortRebase(dir);
    error = pull.stderr.trim() || `git pull exited ${pull.code}`;
  }
  let pushed = false;
  const ahead = await git(dir, ["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) {
    const p = await git(dir, ["push", "--quiet"]);
    pushed = p.code === 0;
    if (!pushed && !error) error = p.stderr.trim() || `git push exited ${p.code}`;
  }
  return { ok: error === null, pulled: pull.code === 0, pushed, error };
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

async function commitFiles(dir, events, files) {
  const add = await git(dir, ["add", "--", ...files]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const commitArgs = [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    commitMessage(events),
    "--",
    ...files,
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

const REJECTED_RE =
  /\[rejected\]|non-fast-forward|fetch first|stale info|remote contains work|cannot lock ref|failed to update ref|remote rejected/i;

/** Re-allocates item.new ids that another machine took while we were rebasing. Returns the changes. */
function repairCollisions(dir, accepted) {
  const mine = new Set(accepted.map((e) => e.id));
  const others = readAllEvents(dir).filter((e) => !e.__invalid && !mine.has(e.id));
  const taken = new Set(others.filter((e) => e.kind === "item.new").map((e) => e.item));
  const changes = new Map(); // old id -> new id
  const resolved = [];
  for (const ev of accepted) {
    if (ev.kind === "item.new" && taken.has(ev.item) && !changes.has(ev.item)) {
      const next = nextItemId(
        fold([
          ...others,
          ...resolved,
          ...accepted.filter((a) => a.kind === "item.new" && !taken.has(a.item)),
        ]),
      );
      changes.set(ev.item, next);
      taken.add(next);
    }
    resolved.push(ev);
  }
  return changes;
}

async function doAppend(events, { dir, push, retries, bugIds, _beforePush }) {
  const warnings = [];
  const sync = await syncSpecs(dir);
  if (!sync.ok) warnings.push(`sync: ${sync.error}`);

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
      const pl = await git(dir, ["pull", "--rebase", "--quiet"]);
      if (pl.code !== 0) {
        await abortRebase(dir);
        throw new Error(`pull --rebase failed after a rejected push: ${pl.stderr.trim()}`);
      }
      const changes = repairCollisions(dir, accepted);
      if (changes.size > 0) {
        const reset = await git(dir, ["reset", "--soft", "HEAD~1"]);
        if (reset.code !== 0)
          throw new Error(`could not rewind to re-allocate ids: ${reset.stderr.trim()}`);
        for (const ev of accepted) {
          if (changes.has(ev.item)) ev.item = changes.get(ev.item);
          const d = ev.kind === "item.edit" ? ev.data.fields : ev.data;
          if (["item.new", "item.edit"].includes(ev.kind) && changes.has(d.parent))
            d.parent = changes.get(d.parent);
        }
        const byId = new Map(accepted.map((e) => [e.id, e]));
        for (const f of files.keys()) {
          const abs = join(dir, f);
          const out = readFileSync(abs, "utf8")
            .split("\n")
            .map((line) => {
              if (!line.trim()) return line;
              try {
                const parsed = JSON.parse(line);
                return byId.has(parsed.id) ? JSON.stringify(byId.get(parsed.id)) : line;
              } catch {
                return line;
              }
            })
            .join("\n");
          writeFileSync(abs, out);
        }
        await commitFiles(dir, accepted, [...files.keys()]);
        for (const [from, to] of changes)
          warnings.push(`item id ${from} was taken by another machine; re-allocated to ${to}`);
      }
    }
    if (!pushed && attempts > retries)
      warnings.push(`push still rejected after ${retries} attempts (kept local)`);
  }
  return { events: accepted, pushed, attempts: Math.min(attempts, retries), warnings };
}

/**
 * Validates, writes, commits and (by default) pushes events to the specs clone, under the lock.
 * An item.new with a null `item` gets the next free numeric id. Throws RefusedError (all-or-nothing)
 * when any event fails validation.
 */
export async function appendEvents(
  events,
  { dir = specsDir(), push = true, retries = 5, home, bugIds = new Set(), _beforePush } = {},
) {
  if (!events || events.length === 0)
    return { events: [], pushed: false, attempts: 0, warnings: [] };
  return withSpecsLock(() => doAppend(events, { dir, push, retries, bugIds, _beforePush }), {
    home,
  });
}
