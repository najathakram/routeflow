import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * Row 562 S1 pin: every StockCountLine is created by exactly two places - the batched seeder
 * (`stock-count-seed.ts`: the amend, and later the reset and its undo) and `upsertStockCountLine` (one line
 * a person adds). A third writer would skip the seeder's rules: the sorted `stock-count-product` locks, the
 * one-open-count-per-product re-check under them, and the live-stock baseline stamp. A NESTED write
 * (`lines: { create }` under a session) is a writer too, and a worse one: it bypasses the tenant extension's
 * tenantId injection, so the row lands invisible to `forTenant()` (catalog.prisma, StockCountLine doc).
 *
 * Test support under a `testing/` folder builds fixtures straight into the table on purpose and is skipped.
 */
const SRC = join(__dirname, "..");
const SEEDER = join(__dirname, "stock-count-seed.ts");
const SERVICE = join(__dirname, "inventory.service.ts");
const UPSERT = "upsertStockCountLine";

const WRITERS: Array<[RegExp, string]> = [
  [
    /\bstockCountLine\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/,
    "stockCountLine.create/createMany/upsert",
  ],
  [/INSERT\s+INTO\s+"?StockCountLine"?/i, "raw INSERT INTO StockCountLine"],
  [/\blines\s*:\s*\{\s*(create|createMany|connectOrCreate)\b/, "nested lines: { create }"],
];

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The shapes of StockCountLine writes found in `text` (comments ignored). */
export function lineWritersIn(text: string): string[] {
  const code = stripComments(text);
  return WRITERS.filter(([re]) => re.test(code)).map(([, why]) => why);
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      return name === "node_modules" || name === "testing" ? [] : sources(abs);
    }
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [abs] : [];
  });
}

/** The text of one service method: from its signature to the next member at the class's indent. */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/\n  (?:\/\*\*|async |private |public )/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Row 562 pin: a StockCountLine is created only by the seeder and upsertStockCountLine", () => {
  it("the detector sees every writer shape and ignores reads, updates and comments (self-test)", () => {
    expect(lineWritersIn("await tx.stockCountLine.create({ data });")).toHaveLength(1);
    expect(
      lineWritersIn("this.prisma.forTenant().stockCountLine.createMany({ data })"),
    ).toHaveLength(1);
    expect(lineWritersIn("tx . stockCountLine . upsert (\n{})")).toHaveLength(1);
    expect(
      lineWritersIn('await tx.$executeRaw`INSERT INTO "StockCountLine" (id) VALUES (1)`'),
    ).toHaveLength(1);
    expect(
      lineWritersIn("stockCountSession.create({ data: { lines: { create: [{ productId }] } } })"),
    ).toHaveLength(1);
    expect(lineWritersIn("await tx.stockCountLine.findMany({ where });")).toHaveLength(0);
    expect(lineWritersIn("await tx.stockCountLine.update({ where, data });")).toHaveLength(0);
    expect(lineWritersIn("await tx.stockCountLine.deleteMany({ where });")).toHaveLength(0);
    expect(
      lineWritersIn("// tx.stockCountLine.create({}) was the old way\nconst a = 1;"),
    ).toHaveLength(0);
    expect(lineWritersIn("/* stockCountLine.createMany( */ const a = 1;")).toHaveLength(0);
  });

  it("no api source writes a StockCountLine outside the seeder and upsertStockCountLine", () => {
    const offenders = sources(SRC)
      .filter((f) => f !== SEEDER && f !== SERVICE)
      .flatMap((f) =>
        lineWritersIn(readFileSync(f, "utf8")).map(
          (why) => `${relative(SRC, f).split(sep).join("/")}: ${why}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("inventory.service.ts writes a line in upsertStockCountLine only, exactly once", () => {
    const src = stripComments(readFileSync(SERVICE, "utf8"));
    const body = methodBody(src, UPSERT);
    expect(body).toContain("tx.stockCountLine.create(");
    expect(lineWritersIn(body)).toEqual(["stockCountLine.create/createMany/upsert"]);
    expect(body.match(/stockCountLine\s*\.\s*create\s*\(/g)).toHaveLength(1);
    // everything else in the file: no writer
    expect(lineWritersIn(src.replace(body, ""))).toEqual([]);
  });

  it("the seeder writes through createMany(skipDuplicates) after its locks and conflict re-check", () => {
    const src = stripComments(readFileSync(SEEDER, "utf8"));
    const lock = src.search(/advisoryXactLocks\(/);
    const conflict = src.search(/await findOpenCountConflicts\(tx/);
    const stamp = src.search(/product\.findMany\(/);
    const write = src.search(/stockCountLine\.createMany\(/);
    expect(lock).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(lock);
    expect(stamp).toBeGreaterThan(conflict);
    expect(write).toBeGreaterThan(stamp);
    expect(src).toMatch(/skipDuplicates: true/);
    expect(src).not.toMatch(/stockCountLine\s*\.\s*create\s*\(/);
  });
});
