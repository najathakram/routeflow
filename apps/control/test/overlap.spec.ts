/** WP2 T14/T15 + glob: overlap of two lanes' file sets (spec 5.2). Modules do not exist yet (RED). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const G: any = require("../src/domain/glob");
const O: any = require("../src/domain/overlap");

const repo = [
  "apps/api/src/invoices/invoice.service.ts",
  "apps/api/src/invoices/invoice-pdf.ts",
  "apps/api/src/invoices/dto/create.dto.ts",
  "apps/api/src/orders/order.service.ts",
  "apps/web/app/(dashboard)/invoices/page.tsx",
  "apps/web/app/(dashboard)/invoices/[id]/page.tsx",
  "apps/web/app/(dashboard)/orders/page.tsx",
  "README.md",
  "docs/a.md",
];

describe("globToRegex / expand", () => {
  it("maps * ? ** and escapes regex chars and parentheses", () => {
    expect(G.globToRegex("apps/*/src").test("apps/api/src")).toBe(true);
    expect(G.globToRegex("apps/*/src").test("apps/a/b/src")).toBe(false);
    expect(G.globToRegex("a?c.ts").test("abc.ts")).toBe(true);
    expect(G.globToRegex("a?c.ts").test("a/c.ts")).toBe(false);
    expect(G.globToRegex("a?c.ts").test("abcxts")).toBe(false);
    expect(G.globToRegex("apps/**/x.ts").test("apps/a/b/x.ts")).toBe(true);
    expect(G.globToRegex("apps/**/x.ts").test("apps/x.ts")).toBe(true);
    expect(G.globToRegex("apps/web/app/(dashboard)/**").test(repo[4])).toBe(true);
    expect(G.globToRegex("apps/web/app/[id]/x+y.ts").test("apps/web/app/[id]/x+y.ts")).toBe(true);
  });
  it("a bare directory prefix matches everything under it, a file glob does not", () => {
    const re = G.globToRegex("apps/api/src/invoices");
    expect(re.test("apps/api/src/invoices")).toBe(true);
    expect(re.test("apps/api/src/invoices/dto/create.dto.ts")).toBe(true);
    expect(re.test("apps/api/src/invoices-other/x.ts")).toBe(false);
    expect(G.globToRegex("docs/a.md").test("docs/a.md/x")).toBe(false);
  });
  it("rejects unsafe globs (parent traversal, backslash)", () => {
    expect(() => G.globToRegex("../secret")).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("a/../b")).toThrow(/unsafe glob/);
    expect(() => G.globToRegex("apps\\api\\**")).toThrow(/unsafe glob/);
  });
  it("expand returns the matching subset of files as a Set", () => {
    const s: Set<string> = G.expand(["apps/api/src/invoices/**", "README.md"], repo);
    expect([...s].sort()).toEqual(
      [
        "README.md",
        "apps/api/src/invoices/dto/create.dto.ts",
        "apps/api/src/invoices/invoice-pdf.ts",
        "apps/api/src/invoices/invoice.service.ts",
      ].sort(),
    );
  });
  it("normalises backslashes in a changed-file path before matching", () => {
    const s: Set<string> = G.expand(
      ["apps/api/src/invoices/**"],
      ["apps\\api\\src\\invoices\\invoice.service.ts"],
    );
    expect([...s]).toEqual(["apps/api/src/invoices/invoice.service.ts"]);
  });
});

describe("overlap (T14)", () => {
  it("declared areas, one shared file: shared 1, coef 1, WARN, symmetric", () => {
    const a: Set<string> = G.expand(["apps/api/src/invoices/**"], repo);
    const b: Set<string> = G.expand(
      ["apps/api/src/invoices/invoice-pdf.ts", "apps/web/app/(dashboard)/invoices/**"],
      repo,
    );
    expect(a.size).toBe(3);
    expect(b.size).toBe(3);
    const r = O.overlap(a, b);
    expect(r).toEqual({
      shared: 1,
      coef: 1 / 3,
      level: "WARN",
      paths: ["apps/api/src/invoices/invoice-pdf.ts"],
    });
    expect(O.overlap(b, a)).toEqual(r);
  });
  it("pure 1-of-1 containment is coef 1.0 but only WARN (shared < 3)", () => {
    const r = O.overlap(new Set(["x.ts"]), new Set(["x.ts", "y.ts", "z.ts"]));
    expect(r).toEqual({ shared: 1, coef: 1, level: "WARN", paths: ["x.ts"] });
  });
});

