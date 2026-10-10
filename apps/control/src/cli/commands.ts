/**
 * `ctl` command implementations (spec §7). Every change verb appends exactly one event through
 * `appendAndPush` (the library owns seq, ts, validation, retry and parking); read verbs take the
 * clone lock, sync, read and fold. Nothing here spawns a shell: git calls are argv arrays.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { nextEligible } from "../domain/next";
import { overlapPairs } from "../domain/overlap";
import type { LaneFiles } from "../domain/overlap";
import { piggyback } from "../domain/piggyback";
import type { PiggybackCandidate } from "../domain/piggyback";
import { validateEvents } from "../domain/validate";
import type { EventFile } from "../domain/validate";
import type { ControlEvent, ControlState, TaskState, ValidationError } from "../domain/types";
import { registerTasks } from "../domain/adapters";
import { links } from "../domain/trailers";
import type { Registers } from "./../sources/registers";
import { compact } from "../sources/compact";
import { CtlError, assertLaneName, gitTry } from "../sources/git";
import type { Env } from "../sources/git";
import { withLock } from "../sources/lock";
import { denylistHit } from "../sources/denylist";
import {
  appendAndPush,
  ensureClone,
  foldDir,
  lastSeq,
  lockDirOf,
  park,
  readTree,
  syncClone,
} from "../sources/state-branch";
import type { Draft, Tree } from "../sources/state-branch";
import { LINE_MAX, checkLaneFields, initCmd, originCmd } from "./init";
import {
  changeLine,
  formatNext,
  formatOverlap,
  formatPiggyback,
  formatShow,
  controlFailure,
  formatWaste,
  oneLine,
  trunc,
} from "./format";

export interface Args {
  verb: string;
  pos: string[];
  flags: Record<string, string | true>;
}

export interface Ctx {
  cwd: string;
  env: Env;
  registers: Registers;
  lane: string | null;
  args: Args;
  out(text: string): void;
}

export type Command = (ctx: Ctx) => Promise<void>;

const LOCK_STALE_MS = 30_000;
const NOTE_MAX = 80;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ args helpers */

function flag(ctx: Ctx, name: string): string | undefined {
  const v = ctx.args.flags[name];
  return typeof v === "string" ? v : undefined;
}

function need(ctx: Ctx, name: string): string {
  const v = flag(ctx, name);
  if (v === undefined || v === "") throw new CtlError(2, `${ctx.args.verb}: --${name} is required`);
  return v;
}

function pos(ctx: Ctx, i: number, what: string): string {
  const v = ctx.args.pos[i];
  if (v === undefined || v === "") throw new CtlError(2, `${ctx.args.verb}: missing ${what}`);
  return v;
}

function noteText(text: string): string {
  if (Array.from(text).length > NOTE_MAX) {
    throw new CtlError(3, `note is ${Array.from(text).length} chars; the limit is ${NOTE_MAX}`);
  }
  return text;
}

