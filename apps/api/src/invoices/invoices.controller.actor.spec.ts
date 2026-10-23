import { InvoicesController } from "./invoices.controller";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * H3b — the acting user rides POST /invoices and PATCH /invoices/:id into the service, where a typed price
 * is judged against the customer's tier price and a real override is stamped `overriddenBy`. Without it
 * (an internal caller) the service judges nothing, so the controller must always pass `user.sub`.
 */
describe("InvoicesController — the acting user reaches create/update (H3b)", () => {
  const service = { create: jest.fn(), update: jest.fn() };
  const controller = new InvoicesController(service as never, {} as never);
  const user = { sub: "user-1" } as JwtPayload;

  beforeEach(() => jest.clearAllMocks());

  it("create passes the body and user.sub", async () => {
    const dto = { customerId: "c1", items: [] } as never;
    await controller.create(dto, user);
    expect(service.create).toHaveBeenCalledWith(dto, "user-1");
  });

  it("update passes the id, the body and user.sub", async () => {
    const dto = { items: [] } as never;
    await controller.update("inv-1", dto, user);
    expect(service.update).toHaveBeenCalledWith("inv-1", dto, "user-1", {
      userAgent: undefined,
      appVersion: undefined,
      xClient: undefined,
    });
  });
});
