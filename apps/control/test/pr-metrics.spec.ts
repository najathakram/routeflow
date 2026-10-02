/**
 * Spec 5.5 / 5.9 (coordinator ruling: added to WP5) — PR metrics per release: PR count, lead time
 * open -> merge -> deploy (median, p90) and the closed-unmerged rate. `prMetrics` in src/domain/prs.ts.
 *
 * Contract under test (chosen by the test author; see the WP5 test report):
 *   prMetrics(prs, releases, taskRelease) -> Record<releaseId, Metrics>     pure, never mutates
 *     prs         normalized PR records (prs.spec.ts): {pr, state, createdAt, mergedAt, closedAt,
 *                 deployed: true|false|"unknown", deployedAt?, links{task,bug,feature,...}}
 *     releases    [{id, from: ISO|null, to: ISO|null}]   window = [from, to)  (from inclusive, to exclusive)
 *     taskRelease (taskId) -> releaseId | null           the linked task's release
 *   A PR belongs to a release when its task/bug/feature link resolves to that release, else when
 *   mergedAt (merged) or closedAt (closed unmerged) falls in the window; open/draft PRs count only by link.
 *   Metrics = { merged, closedUnmerged, count, closedUnmergedRate, openToMerge, mergeToDeploy,
 *               openToDeploy }, each leg {median, p90} in MILLISECONDS (null when the series is empty):
 *     count = merged + closedUnmerged; rate = closedUnmerged / count (null when count is 0);
 *     openToMerge over merged PRs; the two deploy legs only over merged PRs with deployed === true.
 *   median / p90 are pinned on series with ties at the quantile so nearest-rank and interpolated
 *   definitions agree.
 */
function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const prsMod = tryRequire(() => require("../src/domain/prs"));
const need = () => {
  expect(prsMod).toBeDefined();
  expect(typeof prsMod.prMetrics).toBe("function");
  return prsMod.prMetrics as (
    prs: any[],
    releases: any[],
    taskRelease: (id: string) => string | null,
  ) => Record<string, any>;
};

const H = 3_600_000;
const T = (iso: string) => Date.parse(iso);
const at = (base: string, hours: number) => new Date(T(base) + hours * H).toISOString();

const R1 = { id: "R1", from: "2026-01-05T00:00:00Z", to: "2026-01-12T00:00:00Z" };
const R2 = { id: "R2", from: "2026-01-12T00:00:00Z", to: null as string | null };
const RELEASES = [R1, R2];
const NOLINK = { task: null, bug: null, feature: null, defers: null, issue: null };

let seq = 0;
const merged = (o: {
  created: string;
  openToMerge: number;
  deployAfter?: number | "unknown";
  links?: any;
  pr?: number;
}) => {
  const mergedAt = at(o.created, o.openToMerge);
  const dep = o.deployAfter;
  return {
    pr: o.pr ?? 1000 + ++seq,
    state: "merged",
    createdAt: o.created,
    mergedAt,
    closedAt: mergedAt,
    deployed: typeof dep === "number" ? true : dep === "unknown" ? "unknown" : false,
    ...(typeof dep === "number" ? { deployedAt: at(mergedAt, dep) } : {}),
    links: { ...NOLINK, ...(o.links ?? {}) },
  };
};
const closed = (o: { created: string; closedAt: string; links?: any }) => ({
  pr: 2000 + ++seq,
  state: "closed",
  createdAt: o.created,
  mergedAt: null,
  closedAt: o.closedAt,
  deployed: false,
  links: { ...NOLINK, ...(o.links ?? {}) },
});
const open = (o: { created: string; links?: any; state?: string }) => ({
  pr: 3000 + ++seq,
  state: o.state ?? "open",
  createdAt: o.created,
  mergedAt: null,
  closedAt: null,
  deployed: false,
  links: { ...NOLINK, ...(o.links ?? {}) },
});
const none = () => null;

beforeEach(() => {
  seq = 0;
});

/**
 * R1 fixture: 8 merged PRs, open->merge hours [1,2,3,4,4,6,8,8]; the first five are deployed with
 * merge->deploy hours [1,1,2,3,3] (pairs: 1+1, 2+1, 3+2, 4+3, 4+3); 2 closed-unmerged.
 */
const r1 = () => {
  const c = "2026-01-06T00:00:00Z";
  const pairs: Array<[number, number | undefined]> = [
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 3],
    [4, 3],
    [6, undefined],
    [8, undefined],
    [8, undefined],
  ];
  return [
    ...pairs.map(([o, dpl]) => merged({ created: c, openToMerge: o, deployAfter: dpl })),
    closed({ created: c, closedAt: "2026-01-07T00:00:00Z" }),
    closed({ created: c, closedAt: "2026-01-08T00:00:00Z" }),
  ];
};

