#!/usr/bin/env node
// plane-intake.mjs — the Plane → registry front door (build-plan.md WP3,
// .claude/pipeline/2026-09-11-plane-harness/, spec.md R6). The ONLY direction
// Plane is ever allowed to move the registry: a human files a bug straight in
// Plane's BUGS project (no `B### ·` name prefix yet, `external_id` still
// null) and this script turns it into a real registry entry.
//
// LISTING (default, no --apply): read-only. Prints one ready-to-run
// `bugs.mjs file ...` command per human-created BUGS item, plus a
// report-only count of Intake-queue records still awaiting owner triage
// (status -2 — see Landmine 14/15 below). Makes zero writes, needs no git
// state, and exits 0 with a skip line when PLANE_API_KEY is absent (same
// "never blocks" contract every Plane script in this family keeps).
//
// --apply: mints the registry ids for real. Preconditions, in this exact
// order (spec.md R6 / build-plan.md WP3, each ending the run at exit 2 with
// zero writes on failure): (1) `.claude/campaign` is clean
// (`git status --porcelain`) — ids are only ever minted from a tree with no
// in-flight registry edits; (2) HEAD descends from `origin/master` — ids are
// minted only on master-merged trees; (3) PLANE_API_KEY is present. Then,
// per listable item: spawn `bugs.mjs file ...` (Landmine 1: the throwaway
// registry dir the self-test points at travels as PLANE_SYNC_REGISTRY_DIR,
// which bugs.mjs itself only understands as BUGS_ROOT — translated here),
// parse the minted `B###` off its stdout, PATCH the SAME Plane item to stamp
// `external_source`/`external_id`/the `B### · <name>` prefix, then spawn
// `bugs.mjs note ... --section "Summary"` and swallow whatever it does
// (Landmine 2: `note --section` needs a section that already exists in the
// generated record — a freshly filed one may not carry it yet, so a failure
// here is expected to no-op, not a failure of this run).
//
// R2 (denylist): every outbound name is scanned before it is ever printed or
// written. A hit during listing drops that one item with a
// `Plane intake warn:` line (never the matched text); a hit surviving to an
// --apply write (should never happen — the write is always over a name this
// same run already screened) fails that op, exit 1, index + pattern name
// only.
//
// R3 (manual write budget): --apply refuses before making ANY write when
// today's non-plane-sync ledger total plus this run's planned PATCH count
// would exceed 20, unless --over-budget "<reason>" is passed (the reason is
// then carried into every ledger line this run produces).
//
// Landmine 14/15: the real Plane REST shape for the Intake-queue resource is
// `GET projects/{project}/intake-issues/` (paginated; a record carries
// `status` -2 pending … 2 duplicate, and `issue` = the work item id) —
// verified live 2026-09-12. `intake-work-items/` does not exist. A 404 here
// is not a failure of this script: log `intake: endpoint unavailable (404)`
// and continue reporting 0 pending.
//
// R13/Landmine 3: --help/-h and an unknown flag are handled before
// PLANE_API_KEY is read at all, before any network call — see main().
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  appendRun,
  createClient,
  EXTERNAL_SOURCE,
  gitEnv,
  knob,
  loadKnobs,
  NAME_ID_RE,
  repoRoot,
  scanForbidden,
  writesToday,
} from "./plane-client.mjs";
import { currentBranch } from "./plane-sync.mjs";

const BUGS_SCRIPT = fileURLToPath(new URL("./bugs.mjs", import.meta.url));

// intake default 20 (spec.md R3) — independent of plane-sync's syncMaxWrites
// and plane-apply's own default; each caller sets its own, never a shared
// constant. The MANUAL budget (writesToday ceiling, below) is knob-driven
// (spec 2026-09-12-plane-learning R1: `applyManualBudgetPerDay`) — this
// per-run client cap is not.
const DEFAULT_MAX_WRITES = 20;

const USAGE =
  'Usage: plane-intake.mjs [--apply] [--batch F##] [--over-budget "<reason>"] ' +
  "[--json] [--relink B###=PROJECT-N ...] [--help]";

// Same "<PROJECT>-<sequence_id>" shape plane-apply.mjs's REF_RE gives — only
// used here to parse a --relink pair's ref half.
const REF_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const RELINK_PAIR_RE = /^(B\d+)=(.+)$/;

