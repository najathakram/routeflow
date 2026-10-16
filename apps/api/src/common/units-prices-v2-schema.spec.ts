/**
 * Units program S6 (PLAN §1.2; SA-795 (b), (g), (h)): the new columns and tables exist on the
 * generated client with the right type, nullability and default, and the dark registry rows are in.
 * Prisma 7's runtime DMMF keeps names/types only, so nullability/defaults are read from the schema
 * folder text (the units-p0a-schema.spec pattern). A stale client is red for the wrong reason:
 * run `npx prisma generate` in apps/api first.
 */
import * as fs from "fs";
import * as path from "path";
import { Prisma } from "@prisma/client";
import { SETTINGS_REGISTRY, validateSettingsRegistry } from "@routeflow/types";
import {
  INVOICE_UNIT_SETTING_KEY,
  ORDER_UNIT_SETTING_KEY,
  TIER_RULES_SETTING_KEY,
} from "@routeflow/pricing";
import { FEATURE_REGISTRY } from "../billing/feature-registry";

const SCHEMA_DIR = path.resolve(__dirname, "../../prisma/schema");
const fileOf = (f: string) => fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8");
const SRC = fs
  .readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".prisma"))
  .map(fileOf)
  .join("\n");

function modelBody(model: string, src = SRC): string {
  const m = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(src);
  if (!m) throw new Error(`model ${model} not in schema source`);
  return m[1];
}
const fieldLine = (model: string, field: string) =>
  modelBody(model)
    .split("\n")
    .find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
const dmmfType = (model: string, field: string) =>
  Prisma.dmmf.datamodel.models.find((m) => m.name === model)?.fields.find((f) => f.name === field)
    ?.type;

const NULLABLE: Array<[string, string, string]> = [
  ["Product", "invoiceUnitRef", "String"],
  ["CustomerPrice", "orderUnitRef", "String"],
  ["CustomerPrice", "invoiceUnitRef", "String"],
  ["InvoiceItem", "invoiceUnitLabel", "String"],
  ["InvoiceItem", "invoiceUnitFactor", "Int"],
  ["CreditNoteItem", "invoiceUnitLabel", "String"],
  ["CreditNoteItem", "invoiceUnitFactor", "Int"],
  ...["PurchaseOrderItem", "VendorBillItem"].flatMap((m): Array<[string, string, string]> => [
    [m, "unitLabel", "String"],
    [m, "familyProductId", "String"],
    [m, "familyGroupId", "String"],
  ]),
  ["ProductTierUnit", "orderUnitRef", "String"],
  ["ProductTierUnit", "invoiceUnitRef", "String"],
];

describe("units prices v2 schema (S6)", () => {
  it.each(NULLABLE)("%s.%s exists, is nullable, has no default", (model, field, type) => {
    expect(dmmfType(model, field)).toBe(type);
    expect(fieldLine(model, field)).toMatch(new RegExp(`^\\s*${field}\\s+${type}\\?\\s*(//.*)?$`));
  });

  it("Product.packAuto is Int NOT NULL @default(0)", () => {
    expect(dmmfType("Product", "packAuto")).toBe("Int");
    expect(fieldLine("Product", "packAuto")).toMatch(
      /^\s*packAuto\s+Int\s+@default\(0\)\s*(\/\/.*)?$/,
    );
  });

  it('Product.orderUnitRef is String NOT NULL @default("pack") (every product has an order unit)', () => {
    expect(dmmfType("Product", "orderUnitRef")).toBe("String");
    expect(fieldLine("Product", "orderUnitRef")).toMatch(
      /^\s*orderUnitRef\s+String\s+@default\("pack"\)\s*(\/\/.*)?$/,
    );
  });

  it("the schema documents the packAuto bit order next to the column", () => {
    expect(modelBody("Product")).toMatch(
      /bit 0 = Retail \(pricePerUnit\), bits 1-4 = priceTier2-5/,
    );
  });

  it("ProductTierUnit: tenant-scoped, Cascade from Product, one row per (product, tier)", () => {
    const body = modelBody("ProductTierUnit", fileOf("catalog.prisma"));
    expect(body).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(body).toMatch(/^\s*tier\s+Int\s*$/m);
    expect(body).toMatch(/fields: \[productId\], references: \[id\], onDelete: Cascade/);
    expect(body).toMatch(/fields: \[tenantId\], references: \[id\]\)/);
    expect(body).toMatch(/@@unique\(\[productId, tier\]\)/);
    expect(body).toMatch(/@@index\(\[tenantId\]\)/);
  });

  it("CustomerUnitPrice: tenant-scoped, Cascade from Customer and Product, one price per (customer, product, unit)", () => {
    const body = modelBody("CustomerUnitPrice", fileOf("sales.prisma"));
    expect(body).toMatch(/^\s*tenantId\s+String\s*$/m);
    expect(body).toMatch(/^\s*unitRef\s+String\s*$/m);
    expect(body).toMatch(/^\s*price\s+Decimal\s+@db\.Decimal\(10, 2\)\s*$/m);
    expect(body).toMatch(/fields: \[customerId\], references: \[id\], onDelete: Cascade/);
    expect(body).toMatch(/fields: \[productId\], references: \[id\], onDelete: Cascade/);
    expect(body).toMatch(/@@unique\(\[customerId, productId, unitRef\]\)/);
    expect(body).toMatch(/@@index\(\[tenantId\]\)/);
    expect(body).toMatch(/@@index\(\[productId\]\)/);
    expect(dmmfType("CustomerUnitPrice", "price")).toBe("Decimal");
  });

  it.each(["PurchaseOrderItem", "VendorBillItem"])(
    "%s.familyProduct is an optional SetNull FK into Product, indexed by familyGroupId",
    (model) => {
      const body = modelBody(model);
      expect(body).toMatch(/fields: \[familyProductId\], references: \[id\], onDelete: SetNull/);
      expect(body).toMatch(/@@index\(\[familyGroupId\]\)/);
    },
  );
});

describe("units prices v2 dark registry rows (S6, SA-795 (h): nothing turns on)", () => {
  it.each([TIER_RULES_SETTING_KEY, ORDER_UNIT_SETTING_KEY, INVOICE_UNIT_SETTING_KEY])(
    "%s is a pending SystemConfig config row with a planned surface, no screen",
    (key) => {
      const row = SETTINGS_REGISTRY.find((r) => r.key === key);
      expect(row).toMatchObject({ home: "systemConfig", kind: "config" });
      expect(row?.status).not.toBe("live");
      expect(row?.screen).toBeUndefined();
      expect(row?.plannedSurface).toMatch(/\S/);
    },
  );

  it("the registry stays valid with the new rows", () => {
    expect(validateSettingsRegistry()).toEqual([]);
  });

  it("flag.units_prices_v2 is registered, ungranted by default, in no plan, with no gate wired yet", () => {
    const row = FEATURE_REGISTRY.find((f) => f.key === "flag.units_prices_v2");
    expect(row).toBeDefined();
    expect(row?.defaultGranted).toBe(false);
    expect(row?.area).toBe("catalog");
    expect(row?.gate.state).not.toBe("dark");
    expect(row?.billing.skus).toEqual([]);
  });
});
