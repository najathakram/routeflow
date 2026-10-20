#!/usr/bin/env node
/**
 * Stop gate for the ops monitor. The PostToolUse recorder (ops-post-push.mjs) logs every
 * `git push` / `gh pr ...` of this session's turn; this gate blocks the turn from closing
 * (exit 2) when such an action has no matching event in routeflow-specs, or the pushed
 * branch / PR is not linked to a work item, or a merged PR's item has no status event. The
 * plan recorder (ops-post-plan.mjs) adds plan-change / assign actions: a plan file edited or work
 * assigned in the turn needs some human event on this machine in the same turn.
 *
 * Recording a push / PR is the MONITOR's job (the detached recorder), so a miss there is a monitor
 * failure, not the person's: it becomes a stderr WARNING plus a local incident line, never a block.
 * Blocking is only for person-owned duties (item links, merge status, plan changes, assignments).
 *
 * FAIL OPEN (this runs at the end of EVERY session once merged; a false block is expensive):
 * any exception, missing/garbled stdin, no actions file, missing ops clone, unreadable events,
 * RF_OPS_GATE=off -> exit 0. The same block repeated 3 times in a row is allowed through
 * (loud stderr line) so a session can never be bricked.
 *
 * Every export above the "── IO" marker is pure and tested directly.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WINDOW_MS = 5 * 60 * 1000;
const PENDING_MS = 30 * 1000;
const RF = "node tools/ops-monitor/bin/rf.mjs";
const TRUNK = new Set(["master", "main"]);
const LANDING_BRANCH_RE = /^(train|docs\/bookkeeping|chore\/bookkeeping)[/-]/;

// ════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Item id linked to a branch / PR number: explicit links first, then an id in the branch name. */
function findLinkedItem(state, { number, branch }) {
  const items = [...state.items.values()];
  if (number != null) {
    const ev = state.prEvents.find((e) => e.number === number && e.item);
    if (ev) return ev.item;
    const it = items.find((i) => i.links.prs.includes(number));
    if (it) return it.id;
  }
  if (branch && !TRUNK.has(branch)) {
    const it = items.find((i) => i.links.branches.includes(branch));
    if (it) return it.id;
    for (const tok of branch.split(/[/_.-]/)) {
      if (/^b\d{1,5}$/i.test(tok) && state.items.has(tok.toUpperCase())) return tok.toUpperCase();
      if (/^\d{3,5}$/.test(tok) && state.items.has(tok)) return tok;
    }
  }
  return null;
}

const NOT_RECORDED_PUSH = "push not recorded";
const NOT_RECORDED_PR = "PR not recorded";
const PLAN_KINDS = new Set(["plan-change", "assign"]);
const PLAN_FIX =
  `${RF} item new --title "..." --type feature  /  ${RF} item edit <id> --lane <lane> --train R3 --eta ...  /  ` +
  `${RF} event owner-decision --question "..." --answer "..."  /  ${RF} event note --text "..."`;

/**
 * A plan change or an assignment needs at least one human event (any kind except push / pr, not
 * the register-sync robot) on THIS machine at or after the earliest such action minus a minute.
 * Returns one missing entry covering every such action, or null (also when `events` is unknown).
 */
function planChangeMissing(actions, events, machine) {
  const plan = actions.filter((a) => PLAN_KINDS.has(a.kind));
  if (plan.length === 0 || !Array.isArray(events)) return null;
  const since = Math.min(...plan.map((a) => toMs(a.ts) ?? 0)) - 60_000;
  const recorded = events.some(
    (e) =>
      e &&
      !e.__invalid &&
      !["push", "pr"].includes(e.kind) &&
      e.actor !== "register-sync" &&
      (machine == null || e.machine === machine) &&
      (toMs(e.ts) ?? -1) >= since,
  );
  if (recorded) return null;
  const what = [
    ...new Set(plan.map((a) => (a.kind === "assign" ? `assignment to ${a.to}` : a.path))),
  ];
  const shown = what.slice(0, 3).join(", ") + (what.length > 3 ? `, +${what.length - 3} more` : "");
  return {
    action: plan[0],
    why: `you changed a plan or assigned work (${shown}) but recorded nothing on the monitor`,
    fix: PLAN_FIX,
  };
}

/**
 * Which of this turn's actions lack a matching event. `actions` = turn-actions entries
 * ({ts (ms or ISO), kind:'push'|'pr'|'plan-change'|'assign', ...}); `state` = fold() output;
 * `events` = the raw event log and `machine` = this machine's id (both needed only for the
 * plan-change / assign rule, which fails open without `events`). `now` is accepted for contract
 * compatibility but no rule needs it.
 * Returns { ok: true } or { ok: false, missing: [{ action, why, fix }] }; either carries
 * `warnings` (same shape: monitor-side misses that never block) when there are any.
 */
