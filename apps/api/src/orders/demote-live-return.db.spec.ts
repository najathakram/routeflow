/**
 * SA-1101 A-5 (B1272) on REAL Postgres: the office demotion out of DELIVERED refuses while the order holds a live
 * return. Order stock books once and a return books its own credit, so an open order that still carries a live
 * return double-credits through four sinks (the order cancel, a line edit's stock settle, an order delete, a customer
 * delete). The guard goes where that state is made: DELIVERED -> CONFIRMED and DELIVERED -> PARTIALLY_DELIVERED.
 *
 * RO-24 (legacy DELIVERED order, no recorded quantities: the case B692's cancel guard misses; 94, not 104) and its
 * recorded-quantities twin, RO-25 (-> PARTIALLY_DELIVERED), RO-26 (SHIP order at a business that bills at shipment),
 * RO-27 (cancel the return first and the same demotion then cancel credits once: stock 100).
 *
 * The REAL OrdersService.changeStatus (transition table, reason rule, demotion guard, then the write), the REAL
 * updateStatusWithShipMarker for the SHIP marker row, and the REAL ReturnsService run over the order-stock world's
 * books: an order that sold 10 of a product opened at 100 leaves the counter at 90. Test tenant only (qa-b1272-*,
 * assertTestTenant in the world). Run: `npm run local:test:db`.
 */
import { Test } from "@nestjs/testing";
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { PrismaService } from "../prisma/prisma.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { buildStatusUpdateData } from "./order-status-claim";
import { SHIP_STATE_REOPENED, updateStatusWithShipMarker } from "./order-ship-state";
import { seedInlineReturn } from "../returns/testing/inline-return-seed";
import { IdempotencyService } from "../common/idempotency.service";
import { returnCustomerLockKey } from "../returns/return-customer-lock";

const START = 100;
const SOLD = 10;
const REASON = "office correction";
const DEMOTE_MESSAGE =
  "This order has a return. To change its delivery status, cancel the return first.";

