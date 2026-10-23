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
// Fail closed: a dead agent, a stale gate file or a thrown stage parks the cluster and is reported.

const RUN = args.run;
const R = args.repo;
const RUN_DIR = args.runDir;
const REQUESTED = Array.isArray(args.rows) ? args.rows.map(String) : [];
const SCRIPTS = args.scriptsDir || `${R}/.claude/skills/bug-swarm/scripts`;
const AVOID = Array.isArray(args.avoidFiles) ? args.avoidFiles : [];
const MAX = args.maxClusters ?? 4;
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
    parked: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } },
    unaccounted: { type: "array", items: { type: "string" } },
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
  required: ["clusters", "excluded", "bugs"],
};
const PACK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, path: { type: "string" }, bytes: { type: "number" } },
  required: ["ok", "path", "bytes"],
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

const rowsOf = (c) => c.bugs.map((b) => (b.sub ? `${b.row}${b.sub}` : b.row));
const redTails = (g) =>
  g.steps
    .filter((s) => !s.ok)
    .map((s) => `--- ${s.name} ---\n${s.tail || ""}`)
    .join("\n") || (g.running ? "gate file still marked running" : "stale or missing gate result");
// Green only when the gate ran on the commit the builder reported and says it finished ok.
const gateGreen = (g, head) => !!g && g.ok === true && !g.running && !!head && g.head === head;

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
  log(`excluded: ${r.excluded.length}`);
  log(`parked: ${r.parked.length}`);
  log(`unaccounted: ${r.unaccounted.length}${r.error ? ` (${r.error})` : ""}`);
  log(`overCap: ${r.overCap}`);
  return r;
};

if (!RUN || !R || !RUN_DIR || REQUESTED.length === 0) {
  return report({
    error: "args.run, args.repo, args.runDir and a non-empty args.rows are required",
  });
}

// ---- Triage ----
phase("Triage");
const manifest = await agent(
  `Triage these RouteFlow bug register rows for run ${RUN}: ${REQUESTED.join(", ")}.
Repo: ${R}. For each row read the register row and its card (node scripts/campaign/bugs.mjs card <id>), then decide:
risk LOW or HIGH (HIGH = money, ledger, units, locks, tenancy, migrations, billing, auth, or a repro needing a live-tenant reading), the reason, status (live | fixed-on-master | unclear: check the code on origin/master), files (use .claude/code-map/INDEX.md and scripts/graph.mjs radius), needsDb (prisma, a *.db.spec, or a transaction path), ui (yes/no) and a one-line repro. Split a row into sub-bugs (sub: "a", "b") when it holds several defects.
Write the result as JSON to ${RUN_DIR}/manifest.json (shape {"run": "${RUN}", "bugs": [...]}) and return the same object. Read-only apart from that file. ${RULES}`,
  { label: "triage", phase: "Triage", schema: MANIFEST_SCHEMA, model: "haiku", effort: "low" },
);
if (!manifest) {
  return report({ error: "triage agent died", unaccounted: REQUESTED });
}

// ---- Cluster ----
phase("Cluster");
const clustered = await agent(
  `Run exactly: cd "${R}" && node "${SCRIPTS}/cluster.mjs" "${RUN_DIR}/manifest.json" --write --max ${MAX} --rows "${REQUESTED.join(",")}"${avoidFlags}
Return its printed JSON verbatim (clusters, excluded, parked, unaccounted, overCap), and add "bugs": the list of {row, sub, risk, status} copied from ${RUN_DIR}/manifest.json. Do not edit anything else, do not reinterpret. ${RULES}`,
  { label: "cluster", phase: "Cluster", schema: CLUSTER_SCHEMA, model: "haiku", effort: "low" },
);
if (!clustered) {
  return report({ error: "cluster agent died", unaccounted: REQUESTED });
}

// HIGH or not-live bugs never reach Build, whatever the script returned.
const key = (b) => `${b.row}|${b.sub || ""}`;
const meta2 = new Map(clustered.bugs.map((b) => [key(b), b]));
const excluded = [...clustered.excluded];
const clusters = [];
for (const c of clustered.clusters) {
  const keep = c.bugs.filter((b) => {
    const m = meta2.get(key(b));
    const ok = m && m.risk === "LOW" && m.status === "live";
    if (!ok) {
      const reason = m ? `risk ${m.risk}, status ${m.status}` : "not in manifest";
      excluded.push({ row: b.row, sub: b.sub, reason: `dropped before Build: ${reason}` });
      log(`dropped ${key(b)} from ${c.id}: ${reason}`);
    }
    return ok;
  });
  if (keep.length) clusters.push({ ...c, bugs: keep });
}
log(`clusters: ${clusters.length}, excluded: ${excluded.length}`);

