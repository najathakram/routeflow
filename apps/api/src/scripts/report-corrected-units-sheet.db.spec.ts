/**
 * SA-1088 (design §5): the corrected-units sheet against a REAL Postgres, driven end to end through the CLI.
 * Seeds one throwaway `qa-qdsheet-<run>` tenant with four lines in one GENERATED filing:
 *   (a) a box-axis SALE with a consistent reversal            -> listed with the exact pieces figure
 *   (b) a clean piece-axis line                                -> absent
 *   (c) a straddling line (one box-axis and one piece-axis SALE) -> listed unguessed, with a reason
 *   (d) a line with no pack evidence (no product)              -> listed unguessed, with a reason
 * and asserts the per-period figures reconcile, that a ledger row booked after the filing prints
 * `LEDGER MOVED SINCE FILING` with exit 1, that two filings are all listed (compared with the newest LOCKED), and
 * that row counts and a checksum of the ledger, filing and invoice tables are identical before and after every run.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); `requireLocalDatabaseUrl()` refuses any non-local host.
 * The tenant is approved by `assertTestTenant`; afterAll deletes exactly the rows this run created. No client
 * identifiers anywhere.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-corrected-units-sheet.mjs");
const OUT_DIR = path.resolve(API_DIR, "../../local-assets/handoff");
const BEFORE_CUTOFF = new Date("2026-09-01T00:00:00Z");

describeDb("SA-1088 corrected-units sheet, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-qdsheet-${run}`, "report-corrected-units-sheet.db.spec.ts");
  const outFile = path.join(OUT_DIR, `qd-sheet-dbspec-${run}.csv`);
  let tenantId = "";
  let categoryId = "";
  let pieceLineId = ""; // (b), the clean piece-axis order line
  const url = () => requireLocalDatabaseUrl();

  const cli = (extra: string[] = []) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url() };
    for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_")) delete env[k];
    delete env.PROTECTED_TENANT_SLUGS;
    const host = new URL(url()).hostname;
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--tenant", slug, `--target-host=${host}`, "--out", outFile, ...extra],
      { encoding: "utf8", env, cwd: API_DIR },
    );
    return {
      status: res.status,
      out: res.stdout,
      err: res.stderr,
      csv: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
    };
  };

  /** Row counts + a checksum of the ledger, filing and invoice tables, for this tenant. */
  const fingerprint = async () => {
    const tables = ["RegulatedSalesLedger", "RegulatedFiling", "Invoice", "InvoiceItem"];
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x.id)), '') AS sum FROM "${t}" x WHERE x."tenantId" = $1`,
        [tenantId],
      );
      out[t] = `${r.rows[0].n}:${r.rows[0].sum}`;
    }
    return out;
  };

  const ledger = (data: Record<string, unknown>) =>
    raw.regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        soldAt: new Date("2026-07-10T12:00:00Z"),
        periodBucket: "2026-07",
        createdAt: BEFORE_CUTOFF,
        categoryTax: "0",
        ...data,
      } as never,
    });

  const filingRows = (unitBasisQty: number) => [
    {
      trackedCategoryId: categoryId,
      categoryName: "Excise",
      periodBucket: "2026-07",
      qty: 0,
      unitBasisQty,
      netSales: 0,
      categoryTax: 0,
    },
  ];
  const filing = (data: Record<string, unknown>) =>
    raw.regulatedFiling.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        reportTemplate: "GENERIC",
        periodKey: "2026-07",
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-01T00:00:00Z"),
        status: "GENERATED",
        generatedAt: new Date("2026-08-02T00:00:00Z"),
        rows: filingRows(97),
        ...data,
      } as never,
    });

  const lineOf = (csv: string, needle: string | RegExp) =>
    csv
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .find((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    pool = new Pool({ connectionString: url() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `QD sheet ${slug}` } })).id;
    const user = await raw.user.create({
      data: { email: `qd-${run}@example.test`, username: `qd-${run}`, role: "CUSTOMER", tenantId },
    });
    const customerId = (
      await raw.customer.create({
        data: { userId: user.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    categoryId = (
      await raw.trackedCategory.create({
        data: { tenantId, name: `Excise ${run}`, taxType: "EXCISE_PER_UNIT", rate: 0.05 },
      })
    ).id;
    const product = await raw.product.create({
      data: {
        name: `Cigar ${run}`,
        sku: `QD-${run}`,
        unit: "each",
        unitsPerBox: 12,
        pricePerUnit: "1.00",
        currentStock: 100,
        trackedCategoryId: categoryId,
        tenantId,
      } as never,
    });
    const orderId = (
      await raw.order.create({
        data: {
          customerId,
          status: "PENDING",
          subtotal: "100.00",
          total: "100.00",
          orderNumber: `ORD-QD-${run}`,
          tenantId,
        },
      })
    ).id;
    const orderLine = async (productId: string | null) =>
      (
        await raw.orderItem.create({
          data: {
            orderId,
            tenantId,
            productId,
            name: productId ? undefined : "Unlisted",
            qty: 5,
            unitPrice: "1.00",
            subtotal: "5.00",
            status: "PENDING",
            priceType: "STANDARD",
          } as never,
        })
      ).id;
    const [oA, oB, oC, oD] = [
      await orderLine(product.id),
      await orderLine(product.id),
      await orderLine(product.id),
      await orderLine(null),
    ];
    // the live invoice line a box-count copy is checked against: 5 boxes of 12 = 60 pieces
    const invoiceId = (
      await raw.invoice.create({
        data: {
          invoiceNumber: `INV-QD-${run}`,
          customerId,
          orderId,
          status: "SENT",
          subtotal: "100.00",
          total: "100.00",
          tenantId,
        },
      })
    ).id;
    await raw.invoiceItem.create({
      data: {
        invoiceId,
        tenantId,
        productId: product.id,
        orderItemId: oA,
        description: "Cigar",
        qty: 60,
        boxes: 5,
        pieces: 0,
        unitsPerBox: 12,
        unitPrice: "1.00",
        subtotal: "60.00",
      } as never,
    });
    pieceLineId = oB;
    // (a) box-axis SALE 5 boxes (unitBasisQty = qty) + a consistent reversal of 2: ledger sum 3, corrected 36
    await ledger({
      orderItemId: oA,
      entryType: "SALE",
      qty: 5,
      unitBasisQty: 5,
      netSales: "100.00",
      categoryTax: "10.00",
    });
    await ledger({
      orderItemId: oA,
      entryType: "REVERSAL",
      qty: -2,
      unitBasisQty: -2,
      netSales: "-40.00",
      categoryTax: "-4.00",
    });
    // (b) already on the pieces axis (5 boxes of 12 = 60)
    await ledger({
      orderItemId: oB,
      entryType: "SALE",
      qty: 5,
      unitBasisQty: 60,
      netSales: "120.00",
      categoryTax: "12.00",
    });
    // (c) straddles: one box-axis SALE, one piece-axis SALE
    await ledger({
      orderItemId: oC,
      entryType: "SALE",
      qty: 5,
      unitBasisQty: 5,
      netSales: "50.00",
    });
    await ledger({
      orderItemId: oC,
      entryType: "SALE",
      qty: 2,
      unitBasisQty: 24,
      netSales: "20.00",
    });
    // (d) no product, no pack evidence
    await ledger({
      orderItemId: oD,
      entryType: "SALE",
      qty: 5,
      unitBasisQty: 5,
      netSales: "10.00",
    });
    // ledger sum = 3 + 60 + (5 + 24) + 5 = 97, the figure the filing froze
    await filing({});
  }, 120_000);

  afterAll(async () => {
    if (existsSync(outFile)) unlinkSync(outFile);
    if (raw) {
      await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await raw.regulatedFiling.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await raw.$disconnect();
    }
    await pool?.end();
  });

  it("QD-4 / QD-6: lists (a) with the exact pieces figure, omits (b), lists (c) and (d) unguessed, and reconciles", async () => {
    const before = await fingerprint();
    const res = cli();
    expect(res.err).not.toMatch(/Error|refus/);
    expect(res.status).toBe(0);
    // (a): ledger 3 boxes, corrected 3 x 12 = 36, delta 33, no money delta
    const a = lineOf(res.csv, /,A,12,/);
    expect(a).toBeDefined();
    expect(a).toContain(`QD-${run}`);
    expect(a).toContain(`order ORD-QD-${run} line`);
    expect(a).toMatch(/,A,12,derived \(sibling line or product now\),3,36,33,60,6,0,0,$/);
    // (b) is absent: only (a), (c), (d) are listed
    expect(
      res.csv.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("period")),
    ).toHaveLength(3);
    // (c) and (d): corrected and delta empty, a reason given
    expect(lineOf(res.csv, /,straddles,,,29,,,/)).toMatch(/split across both axes/);
    expect(lineOf(res.csv, /,unknown-basis,,,5,,,/)).toMatch(/no snapshot and no product/);
    // the footer: snapshot 97, delta 33, corrected total 130, RECONCILED
    expect(res.out).toMatch(/2026-07: RECONCILED/);
    expect(res.out).toMatch(
      /filed \(snapshot, GENERATED\): 97 \| sum of line deltas: 33 \| corrected period total: 130/,
    );
    // QD-8: 3 lines is not the census of 49
    expect(res.out).toMatch(/!!! LINE COUNT 3 IS NOT THE 49 OF THE SA-790 CENSUS/);
    expect(res.csv.split("\n")[0]).toBe(
      "# Reference only. The ledger and the filed forms are unchanged.",
    );
    // the red value: the corrected column is never the ledger figure for (a)
    expect(a).not.toMatch(/,A,12,[^,]*,3,3,/);
    expect(await fingerprint()).toEqual(before);
  });

  it("QD-5: a ledger row booked after the filing prints LEDGER MOVED SINCE FILING and exits 1", async () => {
    await raw.regulatedSalesLedger.create({
      data: {
        tenantId,
        trackedCategoryId: categoryId,
        entryType: "SALE",
        orderItemId: pieceLineId,
        qty: 1,
        unitBasisQty: 12,
        netSales: "10.00",
        categoryTax: "1.00",
        soldAt: new Date("2026-07-20T12:00:00Z"),
        periodBucket: "2026-07",
        createdAt: BEFORE_CUTOFF,
      } as never,
    });
    const before = await fingerprint();
    const res = cli();
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/LEDGER MOVED SINCE FILING by 12/);
    // the corrected total is the snapshot plus the line deltas, never the live sum
    expect(res.out).toMatch(/corrected period total: 130/);
    expect(await fingerprint()).toEqual(before);
  });

  it("QD-7: two filings for the period are all listed, compared with the newest LOCKED", async () => {
    await filing({
      periodKey: "2026-Q3",
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      status: "LOCKED",
      lockedAt: new Date("2026-08-15T00:00:00Z"),
      generatedAt: new Date("2026-08-14T00:00:00Z"),
      rows: filingRows(109),
    });
    const before = await fingerprint();
    const res = cli();
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/2026-07: RECONCILED/);
    expect(res.out).toMatch(/filing LOCKED key 2026-Q3/);
    expect(res.out).toMatch(/filing GENERATED key 2026-07/);
    expect(res.out).toMatch(
      /filed \(snapshot, LOCKED\): 109 \| sum of line deltas: 33 \| corrected period total: 142/,
    );
    expect(await fingerprint()).toEqual(before);
  });

  it("QD-2: --apply is refused with exit 2 and the tables are untouched", async () => {
    const before = await fingerprint();
    const res = cli(["--apply"]);
    expect(res.status).toBe(2);
    expect(await fingerprint()).toEqual(before);
  });
});
