import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * T10 (#2728 M1 build-plan, SA-572b Q6): every `.product.(create|update|upsert|createMany|
 * updateMany)(` call anywhere under apps/api/src (non-spec) that writes `barcode` or `imageKeys` as
 * a data key must be in the allow-list below, AND that allow-listed file must call
 * syncProductBarcodesFromLegacy (for a `barcode` write) / syncProductImagesFromLegacy (for an
 * `imageKeys` write) — the dual-write helpers in product-catalog-sync.ts. A NEW writer that forgets
 * to sync fails this spec instead of silently drifting the legacy column from the row mirror.
 *
 * migration.service.ts is deliberately NOT in the allow-list: its PRODUCT commit path calls
 * `this.products.create(...)` (ProductsService, already covered) rather than writing
 * `.product.create(` directly — see products.service.ts's own writer.
 */
const SRC_ROOT = join(__dirname, "..", "..", "src");

const ALLOW_LIST = new Set(["products/products.service.ts", "import/import.service.ts"]);

const WRITE_METHODS = ["create", "update", "upsert", "createMany", "updateMany"];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** From the position right after `.product.<method>(`, find the matching close paren (balanced). */
function extractBalancedCall(text: string, openParenIdx: number): string {
  let depth = 1;
  let i = openParenIdx + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    i++;
  }
  return text.slice(openParenIdx, i);
}

interface Hit {
  file: string;
  method: string;
  writesBarcode: boolean;
  writesImageKeys: boolean;
}

function findProductWriteCalls(text: string): Array<{ method: string; block: string }> {
  const hits: Array<{ method: string; block: string }> = [];
  for (const method of WRITE_METHODS) {
    const needle = `.product.${method}(`;
    let fromIdx = 0;
    for (;;) {
      const idx = text.indexOf(needle, fromIdx);
      if (idx === -1) break;
      const openParenIdx = idx + needle.length - 1;
      const block = extractBalancedCall(text, openParenIdx);
      hits.push({ method, block });
      fromIdx = idx + needle.length;
    }
  }
  return hits;
}

/** A `data:` key match that isn't inside a `where:` clause is good enough here — every real
 *  writer's `barcode`/`imageKeys` key sits directly in `data`, never in `where`, and a false
 *  positive on a `where: { barcode: ... }` filter would only make this spec MORE conservative. */
function writesKey(block: string, key: string): boolean {
  const re = new RegExp(`(^|[\\s{,])${key}\\s*:`, "m");
  return re.test(block);
}

describe("catalog-dual-write-tripwire (T10, SA-572b Q6)", () => {
  const files = listTsFiles(SRC_ROOT);
  const hitsByFile = new Map<string, Hit[]>();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const calls = findProductWriteCalls(text);
    if (calls.length === 0) continue;
    const rel = relative(SRC_ROOT, file).split("\\").join("/");
    const hits: Hit[] = [];
    for (const { method, block } of calls) {
      const writesBarcode = writesKey(block, "barcode");
      const writesImageKeys = writesKey(block, "imageKeys");
      if (writesBarcode || writesImageKeys)
        hits.push({ file: rel, method, writesBarcode, writesImageKeys });
    }
    if (hits.length > 0) hitsByFile.set(rel, hits);
  }

  it("is non-vacuous: finds at least one barcode/imageKeys-writing call in every allow-listed file", () => {
    for (const allowed of ALLOW_LIST) {
      expect(hitsByFile.get(allowed)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("no barcode/imageKeys-writing `.product.*` call exists outside the allow-list", () => {
    const offenders = [...hitsByFile.keys()].filter((f) => !ALLOW_LIST.has(f));
    expect(offenders).toEqual([]);
  });

  it("every allow-listed file with a barcode write calls syncProductBarcodesFromLegacy", () => {
    for (const [file, hits] of hitsByFile) {
      if (!ALLOW_LIST.has(file)) continue;
      if (!hits.some((h) => h.writesBarcode)) continue;
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(text.includes("syncProductBarcodesFromLegacy")).toBe(true);
    }
  });

  it("every allow-listed file with an imageKeys write calls syncProductImagesFromLegacy", () => {
    for (const [file, hits] of hitsByFile) {
      if (!ALLOW_LIST.has(file)) continue;
      if (!hits.some((h) => h.writesImageKeys)) continue;
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      expect(text.includes("syncProductImagesFromLegacy")).toBe(true);
    }
  });

  it("migration.service.ts has no direct `.product.*` write (it delegates to ProductsService.create)", () => {
    expect(hitsByFile.has("import/migration.service.ts")).toBe(false);
  });
});

/**
 * F1 (#2728 M1 follow-up, pre-merge BLOCK): `planBarcodeRows` depends on BOTH `barcode` AND
 * `unitsPerBox` — the tripwire above only watches `barcode`/`imageKeys` writes, so a writer that
 * changes `unitsPerBox` on a product that already has a barcode (and therefore ProductBarcode
 * rows) can drift those rows without ever touching `barcode` itself. `.product.updateMany(` is
 * FORBIDDEN outright when it writes `unitsPerBox` — it can't re-sync per affected row. `.product.
 * update(`/`upsert(` writing `unitsPerBox` must be allow-listed AND its file must call
 * `syncProductBarcodesFromLegacy`. `.product.create`/`createMany` are deliberately excluded: a
 * create with no barcode has no rows to drift, and a create writing both keys is already covered
 * by the barcode tripwire above.
 */
const UNITS_PER_BOX_METHODS = ["update", "upsert", "updateMany"];
const UNITS_PER_BOX_ALLOW_LIST = new Set([
  "products/products.service.ts",
  "import/variant-resolution.service.ts",
  // Units U-2: the ladder PUT sets unitsPerBox from the chosen pack level, then calls the sync helper.
  "products/product-units.service.ts",
]);

describe("catalog-dual-write-tripwire: unitsPerBox writers must sync barcode rows (F1)", () => {
  const files = listTsFiles(SRC_ROOT);
  const upbHitsByFile = new Map<string, string[]>();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const calls = findProductWriteCalls(text).filter((c) =>
      UNITS_PER_BOX_METHODS.includes(c.method),
    );
    const methods = calls.filter((c) => writesKey(c.block, "unitsPerBox")).map((c) => c.method);
    if (methods.length === 0) continue;
    const rel = relative(SRC_ROOT, file).split("\\").join("/");
    upbHitsByFile.set(rel, methods);
  }

  it("is non-vacuous: finds at least one unitsPerBox update/upsert/updateMany site", () => {
    const total = [...upbHitsByFile.values()].reduce((n, methods) => n + methods.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("no `.product.updateMany(` call writes unitsPerBox (can't re-sync per row)", () => {
    const offenders = [...upbHitsByFile.entries()]
      .filter(([, methods]) => methods.includes("updateMany"))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("every unitsPerBox update/upsert site is allow-listed and its file calls syncProductBarcodesFromLegacy", () => {
    const offenders: string[] = [];
    for (const [file, methods] of upbHitsByFile) {
      if (!methods.some((m) => m === "update" || m === "upsert")) continue;
      if (!UNITS_PER_BOX_ALLOW_LIST.has(file)) {
        offenders.push(file);
        continue;
      }
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      if (!text.includes("syncProductBarcodesFromLegacy")) offenders.push(`${file} (no sync call)`);
    }
    expect(offenders).toEqual([]);
  });
});
