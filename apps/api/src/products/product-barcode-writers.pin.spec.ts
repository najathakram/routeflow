/**
 * SA-983 section 1 (row 561, risk b): the ProductBarcode WRITER pin, count-pinned (OP-7, shrink-only, in the style of
 * no-bare-cron.spec.ts).
 *
 * `syncProductBarcodesFromLegacy` still FULL-REPLACES a product's barcode rows: it reads every live row, diffs it against
 * `planBarcodeRows`, and deletes whatever the plan does not produce (product-catalog-sync.ts:238-300). That is safe today
 * ONLY because every live row on master is a legacy mirror the sync itself wrote: the sync's `createMany` is the one
 * writer, nothing writes `ProductBarcode.productUnitId`. The day a second writer lands (a level barcode, SA-826 item 9,
 * slices 7 and 9) the replace would delete its rows. This pin turns that latent loss into a red build:
 *
 *   1. a CREATE-class call (`create / createMany / createManyAndReturn / upsert`) on the `productBarcode` delegate exists
 *      ONLY in product-catalog-sync.ts, once.
 *   2. an UPDATE-class call (`update / updateMany / updateManyAndReturn`) exists only on the pinned list (today 2), and NO
 *      write call anywhere names `productUnitId` (the write the sync's replace would then delete).
 *   3. the delegate is never aliased (`const d = tx.productBarcode`, a destructure, `tx["productBarcode"]`), so a call
 *      through the alias cannot slip past 1 and 2.
 *   4. no NESTED write reaches it through a relation (`barcodes: { create | update | delete | set ... }` on a Product or
 *      ProductUnit write).
 *   5. no RAW `INSERT INTO` / `UPDATE` of ProductBarcode (quoted or not, schema-qualified or not) exists in apps/api/src or
 *      apps/api/scripts.
 *   6. every ProductBarcode DELETE (delegate or raw `DELETE FROM`) is on the list below (today 4). In the MUST 8 PR (the
 *      first level-code writer) each one either gains `productUnitId: null` or is ruled for levels on its own line; a
 *      released LEVEL row is deleted by the sync's `code: null` delete today, the same class as the live replace.
 *
 * The first level-code writer then fails the build until the narrowing lands with it. The call-block scanners are the
 * shared ones the family-price tripwires use (`tripwire-scan.ts`), not a second hand regex.
 */
import * as fs from "fs";
import * as path from "path";
import { WRITE_METHODS, balancedGeneric, callBlocks } from "./tripwire-scan";

const SRC_ROOT = path.resolve(__dirname, "..");
const API_ROOT = path.resolve(SRC_ROOT, "..");

/** Directories that hold no live writer: build output, deps, docs, test trees and fixtures, and SQL-only migrations. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "docs",
  "test",
  "testing",
  "migrations",
  ".turbo",
]);

/**
 * Non-spec source files (any .ts / .js / .mjs / .cjs) under the whole API package, so a writer in `prisma/` (the catalog
 * backfill), `scripts/`, `src/` or a root file is in the walk (review-d MUST 2), not just the two directories first listed.
 */
function files(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) files(full, out);
    } else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Code only: whole-line and trailing `//` comments and block comments are dropped before matching. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/\s\/\/.*$/, "")))
    .join("\n");
}

