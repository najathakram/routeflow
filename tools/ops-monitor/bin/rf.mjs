#!/usr/bin/env node
// rf: the ops-monitor CLI. Human facts are typed once here and become events in routeflow-specs.
// Exit codes: 0 ok, 1 refused (validation) or error, 2 usage, 3 committed but not pushed.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  boardDir,
  laneId,
  loadConfig,
  machineId,
  normalizeLane,
  opsHome,
  specsDir,
  specsRemote,
} from "../lib/config.mjs";
import {
  DONE_STATUSES,
  STATUSES,
  TYPES,
  PRIORITIES,
  PR_ACTIONS,
  needsBusinessStory,
} from "../lib/schema.mjs";
import { newEventId } from "../lib/ids.mjs";
import { fold } from "../lib/fold.mjs";
import { laneNow, rankCandidates } from "../lib/next.mjs";
import { registerModeOf, runSync } from "../lib/sync.mjs";
import { laneForCwd, setLane } from "../lib/lanes-local.mjs";
import { lastEventId, renderBrief, renderSince, splitAtMarker } from "../lib/brief.mjs";
import { registerHook } from "../lib/views.mjs";
import {
  appendEvents,
  ensureClone,
  exec,
  loadBugIds,
  readAllEvents,
  syncSpecs,
  tryWithSpecsLock,
  withSpecsLock,
} from "../lib/store.mjs";

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set([
  "steal",
  "claim",
  "json",
  "no-push",
  "dry",
  "open",
  "help",
  "no-sync",
  "quiet",
  "refresh",
]);
const MULTI_FLAGS = new Set(["pr", "branch", "url"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") {
      positional.push(a);
      continue;
    }
    let key = a.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (BOOLEAN_FLAGS.has(key)) {
      value = true;
    } else {
      if (i + 1 >= argv.length) throw new UsageError(`--${key} needs a value`);
      value = argv[++i];
    }
    if (MULTI_FLAGS.has(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return { positional, flags };
}

const USAGE = `usage: rf <command> [args]
  event <kind> [<item>] [--lane L] [--status S] [--note T] [--by X] [--unblocker Y] [--ref R]
        [--summary S] [--question Q] [--answer A] [--recommended R] [--text T] [--pr N]...
        [--branch B]... [--url U]... [--sha S] [--repo O/R] [--action A] [--number N]
  claim <id> [--lane L] [--branch B] [--steal]     release <id> [--lane L]
  status <id> <status> [--note T]                  block <id> --by X [--unblocker Y]   unblock <id>
  next [--lane L] [--claim] [--json]
  item new --title T --type X [--priority P] [--status S] [--lane L] [--train R1] [--area A]
           [--parent ID] [--eta E] [--gate G] [--id ID]
           [--problem "what is wrong"] [--impact "who it hurts, what it costs"] [--solution "how we fix it"]
           [--owner-ask "what we need from the owner"]   (P0/P1 bug/feature/incident: --problem + --impact required)
  item edit <id> [--title ..] [--priority ..] ...   item show <id> [--json]
  ls [--lane L] [--train R] [--status S] [--type T] [--open] [--json]
  sync [--dry] [--no-push]                         turn changed register / owner-queue rows into events
  audit [--json] [--snapshot FILE]                 the accuracy counts (items, alarms, problems, queue, PRs, bugs)
  bug file <args...>                               files a bug via scripts/campaign/bugs.mjs (lead, coordinator only)
  brief [--lane L] [--since <eventId|iso>] [--refresh] [--json]   what the monitor says, in plain words
  whoami [--machine M] [--lane L]   backfill [--dry]   views [--dry] [--no-push]   doctor   hash-password
global: --json  --no-push  --no-sync  --quiet (no stdout on success)`;

const NULLABLE = [
  "lane",
  "train",
  "area",
  "parent",
  "eta",
  "gate",
  "trainLabel",
  "problem",
  "impact",
  "solution",
  "ownerAsk",
];
const CLEAR_WORDS = new Set(["none", "null", "-", ""]);

function ctxFor(env) {
  return { env, dir: specsDir(env), remote: specsRemote(env), home: opsHome(env) };
}

async function prepare(ctx, flags, { sync }) {
  await withSpecsLock(
    async () => {
      await ensureClone({ dir: ctx.dir, remote: ctx.remote });
      if (sync && !flags["no-sync"] && !ctx.env.RF_NO_SYNC) {
        const generated = registerModeOf(loadConfig(ctx.dir)) === "generated";
        const r = await syncSpecs(ctx.dir, generated ? { afterCommit: registerHook() } : {});
        if (!r.ok) process.stderr.write(`warning: sync failed (using local clone): ${r.error}\n`);
      }
    },
    { home: ctx.home },
  );
  const config = loadConfig(ctx.dir);
  return { ...ctx, config, machine: machineId(config, ctx.env) };
}

/** No --lane: RF_LANE, else the lane recorded for this directory (rf whoami --lane), else null. */
function defaultLane(config, env) {
  return (
    laneId(undefined, config, env) ?? laneForCwd(process.cwd(), env, { config, home: opsHome(env) })
  );
}

function resolveLane(raw, c, { required = false } = {}) {
  let lane;
  if (raw === undefined) lane = defaultLane(c.config, c.env);
  else {
    if (typeof raw !== "string") throw new UsageError("--lane needs a value");
    lane = normalizeLane(raw, c.config);
    if (!lane) throw new UsageError(`unknown lane "${raw}"`);
  }
  if (!lane && required) throw new UsageError("this command needs --lane or RF_LANE");
  return lane;
}

function makeEvent(c, kind, item, data, lane) {
  const ts = Date.now();
  return {
    v: 1,
    id: newEventId(c.machine, ts),
    ts: new Date(ts).toISOString(),
    machine: c.machine,
    actor: (c.env.RF_ACTOR || lane || `${c.machine}:${basename(process.cwd())}`).slice(0, 80),
    lane: lane ?? null,
    kind,
    item,
    data,
  };
}

function stateOf(c) {
  return fold(readAllEvents(c.dir));
}

const list = (v) =>
  String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Item-field flags -> item fields (shared by `item new` and `item edit`). */
function itemFields(flags, c) {
  const f = {};
  for (const k of [
    "title",
    "type",
    "priority",
    "status",
    "area",
    "parent",
    "eta",
    "gate",
    "source",
    "train",
  ]) {
    if (flags[k] !== undefined) f[k] = flags[k];
  }
  // Business view (owner 2026-10-19): the plain-language story of the item.
  for (const k of ["problem", "impact", "solution"]) if (flags[k] !== undefined) f[k] = flags[k];
  if (flags["owner-ask"] !== undefined) f.ownerAsk = flags["owner-ask"];
  if (flags["train-label"] !== undefined) f.trainLabel = flags["train-label"];
  if (flags.trainLabel !== undefined) f.trainLabel = flags.trainLabel;
  if (flags.lane !== undefined) {
    f.lane = CLEAR_WORDS.has(String(flags.lane)) ? null : resolveLane(flags.lane, c);
  }
  for (const k of ["tags", "members", "related"]) if (flags[k] !== undefined) f[k] = list(flags[k]);
  const links = {};
  if (flags.pr) links.prs = flags.pr.map((n) => Number(n));
  if (flags.branch) links.branches = flags.branch;
  if (flags.url) links.urls = flags.url;
  if (Object.keys(links).length) f.links = links;
  for (const k of NULLABLE) if (typeof f[k] === "string" && CLEAR_WORDS.has(f[k])) f[k] = null;
  return f;
}

function print(flags, json, text) {
  if (flags.quiet) return;
  process.stdout.write(
    flags.json ? JSON.stringify(json, null, 2) + "\n" : text.endsWith("\n") ? text : text + "\n",
  );
}

async function submit(c, flags, events) {
  const bugIds = await loadBugIds(c.env.RF_REPO_ROOT || REPO_ROOT);
  const push = !flags["no-push"];
  let res;
  try {
    res = await appendEvents(events, {
      dir: c.dir,
      home: c.home,
      push,
      bugIds,
      // Generated register mode: the register follows every event batch in a views-only commit.
      afterCommit: registerModeOf(c.config) === "generated" ? registerHook() : undefined,
    });
  } catch (e) {
    if (e.refused) {
      if (flags.json)
        process.stdout.write(JSON.stringify({ ok: false, errors: e.errors }, null, 2) + "\n");
      else process.stderr.write(`refused: ${e.errors.join("\n         ")}\n`);
      return { code: 1 };
    }
    throw e;
  }
  if (!flags.quiet) for (const w of res.warnings) process.stderr.write(`warning: ${w}\n`);
  if (res.refused?.length) {
    // Another lane won the claim while our push was rejected; the line never pushed.
    const errors = res.refused.map((r) => r.error);
    if (flags.json)
      process.stdout.write(
        JSON.stringify({ ok: false, errors, events: res.events }, null, 2) + "\n",
      );
    else process.stderr.write(`refused: ${errors.join("\n         ")}\n`);
    return { code: 1 };
  }
  const code = push && !res.pushed ? 3 : 0;
  if (code === 3)
    process.stderr.write(
      "committed locally but not pushed (offline?); the next rf call will push it\n",
    );
  return { code, res };
}

function describe(ev) {
  return `${ev.kind}${ev.item ? ` ${ev.item}` : ""} (${ev.id})`;
}

async function writeCmd(c, flags, events, okText) {
  const { code, res } = await submit(c, flags, events);
  if (!res) return code;
  print(
    flags,
    { ok: true, events: res.events, pushed: res.pushed, warnings: res.warnings },
    okText ? okText(res) : res.events.map((e) => `ok ${describe(e)}`).join("\n"),
  );
  return code;
}

function buildEventData(kind, flags) {
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new UsageError(`--${name} must be a number`);
    return n;
  };
  const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (kind) {
    case "claim":
      return drop({ branch: flags.branch?.[0], steal: flags.steal ? true : undefined });
    case "release":
      return {};
    case "status":
      return drop({ status: flags.status, note: flags.note });
    case "blocked":
      return drop({ by: flags.by, unblocker: flags.unblocker });
    case "unblocked":
      return drop({ note: flags.note });
    case "ruling":
      return drop({ ref: flags.ref, summary: flags.summary });
    case "owner-decision":
      return drop({
        question: flags.question,
        answer: flags.answer,
        recommended: flags.recommended,
      });
    case "note":
      return drop({ text: flags.text });
    case "link":
      return drop({
        prs: flags.pr?.map((n) => num(n, "pr")),
        branches: flags.branch,
        urls: flags.url,
      });
    case "push":
      return drop({
        branch: flags.branch?.[0],
        sha: flags.sha,
        repo: flags.repo,
        remote: flags.remote,
      });
    case "pr":
      return drop({
        number:
          flags.number !== undefined
            ? num(flags.number, "number")
            : flags.pr
              ? num(flags.pr[0], "pr")
              : undefined,
        action: flags.action,
        branch: flags.branch?.[0],
      });
    default:
      throw new UsageError(
        `unknown event kind "${kind}" (use rf item new/edit for item.new/item.edit)`,
      );
  }
}

const KIND_ALIASES = { block: "blocked", unblock: "unblocked", decision: "owner-decision" };
const NEEDS_ITEM = new Set(["claim", "release", "status", "blocked", "unblocked", "link"]);

async function cmdEvent(positional, flags, env) {
  const kindRaw = positional[0];
  if (!kindRaw) throw new UsageError("rf event needs a kind");
  const kind = KIND_ALIASES[kindRaw] ?? kindRaw;
  const item = positional[1] ?? null;
  if (NEEDS_ITEM.has(kind) && !item) throw new UsageError(`rf event ${kind} needs an item id`);
  const c = await prepare(ctxFor(env), flags, { sync: false });
  const lane = resolveLane(flags.lane, c, { required: kind === "claim" || kind === "release" });
  const data = buildEventData(kind, flags);
  return writeCmd(c, flags, [makeEvent(c, kind, item, data, lane)]);
}

async function cmdSimple(kind, positional, flags, env) {
  const id = positional[0];
  if (!id) throw new UsageError(`rf ${kind} needs an item id`);
  const rest = [kind, id];
  if (kind === "status") {
    if (!positional[1]) throw new UsageError("rf status <id> <status>");
    flags.status = positional[1];
  }
  return cmdEvent(rest, flags, env);
}

function fmtItem(it) {
  return `${it.id.padEnd(7)} ${it.priority} ${it.status.padEnd(9)} ${it.type.padEnd(8)} ${(it.lane ?? "-").padEnd(10)} ${(it.train ?? "-").padEnd(3)} ${it.title}`;
}

async function cmdNext(flags, env) {
  const c = await prepare(ctxFor(env), flags, { sync: true });
  const lane = resolveLane(flags.lane, c, { required: true });
  const state = stateOf(c);
  const ranked = rankCandidates(state, lane, c.config, { now: Date.now() });
  const top = ranked[0] ?? null;
  const runnersUp = ranked.slice(1, 5);
  const now = laneNow(state, lane);
  let claimed = false;
  let code = 0;
  if (top && flags.claim) {
    const data = flags.branch ? { branch: flags.branch[0] } : {};
    const r = await submit(c, flags, [makeEvent(c, "claim", top.item.id, data, lane)]);
    code = r.code;
    claimed = r.res !== undefined;
    if (!r.res) return code;
  }
  const slim = (x) => ({
    id: x.item.id,
    title: x.item.title,
    priority: x.item.priority,
    reason: x.reason,
  });
  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        { lane, item: top ? slim(top) : null, runnersUp: runnersUp.map(slim), claimed, now },
        null,
        2,
      ) + "\n",
    );
    return code;
  }
  if (!top) {
    process.stdout.write(
      `nothing to pick for ${lane}${now.length ? ` (in flight: ${now.join(", ")})` : ""}\n`,
    );
    return code;
  }
  let out = `NEXT ${top.item.id}  ${top.item.title}\n     ${top.reason}${claimed ? "  [claimed]" : ""}\n`;
  for (const r of runnersUp) out += `also ${r.item.id}  ${r.item.title}  (${r.reason})\n`;
  if (now.length) out += `now  ${now.join(", ")}\n`;
  process.stdout.write(out);
  return code;
}

