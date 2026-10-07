import { BadRequestException } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { UNSET_FULFILMENT_CAPABILITIES } from "@routeflow/types";
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
        // The buyer's REQUESTED path is honoured only where the portal offers a choice (portalMethods
        // non-empty); an unset / unknown mode has none, so it is exactly today's `stored ?? ROUTE`.
        const buyerNoChoice =
          audience === "buyer" && (mode === "unset" || mode === "some-unknown-mode");
        expect(await resolveFulfilPath(deps(mode), { explicit, stored, audience })).toBe(
          (buyerNoChoice ? undefined : explicit) ?? stored ?? R,
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

describe("(g) SA-678: a capability read failure fails OPEN to today's rule (never blocks an order)", () => {
  it("logs and resolves explicit ?? stored ?? ROUTE", async () => {
    const d = deps(new Error("db down"));
    expect(await resolveFulfilPath(d, { stored: R, audience: "staff" })).toBe(R);
    expect(await resolveFulfilPath(d, { explicit: S, stored: R, audience: "staff" })).toBe(S);
    // a blip reads as unset: the buyer's requested path is ignored, exactly as for an unset tenant
    expect(await resolveFulfilPath(d, { explicit: S, stored: R, audience: "buyer" })).toBe(R);
    expect(await activeFulfilPath(d, { stored: S, audience: "staff" })).toBeUndefined();
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("capability read failed"));
  });
});

const P = FulfillPath.PICKUP;
const refusal = {
  status: 400,
  response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
};

describe("resolveFulfilPath: pickup mode (staff): ROUTE means no preference", () => {
  it.each(["pickup", "pickup_ship"])(
    "%s: no request, or a requested ROUTE, resolves PICKUP",
    async (mode) => {
      expect(await resolveFulfilPath(deps(mode), { stored: null, audience: "staff" })).toBe(P);
      expect(
        await resolveFulfilPath(deps(mode), { explicit: R, stored: null, audience: "staff" }),
      ).toBe(P);
      // the web and mobile hard-send the stored path: ROUTE over a stored ROUTE is still "no preference"
      expect(
        await resolveFulfilPath(deps(mode), { explicit: R, stored: R, audience: "staff" }),
      ).toBe(P);
    },
  );

  it.each(["pickup_ship"])(
    "%s: a customer default ROUTE (the column default) is PICKUP, a default SHIP is SHIP",
    async (mode) => {
      expect(await resolveFulfilPath(deps(mode), { stored: R, audience: "staff" })).toBe(P);
      expect(await resolveFulfilPath(deps(mode), { stored: S, audience: "staff" })).toBe(S);
      expect(
        await resolveFulfilPath(deps(mode), { explicit: R, stored: S, audience: "staff" }),
      ).toBe(S);
    },
  );

  it.each(["pickup_ship"])(
    "%s: an explicit SHIP stays SHIP ('Ship this order instead'); an explicit PICKUP is PICKUP",
    async (mode) => {
      expect(
        await resolveFulfilPath(deps(mode), { explicit: S, stored: R, audience: "staff" }),
      ).toBe(S);
      expect(
        await resolveFulfilPath(deps(mode), { explicit: S, stored: P, audience: "staff" }),
      ).toBe(S);
      expect(
        await resolveFulfilPath(deps(mode), { explicit: P, stored: S, audience: "staff" }),
      ).toBe(P);
      expect(
        await resolveFulfilPath(deps(mode), { explicit: P, stored: R, audience: "staff" }),
      ).toBe(P);
    },
  );

  it("the active resolver answers (not undefined) for a pickup business", async () => {
    expect(await activeFulfilPath(deps("pickup"), { stored: R, audience: "staff" })).toBe(P);
  });
});

describe("resolveFulfilPath: pickup mode (buyer)", () => {
  it("pickup: PICKUP only; default PICKUP whatever the customer's stored path", async () => {
    for (const stored of [R, S, null]) {
      expect(await resolveFulfilPath(deps("pickup"), { stored, audience: "buyer" })).toBe(P);
      expect(
        await resolveFulfilPath(deps("pickup"), { explicit: P, stored, audience: "buyer" }),
      ).toBe(P);
    }
  });

  it.each([S, R])("pickup: a requested %s is 400 FULFIL_METHOD_NOT_OFFERED", async (explicit) => {
    await expect(
      resolveFulfilPath(deps("pickup"), { explicit, stored: R, audience: "buyer" }),
    ).rejects.toMatchObject(refusal);
  });

  it("pickup_ship: PICKUP or SHIP honoured, default PICKUP", async () => {
    expect(await resolveFulfilPath(deps("pickup_ship"), { stored: R, audience: "buyer" })).toBe(P);
    expect(await resolveFulfilPath(deps("pickup_ship"), { stored: S, audience: "buyer" })).toBe(P);
    expect(
      await resolveFulfilPath(deps("pickup_ship"), { explicit: P, stored: R, audience: "buyer" }),
    ).toBe(P);
    expect(
      await resolveFulfilPath(deps("pickup_ship"), { explicit: S, stored: R, audience: "buyer" }),
    ).toBe(S);
  });

  it("pickup_ship: a requested ROUTE is 400 FULFIL_METHOD_NOT_OFFERED", async () => {
    await expect(
      resolveFulfilPath(deps("pickup_ship"), { explicit: R, stored: R, audience: "buyer" }),
    ).rejects.toMatchObject(refusal);
  });
});

