/**
 * T48, T50 (R23) — waste rules W1-W4 and W6-W10 (spec 5.8), thresholds at -1 / 0 / +1 minute, and
 * the `waste.ack` suppression. `src/domain/waste.ts`. (W5 is in waste-relanded.spec.ts; its
 * predicate is injected here.)
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   wasteItems(input, now) -> WasteItem[]      pure, deterministic, never mutates `input`
 *     input = { prs: PR[], branches: Branch[], tasks: WasteTask[],
 *               acks: Record<key, {key, until, why, ref}>, superseded: Record<prNumber, {by, why, ref}>,
 *               relanded?: (pr: PR) => boolean }
 *     PR     = the normalized record of prs.spec.ts, plus `ciSince` (ISO|null, from ciSince()),
 *              `deployFailed?: boolean`, `commitMessages?: string[]`
 *     Branch = { name, oid, committedDate, ahead }
 *     WasteTask = { id, status: {value, source, ref}, doneAt: ISO|null }
 *     WasteItem = { key, rule, subject, why, action, since }
 *       key = `${rule}:${subject}:${headSha | mergeSha | branch oid}`
 *   Thresholds fire only when STRICTLY greater than the threshold (spec 5.8; coordinator ruling): idle 3 d, draft
 *   5 d, CI red 24 h, no check run 2 h, orphan branch 2 d, undeployed 2 h, bookkeeping 24 h, done 24 h.
 *   Severity order: (W4 W3 W5 W7 W7b) > (W1 W2 W6 W8) > (W9 W10), then age (now - since) descending.
 */
import * as fs from "fs";
import * as path from "path";
import { NOW } from "./helpers/clock";

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
  expect(typeof mod.wasteItems).toBe("function");
  return mod.wasteItems as (input: any, now: string) => any[];
};

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const hex = (c: string) => c.repeat(40);

let seq = 0;
/** A PR that triggers nothing: open, fresh, green, clean, one file, attributed. */
const mkPR = (o: Record<string, any> = {}): any => {
  const n = o.pr ?? 100 + ++seq;
  return {
    pr: n,
    title: `acme: change ${n}`,
    state: "open",
    headSha: hex("a"),
    headRef: `feat/x-${n}`,
    baseRef: "master",
    mergeSha: null,
    createdAt: ago(H),
    updatedAt: ago(H),
    mergedAt: null,
    closedAt: null,
    headCommittedAt: ago(H),
    lane: "lane-u",
    links: { task: "RF-1", bug: null, feature: null, defers: null, issue: null },
    ci: "green",
    ciSince: ago(H),
    review: "none",
    mergeable: "clean",
    files: 1,
    filePaths: [`apps/api/src/file-${n}.ts`],
    areas: ["apps"],
    body: "",
    bookkeepingPending: false,
    deployed: false,
    deployFailed: false,
    ...o,
  };
};
const mkMerged = (o: Record<string, any> = {}) => {
  const n = o.pr ?? 500 + ++seq;
  return mkPR({
    pr: n,
    state: "merged",
    mergeSha: "b7c1d2e3f4a5968778695a4b3c2d1e0f9a8b7c6d",
    mergedAt: ago(H),
    closedAt: ago(H),
    deployed: true,
    ...o,
  });
};
const mkClosed = (o: Record<string, any> = {}) =>
  mkPR({ state: "closed", closedAt: ago(10 * D), updatedAt: ago(10 * D), ci: "none", ...o });
const mkBranch = (o: Record<string, any> = {}) => ({
  name: "feat/orphan-y",
  oid: hex("c"),
  committedDate: ago(H),
  ahead: 1,
  ...o,
});
const mkTask = (id: string, o: Record<string, any> = {}) => ({
  id,
  status: { value: "in-progress", source: "reported", ref: "lane-u#1" },
  doneAt: null,
  ...o,
});
const run = (over: Record<string, any> = {}, now = NOW) =>
  need()({ prs: [], branches: [], tasks: [], acks: {}, superseded: {}, ...over }, now);
const ofRule = (items: any[], rule: string) => items.filter((i) => i.rule === rule);

