/**
 * SA-1027 structural pins (no database): the script names no tenant (C-G9), and it writes none of the columns `create`
 * does not carry, because it writes no row of its own at all (C-G13): every write is a call into the app's services.
 */
import * as fs from "fs";
import * as path from "path";

const DIR = __dirname;
const CLI = path.resolve(DIR, "../../scripts/catalog-copy.mjs");
const sources = (): Array<{ file: string; text: string }> =>
  [
    ...fs
      .readdirSync(DIR)
      .filter((f) => /\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f))
      .map((f) => path.join(DIR, f)),
    CLI,
  ].map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));

const NOT_CARRIED = [
  "packAuto",
  "packLabel",
  "baseUnitLabel",
  "orderUnitRef",
  "invoiceUnitRef",
  "invoiceLineCode",
  "familyPriceOverride",
  "kind",
];

describe("SA-1027 structural pins", () => {
  it("C-G9: no tenant slug literal in the script, the module, the service or the CLI", () => {
    for (const { file, text } of sources()) {
      // a slug assigned from a literal, or a literal handed to --source / --target
      expect(text).not.toMatch(/\bslug\s*[:=]\s*["'`][a-z0-9-]+["'`]/);
      expect(text).not.toMatch(/["'`]--(source|target)["'`]\s*,\s*["'`][a-z0-9][a-z0-9-]*["'`]/);
      expect(text).not.toMatch(/\bTENANT_SLUG\b\s*=\s*["'`]/);
      expect(path.basename(file)).toBeTruthy();
    }
  });

  it("C-G13: the module writes no row of its own: no Prisma write call (every write is a service call)", () => {
    const write =
      /\b(?:prisma|tx|db)\b[\w.()]*\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
    for (const { file, text } of sources()) {
      expect({ file: path.basename(file), hit: write.test(text) }).toEqual({
        file: path.basename(file),
        hit: false,
      });
    }
  });

  it("C-G13: the product DTO the service builds names none of the columns `create` does not carry", () => {
    const service = fs.readFileSync(path.join(DIR, "catalog-copy.service.ts"), "utf8");
    const start = service.indexOf("private async createProduct(");
    const end = service.indexOf("private async copyLadder(");
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, end);
    for (const column of NOT_CARRIED) expect(body).not.toMatch(new RegExp(`\\b${column}\\b`));
  });

  /** The code with its comments removed, so a pin reads what runs and not what is explained. */
  const code = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("C-G13 (ruling 1): the service names no price column; every write input comes whole from a plan.ts builder", () => {
    const service = code(fs.readFileSync(path.join(DIR, "catalog-copy.service.ts"), "utf8"));
    expect(service).not.toMatch(/\b(?:pricePerUnit|priceTier[2-5]|packAuto)\b/);
    expect(service).not.toMatch(/\bprice\s*:/);
    for (const builder of [
      "buildProductCreateInput(",
      "buildFamilyContainerInput(",
      "buildLadderLevelInput(",
      "readPrices(",
    ]) {
      expect(service).toContain(builder);
    }
  });

  it("C-G13 (ruling 1): the plan makes no write call, and its product input names none of the columns `create` does not carry", () => {
    const plan = code(fs.readFileSync(path.join(DIR, "catalog-copy.plan.ts"), "utf8"));
    expect(plan).not.toMatch(
      /\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
    );
    expect(plan).not.toMatch(/\b(?:prisma|tx|db)\.|\bthis\./);
    const start = plan.indexOf("export function buildProductCreateInput(");
    expect(start).toBeGreaterThan(-1);
    const next = plan.indexOf("\nexport function ", start + 10);
    const body = plan.slice(start, next === -1 ? undefined : next);
    for (const column of NOT_CARRIED) expect(body).not.toMatch(new RegExp(`\\b${column}\\b`));
  });
});
