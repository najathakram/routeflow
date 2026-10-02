/**
 * The `ctl/state` branch (spec §1, §8): clone, fold, validate, append one line, commit, push.
 * Never merges, never stashes, never force-pushes; every write is validated first (exit 3/4).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { foldEvents, project } from "../domain/fold";
import type { FoldAcc } from "../domain/fold";
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
  cloneTimeoutMs,
  git,
  gitAnywhere,
  gitTry,
  withMovedHint,
} from "./git";
import type { Env } from "./git";
import { assertEnvOrigin } from "./origin";
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

const RENAME_RETRIES = 8;

/**
 * Rename a directory. On Windows only, retry the transient refusals it gives while a virus scanner,
 * the search indexer or a just-exited git child still holds a handle inside it (EPERM / EBUSY /
 * EACCES; a clone is renamed into place right after git exits). On POSIX this is a direct rename
 * with no retry and no sleep: a rename there never raises those codes for this, and the back-off
 * blocks the thread (Atomics.wait), which a Linux server must never pay. Anything else, and the
 * last failure, is thrown unchanged. `rename` / `sleep` / `win` are seams for the spec.
 */
export function renameDirRetrying(
  from: string,
  to: string,
  rename: (a: string, b: string) => void = fs.renameSync,
  sleep: (ms: number) => void = (ms) =>
    void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  win: boolean = process.platform === "win32",
): void {
  if (!win) {
    rename(from, to);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= RENAME_RETRIES) throw e;
      sleep(50 * (attempt + 1));
    }
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nul = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/* ------------------------------------------------------------------ tree reading */

export interface SnapshotFile {
  v: 2;
  at: string;
  sha: string | null;
  seqByLane: Record<string, number>;
  /** The resume accumulator: fold(snapshot + live segments) == fold(all events). */
  acc: FoldAcc;
}

export interface LaneData {
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

function validSnapshot(v: unknown): v is SnapshotFile {
  if (!isObj(v) || v.v !== 2 || typeof v.at !== "string" || !isObj(v.seqByLane)) return false;
  const a = v.acc;
  return (
    isObj(a) &&
    a.v === 1 &&
    isObj(a.tracks) &&
    isObj(a.taskOv) &&
    isObj(a.created) &&
    isObj(a.lanes) &&
    isObj(a.lastByLane) &&
    Array.isArray(a.timeline) &&
    Array.isArray(a.warnings) &&
    Array.isArray(a.mintedIds) &&
    typeof a.maxTs === "string"
  );
}

/** snapshot.json of a checkout: null when absent; a present-but-broken one is a hard refusal. */
export function readSnapshot(dir: string): SnapshotFile | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "snapshot.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CtlError(3, `INVALID snapshot: ${(e as Error).message}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CtlError(3, "INVALID snapshot: not JSON");
  }
  if (!validSnapshot(v)) throw new CtlError(3, "INVALID snapshot: wrong shape or version");
  return v;
}

/** Read a checkout: the snapshot plus the live segments. */
export function readTree(dir: string): Tree {
  const snap = readSnapshot(dir);
  const lanes = nul<LaneData>();
  const get = (lane: string): LaneData =>
    (lanes[lane] ??= { live: [], liveEvents: [], headerFrom: null });
  if (snap) for (const lane of Object.keys(snap.acc.lastByLane)) get(lane);
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
  let best = 0;
  const seen = tree.snap?.acc.lastByLane[lane];
  if (seen) best = Math.max(best, seen.seq);
  const snapSeq = tree.snap?.seqByLane[lane];
  if (typeof snapSeq === "number") best = Math.max(best, snapSeq);
  const d = tree.lanes[lane];
  if (!d) return best;
  if (d.headerFrom !== null) best = Math.max(best, d.headerFrom - 1);
  for (const e of d.liveEvents) if (typeof e.seq === "number") best = Math.max(best, e.seq);
  return best;
}

/** Newest event time on the tip (snapshot + live): new events may not sort before it. */
export function tipMaxTs(tree: Tree): string {
  let best = tree.snap?.acc.maxTs ?? "";
  for (const lane of Object.keys(tree.lanes)) {
    for (const e of tree.lanes[lane].liveEvents)
      if (typeof e.ts === "string" && e.ts > best) best = e.ts;
  }
  return best;
}