/** threshold-1 / threshold / threshold+1: strictly greater than (spec 5.8): silent, silent, fires. */
const boundary = (
  name: string,
  rule: string,
  threshold: number,
  build: (ageMs: number) => Record<string, any>,
) => {
  it(`${name}: silent at threshold-1 min, silent at exactly threshold, fires at threshold+1 min`, () => {
    expect(ofRule(run(build(threshold - MIN)), rule)).toHaveLength(0);
    expect(ofRule(run(build(threshold)), rule)).toHaveLength(0);
    expect(ofRule(run(build(threshold + MIN)), rule)).toHaveLength(1);
  });
};

beforeEach(() => {
  seq = 0;
});

describe("baseline", () => {
  it("a healthy PR, a fresh branch and a finished task flag nothing (false positives kill the panel)", () => {
    const items = run({
      prs: [
        mkPR(),
        mkMerged({ links: { task: "RF-2", bug: null, feature: null, defers: null, issue: null } }),
      ],
      branches: [mkBranch()],
      tasks: [
        mkTask("RF-2", { status: { value: "code-complete", source: "inferred", ref: "#500" } }),
      ],
    });
    expect(items).toEqual([]);
  });

  it("every item carries key, rule, subject, why, action and since as non-empty strings", () => {
    const items = run({
      prs: [
        mkPR({ pr: 11, mergeable: "conflicting" }),
        mkPR({ pr: 12, updatedAt: ago(4 * D) }),
        mkMerged({
          pr: 13,
          links: { task: null, bug: null, feature: null, defers: null, issue: null },
          lane: "unattributed",
        }),
      ],
    });
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const i of items) {
      for (const k of ["key", "rule", "subject", "why", "action", "since"]) {
        expect(typeof i[k]).toBe("string");
        expect(i[k].length).toBeGreaterThan(0);
      }
      expect(i.key.startsWith(`${i.rule}:${i.subject}:`)).toBe(true);
    }
  });

  it("never mutates its input and ignores input order", () => {
    const input = {
      prs: [mkPR({ pr: 21, mergeable: "conflicting" }), mkPR({ pr: 22, updatedAt: ago(5 * D) })],
      branches: [mkBranch({ committedDate: ago(3 * D) })],
      tasks: [],
      acks: {},
      superseded: {},
    };
    const snap = JSON.stringify(input);
    const a = need()(input, NOW);
    expect(JSON.stringify(input)).toBe(snap);
    const rev = { ...input, prs: [...input.prs].reverse() };
    expect(need()(rev, NOW)).toEqual(a);
  });
});

describe("W1 idle PR (open, non-draft, no activity for 3 d)", () => {
  boundary("updatedAt", "W1", 3 * D, (age) => ({ prs: [mkPR({ updatedAt: ago(age) })] }));

  it("a `ready` PR idles too; `since` is the last activity and key ends with the head sha", () => {
    const upd = ago(4 * D);
    const items = ofRule(
      run({ prs: [mkPR({ state: "ready", updatedAt: upd, headSha: hex("d") })] }),
      "W1",
    );
    expect(items).toHaveLength(1);
    expect(items[0].since).toBe(upd);
    expect(items[0].key.endsWith(`:${hex("d")}`)).toBe(true);
  });

  it("a draft idle for 4 d is not W1 (drafts are W2's) and a merged/closed PR is never idle", () => {
    const items = run({
      prs: [
        mkPR({ state: "draft", updatedAt: ago(4 * D) }),
        mkMerged({ updatedAt: ago(30 * D) }),
        mkClosed({ updatedAt: ago(30 * D), body: "Superseded by #9" }),
      ],
    });
    expect(ofRule(items, "W1")).toHaveLength(0);
  });
});

describe("W2 stale draft (draft for 5 d, never marked ready)", () => {
  boundary("createdAt", "W2", 5 * D, (age) => ({
    prs: [mkPR({ state: "draft", createdAt: ago(age) })],
  }));

  it("a non-draft PR that is 6 d old is not W2", () => {
    expect(ofRule(run({ prs: [mkPR({ createdAt: ago(6 * D) })] }), "W2")).toHaveLength(0);
  });
});

