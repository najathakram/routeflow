/**
 * SA-1101 A-3 (N1) on REAL Postgres: what a return and a cancel do to stock around "Deliver again".
 * RO-15 (a received return blocks it; stock = start - 10 + 4), RO-18 (refuse -> Deliver again -> cancel: the stock
 * comes back exactly once). RO-16 (cancel the return, Deliver again, full close; stock = start - 10) lives in
 * routes/stop-outcome-refused.db.spec.ts next to RO-8, whose close steps it reuses.
 *
 * The REAL updateStatusWithShipMarker (the function OrdersService.changeStatus ends in), the REAL ReturnsService and the
 * REAL OrdersService run over the order-stock world's books: an order that sold 10 leaves the counter at start - 10.
 * Test tenant only (qa-sa1101d-*, assertTestTenant in the world). Run: `npm run local:test:db`.
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
import { updateStatusWithShipMarker } from "./order-ship-state";
import { seedInlineReturn } from "../returns/testing/inline-return-seed";

const START = 100;
const SOLD = 10;

describeDb("SA-1101 A-3: Deliver again, returns and cancel — real Postgres", () => {
  let w: OrderStockWorld;
  let returns: ReturnsService;
  let cnSeq = 0;

  beforeAll(async () => {
    w = await buildOrderStockWorld("sa1101d", "deliver-again.db.spec.ts");
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
            reserveNext: jest.fn().mockImplementation(async () => `CN-SA1101D-${++cnSeq}`),
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
      await w.prisma.returnItem.deleteMany(where).catch(swallow);
      await w.prisma.return.deleteMany(where).catch(swallow);
      await w.prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await w.prisma.creditNote.deleteMany(where).catch(swallow);
    }
    await w?.cleanup();
  }, 120_000);

  /** A REFUSED order that sold 10 of a product opened at 100: the counter is at 90. */
  async function refusedOrder(tag: string) {
    const productId = await w.product(tag, START);
    const { order, items } = await w.bookOrder({
      status: "REFUSED",
      lines: [{ productId, qty: SOLD }],
    });
    return { productId, orderId: order.id, lineId: items[0].id };
  }

  /** The same call OrdersService.changeStatus makes for REFUSED -> CONFIRMED. */
  async function deliverAgain(orderId: string) {
    return w.inTenant(async () => {
      const order = await w.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      return updateStatusWithShipMarker(
        { prisma: w.prisma },
        order as never,
        { status: "CONFIRMED" as never },
        w.jwt as never,
        buildStatusUpdateData(order, "CONFIRMED" as never, { isDeliveredDemotion: false }),
      );
    });
  }

  const staffReturn = (s: { productId: string; orderId: string; lineId: string }, qty: number) =>
    w.inTenant(() =>
      returns.create(
        {
          orderId: s.orderId,
          reason: "CUSTOMER_REFUSED",
          items: [{ productId: s.productId, orderItemId: s.lineId, qty }],
        } as any,
        w.jwt.sub,
        "OPERATOR",
      ),
    );
  const receivedReturn = async (
    s: { productId: string; orderId: string; lineId: string },
    qty: number,
  ) => {
    const ret: any = await staffReturn(s, qty);
    await w.inTenant(() => returns.approve(ret.id));
    await w.inTenant(() => returns.receive(ret.id, w.jwt.sub, { restock: true }));
    return ret.id as string;
  };
  const statusOf = async (orderId: string) =>
    (await w.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  it("RO-15: a received return (+4) blocks Deliver again with 409 ORDER_HAS_RETURN; stock = start - 10 + 4", async () => {
    const s = await refusedOrder("ro15");
    expect(await w.stockOf(s.productId)).toBe(START - SOLD);
    await receivedReturn(s, 4);
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);

    await expect(deliverAgain(s.orderId)).rejects.toMatchObject({
      response: {
        code: "ORDER_HAS_RETURN",
        message:
          "This order has a return. To deliver it again, cancel the return first, or create a new order.",
      },
    });
    expect(await statusOf(s.orderId)).toBe("REFUSED");
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
  }, 120_000);

  it("a REJECTED or CANCELLED return does not block Deliver again", async () => {
    const s = await refusedOrder("dead");
    const ret: any = await staffReturn(s, 2);
    await w.inTenant(() => returns.cancel(ret.id, w.jwt as never));
    await deliverAgain(s.orderId);
    expect(await statusOf(s.orderId)).toBe("CONFIRMED");
  }, 120_000);

  it("RO-17 (real rows): a PENDING return blocks it too", async () => {
    const s = await refusedOrder("ro17");
    await staffReturn(s, 3); // PENDING: not approved, not received
    await expect(deliverAgain(s.orderId)).rejects.toMatchObject({
      response: { code: "ORDER_HAS_RETURN" },
    });
    expect(await statusOf(s.orderId)).toBe("REFUSED");
  }, 120_000);

  it("RO-33 (SA-1101 A-6): a refused X with an INLINE return sourced from X (carried by another order) blocks Deliver again", async () => {
    const s = await refusedOrder("ro33");
    const carrierProduct = await w.product("ro33-carry", START);
    const { order: carrier } = await w.bookOrder({
      status: "CONFIRMED",
      lines: [{ productId: carrierProduct, qty: 1 }],
    });
    await seedInlineReturn(w.prisma, {
      tenantId: w.tenantId,
      customerId: w.customerId,
      carryingOrderId: carrier.id,
      sourceOrderId: s.orderId,
      productId: s.productId,
    });
    await w.prisma.product.update({
      where: { id: s.productId },
      data: { currentStock: START - SOLD + 4 },
    });

    await expect(deliverAgain(s.orderId)).rejects.toMatchObject({
      response: { code: "ORDER_HAS_RETURN" },
    });
    expect(await statusOf(s.orderId)).toBe("REFUSED");
    expect(await w.stockOf(s.productId)).toBe(START - SOLD + 4);
  }, 120_000);

  it("RO-18: refuse -> Deliver again -> cancel credits the stock back exactly once", async () => {
    const s = await refusedOrder("ro18");
    await deliverAgain(s.orderId);
    expect(await statusOf(s.orderId)).toBe("CONFIRMED");
    expect(await w.stockOf(s.productId)).toBe(START - SOLD);

    await w.inTenant(() =>
      w.orders.changeStatus(s.orderId, { status: "CANCELLED" } as never, w.jwt as never),
    );
    expect(await statusOf(s.orderId)).toBe("CANCELLED");
    expect(await w.stockOf(s.productId)).toBe(START); // start, not start + 10
  }, 120_000);
});
