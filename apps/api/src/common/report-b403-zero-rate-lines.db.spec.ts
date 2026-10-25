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
import { PrismaClient } from "@prisma/client";
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

  const makeInvoice = async (
    key: string,
    over: {
      status?: string;
      taxAmount?: number;
      withOrder?: boolean;
      issueDate?: Date;
      lines: Array<{ taxRate: number; systemKind?: string }>;
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
      lines: [{ taxRate: 0.075 }, { taxRate: 0, systemKind: "NSF_FEE" }],
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.invoiceItem.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end();
  });

  it("counts only the all-zero taxed order-derived invoices, per month, and writes nothing", async () => {
    const before = await prisma.invoiceItem.count({ where: { tenantId } });
    const code = `
      import { buildReport } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
      import pg from "pg";
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        console.log(JSON.stringify(await buildReport(client, { protectedIds: new Set(), onlyTenant: ${JSON.stringify(tenantId)} })));
      } finally { await client.end(); }
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: path.resolve(__dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() },
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    const rep = JSON.parse(res.stdout.trim());
    expect(rep.tenants).toHaveLength(1);
    const periods = Object.fromEntries(
      rep.tenants[0].periods.map((p: { period: string }) => [p.period, p]),
    );
    expect(periods["2026-08"]).toMatchObject({
      allZeroInvoices: 2,
      allZeroLines: 3,
      storedTaxAllZero: "10.75",
    });
    expect(periods["2026-08"].taxedInvoices).toBe(5); // zero x2, rated, mixed, nsf-only-zero (void, no-tax, manual excluded)
    expect(periods["2026-09"]).toMatchObject({ allZeroInvoices: 1, allZeroLines: 2 });
    expect(rep.totals).toMatchObject({ allZeroInvoices: 3, allZeroLines: 5 });
    expect(await prisma.invoiceItem.count({ where: { tenantId } })).toBe(before);
  }, 60_000);
});