export function evaluateGate({ actions, state, events, machine }) {
  const missing = [];
  const warnings = [];
  const planMissing = planChangeMissing(actions ?? [], events, machine);
  if (planMissing) missing.push(planMissing);
  for (const action of actions ?? []) {
    const ats = toMs(action.ts) ?? 0;
    if (action.kind === "push") {
      const b = action.branch;
      const rec = state.pushes.find(
        (p) =>
          (action.sha && p.sha && (p.sha.startsWith(action.sha) || action.sha.startsWith(p.sha))) ||
          (p.branch === b && p.ts >= ats - WINDOW_MS),
      );
      if (!rec) {
        // Monitor-side miss (recorder crashed, specs lock held, slow pull, clone mid-rebase): warn only.
        warnings.push({
          action,
          why: NOT_RECORDED_PUSH,
          fix: `${RF} event push --branch ${b} --sha ${action.sha} --repo najathakram/routeflow`,
        });
        continue;
      }
      // Direct pushes to trunk have no work item by nature; never demand a link for them.
      if (TRUNK.has(b)) continue;
      // Routine landing branches (merge trains, bookkeeping PRs) carry no item of their own.
      if (LANDING_BRANCH_RE.test(b ?? "")) continue;
      const item = rec.item ?? findLinkedItem(state, { branch: b });
      if (!item) {
        missing.push({
          action,
          why: `branch ${b} is not linked to an item`,
          fix: `${RF} event link <id> --branch ${b}  (or: ${RF} item new --title "..." --type feature)`,
        });
      }
    } else if (action.kind === "pr") {
      const { number = null, branch = null } = action;
      // Routine landing branches (merge trains, bookkeeping PRs) carry no item and no status.
      if (LANDING_BRANCH_RE.test(branch ?? "")) continue;
      if (action.action === "create" || action.action === "ready") {
        if (number == null && !branch) continue; // nothing to look up: fail open
        if (!findLinkedItem(state, { number, branch })) {
          const seen = (state.prEvents ?? []).some((e) =>
            number != null ? e.number === number : e.branch === branch,
          );
          if (!seen) {
            // No `pr` event at all: the recorder missed it (monitor-side), not the person.
            warnings.push({
              action,
              why: NOT_RECORDED_PR,
              fix: `${RF} event pr --number ${number ?? "<n>"} --action ${action.action}`,
            });
            continue;
          }
          missing.push({
            action,
            why: `PR ${number != null ? `#${number}` : `on ${branch}`} is not linked to an item`,
            fix: `${RF} event link <id> --pr ${number ?? "<n>"}`,
          });
        }
      } else if (action.action === "merge") {
        if (number == null && !branch) continue;
        const id = findLinkedItem(state, { number, branch });
        if (!id) {
          missing.push({
            action,
            why: `PR #${number} merged but is not linked to an item`,
            fix: `${RF} event link <id> --pr ${number ?? "<n>"}  then  ${RF} status <id> shipping`,
          });
          continue;
        }
        const item = state.items.get(id);
        const seen = (item?.history ?? []).some(
          (h) => h.kind === "status" && h.ts >= ats - WINDOW_MS,
        );
        if (!seen) {
          missing.push({
            action,
            why: `PR #${number} merged but item ${id} has no status event`,
            fix: `${RF} status ${id} shipping  (or: live)`,
          });
        }
      }
    }
  }
  const out = missing.length === 0 ? { ok: true } : { ok: false, missing };
  if (warnings.length > 0) out.warnings = warnings;
  return out;
}

/**
 * True while a `pr-pending` line (a gh merge awaiting its detached confirmation) younger than
 * PENDING_MS has no matching `pr-pending-done` line. Advisory only: it makes the Stop gate wait,
 * it never blocks by itself.
 */
export function pendingMergeOpen(actions, now) {
  const list = actions ?? [];
  return list.some((p) => {
    if (p?.kind !== "pr-pending") return false;
    const ats = toMs(p.ts) ?? 0;
    if (now - ats > PENDING_MS) return false;
    return !list.some(
      (d) =>
        d?.kind === "pr-pending-done" &&
        (toMs(d.ts) ?? -1) >= ats &&
        (p.number == null || d.number === p.number),
    );
  });
}