export function liveEvents(
  tree: Tree,
  extra?: Record<string, ControlEvent[]>,
): Record<string, ControlEvent[]> {
  const out = nul<ControlEvent[]>();
  for (const lane of Object.keys(tree.lanes)) out[lane] = [...tree.lanes[lane].liveEvents];
  if (extra)
    for (const lane of Object.keys(extra)) out[lane] = [...(out[lane] ?? []), ...extra[lane]];
  return out;
}

function foldTree(
  tree: Tree,
  registers: Env["registers"],
  now: string | undefined,
  extra?: Record<string, ControlEvent[]>,
): ControlState {
  const base = { tasks: registers.tasks, releases: registers.releases };
  const acc = foldEvents(tree.snap?.acc ?? null, base, liveEvents(tree, extra));
  return project(
    acc,
    base,
    null,
    null,
    now ?? tree.snap?.at ?? (acc.maxTs || "1970-01-01T00:00:00Z"),
  );
}

/**
 * fold(snapshot + live segments) for a checkout, via the resume path. `now` defaults to the
 * snapshot's `at`, else the newest event time, so the result is a pure function of the tree.
 */
export function foldDir(dir: string, registers: Env["registers"], now?: string): ControlState {
  return foldTree(readTree(dir), registers, now);
}

/* ------------------------------------------------------------------ clone handling */

/**
 * Every entry point that clones, fetches or pushes the state starts here. The origin gets the same
 * refusal as `ctl origin set` (the product repo, ext::/fd::, insteadOf aliases of it), so an `Env`
 * built by hand cannot bypass the CLI/config validation. The server's separate master clone (the
 * product repo, on purpose) never goes through an `Env`, so it is not subject to this.
 */
function checkEnv(env: Env): void {
  assertOrigin(env.origin);
  assertEnvOrigin(env.origin);
  assertBranchName(env.stateBranch);
  assertBranchName(env.archiveBranch);
}

const CLONE_MARKER = "ctl-clone-complete";
const OWNER_FILE = "ctl-owned";

const notOurs = (dir: string): CtlError =>
  new CtlError(5, `state dir ${dir} is not a ctl clone; move it or set CONTROL_STATE_DIR`);

/** `remote get-url origin` of a clone, probed against its own .git only (never a parent repo). */
function originOf(dir: string): string | null {
  const r = gitTry(dir, ["--git-dir", path.join(dir, ".git"), "remote", "get-url", "origin"]);
  return r.ok ? r.out.trim() : null;
}

function ownerFileMatches(dir: string, origin: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, ".git", OWNER_FILE), "utf8").trim() === origin;
  } catch {
    return false;
  }
}

/** True only for a clone this tool made (ctl-owned names the origin) that still points there. */
export function isOwned(env: Env, dir: string): boolean {
  return ownerFileMatches(dir, env.origin) && originOf(dir) === env.origin;
}

/** Refuse (touching nothing) unless `dir` is our clone: the gate before any reset/clean/remove. */
export function assertOwned(env: Env, dir: string): void {
  if (!isOwned(env, dir)) throw notOurs(dir);
}

/** A clone dir with usable refs and no leftover lock files (probed against its own .git only). */
function cloneUsable(dir: string, branch: string): boolean {
  const gitDir = path.join(dir, ".git");
  for (const l of ["shallow.lock", "index.lock", "HEAD.lock"]) {
    if (fs.existsSync(path.join(gitDir, l))) return false;
  }
  const probe = (ref: string) =>
    gitTry(dir, ["--git-dir", gitDir, "rev-parse", "--verify", "-q", ref]).ok;
  return probe("HEAD") && probe(`refs/remotes/origin/${branch}`);
}

const markOurs = (dir: string, origin: string): void => {
  fs.writeFileSync(path.join(dir, ".git", OWNER_FILE), origin + "\n");
  fs.writeFileSync(path.join(dir, ".git", CLONE_MARKER), "ok\n");
};

/**
 * Clone the state branch on first use (single branch, depth 50). The whole check-and-clone runs
 * under the clone lock. The clone is made in a private sibling dir and renamed into place after
 * its ownership file (.git/ctl-owned = the origin) and completion marker are written, so a dir
 * that is not ours is never removed, reset or cleaned: it is refused (exit 5) untouched. An
 * existing dir is refused unless it carries our ctl-owned stamp; our own broken half-clone is
 * removed and redone.
 */