function csv(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function laneOf(ctx: Ctx): string {
  if (ctx.lane === null) {
    throw new CtlError(2, "no lane: pass --lane, set CTL_LANE, or run `ctl lane use <lane>`");
  }
  return ctx.lane;
}

/* ------------------------------------------------------------------ reading state */

export interface Snapshot {
  clone: string;
  tree: Tree;
  state: ControlState;
  errors: ValidationError[];
  /** The fetch failed; this is the last clone state. */
  offline?: boolean;
}

function textsOf(tree: Tree): EventFile[] {
  return Object.keys(tree.lanes)
    .sort(cmp)
    .filter((l) => tree.lanes[l].live.length > 0)
    .map((l) => ({ file: `${l}.jsonl`, text: tree.lanes[l].live.join("\n") + "\n" }));
}

/** Validation context: tasks carry status + release via registerTasks (never bare ids). */
export function validationContext(registers: Registers) {
  return {
    tasks: registerTasks(registers.tasks),
    releaseIds: registers.releases.map((r) => r.id),
    denylistHit,
  };
}

/**
 * ensureClone's own `.git exists` fast path can see a half-finished clone made by a sibling
 * process, so every CLI call serializes ensureClone behind a separate lock (own lock name, since
 * ensureClone takes `<dir>.clone.lock` itself and the lock is not reentrant).
 */
async function cloneReady(env: Env): Promise<string> {
  const dir = path.resolve(env.cloneDir);
  return withLock(`${dir}.cli.lock`, LOCK_STALE_MS, () => ensureClone(env));
}

export type SnapMode = "fresh" | "local";

/**
 * Clone on first use, then read, validate and fold under the clone lock. "fresh" fetches first; if
 * the fetch fails the existing clone is read as it is (`offline`), so an offline write still parks.
 * "local" never fetches (used to check a lane cheaply: appendAndPush fetches once itself).
 */
export async function snapshot(ctx: Ctx, mode: SnapMode = "fresh"): Promise<Snapshot> {
  const clone = await cloneReady(ctx.env);
  return withLock(lockDirOf(clone), LOCK_STALE_MS, () => {
    let offline = false;
    if (mode === "fresh") {
      try {
        syncClone(ctx.env, clone);
      } catch (e) {
        if (!(e instanceof CtlError) || e.code !== 5) throw e;
        offline = true;
      }
    }
    const tree = readTree(clone);
    const errors = validateEvents(textsOf(tree), validationContext(ctx.registers), tree.snap?.acc);
    const state = foldDir(clone, ctx.env.registers, ctx.env.now());
    return { clone, tree, state, errors, offline };
  });
}

/** Hook mode: the existing clone as it is. No clone, no fetch, no lock, nothing written. */
function snapshotHook(ctx: Ctx): Snapshot | null {
  const clone = path.resolve(ctx.env.cloneDir);
  if (!fs.existsSync(path.join(clone, ".git"))) return null;
  const tree = readTree(clone);
  const errors = validateEvents(textsOf(tree), validationContext(ctx.registers), tree.snap?.acc);
  const state = foldDir(clone, ctx.env.registers, ctx.env.now());
  return { clone, tree, state, errors };
}

function knownLane(state: ControlState, lane: string): boolean {
  return has(state.lanes, lane) && state.lanes[lane].kind !== "unregistered";
}

/** Unknown lane => exit 2. Looks at the local clone first and fetches only on a miss. */
async function checkLane(ctx: Ctx, lane: string, fresh?: Snapshot): Promise<Snapshot> {
  let snap = fresh ?? (await snapshot(ctx, "local"));
  if (!knownLane(snap.state, lane) && !fresh) snap = await snapshot(ctx, "fresh");
  if (!knownLane(snap.state, lane)) throw new CtlError(2, `unknown lane ${lane}`);
  return snap;
}

/* ------------------------------------------------------------------ change verbs */

/** Lines the library allows up to 1,024 B for (lead verb, long titles); everything else is 240. */
const WIDE_TYPES = new Set(["task.created"]);

function headShort(cwd: string): string | undefined {
  const r = gitTry(cwd, ["rev-parse", "--short", "HEAD"]);
  const s = r.out.trim();
  return r.ok && /^[0-9a-f]{7,40}$/.test(s) ? s : undefined;
}

/** The worst-case line (seq 999999, current clock): refused before any fetch or write. */
function assertLineBudget(ctx: Ctx, lane: string, draft: Draft, minted: boolean): void {
  const worst = JSON.stringify({
    seq: 999999,
    ts: ctx.env.now(),
    lane,
    ...draft,
    ...(minted ? { id: "RF-999999" } : {}),
  });
  const n = Buffer.byteLength(worst, "utf8");
  if (!WIDE_TYPES.has(draft.type) && n > LINE_MAX) {
    throw new CtlError(3, `event line would be ${n} bytes; the limit is ${LINE_MAX}`);
  }
  const hit = denylistHit(worst);
  if (hit) throw new CtlError(4, `refused: ${hit}`);
}

/** Move lines parked while no clone existed into the clone's pending/ (drained first, in order). */
function adoptOfflinePending(ctx: Ctx, clone: string): void {
  const dir = path.join(`${path.resolve(ctx.env.cloneDir)}.offline`, "pending");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).sort(cmp);
  } catch {
    return;
  }
  for (const n of names) {
    const from = path.join(dir, n);
    const to = path.join(clone, "pending", n);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.appendFileSync(to, fs.readFileSync(from, "utf8"));
    fs.rmSync(from, { force: true });
  }
}

