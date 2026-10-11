/**
 * SA-773: a named customer's capture with no named source sale prices its chunks from OTHER orders. Those Orders must be locked
 * (id-sorted, in the capture's first lock statement) BEFORE the capture writes a source invoice and asks for the order's sibling
 * invoices, or it can deadlock against a credit note create (Order X, invoice I_a, then I_b): the capture sat on I_b and asked
 * for I_a while the credit note held I_a and asked for I_b (40P01).
 *
 * A raw connection plays the credit note's first two statements (Order X, invoice I_a); the REAL capture starts; the holder then
 * asks for I_b. Postgres' own deadlock counter (pg_stat_database.deadlocks, which a retry cannot hide) must not move: fixed, the
 * capture is queued on Order X holding only its own order, so the holder's I_b is granted and the capture completes after it.
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

describeDb("SA-773 capture locks every chunk's source Order first - real Postgres", () => {
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
    ({ inline } = await buildRefundServices(prisma, `SA773E-${RUN}`));
  }, 120_000);

  afterAll(async () => {
    await cleanupSeeded(prisma, tenantIds);
    await ctl?.end().catch(() => undefined);
    await prisma?.$disconnect();
  }, 120_000);

  const deadlocks = async (): Promise<number> =>
    Number(
      (
        await ctl.query(
          `SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`,
        )
      ).rows[0].n,
    );
  const waiters = async (min: number): Promise<boolean> => {
    for (let i = 0; i < 400; i++) {
      const r = await ctl.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= min) return true;
      await new Promise((x) => setTimeout(x, 25));
    }
    return false;
  };

  it("a capture with no named source, priced from another order's second invoice, queues on that Order and never deadlocks with a credit note create", async () => {
    // order X: invoice I_a bills product Q, invoice I_b bills product A (the goods the customer brings back)
    const s = await seedRefundable(prisma, tenantIds, {
      run: RUN,
      spec: "inline-capture-lock-order.db.spec.ts",
      label: "lock",
      invoices: [
        { lines: [{ product: "Q", qty: 2, subtotal: 20 }] },
        { lines: [{ product: "A", qty: 5, subtotal: 50 }] },
      ],
    });
    // the carrying order: another order of the same customer
    const carrying = await prisma.order.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        orderNumber: `ORD-SA773E-${RUN}-carry`,
        subtotal: 0,
        tax: 0,
        total: 1000,
        status: "PENDING",
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

    const before = await deadlocks();
    const holder = new Client({ connectionString: process.env.DATABASE_URL as string });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [s.orderId]); // the credit note's Order X
    await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoices[0].id]); // ... and I_a

    const capture = tenantCtx
      .run(s.tenantId, () =>
        inline.capture(
          {
            customerId: s.customerId,
            orderId: carrying.id,
            items: [{ productId: s.products.A, qty: 1, boxes: 0, pieces: 1 }],
            returnKey: `lock-${RUN}`,
          },
          staff,
        ),
      )
      .then(
        (v: any) => ({ ok: true as const, v }),
        (e: any) => ({ ok: false as const, e }),
      );
    const queued = await waiters(1);

    let holderError: any;
    try {
      await holder.query(`SET LOCAL lock_timeout = '8s'`);
      await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoices[1].id]); // ... then I_b
      await holder.query("COMMIT");
    } catch (e) {
      holderError = e;
      await holder.query("ROLLBACK").catch(() => undefined);
    } finally {
      await holder.end().catch(() => undefined);
    }
    const out = await capture;

    expect(queued).toBe(true);
    expect(await deadlocks()).toBe(before); // red before: +1
    expect(holderError).toBeUndefined();
    expect(out.ok).toBe(true);
  });
});
