import fs from "node:fs";
import path from "node:path";

/**
 * SA-821 MUST 2 (row 631): ONE refund-claim path per method. A standard return's EXTERNAL refund is claimed ONLY by
 * `ReturnsService#claimRefund` (SA-737: the basis recomputed under the lock, RETURN_REFUND_BASIS_CHANGED, the audit
 * row, plus master's paid-in-full and cash-cap checks); an inline return's by `InlineReturnsService#refund`; the
 * store-credit resolution stamps it in `InlineReturnsService#issueCreditInTx`. A second copy of a claimer (master's
 * pre-SA-737 `processRefund` stamp, or a re-added `recordExternalRefund`) is how two claim paths with different
 * checks come back. This pin lists every site that PRODUCES a `refundedAt` value (a stamp, not a read filter or a copy
 * of a stored one), as `file#method`; an unlisted site fails.
 */
const SRC = path.resolve(__dirname, "..");

const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "testing" || e.name === "node_modules" ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name) ? [p] : [];
  });
}

/** A `refundedAt` value being PRODUCED: `refundedAt: new Date(...)`, `refundedAt: await dbClockNow(...)`, `const refundedAt =`. */
const STAMP = /\brefundedAt\s*:\s*(?:new Date\(|await\s+dbClockNow\()|\bconst\s+refundedAt\s*=/;
const METHOD =
  /^\s{2}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_]\w*)\s*\(|^export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/;

function stampSites(): string[] {
  const sites = new Set<string>();
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    let method = "";
    for (const line of strip(fs.readFileSync(file, "utf8")).split("\n")) {
      const m = METHOD.exec(line);
      if (m) method = m[1] ?? m[2];
      if (STAMP.test(line)) sites.add(`${rel}#${method}`);
    }
  }
  return [...sites].sort();
}

describe("SA-821 MUST 2: one refund-claim path per method", () => {
  it("only the three resolution paths stamp refundedAt (one standard EXTERNAL claimer)", () => {
    expect(stampSites()).toEqual([
      "returns/inline-returns.service.ts#issueCreditInTx",
      "returns/inline-returns.service.ts#refund",
      "returns/returns.service.ts#claimRefund",
    ]);
  });

  it("the scan is not silently empty (the stamp pattern still matches the code)", () => {
    expect(stampSites().length).toBeGreaterThanOrEqual(2);
  });
});
