/**
 * #2468 / SA-468 — real Postgres. A Zoho invoice RE-import never resurrects an invoice the app VOIDed
 * or WROTE OFF: both re-import branches of `importInvoices` sync status inside one tx that locks the
 * invoice row and re-reads it, and a VOID / WRITTEN_OFF prior is SKIPPED with a row error — no status
 * write, no synthetic payment.
 *   - source-numbered branch ("Invoice Number" column): the prior is found by its number;
 *   - numberless branch ("Invoice ID" column): the prior is found through the import's external ref,
 *     so these cases import the row once (creating the invoice and its ref), void it in-app, then
 *     re-import the same file with Balance Due 0.
 * Plus healthy controls (a SENT prior still syncs) and one cheap race: a void committed while the
 * re-import waits on the Invoice lock. Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes
 * what it made. Runs on the DB lane (F2); not run by the authoring lane.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Client } from "pg";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const YEAR = new Date().getFullYear();

describeDb(
  "#2468 invoice re-import never resurrects a VOID / WRITTEN_OFF invoice (real Postgres)",
  () => {
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
          // #2185 (B858/B859): ImportService routes product writes through ProductsService; this
          // suite never reaches a product write, so the stub only satisfies DI.
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
          // #2093: importInvoices flags banned lines (never blocks); ALLOW keeps this suite's rows unflagged.
          {
            provide: SellingRestrictionsService,
            useValue: {
              judgeStaffWrite: jest.fn().mockResolvedValue({
                outcome: "ALLOW",
                reasons: [],
                breaches: [],
                basis: "CUSTOMER",
              }),
            },
          },
          { provide: PrismaService, useValue: prisma },
          { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
          {
            provide: CustomersService,
            useValue: {
              assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
              maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();
      importService = module.get(ImportService);
    });

    afterAll(async () => {
      for (const tenantId of tenantIds) {
        await prisma.importExternalRef.deleteMany({ where: { tenantId } }).catch(() => {});
        await prisma.invoicePayment
          .deleteMany({ where: { invoice: { tenantId } } })
          .catch(() => {});
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
        `qa-i2468-${RUN}-${seq}-${label}`,
        "import-invoice-reimport.db.spec.ts",
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

    /** An invoice the app holds under its ORIGINAL source number, in `status`. */
    async function seedNumbered(
      tenantId: string,
      customerId: string,
      number: string,
      status: InvoiceStatus,
    ) {
      return prisma.invoice.create({
        data: {
          tenantId,
          customerId,
          invoiceNumber: number,
          status,
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          issueDate: new Date(),
        } as any,
      });
    }

    const numberedCsv = (number: string, status = "Paid") =>
      `Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n${number},QA Import Co,100,0,${status}\n`;
    const numberlessCsv = (ref: string, balance: string, status: string) =>
      `Invoice ID,Customer Name,Total,Balance Due,Invoice Status\n${ref},QA Import Co,100,${balance},${status}\n`;

    const importInvoices = (tenantId: string, csv: string) =>
      tenantCtx.run(tenantId, () => importService.importInvoices(Buffer.from(csv), "user-1"));

    const state = async (invoiceId: string) => {
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      return {
        status: inv.status,
        payments: await prisma.invoicePayment.count({ where: { invoiceId } }),
      };
    };

    /** Numberless path, run 1: import the row open (Sent, balance 100) — creates the invoice + its ref. */
    async function importOpen(tenantId: string, ref: string) {
      const r1 = await importInvoices(tenantId, numberlessCsv(ref, "100", "Sent"));
      expect(r1.imported).toBe(1);
      const invs = await prisma.invoice.findMany({ where: { tenantId } });
      expect(invs).toHaveLength(1);
      return invs[0];
    }

    describe("source-numbered branch (Invoice Number)", () => {
      it.each([
        [InvoiceStatus.VOID, "invoice is voided"],
        [InvoiceStatus.WRITTEN_OFF, "invoice is written off"],
      ])(
        "an in-app %s invoice re-imported as Paid (balance 0) ⇒ row error; status unchanged, no payment",
        async (st, why) => {
          const { tenantId, customerId } = await seed(`num-${st}`);
          const number = `INV-${YEAR}-8101`;
          const inv = await seedNumbered(tenantId, customerId, number, st);
          const r = await importInvoices(tenantId, numberedCsv(number));
          expect(r.errors).toEqual([expect.stringContaining(why)]);
          expect(r.updated).toBe(0);
          expect(await state(inv.id)).toEqual({ status: st, payments: 0 });
        },
        30_000,
      );

      // #2478: the same file re-run against an invoice already in that terminal state changes
      // nothing, so it is a silent skip on every run, never a permanent row error.
      it.each([
        [InvoiceStatus.VOID, "Void"],
        [InvoiceStatus.WRITTEN_OFF, "Written Off"],
      ])(
        "#2478: a %s invoice re-imported unchanged ⇒ a silent skip on every run; nothing written",
        async (st, csvStatus) => {
          const { tenantId, customerId } = await seed(`num-same-${st}`);
          const number = `INV-${YEAR}-8401`;
          const inv = await seedNumbered(tenantId, customerId, number, st);
          for (let run = 0; run < 2; run++) {
            const r = await importInvoices(tenantId, numberedCsv(number, csvStatus));
            expect(r.errors).toEqual([]);
            expect({ updated: r.updated, skipped: r.skipped }).toEqual({ updated: 0, skipped: 1 });
          }
          expect(await state(inv.id)).toEqual({ status: st, payments: 0 });
        },
        30_000,
      );

      it("control: a SENT invoice re-imported as Paid still syncs to PAID", async () => {
        const { tenantId, customerId } = await seed("num-ctl");
        const number = `INV-${YEAR}-8201`;
        const inv = await seedNumbered(tenantId, customerId, number, InvoiceStatus.SENT);
        const r = await importInvoices(tenantId, numberedCsv(number));
        expect(r.errors).toEqual([]);
        expect(r.updated).toBe(1);
        expect((await state(inv.id)).status).toBe(InvoiceStatus.PAID);
      }, 30_000);

      it("race: a void committed while the re-import waits on the Invoice lock ⇒ row error, stays VOID", async () => {
        const { tenantId, customerId } = await seed("num-race");
        const number = `INV-${YEAR}-8301`;
        const inv = await seedNumbered(tenantId, customerId, number, InvoiceStatus.SENT);
        const t2 = new Client({ connectionString: url });
        await t2.connect();
        let result: Awaited<ReturnType<ImportService["importInvoices"]>>;
        let sawBlocked = false;
        try {
          await t2.query("BEGIN");
          await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [inv.id]);
          const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const t1 = importInvoices(tenantId, numberedCsv(number));
          for (let i = 0; i < 800 && !sawBlocked; i++) {
            const q = await t2.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [pid],
            );
            sawBlocked = q.rows[0].n > 0;
            if (!sawBlocked) await new Promise((x) => setTimeout(x, 25));
          }
          await t2.query(
            `UPDATE "Invoice" SET status = 'VOID', "updatedAt" = now() WHERE id = $1`,
            [inv.id],
          );
          await t2.query("COMMIT");
          result = await t1;
        } finally {
          await t2.end();
        }
        expect(sawBlocked).toBe(true); // the entry condition held
        expect(result!.errors).toEqual([expect.stringContaining("invoice is voided")]);
        expect(await state(inv.id)).toEqual({ status: InvoiceStatus.VOID, payments: 0 });
      }, 30_000);
    });

    describe("numberless branch (Invoice ID, via the import's external ref)", () => {
      it.each([
        [InvoiceStatus.VOID, "invoice is voided"],
        [InvoiceStatus.WRITTEN_OFF, "invoice is written off"],
      ])(
        "imported open, %s in-app, re-imported with balance 0 ⇒ row error; no status write, no synthetic payment",
        async (st, why) => {
          const { tenantId } = await seed(`ref-${st}`);
          const ref = `zoho-${RUN}-${st}`;
          const inv = await importOpen(tenantId, ref);
          await prisma.invoice.update({ where: { id: inv.id }, data: { status: st } });

          const r = await importInvoices(tenantId, numberlessCsv(ref, "0", "Paid"));

          expect(r.errors).toEqual([expect.stringContaining(why)]);
          expect({ imported: r.imported, updated: r.updated }).toEqual({ imported: 0, updated: 0 });
          expect(await state(inv.id)).toEqual({ status: st, payments: 0 });
          expect(await prisma.invoice.count({ where: { tenantId } })).toBe(1); // never re-minted
        },
        30_000,
      );

      it.each([
        [InvoiceStatus.VOID, "Void"],
        [InvoiceStatus.WRITTEN_OFF, "Written Off"],
      ])(
        "#2478: imported open, %s in-app, re-imported as that same status ⇒ a silent skip on every run",
        async (st, csvStatus) => {
          const { tenantId } = await seed(`ref-same-${st}`);
          const ref = `zoho-${RUN}-same-${st}`;
          const inv = await importOpen(tenantId, ref);
          await prisma.invoice.update({ where: { id: inv.id }, data: { status: st } });
          for (let run = 0; run < 2; run++) {
            const r = await importInvoices(tenantId, numberlessCsv(ref, "100", csvStatus));
            expect(r.errors).toEqual([]);
            expect({ imported: r.imported, updated: r.updated }).toEqual({
              imported: 0,
              updated: 0,
            });
          }
          expect(await state(inv.id)).toEqual({ status: st, payments: 0 });
          expect(await prisma.invoice.count({ where: { tenantId } })).toBe(1); // never re-minted
        },
        30_000,
      );

      it("control: imported open, re-imported with balance 0 ⇒ PAID with exactly one synthetic payment", async () => {
        const { tenantId } = await seed("ref-ctl");
        const ref = `zoho-${RUN}-ctl`;
        const inv = await importOpen(tenantId, ref);

        const r = await importInvoices(tenantId, numberlessCsv(ref, "0", "Paid"));

        expect(r.errors).toEqual([]);
        expect(r.updated).toBe(1);
        expect(await state(inv.id)).toEqual({ status: InvoiceStatus.PAID, payments: 1 });
      }, 30_000);

      it("race: a void committed while the numberless re-import waits on the Invoice lock ⇒ row error, VOID, no synthetic payment", async () => {
        const { tenantId } = await seed("ref-race");
        const ref = `zoho-${RUN}-race`;
        const inv = await importOpen(tenantId, ref);
        const t2 = new Client({ connectionString: url });
        await t2.connect();
        let result: Awaited<ReturnType<ImportService["importInvoices"]>>;
        let sawBlocked = false;
        try {
          await t2.query("BEGIN");
          await t2.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [inv.id]);
          const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          // The re-import pre-reads the prior (SENT) through its ref, then blocks on the row lock.
          const t1 = importInvoices(tenantId, numberlessCsv(ref, "0", "Paid"));
          for (let i = 0; i < 800 && !sawBlocked; i++) {
            const q = await t2.query(
              `SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [pid],
            );
            sawBlocked = q.rows[0].n > 0;
            if (!sawBlocked) await new Promise((x) => setTimeout(x, 25));
          }
          await t2.query(
            `UPDATE "Invoice" SET status = 'VOID', "updatedAt" = now() WHERE id = $1`,
            [inv.id],
          );
          await t2.query("COMMIT");
          result = await t1;
        } finally {
          await t2.end();
        }
        expect(sawBlocked).toBe(true); // the entry condition held
        expect(result!.errors).toEqual([expect.stringContaining("invoice is voided")]);
        expect(await state(inv.id)).toEqual({ status: InvoiceStatus.VOID, payments: 0 });
      }, 30_000);
    });
  },
);
