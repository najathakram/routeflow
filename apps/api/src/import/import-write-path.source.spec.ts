/**
 * SA-284 (a) + (c) source pins for the B858/B859 importers — the fleet ruling asks for these to be
 * pinned in SOURCE, on top of the behavioral pins in import-commercial-columns.spec.ts (which
 * drive the real methods against mocks). A behavioral pin proves the files it feeds; this proves
 * no code path in the method writes raw, whatever file reaches it.
 *
 *   (a) one write path: importProducts writes only through ProductsService create/update, and
 *       the commercial-column writer only through CustomersService update/setCustomerConsent.
 *   (c) averageCost is NEVER written by the importer (the ledger seeds it, SA-136).
 *
 * The pre-existing raw contact-details block in importContacts stays raw this PR (SA-284); it is
 * pinned here only to carry no commercial field.
 */
import * as fs from "fs";
import * as path from "path";

const SERVICE = fs.readFileSync(path.join(__dirname, "import.service.ts"), "utf8");
const COLUMNS = fs.readFileSync(path.join(__dirname, "import-columns.ts"), "utf8");

/** The source of one class member: from its declaration to the next member declaration. */
function memberSource(name: string): string {
  const start = SERVICE.search(new RegExp(`\\n  (?:private )?async ${name}\\(`));
  if (start < 0) throw new Error(`member ${name} not found in import.service.ts`);
  const rest = SERVICE.slice(start + 1);
  const next = rest.search(/\n {2}(?:\/\*\*|(?:private |public )?(?:async )?[A-Za-z]+\()/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Drop // and /* *\/ comments so a prose mention can never satisfy or fail a pin. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const RAW_PRODUCT_WRITE = /\.product\.(create|createMany|update|updateMany|upsert)\(/;
const COMMERCIAL_FIELDS = [
  "defaultPaymentTerms",
  "pricingTier",
  "creditLimit",
  "isTaxExempt",
  "taxId",
  "tobaccoLicenseNo",
  "tobaccoLicenseExpiry",
  "smsConsent",
  "waConsent",
  "consentUpdatedAt",
];

describe("importer write path (SA-284 a/c source pins)", () => {
  it("the member extractor finds each method and stops at the next one", () => {
    const products = memberSource("importProducts");
    expect(products).toMatch(/^ {2}async importProducts\(/);
    expect(products).not.toMatch(/async importInventory\(/);
  });

  it("importProducts has no raw prisma product write — only ProductsService create/update", () => {
    const src = code(memberSource("importProducts"));
    expect(src).not.toMatch(RAW_PRODUCT_WRITE);
    expect(src).toMatch(/this\.productsService\.create\(/);
    expect(src).toMatch(/this\.productsService\.update\(/);
  });

  it("the commercial-column writer uses no prisma client at all", () => {
    const src = code(memberSource("applyCustomerCommercialFields"));
    expect(src).not.toMatch(/this\.prisma\b/);
    expect(src).not.toMatch(/\btx\./);
    expect(src).toMatch(/this\.customersService\.update\(/);
    expect(src).toMatch(/this\.customersService\.setCustomerConsent\(/);
  });

  it("importContacts' raw contact-details writes never name a commercial field", () => {
    const src = code(memberSource("importContacts"));
    for (const field of COMMERCIAL_FIELDS) {
      expect({ field, found: new RegExp(`\\b${field}\\b`).test(src) }).toEqual({
        field,
        found: false,
      });
    }
  });

  it("nothing in the importer or its column registry writes averageCost", () => {
    expect(code(memberSource("importProducts"))).not.toMatch(/averageCost/);
    expect(code(memberSource("importContacts"))).not.toMatch(/averageCost/);
    expect(code(COLUMNS)).not.toMatch(/averageCost/);
  });
});
