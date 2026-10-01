import { PolicyOversellReader } from "./policy-oversell-reader";
import { resolveOversellAllowed } from "./oversell-policy";
import type { PolicyService, PolicyScope } from "../policy/policy.service";

const T = "t-1";

function reader(resolve: jest.Mock) {
  return new PolicyOversellReader({ resolve } as unknown as PolicyService);
}

describe("PolicyOversellReader", () => {
  it("reads the tenant layer when no customer is given", async () => {
    const resolve = jest.fn().mockResolvedValue("backorder");
    await reader(resolve).read({ tenantId: T });
    expect(resolve).toHaveBeenCalledWith(T, "orders.buyerOversell", {});
    await reader(resolve).read({ tenantId: T, customerId: null });
    expect(resolve).toHaveBeenLastCalledWith(T, "orders.buyerOversell", {});
  });

  it("passes the customer as the CUSTOMER scope", async () => {
    const resolve = jest.fn().mockResolvedValue("off");
    await reader(resolve).read({ tenantId: T, customerId: "c-1" });
    expect(resolve).toHaveBeenCalledWith(T, "orders.buyerOversell", { customerId: "c-1" });
  });

  it("returns the raw resolved value", async () => {
    expect(await reader(jest.fn().mockResolvedValue("backorder")).read({ tenantId: T })).toBe(
      "backorder",
    );
    expect(await reader(jest.fn().mockResolvedValue("off")).read({ tenantId: T })).toBe("off");
  });

  it("a read error swallowed by resolve() (registry default 'off') keeps a CUSTOMER blocked", async () => {
    const r = reader(jest.fn().mockResolvedValue("off"));
    await expect(
      resolveOversellAllowed(r, {
        tenantId: T,
        role: "CUSTOMER",
        source: "buyer",
        customerId: "c",
      }),
    ).resolves.toBe(false);
  });

  it("a resolve that THROWS still fails closed and never rejects", async () => {
    const r = reader(jest.fn().mockRejectedValue(new Error("db down")));
    await expect(
      resolveOversellAllowed(r, {
        tenantId: T,
        role: "CUSTOMER",
        source: "buyer",
        customerId: "c",
      }),
    ).resolves.toBe(false);
  });

  describe("CUSTOMER-scope precedence through a layered fake PolicyService", () => {
    function layered(tenant: string, customerRows: Record<string, string>) {
      return jest.fn(async (_t: string, _k: string, scope: PolicyScope = {}) =>
        scope.customerId && customerRows[scope.customerId] !== undefined
          ? customerRows[scope.customerId]
          : tenant,
      );
    }
    const allowed = (r: PolicyOversellReader, customerId: string) =>
      resolveOversellAllowed(r, { tenantId: T, role: "CUSTOMER", source: "buyer", customerId });

    it("tenant off + customer backorder: that customer oversells, another does not", async () => {
      const r = reader(layered("off", { "c-1": "backorder" }));
      expect(await allowed(r, "c-1")).toBe(true);
      expect(await allowed(r, "c-2")).toBe(false);
    });

    it("tenant backorder + customer off: that customer is blocked, another oversells", async () => {
      const r = reader(layered("backorder", { "c-1": "off" }));
      expect(await allowed(r, "c-1")).toBe(false);
      expect(await allowed(r, "c-2")).toBe(true);
    });
  });
});
