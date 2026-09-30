/**
 * T49 (R23, A17) — W5 "closed, unmerged, work never re-landed": `relanded()` of build-plan WP5
 * (verbatim semantics: any commit of base..head has a patch-id on master, OR the whole range diff's
 * patch-id is on master) against a REAL temp git repo (local only, no network), then wired through
 * `wasteItems` so the `pr.superseded` / "Superseded by #n" escapes are proven too.
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   waste.ts
 *     relanded(g: Git, base, head, master = "origin/master") -> boolean
 *     interface Git { lines(args: string[]): string[]; patchId(commit): string; patchIdOfDiff(base, head): string }
 *   This spec supplies its own `Git` over the temp repo (`git patch-id --stable`), so the repo,
 *   not a mock, is the oracle for "same patch-id".
 *   wasteItems(input, now): input.relanded = (pr) => boolean is how the W5 predicate is injected.
 */
import { execFileSync } from "child_process";
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
const mod = tryRequire(() => require("../src/domain/waste"));
const need = () => {
  expect(mod).toBeDefined();
  expect(typeof mod.relanded).toBe("function");
  expect(typeof mod.wasteItems).toBe("function");
  return mod as {
    relanded: (g: any, base: string, head: string, master?: string) => boolean;
    wasteItems: (input: any, now: string) => any[];
  };
};

interface Scenario {
  dir: string;
  g: any;
  base: Record<"A" | "B" | "C" | "D", string>;
  head: Record<"A" | "B" | "C" | "D", string>;
  cleanup(): void;
}

const commitFile = (dir: string, file: string, text: string, msg: string): string => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-q", "-m", msg]);
  return run(dir, ["rev-parse", "HEAD"]).trim();
};

/** A Git over `dir` backed by the real `git patch-id --stable`. */
const makeGit = (dir: string) => ({
  lines: (args: string[]) => run(dir, args).split("\n").filter(Boolean),
  patchId: (commit: string) => {
    const diff = run(dir, ["show", "--format=", commit]);
    return execFileSync("git", ["patch-id", "--stable"], {
      cwd: dir,
      input: diff,
      encoding: "utf8",
    }).split(/\s+/)[0];
  },
  patchIdOfDiff: (base: string, head: string) => {
    const diff = run(dir, ["diff", base, head]);
    return execFileSync("git", ["patch-id", "--stable"], {
      cwd: dir,
      input: diff,
      encoding: "utf8",
    }).split(/\s+/)[0];
  },
});

/**
 * master: c0 -> m1 -> [cherry-pick of A1] -> m2 -> [squash of B1+B2] -> tip   (+ origin/master ref)
 *   PR-A: one commit A1 off c0, cherry-picked onto master      -> patch-id match on a commit
 *   PR-B: two commits B1, B2 off c0, squashed into ONE master commit -> only the range patch-id matches
 *   PR-C: one commit off master tip, never landed               -> not re-landed
 *   PR-D: two commits; only D1 cherry-picked                    -> re-landed (any commit matches)
 */
