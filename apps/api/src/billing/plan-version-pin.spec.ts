/**
 * SA-815a (G1c-1) - the plan-version pin: the one writer, the one resolver, and the entitlement switch.
 */
import { EntitlementsService } from "./entitlements.service";
import { inclusionCatalogFor, pinPlanVersionTx, resolvePlanVersionId } from "./plan-version-pin";

describe("pinPlanVersionTx", () => {
  it("writes BOTH pins in the caller's transaction", async () => {
    const tx: any = {
      tenant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    await pinPlanVersionTx(tx, "t1", "v11", { kind: "SYSTEM", id: null, source: "spec" });
    expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1" },
      data: { planVersionId: "v11" },
    });
    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { planVersionId: "v11" },
    });
  });

  it("a tenant with no subscription row still gets its tenant pin (updateMany, never a throw)", async () => {
    const tx: any = {
      tenant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    await expect(pinPlanVersionTx(tx, "t1", "v11")).resolves.toBeUndefined();
    expect(tx.tenant.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePlanVersionId / inclusionCatalogFor: sub pin, else tenant pin, else published", () => {
  it("the subscription's pin wins over the tenant's", () => {
    expect(resolvePlanVersionId({ planVersionId: "v11" }, { planVersionId: "v7" })).toBe("v11");
  });
  it("falls back to the tenant's pin, then to null (= published)", () => {
    expect(resolvePlanVersionId({ planVersionId: null }, { planVersionId: "v7" })).toBe("v7");
    expect(resolvePlanVersionId(null, { planVersionId: null })).toBeNull();
    expect(resolvePlanVersionId(undefined, undefined)).toBeNull();
  });

  const v = (id: string) => ({ id, definitions: [], addonSkus: [] }) as any;
  const catalog = () => ({
    getVersionForTenant: jest.fn(async (id: string | null) => v(id ?? "pub")),
  });

  it("reads the resolved version through the catalog", async () => {
    const c = catalog();
    expect(
      (await inclusionCatalogFor(c, { planVersionId: "v11" }, { planVersionId: "v7" })).id,
    ).toBe("v11");
    expect(c.getVersionForTenant).toHaveBeenLastCalledWith("v11");
    expect((await inclusionCatalogFor(c, null, { planVersionId: "v7" })).id).toBe("v7");
    expect((await inclusionCatalogFor(c, null, null)).id).toBe("pub");
    expect(c.getVersionForTenant).toHaveBeenLastCalledWith(null);
  });

  it("reuses the published version the caller already holds (no extra read) when it is the resolved one", async () => {
    const c = catalog();
    const pub = v("v11");
    expect(await inclusionCatalogFor(c, { planVersionId: "v11" }, null, pub)).toBe(pub);
    expect(await inclusionCatalogFor(c, null, null, pub)).toBe(pub);
    expect(c.getVersionForTenant).not.toHaveBeenCalled();
    // pinned elsewhere: the pinned version is read, never the held published one
    expect((await inclusionCatalogFor(c, { planVersionId: "v7" }, null, pub)).id).toBe("v7");
  });
});

/**
 * SA ack (c): the entitlement resolver reads the plan version through the SAME resolver. A no-op on live data
 * (both pins agree after the reconcile); it differs only when the tenant pin is missing and the subscription's is not.
 */
describe("EntitlementsService.resolve reads the plan version through the resolver", () => {
  const def = (planKey: string, seats: number) => ({
    planKey,
    name: planKey,
    seatsIncluded: seats,
    routesConcurrent: null,
    scansIncluded: null,
    msgsIncluded: null,
    customersIncluded: null,
    featureFlags: [],
  });
  // v11 is the pinned version (SCALE: 25 seats); the PUBLISHED one is v12 (SCALE: 99 seats)
  const versions: Record<string, any> = {
    v11: { id: "v11", status: "SUPERSEDED", definitions: [def("SCALE", 25)], addonSkus: [] },
    v12: { id: "v12", status: "PUBLISHED", definitions: [def("SCALE", 99)], addonSkus: [] },
  };
  function service(tenantPin: string | null, subPin: string | null) {
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: "t1",
          status: "ACTIVE",
          plan: "BUSINESS",
          planVersionId: tenantPin,
          trialEndsAt: null,
          subscription: { planKey: "SCALE", planVersionId: subPin },
          addons: [],
        }),
      },
    } as any;
    const catalog = {
      getVersionForTenant: jest.fn(async (id: string | null) => versions[id ?? "v12"]),
      getPublishedVersion: jest.fn(async () => versions.v12),
    } as any;
    const overrides = { get: jest.fn().mockResolvedValue(null) } as any;
    return { svc: new EntitlementsService(prisma, catalog, overrides), catalog };
  }

  it("(i) tenant pin = sub pin = v11: the resolved version is v11, as before the switch", async () => {
    const { svc, catalog } = service("v11", "v11");
    const e = await svc.resolve("t1");
    expect(e.planVersionId).toBe("v11");
    expect(e.caps.seats).toBe(25);
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("v11");
  });

  it("(ii) tenant pin null: resolves to the SUBSCRIPTION's pin (v11), not the published version", async () => {
    const { svc, catalog } = service(null, "v11");
    const e = await svc.resolve("t1");
    expect(e.planVersionId).toBe("v11");
    expect(e.caps.seats).toBe(25);
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("v11");
  });

  it("the subscription's pin wins when the two pins disagree", async () => {
    const { svc } = service("v12", "v11");
    expect((await svc.resolve("t1")).planVersionId).toBe("v11");
  });
});
