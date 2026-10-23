export const meta = {
  name: "bug-swarm",
  description:
    "Fix a batch of LOW RouteFlow bugs: triage, cluster by shared files, then per cluster pack, build test-first in a worktree, gate, and review. Returns the report; the orchestrator pushes and opens PRs.",
  phases: [
    {
      title: "Triage",
      detail: "One haiku agent writes manifest.json (risk, files, needsDb, ui, status).",
    },
    {
      title: "Cluster",
      detail: "One haiku agent runs scripts/cluster.mjs --write and returns its JSON.",
    },
    {
      title: "Pack",
      detail: "Per cluster, sonnet writes a context pack (signatures, radius, lesson ids).",
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

const R = args.repo;
const RUN = args.run;
const RUN_DIR = args.runDir;
const SCRIPTS = args.scriptsDir || `${R}/.claude/skills/bug-swarm/scripts`;
const N = String(RUN).split("-").pop();
const AVOID = Array.isArray(args.avoidFiles) ? args.avoidFiles : [];
const MAX = args.maxClusters || 4;

const RULES = `Hard rules: never push, merge, stash, amend, rebase, flip repo visibility, run railway or touch a live tenant. Use the Edit tool for file edits (never sed -i). Chain shell steps with && and quote every path (paths like (dashboard) break unquoted). Read-only git is fine; all writes stay inside your own worktree. Do not run captures (screenshots); the orchestrator decides those.`;
const AVOID_RULE = AVOID.length
  ? `Other lanes have these files open; do NOT edit them (stop and report if a fix needs one): ${AVOID.join(", ")}.`
  : "";

const BUG_SCHEMA = {
  type: "object",
  properties: {
    row: { type: "string" },
    sub: { type: "string" },
    risk: { type: "string", enum: ["LOW", "HIGH"] },
    riskReason: { type: "string" },
    status: { type: "string", enum: ["live", "fixed-on-master", "unclear"] },
    files: { type: "array", items: { type: "string" } },
    needsDb: { type: "boolean" },
    ui: { type: "boolean" },
    repro: { type: "string" },
  },
  required: ["row", "risk", "status", "files", "needsDb", "ui"],
};
const MANIFEST_SCHEMA = {
  type: "object",
  properties: { run: { type: "string" }, bugs: { type: "array", items: BUG_SCHEMA } },
  required: ["run", "bugs"],
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
          bugs: {
            type: "array",
            items: {
              type: "object",
              properties: { row: { type: "string" }, sub: { type: "string" } },
              required: ["row"],
            },
          },
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
    overCap: { type: "boolean" },
  },
  required: ["clusters", "excluded"],
};
const BUILD_SCHEMA = {
  type: "object",
  properties: {
    commits: { type: "array", items: { type: "string" } },
    redValues: { type: "array", items: { type: "string" } },
    specEdits: { type: "array", items: { type: "string" } },
    lesson: { type: "string" },
    worktree: { type: "string" },
  },
  required: ["commits", "redValues", "specEdits", "lesson", "worktree"],
};
const GATE_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, ok: { type: "boolean" }, tail: { type: "string" } },
        required: ["name", "ok"],
      },
    },
  },
  required: ["ok", "steps"],
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

const rowsOf = (c) => c.bugs.map((b) => (b.sub ? `${b.row}${b.sub}` : b.row));
const redTails = (g) =>
  g.steps
    .filter((s) => !s.ok)
    .map((s) => `--- ${s.name} ---\n${s.tail || ""}`)
    .join("\n");

// ---- Triage ----
phase("Triage");
const manifest = await agent(
  `Triage these RouteFlow bug register rows for run ${RUN}: ${args.rows.join(", ")}.
Repo: ${R}. For each row read the register row and its card (node scripts/campaign/bugs.mjs card <id>), then decide:
risk LOW or HIGH (HIGH = money, ledger, units, locks, tenancy, migrations, billing, auth, or a repro needing a live-tenant reading), the reason, status (live | fixed-on-master | unclear: check the code on origin/master), files (use .claude/code-map/INDEX.md and scripts/graph.mjs radius), needsDb (prisma, a *.db.spec, or a transaction path), ui (yes/no) and a one-line repro. Split a row into sub-bugs (sub: "a", "b") when it holds several defects.
Write the result as JSON to ${RUN_DIR}/manifest.json (shape {"run": "${RUN}", "bugs": [...]}) and return the same object. Read-only apart from that file. ${RULES}`,
  { label: "triage", phase: "Triage", schema: MANIFEST_SCHEMA, model: "haiku", effort: "low" },
);

