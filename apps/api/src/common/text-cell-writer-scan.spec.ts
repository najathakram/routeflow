/**
 * B956 / SA-629f: structural writer scan. Every non-spec source file that writes a guarded TEXT
 * field of a guarded model (`<x>.customer.create|createMany|update|updateMany|upsert({ data: {
 * ...businessName... } })`) must call the shared write guard (`assertSafeCustomerNames`,
 * `customerNameViolation` or `assertSafeTextCell`), or be listed in EXEMPT with the reason it is
 * safe. A NEW writer of these fields therefore fails here until it calls the guard, which is how
 * the "DTO decorator alone leaves doors open" gap stays closed. B964 extends GUARDED (a new model
 * and its fields) and reuses the same scan; nothing else needs to change.
 *
 * KNOWN BLIND SPOTS (SA-629g, B956 Opus review): the scan reads field NAMES inside the text of a
 * literal `.<model>.<verb>(...)` call, so it does NOT see:
 *   - a spread or variable `data`: `customer.update({ data: { ...dto } })`, `data: someVariable`
 *     (tenants.service updateBranding builds `const data` first, so only its guard call, not the
 *     scan, protects it);
 *   - a split or aliased delegate: `const db = this.prisma.customer; db.update(...)`,
 *     `const { customer } = tx`, or a helper that receives the delegate as an argument;
 *   - a raw SQL write (`$executeRaw`, `$queryRaw`) of these columns.
 * Today's writers spell the fields out. A new writer in any of those shapes must call the guard
 * anyway, and a reviewer should look for them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** model accessor -> the guarded fields written under it. Extend for B964 (addresses, licenses…). */
const GUARDED: Record<string, readonly string[]> = {
  customer: [
    "businessName",
    "contactName",
    "displayName",
    "tobaccoLicenseNo",
    // B984: the Customer's own copy of the person name
    "salutation",
    "firstName",
    "lastName",
  ],
  // B984: a contact person's name (printed on statements, route sheets, exports). Email / phone / mobile are not guarded.
  contactPerson: ["salutation", "firstName", "lastName"],
  // B964-1: addresses (printed on documents, route sheets, the tobacco filing header), license numbers, buyer names.
  customerAddress: ["label", "line1", "line2", "city", "state", "zip"],
  customerAuthorization: ["licenseNumber"],
  buyerAccount: ["name"],
  // B964-2: product names (invoices, order sheets, exports, regulated filings). #2881's family create/update writes the same
  // columns: it fails this scan until it calls the guard.
  product: ["name", "variantName"],
  // The tenant name is mirrored into a Customer row (tenant-mirror) and printed on buyer documents.
  tenant: ["name"],
  // Printed on buyer documents and on the tobacco filing header.
  // Blind spot: tenants.service updateBranding builds `const data` first, so the scan cannot see it;
  // only its assertSafeTextCell call (and a spec) protects that write.
  tenantConfig: ["businessName"],
};

const GUARD_CALLS = [
  "assertSafeCustomerNames",
  "customerNameViolation",
  "assertSafeTextCell",
  // B964-1
  "assertSafeAddress",
  "addressViolation",
  "assertSafeLicense",
  "licenseViolation",
  "assertSafeBuyerName",
  "safeBuyerDisplayName",
  "isFormulaLedText",
  // B984
  "assertSafePersonName",
  "personNameViolation",
  // B964-2
  "assertSafeProductNames",
  "productNameViolation",
];

/** file (relative to src/) -> why an unguarded write of the fields there is safe. */
const EXEMPT: Record<string, string> = {
  // (B964-1 closed the tenant-mirror's admin-username path: it falls back to the guarded tenant name, so it calls the guard.)
  "tracked-categories/tracked-categories.service.ts":
    "its product.updateMany writes Product.category (a subcategory rename mirrored onto products), NOT Product.name: the scan " +
    "matches the local variable `name`; the category mirror is its own LOW, tracked separately",
};

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** The text of the balanced `( … )` call that opens at `open` (index of the "("). */
function callBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Files that write a guarded field of a guarded model, with the model.field that triggered it. */
function writers(): { file: string; hit: string }[] {
  const found: { file: string; hit: string }[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const [model, fields] of Object.entries(GUARDED)) {
      const call = new RegExp(`\\.${model}\\.(create|createMany|update|updateMany|upsert)\\(`, "g");
      for (let m = call.exec(text); m; m = call.exec(text)) {
        const body = callBody(text, m.index + m[0].length - 1);
        const field = fields.find((f) => new RegExp(`\\b${f}\\b`).test(body));
        if (field)
          // `/`-separated whatever the OS (the EXEMPT keys and the expectations below are)
          found.push({
            file: path
              .slice(SRC.length + 1)
              .split("\\")
              .join("/"),
            hit: `${model}.${field}`,
          });
      }
    }
  }
  return found;
}

describe("text-cell writer scan (B956)", () => {
  const hits = writers();

  it("finds the known writers (the scan itself is not vacuous)", () => {
    const files = new Set(hits.map((h) => h.file));
    expect(files).toContain("customers/customers.service.ts");
    expect(files).toContain("import/import.service.ts");
    expect(files).toContain("platform-admin/tenant-mirror.service.ts");
    expect(hits).toContainEqual({ file: "tenants/tenants.service.ts", hit: "tenant.name" });
    expect(hits).toContainEqual({
      file: "tenants/tenants.service.ts",
      hit: "tenantConfig.businessName",
    });
    expect(hits).toContainEqual({
      file: "platform-admin/platform-admin.service.ts",
      hit: "tenantConfig.businessName",
    });
    expect(hits).toContainEqual({
      file: "platform-admin/platform-admin.service.ts",
      hit: "tenant.name",
    });
  });

  it("every writer of a guarded field calls the shared guard or is explicitly exempt", () => {
    const unguarded = [...new Set(hits.map((h) => h.file))].filter((file) => {
      if (EXEMPT[file]) return false;
      const text = readFileSync(join(SRC, file), "utf8");
      return !GUARD_CALLS.some((g) => text.includes(g));
    });
    expect(unguarded).toEqual([]);
  });

  it("B964-1: the new doors are all found AND guarded (addresses, license numbers, buyer names)", () => {
    const files = new Set(hits.map((h) => h.file));
    for (const f of [
      "customers/customers.service.ts",
      "import/import.service.ts",
      "authorizations/authorizations.service.ts",
      "buyer/buyer-auth.service.ts",
      "buyer/buyer-admin.service.ts",
      "auth/google-oauth.service.ts",
      "auth/apple-oauth.service.ts",
    ]) {
      expect(files).toContain(f);
    }
    expect(hits).toContainEqual({
      file: "customers/customers.service.ts",
      hit: "customerAddress.label",
    });
    expect(hits).toContainEqual({ file: "buyer/buyer-auth.service.ts", hit: "buyerAccount.name" });
  });

  it("B964-2: the product-name writers are found and guarded (a NEW unguarded writer, e.g. #2881's family create, turns the scan red)", () => {
    const files = new Set(hits.map((h) => h.file));
    for (const f of [
      "products/products.service.ts",
      "import/import.service.ts",
      "inventory/inventory.service.ts",
    ]) {
      expect(files).toContain(f);
    }
    expect(hits).toContainEqual({ file: "products/products.service.ts", hit: "product.name" });
  });

  it("every EXEMPT entry still names a real writer (no stale exemptions)", () => {
    const files = new Set(hits.map((h) => h.file));
    for (const file of Object.keys(EXEMPT)) expect(files).toContain(file);
  });
});
