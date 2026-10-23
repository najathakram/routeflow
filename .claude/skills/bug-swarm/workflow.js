export const meta = {
  name: "bug-swarm",
  description:
    "Fix a batch of LOW RouteFlow bugs: one Triage+Pack agent, cluster by shared files, then per cluster build test-first in a worktree, gate, and review. Returns the report; the orchestrator pushes and opens PRs.",
  phases: [
    {
      title: "Triage+Pack",
      detail:
        "One sonnet agent resolves ids, verifies liveness, writes manifest.json and a pack per bug.",
    },
    {
      title: "Cluster",
      detail: "One haiku agent runs scripts/cluster.mjs --write and returns its JSON.",
    },
    {
      title: "Build",
      detail: "Per cluster, sonnet builds red-first in its own worktree; one commit per bug.",
    },
    {
      title: "Gate",
      detail: "Per cluster, haiku runs scripts/gate.mjs --json; one build fix round if red.",
    },
    {
      title: "Review",
      detail: "Per cluster, opus reviews the diff; one fix round plus re-check if FAIL.",
    },
    { title: "Report", detail: "Return clusters, verdicts, parked reasons and excluded bugs." },
  ],
};

// Why: runs 2026-10-23-bug-swarm-1 and -2 spent 62-70% of cost in the orchestrator, and the hand-typed
// gate broke twice. Every IO step is now an agent with its own context; scripts do the deterministic work.
// Fail closed: a dead agent, a stale gate file or a thrown stage parks the cluster and is reported.

const RUN = args.run;
const R = args.repo;
const RUN_DIR = args.runDir;
const REQUESTED = Array.isArray(args.rows) ? args.rows.map(String) : [];
const SCRIPTS = args.scriptsDir || `${R}/.claude/skills/bug-swarm/scripts`;
const AVOID = Array.isArray(args.avoidFiles) ? args.avoidFiles : [];
const MAX = args.maxClusters ?? 4;
const SPACE = args.idSpace;
const REGISTER =
  args.registerPath || "$HOME/.routeflow/ops/routeflow-specs/register/WORK-REGISTER.md";
const avoidFlags = AVOID.map((f) => ` --avoid "${f}"`).join("");

const RULES = `Hard rules: never push, merge, stash, amend, rebase, flip repo visibility, run railway or touch a live tenant. Use the Edit tool for file edits (never sed -i). Chain shell steps with && and quote every path (paths like (dashboard) break unquoted). Read-only git is fine; all writes stay inside your own worktree. Do not run captures (screenshots); the orchestrator decides those.`;
const AVOID_RULE = AVOID.length
  ? `Other lanes have these files open; do NOT edit them (stop and report if a fix needs one): ${AVOID.join(", ")}.`
  : "";