// ---- Cluster ----
phase("Cluster");
const clustered = manifest
  ? await agent(
      `Run exactly: cd "${R}" && node "${SCRIPTS}/cluster.mjs" "${RUN_DIR}/manifest.json" --write
Return its printed JSON verbatim (clusters, excluded, overCap if present). Do not edit anything else, do not reinterpret. If the maximum is ${MAX} clusters and the script reports overCap, still return it as is.`,
      { label: "cluster", phase: "Cluster", schema: CLUSTER_SCHEMA, model: "haiku", effort: "low" },
    )
  : null;
const clusters = clustered ? clustered.clusters : [];
const excluded = clustered ? clustered.excluded : [];
log(`clusters: ${clusters.length}, excluded: ${excluded.length}`);

// ---- Per-cluster pipeline: Pack -> Build -> Gate (+fix) -> Review (+fix) ----
const buildBrief = (
  c,
  branch,
  pack,
) => `You fix LOW-risk bugs ${rowsOf(c).join(", ")} in RouteFlow, test-first. Cluster ${c.id}, run ${RUN}.
Read the context pack first: ${pack}. Files in scope: ${c.files.join(", ")}.${c.extractionFirst ? " A file here is at its size-ratchet ceiling: extract first (own commit), then fix." : ""}
LOW only: if a fix needs a HIGH path (money, ledger, units, locks, tenancy, migration, billing, auth) stop and report it in the lesson field; do not fix it.
${AVOID_RULE}
Worktree: ${branch.exists ? `already at ${branch.dir} (branch ${branch.name}); work there, do not recreate it.` : `create it first: cd "${R}" && node "${SCRIPTS}/worktree.mjs" --dir "${branch.dir}" --branch "${branch.name}" --from "${args.fromWorktree}"`}
For each bug in order: (1) write a test that fails on the bug's own wrong value and run it; record the failing assertion text (the wrong value) in redValues; (2) make the minimal fix; (3) one commit "fix(<area>): <what> (B<id>)". Editing an existing assertion needs a line "SPEC-EDIT: <file:line> <why>" in specEdits. Put trailers on the LAST commit: "Bookkeeping-Follow-Up: pending" and "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>".
${RULES}
Return {commits (full shas), redValues, specEdits, lesson (one candidate or "none"), worktree (absolute path)}.`;

const runGate = (c, wt, label) =>
  agent(
    `Run in the worktree and return the result: cd "${wt}" && node "${SCRIPTS}/gate.mjs" --json "${RUN_DIR}/gate-${c.id}.json"${c.needsDb ? " --needs-db" : ""}
Then read ${RUN_DIR}/gate-${c.id}.json and return {ok, steps:[{name, ok, tail}]} exactly as recorded (keep the tail only for failed steps). Do not fix anything, do not rerun with other flags. ${RULES}`,
    { label, phase: "Gate", schema: GATE_SCHEMA, model: "haiku", effort: "low" },
  );

const review = (c, st, label, recheck) =>
  agent(
    `${recheck ? "Re-check" : "Review"} cluster ${c.id} (bugs ${rowsOf(c).join(", ")}) in ${st.worktree}, branch ${st.branch}, against origin/master (git -C "${st.worktree}" diff "$(git -C "${st.worktree}" merge-base origin/master HEAD)"..HEAD). At most 12 tool calls. Independent read: you did not write this.
Check: each fix is minimal and matches its bug; each test fails on the bug's wrong value (builder reported: ${JSON.stringify(st.redValues)}); the gate result (ok=${st.gate.ok}); LOW only (no money, ledger, units, locks, tenancy, migration, billing, auth path); no unrelated edits. Every SPEC-EDIT is a required question and a MUST unless justified: ${JSON.stringify(st.specEdits)}.${recheck ? ` Previous MUSTs to confirm fixed: ${JSON.stringify(st.musts)}.` : ""}
Return {verdict: PASS or FAIL, musts (blocking), nits (non-blocking)}. Read-only; edit nothing. ${RULES}`,
    { label, phase: "Review", schema: REVIEW_SCHEMA, model: "opus", effort: "medium" },
  );