export async function ensureClone(env: Env): Promise<string> {
  checkEnv(env);
  const dir = path.resolve(env.cloneDir);
  const marker = path.join(dir, ".git", CLONE_MARKER);
  if (!(fs.existsSync(marker) && isOwned(env, dir))) {
    await withLock(`${dir}.clone.lock`, LOCK_STALE_MS, () => {
      if (fs.existsSync(marker) && isOwned(env, dir)) return;
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        if (entries.length > 0) {
          // only a dir the ctl created and stamped is ever touched: no adoption, even of a
          // same-origin clone (its uncommitted work would be reset and cleaned)
          if (!fs.existsSync(path.join(dir, ".git")) || !ownerFileMatches(dir, env.origin)) {
            throw notOurs(dir);
          }
          if (originOf(dir) === env.origin && cloneUsable(dir, env.stateBranch)) {
            markOurs(dir, env.origin); // ours, complete, only the marker was missing
            return;
          }
          fs.rmSync(dir, { recursive: true, force: true }); // our own crashed half-clone
        } else {
          fs.rmdirSync(dir);
        }
      }
      const parent = path.dirname(dir);
      fs.mkdirSync(parent, { recursive: true });
      const tmpPrefix = `${path.basename(dir)}.ctl-tmp-`;
      for (const n of fs.readdirSync(parent)) {
        if (n.startsWith(tmpPrefix))
          fs.rmSync(path.join(parent, n), { recursive: true, force: true });
      }
      const tmp = path.join(parent, tmpPrefix + randomBytes(4).toString("hex"));
      const r = gitAnywhere(
        [
          "clone",
          "-q",
          "-c",
          "core.autocrlf=false",
          "--single-branch",
          "--branch",
          env.stateBranch,
          "--depth",
          "50",
          "--",
          env.origin,
          tmp,
        ],
        { timeoutMs: cloneTimeoutMs() },
      );
      if (!r.ok) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new CtlError(5, withMovedHint(`clone failed: ${r.err.trim()}`));
      }
      markOurs(tmp, env.origin);
      renameDirRetrying(tmp, dir);
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
  checkEnv(env);
  assertOwned(env, clone);
  const b = env.stateBranch;
  // a git call killed by its timeout can leave the index lock behind; we hold the clone lock
  fs.rmSync(path.join(clone, ".git", "index.lock"), { force: true });
  git(
    clone,
    ["fetch", "-q", "--depth", "50", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`],
    { timeoutMs: cloneTimeoutMs() },
  );
  git(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${b}`]);
  git(clone, ["clean", "-fdq"]);
}

export const lockDirOf = (clone: string): string => path.join(clone, ".ctl.lock");
/** Backoff for retry `attempt` (1-based): 500 ms * 2^(n-1), jitter +/-20%. */
export const appendRetrySleep = (attempt: number): number =>
  500 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ pending (parked) lines */

const NONCE_KEY = "_nonce";
const AT_KEY = "_at";
export const NONCES_FILE = "nonces.txt";
/** Applied nonces are kept by age (a parked line older than the window cannot be deduped). */
const NONCES_KEEP_MS = 7 * 24 * 3_600_000;

function pendingDir(clone: string): string {
  return path.join(clone, "pending");
}

/** Keep a draft that could not be pushed; the next call drains it first (once: see the nonce). */
export function park(
  clone: string,
  lane: string,
  draft: Record<string, unknown>,
  nonce: string,
  at: string,
): void {
  assertLaneName(lane);
  fs.mkdirSync(pendingDir(clone), { recursive: true });
  const line = JSON.stringify({ ...draft, [NONCE_KEY]: nonce, [AT_KEY]: at });
  fs.appendFileSync(path.join(pendingDir(clone), `${lane}.jsonl`), line + "\n");
}

interface PendingItem {
  lane: string;
  draft: Record<string, unknown>;
  nonce: string | null;
  /** When the line was parked (absent on lines from before this field existed). */
  at: string | null;
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
    try {
      assertLaneName(m[1]); // `rejected` and Windows-reserved names are never lanes
    } catch {
      continue;
    }
    const file = path.join(pendingDir(clone), n);
    files.push(file);
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      const o = parseLine(raw);
      if (!o) {
        items.push({ lane: m[1], draft: {}, nonce: null, at: null, raw });
        continue;
      }
      const { [NONCE_KEY]: nonce, [AT_KEY]: at, ...draft } = o;
      items.push({
        lane: m[1],
        draft,
        at: typeof at === "string" ? at : null,
        nonce: typeof nonce === "string" && /^[0-9a-f]{16}$/.test(nonce) ? nonce : null,
        raw,
      });
    }
  }
  return { items, files };
}

