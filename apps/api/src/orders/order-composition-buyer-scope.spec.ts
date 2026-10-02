jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/**
 * #2717 M3 (buyer portal): GET /buyer/orders/:id is OrdersService.findOne under a CUSTOMER
 * pseudo-user. Pins (1) another buyer's order and its components are refused, (2) a buyer sees a
 * composed line's components as LineComponentView keys only. Fixtures are placeholders.
 */
const buyer = (sub: string) =>
  ({
    sub,
    username: "",
    role: "CUSTOMER",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: "t-1",
    tenantSlug: "acme",
    type: "BUYER",
  }) as never;

function serviceFor(order: object, customerRow: { id: string } | null) {
  const findUnique = jest.fn().mockResolvedValue(order);
  const findFirst = jest.fn().mockResolvedValue(customerRow);
  const service = Object.assign(Object.create(OrdersService.prototype), {
    prisma: { forTenant: () => ({ order: { findUnique }, customer: { findFirst } }) },
  }) as OrdersService;
  return { service, findFirst };
}

const ROW = {
  id: "c1",
  tenantId: "t-1",
  orderItemId: "li-1",
  createdAt: new Date(),
  componentProductId: "p1",
  name: "Almond",
  qty: 12,
  unitSku: "ALM-1",
  unitBarcode: "012345678905",
  barcodeSymbology: "UPC_A",
  displayUnitPrice4: { toString: () => "0.6300" },
  position: 0,
};
const orderOf = (customerId: string) => ({
  id: "o-1",
  status: "PENDING",
  customerId,
  routeRun: null,
  lineItems: [{ id: "li-1", components: [ROW] }],
});

describe("OrdersService.findOne, buyer scope over composed lines", () => {
  it("refuses buyer B on buyer A's order (no components returned)", async () => {
    const { service, findFirst } = serviceFor(orderOf("cust-A"), { id: "cust-B" });
    await expect(service.findOne("o-1", buyer("user-B"))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "user-B", deletedAt: null } });
  });

  it("the owning buyer gets components as LineComponentView keys only", async () => {
    const { service } = serviceFor(orderOf("cust-B"), { id: "cust-B" });
    const out = (await service.findOne("o-1", buyer("user-B"))) as unknown as {
      lineItems: Array<{ components: Array<Record<string, unknown>> }>;
    };
    const c = out.lineItems[0].components[0];
    expect(Object.keys(c).sort()).toEqual(
      [
        "id",
        "componentProductId",
        "name",
        "qty",
        "unitSku",
        "unitBarcode",
        "barcodeSymbology",
        "displayUnitPrice4",
        "position",
      ].sort(),
    );
    expect(c).not.toHaveProperty("tenantId");
    expect(c).not.toHaveProperty("orderItemId");
    expect(c).not.toHaveProperty("createdAt");
    expect(c.displayUnitPrice4).toBe(0.63);
  });
});
