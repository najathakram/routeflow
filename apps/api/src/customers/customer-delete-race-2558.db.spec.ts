/**
 * #2558 / SA-510a, real Postgres: the customer-delete time-of-check/time-of-use race.
 *
 * `deleteAllCustomers` runs its blocking-invoice pre-flight OUTSIDE its transaction. Here a SECOND
 * database connection flips the customer's DRAFT invoice to OVERDUE right after that pre-flight
 * passes and before the transaction opens, which is exactly the window that used to destroy the
 * invoice. The in-transaction re-check must refuse (409), roll back, and leave the invoice and its
 * payment in place.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). The tenant is a throwaway
 * `qa-2558-<run>` slug approved by `assertTestTenant`; `afterAll` deletes exactly what it created.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { CustomersService } from "./customers.service";
import * as preflight from "./customer-delete-preflight";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "customer delete: an invoice turned OVERDUE mid-delete survives (#2558, SA-510a)",
  () => {
    let prisma: PrismaService;
    let second: PrismaService; // a separate client: its own pool, its own connection
    let tenantCtx: TenantContextService;
    let service: CustomersService;
    let tenantId: string;
    let invoiceId: string;
    let paymentId: string;
    let customerId: string;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      second = new PrismaService(new TenantContextService());
      await prisma.$connect();
      await second.$connect();

      const slug = assertTestTenant(`qa-2558-${RUN}`, "customer-delete-race-2558.db.spec.ts");
      tenantId = (await prisma.tenant.create({ data: { slug, name: `2558 ${slug}` } })).id;
      const user = await prisma.user.create({
        data: {
          email: `c2558-${RUN}@example.invalid`,
          username: `c2558-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      customerId = (
        await prisma.customer.create({
          data: { userId: user.id, businessName: "2558 race", contactName: "2558", tenantId },
        })
      ).id;
      invoiceId = (
        await prisma.invoice.create({
          data: {
            tenantId,
            customerId,
            invoiceNumber: `INV-2558-${RUN}`,
            status: "DRAFT",
            subtotal: 50,
            total: 50,
          },
        })
      ).id;
      paymentId = (
        await prisma.invoicePayment.create({
          data: { tenantId, invoiceId, amount: 10, method: "CASH" },
        })
      ).id;

      const stub = {} as never;
      service = new CustomersService(
        prisma,
        { get: () => null } as never,
        stub,
        stub,
        stub,
        { hasFlag: async () => false } as never,
        stub,
        { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) } as never,
        stub,
      );
    });

    afterAll(async () => {
      await prisma.invoicePayment.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
      await second?.$disconnect();
      await prisma?.$disconnect();
    });

    it("a second connection flips the invoice to OVERDUE between the pre-flight and the tx: refused, nothing destroyed", async () => {
      const realPreflight = preflight.assertNoBlockingInvoices;
      const spy = jest
        .spyOn(preflight, "assertNoBlockingInvoices")
        .mockImplementation(async (db, ids, opts) => {
          await realPreflight(db, ids, opts); // passes: the invoice is still DRAFT
          await second.invoice.update({ where: { id: invoiceId }, data: { status: "OVERDUE" } });
        });
      try {
        const caught: any = await tenantCtx
          .run(tenantId, () => service.deleteAllCustomers())
          .catch((e) => e);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(caught.message).toContain(`${customerId}: 1 invoice(s)`);
      } finally {
        spy.mockRestore();
      }

      const inv = await second.invoice.findUnique({ where: { id: invoiceId } });
      expect(inv?.status).toBe("OVERDUE");
      expect(await second.invoicePayment.findUnique({ where: { id: paymentId } })).not.toBeNull();
      expect(await second.customer.findUnique({ where: { id: customerId } })).not.toBeNull();
    });
  },
);
