import { MAX_SCAN_SEARCH_CANDIDATES, buildScanSearchOr } from "./scan-search";

describe("buildScanSearchOr", () => {
  const clauses = (code: string) => buildScanSearchOr(code);
  const valuesFor = (code: string, column: string) =>
    clauses(code)
      .filter((c) => column in c)
      .map((c) => (c[column] as { contains: string }).contains);

  it("fans every candidate over all four code-bearing columns", () => {
    const or = clauses("012345678905");
    const perColumn = or.length / 4;
    for (const col of ["name", "sku", "barcode", "unitSku"]) {
      expect(valuesFor("012345678905", col)).toHaveLength(perColumn);
    }
    for (const c of or) {
      const clause = Object.values(c)[0] as { contains: string; mode: string };
      expect(clause.mode).toBe("insensitive");
    }
  });

  it("a 13-digit iOS decode carries the 12-digit UPC-A candidate — the numeric-name fix", () => {
    // iPhone reports the label as "0"+12 digits; the printed 12-digit number is
    // what tenants type into the product NAME. The candidate fan-out must make
    // `name contains <12 digits>` reachable from the 13-digit decode.
    expect(valuesFor("0012345678905", "name")).toContain("012345678905");
  });

  it("a 12-digit desktop decode carries the zero-padded EAN-13 candidate", () => {
    expect(valuesFor("012345678905", "barcode")).toContain("0012345678905");
  });

  it("caps the candidate fan-out (bounded OR size)", () => {
    // A code that generates many variants still yields at most cap × 4 clauses.
    expect(clauses("0012345678905").length).toBeLessThanOrEqual(MAX_SCAN_SEARCH_CANDIDATES * 4);
  });

  it("blank / whitespace input yields [] — Prisma OR:[] matches nothing", () => {
    expect(clauses("")).toEqual([]);
    expect(clauses("   ")).toEqual([]);
  });

  it("keeps candidate order (most canonical first) so earlier clauses are the literal decode", () => {
    const names = valuesFor("012345678905", "name");
    expect(names[0]).toBe("012345678905");
  });
});
