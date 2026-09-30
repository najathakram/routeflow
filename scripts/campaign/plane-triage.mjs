#!/usr/bin/env node
// plane-triage.mjs — read-only session-start brief over the Plane workspace
// (build-plan.md WP4, .claude/pipeline/2026-09-11-plane-harness/; spec.md R7).
//
// `[--brief|--json] [--days <n>]`. Never writes (no POST/PATCH/DELETE, no
// comments/links/properties calls — read-only by design). Call budget
// (ruling-s4-s5.md, exact accounting): 1 GET projects/ + 5 GET states/ (one
// per BUGS/ROAD/OPS/DECIDE/CLIENT) + 4 GET work-items/ page 1 (ROAD, OPS,
// DECIDE, CLIENT — never paginated here) + BUGS work-items/ (paginated to
// completion) = <= GET_BUDGET (16) GETs total. No PQL, no custom
// properties — plain list endpoints plus client-side filtering only, per
// spec.md's binding rules.
//
// DEFECT 2 (proven live): capping the BUGS listing at 2 pages counted 200 of
// 392 live items and reported drift from a partial list. BUGS now paginates
// to completion; whatever the fixed GETs above cost is spent first, and BUGS
// gets whatever remains of GET_BUDGET. A BUGS project bigger than that
// remainder degrades to a page-capped partial brief (`Plane triage: partial
// (page cap)`, still exit 0) rather than silently under-counting again.
//
// Landmine 15 (build-plan.md, live shapes verified 2026-09-12): a work-item
// may carry its own `state_group`/`target_date`/`updated_at` fields, but this
// script NEVER trusts an item's own `state_group` — every group classification
// resolves through the project's own states/ list (`groupById`, below), the
// same discipline plane-sync.mjs's `idToGroup` already applies.
//
// BUGS drift reuses plane-sync.mjs's exported `deriveDesired`/`planDiff`
// (spec.md R7: "never a second diff implementation") — this file contains no
// second copy of that comparison.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendRun, createClient, loadKnobs, repoRoot, writesToday } from "./plane-client.mjs";
import { currentBranch, deriveDesired, planDiff } from "./plane-sync.mjs";

const WANTED_PROJECTS = ["BUGS", "ROAD", "OPS", "DECIDE", "CLIENT"];
const BRIEF_BYTE_CAP = 1536;
const MANUAL_WRITE_CAP = 20; // spec.md R3's manual-budget ceiling (informational here)

const isoDateOnly = (d) => d.toISOString().slice(0, 10);

// ── the diff, delegated (spec.md R7: "never a second diff implementation") ──
// Resolves each distinct desired state NAME to the BUGS project's own state id
// (same lookup shape plane-sync.mjs's runSync uses) and hands both sides to
// the imported, unmodified `planDiff`. Returns the same {count, ids} shape
// runSync's own --check drift uses: creates + patches + skipped + unverified.
function computeBugsDrift(registryDir, bugsStatesMap, existingItems) {
  let rows;
  try {
    rows = deriveDesired(registryDir);
  } catch {
    return { count: 0, ids: [] }; // an unreadable registry is 0 drift, not a crash
  }
  const stateIdByName = new Map();
  for (const name of new Set(rows.map((d) => d.stateName))) {
    stateIdByName.set(name, bugsStatesMap?.get(String(name ?? "").toLowerCase())?.id);
  }
  const desired = rows.map((d) => ({ ...d, stateId: stateIdByName.get(d.stateName) }));
  const { creates, patches, skipped, unverified } = planDiff(desired, existingItems);
  const ids = [
    ...creates.map((c) => c.external_id),
    ...patches.map((p) => p.desired.external_id),
    ...skipped,
    ...unverified,
  ].slice(0, 10);
  return { count: creates.length + patches.length + skipped.length + unverified.length, ids };
}

