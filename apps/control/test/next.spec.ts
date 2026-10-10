/** WP2 T12/T13: next eligible task for a lane (spec 5.1). Module does not exist yet (RED). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const N: any = require("../src/domain/next");

const d = <T>(value: T) => ({ value, source: "register" as const, ref: null });
const T = (id: string, o: Record<string, any> = {}) => ({
  id,
  title: `t ${id}`,
  kind: "feature",
  status: d(o.status ?? "planned"),
  priority: d(o.priority ?? "P2"),
  release: d(o.release === undefined ? null : o.release),
  lane: d(o.lane === undefined ? null : o.lane),
  phase: d(null),
  areas: d([]),
  dependsOn: o.dependsOn ?? [],
  related: d([]),
  effort: o.effort ?? "M",
  importance: o.importance ?? 1,
  customerImpact: o.impact ?? "none",
  ref: null,
  notes: null,
  pr: d(null),
});
const R = (id: string, shipDate: string | null, status = "planned") => ({
  id,
  name: id,
  status: d(status),
  shipDate: d(shipDate),
  goal: null,
  history: [],
});
const mk = (tasks: any[], releases: any[], laneNext: string | null = null) => ({
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  releases: Object.fromEntries(releases.map((r) => [r.id, r])),
  lanes: { "lane-u": { id: "lane-u", next: d(laneNext), current: d(null) } },
});
const ids = (r: any) => r.items.map((i: any) => i.id);
const REL = [R("R1.1c", "2026-10-01"), R("R2", "2026-11-01"), R("R-old", "2026-09-01", "shipped")];

describe("nextEligible T12 oracle", () => {
  const tasks = () => [
    T("RF-1", { priority: "P1", release: "R1.1c", impact: "none", effort: "M", importance: 3 }),
    T("RF-2", { priority: "P0", release: "R2" }),
    T("RF-3", { priority: "P1", release: "R-old" }),
    T("RF-4", { priority: "P0", release: "R1.1c", dependsOn: ["RF-2"] }),
    T("RF-5", { priority: "P1", release: "R1.1c", impact: "high", effort: "S" }),
    T("RF-6", { priority: "P1", lane: "r-ui" }),
    T("RF-7", { priority: "P3" }),
    T("RF-8", { priority: "P2", status: "reconsider" }),
    T("RF-9", { priority: "P1", release: "R1.1c", impact: "none", effort: "S", importance: 3 }),
  ];
  it("explicit task.next first, then sorted: [RF-7, RF-2, RF-5, RF-9, RF-1]; RF-4 held by RF-2", () => {
    const r = N.nextEligible(mk(tasks(), REL, "RF-7"), "lane-u");
    expect(ids(r)).toEqual(["RF-7", "RF-2", "RF-5", "RF-9", "RF-1"]);
    expect(r.held).toEqual([{ id: "RF-4", by: ["RF-2"] }]);
  });
  it("without an explicit next the pure sort puts RF-7 (P3) last of six eligible, top 5 only", () => {
    const r = N.nextEligible(mk(tasks(), REL), "lane-u");
    expect(ids(r)).toEqual(["RF-2", "RF-5", "RF-9", "RF-1", "RF-7"]);
    expect(r.items).toHaveLength(5);
  });
  it("T13: shipped-release task, other-lane task and reconsider task are absent", () => {
    const r = N.nextEligible(mk(tasks(), REL, "RF-7"), "lane-u");
    for (const gone of ["RF-3", "RF-6", "RF-8"]) expect(ids(r)).not.toContain(gone);
  });
  it("an explicit next that is no longer eligible is ignored", () => {
    const r = N.nextEligible(mk(tasks(), REL, "RF-3"), "lane-u");
    expect(ids(r)[0]).toBe("RF-2");
    expect(ids(r)).not.toContain("RF-3");
  });
  it("a task assigned to this lane itself is eligible; a dependency in {code-complete, released, dropped} releases the hold", () => {
    const r = N.nextEligible(
      mk(
        [
          T("RF-1", { lane: "lane-u", priority: "P0" }),
          T("RF-2", { status: "code-complete" }),
          T("RF-3", { status: "dropped" }),
          T("RF-4", { status: "released" }),
          T("RF-5", { priority: "P1", dependsOn: ["RF-2", "RF-3", "RF-4"] }),
          T("RF-6", { priority: "P1", dependsOn: ["RF-2", "RF-1"] }),
        ],
        [],
      ),
      "lane-u",
    );
    expect(ids(r)).toEqual(["RF-1", "RF-5"]);
    expect(r.held).toEqual([{ id: "RF-6", by: ["RF-1"] }]);
  });
});

describe("nextEligible sort key tie-breaks", () => {
  it("release shipDate asc, null and missing release last", () => {
    const r = N.nextEligible(
      mk(
        [
          T("RF-1", { release: "R2" }),
          T("RF-2", { release: null }),
          T("RF-3", { release: "R1.1c" }),
          T("RF-4", { release: "Rnull" }),
        ],
        [...REL, R("Rnull", null)],
      ),
      "lane-u",
    );
    expect(ids(r)).toEqual(["RF-3", "RF-1", "RF-2", "RF-4"]);
  });
  it("customerImpact desc (high > medium > low > none), effort asc (S < M < L), importance desc", () => {
    const r = N.nextEligible(
      mk(
        [
          T("RF-1", { impact: "none" }),
          T("RF-2", { impact: "low" }),
          T("RF-3", { impact: "medium" }),
          T("RF-4", { impact: "high" }),
          T("RF-5", { effort: "L" }),
          T("RF-6", { effort: "S" }),
          T("RF-7", { importance: 5 }),
        ],
        [],
      ),
      "lane-u",
    );
    expect(ids(r)).toEqual(["RF-4", "RF-3", "RF-2", "RF-6", "RF-7"]);
  });
  it("id natural order: RF-2 before RF-10; all else equal", () => {
    const r = N.nextEligible(mk([T("RF-10"), T("RF-9"), T("RF-2"), T("RF-100")], []), "lane-u");
    expect(ids(r)).toEqual(["RF-2", "RF-9", "RF-10", "RF-100"]);
  });
  it("id ties are locale-independent: code-unit order puts RF-3 before bug-3 and B-3 before b-3", () => {
    const r = N.nextEligible(mk([T("bug-3"), T("RF-3"), T("b-3"), T("B-3")], []), "lane-u");
    expect(ids(r)).toEqual(["B-3", "RF-3", "b-3", "bug-3"]);
  });
});