/** Stable hash of a missing list (loop guard compares consecutive blocks). */
export function missingHash(missing) {
  const key = missing.map((m) => `${m.action.kind}|${m.action.branch ?? ""}|${m.why}`).sort();
  return createHash("sha1").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

export function formatBlock(missing) {
  return [
    `Ops gate: ${missing.length} action(s) this turn have no matching event:`,
    ...missing.map((m) => `- ${m.why} → ${m.fix}`),
    "(RF_OPS_GATE=off disables this gate; it fails open on its own errors)",
  ].join("\n");
}

/** Loop guard: the 3rd consecutive block for the same hash is allowed. */
export function nextBlockState(prev, hash) {
  const count = prev && prev.hash === hash ? prev.count + 1 : 1;
  return { block: count < 3, record: { hash, count } };
}

// ════════════════════════════════════════════════════════════════════════
// ── IO ─────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

const lib = (name) => pathToFileURL(join(ROOT, "tools", "ops-monitor", "lib", name)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadState(specsDir) {
  const { readAllEvents } = await import(lib("store.mjs"));
  const { fold } = await import(lib("fold.mjs"));
  const events = readAllEvents(specsDir);
  return { state: fold(events), events };
}

/**
 * Monitor-side misses (a push / PR the recorder did not log): one stderr WARNING each and one
 * local incident line in <opsHome>/hook-incidents.jsonl. Never throws, never blocks.
 */
function reportMonitorMisses(warnings, home, session) {
  for (const w of warnings ?? []) {
    try {
      const a = w.action;
      const isPr = w.why === NOT_RECORDED_PR;
      const what = isPr
        ? `PR ${a.number != null ? `#${a.number}` : `on ${a.branch}`}`
        : `push of ${a.branch}`;
      process.stderr.write(
        `ops monitor: ${what} not recorded yet (monitor-side); it will be picked up by the next sync or run \`${w.fix}\`\n`,
      );
      mkdirSync(home, { recursive: true });
      const line = {
        ts: new Date().toISOString(),
        kind: isPr ? "pr-not-recorded" : "push-not-recorded",
        branch: a.branch ?? null,
        sha: a.sha ?? null,
        session: session ?? null,
      };
      if (a.number != null) line.number = a.number;
      appendFileSync(join(home, "hook-incidents.jsonl"), `${JSON.stringify(line)}\n`);
    } catch {
      // never throw
    }
  }
}

async function main() {
  if (process.env.RF_OPS_GATE === "off") return 0;
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== "object" || !payload.session_id) return 0;

  const { opsHome, specsDir } = await import(lib("config.mjs"));
  const { actionsFile, readActions, archiveActions } = await import(lib("turn-actions.mjs"));
  const file = actionsFile(opsHome(), payload.session_id);
  let actions = readActions(file);
  if (actions.length === 0) return 0;
  const dir = specsDir();
  if (!existsSync(join(dir, "events"))) return 0; // no ops clone (CI, cloud): nothing to check

  const { loadConfig, machineId } = await import(lib("config.mjs"));
  const machine = machineId(loadConfig(dir), process.env);
  const judge = async () => {
    actions = readActions(file); // the detached confirmer may have appended since the last look
    return evaluateGate({ actions, machine, ...(await loadState(dir)) });
  };
  let verdict = await judge();
  // The detached recorder may still be pulling/committing the push event (a few seconds on a busy
  // host): re-read up to 15 x 1 s before blocking. A gh merge still awaiting its detached
  // confirmation (pending < 30 s old, no done line) is waited for the same way, up to 30 x 1 s.
  const retryEnv = Number(process.env.RF_OPS_RETRY_MS);
  const retryMs = Number.isFinite(retryEnv) && retryEnv >= 0 ? retryEnv : 1000;
  for (let i = 0; i < 30; i++) {
    const waitPush =
      i < 15 &&
      (verdict.warnings ?? []).some(
        (m) => m.why === NOT_RECORDED_PUSH || m.why === NOT_RECORDED_PR,
      );
    if (!waitPush && !pendingMergeOpen(actions, Date.now())) break;
    await sleep(retryMs);
    verdict = await judge();
  }
  if (verdict.ok) {
    reportMonitorMisses(verdict.warnings, opsHome(), payload.session_id);
    archiveActions(file);
    return 0;
  }

  const blocksFile = `${file}.blocks`;
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(blocksFile, "utf8"));
  } catch {
    // first block
  }
  const { block, record } = nextBlockState(prev, missingHash(verdict.missing));
  if (!block) {
    process.stderr.write(
      `Ops gate: allowing the turn to close after ${record.count} identical blocks. ` +
        `Still unrecorded:\n${verdict.missing.map((m) => `- ${m.why} → ${m.fix}`).join("\n")}\n`,
    );
    reportMonitorMisses(verdict.warnings, opsHome(), payload.session_id);
    archiveActions(file);
    return 0;
  }
  writeFileSync(blocksFile, JSON.stringify(record));
  process.stderr.write(`${formatBlock(verdict.missing)}\n`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let code = 0;
  try {
    code = await main();
  } catch {
    code = 0; // fail open on our own errors
  }
  process.exit(code);
}