describe("W3 red or stale CI", () => {
  boundary("red for 24 h (ciSince)", "W3", 24 * H, (age) => ({
    prs: [mkPR({ ci: "red", ciSince: ago(age) })],
  }));
  boundary("no check run on the head for 2 h (headCommittedAt)", "W3", 2 * H, (age) => ({
    prs: [mkPR({ ci: "none", ciSince: ago(age), headCommittedAt: ago(age) })],
  }));

  it("green, and pending CI, never fire however old the head is", () => {
    const items = run({
      prs: [
        mkPR({ ci: "green", ciSince: ago(9 * D), headCommittedAt: ago(9 * D) }),
        mkPR({ ci: "pending", ciSince: ago(9 * D), headCommittedAt: ago(9 * D) }),
      ],
    });
    expect(ofRule(items, "W3")).toHaveLength(0);
  });

  it("a merged or closed PR with a red rollup is not flagged", () => {
    const items = run({
      prs: [
        mkMerged({ ci: "red", ciSince: ago(9 * D) }),
        mkClosed({ ci: "red", ciSince: ago(9 * D), body: "Superseded by #2" }),
        mkClosed({ ci: "none", headCommittedAt: ago(9 * D), body: "Superseded by #2" }),
      ],
    });
    expect(ofRule(items, "W3")).toHaveLength(0);
  });
});

describe("W4 conflicting", () => {
  it("fires on an open PR with mergeable = conflicting; silent for clean / unknown / merged / closed", () => {
    const items = run({
      prs: [
        mkPR({ pr: 31, mergeable: "conflicting" }),
        mkPR({ pr: 32, mergeable: "clean" }),
        mkPR({ pr: 33, mergeable: "unknown" }),
        mkMerged({ pr: 34, mergeable: "conflicting" }),
        mkClosed({ pr: 35, mergeable: "conflicting", body: "Superseded by #31" }),
      ],
    });
    const w4 = ofRule(items, "W4");
    expect(w4).toHaveLength(1);
    expect(w4[0].subject).toContain("31");
    expect(w4[0].key.endsWith(`:${hex("a")}`)).toBe(true);
  });
});

describe("W6 orphan branch (ahead of master, no open/merged PR, last push 2 d)", () => {
  boundary("committedDate", "W6", 2 * D, (age) => ({
    branches: [mkBranch({ committedDate: ago(age) })],
  }));

  it("not ahead of master, or covered by an open/merged PR, is not an orphan", () => {
    const old = ago(10 * D);
    const items = run({
      prs: [mkPR({ headRef: "feat/has-open" }), mkMerged({ headRef: "feat/has-merged" })],
      branches: [
        mkBranch({ name: "feat/not-ahead", ahead: 0, committedDate: old }),
        mkBranch({ name: "feat/has-open", committedDate: old }),
        mkBranch({ name: "feat/has-merged", committedDate: old }),
      ],
    });
    expect(ofRule(items, "W6")).toHaveLength(0);
  });

  it("a closed-UNMERGED PR does not exempt its branch (only open/merged do)", () => {
    const items = run({
      prs: [mkClosed({ headRef: "feat/was-closed", body: "Superseded by #1" })],
      branches: [mkBranch({ name: "feat/was-closed", committedDate: ago(10 * D) })],
    });
    expect(ofRule(items, "W6")).toHaveLength(1);
  });

  it("the ctl/* state branches are never code branches (they are hugely 'ahead' of master)", () => {
    const items = run({
      branches: [
        mkBranch({ name: "ctl/state", ahead: 412, committedDate: ago(30 * D) }),
        mkBranch({ name: "ctl/archive", ahead: 88, committedDate: ago(30 * D) }),
        mkBranch({ name: "master", ahead: 0, committedDate: ago(30 * D) }),
      ],
    });
    expect(ofRule(items, "W6")).toEqual([]);
  });

  it("over the recorded branches fixture: only the stale orphan and the closed-PR branch fire", () => {
    const branches = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "acme", "github", "branches.json"), "utf8"),
    );
    const byName = Object.fromEntries(branches.map((b: any) => [b.name, b]));
    const items = run({
      prs: [
        mkPR({ headRef: "feat/RF-2-invoice-dates" }),
        mkMerged({ headRef: "feat/F-05-route-export" }),
        mkClosed({ headRef: "spike/old-idea", body: "Superseded by #9" }),
      ],
      branches,
    });
    const w6 = ofRule(items, "W6");
    expect(w6).toHaveLength(2);
    for (const name of ["spike/old-idea", "feat/orphan-x"]) {
      const item = w6.find((i) => i.subject.includes(name));
      expect(item).toBeDefined();
      expect(item.key.endsWith(`:${byName[name].oid}`)).toBe(true);
    }
    expect(w6.some((i) => i.subject.includes("fresh/just-pushed"))).toBe(false);
    expect(w6.some((i) => i.subject.includes("ctl/state"))).toBe(false);
  });
});

