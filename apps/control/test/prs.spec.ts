/**
 * T42, T43 (R22) + the ledger rules of spec §5.5 — `src/domain/trailers.ts` and `src/domain/prs.ts`.
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   trailers.ts
 *     links(body, branch) -> { task, bug, feature, defers, lane, issue }   (build-plan WP5, verbatim)
 *   prs.ts  (pure: plain objects in, plain objects out; never mutate an input)
 *     normalizePRs(rawNodes, ctx) -> PR[]   sorted by `pr` ascending
 *       rawNodes = GraphQL-shaped PR nodes (fixtures/acme/github/prs.json); the head commit carries
 *                  commits.nodes[0].commit.{committedDate,message,statusCheckRollup{state}}
 *       ctx = { now, files: Record<prNumber, {path,additions,deletions}[]>,
 *               taskLane(id) -> laneId|null, deploy(mergeSha) -> {deployed: true|false|"unknown", deployedAt?} }
 *       PR = the §5.5 row fields {pr, state, headSha, mergeSha, lane, links{task,bug,feature,defers,issue},
 *            ci, review, mergeable, files: n, areas[], deployed, deployedAt?} PLUS the fields waste needs:
 *            title, headRef, baseRef, createdAt, updatedAt, mergedAt, closedAt, headCommittedAt,
 *            filePaths[], body, bookkeepingPending
 *       state: draft | merged | closed | ready (open, non-draft, approved + green + clean) | open (the rest)
 *       ci: SUCCESS->green, FAILURE|ERROR->red, PENDING|EXPECTED->pending, no rollup->none
 *       review: APPROVED->approved, CHANGES_REQUESTED->changes, REVIEW_REQUIRED->required, null->none
 *       mergeable: MERGEABLE->clean, CONFLICTING->conflicting, UNKNOWN->unknown
 *       areas = sorted unique top-level directory of each file
 *       links/lane read the PR body AND the head commit message; lane precedence (§5.4):
 *         Lane: trailer > linked task's lane (task, then bug, then feature) > "unattributed"
 *     ledgerRows(prevRows, prs, at) -> LedgerRow[]   NEW rows only, for PRs whose §5.5 fields changed
 *       versus the last row of that PR (`at` is not compared); input rows are never mutated
 *     ciSince(rows, pr) -> ISO | null   `at` of the first row of the trailing run with the PR's current ci
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
const trailers = tryRequire(() => require("../src/domain/trailers"));
const prsMod = tryRequire(() => require("../src/domain/prs"));

const links = (b: string, br: string): any => {
  expect(trailers).toBeDefined();
  expect(typeof trailers.links).toBe("function");
  return trailers.links(b, br);
};
const need = () => {
  expect(prsMod).toBeDefined();
  expect(typeof prsMod.normalizePRs).toBe("function");
  expect(typeof prsMod.ledgerRows).toBe("function");
  return prsMod as {
    normalizePRs: (raw: any[], ctx: any) => any[];
    ledgerRows: (prev: any[], prs: any[], at: string) => any[];
    ciSince: (rows: any[], pr: number) => string | null;
  };
};

const FX = path.join(__dirname, "fixtures", "acme", "github");
const readJson = (f: string): any => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const RAW: any[] = readJson("prs.json");
const FILES: Record<string, any[]> = readJson("prs-files.json");
const sha = (n: number, key: "headRefOid" | "mergeCommit"): string => {
  const p = RAW.find((x) => x.number === n);
  return key === "headRefOid" ? p.headRefOid : p.mergeCommit.oid;
};

const TASK_LANE: Record<string, string | null> = {
  "RF-2": "lane-u",
  B905: "lane-b",
  "F-05": "lane-u",
  "RF-1": null,
};
const M304 = sha(304, "mergeCommit");
const ctx = () => ({
  now: NOW,
  files: FILES,
  taskLane: (id: string) => TASK_LANE[id] ?? null,
  deploy: (m: string) =>
    m === M304
      ? { deployed: true, deployedAt: "2026-01-07T10:40:00Z" }
      : m === sha(309, "mergeCommit")
        ? { deployed: "unknown" }
        : { deployed: false },
});

const linkKeys = (l: any) => ({
  task: l.task,
  bug: l.bug,
  feature: l.feature,
  defers: l.defers,
  issue: l.issue,
});
const NONE = { task: null, bug: null, feature: null, defers: null };
const issueNo = (v: unknown) => (v == null ? null : Number(String(v).replace("#", "")));

describe("T43 links(): trailer precedence (spec 5.4, build-plan WP5 verbatim)", () => {
  it("reads every trailer key from the body", () => {
    const l = links(
      "Task: RF-2\nBug: B905\nFeature: F-05\nDefers: D-11\nLane: r-ui\nCloses: #2775\n",
      "chore/nothing",
    );
    expect(l.task).toBe("RF-2");
    expect(l.bug).toBe("B905");
    expect(l.feature).toBe("F-05");
    expect(l.defers).toBe("D-11");
    expect(l.lane).toBe("r-ui");
    expect(issueNo(l.issue)).toBe(2775);
  });

  it("body trailers beat branch tokens", () => {
    const l = links("Task: RF-2\nBug: B905\n", "feat/RF-7-x-B12-F-99");
    expect(l.task).toBe("RF-2");
    expect(l.bug).toBe("B905");
    expect(l.feature).toBe("F-99"); // no Feature: trailer, so the branch fills it
  });

  it("branch tokens fill what no trailer names", () => {
    expect(links("", "fix/B905-pdf-date")).toMatchObject({ task: null, bug: "B905" });
    expect(links("", "feat/RF-231-dates")).toMatchObject({ task: "RF-231", bug: null });
    expect(links("", "feat/F-05-route-export")).toMatchObject({ feature: "F-05" });
  });

  it("with neither trailer nor branch token every link is null", () => {
    const l = links("just prose, no trailers", "chore/cleanup");
    expect(linkKeys(l)).toEqual({ ...NONE, issue: null });
    expect(l.lane).toBeNull();
  });

  it("first occurrence of a key wins", () => {
    expect(links("Task: RF-1\nTask: RF-2\n", "x").task).toBe("RF-1");
  });

  it("only line-anchored trailers count (prose containing the word does not)", () => {
    expect(links("see Task: RF-9 for context", "x").task).toBeNull();
    expect(links("Task: RF-9 and more words", "x").task).toBeNull();
  });

  it("tolerates CRLF bodies and trailing whitespace (GitHub bodies are CRLF)", () => {
    const l = links("Task: RF-2   \r\nBug: B905\r\n", "x");
    expect(l.task).toBe("RF-2");
    expect(l.bug).toBe("B905");
  });

  it("branch bug token is 1-4 digits on a word boundary only", () => {
    expect(links("", "fix/B12345-too-long").bug).toBeNull();
    expect(links("", "fix/B1234-ok").bug).toBe("B1234");
    expect(links("", "feat/ROB12-not-a-bug").bug).toBeNull();
  });

  it("spec 5.4 also lists the GitHub keyword form `Closes #n` (no colon)", () => {
    expect(issueNo(links("Closes #2775\n", "x").issue)).toBe(2775);
  });
});

describe("T42 normalizePRs(): ledger rows for the recorded fixture (9 PRs)", () => {
  const pick = (r: any) => ({
    pr: r.pr,
    state: r.state,
    headSha: r.headSha,
    mergeSha: r.mergeSha ?? null,
    lane: r.lane,
    links: linkKeys(r.links),
    ci: r.ci,
    review: r.review,
    mergeable: r.mergeable,
    files: r.files,
    areas: r.areas,
    deployed: r.deployed,
  });
  const EXPECTED = [
    {
      pr: 301,
      state: "ready",
      headSha: sha(301, "headRefOid"),
      mergeSha: null,
      lane: "lane-u",
      links: { ...NONE, task: "RF-2", issue: null },
      ci: "green",
      review: "approved",
      mergeable: "clean",
      files: 3,
      areas: ["apps", "packages"],
      deployed: false,
    },
    {
      pr: 302,
      state: "draft",
      headSha: sha(302, "headRefOid"),
      mergeSha: null,
      lane: "lane-b",
      links: { ...NONE, bug: "B905", issue: null },
      ci: "pending",
      review: "none",
      mergeable: "unknown",
      files: 1,
      areas: ["apps"],
      deployed: false,
    },
    {
      pr: 303,
      state: "open",
      headSha: sha(303, "headRefOid"),
      mergeSha: null,
      lane: "unattributed",
      links: { ...NONE, issue: null },
      ci: "red",
      review: "changes",
      mergeable: "conflicting",
      files: 2,
      areas: ["apps"],
      deployed: false,
    },
    {
      pr: 304,
      state: "merged",
      headSha: sha(304, "headRefOid"),
      mergeSha: M304,
      lane: "r-ui",
      links: { ...NONE, feature: "F-05", issue: 2775 },
      ci: "green",
      review: "approved",
      mergeable: "clean",
      files: 2,
      areas: ["apps", "packages"],
      deployed: true,
    },
    {
      pr: 305,
      state: "closed",
      headSha: sha(305, "headRefOid"),
      mergeSha: null,
      lane: "unattributed",
      links: { ...NONE, issue: null },
      ci: "red",
      review: "none",
      mergeable: "unknown",
      files: 1,
      areas: ["apps"],
      deployed: false,
    },
    {
      pr: 306,
      state: "merged",
      headSha: sha(306, "headRefOid"),
      mergeSha: sha(306, "mergeCommit"),
      lane: "unattributed",
      links: { ...NONE, task: "RF-1", issue: null },
      ci: "green",
      review: "approved",
      mergeable: "clean",
      files: 1,
      areas: [".claude"],
      deployed: false,
    },
    {
      pr: 307,
      state: "open",
      headSha: sha(307, "headRefOid"),
      mergeSha: null,
      lane: "lane-x",
      links: { ...NONE, task: "RF-2", bug: "B905", issue: null },
      ci: "pending",
      review: "none",
      mergeable: "clean",
      files: 1,
      areas: ["apps"],
      deployed: false,
    },
    {
      pr: 308,
      state: "open",
      headSha: sha(308, "headRefOid"),
      mergeSha: null,
      lane: "unattributed",
      links: { ...NONE, issue: null },
      ci: "none",
      review: "required",
      mergeable: "clean",
      files: 0,
      areas: [],
      deployed: false,
    },
    {
      pr: 309,
      state: "merged",
      headSha: sha(309, "headRefOid"),
      mergeSha: sha(309, "mergeCommit"),
      lane: "unattributed",
      links: { ...NONE, defers: "D-11", issue: null },
      ci: "green",
      review: "approved",
      mergeable: "clean",
      files: 1,
      areas: ["apps"],
      deployed: "unknown",
    },
  ];

  it("matches the hand-written expected rows (state, ci, review, mergeable, links, lane, files, areas)", () => {
    const { normalizePRs } = need();
    const rows = normalizePRs(RAW, ctx());
    expect(
      rows.map(pick).map((r) => ({ ...r, links: { ...r.links, issue: issueNo(r.links.issue) } })),
    ).toEqual(EXPECTED);
  });

  it("is sorted by PR number regardless of input order and never mutates its input", () => {
    const { normalizePRs } = need();
    const input = JSON.parse(JSON.stringify(RAW)).reverse();
    const frozen = JSON.stringify(input);
    const rows = normalizePRs(input, ctx());
    expect(rows.map((r: any) => r.pr)).toEqual([301, 302, 303, 304, 305, 306, 307, 308, 309]);
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("stamps every row with the poll time and carries deployedAt only when deployed", () => {
    const { normalizePRs } = need();
    const rows = normalizePRs(RAW, ctx());
    for (const r of rows) expect(r.at).toBe(NOW);
    expect(rows.find((r: any) => r.pr === 304).deployedAt).toBe("2026-01-07T10:40:00Z");
    expect(rows.find((r: any) => r.pr === 301).deployedAt ?? null).toBeNull();
  });

  it("an open PR is never `ready` unless approved AND green AND clean", () => {
    const { normalizePRs } = need();
    const base = RAW.find((p) => p.number === 301);
    const variant = (over: (n: any) => void) => {
      const n = JSON.parse(JSON.stringify(base));
      over(n);
      return normalizePRs([n], ctx())[0].state;
    };
    expect(variant(() => undefined)).toBe("ready");
    expect(variant((n) => (n.reviewDecision = "REVIEW_REQUIRED"))).toBe("open");
    expect(variant((n) => (n.commits.nodes[0].commit.statusCheckRollup.state = "PENDING"))).toBe(
      "open",
    );
    expect(variant((n) => (n.mergeable = "CONFLICTING"))).toBe("open");
    expect(variant((n) => (n.isDraft = true))).toBe("draft");
  });

  it("trailers in the HEAD commit message count like body trailers", () => {
    const { normalizePRs } = need();
    const n = JSON.parse(JSON.stringify(RAW.find((p) => p.number === 308)));
    n.commits.nodes[0].commit.message = "acme: commit\n\nTask: RF-9\nLane: r-ui";
    const row = normalizePRs([n], ctx())[0];
    expect(row.links.task).toBe("RF-9");
    expect(row.lane).toBe("r-ui");
  });

  it("T43: Lane trailer beats the linked task's lane; task lane beats unattributed", () => {
    const { normalizePRs } = need();
    const rows = normalizePRs(RAW, ctx());
    const lane = (n: number) => rows.find((r: any) => r.pr === n).lane;
    expect(lane(304)).toBe("r-ui"); // body Lane: beats F-05 -> lane-u
    expect(lane(301)).toBe("lane-u"); // no trailer, RF-2 started by lane-u
    expect(lane(302)).toBe("lane-b"); // branch token B905 -> task lane
    expect(lane(303)).toBe("unattributed"); // neither
  });

  it("flags `Bookkeeping-Follow-Up: pending` from the body or head commit, nothing else", () => {
    const { normalizePRs } = need();
    const rows = normalizePRs(RAW, ctx());
    expect(rows.find((r: any) => r.pr === 306).bookkeepingPending).toBe(true);
    expect(rows.find((r: any) => r.pr === 301).bookkeepingPending).toBe(false);
    const n = JSON.parse(JSON.stringify(RAW.find((p) => p.number === 308)));
    n.commits.nodes[0].commit.message = "docs: x\n\nBookkeeping-Follow-Up: pending";
    expect(normalizePRs([n], ctx())[0].bookkeepingPending).toBe(true);
    n.commits.nodes[0].commit.message = "docs: x\n\nBookkeeping-Follow-Up: done";
    expect(normalizePRs([n], ctx())[0].bookkeepingPending).toBe(false);
  });

  it("a missing detail (no files entry, no deploy hook) degrades to 0 files / deployed false, never throws", () => {
    const { normalizePRs } = need();
    const rows = normalizePRs(RAW, { now: NOW, files: {}, taskLane: () => null });
    expect(rows.every((r: any) => r.files === 0 && Array.isArray(r.areas))).toBe(true);
    expect(rows.find((r: any) => r.pr === 304).deployed).toBe(false);
  });
});

describe("ledgerRows(): rows are appended only on change (spec 5.5)", () => {
  const fresh = () => need().normalizePRs(RAW, ctx());
  const first = () => need().ledgerRows([], fresh(), NOW);

  it("an empty ledger gets one row per PR, in PR order", () => {
    const rows = first();
    expect(rows.map((r: any) => r.pr)).toEqual([301, 302, 303, 304, 305, 306, 307, 308, 309]);
    expect(rows.every((r: any) => r.at === NOW)).toBe(true);
  });

  it("an unchanged poll appends nothing", () => {
    const { ledgerRows } = need();
    expect(ledgerRows(first(), fresh(), "2026-01-12T10:00:30Z")).toEqual([]);
  });

  it("fields outside the §5.5 row (updatedAt, title) do not append", () => {
    const { ledgerRows } = need();
    const cur = fresh();
    cur[0].updatedAt = "2026-01-12T09:59:00Z";
    cur[0].title = "acme: renamed";
    expect(ledgerRows(first(), cur, "2026-01-12T10:00:30Z")).toEqual([]);
  });

  it.each([
    ["ci", (p: any) => (p.ci = "red")],
    ["headSha", (p: any) => (p.headSha = "f".repeat(40))],
    ["review", (p: any) => (p.review = "changes")],
    ["mergeable", (p: any) => (p.mergeable = "conflicting")],
    ["state", (p: any) => (p.state = "draft")],
    ["files", (p: any) => (p.files = 99)],
    ["deployed", (p: any) => (p.deployed = true)],
    ["lane", (p: any) => (p.lane = "lane-z")],
  ])("a change of %s appends exactly one row for that PR, with the new value", (field, mutate) => {
    const { ledgerRows } = need();
    const prev = first();
    const cur = fresh();
    const target = cur.find((p: any) => p.pr === 301);
    (mutate as (p: any) => void)(target);
    const added = ledgerRows(prev, cur, "2026-01-12T10:00:30Z");
    expect(added).toHaveLength(1);
    expect(added[0].pr).toBe(301);
    expect(added[0].at).toBe("2026-01-12T10:00:30Z");
    expect(added[0][field as string]).toEqual(target[field as string]);
  });

  it("compares against the LAST row of a PR, not the first (A -> B -> A appends again)", () => {
    const { ledgerRows } = need();
    const a = fresh();
    const rowsA = ledgerRows([], a, "2026-01-12T10:00:00Z");
    const b = fresh();
    b.find((p: any) => p.pr === 301).ci = "red";
    const rowsB = ledgerRows(rowsA, b, "2026-01-12T10:01:00Z");
    expect(rowsB).toHaveLength(1);
    const back = fresh(); // ci green again
    const rowsC = ledgerRows([...rowsA, ...rowsB], back, "2026-01-12T10:02:00Z");
    expect(rowsC).toHaveLength(1);
    expect(rowsC[0].ci).toBe("green");
  });

  it("a PR that appears for the first time appends; a PR that vanishes from the poll appends nothing", () => {
    const { ledgerRows } = need();
    const prev = first();
    const cur = fresh().filter((p: any) => p.pr !== 309);
    expect(ledgerRows(prev, cur, "2026-01-12T10:00:30Z")).toEqual([]);
    const prev2 = ledgerRows(
      [],
      fresh().filter((p: any) => p.pr !== 309),
      NOW,
    );
    const added = ledgerRows(prev2, fresh(), "2026-01-12T10:00:30Z");
    expect(added.map((r: any) => r.pr)).toEqual([309]);
  });

  it("never mutates the previous rows or the current PRs", () => {
    const { ledgerRows } = need();
    const prev = first();
    const cur = fresh();
    cur[0].ci = "red";
    const a = JSON.stringify(prev);
    const b = JSON.stringify(cur);
    ledgerRows(prev, cur, "2026-01-12T10:00:30Z");
    expect(JSON.stringify(prev)).toBe(a);
    expect(JSON.stringify(cur)).toBe(b);
  });
});

describe("ciSince(): when did the PR's current ci start (feeds waste W3)", () => {
  const row = (pr: number, at: string, ci: string) => ({ pr, at, ci });

  it("is the `at` of the first row of the trailing run with the current ci", () => {
    const { ciSince } = need();
    const rows = [
      row(1, "2026-01-01T00:00:00Z", "red"),
      row(1, "2026-01-02T00:00:00Z", "green"),
      row(1, "2026-01-03T00:00:00Z", "red"),
      row(2, "2026-01-03T12:00:00Z", "red"),
    ];
    expect(ciSince(rows, 1)).toBe("2026-01-03T00:00:00Z");
    expect(ciSince(rows, 2)).toBe("2026-01-03T12:00:00Z");
  });

  it("is null for a PR with no rows", () => {
    const { ciSince } = need();
    expect(ciSince([row(1, "2026-01-01T00:00:00Z", "red")], 9)).toBeNull();
  });
});
