import { priceEditAllowedFor } from "../auth/permissions/price-edit";
import { loadOverride } from "./invoice-line-override";

jest.mock("../auth/permissions/price-edit", () => ({ priceEditAllowedFor: jest.fn() }));

/**
 * SA-1034 rule 6: `loadOverride` takes the invoice source from `create()` / the edit, never from its own default.
 * A "request" asks the one capability helper; a "template-run" re-sends an authored price and carries the
 * capability with no read (so a "Run now" by an operator without price rights still bills).
 */
describe("loadOverride source (SA-1034 rule 6)", () => {
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 1 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = { forTenant: () => db, getTenantId: () => "t1" } as never;
  const dto = { customerId: "c1", items: [{ productId: "p1" }] };
  const operator = { sub: "u1", role: "OPERATOR", tenantId: "t1" };
  const load = (source: "request" | "template-run") =>
    loadOverride(prisma, dto, new Map() as never, operator, source);
  const allowedFor = priceEditAllowedFor as jest.Mock;

  beforeEach(() => allowedFor.mockReset());

  it("a request carries the helper's answer, read for this actor and site", async () => {
    allowedFor.mockResolvedValue(false);
    expect((await load("request"))?.priceEditAllowed).toBe(false);
    expect(allowedFor).toHaveBeenCalledTimes(1);
    expect(allowedFor.mock.calls[0][2]).toBe("InvoicesService.loadOverride");
    allowedFor.mockResolvedValue(true);
    expect((await load("request"))?.priceEditAllowed).toBe(true);
  });

  it("a template run carries the capability with no read, even for an operator whose rights are off", async () => {
    allowedFor.mockResolvedValue(false);
    expect((await load("template-run"))?.priceEditAllowed).toBe(true);
    expect(allowedFor).not.toHaveBeenCalled();
  });

  it("no actor is no context in either source (internal callers are not judged)", async () => {
    expect(
      await loadOverride(prisma, dto, new Map() as never, undefined, "template-run"),
    ).toBeUndefined();
    expect(
      await loadOverride(prisma, dto, new Map() as never, undefined, "request"),
    ).toBeUndefined();
  });
});
