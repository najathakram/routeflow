import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * T15 / SA-829 MUST: the B294 InvoiceItem.taxRate backfill selects by EMPTINESS (every line still at 0 and a rate the
 * stored totals prove), never by a creation date. The old writer kept stamping 0 until its fix deployed, so a date
 * cutoff silently skips lines. Pure-logic pin; the round trip is `backfill-b294-order-line-taxrate.db.spec.ts`.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/backfill-b294-order-line-taxrate.mjs");
const HREF = pathToFileURL(SCRIPT).href;

describe("backfill-b294 selects by emptiness, never by date", () => {
  const zero = [{ taxRate: 0, categoryTaxAmount: 0 }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let out: any;
  beforeAll(() => {
    const code = `
      import { classifyInvoice } from "${HREF}";
      const lines = ${JSON.stringify(zero)};
      const at = (createdAt, taxAmount = 7.5) => classifyInvoice({ subtotal: 100, taxAmount, createdAt }, lines);
      console.log(JSON.stringify({
        old: at("2026-09-01T00:00:00Z"),
        afterFix: at("2026-10-01T00:00:00Z"),
        future: at("2030-01-01T00:00:00Z"),
        unverified: at("2026-10-01T00:00:00Z", 7.33),
      }));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    out = JSON.parse(res.stdout.trim());
  });

  it("an invoice created before the stamping fix plans APPLY", () => {
    expect(out.old).toMatchObject({ kind: "APPLY", rate: 0.075 });
  });

  it("an invoice created AFTER the fix whose lines are still empty is REVIEW post-fix (a live writer), never APPLY (SA-960)", () => {
    expect(out.afterFix).toMatchObject({ kind: "REVIEW", rate: 0.075, reason: "post-fix" });
    expect(out.future).toMatchObject({ kind: "REVIEW", rate: 0.075, reason: "post-fix" });
  });

  it("an unverifiable rate is REVIEW whatever the date (the proof, not the date, is the classifier)", () => {
    expect(out.unverified).toMatchObject({ kind: "REVIEW" });
  });

  it("the dry run counts post-fix lines per tenant id and per creation source", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("by creation source");
    expect(src).toContain("by tenant id");
    expect(src).toContain("ESTIMATE_CONVERSION");
  });

  it("the derived-invoice SQL has no createdAt bound and the --before flag is retired", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const sql = /const DERIVED_INVOICES_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    expect(sql).toContain('FROM "Invoice" i');
    expect(sql).not.toMatch(/"createdAt"\s*(<|>|<=|>=)/); // no date bound (the column is only selected)
    const res = spawnSync(process.execPath, [SCRIPT, "--before", "2026-09-13T00:00:00Z"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--before is retired/);
  });
});