// ── network gather (never throws — a failure mid-flight is captured on
// payload.error and whatever was already gathered is returned as-is, so a
// partial brief still reports the sections it reached) ─────────────────────
// `getBudget` defaults to the `triageGetBudget` knob (spec 2026-09-12-plane-
// learning R1) — the caller (main()) resolves it via loadKnobs()/knob() once,
// before any request, and threads it through here rather than this function
// reading the knob itself.
async function gatherTriage({ apiKey, registryDir, days, getBudget }) {
  const payload = {
    overdue: [],
    dueSoon: [],
    openRulings: [],
    staleStarted: [],
    driftCount: 0,
    driftIds: [],
    manualWrites: 0,
    syncWrites: 0,
    countsByProject: [],
    error: null,
    clientSummary: null,
  };

  // Ledger reads are a local file, not network — attempted independently of
  // Plane reachability so a network failure never hides the write-budget
  // signal (the two-am reason this section exists at all).
  try {
    const total = writesToday();
    const manual = writesToday({ exclude: ["plane-sync"] });
    payload.manualWrites = manual;
    payload.syncWrites = Math.max(0, total - manual);
  } catch {
    // missing/unparsable ledger reads as zero — never fatal to the brief.
  }

  const today = isoDateOnly(new Date());
  const untilDate = isoDateOnly(new Date(Date.now() + days * 86_400_000));
  const cutoff = Date.now() - days * 86_400_000;
  const countsMap = new Map();

  const classify = (ident, item) => {
    const group = groupById.get(item.state) ?? "unknown";
    const counts = countsMap.get(ident);
    if (counts) counts[group] = (counts[group] ?? 0) + 1;
    const label = `${ident}-${item.sequence_id}`;
    const open = group !== "completed" && group !== "cancelled";
    if (item.target_date && open) {
      if (item.target_date < today) {
        payload.overdue.push(label);
      } else if ((ident === "OPS" || ident === "ROAD") && item.target_date <= untilDate) {
        payload.dueSoon.push(label);
      }
    }
    if (ident === "DECIDE" && (group === "backlog" || group === "unstarted")) {
      payload.openRulings.push(label);
    }
    if (
      (ident === "ROAD" || ident === "OPS" || ident === "BUGS") &&
      group === "started" &&
      item.updated_at &&
      Date.parse(item.updated_at) < cutoff
    ) {
      payload.staleStarted.push(label);
    }
  };

  const groupById = new Map();
  let byIdent;
  const client = createClient({ apiKey, tool: "plane-triage" });
  try {
    // 1 GET.
    const projects = await client.listAll("projects/");
    byIdent = new Map(
      WANTED_PROJECTS.map((ident) => [ident, projects.find((p) => p.identifier === ident)]),
    );

    for (const ident of WANTED_PROJECTS) {
      if (byIdent.get(ident)) {
        const zero = {
          backlog: 0,
          unstarted: 0,
          started: 0,
          completed: 0,
          cancelled: 0,
          unknown: 0,
        };
        countsMap.set(ident, zero);
        payload.countsByProject.push([ident, zero]);
      }
    }

    // ≤ 5 GETs — one states/ list per known project. Every group
    // classification below reads ONLY this map, never an item's own field
    // (Landmine 15).
    const statesByIdent = new Map();
    for (const ident of WANTED_PROJECTS) {
      const proj = byIdent.get(ident);
      if (!proj) continue;
      const statesMap = await client.resolveStates(proj.id);
      statesByIdent.set(ident, statesMap);
      for (const s of statesMap.values()) groupById.set(s.id, s.group);
    }

    // 4 GETs — page 1 only for ROAD/OPS/DECIDE/CLIENT (ruling-s4-s5.md's
    // budget: these never paginate here; a project with >100 open items is
    // under-counted this run, not over-budget).
    for (const ident of ["ROAD", "OPS", "DECIDE", "CLIENT"]) {
      const proj = byIdent.get(ident);
      if (!proj) continue;
      const page = await client.get(`projects/${proj.id}/work-items/`, {
        query: { per_page: "100" },
      });
      for (const item of page?.results ?? []) classify(ident, item);
    }

    // BUGS, paginated to COMPLETION (Defect 2 — a 2-page cap counted 200 of
    // 392 live items and reported drift from a partial list). Also feeds the
    // drift section. `nonBugsGets` is what the fixed section above already
    // spent (1 projects/ + one states/ per known project, incl. BUGS, + one
    // page-1 GET per known ROAD/OPS/DECIDE/CLIENT); BUGS gets whatever of
    // GET_BUDGET remains. Running out mid-listing degrades to a page-capped
    // partial brief — still every page already fetched is classified and fed
    // to the drift diff, never silently dropped.
    const bugsProj = byIdent.get("BUGS");
    if (bugsProj) {
      const fields =
        "id,name,state,priority,external_id,description_stripped,sequence_id,target_date,updated_at";
      const nonBugsGets =
        1 +
        statesByIdent.size +
        ["ROAD", "OPS", "DECIDE", "CLIENT"].filter((ident) => byIdent.get(ident)).length;
      const maxBugsPages = Math.max(1, getBudget - nonBugsGets);

      let bugsItems = [];
      let cursor;
      let pagesFetched = 0;
      let pageCapped = false;
      do {
        const page = await client.get(`projects/${bugsProj.id}/work-items/`, {
          query: { per_page: "100", fields, ...(cursor ? { cursor } : {}) },
        });
        bugsItems = bugsItems.concat(page?.results ?? []);
        pagesFetched++;
        cursor = page?.next_page_results ? page.next_cursor : null;
        if (cursor && pagesFetched >= maxBugsPages) {
          pageCapped = true;
          cursor = null;
        }
      } while (cursor);
      if (pageCapped) payload.error = "page cap";

      for (const item of bugsItems) classify("BUGS", item);

      const drift = computeBugsDrift(registryDir, statesByIdent.get("BUGS"), bugsItems);
      payload.driftCount = drift.count;
      payload.driftIds = drift.ids;
    }
  } catch (err) {
    payload.error = err?.message ?? String(err);
  }

  payload.clientSummary = client.summary();
  return payload;
}

