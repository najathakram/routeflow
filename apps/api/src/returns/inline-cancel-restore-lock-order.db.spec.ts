/**
 * SA-773 follow-up (A): an inline cancel of a store-credit return gives its credit note's applications back, and an application
 * can sit on ANOTHER order's invoice. Writing that invoice (its payment row, its status) without the other order's lock let it
 * race a value-writer on that order, which holds the Order and then the invoice (house order Return -> Order -> Invoice):
 * the cancel read the invoice's payments unlocked and wrote a status computed from them after the other writer committed.
 *
 * A raw connection plays that value-writer (Order Y, then invoice I_Y, then a cash payment on I_Y) and the REAL cancel starts.
 * Fixed, the cancel's single Order lock statement (the carrying order together with every order the note was applied to)
 * queues on Order Y before it writes anything, reads I_Y's payments after the holder committed, and the invoice ends
 * PARTIAL (the cash counted). Before, it was queued on the invoice UPDATE, having read the payments first, and wrote a stale
 * status over the holder's payment.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { cleanupSeeded, seedRefundable } from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "SA-773 inline cancel locks the orders its credit note was applied to - real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let inline: any;
    let ctl: any;
    const tenantIds: string[] = [];

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ctl = new Client({ connectionString: url });
      await ctl.connect();
      ({ inline } = await buildRefundServices(prisma, `SA773F-${RUN}`));
    }, 120_000);

    afterAll(async () => {
      await cleanupSeeded(prisma, tenantIds);
      await ctl?.end().catch(() => undefined);
      await prisma?.$disconnect();
    }, 120_000);

    const waiters = async (min: number): Promise<boolean> => {
      for (let i = 0; i < 160; i++) {
        const r = await ctl.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (r.rows[0].n >= min) return true;
        await new Promise((x) => setTimeout(x, 25));
      }
      return false;
    };

    it("queues on the other order's lock before writing its invoice, and the invoice status counts the payment that committed meanwhile", async () => {
      // order Y: one invoice of 100, paid entirely by a credit note application of the return's note
      const s = await seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: "inline-cancel-restore-lock-order.db.spec.ts",
        label: "cancel",
        invoices: [{ lines: [{ product: "Q", qty: 1, subtotal: 100 }] }],
      });
      const invoiceId = s.invoices[0].id;
      await prisma.invoicePayment.deleteMany({ where: { invoiceId } });
      const note = await prisma.creditNote.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          creditNoteNumber: `CN-SA773F-${RUN}`,
          amount: 100,
          amountUsed: 100,
          status: "APPLIED",
          appliedToInvoiceId: invoiceId,
        } as any,
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId,
          amount: 100,
          method: "CREDIT_NOTE",
          status: "PAID",
          creditNoteId: note.id,
        } as any,
      });
      // the carrying order of the return (another order of the same customer) and the REFUNDED store-credit return itself
      const carrying = await prisma.order.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderNumber: `ORD-SA773F-${RUN}-carry`,
          subtotal: 0,
          tax: 0,
          total: 0,
          status: "PENDING",
        } as any,
      });
      const ret = await prisma.return.create({
        data: {
          tenantId: s.tenantId,
          customerId: s.customerId,
          orderId: carrying.id,
          kind: "INLINE",
          reason: "DAMAGED",
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          creditNoteId: note.id,
          returnNumber: `RET-SA773F-${RUN}`,
          items: {
            create: [{ tenantId: s.tenantId, productId: s.products.Q, qty: 1, restock: false }],
          },
        } as any,
      });
      const staff = {
        sub: s.userId,
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: s.tenantId,
        tenantSlug: "x",
      } as any;

      // the value-writer on Order Y: Order, then invoice, then a cash payment on it (uncommitted)
      const holder = new Client({ connectionString: process.env.DATABASE_URL as string });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]);
      await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [invoiceId]);
      await holder.query(
        `INSERT INTO "InvoicePayment" (id, "tenantId", "invoiceId", amount, method, status)
       VALUES ($1, $2, $3, 40, 'CASH', 'PAID')`,
        [randomUUID(), s.tenantId, invoiceId],
      );

      const cancel = tenantCtx
        .run(s.tenantId, () => inline.cancel(ret.id, staff))
        .then(
          (v: any) => ({ ok: true as const, v }),
          (e: any) => ({ ok: false as const, e }),
        );
      const queued = await waiters(1);
      const blockedOn: Array<{ query: string }> = (
        await ctl.query(
          `SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        )
      ).rows;
      await holder.query("COMMIT");
      await holder.end().catch(() => undefined);
      const out = await cancel;

      expect(queued).toBe(true);
      // WHAT it waits on: the Order lock statement (nothing of Y written yet); before: the invoice UPDATE after an unlocked read
      const blocked = blockedOn.map((r) => r.query).join(" | ");
      expect(blocked).toMatch(/FROM "Order"/);
      expect(blocked).not.toMatch(/"Invoice"/);
      expect(out.ok).toBe(true);
      const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      expect(inv?.status).toBe("PARTIAL"); // the cash that committed meanwhile counts; before: SENT, a stale write
      expect(
        await prisma.invoicePayment.count({ where: { invoiceId, method: "CREDIT_NOTE" } }),
      ).toBe(0);
      expect((await prisma.creditNote.findUnique({ where: { id: note.id } }))?.status).toBe("VOID");
    }, 60_000);
  },
);