const CREATE_METHODS = ["create", "createMany", "createManyAndReturn", "upsert"];
const UPDATE_METHODS = ["update", "updateMany", "updateManyAndReturn"];
const DELETE_METHODS = ["delete", "deleteMany"];
/** The delegate named any way but a call: `x = tx.productBarcode;`, `{ productBarcode } = tx`, `tx["productBarcode"]`. */
const ALIASES = [
  // `state.productBarcode` is scripts/qa-run.js's plain scanned-code string, not the delegate.
  /(?<!\bstate)\.productBarcode\b(?!\s*\.\s*\w+\s*\()/g,
  /\{[^{}]*\bproductBarcode\b[^{}]*\}\s*=/g,
  /\[\s*["'`]productBarcode["'`]\s*\]/g,
];
const NESTED_KEY = /\bbarcodes\s*:\s*\{/g;
const NESTED_WRITE =
  /\b(create|createMany|connectOrCreate|upsert|update|updateMany|delete|deleteMany|set|connect|disconnect)\s*:/;
// A table name, optionally schema-qualified, each part quoted or not (`"public"."ProductBarcode"`, `ProductBarcode`).
const RAW = (verb: string) =>
  new RegExp(
    `\\b${verb}\\s+(?:ONLY\\s+)?(?:"?\\w+"?\\s*\\.\\s*)?"?ProductBarcode"?(?![\\w"])`,
    "gi",
  );
const RAW_INSERT = RAW("INSERT\\s+INTO");
const RAW_UPDATE = RAW("UPDATE");
const RAW_DELETE = RAW("(?:DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)");

const matches = (re: RegExp, text: string) =>
  (text.match(new RegExp(re.source, re.flags)) ?? []).length;
const calls = (code: string, methods: string[]) => callBlocks(code, "productBarcode", methods);

interface Tally {
  creates: number;
  updates: number;
  unitWrites: number;
  deletes: number;
  aliases: number;
  nested: number;
  rawInsert: number;
  rawUpdate: number;
}

/** Everything this pin counts, in one text. */
export function tally(text: string): Tally {
  const code = codeOf(text);
  const writes = calls(code, WRITE_METHODS);
  let nested = 0;
  for (const m of code.matchAll(NESTED_KEY)) {
    const body = balancedGeneric(code, (m.index ?? 0) + m[0].length - 1, "{", "}");
    if (NESTED_WRITE.test(body)) nested++;
  }
  return {
    creates: calls(code, CREATE_METHODS).length,
    updates: calls(code, UPDATE_METHODS).length,
    unitWrites: writes.filter((b) => /\bproductUnitId\b/.test(b)).length,
    deletes: calls(code, DELETE_METHODS).length + matches(RAW_DELETE, code),
    aliases: ALIASES.reduce((n, re) => n + matches(re, code), 0),
    nested,
    rawInsert: matches(RAW_INSERT, code),
    rawUpdate: matches(RAW_UPDATE, code),
  };
}

/** every create-class writer, per file */
const PINNED_CREATES: Record<string, [number, string]> = {
  "src/products/product-catalog-sync.ts": [
    1,
    "the mirror sync's createMany: the one runtime writer",
  ],
  "prisma/backfill-product-catalog-rows.ts": [
    1,
    "a one-off, insert-only backfill of legacy level rows for a product with none (skipDuplicates); writes no productUnitId",
  ],
};

/** every update-class write, per file (they set code / retiredCode only; none names productUnitId) */
const PINNED_UPDATES: Record<string, [number, string]> = {
  "src/products/product-code-release.ts": [
    2,
    "retire / restore a product's own code on deactivate and reactivate: sets code and retiredCode, never productUnitId",
  ],
};

/** every ProductBarcode DELETE, per file, with what it removes */
const PINNED_DELETES: Record<string, [number, string]> = {
  "src/products/product-catalog-sync.ts": [
    2,
    "syncProductBarcodesFromLegacy: the live replace (rows the plan does not produce) and the released rows (code: null); both must gain productUnitId: null in the MUST 8 PR",
  ],
  "src/products/product-code-release.ts": [
    1,
    "reactivate: deletes a product's retired rows (retiredCode) before restoring its own code",
  ],
  "scripts/propose-pack-sizes.mjs": [
    1,
    "a one-off repair script's raw DELETE of a product's rows; narrows in the same PR as the sync",
  ],
};

const pinnedCount = (m: Record<string, [number, string]>) =>
  Object.fromEntries(Object.entries(m).map(([f, [n]]) => [f, n]));

/** Every way the pin can be broken, given `{ repo-relative path: source }`. Empty = green. */
export function violations(sources: Record<string, string>): string[] {
  const out: string[] = [];
  const perFile = (pick: (t: Tally) => number) =>
    Object.fromEntries(
      Object.entries(sources)
        .map(([f, text]) => [f, pick(tally(text))] as const)
        .filter(([, n]) => n > 0),
    );
  const same = (label: string, got: Record<string, number>, want: Record<string, number>) => {
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want).sort()))
      out.push(`${label}: found ${JSON.stringify(got)}, pinned ${JSON.stringify(want)}`);
  };
  same(
    "create-class writers",
    perFile((t) => t.creates),
    pinnedCount(PINNED_CREATES),
  );
  same(
    "update-class writers",
    perFile((t) => t.updates),
    pinnedCount(PINNED_UPDATES),
  );
  same(
    "writes naming productUnitId",
    perFile((t) => t.unitWrites),
    {},
  );
  same(
    "delegate aliases",
    perFile((t) => t.aliases),
    {},
  );
  same(
    "nested barcodes writes",
    perFile((t) => t.nested),
    {},
  );
  same(
    "raw INSERT INTO",
    perFile((t) => t.rawInsert),
    {},
  );
  same(
    "raw UPDATE",
    perFile((t) => t.rawUpdate),
    {},
  );
  same(
    "deletes",
    perFile((t) => t.deletes),
    pinnedCount(PINNED_DELETES),
  );
  return out;
}

const rel = (f: string) => path.relative(API_ROOT, f).split(path.sep).join("/");
const realSources = () =>
  Object.fromEntries(files(API_ROOT).map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

describe("SA-983: the ProductBarcode writers are count-pinned", () => {
  it("the repo is green: one create-class writer, the pinned updates and deletes, nothing else", () => {
    expect(violations(realSources())).toEqual([]);
  });

  it("each pinned update and delete carries a reason, and the totals are the ruled 2 and 4", () => {
    for (const [, why] of [...Object.values(PINNED_UPDATES), ...Object.values(PINNED_DELETES)])
      expect(why.length).toBeGreaterThan(30);
    expect(Object.values(PINNED_UPDATES).reduce((a, [n]) => a + n, 0)).toBe(2);
    expect(Object.values(PINNED_DELETES).reduce((a, [n]) => a + n, 0)).toBe(4);
  });

  it("the scan covered the sync and the code-release module (guards a path typo turning it vacuous)", () => {
    const sources = realSources();
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([
        "src/products/product-catalog-sync.ts",
        "src/products/product-code-release.ts",
        "scripts/propose-pack-sizes.mjs",
        "prisma/backfill-product-catalog-rows.ts",
      ]),
    );
    expect(tally(sources["src/products/product-catalog-sync.ts"]).creates).toBe(1);
  });
});

/**
 * Review (MacBook P2, MUST): a pin that stays GREEN against a bypass is no pin. Each shape below is planted into an
 * otherwise-green source set as a NEW file and must turn `violations` red; the same shape is also planted into the
 * pinned sync file where that matters (a second writer there would still be a second writer).
 */
describe("SA-983: each bypass shape turns the pin red", () => {
  const green = realSources();
  const plant = (src: string, into = "src/products/zz-planted.ts") => ({ ...green, [into]: src });

  it("starts green, so a red below is the planted shape's doing", () => {
    expect(violations(green)).toEqual([]);
  });

  it.each([
    ["createManyAndReturn", "await tx.productBarcode.createManyAndReturn({ data });"],
    ["a plain create", "await tx.productBarcode.create({ data });"],
    ["an upsert", "await prisma.productBarcode.upsert({ where, create, update });"],
    [
      "an update that sets productUnitId",
      "await tx.productBarcode.update({ where, data: { productUnitId: u } });",
    ],
    ["an updateMany", "await tx.productBarcode.updateMany({ where, data: { code: null } });"],
    [
      "a nested barcodes create",
      "await tx.product.update({ where, data: { barcodes: { create: [{ code }] } } });",
    ],
    [
      "a nested barcodes deleteMany",
      "await tx.productUnit.update({ where, data: { barcodes: { deleteMany: {} } } });",
    ],
    ["an alias", "const d = tx.productBarcode;\nawait d.create({ data });"],
    [
      "a destructured alias",
      "const { productBarcode } = tx;\nawait productBarcode.create({ data });",
    ],
    ["a string-keyed alias", 'await tx["productBarcode"].create({ data });'],
    [
      "a raw UPDATE",
      'await tx.$executeRaw`UPDATE "ProductBarcode" SET "productUnitId" = ${u} WHERE id = ${id}`;',
    ],
    ["an unquoted raw UPDATE", "await db.query('UPDATE ProductBarcode SET code = $1');"],
    [
      "a quoted raw INSERT",
      'await tx.$executeRaw`INSERT INTO "ProductBarcode" (id) VALUES (${id})`;',
    ],
    ["an UNQUOTED raw INSERT", "await db.query('INSERT INTO ProductBarcode (id) VALUES ($1)');"],
    [
      "a schema-qualified raw INSERT",
      "await db.query('INSERT INTO public.\"ProductBarcode\" (id) VALUES ($1)');",
    ],
    ["a new delete", "await tx.productBarcode.deleteMany({ where: { productId } });"],
    ["a raw DELETE", "await db.query('DELETE FROM ProductBarcode WHERE id = $1');"],
    // review-d P1 (MUST 1): the call split across lines, or spaced, or optional-chained, is the same call
    ["a call split across lines", "await tx.productBarcode\n  .create({ data });"],
    ["a receiver split from its dot", "await tx\n  .productBarcode\n  .createMany({ data });"],
    ["a spaced call", "await tx.productBarcode . createMany ( { data } );"],
    ["an optional-chained call", "await tx?.productBarcode?.create?.({ data });"],
    ["a non-null receiver", "await tx.productBarcode!.upsert({ where, create, update });"],
    ["a bracket-named method", 'await tx.productBarcode["createMany"]({ data });'],
    [
      "a multi-line updateMany",
      "await tx.productBarcode\n  .updateMany({ where, data: { productUnitId: u } });",
    ],
    ["a multi-line delete", "await tx.productBarcode\n  .deleteMany({ where });"],
    [
      "a quoted schema in a raw INSERT",
      'await db.query(\'INSERT INTO "public"."ProductBarcode" (id) VALUES ($1)\');',
    ],
    [
      "a raw INSERT split over lines",
      'await db.query(`INSERT INTO\n  "ProductBarcode" (id) VALUES ($1)`);',
    ],
    ["a raw TRUNCATE", "await db.query('TRUNCATE TABLE \"ProductBarcode\"');"],
  ])("%s", (_name, src) => {
    expect(violations(plant(src)).length).toBeGreaterThan(0);
  });

  it("a live writer under prisma/ is inside the walk and red until pinned (review-d MUST 2)", () => {
    expect(
      violations(plant("await tx.productBarcode.createMany({ data });", "prisma/zz-planted.ts"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("a second writer inside the pinned sync file is still red", () => {
    const sync = green["src/products/product-catalog-sync.ts"];
    expect(
      violations(
        plant(
          `${sync}\nawait tx.productBarcode.createMany({ data: other });`,
          "src/products/product-catalog-sync.ts",
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("reads, comments and unrelated relations stay green", () => {
    expect(
      violations(
        plant(
          [
            "await tx.productBarcode.findMany({ where });",
            "await tx.productBarcode.count({ where });",
            "// await tx.productBarcode.create({ data });",
            '/* INSERT INTO "ProductBarcode" */',
            "const rows = await tx.product.findMany({ include: { barcodes: { orderBy: { level: 'asc' } } } });",
            "const sel = { barcodes: { select: { code: true } } };",
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });
});