async function cmdItem(positional, flags, env) {
  const sub = positional[0];
  if (sub === "new") {
    const c = await prepare(ctxFor(env), flags, { sync: false });
    const fields = itemFields(flags, c);
    if (!fields.title || !fields.type) throw new UsageError("rf item new needs --title and --type");
    if (needsBusinessStory({ priority: "P2", ...fields }) && (!fields.problem || !fields.impact)) {
      throw new UsageError(
        'a P0/P1 bug, feature or incident needs --problem "<what is wrong, in customer terms>" and --impact "<who it hurts and what it costs>"',
      );
    }
    if (flags.id !== undefined && (flags.id === true || !flags.id))
      throw new UsageError("--id needs a value");
    const lane = defaultLane(c.config, c.env);
    return writeCmd(
      c,
      flags,
      [makeEvent(c, "item.new", flags.id ?? null, fields, lane)],
      (res) => `created item ${res.events[0].item}: ${res.events[0].data.title}`,
    );
  }
  if (sub === "edit") {
    const id = positional[1];
    if (!id) throw new UsageError("rf item edit <id> [fields]");
    const c = await prepare(ctxFor(env), flags, { sync: false });
    const fields = itemFields(flags, c);
    if (Object.keys(fields).length === 0)
      throw new UsageError("rf item edit needs at least one field flag");
    // A human edit of the story confirms it (clears the "draft" mark the summary import set).
    if (["problem", "impact", "solution"].some((k) => fields[k] !== undefined))
      fields.summaryDraft = false;
    const lane = defaultLane(c.config, c.env);
    return writeCmd(c, flags, [makeEvent(c, "item.edit", id, { fields }, lane)]);
  }
  if (sub === "show") {
    const id = positional[1];
    if (!id) throw new UsageError("rf item show <id>");
    const c = await prepare(ctxFor(env), flags, { sync: true });
    const it = stateOf(c).items.get(id);
    if (!it) {
      process.stderr.write(`unknown item ${id}\n`);
      return 1;
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify(it, null, 2) + "\n");
      return 0;
    }
    const iso = (ms) => (ms ? new Date(ms).toISOString() : "-");
    const lines = [
      `${it.id}  ${it.title}`,
      `type ${it.type}  priority ${it.priority}  status ${it.status}  lane ${it.lane ?? "-"}  train ${it.train ?? "-"}`,
      `area ${it.area ?? "-"}  parent ${it.parent ?? "-"}  eta ${it.eta ?? "-"}  gate ${it.gate ?? "-"}`,
      `claimed by ${it.claimedBy ?? "-"}${it.claimedAt ? ` since ${iso(it.claimedAt)}` : ""}${it.blocked ? `  BLOCKED by ${it.blocked.by}` : ""}`,
      `links  prs ${it.links.prs.join(",") || "-"}  branches ${it.links.branches.join(",") || "-"}`,
      `children ${it.children.join(",") || "-"}  updated ${iso(it.updatedAt)}`,
      "history:",
      ...it.history
        .slice(-5)
        .map(
          (h) =>
            `  ${iso(h.ts)} ${h.kind}${h.status ? ` ${h.status}` : ""} ${h.lane ?? ""} ${h.actor}`,
        ),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }
  throw new UsageError("rf item <new|edit|show>");
}

