/**
 * #2587 / SA-516, real Postgres: a bulk customer delete never destroys a money record. SA-516d:
 * two more customers each hold only a transaction payment / only a DRAFT invoice's payment, so
 * the two relation-filtered counts are executed against Postgres too. The first
 * customer holds exactly the records the old record-free logic treated as disposable, a VOID
 * credit note and a fully drawn-down (balance 0) advance payment, and no invoice at all, so
 * the #2558 invoice guards have nothing to say. Both bulk paths must now refuse (409) and leave
 * the credit note, the advance payment and the customer byte-identical. Pre-fix, both paths
 * hard-delete them all.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). The tenant is a throwaway
 * `qa-2587-<run>` slug approved by `assertTestTenant`; `afterAll` deletes exactly what it created.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { Client } from "pg";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("customer bulk deletes keep every money record (#2587, SA-516)", () => {
  let prisma: PrismaService;
  let obs: Client;
  let tenantCtx: TenantContextService;
  let service: CustomersService;
  let tenantId: string;
  let customerId: string;
  let creditNoteId: string;
  let advanceId: string;
  // SA-516d: the two relation-filtered counts (payment via transaction.customerId, invoice payment
  // via invoice.customerId) each get a customer of their own, so each 409 entry proves its filter.
  let paymentCustomerId: string;
  let invoicePaymentCustomerId: string;
  const tracked: Array<[string, string]> = []; // [table, id] compared byte-for-byte

  async function rowJson(table: string, id: string): Promise<string | null> {
    const r = await obs.query(`SELECT to_jsonb(t)::text AS j FROM "${table}" t WHERE t.id = $1`, [
      id,
    ]);
    return r.rows[0]?.j ?? null;
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    obs = new Client({ connectionString: url });
    await obs.connect();

    const slug = assertTestTenant(
      `qa-2587-${RUN}`,
      "customer-delete-money-records-2587.db.spec.ts",
    );
    tenantId = (await prisma.tenant.create({ data: { slug, name: `2587 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `c2587-${RUN}@example.invalid`,
        username: `c2587-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "2587 money", contactName: "2587", tenantId },
      })
    ).id;
    creditNoteId = (
      await prisma.creditNote.create({
        data: {
          tenantId,
          customerId,
          creditNoteNumber: `CN-2587-${RUN}`,
          amount: 10,
          status: "VOID",
        },
      })
    ).id;
    advanceId = (
      await prisma.advancePayment.create({
        data: { tenantId, customerId, amount: 25, balance: 0, method: "CASH" },
      })
    ).id;

    const mkCustomer = async (tag: string) => {
      const u = await prisma.user.create({
        data: {
          email: `c2587${tag}-${RUN}@example.invalid`,
          username: `c2587${tag}-${RUN}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const c = await prisma.customer.create({
        data: { userId: u.id, businessName: `2587 ${tag}`, contactName: "2587", tenantId },
      });
      tracked.push(["User", u.id], ["Customer", c.id]);
      return c.id;
    };
    // B: a transaction payment and nothing else (the payment's owner is reachable only via Transaction).
    paymentCustomerId = await mkCustomer("pay");
    const txn = await prisma.transaction.create({
      data: { tenantId, customerId: paymentCustomerId, totalOwed: 40 },
    });
    const pay = await prisma.payment.create({
      data: { tenantId, transactionId: txn.id, amount: 15, method: "CASH" },
    });
    // C: a DRAFT (non-blocking) invoice with a payment (its owner is reachable only via Invoice).
    invoicePaymentCustomerId = await mkCustomer("ipay");
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: invoicePaymentCustomerId,
        invoiceNumber: `INV-2587-${RUN}`,
        status: "DRAFT",
        subtotal: 30,
        total: 30,
      },
    });
    const ipay = await prisma.invoicePayment.create({
      data: { tenantId, invoiceId: inv.id, amount: 5, method: "CASH" },
    });
    tracked.push(
      ["CreditNote", creditNoteId],
      ["AdvancePayment", advanceId],
      ["Customer", customerId],
      ["User", user.id],
      ["Transaction", txn.id],
      ["Payment", pay.id],
      ["Invoice", inv.id],
      ["InvoicePayment", ipay.id],
    );

    const stub = {} as never;
    service = new CustomersService(
      prisma,
      { get: () => null } as never,
      stub,
      stub,
      stub,
      { can: async () => false } as never, // EntitlementAuthority (#2241)
      stub,
      { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) } as never,
      stub,
    );
  });

  afterAll(async () => {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.transaction.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await obs?.end().catch(() => undefined);
    await prisma?.$disconnect();
  });

  it.each([
    ["deleteAllCustomers", () => service.deleteAllCustomers()],
    [
      "deleteImportedCustomers (no buyer link ⇒ selected)",
      () => service.runImportedCustomersCleanup(),
    ],
  ])(
    "%s: credit note / advance, transaction payment, invoice payment ⇒ 409 naming each owner, all rows byte-identical",
    async (_n, run) => {
      const snap = () => Promise.all(tracked.map(([t, id]) => rowJson(t, id)));
      const before = await snap();
      expect(before.every((r) => r !== null)).toBe(true);

      const caught: any = await tenantCtx.run(tenantId, () => run()).catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain(`${customerId}: 2 record(s)`);
      expect(caught.message).toContain(`${paymentCustomerId}: 1 record(s)`);
      expect(caught.message).toContain(`${invoicePaymentCustomerId}: 1 record(s)`);

      expect(await snap()).toEqual(before);
    },
  );
});

/**
 * #2591 / SA-516b, real Postgres: cleanup-imported on a customer whose RouteStop is referenced by
 * a RouteRunStop (delivery history). Pre-fix this was the FK 500
 * (RouteRunStop_routeStopId_fkey); now it is a 409 naming the customer, and the route, run, stops
 * and the customer are all kept byte-identical. Its own throwaway `qa-2591-<run>` tenant.
 */