// Finding C: shared BUGS_ROOT/PLANE_SYNC_REGISTRY_DIR translation
// (Landmine 1, same precedence applyCandidates() already used for the
// spawned bugs.mjs) — so --relink's registry-row validation and
// gatherIntake's title-dedup scan always read the exact catalogue
// applyCandidates() itself mints into. Falls back to bugs.mjs's own default
// (`.claude/campaign` under the repo root) when neither env var is set,
// matching what bugs.mjs resolves on its own when spawned with cwd=repoRoot().
function registryRoot() {
  return (
    process.env.PLANE_SYNC_REGISTRY_DIR ??
    process.env.BUGS_ROOT ??
    join(repoRoot(), ".claude", "campaign")
  );
}

function readCatalogueRows() {
  const file = join(registryRoot(), "bugs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // a malformed catalogue line is skipped, never a crash
      }
    })
    .filter(Boolean);
}

// case/whitespace-normalised title match (Finding C3) — "  Scanner  crashes"
// and "scanner crashes" are the same title for dedup purposes.
function normalizeTitle(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// sev = priority map, verbatim (spec.md R6): urgent→critical, high→high,
// medium→medium, low/none/missing→low.
const SEVERITY_BY_PRIORITY = {
  urgent: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  none: "low",
};

// "loc = `Area · <first area label among api/web/mobile/infra/docs>`" —
// checked in THIS priority order, case-insensitively; the label's own
// casing (not a forced-lowercase token) is what ends up in the printed
// location.
const AREA_LABEL_ORDER = ["api", "web", "mobile", "infra", "docs"];

function severityFor(priority) {
  const key = String(priority ?? "none").toLowerCase();
  return SEVERITY_BY_PRIORITY[key] ?? "low";
}

function locationFor(item, labelNameById) {
  const names = (item.labels ?? [])
    .map((id) => labelNameById.get(id))
    .filter((name) => typeof name === "string" && name.length > 0);
  for (const area of AREA_LABEL_ORDER) {
    const match = names.find((name) => name.toLowerCase() === area);
    if (match) return `Area · ${match}`;
  }
  return "Unknown · triage";
}

// The exact ready-command shape, spec.md R6 verbatim:
//   bugs.mjs file "<name>" --location "<loc>" --severity <sev> [--batch F##] --tier T1
// --tier T1 is always present (bugs.mjs only enforces it when --batch is
// also given; passing it unconditionally is harmless and keeps the printed
// command identical to what --apply actually runs).
function readyCommand({ name, location, severity, batch }) {
  const escapedName = name.replace(/"/g, '\\"');
  const parts = [
    "node",
    "scripts/campaign/bugs.mjs",
    "file",
    `"${escapedName}"`,
    "--location",
    `"${location}"`,
    "--severity",
    severity,
  ];
  if (batch) parts.push("--batch", batch);
  parts.push("--tier", "T1");
  return parts.join(" ");
}

// Same shape as readyCommand(), as a real argv array (no quoting needed —
// spawn takes each argument literally) — this is what --apply actually runs,
// so the two must never drift apart.
function fileArgv({ name, location, severity, batch }) {
  const args = ["file", name, "--location", location, "--severity", severity];
  if (batch) args.push("--batch", batch);
  args.push("--tier", "T1");
  return args;
}

// Lists candidate BUGS items (external_id null, name not yet `B### · …`) and
// the Intake-queue's pending count. Shared by listing and --apply so the
// items --apply writes are always exactly the items listing just showed.
async function gatherIntake(client) {
  const project = await client.resolveProject("BUGS");
  const items = await client.listAll(`projects/${project.id}/work-items/`);
  const labelList = await client.listAll(`projects/${project.id}/labels/`);
  const labelNameById = new Map(labelList.map((l) => [l.id, l.name]));

  // Finding C3: an item already filed as a registry row by title (a human
  // ran `bugs.mjs file` directly, never through this script) must never be
  // offered again as a NEW candidate — that would mint a SECOND id for the
  // same bug. Built once per gatherIntake() call so both listing and --apply
  // see the identical exclusion set.
  const registryIdByTitle = new Map(
    readCatalogueRows()
      .filter((row) => row && typeof row.id === "string" && typeof row.title === "string")
      .map((row) => [normalizeTitle(row.title), row.id]),
  );

  const candidates = [];
  for (const item of items) {
    if (item.external_id) continue;
    if (NAME_ID_RE.test(String(item.name ?? ""))) continue;
    const hit = scanForbidden(item.name);
    if (hit) {
      // Never print the matched text (R2) — reference the item by its
      // sequence number instead of its (possibly forbidden) name.
      console.error(`Plane intake warn: BUGS-${item.sequence_id ?? "?"} forbidden (${hit.name})`);
      continue;
    }
    const existingId = registryIdByTitle.get(normalizeTitle(item.name));
    if (existingId) {
      console.error(
        `Plane intake: BUGS-${item.sequence_id ?? "?"} already filed as ${existingId} ` +
          `(relink with --relink ${existingId}=BUGS-${item.sequence_id ?? "?"})`,
      );
      continue;
    }
    candidates.push({
      item,
      severity: severityFor(item.priority),
      location: locationFor(item, labelNameById),
    });
  }

  let pending = 0;
  try {
    const records = await client.listAll(`projects/${project.id}/intake-issues/`);
    pending = records.filter((r) => r?.status === -2).length;
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/HTTP 404/.test(message)) {
      console.error("Plane intake: endpoint unavailable (404)");
    } else {
      console.error(`Plane intake warn: intake-issues unavailable (${message})`);
    }
    pending = 0;
  }

  return { project, candidates, pending };
}

function printListing({ candidates, pending }, { batch, json }) {
  if (json) {
    const commands = candidates.map(({ item, severity, location }) => ({
      name: item.name,
      severity,
      location,
      batch: batch ?? null,
      command: readyCommand({ name: item.name, location, severity, batch }),
    }));
    process.stdout.write(`${JSON.stringify({ commands, pending }, null, 2)}\n`);
    return;
  }
  for (const { item, severity, location } of candidates) {
    process.stdout.write(`${readyCommand({ name: item.name, location, severity, batch })}\n`);
  }
  process.stdout.write(`awaiting owner triage: ${pending}\n`);
}

// --apply: mint one registry id per candidate, then stamp the Plane item.
// Returns the process exit code (0 on success — non-zero cases each write
// their own message and return immediately, per-item, so a mid-run failure
// never silently swallows the items after it).
async function applyCandidates(
  client,
  project,
  candidates,
  { batch, overBudgetReason, json, manualBudgetLimit },
) {
  const planned = candidates.length;
  if (!overBudgetReason) {
    const usedToday = writesToday({ exclude: ["plane-sync"] });
    if (usedToday + planned > manualBudgetLimit) {
      process.stderr.write(
        `Plane intake: refused --apply — manual write budget exceeded ` +
          `(${usedToday} today + ${planned} planned > ${manualBudgetLimit}); ` +
          `pass --over-budget "<reason>" to proceed\n`,
      );
      return { exitCode: 3, filed: 0 };
    }
  }

  const root = repoRoot();
  const env = {
    ...process.env,
    // Landmine 1: bugs.mjs reads BUGS_ROOT, not PLANE_SYNC_REGISTRY_DIR.
    BUGS_ROOT: registryRoot(),
  };

  const applied = [];
  for (let i = 0; i < candidates.length; i++) {
    const { item, severity, location } = candidates[i];
    const argv = fileArgv({ name: item.name, location, severity, batch });
    const fileRes = spawnSync(process.execPath, [BUGS_SCRIPT, ...argv], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    const minted = /filed (B\d+)/.exec(fileRes.stdout ?? "");
    if (fileRes.error || fileRes.status !== 0 || !minted) {
      process.stderr.write(
        `Plane intake: #${i + 1} bugs.mjs file failed — ` +
          `${(fileRes.stderr || fileRes.stdout || fileRes.error?.message || "no output").trim()}\n`,
      );
      return { exitCode: 1, filed: applied.length };
    }
    const mintedId = minted[1];

    // Finding C1 (Opus #4): the id is ALREADY minted at this point — a PATCH
    // failure (thrown, e.g. a non-2xx) or a denylist hit here must never
    // leave the row silently orphaned. Both get the identical remediation:
    // the registry row stays (never rolled back — bugs.mjs has no undo), the
    // Plane item stays unlinked, and the run stops (zero further writes,
    // never mints a second id for the same item on a naive rerun).
    const relinkHint = () =>
      `minted ${mintedId} for BUGS-${item.sequence_id} but the Plane link failed — rerun: ` +
      `node scripts/campaign/plane-intake.mjs --relink ${mintedId}=BUGS-${item.sequence_id}`;
    let patchResult;
    try {
      patchResult = await client.patch(
        `projects/${project.id}/work-items/${item.id}/`,
        {
          external_source: EXTERNAL_SOURCE,
          external_id: mintedId,
          name: `${mintedId} · ${item.name}`,
        },
        { ref: mintedId, ...(overBudgetReason ? { reason: overBudgetReason } : {}) },
      );
    } catch {
      process.stderr.write(`Plane intake: ${relinkHint()}\n`);
      return { exitCode: 1, filed: applied.length };
    }
    if (patchResult?.forbidden || patchResult?.deferred) {
      // forbidden should never trigger — item.name already passed
      // scanForbidden in gatherIntake — and deferred should never trigger at
      // intake's own maxWrites=20 for a single-digit candidate list, but
      // either one leaves the item unlinked exactly like a thrown PATCH, so
      // both get the SAME remediation path (Finding C1), never the old
      // "forbidden (...)" message that had no rerun story.
      process.stderr.write(`Plane intake: ${relinkHint()}\n`);
      return { exitCode: 1, filed: applied.length };
    }

    // Fable ruling: bugs.mjs's SECTIONS are Summary | What this feature is
    // for | Root cause | User impact | Fix approach and UX | Test plan —
    // "Links" was never one of them. Use "Summary" instead. Still swallowed
    // silently on failure (Landmine 2 / R6: "skip the note silently if
    // unavailable") — a freshly `expand()`-ed record may not carry the
    // section either, and that must never fail this run.
    try {
      spawnSync(
        process.execPath,
        [BUGS_SCRIPT, "note", mintedId, `Plane: BUGS-${item.sequence_id}`, "--section", "Summary"],
        { cwd: root, env, encoding: "utf8" },
      );
    } catch {
      // never fatal — see comment above
    }

    applied.push(mintedId);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ applied }, null, 2)}\n`);
  } else {
    process.stdout.write(`Plane intake: applied ${applied.length}/${candidates.length}\n`);
  }
  return { exitCode: 0, filed: applied.length };
}

// Finding C2 (Opus #4): the recovery half of C1's remediation line — repair
// ONE item left unlinked by a failed --apply PATCH, with NO minting (the
// registry row from the earlier --apply already exists). Validates every
// pair BEFORE any write (same "validate first" discipline as plane-apply),
// so a bad pair in a batch of --relink flags never leaves an earlier one
// half-applied. Deliberately skips --apply's dirty-tree/origin-master
// preconditions — those exist to protect deterministic id MINTING, and this
// path never mints.
async function resolveRelink(client, mintedId, ref, registryRows) {
  const m = REF_RE.exec(String(ref ?? ""));
  if (!m) return { error: `--relink ref "${ref}" is not a valid identifier (expected PROJECT-N)` };
  const identifier = m[1];
  const seq = Number(m[2]);

  const registryRow = registryRows.find((r) => r.id === mintedId);
  if (!registryRow) {
    return { error: `--relink ${mintedId}=${ref}: no registry row "${mintedId}" found` };
  }

  let targetProject;
  try {
    targetProject = await client.resolveProject(identifier);
  } catch (err) {
    return { error: `--relink ${mintedId}=${ref}: ${err?.message ?? err}` };
  }
  const items = await client.listAll(`projects/${targetProject.id}/work-items/`);
  const item = items.find((it) => it.sequence_id === seq);
  if (!item) {
    return {
      error: `--relink ${mintedId}=${ref}: no work item "${ref}" found in project ${identifier}`,
    };
  }
  if (item.external_id) {
    return {
      error: `--relink ${mintedId}=${ref}: item is already linked (external_id=${item.external_id})`,
    };
  }

  return { project: targetProject, item };
}

async function applyRelinks(client, pairs, { overBudgetReason, json, manualBudgetLimit } = {}) {
  const registryRows = readCatalogueRows();

  const resolved = [];
  for (const { mintedId, ref } of pairs) {
    const r = await resolveRelink(client, mintedId, ref, registryRows);
    if (r.error) {
      process.stderr.write(`Plane intake: ${r.error}\n`);
      return { exitCode: 1, relinked: 0 };
    }
    resolved.push({ mintedId, ref, project: r.project, item: r.item });
  }

  if (!overBudgetReason) {
    const usedToday = writesToday({ exclude: ["plane-sync"] });
    if (usedToday + resolved.length > manualBudgetLimit) {
      process.stderr.write(
        `Plane intake: refused --relink — manual write budget exceeded ` +
          `(${usedToday} today + ${resolved.length} planned > ${manualBudgetLimit}); ` +
          `pass --over-budget "<reason>" to proceed\n`,
      );
      return { exitCode: 3, relinked: 0 };
    }
  }

  const relinked = [];
  for (const { mintedId, ref, project, item } of resolved) {
    const patchResult = await client.patch(
      `projects/${project.id}/work-items/${item.id}/`,
      {
        external_source: EXTERNAL_SOURCE,
        external_id: mintedId,
        name: `${mintedId} · ${item.name}`,
      },
      { ref: mintedId, ...(overBudgetReason ? { reason: overBudgetReason } : {}) },
    );
    if (patchResult?.forbidden) {
      process.stderr.write(
        `Plane intake: --relink ${mintedId}=${ref} forbidden (${patchResult.forbidden.name})\n`,
      );
      return { exitCode: 1, relinked: relinked.length };
    }
    if (patchResult?.deferred) {
      process.stderr.write(`Plane intake: --relink ${mintedId}=${ref} deferred (max-writes)\n`);
      return { exitCode: 1, relinked: relinked.length };
    }
    relinked.push(mintedId);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ relinked }, null, 2)}\n`);
  } else {
    process.stdout.write(`Plane intake: relinked ${relinked.length}/${resolved.length}\n`);
  }
  return { exitCode: 0, relinked: relinked.length };
}