/** The draft an event is appended with: caller fields plus `by`, the working repo's sha and `--note`. */
function fullDraft(ctx: Ctx, draft: { type: string; [k: string]: unknown }): Draft {
  const sha = headShort(ctx.cwd);
  const note = flag(ctx, "note");
  // a sha the caller set (sync: the merged commit) wins over the working repo's HEAD
  return {
    by: "agent",
    ...(sha ? { sha } : {}),
    ...draft,
    ...(note !== undefined && draft.type !== "lane.note" ? { note: noteText(note) } : {}),
  };
}

interface EmitOpts {
  mint?: (state: ControlState) => string;
  quiet?: boolean;
  /** A fresh snapshot the caller already took (saves a fetch). */
  fresh?: Snapshot;
}

/** Append one event on the resolved lane and print the <= 200 B confirmation. */
async function emit(
  ctx: Ctx,
  draft: { type: string; [k: string]: unknown },
  opts: EmitOpts = {},
): Promise<ControlEvent> {
  const lane = assertLaneName(laneOf(ctx));
  const full = fullDraft(ctx, draft);
  assertLineBudget(ctx, lane, full, opts.mint !== undefined);
  let clone: string;
  try {
    clone = await cloneReady(ctx.env);
  } catch (e) {
    if (e instanceof CtlError && e.code === 5) {
      // no clone and no origin: keep the line (size/denylist-checked, lane unchecked)
      const stash = `${path.resolve(ctx.env.cloneDir)}.offline`;
      park(stash, lane, full, randomBytes(8).toString("hex"), ctx.env.now());
      throw new CtlError(5, `${oneLine(e.message)}; event parked in pending/`);
    }
    throw e;
  }
  await withLock(lockDirOf(clone), LOCK_STALE_MS, () => adoptOfflinePending(ctx, clone));
  await checkLane(ctx, lane, opts.fresh);
  let ev: ControlEvent;
  try {
    ev = await appendAndPush(ctx.env, lane, full, opts.mint);
  } catch (e) {
    // name the subject: the library reports the transition but not which task it was for
    if (e instanceof CtlError && e.code === 3 && typeof draft.task === "string") {
      throw new CtlError(3, `${draft.task}: ${e.message}`);
    }
    throw e;
  }
  if (!opts.quiet) {
    const tip = gitTry(clone, ["rev-parse", "--short", "HEAD"]).out.trim();
    const subject = typeof ev.task === "string" ? ev.task : typeof ev.id === "string" ? ev.id : "";
    ctx.out(
      changeLine(`✓ ${lane}#${ev.seq} ${ev.type} ${subject} (pushed ${tip})`.replace(/ +/g, " ")),
    );
  }
  return ev;
}

const start: Command = (ctx) =>
  emit(ctx, { type: "task.started", task: pos(ctx, 0, "task") }).then();

const done: Command = async (ctx) => {
  const prRaw = flag(ctx, "pr");
  const pr = prRaw === undefined ? undefined : Number(prRaw);
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) {
    throw new CtlError(2, "done: --pr must be a positive integer");
  }
  await emit(ctx, { type: "task.done", task: pos(ctx, 0, "task"), ...(pr ? { pr } : {}) });
};

const block: Command = (ctx) =>
  emit(ctx, {
    type: "task.blocked",
    task: pos(ctx, 0, "task"),
    reason: trunc(need(ctx, "reason"), 120),
  }).then();

const unblock: Command = (ctx) =>
  emit(ctx, { type: "task.unblocked", task: pos(ctx, 0, "task") }).then();

