import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { deriveFulfilmentCapability } from "../billing/fulfilment-capability";
import { featureDefByKey } from "../billing/feature-registry";
import { activeFulfilPath, resolveFulfilPath } from "./fulfil-path-resolver";

/**
 * The ONE fulfil-path resolver. Real shapes throughout: a customer whose stored path is ROUTE (the column
 * default, so every customer made before the business switched to shipping) in a ship-only tenant.
 */
const deps = (mode: string | Error, logger = { warn: jest.fn() }) => ({
  featureConfig: {
    getEffectiveMode: jest.fn(async () => {
      if (mode instanceof Error) throw mode;
      return mode;
    }),
  },
  tenantId: "t1",
  logger,
});
const R = FulfillPath.ROUTE;
const S = FulfillPath.SHIP;

describe("resolveFulfilPath: active only where the capability EXCLUDES ROUTE (ship-only)", () => {
  it("(b) staff, explicit SHIP: used", async () => {
    expect(
      await resolveFulfilPath(deps("ship"), { explicit: S, stored: R, audience: "staff" }),
    ).toBe(S);
  });

  it("(b) staff, explicit ROUTE EQUAL to the stored ROUTE: treated as omitted (web/mobile always send the stored path), with a log line", async () => {
    const d = deps("ship");
    expect(await resolveFulfilPath(d, { explicit: R, stored: R, audience: "staff" })).toBe(S);
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("treated as omitted"));
  });

  it("(b) staff, explicit ROUTE that DIFFERS from the stored path: coded 400 FULFIL_METHOD_NOT_OFFERED", async () => {
    await expect(
      resolveFulfilPath(deps("ship"), { explicit: R, stored: S, audience: "staff" }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
    });
    await expect(
      resolveFulfilPath(deps("ship"), { explicit: R, stored: null, audience: "staff" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("(b) staff, omitted: the stored path when offered, else the staff default (a stored ROUTE customer ships)", async () => {
    expect(await resolveFulfilPath(deps("ship"), { stored: S, audience: "staff" })).toBe(S);
    expect(await resolveFulfilPath(deps("ship"), { stored: R, audience: "staff" })).toBe(S);
    expect(await resolveFulfilPath(deps("ship"), { stored: null, audience: "staff" })).toBe(S);
  });

  it("(c) buyer: omitted + stored ROUTE falls to the portal default SHIP", async () => {
    expect(await resolveFulfilPath(deps("ship"), { stored: R, audience: "buyer" })).toBe(S);
    expect(await resolveFulfilPath(deps("ship"), { stored: S, audience: "buyer" })).toBe(S);
  });

  it("(d) the template path resolves only for a ship-only business", async () => {
    expect(await activeFulfilPath(deps("ship"), { stored: R, audience: "staff" })).toBe(S);
  });
});

describe("resolveFulfilPath: unset / delivery / both are byte-identical to today (explicit ?? stored ?? ROUTE)", () => {
  const combos: Array<[FulfillPath | null | undefined, FulfillPath | null | undefined]> = [
    [S, R],
    [R, S],
    [undefined, S],
    [undefined, R],
    [undefined, undefined],
    [null, null],
    [R, undefined],
  ];
  it.each(["unset", "delivery", "both", "some-unknown-mode"])("mode %s", async (mode) => {
    for (const audience of ["staff", "buyer"] as const)
      for (const [explicit, stored] of combos) {
        expect(await resolveFulfilPath(deps(mode), { explicit, stored, audience })).toBe(
          explicit ?? stored ?? R,
        );
        expect(await activeFulfilPath(deps(mode), { explicit, stored, audience })).toBeUndefined();
      }
  });

  it("a deployment with no feature-config service resolves exactly as before", async () => {
    expect(
      await resolveFulfilPath(
        { tenantId: "t1" },
        { explicit: undefined, stored: S, audience: "staff" },
      ),
    ).toBe(S);
  });
});

describe("(g) a capability read failure is a coded 503, never a guessed path", () => {
  it("throws FULFIL_CAPABILITY_UNAVAILABLE", async () => {
    await expect(
      resolveFulfilPath(deps(new Error("db down")), { stored: R, audience: "staff" }),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: "FULFIL_CAPABILITY_UNAVAILABLE" }),
    });
    await expect(
      resolveFulfilPath(deps(new Error("x")), { stored: R, audience: "buyer" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("(e) SA-666/666a: pickup and pickup_ship are unavailable and a stored one reads as unset", () => {
  const unset = deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: true });

  it("the registry marks pickup and pickup_ship available:false (every other mode stays true)", () => {
    const modes = featureDefByKey("fulfilment_model")!.config!.modes;
    expect(modes.pickup.available).toBe(false);
    expect(modes.pickup_ship.available).toBe(false);
    for (const m of ["unset", "delivery", "ship", "both"]) expect(modes[m].available).toBe(true);
  });

  it("a STORED pickup / pickup_ship derives exactly the unset capability (read from the registry)", () => {
    // counter sales is its own switch: it still applies on top of the unset shape
    expect(
      deriveFulfilmentCapability({ mode: "pickup", counterSales: "on", fleet: false }),
    ).toEqual({
      ...unset,
      counter: "optional",
      fleet: false,
    });
    for (const mode of ["pickup", "pickup_ship"])
      expect(deriveFulfilmentCapability({ mode, counterSales: "unset", fleet: true })).toEqual(
        unset,
      );
  });

  it("(f) CONTRACT: the unset capability shape the web's isUnsetCapabilities() keys on", () => {
    // apps/web `isUnsetCapabilities` (fleet-off, #3198) treats exactly this shape as "no mode set":
    // ROUTE+SHIP offered, ROUTE the default, no buyer choice. A change here must change it too.
    expect(unset).toEqual({
      methods: ["ROUTE", "SHIP"],
      staffDefault: "ROUTE",
      staffOpensAs: "order",
      portalMethods: [],
      portalDefault: null,
      counter: "off",
      fleet: true,
      consistent: true,
    });
    // and no configured mode produces it by accident (the web must be able to tell them apart)
    for (const mode of ["delivery", "ship", "both"]) {
      const c = deriveFulfilmentCapability({ mode, counterSales: "unset", fleet: true });
      expect(c.portalMethods.length > 0 && JSON.stringify(c.methods) !== "[]").toBe(true);
      expect(c).not.toEqual(unset);
    }
  });
});
