/**
 * T44-T47 (R22) — inferred-vs-reported reconciliation (spec 5.7) and the Railway source.
 * `src/domain/reconcile.ts`, `src/sources/railway.ts`.
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   reconcile(state, inferred, now) -> state'      pure; `state` is a folded ControlState (events +
 *     registers only, deep-frozen here), `inferred` = { prs: PR[] (normalized, see prs.spec.ts),
 *     branches: {name, committedDate}[], deploys: Deploys | null, repoDir?: string }. Returns a NEW state:
 *       prs         = inferred.prs (with `deployed: true|false|"unknown"` recomputed from deploys)
 *       tasks[id]   = {status, verified?, badges: string[], deployed?: {api, web}}; status.source is
 *                     "inferred" whenever inference moved it
 *       lanes[id]   = {heartbeat, stale} recomputed as max(last event, last push on an attributed branch)
 *       nudges      = [{lane, task, pr, message}]   ("RF-2 merged as #7 - run `ctl done`? or start next")
 *       timeline    += an entry whose text contains "inferred from #<pr>"
 *   Deploys = { api: {sha, at}|null, web: {sha, at}|null, failedShas: string[] };
 *     a merge sha is "deployed" on a service iff `git merge-base --is-ancestor <sha> <service sha>`
 *     in `repoDir` (exit 1 -> false; unknown commit / error -> "unknown"; deploys null -> "unknown").
 *   FIELD_WINNER = the §5.7 table: { prState: "inferred", taskCodeComplete: "inferred-if-linked",
 *     taskReleased: "inferred", decisions: "reported", heartbeat: "latest", bug: "register" }
 *   railway.ts: normalizeDeployments(raw) -> Deploys; readDeployState(probe, fallback?) ->
 *     Promise<{ state: Deploys | null, source: "railway" | "github" | "none", warnings: string[] }>
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NOW } from "./helpers/clock";
import { git as run } from "./helpers/temp-repo";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const rec = tryRequire(() => require("../src/domain/reconcile"));
const rw = tryRequire(() => require("../src/sources/railway"));
const needRec = () => {
  expect(rec).toBeDefined();
  expect(typeof rec.reconcile).toBe("function");
  return rec.reconcile as (s: any, i: any, now: string) => any;
};

const MIN = 60_000;
const H = 60 * MIN;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as any)) deepFreeze(v);
  }
  return o;
};

const d = (value: any, source = "reported", ref: string | null = null) => ({ value, source, ref });
const mkTask = (id: string, status: string, o: Record<string, any> = {}): any => ({
  id,
  title: `acme: ${id}`,
  kind: "feature",
  status: d(status, o.source ?? "reported", o.ref ?? "lane-u#1"),
  priority: d("P2", "register"),
  release: d(null, "register"),
  lane: d("lane-u", "reported", "lane-u#1"),
  phase: d(null, "register"),
  areas: d([], "register"),
  dependsOn: [],
  related: d([], "register"),
  effort: "M",
  importance: 3,
  customerImpact: "none",
  ref: null,
  notes: null,
  pr: d(null, "register"),
  ...Object.fromEntries(Object.entries(o).filter(([k]) => !["source", "ref"].includes(k))),
});
const mkLane = (id: string, o: Record<string, any> = {}): any => ({
  id,
  name: id,
  machine: "mac",
  kind: "feature",
  active: true,
  current: d(null),
  next: d(null),
  blockers: [],
  heartbeat: d(ago(H), "reported", `${id}#1`),
  stale: d("live", "reported", `${id}#1`),
  ...o,
});
const mkState = (tasks: any[] = [], lanes: any[] = []): any =>
  deepFreeze({
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    lanes: Object.fromEntries(lanes.map((l) => [l.id, l])),
    releases: {},
    prs: [],
    branches: [],
    waste: [],
    overlap: [],
    piggyback: {},
    acks: {},
    superseded: {},
    timeline: [],
    warnings: [],
    sources: { events: 0, lanes: lanes.length, github: false, railway: false },
    version: "",
  });
const mkPR = (o: Record<string, any> = {}): any => {
  const n = o.pr ?? 7;
  return {
    pr: n,
    title: `acme: change ${n}`,
    state: "merged",
    headSha: "a".repeat(40),
    headRef: `feat/RF-2-x`,
    baseRef: "master",
    mergeSha: "b".repeat(40),
    createdAt: ago(30 * H),
    updatedAt: ago(5 * H),
    mergedAt: ago(5 * H),
    closedAt: ago(5 * H),
    headCommittedAt: ago(6 * H),
    lane: "lane-u",
    links: {
      task: "RF-2",
      bug: null,
      feature: null,
      defers: null,
      issue: null,
      ...(o.links ?? {}),
    },
    ci: "green",
    ciSince: ago(6 * H),
    review: "approved",
    mergeable: "clean",
    files: 1,
    filePaths: ["apps/api/a.ts"],
    areas: ["apps"],
    body: "",
    bookkeepingPending: false,
    deployed: false,
    ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "links")),
  };
};
const inferred = (o: Record<string, any> = {}) => ({
  prs: [],
  branches: [],
  deploys: null,
  ...o,
});
const text = (x: unknown) => JSON.stringify(x);

describe("FIELD_WINNER (spec 5.7 as one table)", () => {
  it("has the §5.7 rows with the documented winners", () => {
    expect(rec).toBeDefined();
    expect(rec.FIELD_WINNER).toBeDefined();
    expect(rec.FIELD_WINNER).toEqual({
      prState: "inferred",
      taskCodeComplete: "inferred-if-linked",
      taskReleased: "inferred",
      decisions: "reported",
      heartbeat: "latest",
      bug: "register",
    });
  });
});

describe("row 1: PR state, CI, mergeable, review, merged sha, deployed -> inferred only", () => {
  it("state.prs is the inferred set; a stale or reported value is never kept", () => {
    const reconcile = needRec();
    const s = {
      ...mkState([mkTask("RF-2", "in-progress")]),
      prs: [{ pr: 7, state: "open", ci: "red" }],
    };
    const pr = mkPR({ pr: 7, state: "merged", ci: "green" });
    const out = reconcile(deepFreeze(s), inferred({ prs: [pr] }), NOW);
    expect(out.prs).toHaveLength(1);
    expect(out.prs[0]).toMatchObject({
      pr: 7,
      state: "merged",
      ci: "green",
      mergeSha: "b".repeat(40),
    });
  });

  it("does not mutate the folded state it was given", () => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-2", "in-progress")], [mkLane("lane-u", { current: d("RF-2") })]);
    const snap = text(s);
    reconcile(s, inferred({ prs: [mkPR()] }), NOW);
    expect(text(s)).toBe(snap);
  });
});

describe("row 2 / T44: a merged PR linking the task advances it (inferred)", () => {
  const laneU = () => mkLane("lane-u", { current: d("RF-2", "reported", "lane-u#3") });

  it("reported in-progress + merged PR #7 -> code-complete, source inferred, timeline `inferred from #7`", () => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-2", "in-progress", { ref: "lane-u#3" })], [laneU()]);
    const out = reconcile(s, inferred({ prs: [mkPR({ pr: 7 })] }), NOW);
    const t = out.tasks["RF-2"];
    expect(t.status.value).toBe("code-complete");
    expect(t.status.source).toBe("inferred");
    expect(String(t.status.ref)).toContain("7");
    expect(text(out.timeline)).toContain("inferred from #7");
    expect(t.verified).not.toBe(false);
  });

  it("links by bug / feature trailer and by the task's own `pr` number also count", () => {
    const reconcile = needRec();
    const feat = mkTask("F-05", "in-progress");
    const viaPr = mkTask("RF-8", "in-progress", { pr: d(9, "reported", "lane-u#4") });
    const s = mkState([feat, viaPr]);
    const out = reconcile(
      s,
      inferred({
        prs: [
          mkPR({ pr: 7, links: { task: null, feature: "F-05" } }),
          mkPR({ pr: 9, links: { task: null } }),
        ],
      }),
      NOW,
    );
    expect(out.tasks["F-05"].status).toMatchObject({ value: "code-complete", source: "inferred" });
    expect(out.tasks["RF-8"].status).toMatchObject({ value: "code-complete", source: "inferred" });
  });

  it("an OPEN, draft or closed-unmerged PR never advances the task (no mis-advance)", () => {
    const reconcile = needRec();
    for (const over of [
      { state: "open", mergedAt: null, mergeSha: null },
      { state: "ready", mergedAt: null, mergeSha: null },
      { state: "draft", mergedAt: null, mergeSha: null },
      { state: "closed", mergedAt: null, mergeSha: null },
    ]) {
      const s = mkState([mkTask("RF-2", "in-progress", { ref: "lane-u#3" })], [laneU()]);
      const out = reconcile(s, inferred({ prs: [mkPR(over)] }), NOW);
      expect(out.tasks["RF-2"].status).toMatchObject({ value: "in-progress", source: "reported" });
      expect(text(out.timeline)).not.toContain("inferred from");
    }
  });

  it("a merged PR for a task that is already code-complete or released changes nothing", () => {
    const reconcile = needRec();
    const s = mkState([
      mkTask("RF-2", "released", { source: "reported", ref: "lead#9" }),
      mkTask("RF-3", "code-complete", { ref: "lane-u#5" }),
    ]);
    const out = reconcile(
      s,
      inferred({
        prs: [mkPR({ pr: 7 }), mkPR({ pr: 8, links: { task: "RF-3" }, mergeSha: "c".repeat(40) })],
      }),
      NOW,
    );
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "released", source: "reported" });
    expect(out.tasks["RF-3"].status.value).toBe("code-complete");
  });

  it("a merged PR linking a BLOCKED, reconsidered or dropped task does not override that decision", () => {
    const reconcile = needRec();
    for (const st of ["blocked", "reconsider", "dropped"]) {
      const s = mkState([mkTask("RF-2", st, { ref: "lane-u#6" })]);
      const out = reconcile(s, inferred({ prs: [mkPR({ pr: 7 })] }), NOW);
      expect(out.tasks["RF-2"].status).toMatchObject({ value: st, source: "reported" });
    }
  });
});

describe("row 4 / T46: lane pointers and decisions stay reported; the lane gets a nudge", () => {
  it("lane.current stays on the merged task (source reported) and `ctl next` gets a nudge naming the PR", () => {
    const reconcile = needRec();
    const s = mkState(
      [mkTask("RF-2", "in-progress", { ref: "lane-u#3" })],
      [
        mkLane("lane-u", {
          current: d("RF-2", "reported", "lane-u#3"),
          next: d("RF-9", "reported", "lane-u#4"),
        }),
      ],
    );
    const out = reconcile(s, inferred({ prs: [mkPR({ pr: 7 })] }), NOW);
    expect(out.lanes["lane-u"].current).toMatchObject({ value: "RF-2", source: "reported" });
    expect(out.lanes["lane-u"].next).toMatchObject({ value: "RF-9", source: "reported" });
    const n = out.nudges.find((x: any) => x.lane === "lane-u");
    expect(n).toBeDefined();
    expect(n.task).toBe("RF-2");
    expect(n.pr).toBe(7);
    expect(n.message).toContain("RF-2 merged as #7");
  });

  it("no nudge when nothing merged, or when the lane's current task is a different one", () => {
    const reconcile = needRec();
    const s = mkState(
      [mkTask("RF-2", "in-progress"), mkTask("RF-5", "in-progress")],
      [mkLane("lane-u", { current: d("RF-5", "reported", "lane-u#3") })],
    );
    const out = reconcile(
      s,
      inferred({ prs: [mkPR({ pr: 7, state: "open", mergedAt: null, mergeSha: null })] }),
      NOW,
    );
    expect(out.nudges).toEqual([]);
    const out2 = reconcile(s, inferred({ prs: [mkPR({ pr: 7 })] }), NOW);
    expect(out2.nudges.find((x: any) => x.lane === "lane-u")).toBeUndefined();
  });

  it("priority, release and lane assignment are reported decisions: a merged PR never overwrites them", () => {
    const reconcile = needRec();
    const t = mkTask("RF-2", "in-progress", {
      priority: d("P0", "reported", "lead#4"),
      release: d("R1.1c", "reported", "lead#5"),
      lane: d("lane-v", "reported", "owner#2"),
    });
    const out = reconcile(mkState([t]), inferred({ prs: [mkPR({ pr: 7, lane: "r-ui" })] }), NOW);
    expect(out.tasks["RF-2"].priority).toMatchObject({ value: "P0", source: "reported" });
    expect(out.tasks["RF-2"].release).toMatchObject({ value: "R1.1c", source: "reported" });
    expect(out.tasks["RF-2"].lane).toMatchObject({ value: "lane-v", source: "reported" });
  });
});

describe("row 2 / T46: reported `done` with no linked PR -> unverified", () => {
  it("RF-3 reported code-complete, no PR -> status code-complete, verified false, badge `unverified`", () => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-3", "code-complete", { ref: "lane-u#9" })]);
    const out = reconcile(s, inferred({ prs: [mkPR({ pr: 7 })] }), NOW); // PR 7 links RF-2, not RF-3
    const t = out.tasks["RF-3"];
    expect(t.status.value).toBe("code-complete");
    expect(t.status.source).toBe("reported");
    expect(t.verified).toBe(false);
    expect(t.badges).toContain("unverified");
  });

  it("the same task with a merged PR linking it is verified (no badge)", () => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-3", "code-complete", { ref: "lane-u#9" })]);
    const out = reconcile(s, inferred({ prs: [mkPR({ pr: 8, links: { task: "RF-3" } })] }), NOW);
    expect(out.tasks["RF-3"].verified).not.toBe(false);
    expect(out.tasks["RF-3"].badges ?? []).not.toContain("unverified");
  });

  it("an open PR does not verify it", () => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-3", "code-complete", { ref: "lane-u#9" })]);
    const pr = mkPR({
      pr: 8,
      state: "open",
      mergedAt: null,
      mergeSha: null,
      links: { task: "RF-3" },
    });
    expect(reconcile(s, inferred({ prs: [pr] }), NOW).tasks["RF-3"].verified).toBe(false);
  });

  it("tasks that are not code-complete carry no unverified badge", () => {
    const reconcile = needRec();
    const out = reconcile(
      mkState([mkTask("RF-4", "in-progress"), mkTask("RF-5", "planned", { source: "register" })]),
      inferred(),
      NOW,
    );
    expect(out.tasks["RF-4"].badges ?? []).not.toContain("unverified");
    expect(out.tasks["RF-5"].badges ?? []).not.toContain("unverified");
  });
});

describe("row 6: bug open/fixed -> the register wins; a merged `Bug:` PR only adds a badge", () => {
  it("register-open bug B905 + merged PR with `Bug: B905` -> status unchanged (register), badge `fixed · register lag`", () => {
    const reconcile = needRec();
    const bug = mkTask("B905", "planned", {
      source: "register",
      ref: null,
      kind: "bug",
      lane: d(null, "register"),
    });
    const out = reconcile(
      mkState([bug]),
      inferred({ prs: [mkPR({ pr: 7, links: { task: null, bug: "B905" } })] }),
      NOW,
    );
    const t = out.tasks["B905"];
    expect(t.status).toMatchObject({ value: "planned", source: "register" });
    expect((t.badges as string[]).some((b) => /register lag/.test(b))).toBe(true);
  });

  it("no merged PR -> no badge", () => {
    const reconcile = needRec();
    const bug = mkTask("B905", "planned", {
      source: "register",
      ref: null,
      kind: "bug",
      lane: d(null, "register"),
    });
    const pr = mkPR({
      pr: 7,
      state: "open",
      mergedAt: null,
      mergeSha: null,
      links: { task: null, bug: "B905" },
    });
    const out = reconcile(mkState([bug]), inferred({ prs: [pr] }), NOW);
    expect((out.tasks["B905"].badges ?? []).some((b: string) => /register lag/.test(b))).toBe(
      false,
    );
  });
});

describe("lane heartbeat (row 5 / T47): max(last event, last push on an attributed branch)", () => {
  const hb = (eventAgo: number, pushes: any[] = [], prs: any[] = []) => {
    const reconcile = needRec();
    const lane = mkLane("lane-u", { heartbeat: d(ago(eventAgo), "reported", "lane-u#8") });
    const out = reconcile(mkState([], [lane]), inferred({ branches: pushes, prs }), NOW);
    return out.lanes["lane-u"];
  };
  const openPR = (branch: string, lane = "lane-u") =>
    mkPR({
      pr: 20,
      state: "open",
      mergedAt: null,
      mergeSha: null,
      headRef: branch,
      lane,
      links: { task: null },
    });

  it("T47: last event 30 h ago but a push on its branch 2 h ago -> heartbeat is the push, not stale", () => {
    const l = hb(
      30 * H,
      [{ name: "feat/lane-u-work", committedDate: ago(2 * H) }],
      [openPR("feat/lane-u-work")],
    );
    expect(l.heartbeat.value).toBe(ago(2 * H));
    expect(l.heartbeat.source).toBe("inferred");
    expect(l.stale.value).toBe("live");
  });

  it("T47: no push and 80 h since the last event -> silent", () => {
    expect(hb(80 * H).stale.value).toBe("silent");
  });

  it("an event newer than the push keeps the reported heartbeat (max)", () => {
    const l = hb(
      1 * H,
      [{ name: "feat/lane-u-work", committedDate: ago(9 * H) }],
      [openPR("feat/lane-u-work")],
    );
    expect(l.heartbeat).toMatchObject({ value: ago(1 * H), source: "reported" });
  });

  it("a push on a branch attributed to ANOTHER lane, or to no lane, does not refresh this lane", () => {
    const l = hb(
      30 * H,
      [
        { name: "feat/other-lane", committedDate: ago(1 * H) },
        { name: "feat/nobody", committedDate: ago(1 * H) },
      ],
      [openPR("feat/other-lane", "lane-v")],
    );
    expect(l.heartbeat.value).toBe(ago(30 * H));
    expect(l.stale.value).toBe("stale");
  });

  it("live -> stale at 24 h and stale -> silent at 72 h (strictly greater than, E21)", () => {
    expect(hb(24 * H - MIN).stale.value).toBe("live");
    expect(hb(24 * H + MIN).stale.value).toBe("stale");
    expect(hb(72 * H - MIN).stale.value).toBe("stale");
    expect(hb(72 * H + MIN).stale.value).toBe("silent");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* row 3 / T45 — released only when the merge sha is an ancestor of BOTH deployed commits        */
