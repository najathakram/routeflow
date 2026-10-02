import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { opaqueProductWrites } from "./tripwire-scan";

/**
 * SA-584 C1 (#2717 M2 fold): `Product.familyPriceOverride` has NO writer in M2 (no DTO field, no
 * service write), so Q10's override branch — a recipe product may keep a `unitsPerPack` that
 * differs from the family's `unitsPerBox` ONLY because it owns its own price — cannot be reached.
 * The day a writer appears it can flip the flag on a recipe whose pack size differs from the family
 * box size without any pack check. So: no writer of `familyPriceOverride` outside ALLOW (EMPTY).
 *
 * The scan reads the source at test time (L-206): apps/api/src, apps/api/scripts and apps/api/prisma,
 * non-spec files. A "writer" is any of:
 *   - a `data:` object of a `.product|.products|.recipe` create/update/upsert/createMany/updateMany
 *     call that names the key (a `where:` mention is a read and is ignored);
 *   - a DTO class field of that name (a request could then carry the write);
 *   - the quoted SQL identifier "familyPriceOverride" anywhere outside migrations.
 */
const API_ROOT = join(__dirname, "..", "..");
const KEY = "familyPriceOverride";
const WRITE_METHODS = ["create", "update", "upsert", "createMany", "updateMany"];

/** file (relative to apps/api) -> the reason it may write the flag. EMPTY on purpose. */
const ALLOW: Record<string, string> = {};

/**
 * SA-587 lead LOW: the `data:` scan above only sees a LITERAL object. A Product write whose data is a
 * variable or carries a spread (`const patch = { familyPriceOverride: true }; ...update({ data: patch })`)
 * hides the key. Every such write (file relative to apps/api -> EXACT count, with a reason none of them can
 * carry the flag) is listed here; a new one, or one more in a listed file, fails.
 */
export const OPAQUE_ALLOW: Record<string, { count: number; reason: string }> = {
  "src/inventory/inventory.service.ts": {
    count: 3,
    reason:
      "createVariantRowInTx spreads the family's five price columns and a cost-basis `data`; " +
      "neither names familyPriceOverride (the flag has no writer in M2, SA-584a).",
  },
  "src/products/product-code-release.ts": {
    count: 2,
    reason:
      "releaseLive / restoreProductCodes build `data` from the three code columns and their retired* " +
      "twins only (sku, barcode, unitSku); no price, tier or family column is ever named.",
  },
  "src/products/family-price.ts": {
    count: 2,
    reason:
      "propagateFamilyPrice copies pickPriceColumns (five price columns only) onto variants and " +
      "non-override recipe products; it reads the flag in its where, never writes it.",
  },
  "src/products/products.service.ts": {
    count: 2,
    reason:
      "create/update write a `data` built from the typed DTO, which has no familyPriceOverride " +
      "field (pinned by the DTO scan above), after the family-price routing.",
  },
  "scripts/demo-seed.js": {
    count: 2,
    reason:
      "Seeds the routeflow-demo tenant only: batch rows built in the script and a demo row " +
      "re-write; none sets the override flag.",
  },
  "scripts/reset-seed.js": {
    count: 1,
    reason: "Seed script for a scratch/test database: spreads its own dummy product rows, no flag.",
  },
  "scripts/sales-facts-timing.ts": {
    count: 1,
    reason: "Timing harness creating synthetic products in a test tenant via a map; no flag.",
  },
  "scripts/seed-marketing-screenshot-products.js": {
    count: 2,
    reason: "Marketing-screenshot seed for the demo tenant: definitional fields only, no flag.",
  },
  "scripts/seed-test-catalog.js": {
    count: 2,
    reason: "Seeds the approved test tenant catalog: definitional fields only, no flag.",
  },
};

export function opaqueViolations(
  found: Map<string, number>,
  allow: Record<string, { count: number; reason: string }>,
): string[] {
  const out: string[] = [];
  for (const [file, n] of found) {
    if (!(file in allow)) out.push(`${file}: ${n} (not allow-listed)`);
    else if (allow[file].count !== n) out.push(`${file}: found ${n}, allowed ${allow[file].count}`);
  }
  for (const [file, { count }] of Object.entries(allow)) {
    if (!found.has(file)) out.push(`${file}: allow-listed ${count} but none found (stale)`);
  }
  return out;
}

export const REMEDIATION =
  "familyPriceOverride now has a writer. Before it can land you MUST re-run the Q10 pack check " +
  "(SA-574 Q10 / SA-584 C1): flipping the flag to true is what lets a recipe's unitsPerPack differ " +
  "from the family's unitsPerBox, and flipping it back to false on a recipe whose unitsPerPack " +
  "differs must give 409 (a false-flip with unitsPerPack != the family upb). Add the check and its " +
  "pin, then list the file in ALLOW with the reason.";

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "migrations" || entry === "dist") continue;
      out.push(...listFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry) && !/\.spec\.ts$|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function balanced(text: string, openIdx: number, open: string, close: string): string {
  let depth = 1;
  let i = openIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === open) depth++;
    else if (text[i] === close) depth--;
    i++;
  }
  return text.slice(openIdx, i);
}

