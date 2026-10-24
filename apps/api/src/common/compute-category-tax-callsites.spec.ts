/**
 * B297 (SA-088) PR 2 — every `computeCategoryTax(` caller in apps/api/src is classified by ROLE,
 * so a NEW call site can never slip in unclassified. Two roles, matching B297-SPEC.md §1/§2:
 *
 *   - "writer": a NEW-sale writer — the write moment IS the snapshot moment (D6). Every writer
 *     site must ALSO stamp the categoryTaxType/categoryTaxRate/categoryPriceIncludesTax trio the
 *     amount was computed from (via `categoryTaxSnapshotOf`/`categoryTaxForLine`), never leave the
 *     line with an amount but no proof of the rate it came from.
 *   - "recompute": a recompute of an ALREADY-STORED line. Per D2 it reads the line's own snapshot
 *     and never the live category: PR 3 (the B297 headline fix) routes every one through
 *     `recomputeCategoryTax` (`@routeflow/pricing`), whose name also matches the fingerprint below.
 *     The recompute sites are `orders/recompute-line-category-taxes.ts`, price-adjustment-ledger.ts's
 *     buildPriceAdjustmentUpdates and invoice-edit-plan.ts's changed matched rows (R3). This spec exists
 *     so a THIRD role — a call site that is neither — can never appear silently: the count below can
 *     only move if a site is added, removed, or reclassified on purpose.
 *
 * Same allowlist shape as the B661 `no-second-legacy-line-pieces.spec.ts` scan: an exact
 * match-count per file, so the list can only ever be edited deliberately.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);
const CALL = /computeCategoryTax\(/g;
const callCount = (text: string) => (strip(text).match(CALL) ?? []).length;

type Role = "writer" | "recompute" | "writer+recompute";
// B662: invoices.service.ts's recompute (applyPriceAdjustment) moved to price-adjustment-ledger.ts, and
// #2083 moved its writer (update()'s fresh snapshot) to invoice-edit-plan.ts, so invoices.service.ts
// carries no computeCategoryTax( call; the two extracted helpers are the writer and recompute sites.
// B297 PR3: orders.service.ts's recompute moved to orders/recompute-line-category-taxes.ts (so
// orders.service.ts carries create()'s single writer call), and every recompute calls
// `recomputeCategoryTax(` (which contains the fingerprint) instead of pricing from the live category.
const ALLOWLIST: { file: string; count: number; role: Role }[] = [
  { file: "invoices/invoice-unit-line.ts", count: 1, role: "writer" }, // buildInvoiceUnitLine
  { file: "invoices/manual-invoice-lines.ts", count: 1, role: "writer" }, // buildManualInvoiceLines
  { file: "order-templates/order-templates.service.ts", count: 1, role: "writer" }, // standing-order line gen
  { file: "orders/unit-line-build.ts", count: 1, role: "writer" }, // categoryTaxForLine
  { file: "orders/orders.service.ts", count: 1, role: "writer" }, // create()
  // update()'s fresh snapshot for a new row / substitute (writer) + a changed matched row's snapshot recompute (R3)
  { file: "invoices/invoice-edit-plan.ts", count: 2, role: "writer+recompute" },
  { file: "invoices/price-adjustment-ledger.ts", count: 1, role: "recompute" }, // buildPriceAdjustmentUpdates (B662)
  { file: "orders/recompute-line-category-taxes.ts", count: 1, role: "recompute" }, // B297 PR3
];

describe("computeCategoryTax callsites — writer vs recompute (B297-SPEC.md §1/§2)", () => {
  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("the scanner sees the fingerprint and strips comments first", () => {
    expect(callCount("computeCategoryTax({ taxType: X })")).toBe(1);
    expect(callCount("// computeCategoryTax({ taxType: X })")).toBe(0);
    expect(callCount("/* computeCategoryTax({ */")).toBe(0);
  });

  it("every allowlisted file's count is EXACTLY what's pinned — never higher (a new site), never lower (stale)", () => {
    for (const { file, count } of ALLOWLIST) {
      const text = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      expect({ file, count: callCount(text) }).toEqual({ file, count });
    }
  });

  it("no file OUTSIDE the known set has any computeCategoryTax( call — a new site fails the build, not just a changed one", () => {
    const knownFiles = new Set(ALLOWLIST.map((a) => a.file));
    const offenders = FILES.filter((f) => {
      const rel = path.relative(SRC_ROOT, f).replace(/\\/g, "/");
      if (knownFiles.has(rel)) return false;
      return callCount(fs.readFileSync(f, "utf8")) > 0;
    }).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });

  it("total computeCategoryTax( calls across apps/api/src is exactly 9 — 6 writer + 3 recompute", () => {
    const total = FILES.reduce((n, f) => n + callCount(fs.readFileSync(f, "utf8")), 0);
    expect(total).toBe(9);
  });
});
