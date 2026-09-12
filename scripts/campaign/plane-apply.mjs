#!/usr/bin/env node
// plane-apply.mjs — the one script that WRITES arbitrary, human-authored
// changes into Plane from an ops file. See .claude/pipeline/
// 2026-09-11-plane-harness/build-plan.md (WP5, R8) and ruling-s4-s5.md's
// "plane-apply resolution order" hard line.
//
// `node scripts/campaign/plane-apply.mjs <ops.json> [--dry-run]
// [--max-writes n] [--over-budget "<reason>"]`. Ops file: `{"ops":[...]}`,
// each op one of update|comment|create|relation|archive|link. NO PLANE UUIDS
// anywhere in this file or in anything it prints: every target is named by
// its identifier (`"ref":"ROAD-15"`), every project/state/label/type/member
// by NAME, resolved at runtime via the shared client. Per the Fable ruling on
// the ops-file schema: an op's project is parsed from its own `ref`'s
// "<PROJECT>-<n>" prefix; only `create` (which names no existing item) carries
// an explicit `"project"`.
//
// VALIDATION FIRST, THEN WRITES (the hard line, verbatim): every ref/name in
// the whole ops file resolves — projects, then states/labels/types/members
// per referenced project, then every ref (via a work-items page of that
// project matched on sequence_id) — before the first write happens anywhere.
// `archive` additionally checks the target's CURRENT state group at
// resolution time (must be completed/cancelled) — the same validation-error
// path as an unresolvable ref. A miss throws `{opIndex, message}`, caught at
// the top as `#<opIndex+1> <message>`, exit 1, zero writes made. The denylist
// scan (R2) also runs during this same validation pass, over every outbound
// string (name/description_html/comment_html/url) — a hit is a validation
// failure too (`... forbidden (<pattern name>)`, the matched text itself
// never printed), not merely a skipped write like plane-sync: apply fails the
// whole run before touching the network.
//
// TWO SEPARATE BUDGETS. (1) The shared client's own per-run `maxWrites`
// (`--max-writes`, default 20) defers writes past that count within THIS
// process — ordinary R3 behaviour, unchanged from plane-sync/plane-client.
// (2) The MANUAL write-budget refusal (R3, apply/intake-specific): before
// touching the network at all, if `writesToday({exclude:["plane-sync"]})`
// plus this run's own op count would exceed 20, the whole run refuses
// (exit 3, zero writes) unless `--over-budget "<reason>"` is given, in which
// case every write this run makes carries that reason in its ledger line.
// `--dry-run` never trips this refusal — it writes nothing regardless.
//
// EXIT CODES. 0 ok · 1 validation failure or a write failed mid-run · 2
// missing PLANE_API_KEY or a bad CLI invocation · 3 manual write-budget
// refusal · 4 one or more ops deferred by `--max-writes` (Finding A/Opus
// #2) — printed per-op as `#i <op> <ref> → deferred (max-writes)`, summary
// `Plane apply: applied=N deferred=M`; once the first op defers, every op
// after it would also defer (the client's own maxWrites counter never
// resets mid-run), so none of them are even attempted. Unlike every other
// plane-*.mjs script, a missing key is NOT a silent skip: this script's
// whole purpose is to write (spec.md binding rules single it out by name).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  appendRun,
  createClient,
  knob,
  loadKnobs,
  scanForbidden,
  writesToday,
} from "./plane-client.mjs";
import { currentBranch } from "./plane-sync.mjs";

// "<PROJECT>-<sequence_id>", the only ref shape spec.md gives (`ROAD-15`,
// `OPS-23`, …) — the project identifier is everything before the last "-".
const REF_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

const DEFAULT_MAX_WRITES = 20;

