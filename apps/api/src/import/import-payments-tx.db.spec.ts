/**
 * #2262 / SA-404b — real Postgres. The bulk Zoho import writes each invoice's payments and its
 * Invoice row in ONE transaction:
 *   (a) atomic — a failure after the payment insert leaves NEITHER the payment NOR a status change
 *       (importPayments), and a failed synthetic payment leaves no invoice (importInvoices);
 *   (b) serialized — a second connection that holds the Invoice row lock and voids the invoice
 *       while the import waits: the import runs after it, on the locked re-read, and never writes a
 *       stale status over the VOID.
 * Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes what it made. Runs on the DB lane.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const YEAR = new Date().getFullYear();

describeDb("#2262 import payments + Invoice row in one transaction (real Postgres)", () => {
  let url: string;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        NumberingService,
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        // #2185 (B858/B859): ImportService routes product writes through ProductsService. This
        // suite imports payments only, so it never calls it; the stub just satisfies DI.
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: "prod-1" }),
            update: jest.fn().mockResolvedValue({ id: "prod-1" }),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    importService = module.get(ImportService);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await prisma.importExternalRef.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } }).catch(() => {});
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.numberingSequence.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await prisma?.$disconnect();
  });

  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-i2262-${RUN}-${seq}-${label}`,
      "import-payments-tx.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `qa ${slug}` } });
    tenantIds.push(tenant.id);
    const idBase = `${tenant.id}-cust`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "QA Import Co",
        contactName: "QA",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  async function seedInvoice(tenantId: string, customerId: string, number: string) {
    return prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: number,
        status: InvoiceStatus.SENT,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        issueDate: new Date(),
      } as any,
    });
  }

  /** Run the next tenantTransaction with ONE delegate method on the tx client replaced. */
  function breakNextTx(delegate: "invoice" | "invoicePayment", method: string) {
    const real = prisma.tenantTransaction.bind(prisma);
    jest.spyOn(prisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts: any) =>
      real(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get: (t, k) =>
                k === delegate
                  ? new Proxy(t[k], {
                      get: (d, m) =>
                        m === method
                          ? async () => {
                              throw new Error(`forced ${String(delegate)}.${String(m)} failure`);
                            }
                          : typeof d[m] === "function"
                            ? d[m].bind(d)
                            : d[m],
                    })
                  : t[k],
            }),
          ),
        opts,
      )) as any);
  }

  it("(a) importPayments: a failure after the payment insert leaves neither the payment nor a status change", async () => {
    const { tenantId, customerId } = await seed("atomic-pay");
    const inv = await seedInvoice(tenantId, customerId, `INV-${YEAR}-7001`);
    breakNextTx("invoice", "update"); // the status write, AFTER the payment create in the same tx
    const csv = `Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-${YEAR}-7001,100,Cash,${YEAR}-01-02\n`;
    const result = await tenantCtx.run(tenantId, () =>
      importService.importPayments(Buffer.from(csv), "user-1"),
    );
    expect(result.imported).toBe(0);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } })).toBe(0);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe(InvoiceStatus.SENT);
  }, 30_000);

  it("(a) importInvoices: a failed synthetic payment leaves no invoice behind", async () => {
    const { tenantId } = await seed("atomic-inv");
    breakNextTx("invoicePayment", "create");
    const number = `INV-${YEAR}-7101`;
    const csv = `Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n${number},QA Import Co,100,0,Paid\n`;
    const result = await tenantCtx.run(tenantId, () =>
      importService.importInvoices(Buffer.from(csv), "user-1"),
    );
    expect(result.imported).toBe(0);
    expect(await prisma.invoice.count({ where: { tenantId, invoiceNumber: number } })).toBe(0);
  }, 30_000);

  it("(a) control: the same payment row with nothing forced imports the payment AND flips the status", async () => {
    const { tenantId, customerId } = await seed("control");
    const inv = await seedInvoice(tenantId, customerId, `INV-${YEAR}-7201`);
    const csv = `Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-${YEAR}-7201,100,Cash,${YEAR}-01-02\n`;
    const result = await tenantCtx.run(tenantId, () =>
      importService.importPayments(Buffer.from(csv), "user-1"),
    );
    expect(result.imported).toBe(1);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } })).toBe(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(
      InvoiceStatus.PAID,
    );
  }, 30_000);

  it("(b) a void committed while the import waits on the Invoice lock ⇒ row error, NO payment, stays VOID (SA-424 N1)", async () => {
    const { tenantId, customerId } = await seed("serial");
    const inv = await seedInvoice(tenantId, customerId, `INV-${YEAR}-7301`);
    const t2 = new Client({ connectionString: url });
    await t2.connect();
    let result: Awaited<ReturnType<ImportService["importPayments"]>>;
    let sawBlocked = false;
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [inv.id]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const csv = `Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-${YEAR}-7301,100,Cash,${YEAR}-01-02\n`;
      const t1 = tenantCtx.run(tenantId, () =>
        importService.importPayments(Buffer.from(csv), "user-1"),
      );
      // ENTRY CONDITION (SA-E17), proven not timed: the import's per-row tx is BLOCKED on T2's
      // Invoice row lock (it pre-read the invoice as SENT, by number, before the lock).
      for (let i = 0; i < 400 && !sawBlocked; i++) {
        const { rows } = await t2.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        );
        sawBlocked = rows[0].n > 0;
        if (!sawBlocked) await new Promise((r) => setTimeout(r, 25));
      }
      await t2.query(`UPDATE "Invoice" SET status = 'VOID' WHERE id = $1`, [inv.id]);
      await t2.query("COMMIT");
      result = await t1;
    } finally {
      await t2.end();
    }
    expect(sawBlocked).toBe(true);
    // Under the lock the import sees the committed VOID and refuses the row (SA-424 N1): no payment
    // (pre-fix: a CASH $100 payment landed on the VOID invoice), a row error, and it stays VOID.
    expect(result!.imported).toBe(0);
    expect(result!.errors).toEqual([`Payment for INV-${YEAR}-7301: invoice is voided`]);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: inv.id } })).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(
      InvoiceStatus.VOID,
    );
  }, 30_000);
});
