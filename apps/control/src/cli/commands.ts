/**
 * `ctl` command implementations (spec §7). Every change verb appends exactly one event through
 * `appendAndPush` (the library owns seq, ts, validation, retry and parking); read verbs take the
 * clone lock, sync, read and fold. Nothing here spawns a shell: git calls are argv arrays.
 */
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
  readTree,
  syncClone,
} from "../sources/state-branch";
import type { Draft, Tree } from "../sources/state-branch";
import {
  changeLine,
  formatNext,
  formatOverlap,
  formatPiggyback,
  formatShow,
  formatWaste,
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

/** Clone on first use, sync, read, validate and fold, all under the clone lock. */
export async function snapshot(ctx: Ctx): Promise<Snapshot> {
  const clone = await cloneReady(ctx.env);
  return withLock(lockDirOf(clone), LOCK_STALE_MS, () => {
    syncClone(ctx.env, clone);
    const tree = readTree(clone);
    const errors = validateEvents(textsOf(tree), validationContext(ctx.registers), tree.snap?.acc);
    const state = foldDir(clone, ctx.env.registers, ctx.env.now());
    return { clone, tree, state, errors };
  });
}

function knownLane(state: ControlState, lane: string): boolean {
  return has(state.lanes, lane) && state.lanes[lane].kind !== "unregistered";
}

/* ------------------------------------------------------------------ change verbs */

function headShort(cwd: string): string | undefined {
  const r = gitTry(cwd, ["rev-parse", "--short", "HEAD"]);
  const s = r.out.trim();
  return r.ok && /^[0-9a-f]{7,40}$/.test(s) ? s : undefined;
}

/** Append one event on the resolved lane and print the <= 200 B confirmation. */
async function emit(
  ctx: Ctx,
  draft: { type: string; [k: string]: unknown },
  mint?: (state: ControlState) => string,
  quiet = false,
): Promise<ControlEvent> {
  const lane = laneOf(ctx);
  assertLaneName(lane);
  const snap = await snapshot(ctx);
  if (!knownLane(snap.state, lane)) throw new CtlError(2, `unknown lane ${lane}`);
  const sha = headShort(ctx.cwd);
  const note = flag(ctx, "note");
  const full: Draft = {
    ...draft,
    by: "agent",
    ...(sha ? { sha } : {}),
    ...(note !== undefined && draft.type !== "lane.note" ? { note: noteText(note) } : {}),
  };
  let ev: ControlEvent;
  try {
    ev = await appendAndPush(ctx.env, lane, full, mint);
  } catch (e) {
    // name the subject: the library reports the transition but not which task it was for
    if (e instanceof CtlError && e.code === 3 && typeof draft.task === "string") {
      throw new CtlError(3, `${draft.task}: ${e.message}`);
    }
    throw e;
  }
  if (!quiet) {
    const tip = gitTry(snap.clone, ["rev-parse", "--short", "HEAD"]).out.trim();
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
  const title = trunc(pos(ctx, 0, "title"), 120);
  const lane = laneOf(ctx);
  const snap = await snapshot(ctx);
  const tmpId = `${lane}.${lastSeq(snap.tree, lane) + 1}`;
  const prio = flag(ctx, "priority");
  await emit(ctx, {
    type: "task.proposed",
    tmpId,
    title,
    kind: need(ctx, "kind"),
    areas: csv(need(ctx, "areas")),
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

function createDraft(ctx: Ctx, title: string, kind: string, areas: string[]) {
  const extra: Record<string, unknown> = {};
  for (const k of ["priority", "release", "effort", "customerImpact"]) {
    const v = flag(ctx, k === "customerImpact" ? "impact" : k);
    if (v !== undefined) extra[k] = v;
  }
  const imp = flag(ctx, "importance");
  if (imp !== undefined) extra.importance = Number(imp);
  return { type: "task.created", title: trunc(title, 120), kind, areas, ...extra };
}

const task: Command = async (ctx) => {
  const sub = pos(ctx, 0, "subcommand (new)");
  if (sub !== "new") throw new CtlError(2, `task: unknown subcommand ${sub}`);
  const title = pos(ctx, 1, "title");
  await emit(
    ctx,
    createDraft(ctx, title, need(ctx, "kind"), csv(flag(ctx, "areas") ?? "")),
    nextRfId,
  );
};

const adopt: Command = async (ctx) => {
  const tmp = pos(ctx, 0, "tmpId");
  const snap = await snapshot(ctx);
  if (!has(snap.state.tasks, tmp)) throw new CtlError(3, `unknown proposal ${tmp}`);
  const p = snap.state.tasks[tmp];
  let id = flag(ctx, "task");
  if (id === undefined) {
    const created = await emit(
      ctx,
      createDraft(ctx, p.title, p.kind, p.areas.value),
      nextRfId,
      true,
    );
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
        await emit(ctx, d, undefined, true);
        added++;
        seen.add(`${d.type}|${subject}|${c.sha.slice(0, 7)}`);
      } catch (e) {
        if (e instanceof CtlError && (e.code === 3 || e.code === 4)) skipped++;
        else throw e;
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

/** `next` never fails: any problem becomes exactly one `control: ...` line, exit 0. */
// TODO(WP7): add PR facts (CI, review, mergeable) and the merged-PR nudge once WP5 state lands.
const next: Command = async (ctx) => {
  const quiet = ctx.args.flags.quiet === true;
  const say = (line: string): void => {
    if (!quiet) ctx.out(line.replace(/\s+/g, " ").slice(0, 200) + "\n");
  };
  try {
    if (ctx.lane === null) return say("control: no lane (use --lane, CTL_LANE or `ctl lane use`)");
    assertLaneName(ctx.lane);
    const snap = await snapshot(ctx);
    if (snap.errors.length > 0) {
      const e = snap.errors[0];
      // one line even when the state is broken, and quiet (session-start) mode still warns
      ctx.out(`control: INVALID ${e.file}:${e.line} ${trunc(e.reason, 120)}\n`);
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
      ctx.out(
        JSON.stringify({
          lane: ctx.lane,
          current: snap.state.lanes[ctx.lane].current.value,
          next: snap.state.lanes[ctx.lane].next.value,
          blockers: snap.state.lanes[ctx.lane].blockers,
          eligible: res.items,
          held: res.held.length,
          piggyback: pig.count,
          overlap: overlaps.map((o) => ({ a: o.a, b: o.b, level: o.level, shared: o.shared })),
        }) + "\n",
      );
      return;
    }
    ctx.out(
      formatNext({
        lane: ctx.lane,
        state: snap.state,
        next: res,
        piggybackCount: pig.count,
        overlaps,
      }),
    );
  } catch (e) {
    say(`control: unavailable ${trunc(e instanceof Error ? e.message : String(e), 120)}`);
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
  await cloneReady(ctx.env);
  const r = await compact(ctx.env);
  ctx.out(
    changeLine(
      r.compacted ? `✓ compacted (${r.archived.length} archive file(s))` : "nothing to compact",
    ),
  );
};

const laneCmd: Command = (ctx) => {
  const sub = ctx.args.pos[0];
  if (sub === undefined) {
    ctx.out(`${ctx.lane ?? "none"}\n`);
    return Promise.resolve();
  }
  if (sub !== "use") throw new CtlError(2, `lane: unknown subcommand ${sub}`);
  const name = assertLaneName(pos(ctx, 1, "lane"));
  const top = gitTry(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  const root = top.ok && top.out.trim() !== "" ? top.out.trim() : ctx.cwd;
  const file = path.join(root, ".claude", "control", ".lane");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, name + "\n");
  ctx.out(changeLine(`✓ lane ${name}`));
  return Promise.resolve();
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
  "serve",
  "next",
]);
