// Generated views: the WORK-REGISTER, the DASHBOARD marker sections and the Work Board JSON.
// Everything here is a pure function of the snapshot (no clock, no ages) so a refresh that
// changes nothing produces byte-identical output and therefore no commit.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DONE_STATUSES, PRIORITIES } from "./schema.mjs";
import { GITHUB_REPO } from "./config.mjs";
import { loadClientNames, maskDeep } from "./mask.mjs";
import { fold } from "./fold.mjs";
import { VIEWS_COMMIT_PREFIX, exec as gitExec, readAllEvents, runCommit } from "./store.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const HEADER_RE = /^<!-- ops:generated register v1 sha256=([0-9a-f]{64}) -->\n/;

// ---------------------------------------------------------------------------------------------
// Helpers

const cell = (v) => {
  if (v === null || v === undefined) return "-";
  const t = String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return t === "" ? "-" : t;
};

const isNumericId = (id) => /^\d+$/.test(id);
function compareIds(a, b) {
  const an = isNumericId(a);
  const bn = isNumericId(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
const prioIdx = (p) => {
  const i = PRIORITIES.indexOf(p);
  return i < 0 ? 9 : i;
};
const trainNo = (t) => {
  const m = /^R(\d+)$/.exec(t ?? "");
  return m ? Number(m[1]) : 99;
};
const byPriorityId = (a, b) => prioIdx(a.priority) - prioIdx(b.priority) || compareIds(a.id, b.id);
const isoDate = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null);
const label = (it) => (it ? `${it.id} ${it.title}` : "-");

/** Items shown in the register: everything but releases and verified/dropped work. */
function registerItems(snapshot) {
  return (snapshot.items ?? [])
    .filter((i) => i.type !== "release" && i.status !== "verified" && i.status !== "dropped")
    .sort(byPriorityId);
}
const typeLabel = (t) => (t === "bug" ? "fix" : t);

// ---------------------------------------------------------------------------------------------
// Register

export function renderRegister(snapshot, { itemFileExists = () => false } = {}) {
  const rows = registerItems(snapshot);
  const merged = new Set((snapshot.prs?.merged ?? []).map((p) => p.number));
  const counts = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  for (const r of rows) if (r.priority in counts) counts[r.priority] += 1;
  const lines = [
    "# Work register (generated)",
    "",
    "This file is generated from items and events by tools/ops-monitor; edit items with `rf`, not here. A hand edit blocks the next regeneration until it is resolved.",
    "",
    `Open: ${rows.length} rows (${PRIORITIES.map((p) => `${p} ${counts[p]}`).join(", ")}).`,
    "",
    "| ID | Title | Type | Priority | Status | Lane | Train | Gate | ETA | Links | Updated |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const links = [];
    if (itemFileExists(r.id)) links.push(`[item](items/${r.id}.md)`);
    // The item's own PRs first, then the PRs the register merely cites (background refs).
    const own = r.links?.prs ?? [];
    for (const n of [...own, ...(r.refPrs ?? []).filter((x) => !own.includes(x))]) {
      links.push(
        `[#${n}](https://github.com/${GITHUB_REPO}/pull/${n})${merged.has(n) ? " merged" : ""}`,
      );
    }
    lines.push(
      `| ${[
        cell(r.id),
        cell(r.title),
        cell(typeLabel(r.type)),
        cell(r.priority),
        cell(r.status),
        cell(r.lane),
        cell(r.trainLabel ?? r.train),
        cell(r.gate),
        cell(r.eta),
        links.length ? links.join(" ") : "-",
        cell(isoDate(r.updatedAt)),
      ].join(" | ")} |`,
    );
  }
  const body = `${lines.join("\n")}\n`;
  return `<!-- ops:generated register v1 sha256=${sha256(body)} -->\n${body}`;
}

/** May the generator overwrite the register on disk? */
export function registerWritePolicy(currentText, { backfillSha256 = null } = {}) {
  if (currentText === null || currentText === undefined || currentText === "") {
    return { allowed: true, reason: "no register file yet" };
  }
  const norm = String(currentText).replace(/\r\n/g, "\n");
  const m = HEADER_RE.exec(norm);
  if (m && sha256(norm.slice(m[0].length)) === m[1]) {
    return { allowed: true, reason: "intact generated file" };
  }
  if (
    backfillSha256 &&
    (sha256(currentText) === backfillSha256 || sha256(norm) === backfillSha256)
  ) {
    return { allowed: true, reason: "unchanged since backfill" };
  }
  return { allowed: false, reason: "hand-edited since last generation" };
}

// ---------------------------------------------------------------------------------------------
// Generated register mode (registerMode "generated"): the register is a pure function of the
// events, regenerated into a disposable views-only commit after every event batch.

const iso = (ms) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** State (fold output) -> the snapshot shape renderRegister reads. Registry-bug overlays are not rows. */
export function stateToSnapshot(state) {
  const items = [];
  for (const it of state.items.values()) {
    if (it.overlay) continue;
    const { history: _history, ...rest } = it;
    items.push({
      ...rest,
      blocked: it.blocked ? { ...it.blocked, at: iso(it.blocked.at) } : null,
      createdAt: iso(it.createdAt),
      updatedAt: iso(it.updatedAt),
      claimedAt: iso(it.claimedAt),
    });
  }
  return { items, prs: { open: [], merged: [] } };
}

/** The register text for a state: render(fold(all events)). */
export function renderGeneratedRegister(
  state,
  { itemFileExists = () => false, clientNames = null } = {},
) {
  const snap = maskDeep(stateToSnapshot(state), clientNames ?? loadClientNames().names);
  return renderRegister(snap, { itemFileExists });
}

/**
 * The `afterCommit` hook of generated mode: regenerates register/WORK-REGISTER.md from the events
 * in the specs clone and commits it alone (`ops(views): …`). A register with a generated header
 * that was hand-edited since is left alone (reported as `refused`); a plain hand-kept register is
 * replaced (that is the switch to generated mode). Callers hold the specs lock.
 */
export function registerHook() {
  return async (dir) => {
    const state = fold(readAllEvents(dir));
    const rel = "register/WORK-REGISTER.md";
    const path = join(dir, "register", "WORK-REGISTER.md");
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    const next = renderGeneratedRegister(state, {
      itemFileExists: (id) => existsSync(join(dir, "register", "items", `${id}.md`)),
    });
    // A Windows checkout may hold CRLF; git stores LF, so compare on LF.
    if (current !== null && current.split("\r\n").join("\n") === next) return { committed: false };
    if (current !== null && /^<!-- ops:generated register v1 /.test(current)) {
      const policy = registerWritePolicy(current);
      if (!policy.allowed) return { committed: false, refused: policy.reason };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    const add = await gitExec("git", ["add", "--", rel], { cwd: dir });
    if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const staged = await gitExec("git", ["diff", "--cached", "--quiet", "--", rel], { cwd: dir });
    if (staged.code === 0) return { committed: false }; // identical after line-ending normalization
    await runCommit(dir, `${VIEWS_COMMIT_PREFIX} regenerate register`, [rel]);
    return { committed: true };
  };
}

// ---------------------------------------------------------------------------------------------
// Dashboard

const table = (head, rows) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");

export function renderDashboardSections(snapshot) {
  const items = snapshot.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const list = (ids) =>
    (ids ?? []).map((id) => label(byId.get(id) ?? { id, title: "" }).trim()).join("; ");

  const now = table(
    ["Lane", "Building", "Next gate"],
    (snapshot.lanes ?? []).map((l) => [
      `${l.title} (${l.id})`,
      list(l.now) || "-",
      l.next ? `${l.next.id} ${l.next.title}` : "-",
    ]),
  );

  const blockedItems = items.filter((i) => i.blocked).sort(byPriorityId);
  const blocked = blockedItems.length
    ? table(
        ["Item", "Blocked by", "Unblocks it"],
        blockedItems.map((i) => [label(i), i.blocked.by, i.blocked.unblocker]),
      )
    : "_Nothing is blocked._";

  const problemItems = (snapshot.problems ?? []).map((id) => byId.get(id)).filter(Boolean);
  const problems = problemItems.length
    ? table(
        ["Item", "Priority", "Status", "Gate"],
        problemItems.map((i) => [label(i), i.priority, i.status, i.gate]),
      )
    : "_None._";

  const open = items
    .filter(
      (i) =>
        !DONE_STATUSES.includes(i.status) &&
        i.status !== "idea" &&
        !["release", "epic", "decision"].includes(i.type) &&
        !i.claimedBy,
    )
    .sort(
      (a, b) =>
        prioIdx(a.priority) - prioIdx(b.priority) ||
        trainNo(a.train) - trainNo(b.train) ||
        compareIds(a.id, b.id),
    )
    .slice(0, 10);
  const next = open.length
    ? table(
        ["Item", "Priority", "Train", "Lane", "ETA"],
        open.map((i) => [label(i), i.priority, i.trainLabel ?? i.train, i.lane, i.eta]),
      )
    : "_Nothing queued._";

  const oq = snapshot.ownerQueue ?? [];
  const owner = oq.length
    ? table(
        ["Item", "Recommended", "ETA"],
        oq.map((o) => [label(o), o.gate, o.eta]),
      )
    : "_Nothing waiting on the owner._";

  const alarms = snapshot.alarms ?? [];
  const sev = (s) => alarms.filter((a) => a.severity === s).length;
  const master = snapshot.ci?.master;
  const sources = Object.keys(snapshot.sources ?? {}).sort();
  const health = table(
    ["Check", "Value"],
    [
      ["Visibility", snapshot.ci?.visibility ?? "unknown"],
      [
        "Master",
        master
          ? `${String(master.sha ?? "").slice(0, 9)} ${master.checks ?? ""}`.trim()
          : "unknown",
      ],
      ["Open PRs", String((snapshot.prs?.open ?? []).length)],
      ["Alarms", `${sev("error")} error, ${sev("warn")} warn, ${sev("info")} info`],
      ...sources.map((name) => {
        const s = snapshot.sources[name];
        return [`Source ${name}`, s.stale ? "stale" : !s.ok ? "error" : "ok"];
      }),
    ],
  );
  return { now, blocked, problems, next, owner, health };
}

/** Replaces the text between `<!-- ops:<name>:begin -->` and `<!-- ops:<name>:end -->`. */
export function applyDashboardMarkers(text, sections) {
  let out = String(text);
  const replaced = [];
  const missing = [];
  for (const [name, content] of Object.entries(sections)) {
    const begin = `<!-- ops:${name}:begin -->`;
    const end = `<!-- ops:${name}:end -->`;
    const b = out.indexOf(begin);
    const e = b < 0 ? -1 : out.indexOf(end, b + begin.length);
    if (b < 0 || e < 0) {
      missing.push(name);
      continue;
    }
    out = `${out.slice(0, b + begin.length)}\n${content}\n${out.slice(e)}`;
    replaced.push(name);
  }
  return { text: out, replaced, missing };
}

// ---------------------------------------------------------------------------------------------
// Board JSON (same row shapes as local-assets/board/state.json / export-board)

export function boardJson(snapshot) {
  const items = snapshot.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const list = (ids) =>
    (ids ?? []).map((id) => label(byId.get(id) ?? { id, title: "" }).trim()).join("; ");
  const register = registerItems(snapshot).map((i) => ({
    id: isNumericId(i.id) ? Number(i.id) : i.id,
    title: i.title,
    type: typeLabel(i.type),
    priority: i.priority,
    status: i.status,
    lane: i.lane ?? null,
    train: i.trainLabel ?? i.train ?? null,
    gate: i.gate ?? null,
    eta: i.eta ?? null,
    updated: isoDate(i.updatedAt),
  }));
  const trains = (snapshot.trains ?? []).map((t) => {
    const lanes = [...new Set((t.members ?? []).map((id) => byId.get(id)?.lane).filter(Boolean))];
    return {
      order: trainNo(t.id),
      train: t.id,
      name: t.title,
      members: (t.members ?? []).join(", "),
      lanes: lanes.join(", "),
      target: t.eta ?? "",
      state: t.status,
      next: "",
    };
  });
  const lanes = (snapshot.lanes ?? []).map((l) => ({
    lane: l.title,
    machine: l.machine ?? "",
    model: "",
    now: list(l.now),
    next: l.next ? `${l.next.id} ${l.next.title}` : "",
  }));
  const owner = (snapshot.ownerQueue ?? []).map((o) => ({
    ask: o.title,
    when: o.eta ?? "",
    recommended: o.gate ?? "",
    state: o.status,
  }));
  const problems = (snapshot.problems ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((i) => ({ problem: i.title, impact: "", fix: i.gate ?? "", state: i.status }));
  return { register, trains, lanes, owner, problems };
}

// ---------------------------------------------------------------------------------------------
// IO

async function resolveDeps(deps = {}) {
  const d = { ...deps };
  d.readText ??= (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  d.exists ??= (p) => existsSync(p);
  d.writeText ??= (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, t);
  };
  if (!d.withLock || !d.syncSpecs || !d.exec) {
    const store = await import("./store.mjs");
    d.withLock ??= (fn) => store.withSpecsLock(fn);
    d.syncSpecs ??= store.syncSpecs;
    d.exec ??= store.exec;
  }
  return d;
}

const BOARD_FILES = ["register", "trains", "lanes", "owner", "problems"];

/**
 * Writes the generated views. Under the specs lock: register (only when the write policy allows
 * it), DASHBOARD marker sections, one commit of the changed view paths, pushed at once. Only on
 * a tree with no unpushed commits; a push that cannot land is rolled back to upstream
 * (`retryLater`), never left under events.
 * Board JSON goes to `<boardDir>/out/*.json` (no git). `dry` computes and writes nothing.
 * Client names (`clientNames`, default: the machine-local list) are masked in everything written.
 * `registerMode: "generated"` leaves the register to the event-driven writer (`registerHook`).
 */
export async function writeViews({
  specsDir,
  boardDir,
  snapshot: rawSnapshot,
  clientNames = null,
  push = true,
  dry = false,
  registerMode = "human",
  deps = {},
}) {
  // Live-client names never reach a git repo or a board file: mask before anything is rendered.
  let names = clientNames;
  if (names === null) {
    const loaded = loadClientNames();
    // A names file that exists but does not parse must not turn into "no names": nothing is written.
    if (loaded.error) throw new Error(`views not written: ${loaded.error}`);
    names = loaded.names;
  }
  const snapshot = maskDeep(rawSnapshot, names);
  const d = await resolveDeps(deps);
  const result = {
    registerWritten: false,
    refused: null,
    dashboardReplaced: [],
    boardWritten: [],
    pushed: false,
    retryLater: false,
    skipped: null,
  };
  const p = (...parts) => join(specsDir, ...parts);

  const work = async () => {
    if (!dry) {
      await d.syncSpecs(specsDir);
      // A views commit never sits under unpushed events (a rebase of it could not be repaired
      // without touching them): write views only on a tree with nothing unpushed.
      const ahead = await d.exec("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: specsDir });
      if (ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) {
        result.retryLater = true;
        result.skipped = ahead.code !== 0 ? "no upstream to compare with" : "unpushed commits";
        return;
      }
    }
    const changed = [];

    // Register (in generated mode the event-driven writer owns it; this one never touches it)
    const regPath = p("register", "WORK-REGISTER.md");
    const current = d.readText(regPath);
    let backfillSha256 = null;
    try {
      backfillSha256 =
        JSON.parse(d.readText(p("ops", "state", "backfill.json")) ?? "null")?.registerSha256 ??
        null;
    } catch {
      backfillSha256 = null;
    }
    // The register is never written here: in "human" mode the lead owns the file (lead ruling
    // 10-19: generation stays OFF until review + accuracy proof + merge); in "generated" mode the
    // event-driven registerHook owns it. Only the explicit legacy mode "views" lets writeViews
    // regenerate it, and then only behind the hand-edit policy.
    const policy =
      registerMode === "views"
        ? registerWritePolicy(current, { backfillSha256 })
        : { allowed: false, reason: null };
    if (!policy.allowed) {
      result.refused = policy.reason; // null in generated mode: nothing to report
    } else {
      const next = renderRegister(snapshot, {
        itemFileExists: (id) => d.exists(p("register", "items", `${id}.md`)),
      });
      if (next !== current) {
        if (!dry) d.writeText(regPath, next);
        result.registerWritten = true;
        changed.push("register/WORK-REGISTER.md");
      }
    }

    // Dashboard
    const dashText = d.readText(p("DASHBOARD.md"));
    if (dashText !== null && dashText !== undefined) {
      const r = applyDashboardMarkers(dashText, renderDashboardSections(snapshot));
      if (r.text !== dashText) {
        if (!dry) d.writeText(p("DASHBOARD.md"), r.text);
        result.dashboardReplaced = r.replaced;
        changed.push("DASHBOARD.md");
      }
    }
    if (dry) return;

    // The backfill record written by `rf backfill` rides along in the first views commit.
    if (d.exists(p("ops", "state", "backfill.json"))) {
      const st = await d.exec("git", ["status", "--porcelain", "--", "ops/state/backfill.json"], {
        cwd: specsDir,
      });
      if (st.stdout.trim()) changed.push("ops/state/backfill.json");
    }
    if (changed.length) {
      const backfillPath = p("ops", "state", "backfill.json");
      const backfillText = changed.includes("ops/state/backfill.json")
        ? d.readText(backfillPath)
        : null;
      const run = (args) => d.exec("git", args, { cwd: specsDir });
      await run(["add", "--", ...changed]);
      let committed = true;
      try {
        await runCommit(specsDir, `${VIEWS_COMMIT_PREFIX} regenerate generated views`, changed, {
          run,
        });
      } catch (e) {
        // Leave the tree clean: unstage the view files and restore the tracked ones. backfill.json
        // is not regenerable and (new) untracked, so it stays on disk for the next run.
        committed = false;
        await run(["reset", "-q", "--", ...changed]);
        const tracked = changed.filter((f) => f !== "ops/state/backfill.json");
        if (tracked.length) await run(["checkout", "--", ...tracked]);
        result.retryLater = true;
        result.skipped = `commit failed: ${e.message}`;
      }
      if (committed && push) {
        for (let attempt = 0; attempt < 3 && !result.pushed; attempt++) {
          const r = await d.exec("git", ["push"], { cwd: specsDir });
          if (r.code === 0) {
            result.pushed = true;
            break;
          }
          const pl = await d.exec("git", ["pull", "--rebase", "--quiet"], { cwd: specsDir });
          if (pl.code !== 0) {
            await d.exec("git", ["rebase", "--abort"], { cwd: specsDir });
            break;
          }
        }
        if (!result.pushed) {
          // The commit holds only view files, regenerated next run: drop it rather than leave a
          // commit that could block event appends or pull --rebase.
          await d.exec("git", ["reset", "--hard", "--quiet", "@{u}"], { cwd: specsDir });
          if (backfillText !== null && backfillText !== undefined)
            d.writeText(backfillPath, backfillText); // not regenerable: keep it for the next run
          result.retryLater = true;
        }
      }
    }
  };

  if (dry) await work();
  else await d.withLock(work);

  // Board JSON (machine-local, no git).
  const board = boardJson(snapshot);
  for (const name of BOARD_FILES) {
    const file = join(boardDir, "out", `${name}.json`);
    const text = `${JSON.stringify(board[name], null, 2)}\n`;
    if (d.readText(file) === text) continue;
    if (!dry) d.writeText(file, text);
    result.boardWritten.push(name);
  }
  if (dry) result.pushed = false;
  return result;
}
