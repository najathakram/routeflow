// SA-429 (#2377): these driver cases pin OTHER behaviour (pricing, merges, restrictions, returns),
// not ownership, and their mocks carry no assigned run; the ownership predicate itself is pinned by
// driver-edit-access.spec.ts and driver-edit-access.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
import {
  buildOrdersService,
  buyerPseudoUser,
  operatorPayload,
} from "./testing/orders-service-harness";
import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import {
  sellableLinesForMergeEdit,
  sellableLinesForReplaceEdit,
} from "../selling-restrictions/order-edit-lines";

/**
 * Lane R 2a-7 — `updateOrderItems` asks the selling-restrictions choke point, in the ONE place every
 * live-order edit (buyer, operator, driver; merge and replace-all) goes through. The choke point is
 * proven in `selling-restrictions.service.spec.ts` and the line derivation in `order-edit-lines*.spec.ts`;
 * this pins the CALL: the tenant, the channel, the lines per branch, the ORDER (before the invoice
 * revert and the transaction), the OFF path's inertness, and the re-check under the row lock.
 */
describe("OrdersService.updateOrderItems — selling restrictions (lane R 2a-7)", () => {
  const EXISTING = [
    {
      id: "li-a",
      orderId: "ord-1",
      productId: "prod-a",
      qty: 2,
      unitPrice: 10,
      subtotal: 20,
      status: "PENDING",
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      priceType: "STANDARD",
      originalPrice: null,
    },
  ];
  const ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-row",
    orderNumber: "ORD-1",
    status: "PENDING",
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: EXISTING,
  };
  const operator = { ...operatorPayload, tenantId: "t-caller" } as never;
  const driver = { ...operatorPayload, role: "DRIVER", tenantId: "t-caller" } as never;
  const buyer = { ...buyerPseudoUser, tenantId: "t-caller" } as never;
  const ADD_X = { items: [{ productId: "prod-x", qty: 1 }] };
  const ECHO_A = { items: [{ id: "li-a", qty: 2 }] };

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let revert: jest.Mock;
  const edit = (dto: object, user: never = operator, order: object = ORDER) => {
    h.prisma.order.findUnique.mockResolvedValue({ ...order });
    return h.service.updateOrderItems("ord-1", dto as never, user);
  };
  const on = () => undefined; // row 510: nothing to switch on
  const firstCall = (m: jest.Mock) => m.mock.invocationCallOrder[0];

  beforeEach(async () => {
    h = await buildOrdersService();
    revert = h.module.get(InvoicesService).revertLinkedInvoicesForOrderEdit as jest.Mock;
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.product.findMany.mockResolvedValue([
      { id: "prod-a", pricePerUnit: 10, unitsPerBox: null, category: null },
      { id: "prod-x", pricePerUnit: 5, unitsPerBox: null, category: null },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue(EXISTING);
  });

  describe("row 510: the tenant switch is gone, so a staff edit is always judged", () => {
    it("never reads the tenant policy itself (the engine reads what it needs); the plan query and the choke point run with NO switch on", async () => {
      await edit(ADD_X);

      expect(h.restrictions.getPolicy).not.toHaveBeenCalled();
      expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
      const planReads = h.prisma.product.findMany.mock.calls.filter(
        ([a]) => JSON.stringify(a.select) === JSON.stringify({ id: true, unitsPerBox: true }),
      );
      expect(planReads).toHaveLength(1);
    });

    it("a DRAFT edit reads nothing at all: a draft is judged at its promotion", async () => {
      await edit(ADD_X, operator, { ...ORDER, status: "DRAFT" });
      expect(h.restrictions.getPolicy).not.toHaveBeenCalled();
      expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    });
  });

  describe("ON", () => {
    beforeEach(on);

    it.each([
      [{ fulfillPath: "PICKUP" }, "PICKUP"],
      [{ counterSale: true, fulfillPath: "PICKUP" }, "COUNTER"],
      [{ fulfillPath: "ROUTE" }, "DELIVERY"],
    ])("L8: an edit of an order with %j is judged as %s", async (facts, kind) => {
      await edit(ADD_X, operator, { ...ORDER, ...facts });
      expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({ fulfilmentKind: kind }),
      );
    });

    it("asks the choke point ONCE with the ROW's tenant (not the caller's), the customer, the added product and the STAFF channel — before the invoice revert and the transaction", async () => {
      await edit(ADD_X);

      expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
      expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "t-row",
          customerId: "cust-1",
          lines: [{ productId: "prod-x", lineKey: "n:0" }], // row 510: keyed by its payload index
          channel: "STAFF",
          fulfilmentKind: "DELIVERY",
          document: "ORDER",
        }),
      );
      const asked = firstCall(h.restrictions.assertLinesSellable);
      expect(asked).toBeLessThan(firstCall(revert));
      expect(asked).toBeLessThan(firstCall(h.prisma.tenantTransaction));
    });

    it("a refusal (409 SELLING_RESTRICTED) leaves nothing mutated: no invoice revert, no transaction, no line write", async () => {
      h.restrictions.assertLinesSellable.mockRejectedValue(
        new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
      );

      await expect(edit(ADD_X)).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
      expect(revert).not.toHaveBeenCalled();
      expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    });

    // Each principal takes a different branch of the service; the call must derive its lines with the
    // SAME branch, or a ban is judged on a quantity the edit does not write.
    it.each([
      ["an operator's merge edit", operator, ECHO_A, "STAFF", "merge"],
      [
        "an operator's replace-all",
        operator,
        { replaceAll: true, items: [{ productId: "prod-a", qty: 3 }] },
        "STAFF",
        "staff",
      ],
      [
        "a buyer's replace",
        buyer,
        {
          items: [
            { productId: "prod-a", qty: 3 },
            { productId: "prod-x", qty: 1 },
          ],
        },
        "BUYER_PORTAL",
        "buyer",
      ],
      [
        "a driver's replace",
        driver,
        { items: [{ productId: "prod-a", qty: 3 }] },
        "STAFF",
        "driver",
      ],
      [
        "a driver's diff edit (a merge)",
        driver,
        { replaceAll: false, items: [{ id: "li-a", qty: 3 }] },
        "STAFF",
        "merge",
      ],
    ] as const)(
      "%s: the lines and channel are that branch's",
      async (_who, user, dto, channel, mode) => {
        await edit(dto, user as never);

        const live = new Map([
          ["prod-a", null],
          ["prod-x", null],
        ]);
        const expected =
          mode === "merge"
            ? sellableLinesForMergeEdit(EXISTING, dto.items, { liveUnitsPerBox: live })
            : sellableLinesForReplaceEdit(EXISTING, dto.items, {
                actor: mode,
                liveUnitsPerBox: live,
              });
        const call = h.restrictions.assertLinesSellable.mock.calls[0][0];
        expect(call.channel).toBe(channel);
        // row 510: the same lines, each now carrying the key a warning echoes back
        expect(call.lines).toEqual(expected.map((l) => ({ ...l, lineKey: expect.any(String) })));
      },
    );

    // 2 cases (box-unaware) of a 24-per-case product, then qty 3 + pieces 5: the actors write different
    // goods, so a wrong actor changes the delta (hand-derived, not computed by the function under test).
    it.each([
      ["staff replace-all: the split wins (5 pieces)", operator, { replaceAll: true }, -43],
      ["buyer: qty wins, as pieces on a split hint", buyer, {}, -45],
      ["driver: qty is cases (72 pieces)", driver, {}, 24],
    ] as const)("a boxed line is sized per actor — %s", async (_who, user, extra, delta) => {
      h.prisma.product.findMany.mockResolvedValue([
        { id: "prod-a", pricePerUnit: 10, unitsPerBox: 24, category: null },
      ]);
      await edit({ ...extra, items: [{ productId: "prod-a", qty: 3, pieces: 5 }] }, user as never);

      expect(h.restrictions.assertLinesSellable.mock.calls[0][0].lines).toEqual([
        { productId: "prod-a", qtyDelta: delta, lineKey: "n:0" },
      ]);
    });

    it("re-checked under the row lock: an edit that was a no-op when judged but now RAISES a product (a concurrent decrease) is refused, retryable, with no line written", async () => {
      // pre-lock: qty 2 echoed = delta 0 (never checked). lock-time: another writer dropped it to 1.
      h.prisma.orderItem.findMany.mockResolvedValue([{ ...EXISTING[0], qty: 1 }]);

      await expect(edit(ECHO_A)).rejects.toMatchObject({
        response: { code: "ORDER_CHANGED_DURING_EDIT" },
      });
      expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("control: a lock-time read that matches the judged rows completes the same edit", async () => {
      await expect(edit(ECHO_A)).resolves.toBeDefined();
    });
  });
});