describe("W7 merged, not deployed (merged 2 h ago, api AND web not on the deployed commit, or a deploy FAILED)", () => {
  boundary("mergedAt", "W7", 2 * H, (age) => ({
    prs: [mkMerged({ mergedAt: ago(age), deployed: false })],
  }));

  it("deployed true is silent; deployed 'unknown' (probe failed) is silent, never a guess", () => {
    const items = run({
      prs: [
        mkMerged({ mergedAt: ago(9 * D), deployed: true }),
        mkMerged({ mergedAt: ago(9 * D), deployed: "unknown" }),
      ],
    });
    expect(ofRule(items, "W7")).toHaveLength(0);
  });

  it("a FAILED deploy fires (merged 3 h ago) and the key ends with the merge sha", () => {
    const m = "e".repeat(40);
    const items = ofRule(
      run({
        prs: [
          mkMerged({ mergedAt: ago(3 * H), mergeSha: m, deployed: "unknown", deployFailed: true }),
        ],
      }),
      "W7",
    );
    expect(items).toHaveLength(1);
    expect(items[0].key.endsWith(`:${m}`)).toBe(true);
  });

  it("an open or closed PR is never W7", () => {
    const items = run({
      prs: [mkPR({ deployed: false }), mkClosed({ deployed: false, body: "Superseded by #2" })],
    });
    expect(ofRule(items, "W7")).toHaveLength(0);
  });
});

describe("W7b bookkeeping pending (no follow-up PR citing the merge sha within 24 h)", () => {
  const M = "1234567" + "a".repeat(33);
  boundary("mergedAt", "W7b", 24 * H, (age) => ({
    prs: [mkMerged({ mergedAt: ago(age), mergeSha: M, bookkeepingPending: true })],
  }));

  const pending = () =>
    mkMerged({ pr: 41, mergedAt: ago(30 * H), mergeSha: M, bookkeepingPending: true });

  it("a later PR whose body cites the first 7 chars of the merge sha satisfies it (merged or open)", () => {
    for (const state of ["merged", "open"]) {
      const followUp = mkPR({ pr: 42, state, body: `docs: bookkeeping for ${M.slice(0, 7)}` });
      expect(ofRule(run({ prs: [pending(), followUp] }), "W7b")).toHaveLength(0);
    }
  });

  it("a head-commit citation counts too", () => {
    const followUp = mkPR({ pr: 42, commitMessages: [`docs: follow-up to ${M.slice(0, 7)}`] });
    expect(ofRule(run({ prs: [pending(), followUp] }), "W7b")).toHaveLength(0);
  });

  it("a 6-char prefix is not a citation (7+ required) and an unrelated PR does not help", () => {
    const short = mkPR({ pr: 42, body: `docs for ${M.slice(0, 6)} only` });
    const other = mkPR({ pr: 43, body: "docs for deadbee" });
    expect(ofRule(run({ prs: [pending(), short, other] }), "W7b")).toHaveLength(1);
  });

  it("without the pending trailer there is nothing to follow up", () => {
    const items = run({ prs: [mkMerged({ mergedAt: ago(9 * D), bookkeepingPending: false })] });
    expect(ofRule(items, "W7b")).toHaveLength(0);
  });
});

