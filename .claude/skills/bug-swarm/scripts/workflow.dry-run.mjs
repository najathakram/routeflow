#!/usr/bin/env node
// Why: a Workflow script can only be proven by running it; this harness runs workflow.js against stubbed
// globals (no real agents) and asserts the /bug-swarm v1 contract: pure meta, phase titles, model/effort
// per role, HIGH rows never reach Build, bounded fix rounds, 0 clusters skips to Report.
//
//   node workflow.dry-run.mjs        (exit 0 = every assertion held)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const WORKFLOW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflow.js");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const ROLE_TABLE = {
  Triage: { model: "haiku", effort: "low" },
  Cluster: { model: "haiku", effort: "low" },
  Pack: { model: "sonnet", effort: "low" },
  Build: { model: "sonnet", effort: "medium" },
  Gate: { model: "haiku", effort: "low" },
  Review: { model: "opus", effort: "medium" },
};

export const loadSource = () => readFileSync(WORKFLOW, "utf8");

/** Evaluate the `meta` literal in an empty vm context: any identifier/call in it throws. */
export function readMeta(src) {
  const m = /export const meta = (\{[\s\S]*?\n\});/.exec(src);
  assert.ok(
    m,
    "workflow.js must start with `export const meta = {...};` ending at a line-start `};`",
  );
  return vm.runInNewContext(`(${m[1]})`, Object.create(null), { timeout: 100 });
}

/**
 * Run workflow.js with stubbed globals.
 * scenario: { clusters: [{id,rows}], excluded?, gateGreen: bool|fn(n), verdict: "PASS"|"FAIL"|fn(n) }
 */
export async function runWorkflow(scenario, args = {}) {
  const src = loadSource();
  const body = src.replace(/^export const meta/m, "const meta");
  const calls = [];
  const phases = [];
  const gateN = {};
  const reviewN = {};
  const clusters = scenario.clusters.map((c) => ({
    id: c.id,
    bugs: c.rows.map((r) => ({ row: r })),
    files: [`apps/web/${c.id}.tsx`],
    workspaces: ["apps/web"],
    needsDb: false,
    ui: true,
    extractionFirst: false,
  }));
  const lastHead = {};
  const manifestBugs =
    scenario.manifestBugs ??
    scenario.clusters.flatMap((c) => c.rows.map((r) => ({ row: r, risk: "LOW", status: "live" })));
  const pick = (v, n) => (typeof v === "function" ? v(n) : v);
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, ...opts });
    const [kind, id] = String(opts.label).split(":");
    if (scenario.throwOn === opts.label) throw new Error("boom");
    switch (kind) {
      case "triage":
        return scenario.triageNull
          ? null
          : { run: args.run, bugs: scenario.triageBugs ?? manifestBugs };
      case "cluster":
        return {
          clusters,
          excluded: scenario.excluded ?? [],
          parked: scenario.parked ?? [],
          unaccounted: scenario.unaccounted ?? [],
          overCap: !!scenario.overCap,
          bugs: manifestBugs,
        };
      case "pack":
        return scenario.packFail
          ? { ok: false, path: "", bytes: 0 }
          : { ok: true, path: `/p/${id}.md`, bytes: 100 };
      case "build":
      case "buildfix":
      case "reviewfix":
        if (
          scenario.emptyBuild === "always" ||
          (scenario.emptyBuild === "first" && kind === "build")
        )
          return {
            status: "ok",
            commits: [],
            redValues: [],
            specEdits: [],
            lesson: "none",
            worktree: `/wt/${id}`,
            head: "empty",
          };
        if (scenario.worktreeFailed && kind === "build")
          return {
            status: "worktree-failed",
            message: "dir exists",
            commits: [],
            redValues: [],
            specEdits: [],
            lesson: "",
            worktree: "",
            head: "",
          };
        lastHead[id] = `head-${id}-${(lastHead[id + "n"] = (lastHead[id + "n"] ?? 0) + 1)}`;
        return {
          status: "ok",
          commits: [`sha-${id}`],
          redValues: ["expected 1 got 2"],
          specEdits: [],
          lesson: "none",
          worktree: `/wt/${id}`,
          head: lastHead[id],
        };
      case "gate": {
        gateN[id] = (gateN[id] ?? 0) + 1;
        if (scenario.gateNull) return null;
        if (pick(scenario.gateRunning ?? false, gateN[id]))
          return { ok: false, running: true, head: "", steps: [] };
        const ok = pick(scenario.gateGreen, gateN[id]);
        const head = scenario.staleHead ? "old-head" : lastHead[id];
        return { ok, head, steps: [{ name: "jest", ok, tail: ok ? "" : "boom" }] };
      }
      case "review":
      case "recheck": {
        reviewN[id] = (reviewN[id] ?? 0) + 1;
        const verdict = pick(scenario.verdict, reviewN[id]);
        return { verdict, musts: verdict === "PASS" ? [] : ["fix it"], nits: [] };
      }
      default:
        throw new Error(`unknown agent label ${opts.label}`);
    }
  };
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        try {
          let prev = item;
          for (const s of stages) prev = await s(prev, item, i);
          return prev;
        } catch {
          return null;
        }
      }),
    );
  const parallel = (thunks) =>
    Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(t)
          .catch(() => null),
      ),
    );
  const phase = (t) => phases.push(t);
  const fn = new AsyncFunction(
    "agent",
    "pipeline",
    "parallel",
    "phase",
    "log",
    "args",
    "budget",
    body,
  );
  const result = await fn(agent, pipeline, parallel, phase, () => {}, args, {});
  return { result, calls, phases };
}

