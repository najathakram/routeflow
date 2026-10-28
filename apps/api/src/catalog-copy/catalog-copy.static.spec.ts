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

/**
 * C-G19, the sweep (review-a BLOCK on #3892): every path that can write goes through the SAME guards. The writes are the
 * calls into the app's own writers; they may sit only in PRIVATE methods; the only public async methods of the service
 * are the two entry points below; and each of them calls assertApplyAllowed and the beforeWrite hook. A new flag or
 * method that writes without passing the hook fails here (add it to ENTRY_POINTS only with the hook in its body).
 */
describe("C-G19: every write path runs the apply guards and beforeWrite", () => {
  const code = (x: string): string =>
    x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const ENTRY_POINTS = ["run", "resumePhotos"];
  const WRITER_CALLS = [
    "this.products.create(",
    "this.products.bulkDelete(",
    "this.products.uploadImage(",
    "this.units.create(",
    "this.families.createFamilyContainer(",
    "this.families.reserveFamilyName(",
  ];
  const service = () => code(fs.readFileSync(path.join(DIR, "catalog-copy.service.ts"), "utf8"));
  const METHOD = /^ {2}(private |public |protected )?(async )?(get )?([A-Za-z_]+)\(/;
  const methods = (text: string) => {
    const lines = text.split("\n");
    const found: Array<{ name: string; priv: boolean; async: boolean; start: number }> = [];
    lines.forEach((l, i) => {
      const m = METHOD.exec(l);
      if (m && !["constructor", "if", "for", "while", "switch", "catch"].includes(m[4]))
        found.push({
          name: m[4],
          priv: m[1]?.trim() === "private",
          async: !!m[2],
          start: i,
        });
    });
    return { lines, found };
  };
  const bodyOf = (name: string) => {
    const { lines, found } = methods(service());
    const at = found.findIndex((f) => f.name === name);
    const end = at + 1 < found.length ? found[at + 1].start : lines.length;
    return lines.slice(found[at].start, end).join("\n");
  };

  it("the service's public async methods are exactly the guarded entry points", () => {
    const pub = methods(service())
      .found.filter((f) => !f.priv && f.async)
      .map((f) => f.name)
      .sort();
    expect(pub).toEqual([...ENTRY_POINTS].sort());
  });

  it("every call into a writer sits inside a private method", () => {
    const { lines, found } = methods(service());
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (!WRITER_CALLS.some((w) => l.includes(w))) return;
      const owner = [...found].reverse().find((f) => f.start <= i);
      if (!owner || !owner.priv) offenders.push(`${owner?.name ?? "?"}:${i + 1}`);
    });
    expect(offenders).toEqual([]);
  });

  it.each(ENTRY_POINTS)("%s asserts the apply gate and runs the beforeWrite hook", (name) => {
    const body = bodyOf(name);
    expect(body).toContain("assertApplyAllowed(");
    expect(body).toMatch(/options\.beforeWrite|beforeWrite\?\.\(/);
    expect(body).toContain("beforeWrite(");
  });

  it("the runner hands the hook to BOTH entry points, and the CLI passes one", () => {
    const runner = code(fs.readFileSync(path.join(DIR, "catalog-copy.runner.ts"), "utf8"));
    expect(runner).toMatch(/service\.run\([^)]*beforeWrite: hooks\.beforeWrite/s);
    expect(runner).toMatch(/service\.resumePhotos\([^)]*beforeWrite: hooks\.beforeWrite/s);
    expect(code(fs.readFileSync(CLI, "utf8"))).toMatch(/runCatalogCopy\([^)]*\{ beforeWrite \}/s);
  });
});