// Defect fix 2026-09-12: the live Plane REST API's `relation_type` is a
// snake_case enum — a human relation label ("relates to") sent verbatim (the
// ops file's own vocabulary) got HTTP 400 `"relates to" is not a valid
// choice`. Accept an enum value as-is, or a human label normalised
// case-insensitively with spaces/hyphens folded to underscores
// ("relates to"/"Relates to"/"blocked by" → `relates_to`/`relates_to`/
// `blocked_by`) — reject anything else at validation time, before any
// write, per the Fable ruling.
const RELATION_TYPES = [
  "blocking",
  "blocked_by",
  "start_before",
  "start_after",
  "finish_before",
  "finish_after",
  "relates_to",
  "duplicate",
];
const RELATION_TYPE_SET = new Set(RELATION_TYPES);

// ── ops-file validation + plan building (zero network writes) ──────────────
// Builds one execute() closure per op, in file order, after EVERY ref/name in
// the whole file has resolved. Throws an Error carrying `.opIndex` (0-based)
// on the first unresolvable ref/name/state/label/type/member or denylist hit
// — the caller turns that into `#<opIndex+1> <message>`.
async function buildPlan(client, ops, overBudgetReason) {
  const projectCache = new Map(); // identifier -> ctx
  const memberCache = new Map(); // display name -> member id

  function fail(index, message) {
    const err = new Error(message);
    err.opIndex = index;
    throw err;
  }

  function parseRef(ref, index, field) {
    const m = REF_RE.exec(String(ref ?? ""));
    if (!m) fail(index, `${field} "${ref}" is not a valid identifier (expected PROJECT-N)`);
    return { identifier: m[1], seq: Number(m[2]) };
  }

  // Accepts an enum value as-is; accepts a human label ignoring case and
  // with spaces/hyphens folded to underscores; rejects anything else here
  // (validation time, zero writes made) — never at write time.
  function normalizeRelationType(raw, index) {
    const normalized = String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    if (RELATION_TYPE_SET.has(normalized)) return normalized;
    fail(index, `unknown relation type "${raw}" (valid: ${RELATION_TYPES.join(", ")})`);
  }

  async function getProjectCtx(identifier, index) {
    if (projectCache.has(identifier)) return projectCache.get(identifier);
    let project;
    try {
      project = await client.resolveProject(identifier);
    } catch (err) {
      fail(index, err?.message ?? String(err));
    }
    const [states, labels, types, items] = await Promise.all([
      client.resolveStates(project.id),
      client.resolveLabels(project.id),
      client.resolveTypes(project.id),
      client.listAll(`projects/${project.id}/work-items/`, { query: { per_page: "100" } }),
    ]);
    const itemsBySeq = new Map(items.map((it) => [it.sequence_id, it]));
    const idToGroup = new Map([...states.values()].map((s) => [s.id, s.group]));
    // Finding B (Opus #6): reverse the same `states` map (id -> lowercased
    // name) so the archive-precondition message can name a state whose
    // `group` came back missing/undefined WITHOUT ever falling back to the
    // raw Plane id — the id is still resolvable here even when its group
    // isn't, since both come from this one project states list.
    const idToName = new Map([...states].map(([name, s]) => [s.id, name]));
    const ctx = { project, states, labels, types, itemsBySeq, idToGroup, idToName };
    projectCache.set(identifier, ctx);
    return ctx;
  }

  async function resolveItem(ref, index, field = "ref") {
    const { identifier, seq } = parseRef(ref, index, field);
    const ctx = await getProjectCtx(identifier, index);
    const item = ctx.itemsBySeq.get(seq);
    if (!item) fail(index, `no work item "${ref}" found in project ${identifier}`);
    return { ctx, item };
  }

  function resolveStateId(ctx, name, index) {
    const entry = ctx.states.get(String(name ?? "").toLowerCase());
    if (!entry) fail(index, `no state named "${name}" in project ${ctx.project.identifier}`);
    return entry.id;
  }

  function resolveLabelIds(ctx, names, index) {
    return (names ?? []).map((name) => {
      const id = ctx.labels.get(String(name ?? "").toLowerCase());
      if (!id) fail(index, `no label named "${name}" in project ${ctx.project.identifier}`);
      return id;
    });
  }

  async function resolveMemberId(name, index) {
    if (memberCache.has(name)) return memberCache.get(name);
    const id = await client.resolveMember(name);
    if (!id) fail(index, `no member named "${name}"`);
    memberCache.set(name, id);
    return id;
  }

  // R2: every outbound string, scanned during validation (never at write
  // time) so a hit fails the whole run before any write, per apply's own
  // stricter contract — never just the one op, unlike plane-sync's skip.
  function checkDenylist(index, label, strings) {
    for (const s of strings) {
      if (!s) continue;
      const hit = scanForbidden(s);
      if (hit) fail(index, `${label} forbidden (${hit.name})`);
    }
  }

  const plan = [];

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] ?? {};
    const writeOpts = overBudgetReason ? { reason: overBudgetReason } : {};

    if (op.op === "update") {
      if (!op.ref) fail(index, `update requires "ref"`);
      const { ctx, item } = await resolveItem(op.ref, index);
      const set = op.set ?? {};
      const body = {};
      if (set.state !== undefined) body.state = resolveStateId(ctx, set.state, index);
      if (set.priority !== undefined) body.priority = set.priority;
      if (set.target_date !== undefined) body.target_date = set.target_date;
      if (set.name !== undefined) body.name = set.name;
      if (set.description_html !== undefined) body.description_html = set.description_html;
      if (set.labels !== undefined) body.labels = resolveLabelIds(ctx, set.labels, index);
      if (set.parent !== undefined) {
        const { item: parentItem } = await resolveItem(set.parent, index, "set.parent");
        body.parent = parentItem.id;
      }
      if (set.assignee !== undefined) {
        body.assignees = [await resolveMemberId(set.assignee, index)];
      }
      checkDenylist(index, `update ${op.ref}`, [set.name, set.description_html]);
      plan.push({
        index,
        label: `update ${op.ref}`,
        execute: () =>
          client.patch(`projects/${ctx.project.id}/work-items/${item.id}/`, body, {
            ref: op.ref,
            ...writeOpts,
          }),
      });
      continue;
    }

    if (op.op === "comment") {
      if (!op.ref) fail(index, `comment requires "ref"`);
      const { ctx, item } = await resolveItem(op.ref, index);
      checkDenylist(index, `comment ${op.ref}`, [op.html]);
      plan.push({
        index,
        label: `comment ${op.ref}`,
        execute: () =>
          client.post(
            `projects/${ctx.project.id}/work-items/${item.id}/comments/`,
            { comment_html: op.html },
            { ref: op.ref, ...writeOpts },
          ),
      });
      continue;
    }

    if (op.op === "create") {
      if (!op.project) fail(index, `create requires "project"`);
      if (!op.name) fail(index, `create requires "name"`);
      const ctx = await getProjectCtx(op.project, index);
      const body = { name: op.name };
      if (op.state !== undefined) body.state = resolveStateId(ctx, op.state, index);
      if (op.priority !== undefined) body.priority = op.priority;
      if (op.description_html !== undefined) body.description_html = op.description_html;
      if (op.labels !== undefined) body.labels = resolveLabelIds(ctx, op.labels, index);
      if (op.type !== undefined) {
        const typeId = ctx.types.get(String(op.type).toLowerCase());
        if (!typeId) fail(index, `no work-item type named "${op.type}" in project ${op.project}`);
        body.type_id = typeId;
      }
      if (op.parent !== undefined) {
        const { item: parentItem } = await resolveItem(op.parent, index, "parent");
        body.parent = parentItem.id;
      }
      checkDenylist(index, `create "${op.name}"`, [op.name, op.description_html]);
      plan.push({
        index,
        label: `create "${op.name}"`,
        execute: () =>
          client.post(`projects/${ctx.project.id}/work-items/`, body, {
            ref: op.name,
            ...writeOpts,
          }),
      });
      continue;
    }

    if (op.op === "relation") {
      if (!op.ref) fail(index, `relation requires "ref"`);
      if (!op.to) fail(index, `relation requires "to"`);
      if (!op.type) fail(index, `relation requires "type"`);
      const relationType = normalizeRelationType(op.type, index);
      const { ctx, item } = await resolveItem(op.ref, index);
      const { item: toItem } = await resolveItem(op.to, index, "to");
      // Landmine 15: built-in dependencies take `{relation_type, issues}`;
      // a custom definition (e.g. "duplicate") needs its definition id +
      // outward/inward label, which no resolver in plane-client.mjs exposes
      // (no relation-definitions endpoint is wired there) — validate the
      // response status, not the body shape, per the same landmine's note.
      const body = { relation_type: relationType, issues: [toItem.id] };
      plan.push({
        index,
        label: `relation ${op.ref} -> ${op.to} (${relationType})`,
        execute: () =>
          client.post(`projects/${ctx.project.id}/work-items/${item.id}/relations/`, body, {
            ref: op.ref,
            ...writeOpts,
          }),
      });
      continue;
    }

    if (op.op === "archive") {
      if (!op.ref) fail(index, `archive requires "ref"`);
      const { ctx, item } = await resolveItem(op.ref, index);
      const group = ctx.idToGroup.get(item.state);
      if (group !== "completed" && group !== "cancelled") {
        // Finding B (Opus #6): never print the raw Plane state id — resolve
        // its NAME from the project's own states (works even when the group
        // itself came back missing), or the literal "<unknown state>" marker
        // when the id isn't in the project's state list at all.
        const stateName = ctx.idToName.get(item.state) ?? "<unknown state>";
        fail(
          index,
          `archive ${op.ref}: current state is "${stateName}" (group "${group ?? "unknown"}") — must be completed or cancelled`,
        );
      }
      plan.push({
        index,
        label: `archive ${op.ref}`,
        execute: () =>
          client.post(
            `projects/${ctx.project.id}/work-items/${item.id}/archive/`,
            {},
            { ref: op.ref, ...writeOpts },
          ),
      });
      continue;
    }

    if (op.op === "link") {
      if (!op.ref) fail(index, `link requires "ref"`);
      if (!op.url) fail(index, `link requires "url"`);
      const { ctx, item } = await resolveItem(op.ref, index);
      checkDenylist(index, `link ${op.ref}`, [op.url]);
      plan.push({
        index,
        label: `link ${op.ref}`,
        execute: () =>
          client.post(
            `projects/${ctx.project.id}/work-items/${item.id}/links/`,
            { url: op.url },
            { ref: op.ref, ...writeOpts },
          ),
      });
      continue;
    }

    fail(index, `unknown op "${op.op}"`);
  }

  return plan;
}