const ARGS = {
  run: "2026-10-23-bug-swarm-9",
  rows: ["1", "2"],
  repo: "/repo",
  runDir: "/repo/.claude/pipeline/r",
  fromWorktree: "/wt/base",
  maxClusters: 4,
};
const count = (calls, re) => calls.filter((c) => re.test(c.label)).length;
const two = [
  { id: "c1", rows: ["1"] },
  { id: "c2", rows: ["2"] },
];

export async function runAll() {
  const out = {};
  const src = loadSource();

  // 1. meta is a pure literal; titles match the phase() calls.
  const meta = readMeta(src);
  assert.equal(typeof meta.name, "string");
  assert.equal(typeof meta.description, "string");
  const titles = Array.from(meta.phases, (p) => p.title);
  assert.deepEqual(titles, Object.keys(ROLE_TABLE).concat("Report"));
  for (const p of meta.phases) assert.ok(p.detail, `phase ${p.title} needs detail`);

  // 2. green path: one Gate and one Review per cluster, model/effort per the role table.
  const green = await runWorkflow({ clusters: two, gateGreen: true, verdict: "PASS" }, ARGS);
  for (const c of green.calls) {
    assert.ok(c.phase in ROLE_TABLE, `agent ${c.label} has phase ${c.phase}`);
    assert.equal(c.model, ROLE_TABLE[c.phase].model, `${c.label} model`);
    assert.equal(c.effort, ROLE_TABLE[c.phase].effort, `${c.label} effort`);
  }
  assert.equal(count(green.calls, /^gate:/), 2);
  assert.equal(count(green.calls, /^review:/), 2);
  assert.equal(count(green.calls, /^(buildfix|reviewfix|recheck):/), 0);
  assert.equal(count(green.calls, /^build:/), 2);
  const seen = [...new Set(green.phases)];
  assert.deepEqual(seen, titles, "phase() calls cover meta titles, in order");
  assert.equal(green.result.clusters.length, 2);
  assert.ok(green.result.clusters.every((c) => c.verdict === "PASS" && !c.parked));
  out.green = { calls: green.calls.length, gate: 2, review: 2 };

  // 3. zero clusters: Pack/Build/Gate/Review never called, Report still returned.
  const zero = await runWorkflow(
    {
      clusters: [],
      excluded: [{ row: "9", reason: "risk HIGH" }],
      gateGreen: true,
      verdict: "PASS",
    },
    ARGS,
  );
  assert.equal(count(zero.calls, /^(pack|build|buildfix|gate|review|reviewfix|recheck):/), 0);
  assert.equal(zero.result.clusters.length, 0);
  assert.equal(zero.result.excluded.length, 1);
  assert.ok(zero.phases.includes("Report"));
  out.zero = { calls: zero.calls.length };

  // 4. gate always red: one fix round, two gates, no review, parked.
  const red = await runWorkflow({ clusters: [two[0]], gateGreen: false, verdict: "PASS" }, ARGS);
  assert.equal(count(red.calls, /^build:/), 1);
  assert.equal(count(red.calls, /^buildfix:/), 1);
  assert.equal(count(red.calls, /^gate:/), 2);
  assert.equal(count(red.calls, /^(review|recheck|reviewfix):/), 0);
  assert.ok(red.result.clusters[0].parked);
  out.gateRed = { calls: red.calls.length, gate: 2, buildfix: 1 };

  // 5. review always FAIL: one review fix round, gate again, one recheck, parked.
  const fail = await runWorkflow({ clusters: [two[0]], gateGreen: true, verdict: "FAIL" }, ARGS);
  assert.equal(count(fail.calls, /^review:/), 1);
  assert.equal(count(fail.calls, /^reviewfix:/), 1);
  assert.equal(count(fail.calls, /^recheck:/), 1);
  assert.equal(count(fail.calls, /^gate:/), 2);
  assert.equal(count(fail.calls, /^buildfix:/), 0);
  assert.ok(fail.result.clusters[0].parked);
  assert.equal(fail.result.clusters[0].verdict, "FAIL");
  out.reviewFail = { calls: fail.calls.length, gate: 2, review: 2 };

  // 6. FAIL then PASS on the re-check: not parked.
  const heal = await runWorkflow(
    { clusters: [two[0]], gateGreen: true, verdict: (n) => (n === 1 ? "FAIL" : "PASS") },
    ARGS,
  );
  assert.ok(!heal.result.clusters[0].parked);
  assert.equal(heal.result.clusters[0].verdict, "PASS");

  // 7. avoidFiles reaches the Build prompt.
  const avoid = await runWorkflow(
    { clusters: [two[0]], gateGreen: true, verdict: "PASS" },
    { ...ARGS, avoidFiles: ["apps/api/src/orders/orders.service.ts"] },
  );
  assert.ok(avoid.calls.find((c) => c.label === "build:c1").prompt.includes("orders.service.ts"));

  // 8. HIGH / not-live bug in the cluster result never reaches Build.
  const high = await runWorkflow(
    {
      clusters: [
        { id: "c1", rows: ["1"] },
        { id: "c2", rows: ["2"] },
      ],
      manifestBugs: [
        { row: "1", risk: "LOW", status: "live" },
        { row: "2", risk: "HIGH", status: "live" },
      ],
      gateGreen: true,
      verdict: "PASS",
    },
    ARGS,
  );
  assert.equal(count(high.calls, /^build:/), 1);
  assert.equal(high.calls.find((c) => c.label === "build:c1") !== undefined, true);
  assert.equal(high.result.clusters.length, 1);
  assert.ok(high.result.excluded.some((e) => e.row === "2"));

  // 9. Triage dead: every requested row unaccounted, nothing else runs.
  const dead = await runWorkflow(
    { clusters: two, triageNull: true, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(dead.calls.length, 1);
  assert.deepEqual([...dead.result.unaccounted], ["1", "2"]);
  assert.match(dead.result.error, /triage/);

  // 10. A stage throw parks the cluster with the stage name.
  const thrown = await runWorkflow(
    { clusters: [two[0]], throwOn: "gate:c1", gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.match(thrown.result.clusters[0].parked, /stage Gate threw/);
  assert.equal(count(thrown.calls, /^review:/), 0);
  assert.ok(thrown.result.parked.some((p) => /stage Gate/.test(p.reason)));

  // 11. A stale gate head is red: one fix round, then parked.
  const stale = await runWorkflow(
    { clusters: [two[0]], staleHead: true, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(count(stale.calls, /^buildfix:/), 1);
  assert.equal(count(stale.calls, /^gate:/), 2);
  assert.equal(count(stale.calls, /^review:/), 0);
  assert.ok(stale.result.clusters[0].parked);
  const rounds = stale.calls
    .filter((c) => /^gate:/.test(c.label))
    .map((c) => /gate-c1-r(\d)\.json/.exec(c.prompt)[1]);
  assert.deepEqual(rounds, ["1", "2"]);

  // 12. Over-cap clusters are reported parked, with overCap and unaccounted carried through.
  const cap = await runWorkflow(
    {
      clusters: [two[0]],
      parked: [{ id: "c9" }],
      overCap: true,
      unaccounted: ["7"],
      gateGreen: true,
      verdict: "PASS",
    },
    ARGS,
  );
  assert.equal(cap.result.overCap, true);
  assert.ok(cap.result.parked.some((p) => p.id === "c9"));
  assert.ok(cap.result.unaccounted.includes("7"));

  // 13. worktree-failed and pack failure park the cluster; missing rows reports an error.
  const wtf = await runWorkflow(
    { clusters: [two[0]], worktreeFailed: true, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.match(wtf.result.clusters[0].parked, /worktree-failed/);
  assert.equal(count(wtf.calls, /^gate:/), 0);
  const pf = await runWorkflow(
    { clusters: [two[0]], packFail: true, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(pf.result.clusters[0].parked, "pack failed");
  assert.equal(count(pf.calls, /^build:/), 0);
  const norows = await runWorkflow(
    { clusters: two, gateGreen: true, verdict: "PASS" },
    { ...ARGS, rows: undefined },
  );
  assert.ok(norows.result.error);
  assert.equal(norows.calls.length, 0);

  // 14. Full-slug names, cluster flags, avoid on gate.
  const flags = await runWorkflow(
    { clusters: [two[0]], gateGreen: true, verdict: "PASS" },
    { ...ARGS, avoidFiles: ["a/b.ts"] },
  );
  const cl = flags.calls.find((c) => c.label === "cluster").prompt;
  assert.ok(
    cl.includes("--max 4") && cl.includes('--avoid "a/b.ts"') && cl.includes('--rows "1,2"'),
  );
  assert.ok(cl.includes("Hard rules"));
  assert.ok(flags.calls.find((c) => c.label === "gate:c1").prompt.includes('--avoid "a/b.ts"'));
  const bp = flags.calls.find((c) => c.label === "build:c1").prompt;
  assert.ok(bp.includes(`--branch "fix/${ARGS.run}-c1"`) && bp.includes(`/repo-wt-${ARGS.run}-c1`));
  assert.equal(flags.result.clusters[0].branch, `fix/${ARGS.run}-c1`);

  // 15. Gate still running once: exactly one re-gate, no fix round, cluster green.
  const run1 = await runWorkflow(
    { clusters: [two[0]], gateRunning: (n) => n === 1, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(count(run1.calls, /^gate:/), 2);
  assert.equal(count(run1.calls, /^buildfix:/), 0);
  assert.equal(run1.result.clusters[0].verdict, "PASS");
  assert.ok(!run1.result.clusters[0].parked);

  // 16. Gate running twice: parked "gate incomplete", zero fix rounds, no review.
  const run2 = await runWorkflow(
    { clusters: [two[0]], gateRunning: true, gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(run2.result.clusters[0].parked, "gate incomplete");
  assert.equal(count(run2.calls, /^gate:/), 2);
  assert.equal(count(run2.calls, /^(buildfix|review):/), 0);

  // 16b. Dead gate agent: same re-gate/park logic, distinct reason; prompt uses --wait, never sleep.
  const dead2 = await runWorkflow({ clusters: [two[0]], gateNull: true, verdict: "PASS" }, ARGS);
  assert.equal(dead2.result.clusters[0].parked, "gate agent died");
  assert.equal(count(dead2.calls, /^gate:/), 2);
  assert.equal(count(dead2.calls, /^buildfix:/), 0);
  const gp = run1.calls.find((c) => c.label === "gate:c1").prompt;
  assert.ok(
    gp.includes("--wait") &&
      !/\bsleep (?!\w*\) is blocked)/.test(gp.replace("Never use sleep (it is blocked)", "")),
  );

  // 17. Cluster relay says LOW, Triage says HIGH: Triage wins, bug dropped.
  const relay = await runWorkflow(
    {
      clusters: [two[0], two[1]],
      triageBugs: [
        { row: "1", risk: "LOW", status: "live" },
        { row: "2", risk: "HIGH", status: "live" },
      ],
      manifestBugs: [
        { row: "1", risk: "LOW", status: "live" },
        { row: "2", risk: "LOW", status: "live" },
      ],
      gateGreen: true,
      verdict: "PASS",
    },
    ARGS,
  );
  assert.equal(count(relay.calls, /^build:/), 1);
  assert.ok(relay.result.excluded.some((e) => e.row === "2"));

  // 18. Reconciliation: a manifest bug and a requested row that no bucket holds become unaccounted.
  const recon = await runWorkflow(
    {
      clusters: [two[0]],
      triageBugs: [
        { row: "1", risk: "LOW", status: "live" },
        { row: "3", risk: "LOW", status: "live" },
      ],
      gateGreen: true,
      verdict: "PASS",
    },
    { ...ARGS, rows: ["1", "3", "5"] },
  );
  assert.deepEqual([...recon.result.unaccounted].sort(), ["3", "5"]);

  // 19. Empty build is red: the fix round runs once (no gate before it); a second empty parks "no change".
  const e1 = await runWorkflow(
    { clusters: [two[0]], emptyBuild: "first", gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(count(e1.calls, /^buildfix:/), 1);
  assert.equal(count(e1.calls, /^gate:/), 1);
  assert.ok(!e1.result.clusters[0].parked);
  const e2 = await runWorkflow(
    { clusters: [two[0]], emptyBuild: "always", gateGreen: true, verdict: "PASS" },
    ARGS,
  );
  assert.equal(e2.result.clusters[0].parked, "no change");
  assert.equal(count(e2.calls, /^(gate|review):/), 0);
  assert.equal(count(e2.calls, /^buildfix:/), 1);

  // 20. fromWorktree is required; the gate prompt stops an earlier gate by pid file.
  const nofrom = await runWorkflow(
    { clusters: two, gateGreen: true, verdict: "PASS" },
    { ...ARGS, fromWorktree: undefined },
  );
  assert.ok(nofrom.result.error);
  assert.equal(nofrom.calls.length, 0);
  for (const needle of [
    "gate-c1.pid",
    "stop any earlier gate",
    "ps -p P -o command=",
    "ONLY if that output contains gate.mjs",
    "never kill otherwise",
    "--pid-file",
  ])
    assert.ok(gp.includes(needle), `gate prompt pins: ${needle}`);

  // 21. Real cluster.mjs parked shape ({ cluster: { bugs }, reason }): the row is parked only.
  const realParked = await runWorkflow(
    {
      clusters: [two[0]],
      parked: [{ cluster: { id: "c9", bugs: [{ row: "7" }], files: [] }, reason: "over cap" }],
      overCap: true,
      gateGreen: true,
      verdict: "PASS",
    },
    { ...ARGS, rows: ["1", "7"] },
  );
  assert.equal(realParked.result.parked.filter((p) => p.reason === "over cap").length, 1);
  assert.ok(!realParked.result.unaccounted.includes("7"));

  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll().then(
    (o) => console.log("workflow dry-run ok", JSON.stringify(o)),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