/** Every `data: { ... }` object (balanced braces) inside the call blocks of the write methods. */
function dataObjects(text: string): string[] {
  const out: string[] = [];
  for (const receiver of ["product", "products", "recipe"]) {
    for (const method of WRITE_METHODS) {
      const needle = `.${receiver}.${method}(`;
      let from = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx === -1) break;
        const call = balanced(text, idx + needle.length - 1, "(", ")");
        const dataAt = call.search(/\bdata\s*:\s*\{/);
        if (dataAt !== -1) {
          const brace = call.indexOf("{", dataAt);
          out.push(balanced(call, brace, "{", "}"));
        }
        from = idx + needle.length;
      }
    }
  }
  return out;
}

export function familyPriceOverrideWriters(file: string, text: string): string[] {
  const hits: string[] = [];
  const keyed = new RegExp(`(^|[\\s{,])${KEY}\\s*[:,}]`, "m");
  if (dataObjects(text).some((d) => keyed.test(d))) hits.push("data: object");
  if (/\/dto\//.test(file.split("\\").join("/")) && text.includes(KEY)) hits.push("dto field");
  if (text.includes(`"${KEY}"`)) hits.push("quoted SQL identifier");
  return hits;
}

describe("familyPriceOverride writer tripwire (SA-584 C1)", () => {
  const files = [
    ...listFiles(join(API_ROOT, "src")),
    ...listFiles(join(API_ROOT, "scripts")),
    ...listFiles(join(API_ROOT, "prisma")),
  ];
  const rel = (f: string) => relative(API_ROOT, f).split("\\").join("/");

  it("scans a non-trivial tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("the allow-list is empty (adding to it is a deliberate, reviewed act)", () => {
    expect(Object.keys(ALLOW)).toEqual([]);
  });

  it("no non-spec source writes familyPriceOverride", () => {
    const offenders = files
      .map((f) => ({ file: rel(f), how: familyPriceOverrideWriters(f, readFileSync(f, "utf8")) }))
      .filter((o) => o.how.length > 0 && !(o.file in ALLOW));
    if (offenders.length > 0) {
      throw new Error(`${REMEDIATION}\nWriters: ${JSON.stringify(offenders)}`);
    }
  });

  it("the scan is not vacuous: it sees a synthetic writer of each kind and ignores a read", () => {
    const create = `await tx.product.create({ data: { name: "x", ${KEY}: true } });`;
    const update = `await this.prisma.forTenant().product.update({ where: { id }, data: { ${KEY}: dto.flag } });`;
    const many = `await tx.product.updateMany({ where: { tenantId, ${KEY}: false }, data: { pricePerUnit: p } });`;
    const shorthand = `await tx.product.update({ where: { id }, data: { ${KEY} } });`;
    expect(familyPriceOverrideWriters("src/x.ts", create)).toEqual(["data: object"]);
    expect(familyPriceOverrideWriters("src/x.ts", update)).toEqual(["data: object"]);
    expect(familyPriceOverrideWriters("src/x.ts", shorthand)).toEqual(["data: object"]);
    expect(familyPriceOverrideWriters("src/x.ts", many)).toEqual([]);
    expect(familyPriceOverrideWriters("src/products/dto/x.dto.ts", `${KEY}?: boolean;`)).toEqual([
      "dto field",
    ]);
    expect(
      familyPriceOverrideWriters("scripts/x.js", `UPDATE "Product" SET "${KEY}" = true`),
    ).toEqual(["quoted SQL identifier"]);
  });

  it("no variable/spread Product write exists outside OPAQUE_ALLOW (file + exact count + reason)", () => {
    const found = new Map<string, number>();
    for (const f of files) {
      const n = opaqueProductWrites(readFileSync(f, "utf8")).length;
      if (n > 0) found.set(rel(f), n);
    }
    expect(opaqueViolations(found, OPAQUE_ALLOW)).toEqual([]);
    for (const { reason } of Object.values(OPAQUE_ALLOW)) expect(reason.length).toBeGreaterThan(20);
  });

  it("the opaque scan is not vacuous: a variable that carries the flag is caught, and the count check bites", () => {
    const variable = `const patch = { ${KEY}: true };\nawait tx.product.update({ where: { id }, data: patch });`;
    const spread = `await tx.product.update({ where: { id }, data: { ...dto } });`;
    expect(opaqueProductWrites(variable)).toHaveLength(1);
    expect(opaqueProductWrites(spread)).toHaveLength(1);
    expect(familyPriceOverrideWriters("src/x.ts", variable)).toEqual([]); // the literal scan alone misses it
    const allow = { "src/x.ts": { count: 1, reason: "r".repeat(30) } };
    expect(opaqueViolations(new Map([["src/x.ts", 1]]), allow)).toEqual([]);
    expect(opaqueViolations(new Map([["src/x.ts", 2]]), allow)).toHaveLength(1);
    expect(opaqueViolations(new Map([["src/y.ts", 1]]), allow)).toHaveLength(2);
  });

  it("the failure text tells a future writer to re-run the Q10 pack check", () => {
    expect(REMEDIATION).toMatch(/Q10 pack check/);
    expect(REMEDIATION).toMatch(/409/);
  });
});
