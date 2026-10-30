/**
 * B403 census (`scripts/report-b403-zero-rate-lines.mjs`) against a REAL Postgres: which taxed order-derived invoices
 * have EVERY goods line at taxRate 0, per tenant and issue month. Counted: an all-zero pre-fix invoice. Not counted: a
 * rated invoice, a MIXED one (an exempt line is legitimate), a VOID one, a zero-tax one, a manual (not order-derived)
 * one, and an invoice whose only zero line is the NSF fee line. The report writes nothing.
 *
 * Collected only by `jest.db.config.js`. SAFETY: the spec's own `qa-b403-*` tenant (assertTestTenant); afterAll deletes
 * what it made; the report is called through its pure `buildReport` on the spec's own connection.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { pathToFileURL } from "url";
import { InvoiceItemSystemKind, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const SCRIPT = path.resolve(__dirname, "../../scripts/report-b403-zero-rate-lines.mjs");

describeDb("report-b403-zero-rate-lines.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let tenantId = "";
  let customerId = "";
  let orderId = "";
  const invoiceIds: Record<string, string> = {};

  const makeInvoice = async (
    key: string,
    over: {
      status?: string;
      taxAmount?: number;
      withOrder?: boolean;
      issueDate?: Date;
      lines: Array<{ taxRate: number; systemKind?: InvoiceItemSystemKind }>;
    },
  ) => {
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        ...(over.withOrder === false ? {} : { orderId }),
        invoiceNumber: `INV-B403-${RUN}-${key}`,
        status: (over.status ?? "SENT") as any,
        subtotal: 100,
        taxAmount: over.taxAmount ?? 7.5,
        total: 107.5,
        issueDate: over.issueDate ?? new Date("2026-08-15T12:00:00Z"),
      } as any,
    });
    invoiceIds[key] = invoice.id;
    for (const [i, l] of over.lines.entries()) {
      await prisma.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          tenantId,
          description: l.systemKind ? "NSF fee" : `Line ${i}`,
          qty: 1,
          unitPrice: 50,
          subtotal: 50,
          taxRate: l.taxRate,
          ...(l.systemKind ? { systemKind: l.systemKind } : {}),
        } as any,
      });
    }
  };

  beforeAll(async () => {
    const dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-b403-${RUN}`, "report-b403-zero-rate-lines.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `b403 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "b403", contactName: "b403", tenantId } as any,
      })
    ).id;
    orderId = (
      await prisma.order.create({
        data: {
          tenantId,
          customerId,
          orderNumber: `ORD-B403-${RUN}`,
          subtotal: 100,
          tax: 7.5,
          total: 107.5,
          status: "DELIVERED",
        } as any,
      })
    ).id;
    const zero2 = [{ taxRate: 0 }, { taxRate: 0 }];
    await makeInvoice("zero-aug-1", { lines: zero2 }); // counted (2 lines)
    await makeInvoice("zero-aug-2", { lines: [{ taxRate: 0 }], taxAmount: 3.25 }); // counted (1 line)
    await makeInvoice("zero-sep", { lines: zero2, issueDate: new Date("2026-09-02T12:00:00Z") }); // counted, other month
    await makeInvoice("rated", { lines: [{ taxRate: 0.075 }, { taxRate: 0.075 }] });
    await makeInvoice("mixed", { lines: [{ taxRate: 0.075 }, { taxRate: 0 }] });
    await makeInvoice("void", { lines: zero2, status: "VOID" });
    await makeInvoice("notax", { lines: zero2, taxAmount: 0 });
    await makeInvoice("manual", { lines: zero2, withOrder: false });
    await makeInvoice("nsf-only-zero", {
      lines: [{ taxRate: 0.075 }, { taxRate: 0, systemKind: InvoiceItemSystemKind.NSF_FEE }],
    });
    // Counted ONLY because the NSF fee line is left out: goods at 0 plus a taxed NSF line (dropping the exclusion makes it mixed).
    await makeInvoice("nsf-taxed", {
      lines: [{ taxRate: 0 }, { taxRate: 0.075, systemKind: InvoiceItemSystemKind.NSF_FEE }],
    });
    // Month edges: the last and first half-hours of August / September (UTC); issueDate is a timestamp without a zone.
    await makeInvoice("edge-aug", {
      lines: [{ taxRate: 0 }],
      issueDate: new Date("2026-08-31T23:30:00Z"),
    });
    await makeInvoice("edge-sep", {
      lines: [{ taxRate: 0 }],
      issueDate: new Date("2026-09-01T00:30:00Z"),
    });
    // Estimate-derived (no orderId, linked from an Estimate): counted.
    await makeInvoice("estimate", { lines: [{ taxRate: 0 }], withOrder: false });
    await prisma.estimate.create({
      data: {
        tenantId,
        customerId,
        estimateNumber: `EST-B403-${RUN}`,
        subtotal: 100,
        total: 107.5,
        invoiceId: invoiceIds.estimate,
      } as any,
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.estimate.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoiceItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end();
  });

  const cli = (...args: string[]) => {
    const dbUrl = requireLocalDatabaseUrl();
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: dbUrl };
    for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_")) delete env[k];
    delete env.PROTECTED_TENANT_SLUGS;
    // db-spec.ts exports PGOPTIONS=-c timezone=UTC to every spec; the CLI must see the DATABASE's own TimeZone (the timezone test).
    delete env.PGOPTIONS;
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env,
      timeout: 90_000,
    });
  };

  it("the CLI (main, with the host named) counts only the all-zero taxed order-derived invoices, per month, and writes nothing", async () => {
    const before = await prisma.invoiceItem.count({ where: { tenantId } });
    const host = new URL(requireLocalDatabaseUrl()).hostname;
    const res = cli(`--target-host=${host}`, "--json", "--tenant", tenantId);
    expect(res.status).toBe(0);
    const rep = JSON.parse(res.stdout.trim());
    expect(rep.tenants).toHaveLength(1);
    const periods = Object.fromEntries(
      rep.tenants[0].periods.map((p: { period: string }) => [p.period, p]),
    );
    // August: zero-aug-1 (2 lines), zero-aug-2 (1), nsf-taxed (1 goods line), edge-aug (1), estimate (1)
    expect(periods["2026-08"]).toMatchObject({
      allZeroInvoices: 5,
      allZeroLines: 6,
      storedTaxAllZero: "33.25",
    });
    // + rated, mixed, nsf-only-zero; excluded: void, no-tax, manual (no order, no estimate)
    expect(periods["2026-08"].taxedInvoices).toBe(8);
    // September: zero-sep (2 lines) and edge-sep (1), the 00:30Z edge lands in September
    expect(periods["2026-09"]).toMatchObject({
      allZeroInvoices: 2,
      allZeroLines: 3,
      storedTaxAllZero: "15.00",
    });
    expect(rep.totals).toMatchObject({ allZeroInvoices: 7, allZeroLines: 9 });
    expect(await prisma.invoiceItem.count({ where: { tenantId } })).toBe(before);
  }, 90_000);

  it("a run without --target-host exits 64, and a wrong one 65, before any query", () => {
    expect(cli("--json").status).toBe(64);
    expect(cli("--target-host=not-this-host", "--json").status).toBe(65);
  });

  it("inside the report's read-only wrapper a write is refused by the database (SQLSTATE 25006)", () => {
    const code = `
      import { createRequire } from "node:module";
      import pg from "pg";
      const require = createRequire(${JSON.stringify(pathToFileURL(SCRIPT).href)});
      const g = require("./lib/report-839-regulated-void-residue.cjs");
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await g.withReadOnlyTx(client, () => client.query('UPDATE "InvoiceItem" SET "taxRate" = 0.5 WHERE false'));
        console.log("NOT-REFUSED");
      } catch (e) {
        console.log(e.code);
      } finally { await client.end(); }
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() },
      timeout: 60_000,
    });
    expect(res.stdout.trim()).toBe("25006");
  }, 60_000);

  it("the month is the UTC clock month whatever the database TimeZone is (issueDate is a timestamp without a zone)", async () => {
    const host = new URL(requireLocalDatabaseUrl()).hostname;
    const dbName = decodeURIComponent(new URL(requireLocalDatabaseUrl()).pathname.slice(1));
    const augCount = () => {
      const res = cli(`--target-host=${host}`, "--json", "--tenant", tenantId);
      expect(res.status).toBe(0);
      const rep = JSON.parse(res.stdout.trim());
      return {
        aug: rep.tenants[0].periods.find((p: { period: string }) => p.period === "2026-08")
          .allZeroInvoices as number,
        sep: rep.tenants[0].periods.find((p: { period: string }) => p.period === "2026-09")
          .allZeroInvoices as number,
      };
    };
    const before = augCount();
    // 2026-08-31 18:00 on the UTC clock is already Sept 1 in Auckland (+13): a zone cast would move it to September.
    await makeInvoice("tz-edge", {
      lines: [{ taxRate: 0 }],
      issueDate: new Date("2026-08-31T18:00:00Z"),
    });
    await pool.query(`ALTER DATABASE "${dbName}" SET TimeZone = 'Pacific/Auckland'`);
    try {
      const after = augCount();
      expect(after.aug).toBe(before.aug + 1);
      expect(after.sep).toBe(before.sep);
    } finally {
      await pool.query(`ALTER DATABASE "${dbName}" RESET TimeZone`);
    }
  }, 120_000);
});
