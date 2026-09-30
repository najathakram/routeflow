/**
 * The `ctl/state` branch (spec §1, §8): clone, fold, validate, append one line, commit, push.
 * Never merges, never stashes, never force-pushes; every write is validated first (exit 3/4).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fold } from "../domain/fold";
import { validateEvents } from "../domain/validate";
import type { EventFile, RegisterTask } from "../domain/validate";
import { MAX_LINE_BYTES } from "../domain/schema";
import type { ControlEvent, ControlState } from "../domain/types";
import { denylistHit } from "./denylist";
import {
  CTL_IDENTITY,
  CtlError,
  assertBranchName,
  assertLaneName,
  assertOrigin,
  git,
  gitAnywhere,
  gitTry,
} from "./git";
import type { Env } from "./git";
import { withLock } from "./lock";

export { CtlError } from "./git";
export type { Env } from "./git";

/** What a caller supplies: everything except the envelope fields the branch owns. */
export interface Draft {
  type: string;
  by: string;
  sha?: string;
  note?: string;
  [key: string]: unknown;
}

const LOCK_STALE_MS = 30_000;
const MAX_ATTEMPTS = 6;
const LANE_FILE_RE = /^([a-z0-9][a-z0-9._-]{0,40})\.jsonl$/;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nul = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/* ------------------------------------------------------------------ tree reading */

export interface SnapshotFile {
  v: 1;
  at: string;
  sha: string | null;
  seqByLane: Record<string, number>;
  tasks: unknown;
  lanes: unknown;
  releases: unknown;
  acks: unknown;
  version: string;
  /** Slimmed history (inert `note` text dropped, `lane` implied by the key), per lane. */
  replay: Record<string, Record<string, unknown>[]>;
}

export interface LaneData {
  /** Events folded into the snapshot (lane restored), oldest first. */
  replay: ControlEvent[];
  /** Raw non-empty lines of the live segment, header included. */
  live: string[];
  /** Live events parsed (header excluded). */
  liveEvents: ControlEvent[];
  /** `from` of the live segment header, if any. */
  headerFrom: number | null;
}

export interface Tree {
  snap: SnapshotFile | null;
  lanes: Record<string, LaneData>;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export function readSnapshot(dir: string): SnapshotFile | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
    if (isObj(v) && isObj(v.replay) && isObj(v.seqByLane) && typeof v.at === "string") {
      return v as unknown as SnapshotFile;
    }
  } catch {
    /* absent or unreadable: treat as no snapshot */
  }
  return null;
}

/** Read a checkout: snapshot replay plus the live segments. */
export function readTree(dir: string): Tree {
  const snap = readSnapshot(dir);
  const lanes = nul<LaneData>();
  const get = (lane: string): LaneData =>
    (lanes[lane] ??= { replay: [], live: [], liveEvents: [], headerFrom: null });
  if (snap) {
    for (const lane of Object.keys(snap.replay)) {
      if (!LANE_FILE_RE.test(`${lane}.jsonl`)) continue;
      for (const e of snap.replay[lane]) get(lane).replay.push({ ...e, lane } as ControlEvent);
    }
    for (const lane of Object.keys(snap.seqByLane)) get(lane);
  }
  const evDir = path.join(dir, "events");
  let names: string[] = [];
  try {
    names = fs.readdirSync(evDir).sort(cmp);
  } catch {
    /* no events dir yet */
  }
  for (const n of names) {
    const m = LANE_FILE_RE.exec(n);
    if (!m) continue;
    const d = get(m[1]);
    const text = fs.readFileSync(path.join(evDir, n), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.trim() === "") continue;
      d.live.push(line);
      const o = parseLine(line);
      if (!o) continue;
      if (o.type === "segment") {
        if (typeof o.from === "number") d.headerFrom = o.from;
        continue;
      }
      d.liveEvents.push(o as ControlEvent);
    }
  }
  return { snap, lanes };
}

/** Last seq used on a lane (0 when absent); a header-only segment continues from `from - 1`. */
export function lastSeq(tree: Tree, lane: string): number {
  const d = tree.lanes[lane];
  if (!d) return 0;
  let best = 0;
  const snapSeq = tree.snap?.seqByLane[lane];
  if (typeof snapSeq === "number") best = Math.max(best, snapSeq);
  for (const e of d.replay) if (typeof e.seq === "number") best = Math.max(best, e.seq);
  if (d.headerFrom !== null) best = Math.max(best, d.headerFrom - 1);
  for (const e of d.liveEvents) if (typeof e.seq === "number") best = Math.max(best, e.seq);
  return best;
}