describeDb("SA-1101 A-5 (B1272): a live return blocks the office demotion — real Postgres", () => {
  let w: OrderStockWorld;
  let returns: ReturnsService;
  let cnSeq = 0;

  beforeAll(async () => {
    w = await buildOrderStockWorld("b1272", "demote-live-return.db.spec.ts");
    Object.assign(w.orders, {
      oversellReader: { read: async () => "off" },
      systemConfig: { get: async () => "0", getAll: async () => ({}) },
      creditNotes: Object.assign(w.orders.creditNotes, {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      }),
    });
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        ReturnsService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        { provide: PrismaService, useValue: w.prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        {
          provide: NumberingService,
          useValue: {
            reserveNext: jest.fn().mockImplementation(async () => `CN-B1272-${++cnSeq}`),
          },
        },
      ],
    }).compile();
    returns = mod.get(ReturnsService);
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    const where = { where: { tenantId: w?.tenantId } };
    if (w) {
      await w.prisma.orderRevision.deleteMany(where).catch(swallow);
      await w.prisma.deliveryMutation.deleteMany(where).catch(swallow);
      await w.prisma.returnItem.deleteMany(where).catch(swallow);
      await w.prisma.return.deleteMany(where).catch(swallow);
      await w.prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await w.prisma.creditNote.deleteMany(where).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  type Seed = { productId: string; orderId: string; lineId: string; deliveredAt: Date };

  /**
   * A DELIVERED order that sold 10 of a product opened at 100 (the counter is at 90). `recorded: false` is the LEGACY
   * row: no `deliveredQty`, no DeliveryMutation (what an order delivered before quantities were recorded looks like).
   */
  async function deliveredOrder(
    tag: string,
    opts: { recorded?: boolean; ship?: boolean } = {},
  ): Promise<Seed> {
    const productId = await w.product(tag, START);
    const { order, items } = await w.bookOrder({
      status: "DELIVERED",
      lines: [{ productId, qty: SOLD }],
    });
    const deliveredAt = new Date("2026-10-01T12:00:00.000Z");
    await w.prisma.order.update({
      where: { id: order.id },
      data: { deliveredAt, ...(opts.ship ? { fulfillPath: "SHIP" } : {}) } as never,
    });
    if (opts.recorded) {
      await w.prisma.orderItem.update({ where: { id: items[0].id }, data: { deliveredQty: SOLD } });
      await w.prisma.deliveryMutation.create({
        data: {
          tenantId: w.tenantId,
          orderId: order.id,
          orderItemId: items[0].id,
          productId,
          type: "DELIVERED",
          quantityDelivered: SOLD,
        },
      });
    }
    return { productId, orderId: order.id, lineId: items[0].id, deliveredAt };
  }

  const staffReturn = (s: Seed, qty: number) =>
    w.inTenant(() =>
      returns.create(
        {
          orderId: s.orderId,
          reason: "EXCESS_ORDER",
          items: [{ productId: s.productId, orderItemId: s.lineId, qty }],
        } as any,
        w.jwt.sub,
        "OPERATOR",
      ),
    );
  const receivedReturn = async (s: Seed, qty: number) => {
    const ret: any = await staffReturn(s, qty);
    await w.inTenant(() => returns.approve(ret.id));
    await w.inTenant(() => returns.receive(ret.id, w.jwt.sub, { restock: true }));
    return ret.id as string;
  };
  /** What the office does on the order page: Reopen order (-> CONFIRMED), with the required reason. */
  const reopen = (orderId: string) =>
    w.inTenant(() =>
      w.orders.changeStatus(
        orderId,
        { status: "CONFIRMED", reason: REASON } as never,
        w.jwt as never,
      ),
    );
  const cancelOrder = (orderId: string) =>
    w.inTenant(() =>
      w.orders.changeStatus(orderId, { status: "CANCELLED" } as never, w.jwt as never),
    );
  const row = (orderId: string) => w.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const refusedWith409 = {
    response: { code: "ORDER_HAS_RETURN", message: DEMOTE_MESSAGE },
  };

  it("RO-24: a legacy DELIVERED order with a received return (+4) cannot be reopened: 409 ORDER_HAS_RETURN, status, deliveredAt and stock 94 unchanged", async () => {
    const s = await deliveredOrder("ro24");
    await receivedReturn(s, 4);
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);

    await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);

    const after = await row(s.orderId);
    expect(after.status).toBe("DELIVERED");
    expect(after.deliveredAt?.toISOString()).toBe(s.deliveredAt.toISOString());
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4); // 94: the cancel can no longer read 104
  }, 120_000);

  it("RO-24b: the same with recorded quantities (deliveredQty 10 and a DELIVERED mutation row) answers the same 409", async () => {
    const s = await deliveredOrder("ro24b", { recorded: true });
    await receivedReturn(s, 4);

    await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);
    expect((await row(s.orderId)).status).toBe("DELIVERED");
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
  }, 120_000);

  it("RO-24c: a PENDING (not yet received) return blocks it too: every status but REJECTED / CANCELLED is live", async () => {
    const s = await deliveredOrder("ro24c");
    await staffReturn(s, 3);

    await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);
    expect((await row(s.orderId)).status).toBe("DELIVERED");
  }, 120_000);

  it("RO-25: DELIVERED -> PARTIALLY_DELIVERED (with the per-line quantities the office types) is refused the same way; no PD quantities are written", async () => {
    const s = await deliveredOrder("ro25");
    await receivedReturn(s, 4);

    await expect(
      w.inTenant(() =>
        w.orders.changeStatus(
          s.orderId,
          {
            status: "PARTIALLY_DELIVERED",
            reason: REASON,
            deliveries: [{ orderItemId: s.lineId, quantityDelivered: 6 }],
          } as never,
          w.jwt as never,
        ),
      ),
    ).rejects.toMatchObject(refusedWith409);

    expect((await row(s.orderId)).status).toBe("DELIVERED");
    expect(await w.prisma.deliveryMutation.count({ where: { orderId: s.orderId } })).toBe(0);
    const line = await w.prisma.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
    expect(Number(line.deliveredQty ?? 0)).toBe(0);
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
  }, 120_000);

  it("RO-26: a SHIP order at a business that bills at shipment: the reopen is refused and leaves no SHIP_STATE_REOPENED marker row", async () => {
    const s = await deliveredOrder("ro26", { ship: true });
    await receivedReturn(s, 4);
    const markers = () =>
      w.prisma.orderRevision.count({ where: { orderId: s.orderId, source: SHIP_STATE_REOPENED } });
    expect(await markers()).toBe(0);

    // The marker transaction (updateStatusWithShipMarker with a business that bills at shipment): the seat
    // changeStatus ends in, driven directly because the world has no feature-config service.
    await expect(
      w.inTenant(async () => {
        const order = await row(s.orderId);
        return updateStatusWithShipMarker(
          {
            prisma: w.prisma,
            featureConfig: { getEffectiveMode: async () => "ship" },
          },
          order as never,
          { status: "CONFIRMED" as never, reason: REASON },
          w.jwt as never,
          buildStatusUpdateData(order, "CONFIRMED" as never, {
            isDeliveredDemotion: true,
            reason: REASON,
          }),
        );
      }),
    ).rejects.toMatchObject(refusedWith409);

    expect(await markers()).toBe(0);
    expect((await row(s.orderId)).status).toBe("DELIVERED");
  }, 120_000);

  it("RO-27: cancel the return first (stock 90), then reopen and cancel the order: both succeed and stock is 100, credited once", async () => {
    const s = await deliveredOrder("ro27");
    const retId = await receivedReturn(s, 4);
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
    await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);

    await w.inTenant(() => returns.cancel(retId, w.jwt as never));
    expect(await w.stockOf(s.productId)).toBe(START - SOLD);

    await reopen(s.orderId);
    expect((await row(s.orderId)).status).toBe("CONFIRMED");
    await cancelOrder(s.orderId);
    expect((await row(s.orderId)).status).toBe("CANCELLED");
    expect(await w.stockOf(s.productId)).toBe(START); // start, not start + 4 or start + 10 on top of a live return
  }, 120_000);

  describe("A-6: an INLINE return sourced from the order counts too (the return rides on ANOTHER order)", () => {
    /**
     * A DELIVERED X, and a NEW order Y for the same customer carrying an inline return of 4 sourced from X. Capture
     * restocks at capture unless the return is held, so a restocked one leaves the counter at 94.
     */
    async function inlineFromX(tag: string, o: { held?: boolean; pinned?: boolean } = {}) {
      const s = await deliveredOrder(tag);
      const carrierProduct = await w.product(`${tag}-carry`, START);
      const { order: carrier } = await w.bookOrder({
        status: "CONFIRMED",
        lines: [{ productId: carrierProduct, qty: 1 }],
      });
      const retId = await seedInlineReturn(w.prisma, {
        tenantId: w.tenantId,
        customerId: w.customerId,
        carryingOrderId: carrier.id,
        sourceOrderId: s.orderId,
        productId: s.productId,
        held: o.held,
        pinnedLineId: o.pinned ? s.lineId : undefined,
      });
      if (!o.held) {
        await w.prisma.product.update({
          where: { id: s.productId },
          data: { currentStock: START - SOLD + 4 },
        });
      }
      return { ...s, carrierId: carrier.id, retId };
    }

    it("RO-31: an inline return of 4 pinned to source X (restocked, 94): reopening X = 409 ORDER_HAS_RETURN; X stays DELIVERED, stock 94", async () => {
      const s = await inlineFromX("ro31", { pinned: true });
      expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);

      await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);

      expect((await row(s.orderId)).status).toBe("DELIVERED");
      expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4); // the cancel can no longer read 104
    }, 120_000);

    it("RO-32: the same UNPINNED (no source line named; the matching set assigned X): reopening X = 409", async () => {
      const s = await inlineFromX("ro32");

      await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);
      expect((await row(s.orderId)).status).toBe("DELIVERED");
      expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
    }, 120_000);

    it("RO-35: a HELD inline return (no restock yet) blocks it too: it restocks on approval", async () => {
      const s = await inlineFromX("ro35", { held: true });
      expect(await w.stockOf(s.productId)).toBe(START - SOLD);

      await expect(reopen(s.orderId)).rejects.toMatchObject(refusedWith409);
      expect((await row(s.orderId)).status).toBe("DELIVERED");
    }, 120_000);

    it("the carrying link keeps counting (A-6 note 2): the order the inline return RIDES on cannot be reopened either", async () => {
      const s = await inlineFromX("ro31c");
      await w.prisma.order.update({ where: { id: s.carrierId }, data: { status: "DELIVERED" } });

      await expect(reopen(s.carrierId)).rejects.toMatchObject(refusedWith409);
      expect((await row(s.carrierId)).status).toBe("DELIVERED");
    }, 120_000);

    it("a CANCELLED inline return no longer blocks X (cancel the return first, the way forward the sentence names)", async () => {
      const s = await inlineFromX("ro31d");
      await w.prisma.return.update({ where: { id: s.retId }, data: { status: "CANCELLED" } });

      await reopen(s.orderId);
      expect((await row(s.orderId)).status).toBe("CONFIRMED");
    }, 120_000);
  });

  describe("SA-1101 A-6 Part 2 (B1279): the demotion waits for a return in flight for the customer", () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("RO-37: a capture holds the customer's returns lock and lands a live return on X; the demotion started meanwhile WAITS, then gets 409 (X stays DELIVERED)", async () => {
      const s = await deliveredOrder("ro37");
      const carrierProduct = await w.product("ro37-carry", START);
      const { order: carrier } = await w.bookOrder({
        status: "CONFIRMED",
        lines: [{ productId: carrierProduct, qty: 1 }],
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));

      // The capture side: the customer lock first (the key every return create/capture/approve takes), then the live
      // return it books against X (a held transaction, as a capture mid-flight is), committed only when released.
      const capture = w.inTenant(() =>
        w.prisma.tenantTransaction(async (tx: any) => {
          await new IdempotencyService().acquireLock(
            returnCustomerLockKey(w.customerId, w.tenantId),
            tx,
          );
          locked();
          await gate;
          await seedInlineReturn(tx, {
            tenantId: w.tenantId,
            customerId: w.customerId,
            carryingOrderId: carrier.id,
            sourceOrderId: s.orderId,
            productId: s.productId,
          });
        }),
      );
      let settled = false;
      let demote: Promise<unknown> | undefined;
      try {
        await lockTaken;
        demote = reopen(s.orderId).then(
          (v) => ((settled = true), v),
          (e) => {
            settled = true;
            throw e;
          },
        );
        demote.catch(() => undefined);
        await pause(1500);
        expect(settled).toBe(false); // red today: the demotion commits CONFIRMED while the capture is still open
        expect((await row(s.orderId)).status).toBe("DELIVERED");
      } finally {
        release();
        await capture;
      }
      await expect(demote).rejects.toMatchObject(refusedWith409);
      expect((await row(s.orderId)).status).toBe("DELIVERED");
    }, 120_000);
  });
});
