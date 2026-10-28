/** SA-1027 C-G17: a run that left an error row (a family not copied, or an undo that failed) exits non-zero. */
import { exitCodeFor, formatReport } from "./catalog-copy.runner";

describe("catalog-copy exit code", () => {
  it("0 when nothing went wrong, a dry run, or a resume", () => {
    expect(exitCodeFor({ errors: [] } as never)).toBe(0);
    expect(exitCodeFor({ mode: "dry-run" } as never)).toBe(0);
    expect(exitCodeFor({ photosCopied: 3 })).toBe(0);
  });

  it("3 when the report holds any error row", () => {
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "copy", message: "m" }] } as never)).toBe(3);
    expect(exitCodeFor({ errors: [{ rootId: "r", kind: "undo", message: "m" }] } as never)).toBe(3);
  });
});

describe("catalog-copy report: the inactive products it leaves out", () => {
  const report = (inactiveLeft: string[]) =>
    ({
      mode: "dry-run",
      sourceProducts: 3,
      inactiveLeftOut: inactiveLeft.length,
      inactiveLeft,
      recipesLeftOut: [],
      skippedBySku: [],
      variantsSkipped: [],
      regulatedIds: [],
      regulated: 0,
      codesDropped: [],
      packOnly: [],
      differs: {},
    }) as never;

  it("lists them by SKU (or id) with the count", () => {
    const text = formatReport(report(["S-5", "id-9"])).join(" | ");
    expect(text).toMatch(/inactive left out: 2 [(]S-5, id-9[)]/);
  });

  it("caps the list at 20 and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => "X-" + i);
    expect(formatReport(report(many)).join(" | ")).toMatch(
      /inactive left out: 25 .*X-19.*[+]5 more/,
    );
  });
});