function eventsOf(
  tree: Tree,
  extra?: Record<string, ControlEvent[]>,
): Record<string, ControlEvent[]> {
  const out = nul<ControlEvent[]>();
  for (const lane of Object.keys(tree.lanes)) {
    const d = tree.lanes[lane];
    out[lane] = [...d.replay, ...d.liveEvents];
  }
  if (extra)
    for (const lane of Object.keys(extra)) out[lane] = [...(out[lane] ?? []), ...extra[lane]];
  return out;
}

function maxTs(byLane: Record<string, ControlEvent[]>): string {
  let best = "";
  for (const lane of Object.keys(byLane)) {
    for (const e of byLane[lane]) if (typeof e.ts === "string" && e.ts > best) best = e.ts;
  }
  return best || "1970-01-01T00:00:00Z";
}

function foldTree(
  tree: Tree,
  registers: Env["registers"],
  now: string | undefined,
  extra?: Record<string, ControlEvent[]>,
): ControlState {
  const byLane = eventsOf(tree, extra);
  return fold(
    { tasks: registers.tasks, releases: registers.releases },
    byLane,
    null,
    null,
    now ?? tree.snap?.at ?? maxTs(byLane),
  );
}

/**
 * fold(snapshot + live segments) for a checkout. `now` defaults to the snapshot's `at`, else the
 * newest event time, so the result is a pure function of the tree.
 */
export function foldDir(dir: string, registers: Env["registers"], now?: string): ControlState {
  return foldTree(readTree(dir), registers, now);
}

/* ------------------------------------------------------------------ clone handling */

function checkEnv(env: Env): void {
  assertOrigin(env.origin);
  assertBranchName(env.stateBranch);
  assertBranchName(env.archiveBranch);
}

/** Clone the state branch on first use (single branch, depth 50); idempotent and race-safe. */
export async function ensureClone(env: Env): Promise<string> {
  checkEnv(env);
  const dir = path.resolve(env.cloneDir);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await withLock(`${dir}.clone.lock`, LOCK_STALE_MS, () => {
      if (fs.existsSync(path.join(dir, ".git"))) return;
      const r = gitAnywhere([
        "clone",
        "-q",
        "--single-branch",
        "--branch",
        env.stateBranch,
        "--depth",
        "50",
        "--",
        env.origin,
        dir,
      ]);
      if (!r.ok) throw new CtlError(5, `clone failed: ${r.err.trim()}`);
    });
  }
  // keep our lock/parking files out of `git add -A`
  const info = path.join(dir, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  const exclude = path.join(info, "exclude");
  let cur = "";
  try {
    cur = fs.readFileSync(exclude, "utf8");
  } catch {
    /* none yet */
  }
  const want = [".ctl.lock", ".ctl.lock/", "pending/"].filter((l) => !cur.split("\n").includes(l));
  if (want.length > 0) {
    fs.writeFileSync(
      exclude,
      cur + (cur === "" || cur.endsWith("\n") ? "" : "\n") + want.join("\n") + "\n",
    );
  }
  return dir;
}