describe("W8 done without a merged PR (reported code-complete for 24 h)", () => {
  const done = (ageMs: number, o: Record<string, any> = {}) =>
    mkTask("RF-3", {
      status: { value: "code-complete", source: "reported", ref: "lane-u#9" },
      doneAt: ago(ageMs),
      ...o,
    });
  boundary("doneAt", "W8", 24 * H, (age) => ({ tasks: [done(age)] }));

  const link = (o: Record<string, any>) =>
    mkMerged({ links: { task: null, bug: null, feature: null, defers: null, issue: null, ...o } });

  it("a merged PR linking the task (by task, bug or feature id) silences it", () => {
    expect(ofRule(run({ tasks: [done(3 * D)], prs: [link({ task: "RF-3" })] }), "W8")).toHaveLength(
      0,
    );
    const bug = mkTask("B905", {
      status: { value: "code-complete", source: "reported", ref: "lane-b#2" },
      doneAt: ago(3 * D),
    });
    expect(ofRule(run({ tasks: [bug], prs: [link({ bug: "B905" })] }), "W8")).toHaveLength(0);
    const feat = mkTask("F-05", {
      status: { value: "code-complete", source: "reported", ref: "r-ui#2" },
      doneAt: ago(3 * D),
    });
    expect(ofRule(run({ tasks: [feat], prs: [link({ feature: "F-05" })] }), "W8")).toHaveLength(0);
  });

  it("an OPEN or closed-unmerged PR linking it does not satisfy it", () => {
    const open = mkPR({
      links: { task: "RF-3", bug: null, feature: null, defers: null, issue: null },
    });
    expect(ofRule(run({ tasks: [done(3 * D)], prs: [open] }), "W8")).toHaveLength(1);
  });

  it("only REPORTED code-complete is unverified: inferred code-complete, released, in-progress are not W8", () => {
    const items = run({
      tasks: [
        done(9 * D, { status: { value: "code-complete", source: "inferred", ref: "#9" } }),
        done(9 * D, { status: { value: "released", source: "inferred", ref: "#9" } }),
        mkTask("RF-4", { doneAt: ago(9 * D) }),
      ],
    });
    expect(ofRule(items, "W8")).toHaveLength(0);
  });

  it("`since` is when the task was reported done", () => {
    const items = ofRule(run({ tasks: [done(3 * D)] }), "W8");
    expect(items[0].since).toBe(ago(3 * D));
    expect(items[0].subject).toContain("RF-3");
  });
});

describe("W9 orphan PR (merged, no task/bug/feature link, no Lane trailer)", () => {
  const none = { task: null, bug: null, feature: null, defers: null, issue: null };
  it("fires for a merged PR that is unlinked and unattributed", () => {
    const items = run({ prs: [mkMerged({ links: none, lane: "unattributed" })] });
    expect(ofRule(items, "W9")).toHaveLength(1);
  });

  it.each([
    ["a task link", { task: "RF-2" }, "unattributed"],
    ["a bug link", { bug: "B905" }, "unattributed"],
    ["a feature link", { feature: "F-05" }, "unattributed"],
    ["a Lane trailer only", {}, "r-ui"],
  ])("%s is enough to not be an orphan", (_n, l, lane) => {
    const items = run({ prs: [mkMerged({ links: { ...none, ...l }, lane })] });
    expect(ofRule(items, "W9")).toHaveLength(0);
  });

  it("open and closed PRs without links are not W9 (it is about merged work)", () => {
    const items = run({
      prs: [
        mkPR({ links: none, lane: "unattributed" }),
        mkClosed({ links: none, lane: "unattributed", body: "Superseded by #5" }),
      ],
    });
    expect(ofRule(items, "W9")).toHaveLength(0);
  });
});

describe("W10 overlapping PRs (two open PRs from different lanes sharing >= 1 file)", () => {
  const shared = "apps/api/src/invoices/dates.ts";
  it("fires once for a shared file across lanes", () => {
    const items = run({
      prs: [
        mkPR({ pr: 51, lane: "lane-u", filePaths: [shared, "apps/web/a.ts"] }),
        mkPR({ pr: 52, lane: "lane-b", filePaths: ["apps/api/z.ts", shared] }),
      ],
    });
    const w10 = ofRule(items, "W10");
    expect(w10).toHaveLength(1);
    expect(w10[0].subject).toContain("51");
    expect(w10[0].subject).toContain("52");
  });

  it("silent for the same lane, disjoint files, or a merged/closed partner", () => {
    const items = run({
      prs: [
        mkPR({ pr: 51, lane: "lane-u", filePaths: [shared] }),
        mkPR({ pr: 52, lane: "lane-u", filePaths: [shared] }),
        mkPR({ pr: 53, lane: "lane-b", filePaths: ["apps/api/other.ts"] }),
        mkMerged({ pr: 54, lane: "lane-v", filePaths: [shared] }),
        mkClosed({ pr: 55, lane: "lane-w", filePaths: [shared], body: "Superseded by #51" }),
      ],
    });
    expect(ofRule(items, "W10")).toHaveLength(0);
  });
});

