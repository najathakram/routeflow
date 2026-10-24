/**
 * #2645 / SA-523d — coverage tripwire for the invoice CAS basis. The CAS in `bumpInvoicedQtyCas` pins
 * `INVOICE_LINE_CAS_FIELDS`; it is only complete if it names EVERY OrderItem column the invoice line
 * is built from. This scans `buildInvoiceItemData` (invoices.service.ts) and the two helpers it hands
 * the row to (`billPackOf`, `assertIntegerPieces` in unit-line-bill-guard.ts) for `li.<field>` reads
 * — comments stripped, relations (`li.product`) excluded — and fails on a field the const lacks. It
 * also fails on a const entry that is not a real OrderItem scalar column (a typo would be a Prisma
 * error at runtime, and SA-523d's own `taxRate` was one — SA-E86).
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { INVOICE_LINE_CAS_FIELDS } from "./partial-invoice-cas";

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The body of a top-level function / class method named `name`, by brace matching. */
function bodyOf(src: string, signature: RegExp): string {
  const m = signature.exec(src);
  if (!m) throw new Error(`tripwire: ${signature} not found — update this spec`);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("tripwire: unbalanced braces");
}

const RELATIONS = new Set(["product"]);
/**
 * Row 510: the staff restriction-override stamp (`restrictionOverride*`) is an AUDIT ANNOTATION the builder copies
 * verbatim, never money, pack or quantity, so it is not part of the billing basis the CAS pins: a stamp added or cleared
 * between the read and the bump cannot over-bill a line (a clear by a product swap moves `productId`, which IS pinned).
 * It also could not be pinned as a plain `where` value: a NULL list column reads as `[]`, which `equals: []` never matches.
 */
const ANNOTATIONS = /^restrictionOverride/;
const readFields = (body: string) =>
  [...stripComments(body).matchAll(/\bli\??\.(\w+)/g)]
    .map((m) => m[1])
    .filter((f) => !RELATIONS.has(f) && !ANNOTATIONS.test(f));

describe("#2645 / SA-523d INVOICE_LINE_CAS_FIELDS covers the whole invoice-line basis", () => {
  const svc = readFileSync(join(__dirname, "invoices.service.ts"), "utf8");
  const guard = readFileSync(join(__dirname, "unit-line-bill-guard.ts"), "utf8");
  const bodies = {
    buildInvoiceItemData: bodyOf(svc, /\bprivate buildInvoiceItemData\(/),
    billPackOf: bodyOf(guard, /\bexport function billPackOf\(/),
    assertIntegerPieces: bodyOf(guard, /\bexport function assertIntegerPieces\(/),
  };

  it.each(Object.entries(bodies))("every li.<field> %s reads is pinned by the CAS", (_n, body) => {
    const fields = readFields(body);
    expect(fields.length).toBeGreaterThan(0); // vacuity guard: the scan really read the body
    const unpinned = [...new Set(fields)].filter(
      (f) => f !== "id" && !(INVOICE_LINE_CAS_FIELDS as readonly string[]).includes(f),
    );
    expect(unpinned).toEqual([]);
  });

  it("every INVOICE_LINE_CAS_FIELDS entry is a real OrderItem scalar column", () => {
    const schemaDir = join(__dirname, "..", "..", "prisma", "schema");
    const schema = readFileSync(join(schemaDir, "sales.prisma"), "utf8");
    const model = /model OrderItem \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const SCALARS = new Set(["String", "Int", "Decimal", "Boolean", "DateTime", "Float"]);
    // Enums may live in any domain file of the schema folder.
    const enums = new Set(
      readdirSync(schemaDir)
        .filter((f) => f.endsWith(".prisma"))
        .flatMap((f) => [...readFileSync(join(schemaDir, f), "utf8").matchAll(/^enum (\w+)/gm)])
        .map((m) => m[1]),
    );
    const columns = new Map(
      model
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter(([name, type]) => name && type && /^\w+$/.test(name))
        .map(([name, type]) => [name, type.replace(/\?$/, "")]),
    );
    for (const f of INVOICE_LINE_CAS_FIELDS) {
      const type = columns.get(f);
      expect({ f, type }).toEqual({ f, type: expect.any(String) });
      expect(SCALARS.has(type!) || enums.has(type!)).toBe(true);
    }
  });
});
