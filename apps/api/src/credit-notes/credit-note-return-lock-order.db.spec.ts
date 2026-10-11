/**
 * SA-773 row 333(b) on real Postgres: a pooled refund mint and a parked-reversal resolve meeting on ONE return no longer
 * deadlock. The resolve takes the Return row and then the Order row (house order, the same as cancel, the refund claim and the
 * inline refund). A raw connection plays the resolve's first two statements while the REAL mint runs between them:
 *
 *   the holder has the Return row; the mint starts and queues; the holder then takes the Order row.
 *
 * Before: the mint took the Order and the order's invoices FIRST and wanted the Return only at its link statement, so it sat on
 * the Order while the holder asked for it: Postgres broke the cycle with 40P01 (on the holder's statement, or the mint's, which
 * retried and so looked fine; the proof is Postgres' own deadlock counter, pg_stat_database.deadlocks). After: the mint's FIRST lock is the Return row, so it queues holding nothing, the holder's Order statement is granted,
 * the holder commits, and the mint then completes. No 40P01 on either side.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import type { CreditNotesService } from "./credit-notes.service";
import { addStandardReturn, cleanupSeeded, seedRefundable } from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);
const SPEC = "credit-note-return-lock-order.db.spec.ts";

describeDb(
  "SA-773 row 333(b): the pooled refund mint and a resolve on one return do not deadlock - real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    let ctl: any;
    const tenantIds: string[] = [];

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ctl = new Client({ connectionString: url });
      await ctl.connect();
      ({ creditNotes } = await buildRefundServices(prisma, `SA773D-${RUN}`));
    }, 120_000);

    afterAll(async () => {
      await cleanupSeeded(prisma, tenantIds);
      await ctl?.end().catch(() => undefined);
      await prisma?.$disconnect();
    }, 120_000);

    const waitForWaiters = async (n: number): Promise<boolean> => {
      for (let i = 0; i < 400; i++) {
        const r = await ctl.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
        );
        if (r.rows[0].n >= n) return true;
        await new Promise((x) => setTimeout(x, 25));
      }
      return false;
    };

    /** Postgres' own count of the deadlocks it has broken in this database: the signal a retry cannot hide. */
    const deadlocks = async (): Promise<number> =>
      Number(
        (
          await ctl.query(
            `SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`,
          )
        ).rows[0].n,
      );

    it("the holder (a resolve: Return, then Order) and the mint (pooled, 2 creditable invoices) finish with no 40P01 and one credit note", async () => {
      const s = await seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: SPEC,
        label: "lock",
        invoices: [
          { lines: [{ product: "A", qty: 5, subtotal: 50 }] },
          { lines: [{ product: "A", qty: 5, subtotal: 50 }] },
        ],
      });
      const ret = await addStandardReturn(prisma, s, {
        number: `RTN-SA773D-${RUN}`,
        status: "RECEIVED",
        items: [{ product: "A", qty: 2 }],
      });

      const deadlocksBefore = await deadlocks();
      const holder = new Client({ connectionString: process.env.DATABASE_URL as string });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Return" WHERE id = $1 FOR UPDATE`, [ret.id]); // the resolve's first lock

      const mint = tenantCtx
        .run(s.tenantId, () =>
          creditNotes.create(
            {
              customerId: s.customerId,
              invoiceId: s.invoices[1].id,
              amount: 20,
              reason: "SA-773 pooled",
            } as any,
            {
              ledgerReversedByReturn: true,
              returnId: ret.id,
              pooledRefund: [{ productId: s.products.A, qty: 2 }],
            },
          ),
        )
        .then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
      const queued = await waitForWaiters(1); // the mint is waiting for the Return row

      let holderError: any;
      try {
        await holder.query(`SET LOCAL lock_timeout = '8s'`);
        await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]); // the resolve's second lock
        await holder.query("COMMIT");
      } catch (e) {
        holderError = e;
        await holder.query("ROLLBACK").catch(() => undefined);
      } finally {
        await holder.end().catch(() => undefined);
      }
      const out = await mint;

      expect(queued).toBe(true);
      // Postgres broke no deadlock: before, the mint (or the holder) was the victim and the mint's retry loop hid it
      expect(await deadlocks()).toBe(deadlocksBefore);
      expect(holderError?.code).not.toBe("40P01"); // red before: the holder's Order statement was the deadlock victim
      expect(holderError).toBeUndefined();
      expect(out.ok).toBe(true);
      expect(await prisma.creditNote.count({ where: { tenantId: s.tenantId } })).toBe(1);
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: ret.id } })).creditNoteId,
      ).not.toBeNull();
    });
  },
);