const setNext: Command = (ctx) => {
  const t = pos(ctx, 0, "task or none");
  return emit(ctx, { type: "task.next", task: t === "none" ? null : t }).then();
};

const progress: Command = (ctx) =>
  emit(ctx, {
    type: "task.progress",
    task: pos(ctx, 0, "task"),
    phase: need(ctx, "phase"),
  }).then();

const note: Command = (ctx) => {
  const text = ctx.args.pos.join(" ");
  if (text === "") throw new CtlError(2, "note: missing text");
  return emit(ctx, { type: "lane.note", note: noteText(text) }).then();
};

const propose: Command = async (ctx) => {
  const lane = laneOf(ctx);
  const snap = await snapshot(ctx, "local");
  const tmpId = `${lane}.${lastSeq(snap.tree, lane) + 1}`;
  const prio = flag(ctx, "priority");
  const kind = need(ctx, "kind");
  const areas = csv(need(ctx, "areas"));
  const sha = headShort(ctx.cwd);
  const size = (title: string, a: string[]): number =>
    Buffer.byteLength(
      JSON.stringify({
        seq: 999999,
        ts: ctx.env.now(),
        lane,
        type: "task.proposed",
        by: "agent",
        ...(sha ? { sha } : {}),
        tmpId,
        title,
        kind,
        areas: a,
        ...(prio ? { priority: prio } : {}),
      }),
      "utf8",
    );
  // R9: <= 240 B. Shorten the title first, then drop trailing areas; still over => exit 3.
  let title = trunc(pos(ctx, 0, "title"), 120);
  let fit = areas;
  while (size(title, fit) > LINE_MAX && Array.from(title).length > 12) {
    title = trunc(title, Array.from(title).length - 4);
  }
  while (size(title, fit) > LINE_MAX && fit.length > 1) fit = fit.slice(0, -1);
  if (size(title, fit) > LINE_MAX) throw new CtlError(3, `propose: line over ${LINE_MAX} bytes`);
  await emit(ctx, {
    type: "task.proposed",
    tmpId,
    title,
    kind,
    areas: fit,
    ...(prio ? { priority: prio } : {}),
  });
};

const bug: Command = (ctx) => {
  // Deviation from spec §7: bug ids are minted only by the landing coordinator (fleet rule), so
  // `ctl bug` never runs scripts/campaign/bugs.mjs; it prints the line to send to the coordinator.
  const title = trunc(pos(ctx, 0, "title"), 100);
  const loc = flag(ctx, "location") ?? "<file:line>";
  const sev = flag(ctx, "severity") ?? "<low|medium|high|critical>";
  ctx.out(
    changeLine(
      `bug ids are minted by the landing coordinator; send: file bug "${title}" at ${loc}, severity ${sev}`,
    ),
  );
  return Promise.resolve();
};