describe("T50 waste.ack suppression", () => {
  const conflicting = (sha = hex("a")) => mkPR({ pr: 61, mergeable: "conflicting", headSha: sha });
  const key = (sha: string) =>
    `W4:${ofRule(run({ prs: [conflicting(sha)] }), "W4")[0].subject}:${sha}`;
  const ack = (k: string, until: string | null) => ({
    [k]: { key: k, until, why: "coordinating", ref: "lead#7" },
  });

  it("the unacked item has the documented key", () => {
    expect(ofRule(run({ prs: [conflicting()] }), "W4")[0].key).toBe(key(hex("a")));
  });

  it("an ack with until = now + 1 d hides it", () => {
    const k = key(hex("a"));
    const until = new Date(Date.parse(NOW) + D).toISOString();
    expect(ofRule(run({ prs: [conflicting()], acks: ack(k, until) }), "W4")).toHaveLength(0);
  });

  it("once the clock passes `until` the item is visible again", () => {
    const k = key(hex("a"));
    const until = new Date(Date.parse(NOW) + D).toISOString();
    const later = new Date(Date.parse(until) + MIN).toISOString();
    expect(ofRule(run({ prs: [conflicting()], acks: ack(k, until) }, later), "W4")).toHaveLength(1);
  });

  it("an ack with no `until` holds while the sha is unchanged, however old", () => {
    const k = key(hex("a"));
    const far = new Date(Date.parse(NOW) + 400 * D).toISOString();
    expect(ofRule(run({ prs: [conflicting()], acks: ack(k, null) }, far), "W4")).toHaveLength(0);
  });

  it("a new head sha re-surfaces the item even before `until` (the key changes)", () => {
    const old = key(hex("a"));
    const until = new Date(Date.parse(NOW) + D).toISOString();
    const items = ofRule(run({ prs: [conflicting(hex("9"))], acks: ack(old, until) }), "W4");
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(key(hex("9")));
  });

  it("an ack for another key hides nothing", () => {
    const other = ack("W4:pr-999:" + hex("a"), null);
    expect(ofRule(run({ prs: [conflicting()], acks: other }), "W4")).toHaveLength(1);
  });

  it("acking W4 leaves an unrelated rule on the same PR visible", () => {
    const pr = mkPR({ pr: 61, mergeable: "conflicting", updatedAt: ago(4 * D) });
    const k = ofRule(run({ prs: [pr] }), "W4")[0].key;
    const items = run({ prs: [pr], acks: ack(k, null) });
    expect(ofRule(items, "W4")).toHaveLength(0);
    expect(ofRule(items, "W1")).toHaveLength(1);
  });
});

describe("ordering: severity tier, then age descending", () => {
  it("(W4 W3 W5 W7) before (W1 W2 W6 W8) before (W9 W10)", () => {
    const none = { task: null, bug: null, feature: null, defers: null, issue: null };
    const items = run({
      prs: [
        mkMerged({ pr: 71, links: none, lane: "unattributed", mergedAt: ago(9 * D) }), // W9 (and old)
        mkPR({ pr: 72, updatedAt: ago(8 * D) }), // W1
        mkPR({ pr: 73, mergeable: "conflicting", updatedAt: ago(H) }), // W4 (fresh)
      ],
    });
    const tier = (r: string) =>
      ["W4", "W3", "W5", "W7", "W7b"].includes(r)
        ? 0
        : ["W1", "W2", "W6", "W8"].includes(r)
          ? 1
          : 2;
    const tiers = items.map((i) => tier(i.rule));
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(items[0].rule).toBe("W4");
    expect(items[items.length - 1].rule).toBe("W9");
  });

  it("within a rule the oldest item comes first", () => {
    const items = ofRule(
      run({
        prs: [
          mkPR({ pr: 81, updatedAt: ago(4 * D) }),
          mkPR({ pr: 82, updatedAt: ago(9 * D) }),
          mkPR({ pr: 83, updatedAt: ago(6 * D) }),
        ],
      }),
      "W1",
    );
    expect(items.map((i) => Number(i.subject.match(/\d+/)?.[0]))).toEqual([82, 83, 81]);
  });
});