// ---- Per-cluster pipeline: Pack -> Build -> Gate (+fix) -> Review (+fix) ----
const buildBrief = (
  c,
  t,
  pack,
) => `You fix LOW-risk bugs ${rowsOf(c).join(", ")} in RouteFlow, test-first. Cluster ${c.id}, run ${RUN}.
Read the context pack first: ${pack}. Files in scope: ${c.files.join(", ")}.${c.extractionFirst ? " A file here is at its size-ratchet ceiling: extract first (own commit), then fix." : ""}
LOW only: if a fix needs a HIGH path (money, ledger, units, locks, tenancy, migration, billing, auth) stop and report it in the lesson field; do not fix it.
${AVOID_RULE}
Worktree: ${t.exists ? `already at ${t.dir} (branch ${t.name}); work there, do not recreate it.` : `create it first: cd "${R}" && node "${SCRIPTS}/worktree.mjs" --dir "${t.dir}" --branch "${t.name}" --from "${args.fromWorktree}". If worktree.mjs exits non-zero, STOP and return status "worktree-failed" with its message in "message" (other fields empty); never reuse or delete an existing tree or branch.`}
For each bug in order: (1) write a test that fails on the bug's own wrong value and run it; record the failing assertion text (the wrong value) in redValues; (2) make the minimal fix; (3) one commit "fix(<area>): <what> (B<id>)". Editing an existing assertion needs a line "SPEC-EDIT: <file:line> <why>" in specEdits. Put trailers on the LAST commit: "Bookkeeping-Follow-Up: pending" and "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>".
${RULES}
Return {status "ok", commits (full shas), redValues, specEdits, lesson (one candidate or "none"), worktree (absolute path), head (git rev-parse HEAD after your last commit)}.`;

const runGate = (c, wt, label, round) =>
  agent(
    `Run in the worktree, with the Bash timeout set to 600000 (or run_in_background and wait for it to exit; never read the file while it is still running): cd "${wt}" && node "${SCRIPTS}/gate.mjs" --json "${RUN_DIR}/gate-${c.id}-r${round}.json"${c.needsDb ? " --needs-db" : ""}${avoidFlags}
Then read ${RUN_DIR}/gate-${c.id}-r${round}.json and return {ok, running, head, base, steps:[{name, ok, tail}]} exactly as recorded (keep the tail only for failed steps). If the file says running:true or is missing, return it as recorded (ok false). Do not fix anything, do not rerun with other flags. ${RULES}`,
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
  // Pack
  guard("Pack", async (c) => {
    phase("Pack");
    const packPath = `${RUN_DIR}/pack-${c.id}.md`;
    const branch = `fix/${RUN}-${c.id}`;
    const p = await agent(
      `Write a context pack for cluster ${c.id} (bugs ${rowsOf(c).join(", ")}) to ${packPath}, at most 6 KB, pinned to the sha of origin/master (put it on line 1). Contents: exported signatures (not bodies) of ${c.files.join(", ")}; the graph radius (node scripts/graph.mjs radius <file>) condensed to file names; the relevant lesson ids from .claude/lessons/LESSONS-DIGEST.md with one line each; the code-map area file path. Repo: ${R}. Read-only apart from the pack. Return {ok, path, bytes} after checking the file exists. ${RULES}`,
      { label: `pack:${c.id}`, phase: "Pack", schema: PACK_SCHEMA, model: "sonnet", effort: "low" },
    );
    if (!p || !p.ok) return { c, packPath, branch, parked: "pack failed" };
    return { c, packPath: p.path || packPath, branch };
  }),
  // Build
  guard("Build", async (st) => {
    phase("Build");
    const dir = `${R}-wt-${RUN}-${st.c.id}`;
    const b = await agent(buildBrief(st.c, { name: st.branch, dir, exists: false }, st.packPath), {
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
    let gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`, 1);
    if (!gate) return { ...st, parked: "gate agent died" };
    if (gateGreen(gate, st.head)) return { ...st, gate };
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
    const next = { ...st, ...fix, worktree: st.worktree };
    phase("Gate");
    gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`, 2);
    if (!gateGreen(gate, next.head)) {
      return {
        ...next,
        gate: gate || { ok: false, steps: [] },
        parked: "gate red after one fix round",
      };
    }
    return { ...next, gate };
  }),
  // Review (+ one fix round, gate, re-check)
  guard("Review", async (st) => {
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
    const next = { ...st, ...fix, worktree: st.worktree };
    phase("Gate");
    const gate = await runGate(st.c, st.worktree, `gate:${st.c.id}`, 3);
    if (!gateGreen(gate, next.head)) {
      return {
        ...next,
        gate: gate || { ok: false, steps: [] },
        verdict: "FAIL",
        musts: first.musts,
        parked: "gate red after review fix",
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
    ...(clustered.parked || []).map((p) => ({ ...p, reason: "over cap" })),
    ...rows.filter((r) => r.parked).map((r) => ({ id: r.id, rows: r.rows, reason: r.parked })),
  ],
  unaccounted: clustered.unaccounted || [],
  overCap: !!clustered.overCap,
});