/* -------------------------------------------------------------------------------------------- */
interface Repo {
  dir: string;
  m1: string; // merge commit of PR #7
  apiSha: string; // child of m1
  webOld: string; // parent of m1
  webNew: string; // child of m1
  cleanup(): void;
}
const buildRepo = (): Repo => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp5-rec-"));
  run(dir, ["init", "-q", "--initial-branch=master"]);
  const commit = (f: string, t: string, msg: string) => {
    fs.writeFileSync(path.join(dir, f), t);
    run(dir, ["add", "-A"]);
    run(dir, ["commit", "-q", "-m", msg]);
    return run(dir, ["rev-parse", "HEAD"]).trim();
  };
  const webOld = commit("a.txt", "1\n", "older deploy");
  const m1 = commit("a.txt", "2\n", "merge of PR 7");
  const apiSha = commit("a.txt", "3\n", "api deployed here");
  const webNew = commit("a.txt", "4\n", "web deployed here");
  return {
    dir,
    m1,
    apiSha,
    webOld,
    webNew,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

describe("T45 released needs both services (git merge-base --is-ancestor)", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = buildRepo();
  });
  afterAll(() => repo.cleanup());

  const go = (deploys: any, prOver: Record<string, any> = {}, taskStatus = "in-progress") => {
    const reconcile = needRec();
    const s = mkState([mkTask("RF-2", taskStatus, { ref: "lane-u#3" })], [mkLane("lane-u")]);
    return reconcile(
      s,
      inferred({
        prs: [mkPR({ pr: 7, mergeSha: repo.m1, ...prOver })],
        deploys,
        repoDir: repo.dir,
      }),
      NOW,
    );
  };
  const at = "2026-01-12T09:00:00Z";

  it("api has it, web does not -> stays code-complete, deployed {api: true, web: false}", () => {
    const out = go({
      api: { sha: repo.apiSha, at },
      web: { sha: repo.webOld, at },
      failedShas: [],
    });
    expect(out.tasks["RF-2"].status.value).toBe("code-complete");
    expect(out.tasks["RF-2"].deployed).toEqual({ api: true, web: false });
    expect(out.prs.find((p: any) => p.pr === 7).deployed).toBe(false);
  });

  it("both services have it -> released (inferred), PR deployed true", () => {
    const out = go({
      api: { sha: repo.apiSha, at },
      web: { sha: repo.webNew, at },
      failedShas: [],
    });
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "released", source: "inferred" });
    expect(out.tasks["RF-2"].deployed).toEqual({ api: true, web: true });
    expect(out.prs.find((p: any) => p.pr === 7).deployed).toBe(true);
  });

  it("the merge sha itself deployed counts (a commit is its own ancestor)", () => {
    const out = go({ api: { sha: repo.m1, at }, web: { sha: repo.m1, at }, failedShas: [] });
    expect(out.tasks["RF-2"].status.value).toBe("released");
  });

  it("web only -> stays code-complete ({api: false, web: true})", () => {
    const out = go({
      api: { sha: repo.webOld, at },
      web: { sha: repo.webNew, at },
      failedShas: [],
    });
    expect(out.tasks["RF-2"].status.value).toBe("code-complete");
    expect(out.tasks["RF-2"].deployed).toEqual({ api: false, web: true });
  });

  it("a deployed sha the clone has never seen -> deployed 'unknown', NOT released, and no throw", () => {
    const out = go({
      api: { sha: "9".repeat(40), at },
      web: { sha: repo.webNew, at },
      failedShas: [],
    });
    expect(out.tasks["RF-2"].status.value).not.toBe("released");
    expect(out.prs.find((p: any) => p.pr === 7).deployed).toBe("unknown");
  });

  it("deploys = null (probe failed, no fallback) -> deployed 'unknown', never released", () => {
    const out = go(null);
    expect(out.tasks["RF-2"].status.value).toBe("code-complete");
    expect(out.prs.find((p: any) => p.pr === 7).deployed).toBe("unknown");
  });

  it("a service with no successful deploy -> not deployed there, not released", () => {
    const out = go({ api: { sha: repo.apiSha, at }, web: null, failedShas: [] });
    expect(out.tasks["RF-2"].status.value).toBe("code-complete");
  });

  it("an in-progress task whose PR merged and deployed everywhere goes straight to released", () => {
    const out = go(
      { api: { sha: repo.apiSha, at }, web: { sha: repo.webNew, at }, failedShas: [] },
      {},
      "in-progress",
    );
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "released", source: "inferred" });
  });

  it("an OPEN PR is never `released` whatever was deployed", () => {
    const out = go(
      { api: { sha: repo.apiSha, at }, web: { sha: repo.webNew, at }, failedShas: [] },
      { state: "open", mergedAt: null, mergeSha: null },
    );
    expect(out.tasks["RF-2"].status.value).toBe("in-progress");
  });

  it("a register-fixed bug (`Fixed · #101` -> code-complete, pr 101) goes released once #101 is on both", () => {
    const reconcile = needRec();
    const bug = mkTask("B03", "code-complete", {
      source: "register",
      ref: null,
      kind: "bug",
      pr: d(101, "register"),
      lane: d(null, "register"),
    });
    const out = reconcile(
      mkState([bug]),
      inferred({
        prs: [mkPR({ pr: 101, mergeSha: repo.m1, links: { task: null } })],
        deploys: { api: { sha: repo.apiSha, at }, web: { sha: repo.webNew, at }, failedShas: [] },
        repoDir: repo.dir,
      }),
      NOW,
    );
    expect(out.tasks["B03"].status).toMatchObject({ value: "released", source: "inferred" });
  });

  it("row 3: a reported `released` (release.shipped by lead) is never downgraded by inference", () => {
    const out = go(
      { api: { sha: repo.webOld, at }, web: { sha: repo.webOld, at }, failedShas: [] },
      {},
      "released",
    );
    expect(out.tasks["RF-2"].status).toMatchObject({ value: "released", source: "reported" });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* railway.ts — A14 probe wrapped, GitHub-deployments fallback                                   */
/* -------------------------------------------------------------------------------------------- */
describe("railway source", () => {
  const raw = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "acme", "railway", "deployments.json"),
        "utf8",
      ),
    );
  const edges = (): any[] => raw().data.deployments.edges;
  const shaOf = (id: string) => edges().find((e) => e.node.id === id).node.meta.commitHash;
  const needRw = () => {
    expect(rw).toBeDefined();
    expect(typeof rw.normalizeDeployments).toBe("function");
    expect(typeof rw.readDeployState).toBe("function");
    return rw as {
      normalizeDeployments: (raw: any) => any;
      readDeployState: (probe: () => Promise<any>, fallback?: () => Promise<any>) => Promise<any>;
    };
  };

  it("the live deploy per service is the NEWEST `SUCCESS` (not BUILDING / REMOVED / FAILED, any array order)", () => {
    const { normalizeDeployments } = needRw();
    const out = normalizeDeployments(raw());
    expect(out.api.sha).toBe(shaOf("dep-a2"));
    expect(out.api.at).toBe("2026-01-12T08:00:00Z");
    expect(out.web.sha).toBe(shaOf("dep-w1"));
  });

  it("failedShas lists commits whose deploy FAILED", () => {
    const { normalizeDeployments } = needRw();
    expect(normalizeDeployments(raw()).failedShas).toEqual([shaOf("dep-w3")]);
  });

  it("a service with no SUCCESS -> null; no deployments at all -> both null and no throw", () => {
    const { normalizeDeployments } = needRw();
    const only = {
      data: {
        deployments: {
          edges: edges().filter(
            (e) => e.node.service.name.endsWith("api") && e.node.status !== "SUCCESS",
          ),
        },
      },
    };
    expect(normalizeDeployments(only).api).toBeNull();
    const none = normalizeDeployments({ data: { deployments: { edges: [] } } });
    expect(none.api).toBeNull();
    expect(none.web).toBeNull();
  });

  it("a newest SUCCESS without a commit hash (CLI deploy) is never treated as the older known sha", () => {
    const { normalizeDeployments } = needRw();
    const e = edges();
    e.push({
      node: {
        id: "dep-a9",
        status: "SUCCESS",
        createdAt: "2026-01-12T09:45:00Z",
        service: { name: "@routeflow/api" },
      },
    });
    const out = normalizeDeployments({ data: { deployments: { edges: e } } });
    expect(out.api?.sha ?? null).toBeNull();
  });

  it("probe ok -> state from Railway, source `railway`, no warnings", async () => {
    const { readDeployState } = needRw();
    const r = await readDeployState(async () => raw());
    expect(r.source).toBe("railway");
    expect(r.state.api.sha).toBe(shaOf("dep-a2"));
    expect(r.warnings).toEqual([]);
  });

  it("probe rejects, no fallback -> state null (deployed: unknown), source `none`, one warning, never throws", async () => {
    const { readDeployState } = needRw();
    const r = await readDeployState(async () => {
      throw new Error("probe unauthorized");
    });
    expect(r.state).toBeNull();
    expect(r.source).toBe("none");
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("probe rejects, fallback ok -> GitHub deployments are used, source `github`, still warns about Railway", async () => {
    const { readDeployState } = needRw();
    const gh = {
      api: { sha: "1".repeat(40), at: "2026-01-12T07:00:00Z" },
      web: { sha: "2".repeat(40), at: "2026-01-12T07:00:00Z" },
      failedShas: [],
    };
    const r = await readDeployState(
      async () => {
        throw new Error("probe 401");
      },
      async () => gh,
    );
    expect(r.source).toBe("github");
    expect(r.state).toEqual(gh);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("probe and fallback both fail -> null state, two warnings at most, never throws", async () => {
    const { readDeployState } = needRw();
    const boom = async () => {
      throw new Error("down");
    };
    const r = await readDeployState(boom, boom);
    expect(r.state).toBeNull();
    expect(r.source).toBe("none");
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
