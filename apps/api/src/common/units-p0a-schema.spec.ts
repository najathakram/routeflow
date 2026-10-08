/**
 * Units rebuild P0a — schema-only. Pins that every new column exists on the generated client
 * and is nullable in the schema source (additive migration: no default, no NOT NULL).
 * Prisma.dmmf in this client lacks `isRequired`, so nullability is read from the schema text.
 * A stale client makes this red for the wrong reason: `npx prisma generate`.
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { INVOICE_LINE_CODE_MODES } from "@routeflow/types";

const SCHEMA_DIR = path.resolve(__dirname, "../../prisma/schema");
const SRC = fs
  .readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".prisma"))
  .map((f) => fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8"))
  .join("\n");

function modelBody(model: string): string {
  const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(SRC);
  if (!m) throw new Error(`model ${model} not in schema source`);
  return m[1];
}

const NULLABLE: Array<[string, string, string]> = [
  ["TenantUnit", "plural", "String"],
  ["TenantUnit", "archivedAt", "DateTime"],
  ["ProductUnit", "tenantUnitId", "String"],
  ["ProductUnit", "perParent", "Int"],
  ["ProductUnit", "sku", "String"],
  ["ProductUnit", "retiredSku", "String"],
  ["Product", "baseUnitLabel", "String"],
  ["Product", "packLabel", "String"],
  ["Product", "invoiceLineCode", "String"],
  ["ProductBarcode", "productUnitId", "String"],
  ["InvoiceItem", "lineCode", "String"],
  ["CreditNoteItem", "lineCode", "String"],
  ...["OrderItem", "InvoiceItem", "EstimateItem", "ReturnItem", "CreditNoteItem"].flatMap(
    (m): Array<[string, string, string]> => [
      [m, "baseLabel", "String"],
      [m, "packLabel", "String"],
    ],
  ),
  ["PurchaseOrderItem", "baseLabel", "String"],
  ["VendorBillItem", "baseLabel", "String"],
];

describe("units P0a additive columns", () => {
  it.each(NULLABLE)("%s.%s exists, is nullable, has no default", (model, field, type) => {
    const dm = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
    expect(dm?.fields.find((f) => f.name === field)?.type).toBe(type);
    const line = modelBody(model)
      .split("\n")
      .find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
    expect(line).toMatch(new RegExp(`^\\s*${field}\\s+${type}\\?\\s*(//.*)?$`));
  });

  it("snapshot columns are absent from the template models", () => {
    for (const m of ["OrderTemplateItem", "RecurringInvoiceItem"]) {
      const dm = Prisma.dmmf.datamodel.models.find((x) => x.name === m);
      expect(dm?.fields.some((f) => f.name === "baseLabel" || f.name === "packLabel")).toBe(false);
    }
  });

  it("TenantUnit is tenant-scoped with a (tenantId, nameKey) unique", () => {
    expect(modelBody("TenantUnit")).toMatch(/@@unique\(\[tenantId, nameKey\]\)/);
  });

  it("ProductBarcode.productUnit is SetNull; ProductUnit.tenantUnit is SetNull", () => {
    expect(modelBody("ProductBarcode")).toMatch(
      /productUnitId\], references: \[id\], onDelete: SetNull/,
    );
    expect(modelBody("ProductUnit")).toMatch(
      /tenantUnitId\], references: \[id\], onDelete: SetNull/,
    );
  });

  it("INVOICE_LINE_CODE_MODES is the pinned set", () => {
    expect([...INVOICE_LINE_CODE_MODES]).toEqual(["legacy", "smallest", "sold", "main"]);
  });
});