async function main() {
  const argv = process.argv.slice(2);

  // Landmine 3/R13/T15: --help/-h and an unknown flag are handled BEFORE
  // process.env.PLANE_API_KEY is read at all, before any network call.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }

  let applyMode = false;
  let jsonMode = false;
  let batch;
  let overBudgetReason;
  const relinkPairs = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--apply") {
      applyMode = true;
      continue;
    }
    if (tok === "--json") {
      jsonMode = true;
      continue;
    }
    if (tok === "--batch") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      batch = v;
      continue;
    }
    if (tok === "--over-budget") {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      overBudgetReason = v;
      continue;
    }
    if (tok === "--relink") {
      const v = argv[++i];
      const m = v === undefined ? null : RELINK_PAIR_RE.exec(v);
      if (!m) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return;
      }
      relinkPairs.push({ mintedId: m[1], ref: m[2] });
      continue;
    }
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  // R2 telemetry (spec 2026-09-12-plane-learning): started/rec set up BEFORE
  // loadKnobs() so a `knobs invalid: <name>` throw still gets exactly one
  // runs.jsonl line via the finally below — --help/usage exits above are the
  // only ones that write none.
  const started = Date.now();
  const rec = { tool: "plane-intake", flags: argv, branch: currentBranch() };
  let client;
  const zeroClientSummary = () => ({
    writes: 0,
    deferred: 0,
    forbidden: 0,
    gets: 0,
    rateLimitSleeps: 0,
    retries: 0,
  });

  try {
    // R1: loaded right after --help/usage handling, before any process.env
    // read or network request (T1) — including `process.env.PLANE_API_KEY`
    // below. Printed explicitly (not left to the outer catch) so the exact
    // "knobs invalid: <name>" text always reaches stderr.
    let manualBudgetLimit;
    try {
      loadKnobs();
      manualBudgetLimit = knob("applyManualBudgetPerDay");
    } catch (err) {
      // See plane-sync.mjs's identical note: T1's contract is an out-of-range
      // VALUE in an otherwise present file — that hard-fails. A missing/
      // unreadable file falls back to the knob's documented default.
      if (/^knobs invalid:/.test(String(err?.message ?? ""))) {
        process.stderr.write(`Plane intake: ${err.message}\n`);
        process.exitCode = 1;
        rec.error = `${err?.name ?? "Error"}: ${String(err.message).slice(0, 200)}`;
        return;
      }
      console.error(
        `Plane intake warn: knobs unavailable (${err?.message ?? err}) — using defaults`,
      );
      manualBudgetLimit = 20;
    }

    const apiKey = process.env.PLANE_API_KEY;

    // Finding C2: --relink is its own mode — it never mints, so it skips
    // --apply's dirty-tree/origin-master preconditions entirely (those exist
    // only to protect deterministic id minting) and short-circuits here,
    // before falling into the listing/--apply branches below.
    if (relinkPairs.length > 0) {
      if (!apiKey) {
        process.stderr.write("Plane intake: refused --relink — PLANE_API_KEY is not set\n");
        process.exitCode = 2;
        rec.intake = { listed: 0, pending: 0, filed: 0, relinked: 0 };
        return;
      }
      client = createClient({ apiKey, tool: "plane-intake", maxWrites: DEFAULT_MAX_WRITES });
      try {
        const result = await applyRelinks(client, relinkPairs, {
          overBudgetReason,
          json: jsonMode,
          manualBudgetLimit,
        });
        process.exitCode = result.exitCode;
        rec.intake = { listed: 0, pending: 0, filed: 0, relinked: result.relinked };
      } catch (err) {
        process.stderr.write(`Plane intake: failed — ${err?.message ?? err}\n`);
        process.exitCode = 1;
        rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
      }
      return;
    }

    if (applyMode) {
      // Precondition order, spec.md R6 / build-plan.md WP3, verbatim: dirty
      // tree, then master-ancestor, then key — each exits 2 with zero writes.
      // Explicit cwd (process.cwd(), matching the implicit default this always
      // ran with — never repoRoot(), which would resolve to THIS script's own
      // worktree rather than wherever the caller invoked it from) + gitEnv()
      // (never inherit GIT_DIR/GIT_WORK_TREE from a pre-push-hook-style
      // ambient env — see plane-client.mjs's gitEnv() doc).
      const statusRes = spawnSync("git", ["status", "--porcelain", "--", ".claude/campaign"], {
        cwd: process.cwd(),
        env: gitEnv(),
        encoding: "utf8",
      });
      if (statusRes.error || statusRes.status !== 0) {
        process.stderr.write(
          `Plane intake: refused --apply — could not check git status ` +
            `(${statusRes.error?.message ?? statusRes.stderr ?? "git status failed"})\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (statusRes.stdout.trim()) {
        process.stderr.write(
          "Plane intake: refused --apply — .claude/campaign has uncommitted changes (dirty)\n",
        );
        process.exitCode = 2;
        return;
      }

      const ancestorRes = spawnSync(
        "git",
        ["merge-base", "--is-ancestor", "origin/master", "HEAD"],
        { cwd: process.cwd(), env: gitEnv(), encoding: "utf8" },
      );
      if (ancestorRes.error || ancestorRes.status !== 0) {
        process.stderr.write(
          "Plane intake: refused --apply — HEAD does not descend from origin/master\n",
        );
        process.exitCode = 2;
        return;
      }

      if (!apiKey) {
        process.stderr.write("Plane intake: refused --apply — PLANE_API_KEY is not set\n");
        process.exitCode = 2;
        return;
      }
    } else if (!apiKey) {
      process.stderr.write("Plane intake: skipped (no PLANE_API_KEY)\n");
      process.exitCode = 0;
      rec.skipped = "no PLANE_API_KEY";
      return;
    }

    client = createClient({ apiKey, tool: "plane-intake", maxWrites: DEFAULT_MAX_WRITES });

    try {
      const { project, candidates, pending } = await gatherIntake(client);

      if (!applyMode) {
        printListing({ candidates, pending }, { batch, json: jsonMode });
        process.exitCode = 0;
        rec.intake = { listed: candidates.length, pending, filed: 0, relinked: 0 };
        return;
      }

      const result = await applyCandidates(client, project, candidates, {
        batch,
        overBudgetReason,
        json: jsonMode,
        manualBudgetLimit,
      });
      process.exitCode = result.exitCode;
      rec.intake = { listed: candidates.length, pending, filed: result.filed, relinked: 0 };
    } catch (err) {
      process.stderr.write(`Plane intake: failed — ${err?.message ?? err}\n`);
      process.exitCode = applyMode ? 1 : 0;
      rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
    }
  } catch (err) {
    process.exitCode = process.exitCode ?? 1;
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    // R2's `forbidden` field is `{count, byPattern}` — the count comes from
    // the shared client's write-time guard (gatherIntake's own listing-time
    // scanForbidden drops are a separate, non-write concern reported via the
    // `Plane intake warn:` lines above, not folded in here).
    const summary = client ? client.summary() : zeroClientSummary();
    const { forbidden: forbiddenCount, ...restSummary } = summary;
    appendRun({
      ...rec,
      exit: process.exitCode ?? 0,
      durationMs: Date.now() - started,
      ...restSummary,
      forbidden: { count: forbiddenCount ?? 0, byPattern: {} },
    });
  }
}

main();