describeDb("cleanup imported refuses a customer with delivery history (#2591, SA-516b)", () => {
  let prisma: PrismaService;
  let obs: Client;
  let tenantCtx: TenantContextService;
  let service: CustomersService;
  let tenantId: string;
  const rows: Array<[string, string]> = []; // [table, id] to compare before/after

  async function snapshot(): Promise<Array<string | null>> {
    const out: Array<string | null> = [];
    for (const [table, id] of rows) {
      const r = await obs.query(`SELECT to_jsonb(t)::text AS j FROM "${table}" t WHERE t.id = $1`, [
        id,
      ]);
      out.push(r.rows[0]?.j ?? null);
    }
    return out;
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    obs = new Client({ connectionString: url });
    await obs.connect();

    const slug = assertTestTenant(
      `qa-2591-${RUN}`,
      "customer-delete-money-records-2587.db.spec.ts",
    );
    tenantId = (await prisma.tenant.create({ data: { slug, name: `2591 ${slug}` } })).id;
    const user = await prisma.user.create({
      data: {
        email: `c2591-${RUN}@example.invalid`,
        username: `c2591-${RUN}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "2591 history", contactName: "2591", tenantId },
    });
    const route = await prisma.route.create({ data: { tenantId, name: `2591 ${RUN}` } });
    const stop = await prisma.routeStop.create({
      data: { tenantId, routeId: route.id, customerId: customer.id, stopNumber: 1 },
    });
    const run = await prisma.routeRun.create({
      data: { tenantId, routeId: route.id, scheduledDate: new Date("2026-09-01T12:00:00Z") },
    });
    // customerId left null: the history is reachable only through the customer's RouteStop.
    const runStop = await prisma.routeRunStop.create({
      data: { tenantId, routeRunId: run.id, routeStopId: stop.id, stopNumber: 1 },
    });
    rows.push(
      ["Customer", customer.id],
      ["User", user.id],
      ["Route", route.id],
      ["RouteStop", stop.id],
      ["RouteRun", run.id],
      ["RouteRunStop", runStop.id],
    );

    const stub = {} as never;
    service = new CustomersService(
      prisma,
      { get: () => null } as never,
      stub,
      stub,
      stub,
      { can: async () => false } as never, // EntitlementAuthority (#2241)
      stub,
      { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) } as never,
      stub,
    );
  });

  afterAll(async () => {
    await prisma.routeRunStop.deleteMany({ where: { tenantId } });
    await prisma.routeRun.deleteMany({ where: { tenantId } });
    await prisma.routeStop.deleteMany({ where: { tenantId } });
    await prisma.route.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await obs?.end().catch(() => undefined);
    await prisma?.$disconnect();
  });

  it("a RouteStop referenced by a RouteRunStop ⇒ 409 naming the customer (not the FK 500), every row kept", async () => {
    const before = await snapshot();
    expect(before.every((r) => r !== null)).toBe(true);

    const caught: any = await tenantCtx
      .run(tenantId, () => service.runImportedCustomersCleanup())
      .catch((e) => e);
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.message).toContain("delivery history");
    expect(caught.message).toContain(rows[0][1]);

    expect(await snapshot()).toEqual(before);
  });
});