describe("per-release counts and the closed-unmerged rate", () => {
  it("counts merged and closed-unmerged PRs whose date falls in the release window", () => {
    const m = need()(r1(), RELEASES, none)["R1"];
    expect(m.merged).toBe(8);
    expect(m.closedUnmerged).toBe(2);
    expect(m.count).toBe(10);
    expect(m.closedUnmergedRate).toBeCloseTo(0.2, 10);
  });

  it("the other release only sees its own PRs", () => {
    const prs = [...r1(), merged({ created: "2026-01-13T00:00:00Z", openToMerge: 2 })];
    const out = need()(prs, RELEASES, none);
    expect(out["R2"].merged).toBe(1);
    expect(out["R2"].closedUnmerged).toBe(0);
    expect(out["R2"].closedUnmergedRate).toBe(0);
    expect(out["R1"].merged).toBe(8);
  });

  it("window is [from, to): merged exactly at `to` belongs to the next release, exactly at `from` to this one", () => {
    const edge = (mergedAt: string) => ({
      ...merged({ created: "2026-01-04T00:00:00Z", openToMerge: 1 }),
      mergedAt,
      closedAt: mergedAt,
    });
    const out = need()([edge(R1.to), edge(R1.from)], RELEASES, none);
    expect(out["R1"].merged).toBe(1);
    expect(out["R2"].merged).toBe(1);
  });

  it("a PR outside every window and without a link is in no release", () => {
    const out = need()(
      [merged({ created: "2025-12-01T00:00:00Z", openToMerge: 1 })],
      RELEASES,
      none,
    );
    expect(out["R1"].count + out["R2"].count).toBe(0);
  });

  it("a linked task's release attributes the PR even when its dates are outside the window", () => {
    const pr = merged({ created: "2025-12-01T00:00:00Z", openToMerge: 1, links: { task: "RF-2" } });
    const out = need()([pr], RELEASES, (id) => (id === "RF-2" ? "R1" : null));
    expect(out["R1"].merged).toBe(1);
    expect(out["R2"].merged).toBe(0);
  });

  it("bug and feature links resolve through taskRelease too", () => {
    const a = merged({ created: "2025-12-01T00:00:00Z", openToMerge: 1, links: { bug: "B905" } });
    const b = merged({
      created: "2025-12-01T00:00:00Z",
      openToMerge: 1,
      links: { feature: "F-05" },
    });
    const out = need()([a, b], RELEASES, (id) => (id === "B905" || id === "F-05" ? "R2" : null));
    expect(out["R2"].merged).toBe(2);
  });

  it("an open or draft PR does not enter the rate or the lead times", () => {
    const prs = [
      ...r1(),
      open({ created: "2026-01-06T00:00:00Z", links: { task: "RF-2" } }),
      open({ created: "2026-01-06T00:00:00Z", links: { task: "RF-2" }, state: "draft" }),
    ];
    const m = need()(prs, RELEASES, (id) => (id === "RF-2" ? "R1" : null))["R1"];
    expect(m.merged).toBe(8);
    expect(m.closedUnmerged).toBe(2);
    expect(m.closedUnmergedRate).toBeCloseTo(0.2, 10);
    expect(m.openToMerge.median).toBe(4 * H);
  });

  it("every release appears in the result, empty ones with zero counts and null series (never NaN)", () => {
    const out = need()([], RELEASES, none);
    for (const id of ["R1", "R2"]) {
      expect(out[id].count).toBe(0);
      expect(out[id].merged).toBe(0);
      expect(out[id].closedUnmergedRate).toBeNull();
      for (const leg of ["openToMerge", "mergeToDeploy", "openToDeploy"]) {
        expect(out[id][leg].median).toBeNull();
        expect(out[id][leg].p90).toBeNull();
      }
    }
  });

  it("an all-closed release has rate 1 and no lead times", () => {
    const prs = [closed({ created: "2026-01-06T00:00:00Z", closedAt: "2026-01-07T00:00:00Z" })];
    const m = need()(prs, RELEASES, none)["R1"];
    expect(m.closedUnmergedRate).toBe(1);
    expect(m.openToMerge.median).toBeNull();
  });
});

describe("lead time: open -> merge -> deploy (median, p90; milliseconds)", () => {
  it("open -> merge over all 8 merged PRs: median 4 h, p90 8 h", () => {
    const m = need()(r1(), RELEASES, none)["R1"];
    expect(m.openToMerge.median).toBe(4 * H);
    expect(m.openToMerge.p90).toBe(8 * H);
  });

  it("merge -> deploy over the 5 deployed PRs only: median 2 h, p90 3 h", () => {
    const m = need()(r1(), RELEASES, none)["R1"];
    expect(m.mergeToDeploy.median).toBe(2 * H);
    expect(m.mergeToDeploy.p90).toBe(3 * H);
  });

  it("open -> deploy over the deployed PRs: median 5 h, p90 7 h", () => {
    const m = need()(r1(), RELEASES, none)["R1"];
    expect(m.openToDeploy.median).toBe(5 * H);
    expect(m.openToDeploy.p90).toBe(7 * H);
  });

  it("deployed false or 'unknown' PRs are excluded from the deploy legs, not counted as zero", () => {
    const c = "2026-01-06T00:00:00Z";
    const prs = [
      merged({ created: c, openToMerge: 2, deployAfter: 4 }),
      merged({ created: c, openToMerge: 2, deployAfter: "unknown" }),
      merged({ created: c, openToMerge: 2 }),
    ];
    const m = need()(prs, RELEASES, none)["R1"];
    expect(m.mergeToDeploy.median).toBe(4 * H);
    expect(m.mergeToDeploy.p90).toBe(4 * H);
    expect(m.openToDeploy.median).toBe(6 * H);
    expect(m.openToMerge.median).toBe(2 * H);
  });

  it("a single PR: median and p90 are its own value", () => {
    const m = need()(
      [merged({ created: "2026-01-06T00:00:00Z", openToMerge: 5, deployAfter: 1 })],
      RELEASES,
      none,
    )["R1"];
    expect(m.openToMerge).toEqual({ median: 5 * H, p90: 5 * H });
    expect(m.openToDeploy).toEqual({ median: 6 * H, p90: 6 * H });
  });

  it("input order does not matter and the input is never mutated", () => {
    const prs = r1();
    const snap = JSON.stringify(prs);
    const a = need()(prs, RELEASES, none);
    const b = need()([...prs].reverse(), RELEASES, none);
    expect(b).toEqual(a);
    expect(JSON.stringify(prs)).toBe(snap);
  });
});
