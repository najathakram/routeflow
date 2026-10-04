import { defaultFulfillPath, isShipModeTenant, resolveFulfillPath } from "./fulfill-path-default";

describe("defaultFulfillPath", () => {
  it("a client-sent value always wins, ship mode or not, over the customer default too", () => {
    expect(defaultFulfillPath({ dtoValue: "ROUTE", customerDefault: "SHIP", shipMode: true })).toBe(
      "ROUTE",
    );
    expect(
      defaultFulfillPath({ dtoValue: "SHIP", customerDefault: "ROUTE", shipMode: false }),
    ).toBe("SHIP");
  });

  it("the customer's own default beats ship mode (ship mode only replaces the last-resort ROUTE)", () => {
    expect(defaultFulfillPath({ customerDefault: "ROUTE", shipMode: true })).toBe("ROUTE");
    expect(defaultFulfillPath({ customerDefault: "SHIP", shipMode: true })).toBe("SHIP");
  });

  it("ship mode with no client value and no customer default is SHIP", () => {
    expect(defaultFulfillPath({ shipMode: true })).toBe("SHIP");
    expect(defaultFulfillPath({ customerDefault: null, shipMode: true })).toBe("SHIP");
  });

  it("outside ship mode today's chain holds: customer default, then ROUTE", () => {
    expect(defaultFulfillPath({ customerDefault: "SHIP", shipMode: false })).toBe("SHIP");
    expect(defaultFulfillPath({ customerDefault: "ROUTE", shipMode: false })).toBe("ROUTE");
    expect(defaultFulfillPath({ customerDefault: null, shipMode: false })).toBe("ROUTE");
    expect(defaultFulfillPath({ shipMode: false })).toBe("ROUTE");
  });
});

describe("isShipModeTenant", () => {
  const reader = (impl: jest.Mock) => ({ getEffectiveMode: impl });

  it("reads the tenant's effective fulfilment_model once", async () => {
    const get = jest.fn().mockResolvedValue("ship");
    await isShipModeTenant(reader(get), "t-1");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("t-1", "fulfilment_model");
  });

  it("only the exact mode ship is ship mode", async () => {
    await expect(
      isShipModeTenant(reader(jest.fn().mockResolvedValue("ship")), "t-1"),
    ).resolves.toBe(true);
    for (const mode of ["unset", "delivery", "both", "pickup", "", "SHIP"]) {
      await expect(
        isShipModeTenant(reader(jest.fn().mockResolvedValue(mode)), "t-1"),
      ).resolves.toBe(false);
    }
  });

  it("fails open on a read error, with a warning and no throw", async () => {
    const warn = jest.fn();
    const get = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(isShipModeTenant(reader(get), "t-1", { warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no reader or no tenant (SUPER_ADMIN) is not ship mode and reads nothing", async () => {
    const get = jest.fn();
    await expect(isShipModeTenant(undefined, "t-1")).resolves.toBe(false);
    await expect(isShipModeTenant(reader(get), null)).resolves.toBe(false);
    await expect(isShipModeTenant(reader(get), undefined)).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("resolveFulfillPath", () => {
  const self = (mode: string | Error | undefined, tenant: string | null = "t-1") => ({
    prisma: { getTenantId: () => tenant },
    featureConfig:
      mode === undefined
        ? undefined
        : {
            getEffectiveMode: jest.fn(async () => {
              if (mode instanceof Error) throw mode;
              return mode;
            }),
          },
  });

  it("ship mode: SHIP only when the client and the customer both hold nothing", async () => {
    const s = self("ship");
    await expect(resolveFulfillPath(s, {}, null, {})).resolves.toBe("SHIP");
    await expect(resolveFulfillPath(s, {}, { fulfillPath: null }, {})).resolves.toBe("SHIP");
    expect(s.featureConfig!.getEffectiveMode).toHaveBeenCalledTimes(2);
  });

  it("ship mode: the customer's ROUTE and the client's value both win, with no mode read", async () => {
    const s = self("ship");
    await expect(resolveFulfillPath(s, {}, { fulfillPath: "ROUTE" }, {})).resolves.toBe("ROUTE");
    await expect(resolveFulfillPath(s, { fulfillPath: "ROUTE" }, null, {})).resolves.toBe("ROUTE");
    await expect(
      resolveFulfillPath(s, { fulfillPath: "SHIP" }, { fulfillPath: "ROUTE" }, {}),
    ).resolves.toBe("SHIP");
    expect(s.featureConfig!.getEffectiveMode).not.toHaveBeenCalled();
  });

  it("any other mode, a throw, no provider or no tenant: today's chain (customer default, else ROUTE)", async () => {
    for (const s of [
      self("unset"),
      self("both"),
      self(new Error("db down")),
      self(undefined),
      self("ship", null),
    ]) {
      await expect(resolveFulfillPath(s, {}, { fulfillPath: "SHIP" }, {})).resolves.toBe("SHIP");
      await expect(resolveFulfillPath(s, {}, { fulfillPath: "ROUTE" }, {})).resolves.toBe("ROUTE");
      await expect(resolveFulfillPath(s, {}, undefined, {})).resolves.toBe("ROUTE");
    }
  });

  it("falls back to the caller's own tenant when the request context carries none", async () => {
    const s = self("ship", null);
    await expect(resolveFulfillPath(s, {}, null, { tenantId: "t-9" })).resolves.toBe("SHIP");
    expect(s.featureConfig!.getEffectiveMode).toHaveBeenCalledWith("t-9", "fulfilment_model");
  });
});