/** Fetch the state branch and hard-reset the checkout to it (never merge, never stash). */
export function syncClone(env: Env, clone: string): void {
  const b = env.stateBranch;
  git(clone, [
    "fetch",
    "-q",
    "--depth",
    "50",
    "origin",
    `+refs/heads/${b}:refs/remotes/origin/${b}`,
  ]);
  git(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${b}`]);
  git(clone, ["clean", "-fdq"]);
}

export const lockDirOf = (clone: string): string => path.join(clone, ".ctl.lock");
/** Backoff for retry `attempt` (1-based): 500 ms * 2^(n-1), jitter +/-20%. */
export const appendRetrySleep = (attempt: number): number =>
  500 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ pending (parked) lines */

function pendingDir(clone: string): string {
  return path.join(clone, "pending");
}

/** Keep a draft that could not be pushed; the next call drains it first. */
export function park(clone: string, lane: string, draft: Record<string, unknown>): void {
  assertLaneName(lane);
  fs.mkdirSync(pendingDir(clone), { recursive: true });
  fs.appendFileSync(path.join(pendingDir(clone), `${lane}.jsonl`), JSON.stringify(draft) + "\n");
}

interface PendingItem {
  lane: string;
  draft: Record<string, unknown>;
  raw: string;
}

function readPending(clone: string): { items: PendingItem[]; files: string[] } {
  const items: PendingItem[] = [];
  const files: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(pendingDir(clone)).sort(cmp);
  } catch {
    return { items, files };
  }
  for (const n of names) {
    const m = LANE_FILE_RE.exec(n);
    if (!m) continue;
    const file = path.join(pendingDir(clone), n);
    files.push(file);
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      const o = parseLine(raw);
      if (o) items.push({ lane: m[1], draft: o, raw });
      else items.push({ lane: m[1], draft: {}, raw });
    }
  }
  return { items, files };
}

/* ------------------------------------------------------------------ validation */

function contextOf(env: Env) {
  const tasks: RegisterTask[] = env.registers.tasks.map((t) => ({
    id: t.id,
    status: t.status,
    release: t.release ?? null,
  }));
  return { tasks, releaseIds: env.registers.releases.map((r) => r.id), denylistHit };
}

/** Per-lane file texts of the whole history (snapshot replay + live), ready for validateEvents. */
function textsOf(tree: Tree, added: Record<string, string[]>): EventFile[] {
  const lanes = new Set<string>([...Object.keys(tree.lanes), ...Object.keys(added)]);
  const files: EventFile[] = [];
  for (const lane of [...lanes].sort(cmp)) {
    const d = tree.lanes[lane];
    const lines: string[] = [];
    if (d) {
      for (const e of d.replay) lines.push(JSON.stringify(e));
      for (const l of d.live) {
        if (d.replay.length > 0 && parseLine(l)?.type === "segment") continue;
        lines.push(l);
      }
    }
    for (const l of added[lane] ?? []) lines.push(l);
    if (lines.length > 0) files.push({ file: `${lane}.jsonl`, text: lines.join("\n") + "\n" });
  }
  return files;
}

/** Errors the additions introduce (same error on the same history line does not count). */
function newErrors(
  env: Env,
  tree: Tree,
  added: Record<string, string[]>,
): { file: string; line: number; reason: string }[] {
  const ctx = contextOf(env);
  const key = (e: { file: string; line: number; reason: string }) =>
    `${e.file}|${e.line}|${e.reason}`;
  const before = new Set(validateEvents(textsOf(tree, {}), ctx).map(key));
  return validateEvents(textsOf(tree, added), ctx).filter((e) => !before.has(key(e)));
}

interface Built {
  lane: string;
  ev: ControlEvent;
  line: string;
}

function buildEvent(
  lane: string,
  seq: number,
  ts: string,
  draft: Record<string, unknown>,
  id?: string,
): ControlEvent {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(draft))
    if (k !== "seq" && k !== "ts" && k !== "lane") rest[k] = draft[k];
  if (id !== undefined) rest.id = id;
  return { seq, ts, lane, ...rest } as ControlEvent;
}

/** Size + denylist checks on a serialized line; returns a CtlError or null. */
function lineProblem(line: string): CtlError | null {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return new CtlError(3, "event line > 1024 bytes");
  const hit = denylistHit(line);
  return hit ? new CtlError(4, `refused: ${hit}`) : null;
}

/* ------------------------------------------------------------------ append and push */

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function appendLines(file: string, lines: string[]): void {
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  if (cur !== "" && !cur.endsWith("\n")) cur += "\n";
  writeAtomic(file, cur + lines.join("\n") + "\n");
}

const REJECTED = "rejected.jsonl";

export async function appendAndPush(
  env: Env,
  lane: string,
  draft: Draft,
  mint?: (state: ControlState) => string,
): Promise<ControlEvent> {
  assertLaneName(lane);
  const clone = await ensureClone(env);
  const sleep = (ms: number): Promise<void> => (env.sleep ? env.sleep(ms) : defaultSleep(ms));
  return withLock(lockDirOf(clone), LOCK_STALE_MS, async () => {
    let lastId: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        syncClone(env, clone);
      } catch (e) {
        park(clone, lane, draft);
        throw new CtlError(5, `${(e as Error).message}; event parked in pending/`);
      }
      const tree = readTree(clone);
      const ts = env.now();
      const next = nul<number>();
      const seqOf = (l: string) => (next[l] ??= lastSeq(tree, l));
      const added = nul<string[]>();
      const extra = nul<ControlEvent[]>();
      const builtAll: Built[] = [];
      const push = (b: Built) => {
        (added[b.lane] ??= []).push(b.line);
        (extra[b.lane] ??= []).push(b.ev);
        builtAll.push(b);
      };

      // 1. drain parked drafts (any that is no longer valid is set aside, never silently lost)
      const pend = readPending(clone);
      const rejected: string[] = [];
      const materialize = (items: PendingItem[]): Built[] => {
        const n = nul<number>();
        return items.map((item) => {
          n[item.lane] = (n[item.lane] ?? lastSeq(tree, item.lane)) + 1;
          const ev = buildEvent(item.lane, n[item.lane], ts, item.draft);
          return { lane: item.lane, ev, line: JSON.stringify(ev) };
        });
      };
      let items = pend.items.filter((it) => {
        const ok =
          Object.keys(it.draft).length > 0 &&
          !lineProblem(JSON.stringify(buildEvent(it.lane, 1, ts, it.draft)));
        if (!ok) rejected.push(it.raw);
        return ok;
      });
      for (let guard = 0; items.length > 0 && guard <= pend.items.length; guard++) {
        const built = materialize(items);
        const probe = nul<string[]>();
        const at = built.map((b) => (probe[b.lane] ??= []).push(b.line) - 1);
        const errs = newErrors(env, tree, probe);
        if (errs.length === 0) break;
        const bad = new Set<number>();
        for (const e of errs) {
          built.forEach((b, i) => {
            if (e.file === `${b.lane}.jsonl` && e.line === textsLines(tree, b.lane) + at[i] + 1) {
              bad.add(i);
            }
          });
        }
        if (bad.size === 0) bad.add(items.length - 1); // unattributable: set the newest aside
        for (const i of bad) rejected.push(items[i].raw);
        items = items.filter((_, i) => !bad.has(i));
      }
      for (const b of materialize(items)) {
        next[b.lane] = b.ev.seq;
        push(b);
      }

      // 2. the current event, minted against the state that includes the drained lines
      const state = foldTree(tree, env.registers, ts, extra);
      lastId = mint ? mint(state) : undefined;
      const ev = buildEvent(lane, seqOf(lane) + 1, ts, draft, lastId);
      const line = JSON.stringify(ev);
      const prob = lineProblem(line);
      if (prob) throw prob;
      push({ lane, ev, line });
      const errs = newErrors(env, tree, added);
      if (errs.length > 0) {
        throw new CtlError(3, errs.map((e) => `${e.file}:${e.line} ${e.reason}`).join("; "));
      }

      // 3. write (atomic), commit, push
      for (const l of Object.keys(added)) {
        appendLines(path.join(clone, "events", `${l}.jsonl`), added[l]);
      }
      git(clone, ["add", "-A"]);
      const extraN = builtAll.length - 1;
      const msg =
        `ctl(${lane}): #${ev.seq} ${ev.type} ${typeof ev.task === "string" ? ev.task : ""}`.trim() +
        (extraN > 0 ? ` (+${extraN} parked)` : "");
      git(clone, [...CTL_IDENTITY, "commit", "-q", "--no-verify", "-m", msg]);
      const pushed = gitTry(clone, ["push", "-q", "origin", `HEAD:refs/heads/${env.stateBranch}`]);
      if (pushed.ok) {
        for (const f of pend.files) fs.rmSync(f, { force: true });
        if (rejected.length > 0) {
          fs.mkdirSync(pendingDir(clone), { recursive: true });
          fs.appendFileSync(path.join(pendingDir(clone), REJECTED), rejected.join("\n") + "\n");
          process.stderr.write(
            `ctl: ${rejected.length} parked line(s) set aside in pending/${REJECTED}\n`,
          );
        }
        return ev;
      }
      const rejectedPush = /non-fast-forward|fetch first|rejected/.test(pushed.err);
      if (!rejectedPush) {
        resetQuiet(env, clone);
        park(clone, lane, { ...draft, ...(lastId !== undefined ? { id: lastId } : {}) });
        throw new CtlError(5, `${pushed.err.trim()}; event parked in pending/`);
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(appendRetrySleep(attempt));
      }
    }
    resetQuiet(env, clone);
    park(clone, lane, { ...draft, ...(lastId !== undefined ? { id: lastId } : {}) });
    throw new CtlError(5, "push exhausted; event parked in pending/");
  });
}

/** Drop our unpushed local commit so the checkout is back at origin. */
function resetQuiet(env: Env, clone: string): void {
  gitTry(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${env.stateBranch}`]);
  gitTry(clone, ["clean", "-fdq"]);
}

/** Number of history lines a lane's validation file has before any additions. */
function textsLines(tree: Tree, lane: string): number {
  const f = textsOf(tree, {}).find((x) => x.file === `${lane}.jsonl`);
  return f ? f.text.split("\n").filter((l) => l !== "").length : 0;
}