function nextRfId(state: ControlState): string {
  let max = 0;
  for (const id of Object.keys(state.tasks)) {
    const m = /^RF-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `RF-${max + 1}`;
}

function createDraft(ctx: Ctx, title: string, kind: string, areas: string[], notes?: string) {
  const extra: Record<string, unknown> = {};
  for (const k of ["priority", "release", "effort", "customerImpact"]) {
    const v = flag(ctx, k === "customerImpact" ? "impact" : k);
    if (v !== undefined) extra[k] = v;
  }
  const imp = flag(ctx, "importance");
  if (imp !== undefined) extra.importance = Number(imp);
  return {
    type: "task.created",
    title: trunc(title, 120),
    kind,
    areas,
    ...extra,
    ...(notes ? { notes } : {}),
  };
}

const task: Command = async (ctx) => {
  const sub = pos(ctx, 0, "subcommand (new)");
  if (sub !== "new") throw new CtlError(2, `task: unknown subcommand ${sub}`);
  const title = pos(ctx, 1, "title");
  await emit(ctx, createDraft(ctx, title, need(ctx, "kind"), csv(flag(ctx, "areas") ?? "")), {
    mint: nextRfId,
  });
};

/**
 * Adopt = create the task, then adopt the proposal onto it: two appends (the library takes one
 * event per call). The created task carries `notes = "adopts <tmpId>"`, so a retry after a failed
 * second push finds it and reuses its id instead of minting RF-(n+1).
 */
const adopt: Command = async (ctx) => {
  const tmp = pos(ctx, 0, "tmpId");
  const lane = laneOf(ctx);
  const snap = await snapshot(ctx);
  const minted = Object.values(snap.state.tasks).find((t) => t.notes === `adopts ${tmp}`);
  if (!has(snap.state.tasks, tmp)) {
    if (minted) return void ctx.out(changeLine(`✓ ${tmp} already adopted as ${minted.id}`));
    throw new CtlError(3, `unknown proposal ${tmp}`);
  }
  const parked = path.join(snap.clone, "pending", `${lane}.jsonl`);
  let hasParkedAdopt = false;
  try {
    hasParkedAdopt = fs
      .readFileSync(parked, "utf8")
      .split("\n")
      .some((l) => l.includes('"task.adopted"') && l.includes(`"tmpId":${JSON.stringify(tmp)}`));
  } catch {
    /* nothing parked */
  }
  if (hasParkedAdopt) {
    // the adoption is already parked; any append drains it first
    await emit(ctx, { type: "lane.note", note: trunc(`adopt ${tmp}`, NOTE_MAX) });
    return;
  }
  const p = snap.state.tasks[tmp];
  let id = flag(ctx, "task") ?? minted?.id;
  if (id === undefined) {
    const draft = createDraft(ctx, p.title, p.kind, p.areas.value, `adopts ${tmp}`);
    const created = await emit(ctx, draft, { mint: nextRfId, quiet: true, fresh: snap });
    id = String(created.id);
  }
  await emit(ctx, { type: "task.adopted", tmpId: tmp, task: id });
};

const handoff: Command = async (ctx) => {
  const card = need(ctx, "card");
  await emit(ctx, { type: "lane.note", note: trunc(`handoff ${path.basename(card)}`, NOTE_MAX) });
};

const renumber: Command = () => {
  throw new CtlError(2, "renumber: repair-only verb, not implemented in this build");
};

/* ------------------------------------------------------------------ sync (coordinator) */

interface SyncCommit {
  sha: string;
  subject: string;
  tasks: string[];
  bugs: string[];
  pr: number | null;
}

function parseCommits(text: string): SyncCommit[] {
  const out: SyncCommit[] = [];
  for (const chunk of text.split("\0")) {
    const body = chunk.replace(/^\n+/, "");
    if (body.trim() === "") continue;
    const lines = body.split("\n");
    const sha = lines[0].trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const rest = lines.slice(1);
    const subject = rest[0] ?? "";
    const pr = /\(#(\d+)\)\s*$/.exec(subject);
    const l = links(rest.join("\n"), "");
    const tasks = l.task ? [l.task] : [];
    const bugs = l.bug ? [l.bug] : [];
    out.push({ sha, subject, tasks, bugs, pr: pr ? Number(pr[1]) : null });
  }
  return out;
}

const sync: Command = async (ctx) => {
  const since = need(ctx, "since");
  if (!/^[0-9a-f]{7,40}$/.test(since)) throw new CtlError(2, "sync: --since must be a hex sha");
  const log = gitTry(ctx.cwd, [
    "log",
    "--first-parent",
    "--format=%H%n%B%x00",
    `${since}..origin/master`,
  ]);
  if (!log.ok) throw new CtlError(5, `sync: git log failed: ${trunc(log.err, 120)}`);
  // oldest first, so a release lands after its fix
  const commits = parseCommits(log.out).reverse();
  const snap = await snapshot(ctx);
  const seen = new Set<string>();
  for (const l of Object.keys(snap.tree.lanes)) {
    for (const e of snap.tree.lanes[l].liveEvents) {
      if (e.type !== "task.released" && e.type !== "bug.fixed") continue;
      const subject = String(e.type === "bug.fixed" ? e.bug : e.task);
      if (typeof e.sha === "string") seen.add(`${e.type}|${subject}|${e.sha.slice(0, 7)}`);
    }
  }
  let added = 0;
  let skipped = 0;
  for (const c of commits) {
    const todo: { type: string; [k: string]: unknown }[] = [];
    for (const b of c.bugs) {
      if (c.pr !== null) todo.push({ type: "bug.fixed", bug: b, pr: c.pr, sha: c.sha });
    }
    for (const t of c.tasks) {
      const ts: TaskState | undefined = has(snap.state.tasks, t) ? snap.state.tasks[t] : undefined;
      const release = ts?.release.value;
      if (release) todo.push({ type: "task.released", task: t, release, sha: c.sha });
    }
    for (const d of todo) {
      const subject = String(d.type === "bug.fixed" ? d.bug : d.task);
      if (seen.has(`${d.type}|${subject}|${c.sha.slice(0, 7)}`)) continue;
      try {
        await emit(ctx, d, { quiet: true, fresh: snap });
        added++;
        seen.add(`${d.type}|${subject}|${c.sha.slice(0, 7)}`);
      } catch (e) {
        if (e instanceof CtlError && (e.code === 3 || e.code === 4)) {
          skipped++;
          process.stderr.write(`sync: skipped ${subject}: ${oneLine(e.message, 120)}\n`);
        } else throw e;
      }
    }
  }
  ctx.out(changeLine(`sync: ${added} appended, ${skipped} skipped (${commits.length} commits)`));
};

/* ------------------------------------------------------------------ read verbs */

function declaredFiles(state: ControlState): LaneFiles[] {
  const out: LaneFiles[] = [];
  for (const l of Object.values(state.lanes)) {
    const cur = l.current.value;
    if (cur === null || !has(state.tasks, cur)) continue;
    out.push({ lane: l.id, files: new Set(state.tasks[cur].areas.value), source: "declared" });
  }
  return out;
}

function candidatesOf(state: ControlState, regs: Registers): PiggybackCandidate[] {
  const sensitive = new Set(regs.tasks.filter((t) => t.sensitive === true).map((t) => t.id));
  return Object.values(state.tasks).map((t) => ({
    id: t.id,
    kind: t.kind,
    status: t.status.value,
    lane: t.lane.value,
    priority: t.priority.value,
    effort: t.effort,
    // TaskState carries no severity: derive one from the priority the register mapped it to
    severity: t.priority.value === "P3" ? "low" : t.priority.value === "P2" ? "medium" : "high",
    sensitive: sensitive.has(t.id),
    files: new Set(t.areas.value),
  }));
}

function laneFilesOf(state: ControlState, lane: string): Set<string> {
  const l = has(state.lanes, lane) ? state.lanes[lane] : undefined;
  const id = l?.current.value ?? l?.next.value ?? null;
  return new Set(id !== null && has(state.tasks, id) ? state.tasks[id].areas.value : []);
}

const JSON_MAX = 16 * 1024;

/** `next` never fails: any problem becomes exactly one `control: INVALID|UNAVAILABLE ...` line. */
// TODO(WP7): add PR facts (CI, review, mergeable) and the merged-PR nudge once WP5 state lands.
const next: Command = async (ctx) => {
  const hook = ctx.args.flags.hook === true;
  const quiet = ctx.args.flags.quiet === true || hook;
  const say = (line: string): void => {
    if (!quiet) ctx.out(line.replace(/\s+/g, " ").slice(0, 120) + "\n");
  };
  try {
    if (ctx.lane === null) return say("control: no lane (use --lane, CTL_LANE or `ctl lane use`)");
    assertLaneName(ctx.lane);
    const snap = hook ? snapshotHook(ctx) : await snapshot(ctx);
    if (snap === null) return; // hook: no clone yet, print nothing
    if (snap.errors.length > 0) {
      const e = snap.errors[0];
      // printed even with --quiet: session start must see broken state
      ctx.out(controlFailure(3, `${e.file}:${e.line} ${e.reason}`));
      return;
    }
    if (!knownLane(snap.state, ctx.lane)) return say(`control: unknown lane ${ctx.lane}`);
    const res = nextEligible(snap.state, ctx.lane);
    const pig = piggyback(
      laneFilesOf(snap.state, ctx.lane),
      candidatesOf(snap.state, ctx.registers),
    );
    const overlaps = overlapPairs(declaredFiles(snap.state)).filter(
      (p) => p.a === ctx.lane || p.b === ctx.lane,
    );
    if (ctx.args.flags.json === true) {
      const l = snap.state.lanes[ctx.lane];
      const obj = {
        lane: ctx.lane,
        current: l.current.value,
        next: l.next.value,
        blockers: l.blockers,
        eligible: res.items,
        held: res.held.length,
        piggyback: pig.count,
        overlap: overlaps.map((o) => ({ a: o.a, b: o.b, level: o.level, shared: o.shared })),
        truncated: false,
      };
      const size = (): number => Buffer.byteLength(JSON.stringify(obj) + "\n", "utf8");
      while (size() > JSON_MAX && (obj.blockers.length > 0 || obj.overlap.length > 0)) {
        obj.truncated = true;
        obj.blockers = obj.blockers.slice(0, Math.floor(obj.blockers.length / 2));
        obj.overlap = obj.overlap.slice(0, Math.floor(obj.overlap.length / 2));
      }
      if (size() > JSON_MAX) {
        obj.truncated = true;
        obj.eligible = [];
      }
      ctx.out(JSON.stringify(obj) + "\n");
      return;
    }
    ctx.out(
      formatNext({
        lane: ctx.lane,
        state: snap.state,
        next: res,
        piggybackCount: pig.count,
        offline: snap.offline === true,
        overlaps,
      }),
    );
  } catch (e) {
    if (hook) return; // the SessionStart hook never prints an error
    // corrupt state (exit 3) is INVALID; everything else (network, missing branch, IO) UNAVAILABLE
    ctx.out(
      controlFailure(
        e instanceof CtlError ? e.code : 5,
        e instanceof Error ? e.message : String(e),
      ),
    );
  }
};

const show: Command = async (ctx) => {
  const id = pos(ctx, 0, "id");
  const snap = await snapshot(ctx);
  if (!has(snap.state.tasks, id)) throw new CtlError(3, `unknown task ${id}`);
  ctx.out(formatShow(snap.state, snap.state.tasks[id]));
};

const overlapCmd: Command = async (ctx) => {
  const snap = await snapshot(ctx);
  ctx.out(formatOverlap(overlapPairs(declaredFiles(snap.state))));
};

const piggybackCmd: Command = async (ctx) => {
  const lane = laneOf(ctx);
  const snap = await snapshot(ctx);
  const r = piggyback(laneFilesOf(snap.state, lane), candidatesOf(snap.state, ctx.registers));
  ctx.out(formatPiggyback(lane, r.items, r.count));
};

const waste: Command = async (ctx) => {
  const snap = await snapshot(ctx);
  ctx.out(formatWaste(snap.state.waste));
};

const prBody: Command = async (ctx) => {
  const id = pos(ctx, 0, "task");
  const lane = laneOf(ctx);
  const snap = await snapshot(ctx);
  if (!has(snap.state.tasks, id)) throw new CtlError(3, `unknown task ${id}`);
  const t = snap.state.tasks[id];
  const lines = [`Task: ${id}`, `Lane: ${lane}`];
  const refBug = t.ref && typeof t.ref.bug === "string" ? t.ref.bug : null;
  const refFeature = t.ref && typeof t.ref.feature === "string" ? t.ref.feature : null;
  if (/^B\d+$/.test(id) || refBug) lines.push(`Bug: ${refBug ?? id}`);
  if (/^F-\d+$/.test(id) || refFeature) lines.push(`Feature: ${refFeature ?? id}`);
  ctx.out(lines.join("\n") + "\n");
};

const validate: Command = async (ctx) => {
  const snap = await snapshot(ctx);
  if (snap.errors.length === 0) {
    ctx.out(changeLine(`✓ valid (${snap.state.sources.events} events)`));
    return;
  }
  const lines = snap.errors.slice(0, 10).map((e) => `${e.file}:${e.line} ${e.reason}`);
  throw new CtlError(3, `INVALID ${snap.errors.length} error(s)\n${lines.join("\n")}`);
};

const compactCmd: Command = async (ctx) => {
  await ensureClone(ctx.env);
  const r = await compact(ctx.env);
  ctx.out(
    changeLine(
      r.compacted ? `✓ compacted (${r.archived.length} archive file(s))` : "nothing to compact",
    ),
  );
};

/**
 * `ctl lane register <id> --name "<n>" --machine <m> --kind <k> [--inactive]`: one `lane.registered`
 * event through the normal append path, emitted by the caller's lane (the lane rules require it to
 * be lead-like). An existing id is updated (the fold merges), which prints `updated` instead.
 */
const laneRegister: Command = async (ctx) => {
  if (ctx.args.pos.length > 2) throw new CtlError(2, "lane register: unexpected argument");
  const f = checkLaneFields(
    {
      id: pos(ctx, 1, "lane id"),
      name: need(ctx, "name"),
      machine: need(ctx, "machine"),
      kind: need(ctx, "kind"),
      active: ctx.args.flags.inactive !== true,
    },
    (field) => `lane register ${field}`,
  );
  const draft = {
    type: "lane.registered",
    laneId: f.id,
    name: f.name,
    machine: f.machine,
    kind: f.kind,
    active: f.active,
  };
  // refuse an over-long or denylisted line before any fetch, like every other verb
  assertLineBudget(ctx, assertLaneName(laneOf(ctx)), fullDraft(ctx, draft), false);
  let fresh: Snapshot | undefined;
  try {
    fresh = await snapshot(ctx);
  } catch (e) {
    // no clone and no origin: emit parks the line itself
    if (!(e instanceof CtlError) || e.code !== 5) throw e;
  }
  const existed = fresh !== undefined && knownLane(fresh.state, f.id);
  await emit(ctx, draft, { quiet: true, fresh });
  ctx.out(`${existed ? "updated" : "registered"} ${f.id}\n`);
};

const laneCmd: Command = async (ctx) => {
  const sub = ctx.args.pos[0];
  if (sub === undefined) {
    ctx.out(`${ctx.lane ?? "none"}\n`);
    return;
  }
  if (sub === "register") return laneRegister(ctx);
  if (sub !== "use") throw new CtlError(2, `lane: unknown subcommand ${sub}`);
  const name = assertLaneName(pos(ctx, 1, "lane"));
  await checkLane(ctx, name);
  const top = gitTry(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.ok && top.out.trim() !== "" ? top.out.trim() : ctx.cwd;
  const file = path.join(root, ".claude", "control", ".lane");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, name + "\n");
  ctx.out(changeLine(`✓ lane ${name}`));
};

const serve: Command = async () => {
  process.env.CONTROL_LOCAL = "1";
  await import("../main.js");
};

export const COMMANDS: Record<string, Command> = {
  next,
  start,
  done,
  block,
  unblock,
  "set-next": setNext,
  progress,
  note,
  propose,
  bug,
  task,
  adopt,
  renumber,
  "pr-body": prBody,
  show,
  overlap: overlapCmd,
  piggyback: piggybackCmd,
  waste,
  handoff,
  sync,
  compact: compactCmd,
  validate,
  lane: laneCmd,
  init: initCmd,
  origin: originCmd,
  serve,
};

/** Verbs that never need a lane. */
export const LANELESS = new Set([
  "show",
  "overlap",
  "waste",
  "compact",
  "validate",
  "lane",
  "init",
  "origin",
  "serve",
  "next",
]);
