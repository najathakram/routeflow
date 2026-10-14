// SA-434: these driver cases pin OTHER behaviour; ownership is pinned in driver-edit-access*.spec.ts.
jest.mock("./driver-edit-access", () => ({
  ...jest.requireActual("./driver-edit-access"),
  assertDriverMayEditOrder: jest.fn(),
}));
import { ConflictException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * Lane R 2a-8 — `approveChangeRequestAtStop` asks the selling-restrictions choke point for the ONE
 * money path at the door. The choke point is proven in `selling-restrictions.service.spec.ts` and the
 * line derivation in `order-edit-lines*.spec.ts`; this pins the CALL: tenant, channel, lines, the
 * ORDER (before the invoice revert and the transaction), the OFF path's inertness and the re-check
 * under the row lock.
 */
describe("OrdersService.approveChangeRequestAtStop — selling restrictions (lane R 2a-8)", () => {
  const LINE = {
    id: "li-a",
    orderId: "ord-1",
    productId: "prod-a",
    qty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 20,
    status: "PENDING",
    deliveredQty: 0,
  };
  const ORDER = {
    id: "ord-1",
    tenantId: "t-row",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    status: "OUT_FOR_DELIVERY",
    subtotal: 20,
    tax: 0,
    total: 20,
    shippingFee: 0,
    routeRunId: "run-1",
    routeRunStopId: "stop-1",
    lineItems: [LINE],
    routeRun: { id: "run-1", status: "IN_PROGRESS", driverId: "drv-1" },
    routeRunStop: { id: "stop-1", status: "PENDING" },
  };
  const cr = (o: object) => ({
    id: "cr-1",
    orderId: "ord-1",
    orderItemId: null,
    productId: null,
    type: "CHANGE_QTY",
    status: "PENDING",
    payload: {},
    ...o,
  });
  const ADD_X = cr({
    type: "ADD_ITEM",
    productId: "prod-x",
    payload: { productId: "prod-x", qty: 1 },
  });
  const RAISE_A = cr({ orderItemId: "li-a", payload: { orderItemId: "li-a", newQty: 5 } });
  const LOWER_A = cr({ orderItemId: "li-a", payload: { orderItemId: "li-a", newQty: 1 } });
  const resolver = { ...operatorPayload, tenantId: "t-caller" } as never;
  const driver = { ...operatorPayload, role: "DRIVER", tenantId: "t-caller" } as never;

  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let revert: jest.Mock;
  const approve = (row: object, who: never = resolver) => {
    h.prisma.changeRequest.findUnique.mockResolvedValue(row);
    return h.service.approveChangeRequestAtStop("cr-1", who, null);
  };
  const on = () => undefined; // row 510: nothing to switch on
  const firstCall = (m: jest.Mock) => m.mock.invocationCallOrder[0];

  beforeEach(async () => {
    h = await buildOrdersService();
    revert = h.module.get(InvoicesService).revertLinkedInvoicesForOrderEdit as jest.Mock;
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER });
    h.prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({ creditLimit: null, pricingTier: 1 });
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    h.prisma.orderItem.findUnique.mockResolvedValue(LINE);
    h.prisma.orderItem.findMany.mockResolvedValue([LINE]);
    h.prisma.product.findUnique.mockResolvedValue({
      id: "prod-x",
      unitsPerBox: null,
      pricePerUnit: 5,
    });
    h.prisma.product.findFirst.mockResolvedValue({ id: "prod-x", trackedCategoryId: null });
  });

  it("row 510: the switch is gone — the edit reads no tenant policy itself and the choke point always runs", async () => {
    await approve(ADD_X);

    expect(h.restrictions.getPolicy).not.toHaveBeenCalled();
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
  });

  it("ON: an ADD_ITEM asks the choke point once — row tenant, customer, the product, STAFF — before the invoice revert and the transaction", async () => {
    on();
    await approve(ADD_X);

    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-row",
        customerId: "cust-1",
        lines: [{ productId: "prod-x", lineKey: "cr:cr-1" }], // row 510: keyed by the change request
        channel: "STAFF",
        document: "ORDER",
      }),
    );
    const asked = firstCall(h.restrictions.assertLinesSellable);
    expect(asked).toBeLessThan(firstCall(revert));
    expect(asked).toBeLessThan(firstCall(h.prisma.tenantTransaction));
  });

  it("ON: a CHANGE_QTY raise sends the positive delta; a lowering sends a non-positive one (the choke point lets it through)", async () => {
    on();
    await approve(RAISE_A);
    expect(h.restrictions.assertLinesSellable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lines: [{ productId: "prod-a", qtyDelta: 3, lineKey: "cr:cr-1" }],
      }),
    );
    await approve(LOWER_A);
    expect(h.restrictions.assertLinesSellable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lines: [{ productId: "prod-a", qtyDelta: -1, lineKey: "cr:cr-1" }],
      }),
    );
  });

  it("a DRIVER resolver (the door-edit endpoint is OPERATOR|DRIVER) is judged on the STAFF channel", async () => {
    on();
    await approve(ADD_X, driver);
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF" }),
    );
  });

  it("a refusal (409 SELLING_RESTRICTED) leaves nothing mutated: no claim, no invoice revert, no transaction", async () => {
    on();
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
    );
    await expect(approve(ADD_X)).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(h.prisma.changeRequest.updateMany).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("a REMOVE_ITEM adds nothing: the choke point is asked with no lines", async () => {
    on();
    await approve(
      cr({ type: "REMOVE_ITEM", orderItemId: "li-a", payload: { orderItemId: "li-a" } }),
    );
    expect(h.restrictions.assertLinesSellable).toHaveBeenLastCalledWith(
      expect.objectContaining({ lines: [] }),
    );
  });

  it("a NOTE carries no money: it claims and returns without ever reaching the choke point", async () => {
    on();
    await expect(approve(cr({ type: "NOTE" }))).resolves.toMatchObject({ merged: true });
    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });

  it("re-check under the lock: a line that became a raise after the pre-lock read refuses with a retryable 409 and claims nothing that commits", async () => {
    on();
    // pre-lock: the line is at 6 (newQty 5 is a lowering, nothing to judge) — lock-time: it is at 2 (a raise)
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER, lineItems: [{ ...LINE, qty: 6 }] });
    h.prisma.orderItem.findMany.mockResolvedValue([LINE]);
    await expect(approve(RAISE_A)).rejects.toMatchObject({
      response: { code: "ORDER_CHANGED_DURING_EDIT" },
    });
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
  });
});