const BUG_SCHEMA = {
  type: "object",
  properties: {
    row: { type: "string" },
    sub: { type: "string" },
    resolvedTitle: { type: "string", minLength: 1 },
    packWritten: { type: "boolean" },
    risk: { type: "string", enum: ["LOW", "HIGH"] },
    riskReason: { type: "string" },
    status: { type: "string", enum: ["live", "fixed-on-master", "unclear"] },
    files: { type: "array", items: { type: "string" } },
    needsDb: { type: "boolean" },
    ui: { type: "boolean" },
    repro: { type: "string" },
  },
  required: ["row", "resolvedTitle", "packWritten", "risk", "status", "files", "needsDb", "ui"],
};
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    run: { type: "string" },
    bugs: { type: "array", items: BUG_SCHEMA },
    unresolved: { type: "array", items: { type: "string" } },
  },
  required: ["run", "bugs"],
};
const ROWREF = {
  type: "object",
  properties: { row: { type: "string" }, sub: { type: "string" } },
  required: ["row"],
};
const CLUSTER_SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          bugs: { type: "array", items: ROWREF },
          files: { type: "array", items: { type: "string" } },
          workspaces: { type: "array", items: { type: "string" } },
          needsDb: { type: "boolean" },
          ui: { type: "boolean" },
          extractionFirst: { type: "boolean" },
        },
        required: ["id", "bugs", "files"],
      },
    },
    excluded: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row: { type: "string" },
          sub: { type: "string" },
          reason: { type: "string" },
        },
        required: ["row", "reason"],
      },
    },
    // Canonical parked shape, exactly what cluster.mjs prints: { cluster: { id, bugs, files... }, reason }.
    parked: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cluster: {
            type: "object",
            properties: { id: { type: "string" }, bugs: { type: "array", items: ROWREF } },
            required: ["id", "bugs"],
          },
          reason: { type: "string" },
        },
        required: ["cluster", "reason"],
      },
    },
    unaccounted: { type: "array", items: { type: "string" } },
    unresolved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row: { type: "string" },
          sub: { type: "string" },
          reason: { type: "string" },
        },
        required: ["row", "reason"],
      },
    },
    overCap: { type: "boolean" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          row: { type: "string" },
          sub: { type: "string" },
          risk: { type: "string" },
          status: { type: "string" },
        },
        required: ["row", "risk", "status"],
      },
    },
  },
  required: ["clusters", "excluded"],
};
const BUILD_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "worktree-failed"] },
    message: { type: "string" },
    commits: { type: "array", items: { type: "string" } },
    redValues: { type: "array", items: { type: "string" } },
    specEdits: { type: "array", items: { type: "string" } },
    lesson: { type: "string" },
    worktree: { type: "string" },
    head: { type: "string" },
  },
  required: ["status", "commits", "redValues", "specEdits", "lesson", "worktree", "head"],
};
const GATE_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    running: { type: "boolean" },
    head: { type: "string" },
    base: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, ok: { type: "boolean" }, tail: { type: "string" } },
        required: ["name", "ok"],
      },
    },
  },
  required: ["ok", "head", "steps"],
};
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    musts: { type: "array", items: { type: "string" } },
    nits: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "musts", "nits"],
};

// The label a commit/test carries for an id: exactly as given in the declared id space.
const labelOf = (row) => (SPACE === "row" && !/^W-/.test(row) ? `row ${row}` : row);
const labelRule = (c) =>
  `Label commits and test names with the id exactly as given in the "${SPACE}" id space (row ids as \`row 599\` / \`W-679\`; bug ids as \`B668\`), never translate a row id to B###. This cluster's labels: ${[...new Set(c.bugs.map((b) => labelOf(String(b.row))))].join(", ")}.`;
const rowsOf = (c) => c.bugs.map((b) => (b.sub ? `${b.row}${b.sub}` : b.row));
const redTails = (g) =>
  g.steps
    .filter((s) => !s.ok)
    .map((s) => `--- ${s.name} ---\n${s.tail || ""}`)
    .join("\n") || (g.running ? "gate file still marked running" : "stale or missing gate result");
// A gate that never finished (still running, no file, no head) is not a code failure.
const gateIncomplete = (g) => !g || g.running === true || !g.head;
const incompleteWhy = (g) => (g.gate ? "gate incomplete" : "gate agent died");
// Run the gate; if it did not finish, re-run it once (no fix round consumed).
// Returns { gate, state: "green" | "red" | "incomplete", round } where round is the next free round number.
const settleGate = async (c, wt, head, round) => {
  let gate = await runGate(c, wt, `gate:${c.id}`, round);
  round += 1;
  if (gateIncomplete(gate)) {
    gate = await runGate(c, wt, `gate:${c.id}`, round);
    round += 1;
  }
  if (gateIncomplete(gate)) return { gate, state: "incomplete", round };
  return { gate, state: gateGreen(gate, head) ? "green" : "red", round };
};
// Green only when the gate ran on the commit the builder reported and says it finished ok.
const gateGreen = (g, head) => !!g && g.ok === true && !g.running && !!head && g.head === head;

// Why unaccounted ids are unaccounted, and the titles the ids resolved to (run 3 fixed the wrong bug
// because Triage resolved W- ids in the wrong id space).
const WHY = new Map();
const TITLES = new Map();
const idsReport = (unaccounted) =>
  REQUESTED.map((id) => {
    const title = TITLES.get(id) || null;
    if (unaccounted.includes(id)) {
      return { id, resolvedTitle: title, unaccounted: true, reason: WHY.get(id) || "in no bucket" };
    }
    return { id, resolvedTitle: title, unaccounted: false };
  });