const build = (): Scenario => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-wp5-"));
  run(dir, ["init", "-q", "--initial-branch=master"]);
  const c0 = commitFile(dir, "a.txt", "l1\nl2\nl3\nl4\n", "c0");
  commitFile(dir, "readme.txt", "acme\n", "seed readme");
  const baseAB = run(dir, ["rev-parse", "HEAD"]).trim();

  // PR-A branch
  run(dir, ["checkout", "-q", "-b", "pr-a", baseAB]);
  const a1 = commitFile(dir, "a.txt", "l1\nl2\nl3\nl4\nA1\n", "A1");
  // PR-B branch
  run(dir, ["checkout", "-q", "-b", "pr-b", baseAB]);
  commitFile(dir, "b.txt", "b1\n", "B1");
  const b2 = commitFile(dir, "b.txt", "b1\nb2\n", "B2");
  // PR-D branch
  run(dir, ["checkout", "-q", "-b", "pr-d", baseAB]);
  const d1 = commitFile(dir, "d.txt", "d1\n", "D1");
  const d2 = commitFile(dir, "d.txt", "d1\nd2\n", "D2");

  // master moves on, then takes A1 by cherry-pick, B by squash, D1 by cherry-pick
  run(dir, ["checkout", "-q", "master"]);
  commitFile(dir, "unrelated.txt", "m1\n", "m1");
  run(dir, ["cherry-pick", a1]);
  commitFile(dir, "unrelated.txt", "m1\nm2\n", "m2");
  run(dir, ["merge", "--squash", "pr-b"]);
  run(dir, ["commit", "-q", "-m", "squash: B"]);
  run(dir, ["cherry-pick", d1]);
  const tip = commitFile(dir, "unrelated.txt", "m1\nm2\nm3\n", "tip");

  // PR-C branch (off the tip, never landed)
  run(dir, ["checkout", "-q", "-b", "pr-c", tip]);
  const c1 = commitFile(dir, "c.txt", "c1\n", "C1");
  run(dir, ["checkout", "-q", "master"]);
  run(dir, ["update-ref", "refs/remotes/origin/master", "master"]);
  void c0;
  return {
    dir,
    g: makeGit(dir),
    base: { A: baseAB, B: baseAB, C: tip, D: baseAB },
    head: { A: a1, B: b2, C: c1, D: d2 },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

let sc: Scenario;
beforeAll(() => {
  sc = build();
});
afterAll(() => sc.cleanup());

describe("the temp repo itself (A17: the fixture is the check)", () => {
  it("cherry-pick keeps the patch-id, a squash keeps the RANGE patch-id, an unlanded commit matches nothing", () => {
    const { g } = sc;
    const onMaster = new Set(
      g
        .lines(["log", "--format=%H", "-n", "2000", "origin/master"])
        .map((h: string) => g.patchId(h)),
    );
    expect(onMaster.has(g.patchId(sc.head.A))).toBe(true);
    expect(onMaster.has(g.patchId(sc.head.B))).toBe(false); // B2 alone is not on master
    expect(onMaster.has(g.patchIdOfDiff(sc.base.B, sc.head.B))).toBe(true);
    expect(onMaster.has(g.patchId(sc.head.C))).toBe(false);
    expect(onMaster.has(g.patchIdOfDiff(sc.base.C, sc.head.C))).toBe(false);
  });
});

describe("relanded() (build-plan WP5, A17)", () => {
  it("PR-A: a commit cherry-picked to master (same patch-id) -> re-landed", () => {
    const { relanded } = need();
    expect(relanded(sc.g, sc.base.A, sc.head.A)).toBe(true);
  });

  it("PR-B: two commits squashed into one master commit (range patch-id) -> re-landed", () => {
    const { relanded } = need();
    expect(relanded(sc.g, sc.base.B, sc.head.B)).toBe(true);
  });

  it("PR-C: nothing landed -> not re-landed", () => {
    const { relanded } = need();
    expect(relanded(sc.g, sc.base.C, sc.head.C)).toBe(false);
  });

  it("PR-D: only the first of two commits landed -> re-landed (any matching commit counts)", () => {
    const { relanded } = need();
    expect(relanded(sc.g, sc.base.D, sc.head.D)).toBe(true);
  });

  it("master defaults to origin/master and can be named explicitly", () => {
    const { relanded } = need();
    expect(relanded(sc.g, sc.base.A, sc.head.A, "master")).toBe(true);
    expect(relanded(sc.g, sc.base.C, sc.head.C, "master")).toBe(false);
    expect(relanded(sc.g, sc.base.A, sc.head.A, "origin/master")).toBe(true);
  });

  it("only looks at base..head (commits of the base side do not count as the PR's own)", () => {
    const { relanded } = need();
    // base = head of PR-C, head = head of PR-C: an empty range is not 'landed'
    expect(relanded(sc.g, sc.head.C, sc.head.C)).toBe(false);
  });
});

describe("W5 through wasteItems (T49)", () => {
  const closedPR = (pr: number, key: "A" | "B" | "C" | "D", o: Record<string, any> = {}) => ({
    pr,
    title: `acme: closed ${key}`,
    state: "closed",
    headSha: sc.head[key],
    headRef: `pr-${key.toLowerCase()}`,
    baseRef: "master",
    mergeSha: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    mergedAt: null,
    closedAt: "2026-01-04T00:00:00Z",
    headCommittedAt: "2026-01-04T00:00:00Z",
    lane: "lane-u",
    links: { task: null, bug: null, feature: null, defers: null, issue: null },
    ci: "none",
    ciSince: null,
    review: "none",
    mergeable: "unknown",
    files: 1,
    filePaths: ["x.ts"],
    areas: [],
    body: "",
    bookkeepingPending: false,
    deployed: false,
    ...o,
  });
  const w5 = (prs: any[], superseded: Record<string, any> = {}) => {
    const { relanded, wasteItems } = need();
    const baseOf: Record<number, string> = Object.fromEntries(
      prs.map((p) => [p.pr, sc.base[p.headRef.slice(-1).toUpperCase() as "A"]]),
    );
    return wasteItems(
      {
        prs,
        branches: [],
        tasks: [],
        acks: {},
        superseded,
        relanded: (p: any) => relanded(sc.g, baseOf[p.pr], p.headSha),
      },
      NOW,
    ).filter((i) => i.rule === "W5");
  };

  it("PR-A (cherry-picked) and PR-B (squashed) are not waste; PR-C (nothing landed) is W5", () => {
    const items = w5([closedPR(1, "A"), closedPR(2, "B"), closedPR(3, "C")]);
    expect(items).toHaveLength(1);
    expect(items[0].subject).toContain("3");
    expect(items[0].key.endsWith(`:${sc.head.C}`)).toBe(true);
    expect(items[0].since).toBe("2026-01-04T00:00:00Z");
  });

  it("PR-C plus a `pr.superseded` event for it is not waste", () => {
    const items = w5([closedPR(3, "C")], { "3": { by: 9, why: null, ref: "lead#5" } });
    expect(items).toEqual([]);
  });

  it("PR-C whose body says `Superseded by #n` is not waste either", () => {
    const items = w5([closedPR(3, "C", { body: "Closing.\n\nSuperseded by #9\n" })]);
    expect(items).toEqual([]);
  });

  it("a supersede event for a DIFFERENT PR does not hide PR-C", () => {
    const items = w5([closedPR(3, "C")], { "4": { by: 9, why: null, ref: "lead#5" } });
    expect(items).toHaveLength(1);
  });

  it("a merged PR is never W5, and an open PR is never W5", () => {
    const merged = {
      ...closedPR(5, "C"),
      state: "merged",
      mergeSha: "f".repeat(40),
      mergedAt: "2026-01-04T00:00:00Z",
    };
    const open = { ...closedPR(6, "C"), state: "open", closedAt: null };
    expect(w5([merged, open])).toEqual([]);
  });
});