async function cmdLs(flags, env) {
  const c = await prepare(ctxFor(env), flags, { sync: true });
  const state = stateOf(c);
  const lane = flags.lane !== undefined ? resolveLane(flags.lane, c) : null;
  const trainItem = flags.train ? state.items.get(flags.train) : null;
  const rows = [...state.items.values()].filter((it) => {
    if (lane && it.lane !== lane && it.claimedBy !== lane) return false;
    if (flags.train && it.train !== flags.train && !trainItem?.members.includes(it.id))
      return false;
    if (flags.status && it.status !== flags.status) return false;
    if (flags.type && it.type !== flags.type) return false;
    if (flags.open && DONE_STATUSES.includes(it.status)) return false;
    return true;
  });
  const num = (id) => (/^\d+$/.test(id) ? Number(id) : Infinity);
  rows.sort(
    (a, b) =>
      a.priority.localeCompare(b.priority) || num(a.id) - num(b.id) || a.id.localeCompare(b.id),
  );
  if (flags.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  else process.stdout.write(rows.length ? rows.map(fmtItem).join("\n") + "\n" : "no items\n");
  return 0;
}

async function cmdWhoami(flags, env) {
  const ctx = ctxFor(env);
  if (flags.machine !== undefined) {
    if (flags.machine === true || !String(flags.machine).trim())
      throw new UsageError("--machine needs a value");
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(join(ctx.home, "machine"), String(flags.machine).trim() + "\n");
  }
  const config = loadConfig(ctx.dir);
  if (flags.lane !== undefined) {
    const lane = typeof flags.lane === "string" ? normalizeLane(flags.lane, config) : null;
    if (!lane) throw new UsageError(`unknown lane "${flags.lane}"`);
    // Record the checkout ROOT (git toplevel), so sub-folders of the checkout inherit the lane.
    const top = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
    const root = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
    setLane(ctx.home, root, lane);
  }
  const info = {
    machine: machineId(config, env),
    lane: defaultLane(config, env),
    specsDir: ctx.dir,
    clone: existsSync(join(ctx.dir, ".git")) ? "present" : "missing",
  };
  print(
    flags,
    info,
    `machine ${info.machine}\nlane ${info.lane ?? "-"}\nspecs ${info.specsDir}\nclone ${info.clone}`,
  );
  return 0;
}

async function loadOptional(rel, label) {
  try {
    return await import(new URL(rel, import.meta.url).href);
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && String(e.message).includes(rel.split("/").pop())) {
      process.stderr.write(`${label} module not available\n`);
      return null;
    }
    throw e;
  }
}