// ── rendering ────────────────────────────────────────────────────────────
function fmtSection(label, ids, countOverride) {
  const count = countOverride ?? ids.length;
  const shown = ids.slice(0, 10);
  return `${label} ${count}${shown.length ? ": " + shown.join(", ") : ""}`;
}

// Degrades in two steps rather than ever exceeding the cap: first drop every
// identifier list (keep bare counts), then hard-truncate at the byte boundary
// — every character this script emits is ASCII, so a byte slice never splits
// a multi-byte codepoint.
function capToBudget(lines) {
  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= BRIEF_BYTE_CAP) return text;
  text = lines.map((l) => l.replace(/: .*/, "")).join("\n");
  if (Buffer.byteLength(text, "utf8") <= BRIEF_BYTE_CAP) return text;
  return Buffer.from(text, "utf8").subarray(0, BRIEF_BYTE_CAP).toString("utf8");
}

function renderBrief(payload, days) {
  const lines = [`${new Date().toISOString()} Plane triage (last ${days}d)`];
  lines.push(fmtSection("overdue", payload.overdue));
  lines.push(fmtSection(`due <=${days}d`, payload.dueSoon));
  lines.push(fmtSection("open rulings", payload.openRulings));
  lines.push(fmtSection("stale started", payload.staleStarted));
  lines.push(fmtSection("BUGS drift", payload.driftIds, payload.driftCount));
  lines.push(
    `writes today manual ${payload.manualWrites}/${MANUAL_WRITE_CAP} sync ${payload.syncWrites}`,
  );
  for (const [ident, counts] of payload.countsByProject) {
    lines.push(
      `${ident} backlog=${counts.backlog} unstarted=${counts.unstarted} started=${counts.started} ` +
        `completed=${counts.completed} cancelled=${counts.cancelled}`,
    );
  }
  if (payload.error) lines.push(`Plane triage: partial (${payload.error})`);
  return capToBudget(lines);
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = "Usage: plane-triage.mjs [--brief|--json] [--days <n>] [--help]";
const KNOWN_FLAGS = new Set(["--brief", "--json", "--days"]);

async function main() {
  const argv = process.argv.slice(2);

  // R13/T15/Landmine 3: --help/-h and an unknown flag are handled BEFORE
  // process.env.PLANE_API_KEY is even read, before any network call.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--days") {
      i++; // consume the value token, never validated as a flag itself
      continue;
    }
    if (!KNOWN_FLAGS.has(tok)) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  // R2 telemetry (spec 2026-09-12-plane-learning): started/rec set up BEFORE
  // loadKnobs() so a `knobs invalid: <name>` throw still gets exactly one
  // runs.jsonl line via the finally below — --help/usage exits above are the
  // only ones that write none.
  const started = Date.now();
  const rec = { tool: "plane-triage", flags: argv, branch: currentBranch() };
  let clientSummaryForRun = {
    writes: 0,
    deferred: 0,
    forbidden: 0,
    gets: 0,
    rateLimitSleeps: 0,
    retries: 0,
  };

  try {
    // R1: loaded right after --help/usage handling, before any process.env
    // read or network request (T1). Printed explicitly so the exact "knobs
    // invalid: <name>" text always reaches stderr.
    let knobs;
    try {
      knobs = loadKnobs();
    } catch (err) {
      // See plane-sync.mjs's identical note: T1's contract is an out-of-range
      // VALUE in an otherwise present file — that hard-fails. A missing/
      // unreadable file falls back to this tool's documented defaults rather
      // than refusing to run (this script never blocks a turn over Plane).
      if (/^knobs invalid:/.test(String(err?.message ?? ""))) {
        process.stderr.write(`Plane triage: ${err.message}\n`);
        process.exitCode = 1;
        rec.error = `${err?.name ?? "Error"}: ${String(err.message).slice(0, 200)}`;
        return;
      }
      console.error(
        `Plane triage warn: knobs unavailable (${err?.message ?? err}) — using defaults`,
      );
      knobs = { knobs: { staleStartedDays: { value: 7 }, triageGetBudget: { value: 16 } } };
    }

    const asJson = argv.includes("--json");
    // `--days` default comes from the `staleStartedDays` knob; a CLI flag
    // still overrides it.
    let days = knobs.knobs.staleStartedDays.value;
    const daysIdx = argv.indexOf("--days");
    if (daysIdx !== -1) {
      const raw = Number(argv[daysIdx + 1]);
      if (Number.isFinite(raw) && raw > 0) days = raw;
      else
        process.stderr.write(
          `Plane triage warn: ignoring --days "${argv[daysIdx + 1] ?? ""}" (not a positive number)\n`,
        );
    }
    // knobs.knobs here is either the real loaded object or this catch
    // block's own fallback shape above — both carry `triageGetBudget`, so
    // this never re-throws the way a bare `knob()` call could.
    const getBudget = knobs.knobs.triageGetBudget.value;

    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      process.stdout.write("Plane triage: skipped (no PLANE_API_KEY)\n");
      process.exitCode = 0;
      rec.skipped = "no PLANE_API_KEY";
      return;
    }

    const registryDir =
      process.env.PLANE_SYNC_REGISTRY_DIR || join(repoRoot(), ".claude", "campaign");
    const payload = await gatherTriage({ apiKey, registryDir, days, getBudget });

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ days, ...payload }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderBrief(payload, days)}\n`);
    }
    process.exitCode = 0;

    if (payload.clientSummary) clientSummaryForRun = payload.clientSummary;
    rec.triage = {
      overdue: payload.overdue.length,
      dueSoon: payload.dueSoon.length,
      openRulings: payload.openRulings.length,
      staleStarted: payload.staleStarted.length,
      drift: payload.driftCount,
      partial: payload.error === "page cap",
    };
  } catch (err) {
    process.exitCode = 1;
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    // R2's `forbidden` field is `{count, byPattern}`; this script never
    // writes, so a forbidden hit here (from the shared client's own guard,
    // never actually reachable on a read-only path) has no per-pattern
    // breakdown to report.
    const { forbidden: forbiddenCount, ...restSummary } = clientSummaryForRun;
    appendRun({
      ...rec,
      exit: process.exitCode ?? 0,
      durationMs: Date.now() - started,
      ...restSummary,
      forbidden: { count: forbiddenCount ?? 0, byPattern: {} },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
