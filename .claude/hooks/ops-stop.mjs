#!/usr/bin/env node
/**
 * Stop gate for the ops monitor. The PostToolUse recorder (ops-post-push.mjs) logs every
 * `git push` / `gh pr ...` of this session's turn; this gate blocks the turn from closing
 * (exit 2) when such an action has no matching event in routeflow-specs, or the pushed
 * branch / PR is not linked to a work item, or a merged PR's item has no status event.
 *
 * FAIL OPEN (this runs at the end of EVERY session once merged; a false block is expensive):
 * any exception, missing/garbled stdin, no actions file, missing ops clone, unreadable events,
 * RF_OPS_GATE=off -> exit 0. The same block repeated 3 times in a row is allowed through
 * (loud stderr line) so a session can never be bricked.
 *
 * Every export above the "── IO" marker is pure and tested directly.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WINDOW_MS = 5 * 60 * 1000;
const RF = "node tools/ops-monitor/bin/rf.mjs";
const TRUNK = new Set(["master", "main"]);

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

/**
 * Which of this turn's actions lack a matching event. `actions` = turn-actions entries
 * ({ts (ms or ISO), kind:'push'|'pr', ...}); `state` = fold() output. `now` is accepted for
 * contract compatibility but no rule needs it.
 * Returns { ok: true } or { ok: false, missing: [{ action, why, fix }] }.
 */
export function evaluateGate({ actions, state }) {
  const missing = [];
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
        missing.push({
          action,
          why: "push not recorded",
          fix: `${RF} event push --branch ${b} --sha ${action.sha} --repo najathakram/routeflow`,
        });
        continue;
      }
      // Direct pushes to trunk have no work item by nature; never demand a link for them.
      if (TRUNK.has(b)) continue;
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
      if (action.action === "create" || action.action === "ready") {
        if (number == null && !branch) continue; // nothing to look up: fail open
        if (!findLinkedItem(state, { number, branch })) {
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
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
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
  return fold(readAllEvents(specsDir));
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
  const actions = readActions(file);
  if (actions.length === 0) return 0;
  const dir = specsDir();
  if (!existsSync(join(dir, "events"))) return 0; // no ops clone (CI, cloud): nothing to check

  let verdict = evaluateGate({ actions, state: await loadState(dir) });
  // The detached recorder may still be pulling/committing the push event (a few seconds on a busy
  // host): re-read up to 15 x 1 s before blocking.
  const retryEnv = Number(process.env.RF_OPS_RETRY_MS);
  const retryMs = Number.isFinite(retryEnv) && retryEnv >= 0 ? retryEnv : 1000;
  for (let i = 0; i < 15 && !verdict.ok; i++) {
    if (!verdict.missing.some((m) => m.why === "push not recorded")) break;
    await sleep(retryMs);
    verdict = evaluateGate({ actions, state: await loadState(dir) });
  }
  if (verdict.ok) {
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