async function cmdBackfill(flags, env) {
  const mod = await loadOptional("../lib/backfill.mjs", "backfill");
  if (!mod) return 2;
  const c = await prepare(ctxFor(env), flags, { sync: true });
  const res = await mod.runBackfill({ specsDir: c.dir, boardDir: boardDir(env), dry: !!flags.dry });
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  return 0;
}

async function cmdViews(flags, env) {
  const views = await loadOptional("../lib/views.mjs", "views");
  const snap = views && (await loadOptional("../lib/snapshot.mjs", "views"));
  const coll = snap && (await loadOptional("../lib/collector.mjs", "views"));
  if (!coll) return 2;
  const c = await prepare(ctxFor(env), flags, { sync: true });
  const collector = coll.createCollector({
    repoRoot: REPO_ROOT,
    specsDir: c.dir,
    exec,
    now: Date.now,
    intervals: {},
    onUpdate: () => {},
    log: () => {},
  });
  for (const name of ["specs", "github", "branches", "bugs", "areas"])
    await collector.runOnce(name);
  const snapshot = snap.buildSnapshot({
    sources: collector.sources,
    config: c.config,
    now: Date.now(),
    machine: c.machine,
  });
  const res = await views.writeViews({
    specsDir: c.dir,
    boardDir: boardDir(env),
    snapshot,
    push: !flags["no-push"],
    dry: !!flags.dry,
    registerMode: registerModeOf(c.config),
  });
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  return 0;
}