// ── the apply run ────────────────────────────────────────────────────────
export async function runApply({
  opsPath,
  dryRun = false,
  maxWrites = DEFAULT_MAX_WRITES,
  overBudget = null,
  apiKey,
  // spec 2026-09-12-plane-learning R1: default from the `applyManualBudgetPerDay`
  // knob when the caller (main()) doesn't pass one explicitly — kept as an
  // explicit parameter (not read here via knob()) so runApply stays usable
  // standalone with the same fallback plane-apply always had.
  manualBudgetLimit = 20,
} = {}) {
  let raw;
  try {
    raw = readFileSync(opsPath, "utf8");
  } catch (err) {
    process.stderr.write(`plane-apply: cannot read ops file "${opsPath}": ${err.message}\n`);
    return { exitCode: 1, applied: 0, deferred: 0, clientSummary: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`plane-apply: invalid JSON in "${opsPath}": ${err.message}\n`);
    return { exitCode: 1, applied: 0, deferred: 0, clientSummary: null };
  }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops : null;
  if (!ops) {
    process.stderr.write(`plane-apply: ops file must be {"ops":[...]}\n`);
    return { exitCode: 1, applied: 0, deferred: 0, clientSummary: null };
  }

  const client = createClient({ apiKey, tool: "plane-apply", maxWrites });

  // Validation first, then writes (the hard line): every ref/name/state/
  // label/type/member resolves, and the denylist scan runs, before this run
  // is even allowed to be gated by the manual write budget below — a
  // validation failure (e.g. T9b's archive precondition) must surface as
  // exit 1 regardless of whether the ledger would separately have refused
  // this run's writes.
  let plan;
  try {
    plan = await buildPlan(client, ops, overBudget);
  } catch (err) {
    const idx = typeof err.opIndex === "number" ? err.opIndex + 1 : null;
    process.stderr.write(`${idx != null ? `#${idx} ` : ""}${err.message}\n`);
    return { exitCode: 1, applied: 0, deferred: 0, clientSummary: client.summary() };
  }

  if (dryRun) {
    for (const p of plan) console.log(`#${p.index + 1} ${p.label}`);
    console.log(`Plane apply: dry-run — ${plan.length} op(s) would write, 0 written`);
    return { exitCode: 0, applied: 0, deferred: 0, clientSummary: client.summary() };
  }

  // Manual write-budget refusal (R3) — historical ledger across every tool
  // other than plane-sync. Checked after validation succeeds but before the
  // first write: zero writes have happened yet, so refusing here still
  // leaves the run at zero writes.
  if (!overBudget) {
    const alreadyToday = writesToday({ exclude: ["plane-sync"] });
    if (alreadyToday + plan.length > manualBudgetLimit) {
      process.stderr.write(
        `plane-apply: refusing — manual writes today (${alreadyToday}) + this run (${plan.length}) ` +
          `would exceed the ${manualBudgetLimit}/day budget; pass --over-budget "<reason>" to proceed\n`,
      );
      return { exitCode: 3, applied: 0, deferred: 0, clientSummary: client.summary() };
    }
  }

  let applied = 0;
  let deferred = 0;
  for (const p of plan) {
    // Finding A (Opus #2): once the client's own `--max-writes` budget is
    // hit once, every remaining op would ALSO defer (the client's own
    // counter never resets mid-run) — so stop attempting them at all and
    // just count each one, per the ruling's "no further ops attempted".
    if (deferred > 0) {
      deferred++;
      console.log(`#${p.index + 1} ${p.label} → deferred (max-writes)`);
      continue;
    }
    try {
      const result = await p.execute();
      if (result?.deferred) {
        deferred++;
        console.log(`#${p.index + 1} ${p.label} → deferred (max-writes)`);
        continue;
      }
      if (result?.forbidden) {
        // Belt-and-braces: checkDenylist already screens every outbound
        // string during validation, so the shared client's own scan should
        // never fire here — but never silently treat it as success if it does.
        process.stderr.write(`#${p.index + 1} ${p.label} forbidden (${result.forbidden.name})\n`);
        return { exitCode: 1, applied, deferred, clientSummary: client.summary() };
      }
      applied++;
      console.log(`#${p.index + 1} ${p.label} → ok`);
    } catch (err) {
      process.stderr.write(`#${p.index + 1} ${p.label} → failed: ${err?.message ?? err}\n`);
      process.stderr.write(`plane-apply: stopped after ${applied} of ${plan.length} writes\n`);
      return { exitCode: 1, applied, deferred, clientSummary: client.summary() };
    }
  }
  if (deferred > 0) {
    console.log(`Plane apply: applied=${applied} deferred=${deferred}`);
    return { exitCode: 4, applied, deferred, clientSummary: client.summary() };
  }
  console.log(`Plane apply: ${applied} write(s) applied`);
  return { exitCode: 0, applied, deferred, clientSummary: client.summary() };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE =
  'Usage: plane-apply.mjs <ops.json> [--dry-run] [--max-writes <n>] [--over-budget "<reason>"] [--help]';

async function main() {
  const argv = process.argv.slice(2);

  // R13/T15: --help/-h and an unknown flag are handled before the ops file is
  // read, before PLANE_API_KEY is read, before any network call.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }

  let dryRun = false;
  let maxWrites = DEFAULT_MAX_WRITES;
  let overBudget = null;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (tok === "--max-writes") {
      const raw = Number(argv[++i]);
      if (Number.isFinite(raw) && raw >= 0) maxWrites = raw;
      else process.stderr.write(`plane-apply: ignoring --max-writes (not a non-negative number)\n`);
      continue;
    }
    if (tok === "--over-budget") {
      overBudget = argv[++i] ?? "";
      continue;
    }
    if (tok.startsWith("--")) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    positionals.push(tok);
  }
  if (positionals.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const opsPath = positionals[0];

  // R2 telemetry (spec 2026-09-12-plane-learning): started/rec set up BEFORE
  // loadKnobs() so a `knobs invalid: <name>` throw still gets exactly one
  // runs.jsonl line via the finally below — --help/usage exits above are the
  // only ones that write none.
  const started = Date.now();
  const rec = { tool: "plane-apply", flags: argv, branch: currentBranch() };
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
    // read (including PLANE_API_KEY below) or network request (T1). Printed
    // explicitly so the exact "knobs invalid: <name>" text always reaches
    // stderr.
    let manualBudgetLimit;
    try {
      loadKnobs();
      manualBudgetLimit = knob("applyManualBudgetPerDay");
    } catch (err) {
      // See plane-sync.mjs's identical note: T1's contract is an out-of-range
      // VALUE in an otherwise present file — that hard-fails. A missing/
      // unreadable file falls back to the knob's documented default.
      if (/^knobs invalid:/.test(String(err?.message ?? ""))) {
        process.stderr.write(`plane-apply: ${err.message}\n`);
        process.exitCode = 1;
        rec.error = `${err?.name ?? "Error"}: ${String(err.message).slice(0, 200)}`;
        return;
      }
      console.error(`plane-apply: knobs unavailable (${err?.message ?? err}) — using defaults`);
      manualBudgetLimit = 20;
    }

    // R8: unlike every other plane-*.mjs script, a missing key is NOT a silent
    // skip — this script's whole purpose is to write.
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) {
      process.stderr.write("plane-apply: missing PLANE_API_KEY (refusing to run without a key)\n");
      process.exitCode = 2;
      return;
    }

    // NEVER process.exit() here — see plane-sync.mjs's identical note (a forced
    // exit can race fetch/undici's keep-alive socket teardown on Windows).
    const result = await runApply({
      opsPath,
      dryRun,
      maxWrites,
      overBudget,
      apiKey,
      manualBudgetLimit,
    });
    process.exitCode = result.exitCode;
    rec.apply = { applied: result.applied ?? 0, deferred: result.deferred ?? 0 };
    if (result.clientSummary) rec.clientSummary = result.clientSummary;
  } catch (err) {
    rec.error = `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
  } finally {
    // R2's `forbidden` field is `{count, byPattern}` — apply's own denylist
    // scan (checkDenylist, in buildPlan) fails the WHOLE run as a validation
    // error before any write, so a hit there surfaces via `rec.error`
    // ("... forbidden (<pattern>)") rather than incrementing this count; a
    // client-level forbidden here is the belt-and-braces guard in the write
    // loop, which should never fire given validation already screened every
    // outbound string.
    const { clientSummary, ...restRec } = rec;
    const summary = clientSummary ?? zeroClientSummary();
    const { forbidden: forbiddenCount, ...restSummary } = summary;
    appendRun({
      ...restRec,
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