const results = await pipeline(
  clusters,
  // Pack
  async (c) => {
    phase("Pack");
    const packPath = `${RUN_DIR}/pack-${c.id}.md`;
    await agent(
      `Write a context pack for cluster ${c.id} (bugs ${rowsOf(c).join(", ")}) to ${packPath}, at most 6 KB, pinned to the sha of origin/master (put it on line 1). Contents: exported signatures (not bodies) of ${c.files.join(", ")}; the graph radius (node scripts/graph.mjs radius <file>) condensed to file names; the relevant lesson ids from .claude/lessons/LESSONS-DIGEST.md with one line each; the code-map area file path. Repo: ${R}. Read-only apart from the pack. ${RULES}`,
      { label: `pack:${c.id}`, phase: "Pack", model: "sonnet", effort: "low" },
    );
    return { c, packPath };
  },
  // Build
  async ({ c, packPath }) => {
    phase("Build");
    const name = `fix/swarm-${N}-${c.id}`;
    const dir = `${R}-wt-swarm${N}-${c.id}`;
    const b = await agent(buildBrief(c, { name, dir, exists: false }, packPath), {
      label: `build:${c.id}`,
      phase: "Build",
      schema: BUILD_SCHEMA,
      model: "sonnet",
      effort: "medium",
    });
    if (!b) return { c, packPath, branch: name, parked: "builder died" };
    return { c, packPath, branch: name, dir, worktree: b.worktree || dir, ...b };
  },
  // Gate (+ one build fix round)
  async (st) => {
    if (st.parked) return st;
    phase("Gate");
    let gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`);
    if (!gate) return { ...st, parked: "gate agent died" };
    if (!gate.ok) {
      phase("Build");
      const fix = await agent(
        `${buildBrief(st.c, { name: st.branch, dir: st.worktree, exists: true }, st.packPath)}\n\nFIX ROUND (the only one): the gate was red. Fix only these failures with new commit(s), then return the same schema. Failed steps:\n${redTails(gate)}`,
        {
          label: `buildfix:${st.c.id}`,
          phase: "Build",
          schema: BUILD_SCHEMA,
          model: "sonnet",
          effort: "medium",
        },
      );
      if (!fix) return { ...st, gate, parked: "build fix agent died" };
      phase("Gate");
      gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`);
      if (!gate || !gate.ok) {
        return {
          ...st,
          ...fix,
          worktree: st.worktree,
          gate: gate || { ok: false, steps: [] },
          parked: "gate red after one fix round",
        };
      }
      return { ...st, ...fix, worktree: st.worktree, gate };
    }
    return { ...st, gate };
  },
  // Review (+ one fix round, gate, re-check)
  async (st) => {
    if (st.parked) return st;
    phase("Review");
    const first = await review(st.c, st, `review:${st.c.id}`, false);
    if (!first) return { ...st, parked: "reviewer died" };
    if (first.verdict === "PASS") return { ...st, verdict: "PASS", musts: first.musts };
    phase("Build");
    const fix = await agent(
      `${buildBrief(st.c, { name: st.branch, dir: st.worktree, exists: true }, st.packPath)}\n\nREVIEW FIX ROUND (the only one): an independent reviewer returned FAIL. Resolve exactly these MUSTs with new commit(s) and return the same schema:\n${first.musts.map((m) => `- ${m}`).join("\n")}`,
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
    phase("Gate");
    const gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`);
    if (!gate || !gate.ok) {
      return {
        ...st,
        ...fix,
        worktree: st.worktree,
        gate: gate || { ok: false, steps: [] },
        verdict: "FAIL",
        musts: first.musts,
        parked: "gate red after review fix",
      };
    }
    phase("Review");
    const again = await review(
      st.c,
      { ...st, ...fix, worktree: st.worktree, gate, musts: first.musts },
      `recheck:${st.c.id}`,
      true,
    );
    if (!again)
      return {
        ...st,
        ...fix,
        worktree: st.worktree,
        gate,
        verdict: "FAIL",
        musts: first.musts,
        parked: "re-check agent died",
      };
    return {
      ...st,
      ...fix,
      worktree: st.worktree,
      gate,
      verdict: again.verdict,
      musts: again.musts,
      parked: again.verdict === "PASS" ? undefined : "review FAIL after one fix round",
    };
  },
);

// ---- Report ----
phase("Report");
const report = {
  run: RUN,
  clusters: clusters.map((c, i) => {
    const r = results[i];
    if (!r)
      return {
        id: c.id,
        rows: rowsOf(c),
        branch: `fix/swarm-${N}-${c.id}`,
        worktree: null,
        gate: null,
        verdict: null,
        musts: [],
        parked: "pipeline stage threw",
      };
    return {
      id: c.id,
      rows: rowsOf(c),
      branch: r.branch,
      worktree: r.worktree || null,
      gate: r.gate ? r.gate.ok : null,
      verdict: r.verdict || null,
      musts: r.musts || [],
      parked: r.parked || false,
    };
  }),
  excluded,
};
return report;