async function cmdSync(flags, env) {
  const c = await prepare(ctxFor(env), flags, { sync: false });
  const bugIds = await loadBugIds(env.RF_REPO_ROOT || REPO_ROOT);
  const res = await runSync({
    dir: c.dir,
    home: c.home,
    env,
    dry: Boolean(flags.dry),
    push: !flags["no-push"],
    bugIds,
  });
  if (!res.ran) {
    print(flags, { ran: false, reason: res.reason }, `sync skipped (${res.reason})`);
    return 0;
  }
  const s = res.summary;
  const text =
    `sync${flags.dry ? " (dry)" : ""}: ${res.events.length} event(s): ${s.registerNew} new row(s), ` +
    `${s.registerEdits} edited, ${s.answered} answered, ${s.dropped} board item(s) dropped` +
    (flags.dry
      ? "\n" + res.events.map((e) => `  ${e.kind} ${e.item ?? "-"}`).join("\n")
      : `; appended ${res.appended}${res.pushed ? " and pushed" : ""}`);
  print(
    flags,
    {
      ran: true,
      dry: Boolean(flags.dry),
      events: res.events,
      summary: s,
      appended: res.appended,
      pushed: res.pushed,
      warnings: res.warnings,
      pullError: res.pullError,
    },
    text,
  );
  if (!flags.quiet) for (const w of res.warnings) process.stderr.write(`warning: ${w}\n`);
  return res.appended > 0 && !res.pushed && !flags["no-push"] ? 3 : 0;
}

