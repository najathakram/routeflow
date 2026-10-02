/** WP2 T16/T17: piggyback candidates for a lane (spec 5.2). Module does not exist yet (RED). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const P: any = require("../src/domain/piggyback");

const L = new Set([
  "a/1.ts",
  "a/2.ts",
  "a/3.ts",
  "a/4.ts",
  "a/5.ts",
  "a/6.ts",
  "a/7.ts",
  "a/8.ts",
  "a/9.ts",
  "a/10.ts",
]);
const cand = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "feature",
  status: "planned",
  lane: null,
  priority: "P2",
  effort: "S",
  sensitive: false,
  files: new Set<string>(),
  ...over,
});
const ids = (r: any) => r.items.map((i: any) => i.id);

describe("piggyback (T16)", () => {
  it("c1 scores 1.0; c2 .25 is dropped; sensitive c3 last and tagged; assigned c4 absent; header count 1", () => {
    const r = P.piggyback(L, [
      cand("c3", { sensitive: true, files: new Set(["a/3.ts"]) }),
      cand("c2", { files: new Set(["a/4.ts", "x/1.ts", "x/2.ts", "x/3.ts"]) }),
      cand("c1", { files: new Set(["a/1.ts", "a/2.ts"]) }),
      cand("c4", { lane: "lane-z", files: new Set(["a/1.ts"]) }),
    ]);
    expect(ids(r)).toEqual(["c1", "c3"]);
    expect(r.items[0]).toMatchObject({ id: "c1", score: 1, shared: 2, sensitive: false });
    expect(r.items[1]).toMatchObject({
      id: "c3",
      score: 1,
      sensitive: true,
      tag: "tier-1 — not bundleable",
    });
    expect(r.items[0].tag).toBeUndefined();
    expect(r.count).toBe(1);
  });
  it("score threshold: .5 is suggested, 1/3 and 2/5 are not", () => {
    const r = P.piggyback(L, [
      cand("half", { files: new Set(["a/1.ts", "a/2.ts", "x/1.ts", "x/2.ts"]) }),
      cand("third", { files: new Set(["a/1.ts", "x/1.ts", "x/2.ts"]) }),
      cand("two5", { files: new Set(["a/1.ts", "a/2.ts", "x/1.ts", "x/2.ts", "x/3.ts"]) }),
    ]);
    expect(ids(r)).toEqual(["half"]);
    expect(r.items[0].score).toBe(0.5);
  });
  it("eligibility: planned, unassigned, effort S or unknown, bugs severity low|medium, shared >= 1", () => {
    const f = new Set(["a/1.ts"]);
    const r = P.piggyback(L, [
      cand("ok-s", { files: f }),
      cand("ok-unknown", { effort: "unknown", files: f }),
      cand("no-m", { effort: "M", files: f }),
      cand("no-l", { effort: "L", files: f }),
      cand("no-status", { status: "in-progress", files: f }),
      cand("no-shared", { files: new Set(["x/1.ts"]) }),
      cand("no-files", {}),
      cand("bug-low", { kind: "bug", severity: "low", effort: "unknown", files: f }),
      cand("bug-med", { kind: "bug", severity: "medium", effort: "unknown", files: f }),
      cand("bug-high", { kind: "bug", severity: "high", effort: "unknown", files: f }),
      cand("bug-crit", { kind: "bug", severity: "critical", effort: "unknown", files: f }),
    ]);
    expect(ids(r).sort()).toEqual(["bug-low", "bug-med", "ok-s", "ok-unknown"]);
  });
  it("sort: score desc, then priority asc, then id asc", () => {
    const r = P.piggyback(L, [
      cand("z-hi-score", { priority: "P3", files: new Set(["a/1.ts"]) }),
      cand("b-p2", { priority: "P2", files: new Set(["a/1.ts", "x/1.ts"]) }),
      cand("a-p2", { priority: "P2", files: new Set(["a/1.ts", "x/1.ts"]) }),
      cand("c-p0", { priority: "P0", files: new Set(["a/1.ts", "x/1.ts"]) }),
    ]);
    expect(ids(r)).toEqual(["z-hi-score", "c-p0", "a-p2", "b-p2"]);
  });
  it("sensitive rows are listed last but never counted in the header", () => {
    const r = P.piggyback(L, [
      cand("s1", { sensitive: true, priority: "P0", files: new Set(["a/1.ts"]) }),
      cand("n1", { priority: "P3", files: new Set(["a/1.ts"]) }),
      cand("s2", { sensitive: true, priority: "P0", files: new Set(["a/2.ts"]) }),
    ]);
    expect(ids(r)).toEqual(["n1", "s1", "s2"]);
    expect(r.count).toBe(1);
  });
});

describe("piggyback (T17) cap and locale-free ordering", () => {
  it("12 candidates all score 1: length 8, sorted priority then id", () => {
    const f = new Set(["a/1.ts"]);
    const list = [
      ...Array.from({ length: 6 }, (_, i) =>
        cand(`c${String(i + 1).padStart(2, "0")}`, { priority: "P2", files: f }),
      ),
      ...Array.from({ length: 4 }, (_, i) => cand(`d${i + 1}`, { priority: "P1", files: f })),
      cand("e1", { priority: "P0", files: f }),
      cand("e2", { priority: "P3", files: f }),
    ].reverse();
    const r = P.piggyback(L, list);
    expect(r.items).toHaveLength(8);
    expect(ids(r)).toEqual(["e1", "d1", "d2", "d3", "d4", "c01", "c02", "c03"]);
    expect(r.count).toBe(8);
  });
  it("id ties use code-unit order: uppercase before lowercase", () => {
    const f = new Set(["a/1.ts"]);
    const r = P.piggyback(L, [
      cand("bug-1", { files: f }),
      cand("RF-1", { files: f }),
      cand("B-1", { files: f }),
      cand("b-1", { files: f }),
    ]);
    expect(ids(r)).toEqual(["B-1", "RF-1", "b-1", "bug-1"]);
  });
});
