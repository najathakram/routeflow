import { OrderTemplatesController } from "./order-templates.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { expectNoStaffLeaks, leakyOrder } from "../common/testing/customer-leak-fixtures";

/**
 * POST /order-templates/:id/generate returns the order the template generated. A CUSTOMER caller
 * gets the customer-facing ALLOWLIST of it (no idempotency key, merge flag, run / template link,
 * commission rate or line override — nor any column added later); an operator gets the service's
 * object itself, untouched. Placeholders only.
 */
const principal = (role: JwtPayload["role"]): JwtPayload => ({
  sub: `user-${role.toLowerCase()}`,
  username: "u",
  role,
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
});

function build(order: unknown) {
  const service = { generateOrderForUser: jest.fn().mockResolvedValue(order) };
  const controller = new OrderTemplatesController(service as never);
  return { controller, service };
}

describe("OrderTemplatesController.generateOrder — customer-facing fields only", () => {
  it("CUSTOMER: only allowlisted fields, no staff-internal key at any depth", async () => {
    const { controller, service } = build(leakyOrder());
    const out = await controller.generateOrder("tpl-1", principal("CUSTOMER"));
    expect(service.generateOrderForUser).toHaveBeenCalledWith("tpl-1", principal("CUSTOMER"));
    expectNoStaffLeaks(out);
    expect(out).toMatchObject({ id: "ord-1", status: "PENDING" });
    expect((out as { lineItems: object[] }).lineItems[0]).toMatchObject({ id: "li-1", qty: 2 });
  });

  it("CUSTOMER: a template that generates nothing answers null", async () => {
    const { controller } = build(null);
    expect(await controller.generateOrder("tpl-1", principal("CUSTOMER"))).toBeNull();
  });

  it("OPERATOR: the service's object, untouched", async () => {
    const row = leakyOrder();
    const { controller } = build(row);
    const out = await controller.generateOrder("tpl-1", principal("OPERATOR"));
    expect(out).toBe(row);
    expect(out).toHaveProperty("idempotencyKey");
  });
});