describe("overlap (T15) thresholds at +-1 boundary", () => {
  const mk = (n: number, p = "f") => Array.from({ length: n }, (_, i) => `${p}${i}.ts`);
  it("A 6 files with 3 inside B's 4-file set: shared 3, coef .75, HOT", () => {
    const b = new Set(["f0.ts", "f1.ts", "f2.ts", "b9.ts"]);
    const a = new Set([...mk(3), "a7.ts", "a8.ts", "a9.ts"]);
    const r = O.overlap(a, b);
    expect(r.shared).toBe(3);
    expect(r.coef).toBe(0.75);
    expect(r.level).toBe("HOT");
    expect(r.paths).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
  });
  it("shared 3 with coef exactly .5 is HOT; coef just under .5 is WARN", () => {
    const six = new Set(mk(6));
    const a = new Set(mk(3)); // 3 of min(3,6)=3 -> 1.0
    expect(O.overlap(a, six).level).toBe("HOT");
    const a2 = new Set([...mk(3), ...mk(3, "a")]); // 6 files, 3 shared with a 6-file set: .5
    const r = O.overlap(a2, six);
    expect(r.coef).toBe(0.5);
    expect(r.level).toBe("HOT");
    const big = new Set([...mk(3), ...mk(4, "z")]); // 7 files vs 7 files with 3 shared: 3/7
    const big2 = new Set([...mk(3), ...mk(4, "y")]);
    const r2 = O.overlap(big, big2);
    expect(r2.coef).toBeCloseTo(3 / 7, 10);
    expect(r2.level).toBe("WARN");
  });
  it("shared 2 of 2 (coef 1) is WARN, never HOT", () => {
    expect(O.overlap(new Set(["a", "b"]), new Set(["a", "b", "c"])).level).toBe("WARN");
  });
  it("coef exactly .25 is WARN, just under is none", () => {
    const four = new Set(["a", "b", "c", "d"]);
    const a = new Set(["a", "x1", "x2", "x3"]);
    expect(O.overlap(a, four)).toMatchObject({ shared: 1, coef: 0.25, level: "WARN" });
    const a5 = new Set(["a", "x1", "x2", "x3", "x4"]);
    const b5 = new Set(["a", "y1", "y2", "y3", "y4", "y5"]);
    expect(O.overlap(a5, b5)).toMatchObject({ shared: 1, level: "none" });
    expect(O.overlap(a5, b5).coef).toBeCloseTo(0.2, 10);
  });
  it("empty side or no intersection is none with coef 0", () => {
    expect(O.overlap(new Set(), new Set(["a"]))).toEqual({
      shared: 0,
      coef: 0,
      level: "none",
      paths: [],
    });
    expect(O.overlap(new Set(["a"]), new Set(["b"])).level).toBe("none");
  });
  it("paths are sorted by code unit (uppercase before lowercase)", () => {
    const r = O.overlap(new Set(["b.ts", "B.ts", "a.ts"]), new Set(["a.ts", "b.ts", "B.ts"]));
    expect(r.paths).toEqual(["B.ts", "a.ts", "b.ts"]);
  });
});

describe("overlapPairs", () => {
  const lane = (id: string, files: string[], source: "diff" | "declared") => ({
    lane: id,
    files: new Set(files),
    source,
  });
  it("a lane with no files forms no pair; diff source wins over declared; sorted coef desc, shared desc, laneA, laneB", () => {
    const pairs = O.overlapPairs([
      lane("lane-b", [], "declared"),
      lane("lane-a", ["f0", "f1", "f2", "a1", "a2", "a3"], "diff"),
      lane("lane-c", ["f0", "f1", "f2", "c1"], "declared"),
      lane("lane-d", ["f0", "d1", "d2", "d3"], "declared"),
    ]);
    expect(pairs.map((p: any) => [p.a, p.b, p.level, p.source])).toEqual([
      ["lane-a", "lane-c", "HOT", "diff"],
      ["lane-a", "lane-d", "WARN", "diff"],
      ["lane-c", "lane-d", "WARN", "declared"],
    ]);
    expect(pairs[0]).toMatchObject({ shared: 3, coef: 0.75 });
    expect(pairs[1]).toMatchObject({ shared: 1, coef: 0.25 });
    expect(pairs[2]).toMatchObject({ shared: 1, coef: 0.25 });
  });
});
