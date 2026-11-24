import fs from "node:fs";
import path from "node:path";

/**
 * SA-1215 (both sets) with the SA-1194 K1 shape: every new PO table carries a tenantId, so each joins the RLS set in the
 * PR that creates it: one line in `apply-rls.js` `TENANT_TABLES` and one name in each of the two ARRAY literals of the
 * parked RLS migration. It has no effect while the RLS migration stays parked.
 */
const NEW_TABLES = [
  "PurchaseOrderReceipt",
  "PurchaseOrderReceiptLine",
  "PurchaseOrderCharge",
  "PurchaseOrderChargeAllocation",
];

const API_DIR = path.join(__dirname, "..", "..");
const applyRls = fs.readFileSync(path.join(API_DIR, "scripts", "apply-rls.js"), "utf8");
const parked = fs.readFileSync(
  path.join(API_DIR, "prisma", "deferred-rls", "20260909000000_rls", "migration.sql"),
  "utf8",
);
const literals = [...parked.matchAll(/tables\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*;/g)].map(
  (m) => [...m[1].matchAll(/'([^']+)'/g)].map((t) => t[1]),
);
const tenantTables = [
  ...applyRls.match(/TENANT_TABLES\s*=\s*\[([\s\S]*?)\];/)![1].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);

describe("SA-1215 PO tables join the RLS set (SA-1194 K1 shape)", () => {
  it.each(NEW_TABLES)("%s is in apply-rls.js TENANT_TABLES exactly once", (name) => {
    expect(tenantTables.filter((t) => t === name)).toEqual([name]);
  });

  it("the parked RLS migration has its two list literals, and each holds every new table once", () => {
    expect(literals).toHaveLength(2);
    for (const list of literals) {
      for (const name of NEW_TABLES) expect(list.filter((t) => t === name)).toEqual([name]);
    }
  });
});
