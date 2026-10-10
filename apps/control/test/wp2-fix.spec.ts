/** WP2 fix round 1 (Opus review): ReDoS guards, `**` semantics, readiness dates, tie-breaks, caps. */
/* eslint-disable @typescript-eslint/no-explicit-any */
const G: any = require("../src/domain/glob");
const N: any = require("../src/domain/next");
const P: any = require("../src/domain/piggyback");
const R: any = require("../src/domain/releases");

describe("glob ReDoS guards", () => {
  it("rejects > 2 stars in one segment, > 256 chars, > 4 wildcard runs", () => {
    expect(() => G.globToRegex("a*a*a*b")).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("a".repeat(257))).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("a*/b*/c*/d*/e*/f")).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("**/*a*b")).not.toThrow();
  });
  it("a 1,024-char path against **/*a*b completes within a small CPU budget", () => {
    const re = G.globToRegex("**/*a*b");
    const input = "a".repeat(1024);
    const c0 = process.cpuUsage();
    re.test(input);
    const c = process.cpuUsage(c0);
    const cpuMs = (c.user + c.system) / 1000;
    // L-165: CPU time (process.cpuUsage), not wall time: wall stretches 3-10x under host load, a
    // ReDoS blowup costs seconds of CPU. Quiet-host measured 0 ms (below the 15 ms CPU tick); budget 150 ms.
    expect(cpuMs).toBeLessThan(150);
  });
  it("expand skips paths longer than 1,024 chars", () => {
    const long = "a".repeat(1025);
    expect([...G.expand(["**"], [long, "ok.ts"])]).toEqual(["ok.ts"]);
  });
  it("strips a leading ./ from file paths", () => {
    expect([...G.expand(["src/**"], ["./src/a.ts"])]).toEqual(["src/a.ts"]);
  });
});

describe("glob round 2", () => {
  const path = "a/".repeat(512);
  const fast = (glob: string) => {
    const c0 = process.cpuUsage();
    try {
      G.globToRegex(glob).test(path);
    } catch (e) {
      expect(String(e)).toMatch(/unsafe glob/);
    }
    const c = process.cpuUsage(c0);
    const cpuMs = (c.user + c.system) / 1000;
    // L-165: CPU time (process.cpuUsage), not wall time: wall stretches 3-10x under host load, a
    // ReDoS blowup costs seconds of CPU. Quiet-host measured 0 ms (below the 15 ms CPU tick); budget 150 ms.
    expect(cpuMs).toBeLessThan(150);
  };
  it("stacked ** globs throw or finish within a small CPU budget", () => {
    fast("**a/**a/**a/**b");
    fast("**/a/**/a/**/a/**/b");
  });
  it("a non-whole-segment ** does not cross /", () => {
    expect(G.globToRegex("apps/**x.ts").test("apps/a/bx.ts")).toBe(false);
    expect(G.globToRegex("apps/**x.ts").test("apps/bx.ts")).toBe(true);
  });
  it("a*a*a*b still throws; > 2 ** runs throw", () => {
    expect(() => G.globToRegex("a*a*a*b")).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("**/a/**/b/**/c")).toThrow(/unsafe glob/);
  });
});

describe("glob ** semantics", () => {
  it("apps/**/x.ts is segment-aware", () => {
    const re = G.globToRegex("apps/**/x.ts");
    expect(re.test("apps/a/bx.ts")).toBe(false);
    expect(re.test("apps/ax.ts")).toBe(false);
    expect(re.test("apps/x.ts")).toBe(true);
    expect(re.test("apps/a/b/x.ts")).toBe(true);
  });
  it("trailing slash is a bare directory", () => {
    expect(G.globToRegex("invoices/").test("invoices/x.ts")).toBe(true);
  });
});

describe("release readiness dates", () => {
  const d = (value: any) => ({ value, source: "register", ref: null });
  const st = (shipDate: string | null, open: number, total: number) => ({
    releases: { R1: { id: "R1", status: d("planned"), shipDate: d(shipDate), history: [] } },
    tasks: Object.fromEntries(
      Array.from({ length: total }, (_, i) => [
        `RF-${i}`,
        { id: `RF-${i}`, status: d(i < open ? "in-progress" : "code-complete"), release: d("R1") },
      ]),
    ),
  });
  it("past due is AT RISK with any open task", () => {
    expect(R.releaseReadiness(st("2026-09-20", 1, 10), "R1", "2026-09-30T00:00:00Z").state).toBe(
      "AT RISK",
    );
  });
  it("uses the true UTC instant of now, honouring offsets", () => {
    expect(
      R.releaseReadiness(st("2026-10-04", 3, 10), "R1", "2026-09-30T23:00:00-05:00").state,
    ).toBe("AT RISK");
  });
  it("ignores a ship date that is not YYYY-MM-DD", () => {
    expect(R.releaseReadiness(st("Oct 3", 9, 10), "R1", "2026-09-30T00:00:00Z").state).toBe(
      "IN PROGRESS",
    );
  });
});

describe("next / piggyback tie-breaks and caps", () => {
  const d = (value: any) => ({ value, source: "register", ref: null });
  const T = (id: string, o: any = {}) => ({
    id,
    title: id,
    kind: "feature",
    status: d("planned"),
    priority: d("P2"),
    release: d(null),
    lane: d(null),
    phase: d(null),
    areas: d([]),
    dependsOn: [],
    related: d([]),
    effort: "M",
    importance: 1,
    customerImpact: "none",
    ref: null,
    notes: null,
    pr: d(null),
    ...o,
  });
  it("another lane's current task is excluded", () => {
    const tasks = [T("RF-5"), T("RF-6")];
    const r = N.nextEligible(
      {
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
        releases: {},
        lanes: {
          "lane-u": { id: "lane-u", next: d(null), current: d(null) },
          "r-ui": { id: "r-ui", next: d(null), current: d("RF-5") },
        },
      },
      "lane-u",
    );
    expect(r.items.map((i: any) => i.id)).toEqual(["RF-6"]);
  });
  it("NaN importance is treated as 0", () => {
    const tasks = [T("RF-1", { importance: NaN }), T("RF-2", { importance: 0 })];
    const r = N.nextEligible(
      {
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
        releases: {},
        lanes: { "lane-u": { id: "lane-u", next: d(null), current: d(null) } },
      },
      "lane-u",
    );
    expect(r.items.map((i: any) => i.id)).toEqual(["RF-1", "RF-2"]);
  });
  const c = (id: string, o: any = {}) => ({
    id,
    kind: "feature",
    status: "planned",
    lane: null,
    priority: "P2",
    effort: "S",
    sensitive: false,
    files: new Set(["a"]),
    ...o,
  });
  it("unknown priority sorts after P3", () => {
    const r = P.piggyback(new Set(["a"]), [
      c("a", { priority: "weird" }),
      c("b", { priority: "P3" }),
    ]);
    expect(r.items.map((i: any) => i.id)).toEqual(["b", "a"]);
  });
  it("cap applies to normal rows only; sensitive holds stay", () => {
    const list = [...Array.from({ length: 8 }, (_, i) => c(`n${i}`)), c("s1", { sensitive: true })];
    const r = P.piggyback(new Set(["a"]), list);
    expect(r.items).toHaveLength(9);
    expect(r.items[8].id).toBe("s1");
    expect(r.count).toBe(8);
  });
});
