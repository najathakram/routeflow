import { defaultSaleFulfilmentKind } from "./default-sale-fulfilment";

jest.mock("./fulfil-path-resolver", () => ({
  resolveFulfilPath: jest.fn(async () => "PICKUP"),
}));
jest.mock("../selling-restrictions/tenant-fulfilment-model", () => ({
  storedFulfilmentMode: jest.fn(async () => "pickup"),
}));

describe("defaultSaleFulfilmentKind (L8, SA-782 MUST 1)", () => {
  it("reads the customer scoped to the passed tenant (off-request callers have no tenant context)", async () => {
    const findFirst = jest.fn(async () => ({ fulfillPath: "PICKUP" }));
    const prisma = {
      tenantFeatureConfig: {},
      forTenant: () => ({ customer: { findFirst } }),
    } as unknown as Parameters<typeof defaultSaleFulfilmentKind>[0];

    await defaultSaleFulfilmentKind(prisma, "tenant-a", "cust-1");

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cust-1", tenantId: "tenant-a" } }),
    );
  });

  it("does not read a customer when there is none", async () => {
    const findFirst = jest.fn();
    const prisma = {
      tenantFeatureConfig: {},
      forTenant: () => ({ customer: { findFirst } }),
    } as unknown as Parameters<typeof defaultSaleFulfilmentKind>[0];

    await defaultSaleFulfilmentKind(prisma, "tenant-a", null);

    expect(findFirst).not.toHaveBeenCalled();
  });
});