export interface NonceRow {
  nonce: string;
  ts: string;
}

/** `nonce ts` rows (a bare `nonce` from an older file has no ts). */
export function readNonces(clone: string): NonceRow[] {
  try {
    return fs
      .readFileSync(path.join(clone, NONCES_FILE), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [nonce, ts] = l.split(" ");
        return { nonce, ts: ts ?? "" };
      });
  } catch {
    return [];
  }
}

export const formatNonces = (rows: NonceRow[]): string =>
  rows.length === 0
    ? ""
    : rows.map((r) => (r.ts === "" ? r.nonce : `${r.nonce} ${r.ts}`)).join("\n") + "\n";

/** Drop rows older than the retention window (by the event clock, never by count). */
export function pruneNonces(rows: NonceRow[], now: string): NonceRow[] {
  const cutoff = Date.parse(now) - NONCES_KEEP_MS;
  return rows.filter((r) => {
    const t = Date.parse(r.ts);
    return Number.isNaN(t) || t >= cutoff;
  });
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

/** Live-segment file texts (plus additions), ready for validateEvents with the snapshot resume. */
function textsOf(tree: Tree, added: Record<string, string[]>): EventFile[] {
  const lanes = new Set<string>([...Object.keys(tree.lanes), ...Object.keys(added)]);
  const files: EventFile[] = [];
  for (const lane of [...lanes].sort(cmp)) {
    const lines = [...(tree.lanes[lane]?.live ?? []), ...(added[lane] ?? [])];
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
  const resume = tree.snap?.acc;
  const key = (e: { file: string; line: number; reason: string }) =>
    `${e.file}|${e.line}|${e.reason}`;
  const before = new Set(validateEvents(textsOf(tree, {}), ctx, resume).map(key));
  return validateEvents(textsOf(tree, added), ctx, resume).filter((e) => !before.has(key(e)));
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

/** Number of live lines a lane's file has before any additions. */
const liveLines = (tree: Tree, lane: string): number => tree.lanes[lane]?.live.length ?? 0;

/**
 * Append one event to `lane` on the state branch and push it. Refuses (exit 3 invalid / 4 denylist)
 * before any write; retries a rejected push 6 times with backoff; on a transport failure or
 * exhaustion parks the draft in `pending/` (exit 5) and drains it, once, on the next call.
 */
export async function appendAndPush(
  env: Env,
  lane: string,
  draft: Draft,
  mint?: (state: ControlState) => string,
): Promise<ControlEvent> {
  assertLaneName(lane);
  checkEnv(env);
  const clone = await ensureClone(env);
  // a line that can never be accepted is refused before anything is written or parked
  const pre = lineProblem(JSON.stringify(buildEvent(lane, 1, env.now(), draft)));
  if (pre) throw pre;
  const nonce = randomBytes(8).toString("hex");
  const sleep = (ms: number): Promise<void> => (env.sleep ? env.sleep(ms) : defaultSleep(ms));
  return withLock(lockDirOf(clone), LOCK_STALE_MS, async () => {
    let lastId: string | undefined;
    let parked = false;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        syncClone(env, clone);
        const tree = readTree(clone);
        const now = env.now();
        const tip = tipMaxTs(tree);
        const ts = now > tip ? now : tip; // never sort before what the snapshot already folded
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

        // 1. drain parked drafts: once (nonce), and never silently lost (set aside when invalid)
        const pend = readPending(clone);
        const nonceRows = readNonces(clone);
        const applied = new Set(nonceRows.map((r) => r.nonce));
        const oldestKept =
          nonceRows
            .map((r) => r.ts)
            .filter((t) => t !== "")
            .sort(cmp)[0] ?? "";
        const rejected: { lane: string; raw: string }[] = [];
        const drainNonces: string[] = [];
        const materialize = (list: PendingItem[]): Built[] => {
          const n = nul<number>();
          return list.map((item) => {
            n[item.lane] = (n[item.lane] ?? lastSeq(tree, item.lane)) + 1;
            const ev = buildEvent(item.lane, n[item.lane], ts, item.draft);
            return { lane: item.lane, ev, line: JSON.stringify(ev) };
          });
        };
        let items = pend.items.filter((it) => {
          if (it.nonce !== null && applied.has(it.nonce)) return false; // already on the branch
          const tooOld =
            it.at !== null &&
            (Date.parse(it.at) < Date.parse(ts) - NONCES_KEEP_MS ||
              (oldestKept !== "" && it.at < oldestKept));
          if (tooOld) {
            rejected.push({ lane: it.lane, raw: it.raw }); // older than the dedupe window
            return false;
          }
          const ok =
            Object.keys(it.draft).length > 0 &&
            !lineProblem(JSON.stringify(buildEvent(it.lane, 1, ts, it.draft)));
          if (!ok) rejected.push({ lane: it.lane, raw: it.raw });
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
              if (e.file === `${b.lane}.jsonl` && e.line === liveLines(tree, b.lane) + at[i] + 1) {
                bad.add(i);
              }
            });
          }
          if (bad.size === 0) bad.add(items.length - 1); // unattributable: set the newest aside
          for (const i of bad) rejected.push({ lane: items[i].lane, raw: items[i].raw });
          items = items.filter((_, i) => !bad.has(i));
        }
        for (const b of materialize(items)) {
          next[b.lane] = b.ev.seq;
          push(b);
        }
        for (const it of items) if (it.nonce !== null) drainNonces.push(it.nonce);

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
        const seen = pruneNonces(
          [...nonceRows, ...[...drainNonces, nonce].map((n) => ({ nonce: n, ts }))],
          ts,
        );
        writeAtomic(path.join(clone, NONCES_FILE), formatNonces(seen));
        git(clone, ["add", "-A"]);
        const extraN = builtAll.length - 1;
        const msg =
          `ctl(${lane}): #${ev.seq} ${ev.type} ${typeof ev.task === "string" ? ev.task : ""}`.trim() +
          (extraN > 0 ? ` (+${extraN} parked)` : "");
        git(clone, [...CTL_IDENTITY, "commit", "-q", "--no-verify", "-m", msg]);
        const pushed = gitTry(clone, [
          "push",
          "-q",
          "origin",
          `HEAD:refs/heads/${env.stateBranch}`,
        ]);
        if (pushed.ok) {
          for (const f of pend.files) fs.rmSync(f, { force: true });
          if (rejected.length > 0) {
            const dir = path.join(pendingDir(clone), "rejected");
            fs.mkdirSync(dir, { recursive: true });
            for (const r of rejected)
              fs.appendFileSync(path.join(dir, `${r.lane}.jsonl`), r.raw + "\n");
            process.stderr.write(
              `ctl: ${rejected.length} parked line(s) set aside in pending/rejected/\n`,
            );
          }
          return ev;
        }
        resetQuiet(env, clone);
        if (!/non-fast-forward|fetch first|rejected/.test(pushed.err)) {
          throw new CtlError(5, withMovedHint(pushed.err.trim()));
        }
        if (attempt < MAX_ATTEMPTS) await sleep(appendRetrySleep(attempt));
      }
      throw new CtlError(5, "push exhausted");
    } catch (e) {
      if (e instanceof CtlError && e.code !== 5) throw e; // refused before any write: nothing to park
      if (!parked) {
        parked = true;
        resetQuiet(env, clone);
        park(
          clone,
          lane,
          { ...draft, ...(lastId !== undefined ? { id: lastId } : {}) },
          nonce,
          env.now(),
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new CtlError(
        5,
        /parked in pending/.test(msg) ? msg : `${msg}; event parked in pending/`,
      );
    }
  });
}

/** Drop our unpushed local commit so the checkout is back at origin. */
function resetQuiet(env: Env, clone: string): void {
  if (!isOwned(env, clone)) return;
  fs.rmSync(path.join(clone, ".git", "index.lock"), { force: true });
  gitTry(clone, ["reset", "-q", "--hard", `refs/remotes/origin/${env.stateBranch}`]);
  gitTry(clone, ["clean", "-fdq"]);
}