const report = (extra) => {
  phase("Report");
  const r = {
    run: RUN,
    clusters: [],
    excluded: [],
    parked: [],
    unaccounted: [],
    overCap: false,
    ...extra,
  };
  if (r.error) {
    // An error means nothing was done: every requested id is unaccounted, with the error as the reason.
    r.unaccounted = [...new Set([...r.unaccounted.map(String), ...REQUESTED])];
    for (const id of REQUESTED) if (!WHY.has(id)) WHY.set(id, r.error);
  }
  r.ids = idsReport(r.unaccounted);
  for (const i of r.ids)
    log(`${i.id}: ${i.unaccounted ? `UNACCOUNTED (${i.reason})` : i.resolvedTitle}`);
  log(`excluded: ${r.excluded.length}`);
  log(`parked: ${r.parked.length}`);
  log(`unaccounted: ${r.unaccounted.length}${r.error ? ` (${r.error})` : ""}`);
  log(`overCap: ${r.overCap}`);
  return r;
};

if (SPACE !== "row" && SPACE !== "bug") {
  return report({ error: 'args.idSpace is required and must be "row" or "bug" (no default)' });
}
const SHAPE = SPACE === "row" ? /^(W-\d+|\d+)$/ : /^B\d{1,4}$/;
const badShapes = REQUESTED.filter((id) => !SHAPE.test(id));
if (badShapes.length) {
  return report({
    error: `id shape does not match idSpace "${SPACE}" (row: W-<n> or <n>; bug: B<n>): ${badShapes.join(", ")}`,
  });
}
if (REQUESTED.length > 10) {
  return report({
    error: "at most 10 ids per batch: split the batch (the orchestrator does that)",
  });
}
if (!RUN || !R || !RUN_DIR || !args.fromWorktree || REQUESTED.length === 0) {
  return report({
    error:
      "args.run, args.repo, args.runDir, args.fromWorktree and a non-empty args.rows are required",
  });
}

// ---- Triage+Pack (one agent per batch, before clustering) ----
phase("Triage+Pack");
const manifest = await agent(
  `Triage these ids for run ${RUN}: ${REQUESTED.join(", ")}. The id space is "${SPACE}" and ONLY that space: ${
    SPACE === "row"
      ? `an id is a WORK-REGISTER row (including W- ids). Resolve each with: cd "${args.fromWorktree}" && node tools/ops-monitor/bin/rf.mjs item show <id>, and confirm with grep -n '| <id> |' "${REGISTER}". NEVER use bugs.mjs and never read a number as a B### catalogue id.`
      : `an id is a B### bug catalogue id. Resolve each with: cd "${R}" && node scripts/campaign/bugs.mjs show <id>.`
  }
Report the resolved title of every id in resolvedTitle. An id that does not resolve in the "${SPACE}" space goes in the "unresolved" list (not in bugs): it is never HIGH and never built; do not try the other space.
Repo: ${R}. For each resolved id decide: risk LOW or HIGH (HIGH = money, ledger, units, locks, tenancy, migrations, billing, auth, or a repro needing a live-tenant reading), the reason, status (live | fixed-on-master | unclear: check the code on origin/master), files (use .claude/code-map/INDEX.md and scripts/graph.mjs radius), needsDb (prisma, a *.db.spec, or a transaction path), ui (yes/no) and a one-line repro. Split an id into sub-bugs (sub: "a", "b") when it holds several defects.
Also write a context pack per resolved row to ${RUN_DIR}/pack-<row>.md (at most 3 KB each; line 1 = the sha of origin/master): the liveness evidence as file:line, exported signatures (not bodies) of the row's files, the graph radius condensed to file names, the relevant lesson ids from .claude/lessons/LESSONS-DIGEST.md with one line each. Set packWritten true on a bug only after checking its pack file exists.
Write the result as JSON to ${RUN_DIR}/manifest.json (shape {"run": "${RUN}", "bugs": [...], "unresolved": [...]}) and return the same object. Read-only apart from the manifest and the packs. ${RULES}`,
  {
    label: "triagepack",
    phase: "Triage+Pack",
    schema: MANIFEST_SCHEMA,
    model: "sonnet",
    effort: "low",
  },
);
if (!manifest) {
  for (const id of REQUESTED) WHY.set(id, "triage+pack agent died");
  return report({ error: "triage+pack agent died", unaccounted: REQUESTED });
}

// ---- Cluster ----
phase("Cluster");
const clustered = await agent(
  `Run exactly: cd "${R}" && node "${SCRIPTS}/cluster.mjs" "${RUN_DIR}/manifest.json" --write --max ${MAX} --rows "${REQUESTED.join(",")}" --packs --id-space ${SPACE} --repo "${R}"${avoidFlags}