describe("resolveFulfilPath: a requested PICKUP is refused wherever the business does not offer it", () => {
  it.each(["unset", "delivery", "both", "ship", "some-unknown-mode"])(
    "staff, mode %s",
    async (mode) => {
      await expect(
        resolveFulfilPath(deps(mode), { explicit: P, stored: R, audience: "staff" }),
      ).rejects.toMatchObject(refusal);
    },
  );

  it("staff, capability read failed or no feature-config service: still refused (a blip never opens PICKUP)", async () => {
    await expect(
      resolveFulfilPath(deps(new Error("db down")), { explicit: P, stored: R, audience: "staff" }),
    ).rejects.toMatchObject(refusal);
    await expect(
      resolveFulfilPath({ tenantId: "t1" }, { explicit: P, stored: R, audience: "staff" }),
    ).rejects.toMatchObject(refusal);
  });

  it.each(["delivery", "both", "ship"])(
    "buyer, mode %s (the portal offers a choice, PICKUP is not in it)",
    async (mode) => {
      await expect(
        resolveFulfilPath(deps(mode), { explicit: P, stored: R, audience: "buyer" }),
      ).rejects.toMatchObject(refusal);
    },
  );
});

describe("resolveFulfilPath: the buyer's requested path is IGNORED where the portal offers no choice", () => {
  it("unset: exactly today's stored ?? ROUTE, whatever was requested (PICKUP included: no 400)", async () => {
    for (const explicit of [R, S, P]) {
      expect(
        await resolveFulfilPath(deps("unset"), { explicit, stored: S, audience: "buyer" }),
      ).toBe(S);
      expect(
        await resolveFulfilPath(deps("unset"), { explicit, stored: R, audience: "buyer" }),
      ).toBe(R);
      expect(
        await resolveFulfilPath(deps("unset"), { explicit, stored: null, audience: "buyer" }),
      ).toBe(R);
    }
  });
});

describe("(e) SA-666b: pickup and pickup_ship are available and a stored one derives the in-store capability", () => {
  const unset = deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: true });

  it("the registry marks every fulfilment_model mode available:true (the flip changed ONLY that field)", () => {
    const modes = featureDefByKey("fulfilment_model")!.config!.modes;
    for (const m of ["unset", "delivery", "ship", "both", "pickup", "pickup_ship"])
      expect(modes[m].available).toBe(true);
    expect(modes.pickup).toMatchObject({ label: "In store only", lifecycle: "proposed" });
    expect(modes.pickup_ship).toMatchObject({
      label: "In store + shipping",
      lifecycle: "proposed",
    });
  });

  it("a STORED pickup / pickup_ship derives the in-store capability (read from the registry), never the unset one", () => {
    for (const [mode, methods] of [
      ["pickup", ["PICKUP"]],
      ["pickup_ship", ["PICKUP", "SHIP"]],
    ] as const) {
      const c = deriveFulfilmentCapability({ mode, counterSales: "unset", fleet: true });
      expect(c).toMatchObject({
        methods,
        staffDefault: "PICKUP",
        portalMethods: methods,
        portalDefault: "PICKUP",
        counter: "always",
      });
      expect(c).not.toEqual(unset);
    }
  });

  it("(f) CONTRACT: the unset capability shape the web's isUnsetCapabilities() keys on", () => {
    // The web's unset check (fleet-off, #3198) treats exactly this shape as "no mode set": ROUTE+SHIP
    // offered, ROUTE the default, no buyer choice.
    // L-072: pinned to the ONE shared constant, never a hand-typed copy.
    expect(unset).toEqual(UNSET_FULFILMENT_CAPABILITIES);
    // and no configured mode produces it by accident (the web must be able to tell them apart)
    for (const mode of ["delivery", "ship", "both"]) {
      const c = deriveFulfilmentCapability({ mode, counterSales: "unset", fleet: true });
      expect(c.portalMethods.length > 0 && JSON.stringify(c.methods) !== "[]").toBe(true);
      expect(c).not.toEqual(unset);
    }
  });
});

describe("resolveFulfilPath: pickup-ONLY never ships (staff); pickup_ship unchanged", () => {
  it("a stored default ROUTE or none resolves PICKUP", async () => {
    expect(await resolveFulfilPath(deps("pickup"), { stored: R, audience: "staff" })).toBe(P);
    expect(await resolveFulfilPath(deps("pickup"), { stored: null, audience: "staff" })).toBe(P);
  });
  it("a stored SHIP (no explicit) resolves PICKUP", async () => {
    expect(await resolveFulfilPath(deps("pickup"), { stored: S, audience: "staff" })).toBe(P);
  });
  it("an explicit SHIP EQUAL to the stored path is treated as omitted (logged) and resolves PICKUP", async () => {
    const d = deps("pickup");
    expect(await resolveFulfilPath(d, { explicit: S, stored: S, audience: "staff" })).toBe(P);
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("treated as omitted"));
  });
  it.each([R, null, P])(
    "an explicit SHIP DIFFERENT from the stored path (%s) is 400 FULFIL_METHOD_NOT_OFFERED",
    async (stored) => {
      await expect(
        resolveFulfilPath(deps("pickup"), { explicit: S, stored, audience: "staff" }),
      ).rejects.toMatchObject(refusal);
    },
  );
  it("an explicit PICKUP is PICKUP", async () => {
    expect(
      await resolveFulfilPath(deps("pickup"), { explicit: P, stored: S, audience: "staff" }),
    ).toBe(P);
  });
  it("pickup_ship is unchanged: explicit SHIP stays SHIP, stored SHIP stays SHIP", async () => {
    expect(
      await resolveFulfilPath(deps("pickup_ship"), { explicit: S, stored: R, audience: "staff" }),
    ).toBe(S);
    expect(
      await resolveFulfilPath(deps("pickup_ship"), { explicit: S, stored: S, audience: "staff" }),
    ).toBe(S);
    expect(await resolveFulfilPath(deps("pickup_ship"), { stored: S, audience: "staff" })).toBe(S);
  });
});
