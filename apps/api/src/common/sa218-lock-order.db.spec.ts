/**
 * SA-218 / #2116 — real-Postgres proof that mergeCustomers and the order-credit sync take the Order
 * row before any Invoice row (house lock order: advisory → Return → Order → Invoice → rows), so
 * neither can deadlock against an Order → Invoice writer (#2083's invoices update(): Order FOR
 * UPDATE, then Invoice FOR UPDATE).
 *
 * Each case is one deterministic interleaving on two connections:
 *   1. the WRITER (a raw `pg` connection) takes the Order row FOR UPDATE;
 *   2. the SERVICE under test starts, and a barrier waits until Postgres reports it BLOCKED by the
 *      writer (`pg_blocking_pids`), so the interleaving is real, never a timing guess;
 *   3. only then does the writer take the Invoice row FOR UPDATE and commit.
 * Master: the service already holds that Invoice when it blocks on the Order (it wrote the Invoice
 * first), so step 3 closes a cycle and Postgres aborts one side with 40P01. Fixed: the service
 * blocks before touching any Invoice, the writer takes it at once, and both finish.
 *
 * The writer only LOCKS (it writes nothing): that isolates the lock-ORDER property. A writer that
 * also UPDATEs the Invoice while the Serializable credit tx waits makes that tx fail 40001 when it
 * later writes the same Invoice (SSI, its snapshot predates the wait): detected, no corruption, and
 * not a deadlock. That is pre-existing Serializable behaviour this fix does not change.
 *
 * WHY THE DB LANE: row locks and deadlock detection exist only in a real Postgres. Collected only by
 * `jest.db.config.js` (`.db.spec.ts$`); run via `npm run local:test:db`.
 *
 * SAFETY: a throwaway `qa-sa218-<run>` tenant (`assertTestTenant`) — mergeCustomers DELETES a
 * customer and its user, which must never touch the shared `test` seed; `afterAll` deletes exactly
 * this tenant's rows, in FK order.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CustomersService } from "../customers/customers.service";
import { OrdersService } from "../orders/orders.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** The SQLSTATE behind an error from either side: a raw `pg` error, or Prisma's P2034 / adapter error. */
function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}
function describeErr(err: unknown): string {
  return err === undefined
    ? "none"
    : `${sqlState(err) ?? "?"}: ${String((err as any)?.message ?? err)}`;
}

