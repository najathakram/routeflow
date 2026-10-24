import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * B297 PR3 / SA-734r2 R1+R2+R7 sizing: the owner-run, READ-ONLY report of regulated lines with a NULL (or
 * partly NULL) category-tax trio, of those the ones PR3's recompute would re-price, and the no-category
 * lines that still carry an excise amount. Pinned here by its --self-test, by exact-count fixtures
 * (a mis-bucketed line changes a count), by the no-DB exit code, and by source (read-only first, no write
 * statement, counts and anonymous labels only). The script is an ES module run by node, so the pure
 * functions are exercised in a child process.
 */
const API_DIR = path.resolve(__dirname, "../..");
const REPORT = path.resolve(API_DIR, "scripts/report-b297-trio-sizing.mjs");
const src = fs.readFileSync(REPORT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

/** Runs `body` inside an ES-module child with the script's exports bound, returns its JSON stdout. */
function runModule(body: string): any {
  const prog = `import * as m from ${JSON.stringify(pathToFileURL(REPORT).href)};\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", prog], {
    encoding: "utf8",
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: "" },
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout);
}

const LINE = `{
  tenantId: "t-1", slug: "acme-one", trackedCategoryId: "cat-1", createdAt: "2026-10-20T00:00:00Z",
  categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null,
  qty: "12", boxes: null, pieces: null, unitsPerBox: null, unitLabel: null,
  subtotal: "100.00", categoryTaxAmount: "0.60", productUnitsPerBox: null,
  liveTaxType: "EXCISE_PER_UNIT", liveRate: "0.0500", livePriceIncludesTax: false,
}`;

describe("report-b297-trio-sizing", () => {
  it("--self-test passes with no database", () => {
    const res = spawnSync(process.execPath, [REPORT, "--self-test"], {
      encoding: "utf8",
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(res.stderr).toBe("");
    expect(res.stdout.trim()).toBe("self-test ok");
    expect(res.status).toBe(0);
  });

  it("exits 2 without connecting when no database url is configured", () => {
    const env = { ...process.env };
    for (const k of [
      "DATABASE_URL",
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "RAILWAY_TCP_PROXY_DOMAIN",
      "RAILWAY_TCP_PROXY_PORT",
    ])
      delete env[k];
    const res = spawnSync(process.execPath, [REPORT], { encoding: "utf8", cwd: API_DIR, env });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("classifies each shape into exactly one gate, with the production arithmetic", () => {
    const out = runModule(`
      const L = ${LINE};
      const r = (o) => m.classifyLine({ ...L, ...o });
      console.log(JSON.stringify({
        consistent: r({}),
        rateMoved: r({ liveRate: "0.0700" }),
        partlyNull: r({ categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.05", categoryPriceIncludesTax: null }),
        // 2 boxes x 12 + 3 pieces = 27 pieces at 0.05 = 1.35: the line's OWN pack, not the product's.
        boxed: r({ qty: "27", boxes: 2, pieces: 3, unitsPerBox: 12, productUnitsPerBox: 6, categoryTaxAmount: "1.35" }),
        // a box-unaware line (no split) falls back to the product's pack: 2 selling units x 6 = 12 pieces.
        productPack: r({ qty: "2", boxes: null, pieces: null, unitsPerBox: null, productUnitsPerBox: 6, categoryTaxAmount: "0.60" }),
        percent: r({ liveTaxType: "PERCENT_OF_SALE", liveRate: "0.0600", categoryTaxAmount: "6.00" }),
        percentIncl: r({ liveTaxType: "PERCENT_OF_SALE", liveRate: "0.0600", livePriceIncludesTax: true, categoryTaxAmount: "5.66" }),
        noCategory: r({ trackedCategoryId: null, categoryTaxAmount: "4.20" }),
        noCategoryZero: r({ trackedCategoryId: null, categoryTaxAmount: "0.00" }),
        exempt: r({ liveRate: "0.0700", categoryTaxAmount: "0.00", exempt: true }),
        fullTrio: r({ categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.05", categoryPriceIncludesTax: false, liveRate: "0.0900" }),
      }));
    `);
    expect(out.consistent).toEqual({
      nullTrio: true,
      mismatch: false,
      noCategory: false,
      exempt: false,
    });
    expect(out.rateMoved).toEqual({
      nullTrio: true,
      mismatch: true,
      noCategory: false,
      exempt: false,
    });
    expect(out.partlyNull.nullTrio).toBe(true);
    expect(out.boxed.mismatch).toBe(false);
    expect(out.productPack.mismatch).toBe(false);
    expect(out.percent.mismatch).toBe(false);
    expect(out.percentIncl.mismatch).toBe(false);
    expect(out.noCategory).toEqual({
      nullTrio: false,
      mismatch: false,
      noCategory: true,
      exempt: false,
    });
    expect(out.noCategoryZero).toEqual({
      nullTrio: false,
      mismatch: false,
      noCategory: false,
      exempt: false,
    });
    // An exempt customer's invoice line is NULL-trio but never a re-price candidate: (b) can read 0.
    expect(out.exempt).toEqual({
      nullTrio: true,
      mismatch: false,
      noCategory: false,
      exempt: true,
    });
    // A line with a full trio is out of scope for (a) and (b), whatever the live rate says.
    expect(out.fullTrio).toEqual({
      nullTrio: false,
      mismatch: false,
      noCategory: false,
      exempt: false,
    });
  });

  it("aggregates anonymously, with exact counts, a test block and the --since split", () => {
    const out = runModule(`
      const L = ${LINE};
      const acc = m.newAccumulator();
      const since = new Date("2026-10-11T00:00:00Z");
      m.foldPage(acc, "OrderItem", [
        L,
        { ...L, liveRate: "0.0700" },
        { ...L, tenantId: "t-0", slug: "acme-zero", trackedCategoryId: "cat-0", createdAt: "2026-01-01T00:00:00Z" },
        { ...L, tenantId: null, slug: null, trackedCategoryId: null, categoryTaxAmount: "4.20" },
        { ...L, tenantId: "e2e-t", slug: "e2e-routeflow" },
      ], since);
      m.foldPage(acc, "InvoiceItem", [{ ...L, tenantId: "t-0", slug: "acme-zero", trackedCategoryId: "cat-9" }], since);
      console.log(JSON.stringify(m.summarize(acc)));
    `);
    const o = out.live.OrderItem;
    expect([o.nullTrio, o.nullTrioSince, o.mismatch, o.noCategory, o.tenants]).toEqual([
      3, 2, 1, 1, 3,
    ]);
    expect(o.detail.map((d: any) => d.tenant)).toEqual(["no tenant", "tenant A", "tenant B"]);
    expect(out.live.InvoiceItem.detail).toEqual([
      expect.objectContaining({ tenant: "tenant A", nullTrio: 1, nullTrioSince: 1 }),
    ]);
    expect(out.live.InvoiceItem.detail[0].categories.map((c: any) => c.category)).toEqual([
      "category 2",
    ]);
    expect(out.test.OrderItem.nullTrio).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(/acme|t-0|t-1|cat-|e2e/);
  });

  it("scopes the page query to a NULL-trio regulated line or a no-category line with an amount", () => {
    const out = runModule(
      `console.log(JSON.stringify({ sql: m.pageSql("InvoiceItem"), scope: m.SCOPE_SQL }));`,
    );
    expect(out.sql).toContain(out.scope);
    expect(out.scope).toContain(`i."categoryTaxType" IS NULL`);
    expect(out.scope).toContain(`i."categoryTaxRate" IS NULL`);
    expect(out.scope).toContain(`i."categoryPriceIncludesTax" IS NULL`);
    expect(out.scope).toContain(`i."trackedCategoryId" IS NULL AND i."categoryTaxAmount" <> 0`);
    expect(out.sql).toMatch(/ORDER BY i\.id\s+LIMIT 500/);
  });

  it("is read-only: the session is set read-only first and no write statement appears", () => {
    const readOnly = src.indexOf("SET default_transaction_read_only = on");
    expect(readOnly).toBeGreaterThan(0);
    expect(src.indexOf("client.query(pageSql(", readOnly)).toBeGreaterThan(readOnly);
    // No statement other than the SET, SET, SET and the page SELECT reaches the client.
    for (const m of code.matchAll(/client\.query\(\s*([`"'][^`"']*|pageSql)/g))
      expect(m[1]).toMatch(
        /^([`"']SET (default_transaction_read_only|statement_timeout|lock_timeout)|pageSql)/,
      );
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/);
    expect(code).toMatch(/await client\.end\(\)/);
    expect(code).toMatch(/finally\s*\{/);
  });

  it("never prints a tenant id, slug, category id or line id: only the anonymous summary reaches stdout", () => {
    for (const m of code.matchAll(/console\.log\(([^;]*)\);/g))
      expect(m[1]).not.toMatch(/\.slug|\.tenantId|\.trackedCategoryId|\.id\b/);
  });

  it("recomputes with production's own helpers, not a copy of the arithmetic", () => {
    expect(code).toMatch(/require\("@routeflow\/pricing"\)/);
    expect(code).toMatch(/computeCategoryTax\(/);
    expect(code).toMatch(/regulatedUnitBasis\(/);
  });
});