const tally = (list, keyOf) => {
  const out = {};
  for (const x of list) {
    const k = keyOf(x) ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** The accuracy counts from a snapshot object (the monitor's last view). */
export function auditFromSnapshot(snap) {
  const q = snap.ownerQueue ?? [];
  const prs = snap.prs ?? {};
  return {
    source: "snapshot",
    at: snap.generatedAt ?? null,
    items: {
      total: (snap.items ?? []).length,
      byStatus: tally(snap.items ?? [], (i) => i.status),
    },
    alarms: { total: (snap.alarms ?? []).length, byKind: tally(snap.alarms ?? [], (a) => a.kind) },
    problems: (snap.problems ?? []).length,
    ownerQueue: {
      open: q.filter((o) => (o.state ?? "open") === "open").length,
      booked: q.filter((o) => o.state === "booked").length,
      answered: (snap.answeredRecently ?? []).length,
    },
    untrackedPrs: {
      open: (prs.open ?? []).filter((p) => !p.item).length,
      merged: (prs.merged ?? []).filter((p) => !p.item).length,
    },
    bugs: { total: (snap.bugs ?? []).length, byFix: tally(snap.bugs ?? [], (b) => b.fix) },
  };
}

/** The same counts from the events alone (no PRs, alarms or bugs: those need the collector). */
export function auditFromState(state) {
  const items = [...state.items.values()];
  const queue = items.filter((i) => i.tags?.includes("owner-queue") && i.status !== "dropped");
  const answered = queue.filter((i) => i.answeredAt).length;
  return {
    source: "events",
    at: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    items: { total: items.length, byStatus: tally(items, (i) => i.status) },
    alarms: null,
    problems: items.filter(
      (i) =>
        ["P0", "P1"].includes(i.priority) &&
        !DONE_STATUSES.includes(i.status) &&
        !["release", "decision"].includes(i.type) &&
        !i.tags?.includes("problem") &&
        !i.tags?.includes("owner-ask"),
    ).length,
    ownerQueue: { open: queue.length - answered, booked: 0, answered },
    untrackedPrs: null,
    bugs: null,
  };
}

function printAudit(a) {
  const lines = [`audit (${a.source}${a.at ? `, ${a.at}` : ""})`];
  const kv = (o) =>
    Object.entries(o)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none";
  lines.push(`items by status (${a.items.total}): ${kv(a.items.byStatus)}`);
  lines.push(
    a.alarms
      ? `alarms by kind (${a.alarms.total}): ${kv(a.alarms.byKind)}`
      : "alarms by kind: n/a (events only)",
  );
  lines.push(`problems: ${a.problems}`);
  lines.push(
    `owner queue: ${a.ownerQueue.open} open, ${a.ownerQueue.booked} booked, ${a.ownerQueue.answered} answered`,
  );
  lines.push(
    a.untrackedPrs
      ? `untracked PRs: ${a.untrackedPrs.open} open, ${a.untrackedPrs.merged} merged`
      : "untracked PRs: n/a (events only)",
  );
  lines.push(
    a.bugs
      ? `bugs by fix state (${a.bugs.total}): ${kv(a.bugs.byFix)}`
      : "bugs by fix state: n/a (events only)",
  );
  return lines.join("\n");
}

async function cmdAudit(flags, env) {
  const ctx = ctxFor(env);
  const explicit = typeof flags.snapshot === "string" ? resolve(flags.snapshot) : null;
  const last = join(ctx.home, "last-snapshot.json");
  let snap = null;
  for (const file of [explicit, existsSync(last) ? last : null]) {
    if (!file) continue;
    try {
      snap = JSON.parse(readFileSync(file, "utf8"));
      break;
    } catch (e) {
      if (file === explicit) throw new Error(`cannot read snapshot ${file}: ${e.message}`);
    }
  }
  let audit;
  if (snap) audit = auditFromSnapshot(snap);
  else {
    const c = await prepare(ctx, flags, { sync: true });
    audit = auditFromState(stateOf(c));
  }
  process.stdout.write(
    flags.json ? JSON.stringify(audit, null, 2) + "\n" : printAudit(audit) + "\n",
  );
  return 0;
}

/** Plain-words brief + "since" line from the local clone and the last monitor snapshot. */
async function cmdBrief(flags, env) {
  const ctx = ctxFor(env);
  if (flags.refresh) {
    // Pull the clone for next time; skipped when a lane is writing (the lock is busy).
    try {
      await tryWithSpecsLock(
        async () => {
          await ensureClone({ dir: ctx.dir, remote: ctx.remote });
          await syncSpecs(ctx.dir);
        },
        { home: ctx.home },
      );
    } catch (e) {
      if (!flags.quiet) process.stderr.write(`warning: refresh failed: ${e?.message ?? e}\n`);
    }
  }
  if (flags.quiet) return 0;
  if (!existsSync(join(ctx.dir, "events"))) {
    throw new Error(`no ops clone at ${ctx.dir} (run: rf doctor)`);
  }
  const config = loadConfig(ctx.dir);
  const lane =
    flags.lane !== undefined ? resolveLane(flags.lane, { config, env }) : defaultLane(config, env);
  const events = readAllEvents(ctx.dir);
  const state = fold(events);
  let snapshot = null;
  try {
    snapshot = JSON.parse(readFileSync(join(ctx.home, "last-snapshot.json"), "utf8"));
  } catch {
    // no live monitor data here
  }
  const now = Date.now();
  const utcOffsetMin = -new Date(now).getTimezoneOffset();
  const text = renderBrief(state, { lane, now, snapshot, config, utcOffsetMin });
  let since = "";
  if (typeof flags.since === "string") {
    const marker = /^\d{4}-\d\d-\d\d/.test(flags.since)
      ? { ts: Date.parse(flags.since) }
      : { lastEventId: flags.since };
    if (marker.ts !== undefined && !Number.isFinite(marker.ts))
      throw new UsageError(`--since needs an event id or an ISO time, got "${flags.since}"`);
    const { before, sorted } = splitAtMarker(events, marker);
    since = renderSince(fold(before), fold(sorted), { lane, nowMs: now, utcOffsetMin });
    if (marker.lastEventId && !sorted.some((e) => e.id === marker.lastEventId))
      throw new UsageError(`--since: no event with id ${marker.lastEventId}`);
  }
  if (flags.json) {
    const out = {
      lane,
      text,
      since,
      lastEventId: lastEventId(events),
      snapshot: snapshot !== null,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`${since ? `${since}\n` : ""}${text}\n`);
  }
  return 0;
}

const BUG_MINTER_LANES = new Set(["lead", "coordinator"]);

/**
 * `rf bug file …`: a thin wrapper over `node scripts/campaign/bugs.mjs file …` in the routeflow
 * checkout, args passed through unchanged. Only the lanes lead and coordinator may run it (one
 * minter, so two lanes can never file the same bug number).
 */
async function cmdBug(rest, env) {
  if (rest[0] !== "file")
    throw new UsageError("rf bug file <args passed to scripts/campaign/bugs.mjs>");
  const config = loadConfig(specsDir(env));
  const raw = String(env.RF_LANE ?? "")
    .trim()
    .toLowerCase();
  const lane = raw ? laneId(undefined, config, env) : defaultLane(config, env);
  if (!BUG_MINTER_LANES.has(lane) && !BUG_MINTER_LANES.has(raw)) {
    process.stderr.write(
      "refused: rf bug file is limited to the lanes lead and coordinator (one minter: a single lane " +
        "mints bug numbers so two lanes can never file the same one). " +
        `Your lane is ${lane ?? (raw || "not set (RF_LANE)")}. Ask the lead to file it.\n`,
    );
    return 1;
  }
  const repo = env.RF_REPO_ROOT || REPO_ROOT;
  const script = join(repo, "scripts", "campaign", "bugs.mjs");
  if (!existsSync(script)) {
    process.stderr.write(`error: ${script} not found\n`);
    return 1;
  }
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...rest], { cwd: repo, stdio: "inherit", env });
    child.on("error", (e) => {
      process.stderr.write(`error: ${e.message}\n`);
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

async function cmdDoctor(flags, env) {
  const ctx = ctxFor(env);
  const rows = [];
  const row = (ok, name, msg) => rows.push({ ok, name, msg });
  const g = await exec("git", ["--version"]);
  row(g.code === 0, "git", g.code === 0 ? g.stdout.trim() : "git not found");
  const gh = await exec("gh", ["auth", "status"]);
  row(
    true,
    "gh",
    gh.code === 127
      ? "not installed (optional)"
      : gh.code === 0
        ? "authenticated"
        : "not authenticated (optional)",
  );
  const cloned = existsSync(join(ctx.dir, ".git"));
  row(
    cloned,
    "clone",
    cloned ? ctx.dir : `missing at ${ctx.dir} (created on first use from ${ctx.remote})`,
  );
  const config = loadConfig(ctx.dir);
  row(true, "config", `${config.lanes.length} lanes, machine ${machineId(config, env)}`);
  const bugs = await loadBugIds(env.RF_REPO_ROOT || REPO_ROOT);
  row(
    bugs.size > 0,
    "bugs",
    bugs.size ? `${bugs.size} registry bug ids on origin/master` : "none found (no origin/master?)",
  );
  if (cloned) {
    const last = await exec("git", ["log", "-1", "--format=%cI %s", "--", "events"], {
      cwd: ctx.dir,
    });
    row(true, "last push", last.stdout.trim() || "no events yet");
  }
  if (flags.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  else
    for (const r of rows)
      process.stdout.write(`${r.ok ? "ok  " : "WARN"} ${r.name.padEnd(10)} ${r.msg}\n`);
  return rows[0].ok ? 0 : 1;
}

export async function main(argv, env = process.env) {
  let code = 0;
  try {
    // `rf bug file …` hands its args to bugs.mjs untouched, so they bypass rf's own flag parser.
    if (argv[0] === "bug") return await cmdBug(argv.slice(1), env);
    const { positional, flags } = parseArgs(argv);
    const cmd = positional.shift();
    if (!cmd || cmd === "help" || flags.help) {
      process.stdout.write(USAGE + "\n");
      return cmd || flags.help ? 0 : 2;
    }
    switch (cmd) {
      case "event":
        code = await cmdEvent(positional, flags, env);
        break;
      case "claim":
      case "release":
      case "status":
        code = await cmdSimple(cmd, positional, flags, env);
        break;
      case "block":
        code = await cmdSimple("blocked", positional, flags, env);
        break;
      case "unblock":
        code = await cmdSimple("unblocked", positional, flags, env);
        break;
      case "next":
        code = await cmdNext(flags, env);
        break;
      case "item":
        code = await cmdItem(positional, flags, env);
        break;
      case "ls":
        code = await cmdLs(flags, env);
        break;
      case "whoami":
        code = await cmdWhoami(flags, env);
        break;
      case "backfill":
        code = await cmdBackfill(flags, env);
        break;
      case "views":
        code = await cmdViews(flags, env);
        break;
      case "sync":
        code = await cmdSync(flags, env);
        break;
      case "audit":
        code = await cmdAudit(flags, env);
        break;
      case "brief":
        code = await cmdBrief(flags, env);
        break;
      case "doctor":
        code = await cmdDoctor(flags, env);
        break;
      case "hash-password": {
        // Prints only the scrypt hash of a password typed on stdin (the owner pastes the hash into
        // the monitor's Railway variables; the password itself is never stored).
        const { hashPasswordCli } = await import("../lib/auth.mjs");
        await hashPasswordCli();
        code = process.exitCode ?? 0;
        break;
      }
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`usage error: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    return 1;
  }
  return code;
}

void STATUSES;
void TYPES;
void PRIORITIES;
void PR_ACTIONS;

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