describeDb(
  "SA-218 (#2116) — Order before Invoice on real Postgres: no 40P01 against an Order → Invoice writer",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let customers: CustomersService;
    let orders: OrdersService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-sa218-${run}`, "sa218-lock-order.db.spec.ts");
    let tenantId = "";

    async function seedCustomer(tag: string) {
      const user = await raw.user.create({
        data: {
          email: `${tag}-${run}@example.test`,
          username: `${tag}-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      return raw.customer.create({
        data: {
          userId: user.id,
          businessName: `SA218 ${tag}`,
          contactName: `SA218 ${tag}`,
          tenantId,
        },
      });
    }

    async function seedOrderWithInvoice(
      customerId: string,
      tag: string,
      invoiceStatus: "SENT" | "PARTIAL",
    ) {
      const order = await raw.order.create({
        data: { customerId, status: "PENDING", subtotal: "100.00", total: "100.00", tenantId },
      });
      const invoice = await raw.invoice.create({
        data: {
          invoiceNumber: `INV-SA218-${run}-${tag}`,
          customerId,
          orderId: order.id,
          status: invoiceStatus,
          subtotal: "100.00",
          total: "100.00",
          tenantId,
        },
      });
      return { orderId: order.id, invoiceId: invoice.id };
    }

    /** Polls until some backend is blocked by `blockerPid`; false if `done()` or the deadline comes first. */
    async function waitUntilBlockedBy(blockerPid: number, done: () => boolean): Promise<boolean> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !done()) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [blockerPid],
        );
        if (rows[0].n > 0) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    }

    /** Steps 1–3 of the header, against `service`. Every failure is captured, never thrown early. */
    async function raceAgainstOrderThenInvoiceWriter(
      ids: { orderId: string; invoiceId: string },
      service: () => Promise<unknown>,
    ): Promise<{ blocked: boolean; writer: string; service: string }> {
      const writer = await pool.connect();
      let writerError: unknown;
      let serviceError: unknown;
      let blocked = false;
      try {
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout = '15s'");
        const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await writer.query('SELECT id FROM "Order" WHERE id = $1 FOR UPDATE', [ids.orderId]);

        let settled = false;
        const running = service()
          .then(
            () => undefined,
            (err) => {
              serviceError = err;
            },
          )
          .finally(() => {
            settled = true;
          });
        blocked = await waitUntilBlockedBy(pid, () => settled);

        try {
          await writer.query('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', [ids.invoiceId]);
          await writer.query("COMMIT");
        } catch (err) {
          writerError = err;
          await writer.query("ROLLBACK").catch(() => undefined);
        }
        await running;
      } finally {
        writer.release();
      }
      return { blocked, writer: describeErr(writerError), service: describeErr(serviceError) };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();

      // Object.create bypasses Nest DI (the parked-reversal-resolution.db.spec.ts pattern): prisma is
      // the REAL connected service, so each method runs its real transaction and real row locks.
      customers = Object.assign(Object.create(CustomersService.prototype), {
        prisma,
        logger: new Logger("sa218-customers"),
      });
      // The REAL credit sync/settle; only the commission side-effect is stubbed (not a lock path here).
      const creditNotes = new CreditNotesService(
        prisma,
        {} as any,
        {} as any,
        { syncInvoiceCommissionSafe: async () => undefined } as any,
        {} as any,
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        creditNotes,
        // The draft-invoice reconcile runs OUTSIDE the credit tx, before it opens — not the SA-218 edge.
        invoicesService: {
          resyncOrderInvoicesForEdit: async () => null,
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        logger: new Logger("sa218-orders"),
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `SA218 ${slug}` } })).id;
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await raw.invoicePayment.deleteMany({ where: { tenantId } });
        await raw.orderCreditNote.deleteMany({ where: { tenantId } });
        await raw.creditNote.deleteMany({ where: { tenantId } });
        await raw.invoice.deleteMany({ where: { tenantId } });
        await raw.order.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("(a) mergeCustomers vs an Order → Invoice writer on the secondary's rows: no 40P01, both finish", async () => {
      const primary = await seedCustomer("a-primary");
      const secondary = await seedCustomer("a-secondary");
      const ids = await seedOrderWithInvoice(secondary.id, "a", "SENT");

      const outcome = await raceAgainstOrderThenInvoiceWriter(ids, () =>
        tenantCtx.run(tenantId, () => customers.mergeCustomers(primary.id, secondary.id)),
      );

      expect(outcome).toEqual({ blocked: true, writer: "none", service: "none" });
      // The merge really landed after the writer committed.
      const order = await raw.order.findUniqueOrThrow({ where: { id: ids.orderId } });
      const invoice = await raw.invoice.findUniqueOrThrow({ where: { id: ids.invoiceId } });
      expect([order.customerId, invoice.customerId]).toEqual([primary.id, primary.id]);
      expect(await raw.customer.findUnique({ where: { id: secondary.id } })).toBeNull();
    }, 60_000);

    it("(b) the order-credit sync tx vs an Order → Invoice writer on the same order: no 40P01, both finish", async () => {
      const customer = await seedCustomer("b");
      const ids = await seedOrderWithInvoice(customer.id, "b", "PARTIAL");
      // A credit already applied to the order's invoice (30 of 100), selected on the order...
      const cnOld = await raw.creditNote.create({
        data: {
          creditNoteNumber: `CN-SA218-${run}-old`,
          customerId: customer.id,
          amount: "30.00",
          amountUsed: "30.00",
          status: "APPLIED",
          appliedToInvoiceId: ids.invoiceId,
          appliedAt: new Date(),
          tenantId,
        },
      });
      await raw.invoicePayment.create({
        data: {
          invoiceId: ids.invoiceId,
          amount: "30.00",
          method: "CREDIT_NOTE",
          creditNoteId: cnOld.id,
          status: "PAID",
          tenantId,
        },
      });
      await raw.orderCreditNote.create({
        data: { orderId: ids.orderId, creditNoteId: cnOld.id, amount: null, tenantId },
      });
      // ...and a new one the operator swaps in: the sync pulls the old credit back (an Invoice
      // write) and inserts the new intent (a KEY SHARE on the Order) — master's Invoice → Order edge.
      const cnNew = await raw.creditNote.create({
        data: {
          creditNoteNumber: `CN-SA218-${run}-new`,
          customerId: customer.id,
          amount: "20.00",
          amountUsed: "0.00",
          status: "ISSUED",
          tenantId,
        },
      });

      // replayMergeReconcile is one of reconcileOrderAfterEdit's two real callers (a PENDING order
      // takes the draft-reconcile branch, then the Serializable credit tx under test).
      const outcome = await raceAgainstOrderThenInvoiceWriter(ids, () =>
        tenantCtx.run(tenantId, () =>
          orders.replayMergeReconcile(ids.orderId, customer.id, [
            { creditNoteId: cnNew.id } as any,
          ]),
        ),
      );

      expect(outcome).toEqual({ blocked: true, writer: "none", service: "none" });
      // The sync + settle really landed: the old credit is back in the wallet, the new one applied.
      const intents = await raw.orderCreditNote.findMany({ where: { orderId: ids.orderId } });
      expect(intents.map((i) => i.creditNoteId)).toEqual([cnNew.id]);
      const payments = await raw.invoicePayment.findMany({ where: { invoiceId: ids.invoiceId } });
      expect(payments.map((p) => [p.creditNoteId, Number(p.amount)])).toEqual([[cnNew.id, 20]]);
      const old = await raw.creditNote.findUniqueOrThrow({ where: { id: cnOld.id } });
      expect([Number(old.amountUsed), old.status]).toEqual([0, "ISSUED"]);
    }, 60_000);
  },
);
