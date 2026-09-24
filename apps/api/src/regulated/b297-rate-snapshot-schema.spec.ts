/**
 * B297 (SA-088) PR 1 — schema-only. Pins that the rate-snapshot trio and the LOCKED filing
 * columns exist on the generated Prisma client, so a later PR that reads/writes them (PR 2
 * onward) can trust the client without re-deriving column names. Hermetic: no DB.
 *
 * `Prisma.dmmf` in this generated client (v7) keeps only `name`/`kind`/`type` per field — no
 * `isRequired`, no `nativeType`, and `datamodel.enums` is pruned to empty — so column presence
 * is asserted from the dmmf (same pattern as data-questions-report.spec.ts) and enum VALUES from
 * the runtime enum object `@prisma/client` exports (the same source enum-parity.spec.ts reads).
 * Precision (DECIMAL(12,4), matching TrackedCategory.rate) isn't in the generated client at all,
 * so it's asserted from the schema source text instead — the one place it's actually declared.
 * A stale local client makes the dmmf/enum assertions red for the wrong reason:
 * `npx prisma generate`.
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PrismaRuntime = require("@prisma/client") as Record<string, Record<string, string>>;

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function fieldsOf(modelName: string): Map<string, { kind: string; type: string }> {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`model ${modelName} not found in Prisma.dmmf`);
  return new Map(model.fields.map((f) => [f.name, { kind: f.kind, type: f.type }]));
}

describe("B297 rate-snapshot columns (OrderItem, InvoiceItem)", () => {
  it.each(["OrderItem", "InvoiceItem"])(
    "%s carries the categoryTaxType/categoryTaxRate/categoryPriceIncludesTax trio",
    (modelName) => {
      const fields = fieldsOf(modelName);

      expect(fields.get("categoryTaxType")).toEqual({
        kind: "enum",
        type: "TrackedCategoryTaxType",
      });
      expect(fields.get("categoryTaxRate")).toEqual({ kind: "scalar", type: "Decimal" });
      expect(fields.get("categoryPriceIncludesTax")).toEqual({ kind: "scalar", type: "Boolean" });
    },
  );

  it.each([
    ["sales.prisma", "categoryTaxRate.*Decimal\\?.*@db\\.Decimal\\(12, ?4\\)"],
    ["finance.prisma", "categoryTaxRate.*Decimal\\?.*@db\\.Decimal\\(12, ?4\\)"],
  ])(
    "%s declares categoryTaxRate as nullable @db.Decimal(12,4) — TrackedCategory.rate's own precision",
    (file) => {
      const src = fs.readFileSync(path.join(REPO_ROOT, "apps/api/prisma/schema", file), "utf8");
      expect(src).toMatch(/categoryTaxRate\s+Decimal\?\s+@db\.Decimal\(12,\s*4\)/);
    },
  );
});

describe("B297 LOCKED filing status (RegulatedFiling)", () => {
  it("RegulatedFilingStatus gained LOCKED alongside GENERATED and FAILED", () => {
    expect(Object.values(PrismaRuntime.RegulatedFilingStatus)).toEqual(
      expect.arrayContaining(["GENERATED", "FAILED", "LOCKED"]),
    );
  });

  it("RegulatedFiling carries the lockedAt/lockedById/lockReason trio", () => {
    const fields = fieldsOf("RegulatedFiling");
    expect(fields.get("lockedAt")).toEqual({ kind: "scalar", type: "DateTime" });
    expect(fields.get("lockedById")).toEqual({ kind: "scalar", type: "String" });
    expect(fields.get("lockReason")).toEqual({ kind: "scalar", type: "String" });
  });
});