Return its printed JSON verbatim (clusters, excluded, parked, unaccounted, overCap), and add "bugs": [] (the workflow reads risk and status from Triage, not from you). Do not edit anything else, do not reinterpret. ${RULES}`,
  { label: "cluster", phase: "Cluster", schema: CLUSTER_SCHEMA, model: "haiku", effort: "low" },
);
if (!clustered) {
  for (const id of REQUESTED) WHY.set(id, "cluster agent died");
  return report({ error: "cluster agent died", unaccounted: REQUESTED });
}

// HIGH or not-live bugs never reach Build, whatever the script returned.
const key = (b) => `${b.row}|${b.sub || ""}`;
const meta2 = new Map(manifest.bugs.map((b) => [key(b), b]));
const unresolved = new Set((manifest.unresolved || []).map(String));
for (const b of manifest.bugs)
  if (!TITLES.has(String(b.row))) TITLES.set(String(b.row), b.resolvedTitle);
// Not found in the declared id space: an unresolved id, or a bug whose resolvedTitle is empty. These are
// unaccounted ("not found in <space>"), never excluded, never built, and never mislabelled by risk/status.
const notFound = new Set(unresolved);
// cluster.mjs resolves every id in code (rf.mjs / bugs.mjs); what it rejects is not found either.
const codeWhy = new Map();
for (const u of clustered.unresolved || []) {
  notFound.add(String(u.row));
  codeWhy.set(String(u.row), u.reason);
}
for (const b of manifest.bugs) {
  if (typeof b.resolvedTitle !== "string" || b.resolvedTitle.trim() === "")
    notFound.add(String(b.row));
}
const excluded = clustered.excluded.filter((e) => !notFound.has(String(e.row)));
const clusters = [];
for (const c of clustered.clusters) {
  const keep = c.bugs.filter((b) => {
    const m = meta2.get(key(b));
    if (notFound.has(String(b.row))) {
      log(`dropped ${key(b)} from ${c.id}: not found in ${SPACE}`);
      return false;
    }
    const ok = m && m.packWritten === true && m.risk === "LOW" && m.status === "live";
    if (!ok) {
      const reason = !m
        ? "not in manifest"
        : m.packWritten !== true
          ? "no context pack"
          : `risk ${m.risk}, status ${m.status}`;
      excluded.push({ row: b.row, sub: b.sub, reason: `dropped before Build: ${reason}` });
      log(`dropped ${key(b)} from ${c.id}: ${reason}`);
    }
    return ok;
  });
  if (keep.length) clusters.push({ ...c, bugs: keep });
}
log(`clusters: ${clusters.length}, excluded: ${excluded.length}`);

// Every requested row and every manifest bug must sit in a bucket: clusters, excluded, parked, unaccounted.
const seenKeys = new Set();
const seenRows = new Set();
const note = (row, sub) => {
  if (row === undefined || row === null) return;
  seenRows.add(String(row));
  seenKeys.add(`${row}|${sub || "*"}`);
};
const noteLabel = (label) => {
  const m = /^(.*?)([a-z])?$/.exec(String(label));
  note(m[1], m[2]);
  seenRows.add(String(label));
};
for (const c of clustered.clusters) for (const b of c.bugs) note(b.row, b.sub);
for (const e of excluded) note(e.row, e.sub);
for (const p of clustered.parked || []) {
  for (const b of (p.cluster && p.cluster.bugs) || []) note(b.row, b.sub); // canonical shape only
}
for (const u of clustered.unaccounted || []) noteLabel(u);
const bucketed = (row, sub) => seenKeys.has(`${row}|${sub || "*"}`) || seenKeys.has(`${row}|*`);
const unaccounted = [...(clustered.unaccounted || []).map(String)];
const addMissing = (label, why = "in no bucket") => {
  if (!WHY.has(label)) WHY.set(label, why);
  if (!unaccounted.includes(label)) {
    unaccounted.push(label);
    log(`unaccounted (${why}): ${label}`);
  }
};
for (const u of notFound) {
  const why = codeWhy.get(u) || `not found in ${SPACE}`;
  WHY.set(u, why);
  addMissing(u, why);
}
for (const r of REQUESTED) if (!seenRows.has(r)) addMissing(r);
for (const b of manifest.bugs) {
  if (!bucketed(b.row, b.sub)) addMissing(b.sub ? `${b.row}${b.sub}` : String(b.row));
}

// ---- Per-cluster pipeline: Build -> Gate (+fix) -> Review (+fix) ----
const buildBrief = (
  c,
  t,
  pack,
) => `You fix LOW-risk bugs ${rowsOf(c).join(", ")} in RouteFlow, test-first. Cluster ${c.id}, run ${RUN}.
Read the context pack(s) first: ${pack}. Files in scope: ${c.files.join(", ")}.${c.extractionFirst ? " A file here is at its size-ratchet ceiling: extract first (own commit), then fix." : ""}
LOW only: if a fix needs a HIGH path (money, ledger, units, locks, tenancy, migration, billing, auth) stop and report it in the lesson field; do not fix it.
${AVOID_RULE}
Worktree: ${t.exists ? `already at ${t.dir} (branch ${t.name}); work there, do not recreate it.` : `create it first: cd "${R}" && node "${SCRIPTS}/worktree.mjs" --dir "${t.dir}" --branch "${t.name}" --from "${args.fromWorktree}". If worktree.mjs exits non-zero, STOP and return status "worktree-failed" with its message in "message" (other fields empty); never reuse or delete an existing tree or branch.`}
For each bug in order: (1) write a test that fails on the bug's own wrong value and run it; record the failing assertion text (the wrong value) in redValues; (2) make the minimal fix; (3) one commit "fix(<area>): <what> (<label>)". ${labelRule(c)} Editing an existing assertion needs a line "SPEC-EDIT: <file:line> <why>" in specEdits. Put trailers on the LAST commit: "Bookkeeping-Follow-Up: pending" and "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>".
${RULES}
Return {status "ok", commits (full shas of the commits made in THIS round; empty if you changed nothing), redValues, specEdits, lesson (one candidate or "none"), worktree (absolute path), head (git rev-parse HEAD after your last commit)}.`;

const runGate = (c, wt, label, round) =>
  agent(
    `First stop any earlier gate of this cluster by running: node "${SCRIPTS}/gate.mjs" --stop "${RUN_DIR}/gate-${c.id}.pid" (it kills the gate's process tree on any platform only if that pid is a gate.mjs process, then removes the pid file; never kill anything by hand). Then start the gate with Bash run_in_background (it queues behind other clusters and can run for a long time): cd "${wt}" && node "${SCRIPTS}/gate.mjs" --json "${RUN_DIR}/gate-${c.id}-r${round}.json" --pid-file "${RUN_DIR}/gate-${c.id}.pid" --ids "${[...new Set(c.bugs.map((b) => b.row))].join(",")}" --id-space ${SPACE}${c.needsDb ? " --needs-db" : ""}${avoidFlags}
Then wait for it with: node "${SCRIPTS}/gate.mjs" --wait "${RUN_DIR}/gate-${c.id}-r${round}.json" (Bash timeout 600000). It prints the json and exits 0 when the gate finished, or exits 3 if it is still running: call it again, up to 5 times in total, until it exits 0. Never use sleep (it is blocked). Return {ok, running, head, base, steps:[{name, ok, tail}]} exactly as printed (keep the tail only for failed steps). If it still exits 3 after 5 calls, or the file is missing, return what you have (ok false, running true, head empty) and do not retry. Do not fix anything, do not rerun with other flags. ${RULES}`,
    { label, phase: "Gate", schema: GATE_SCHEMA, model: "haiku", effort: "low" },
  );

const review = (c, st, label, recheck) =>
  agent(
    `${recheck ? "Re-check" : "Review"} cluster ${c.id} (bugs ${rowsOf(c).join(", ")}) in ${st.worktree}, branch ${st.branch}, against origin/master (git -C "${st.worktree}" diff "$(git -C "${st.worktree}" merge-base origin/master HEAD)"..HEAD). At most 12 tool calls. Independent read: you did not write this.
Check: each fix is minimal and matches its bug; each test fails on the bug's wrong value (builder reported: ${JSON.stringify(st.redValues)}); the gate result (ok=${st.gate.ok}); LOW only (no money, ledger, units, locks, tenancy, migration, billing, auth path); no unrelated edits. Every SPEC-EDIT is a required question and a MUST unless justified: ${JSON.stringify(st.specEdits)}.${recheck ? ` Previous MUSTs to confirm fixed: ${JSON.stringify(st.musts)}.` : ""}
Return {verdict: PASS or FAIL, musts (blocking), nits (non-blocking)}. Read-only; edit nothing. ${RULES}`,
    { label, phase: "Review", schema: REVIEW_SCHEMA, model: "opus", effort: "medium" },
  );

// A throwing stage becomes a parked marker (never an exception), so the Report always lists the cluster.
const guard = (name, fn) => async (prev, item) => {
  if (prev && prev.parked) return prev;
  try {
    return await fn(prev, item);
  } catch (e) {
    const base = prev && prev.c ? prev : { c: item, branch: `fix/${RUN}-${item.id}` };
    return { ...base, parked: `stage ${name} threw: ${e && e.message ? e.message : e}` };
  }
};

const results = await pipeline(
  clusters,
  // Build
  guard("Build", async (c) => {
    phase("Build");
    const st = {
      c,
      branch: `fix/${RUN}-${c.id}`,
      packs: [...new Set(c.bugs.map((b) => b.row))]
        .map((r) => `${RUN_DIR}/pack-${r}.md`)
        .join(", "),
    };
    const dir = `${R}-wt-${RUN}-${c.id}`;
    const b = await agent(buildBrief(st.c, { name: st.branch, dir, exists: false }, st.packs), {
      label: `build:${st.c.id}`,
      phase: "Build",
      schema: BUILD_SCHEMA,
      model: "sonnet",
      effort: "medium",
    });
    if (!b) return { ...st, parked: "builder died" };
    if (b.status === "worktree-failed") {
      return { ...st, parked: `worktree-failed: ${b.message || "worktree.mjs exited non-zero"}` };
    }
    return { ...st, ...b, worktree: b.worktree || dir };
  }),
  // Gate (+ one build fix round)
  guard("Gate", async (st) => {
    phase("Gate");
    // An empty build (no commit) is red without spending a gate run; it consumes the one fix round.
    const emptyBuild = !st.commits || st.commits.length === 0;
    let g = emptyBuild
      ? {
          state: "red",
          round: 1,
          gate: {
            ok: false,
            steps: [{ name: "build", ok: false, tail: "the build made no commit" }],
          },
        }
      : await settleGate(st.c, st.worktree, st.head, 1);
    if (g.state === "incomplete") {
      return { ...st, gate: g.gate || { ok: false, steps: [] }, parked: incompleteWhy(g) };
    }
    if (g.state === "green") return { ...st, gate: g.gate, round: g.round };
    const gate = g.gate;
    phase("Build");
    const fix = await agent(
      `${buildBrief(st.c, { name: st.branch, dir: st.worktree, exists: true }, st.packs)}\n\nFIX ROUND (the only one): the gate was red. Fix only these failures with new commit(s), then return the same schema. Failed steps:\n${redTails(gate)}`,
      {
        label: `buildfix:${st.c.id}`,
        phase: "Build",
        schema: BUILD_SCHEMA,
        model: "sonnet",
        effort: "medium",
      },
    );
    if (!fix) return { ...st, gate, parked: "build fix agent died" };
    const next = { ...st, ...fix, worktree: st.worktree };
    if (!fix.commits || fix.commits.length === 0) return { ...next, gate, parked: "no change" };
    phase("Gate");
    g = await settleGate(st.c, st.worktree, next.head, g.round);
    if (g.state !== "green") {
      return {
        ...next,
        gate: g.gate || { ok: false, steps: [] },
        parked: g.state === "incomplete" ? incompleteWhy(g) : "gate red after one fix round",
      };
    }
    return { ...next, gate: g.gate, round: g.round };
  }),
  // Review (+ one fix round, gate, re-check)
  guard("Review", async (st) => {
    phase("Review");
    const first = await review(st.c, st, `review:${st.c.id}`, false);
    if (!first) return { ...st, parked: "reviewer died" };
    if (first.verdict === "PASS") return { ...st, verdict: "PASS", musts: first.musts };
    phase("Build");
    const fix = await agent(
      `${buildBrief(st.c, { name: st.branch, dir: st.worktree, exists: true }, st.packs)}\n\nREVIEW FIX ROUND (the only one): an independent reviewer returned FAIL. Resolve exactly these MUSTs with new commit(s) and return the same schema:\n${first.musts.map((m) => `- ${m}`).join("\n")}`,
      {
        label: `reviewfix:${st.c.id}`,
        phase: "Build",
        schema: BUILD_SCHEMA,
        model: "sonnet",
        effort: "medium",
      },
    );
    if (!fix)
      return { ...st, verdict: "FAIL", musts: first.musts, parked: "review fix agent died" };
    const next = { ...st, ...fix, worktree: st.worktree };
    if (!fix.commits || fix.commits.length === 0) {
      return { ...next, verdict: "FAIL", musts: first.musts, parked: "no change" };
    }
    phase("Gate");
    const g = await settleGate(st.c, st.worktree, next.head, st.round || 3);
    const gate = g.gate;
    if (g.state !== "green") {
      return {
        ...next,
        gate: gate || { ok: false, steps: [] },
        verdict: "FAIL",
        musts: first.musts,
        parked: g.state === "incomplete" ? incompleteWhy(g) : "gate red after review fix",
      };
    }
    phase("Review");
    const again = await review(
      st.c,
      { ...next, gate, musts: first.musts },
      `recheck:${st.c.id}`,
      true,
    );
    if (!again)
      return { ...next, gate, verdict: "FAIL", musts: first.musts, parked: "re-check agent died" };
    return {
      ...next,
      gate,
      verdict: again.verdict,
      musts: again.musts,
      parked: again.verdict === "PASS" ? undefined : "review FAIL after one fix round",
    };
  }),
);

// ---- Report ----
const rows = clusters.map((c, i) => {
  const r = results[i];
  if (!r) {
    return {
      id: c.id,
      rows: rowsOf(c),
      branch: `fix/${RUN}-${c.id}`,
      worktree: null,
      gate: null,
      verdict: null,
      musts: [],
      parked: "pipeline stage threw",
    };
  }
  return {
    id: c.id,
    rows: rowsOf(c),
    branch: r.branch,
    worktree: r.worktree || null,
    gate: r.gate ? gateGreen(r.gate, r.head) : null,
    verdict: r.verdict || null,
    musts: r.musts || [],
    parked: r.parked || false,
  };
});
return report({
  clusters: rows,
  excluded,
  parked: [
    ...(clustered.parked || []).map((p) => ({
      cluster: p.cluster,
      reason: p.reason || "over cap",
    })),
    ...rows.filter((r) => r.parked).map((r) => ({ id: r.id, rows: r.rows, reason: r.parked })),
  ],
  unaccounted,
  overCap: !!clustered.overCap,
});
