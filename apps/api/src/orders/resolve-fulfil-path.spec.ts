import { BadRequestException } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { resolveFulfilPath, resolveCreateFulfilPath } from "./resolve-fulfil-path";
import { UNSET_CAPABILITY, type FulfilmentCapability } from "./counter-sale/capability-shape";

/**
 * SA-655 item 10: the ONE pure resolver for an order's fulfil path. The capability shapes below are
 * what #3188's BY_MODE table derives (see counter-sale/capability-shape.ts).
 */
const { ROUTE, SHIP, PICKUP } = FulfillPath;

const derived = (
  methods: FulfilmentCapability["methods"],
  over: Partial<FulfilmentCapability> = {},
): FulfilmentCapability => ({
  methods,
  staffDefault: methods[0],
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  consistent: true,
  ...over,
});
const inStore = (methods: FulfilmentCapability["methods"]) =>
  derived(methods, {
    staffOpensAs: "counter",
    portalMethods: [...methods],
    portalDefault: methods[0],
    counter: "always",
  });

const CAPS = {
  unset: UNSET_CAPABILITY,
  delivery: derived(["ROUTE"], { portalMethods: ["ROUTE"], portalDefault: "ROUTE" }),
  ship: derived(["SHIP"], { portalMethods: ["SHIP"], portalDefault: "SHIP" }),
  both: derived(["ROUTE", "SHIP"], { portalMethods: ["ROUTE", "SHIP"], portalDefault: "ROUTE" }),
  pickup: inStore(["PICKUP"]),
  pickup_ship: inStore(["PICKUP", "SHIP"]),
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code?: string };
  }
  throw new Error("expected a refusal");
};

describe("resolveFulfilPath", () => {
  describe("10a. unset tenant: byte-identical to today", () => {
    const today = (requested?: FulfillPath, customerDefault?: FulfillPath) =>
      requested ?? customerDefault ?? ROUTE;
    const combos: Array<FulfillPath | undefined> = [undefined, ROUTE, SHIP];
    it.each(["staff", "buyer"] as const)("%s: requested ?? customerDefault ?? ROUTE", (actor) => {
      for (const requested of combos)
        for (const customerDefault of combos)
          expect(resolveFulfilPath({ cap: CAPS.unset, actor, requested, customerDefault })).toBe(
            today(requested, customerDefault),
          );
    });
    it.each(["staff", "buyer"] as const)("%s: a requested PICKUP is refused", (actor) => {
      expect(() => resolveFulfilPath({ cap: CAPS.unset, actor, requested: PICKUP })).toThrow(
        BadRequestException,
      );
    });
  });

  describe("10b. mode pickup", () => {
    const cap = CAPS.pickup;
    it("staff with no request resolves PICKUP", () => {
      expect(resolveFulfilPath({ cap, actor: "staff" })).toBe(PICKUP);
    });
    it("staff requested ROUTE (an old client hard-sends it) resolves PICKUP, never ROUTE", () => {
      expect(resolveFulfilPath({ cap, actor: "staff", requested: ROUTE })).toBe(PICKUP);
    });
    it("a customer default of ROUTE (every existing customer) means no preference: PICKUP", () => {
      expect(resolveFulfilPath({ cap, actor: "staff", customerDefault: ROUTE })).toBe(PICKUP);
      expect(
        resolveFulfilPath({ cap, actor: "staff", requested: ROUTE, customerDefault: ROUTE }),
      ).toBe(PICKUP);
    });
    it("a customer default of SHIP is honoured", () => {
      expect(resolveFulfilPath({ cap, actor: "staff", customerDefault: SHIP })).toBe(SHIP);
      expect(
        resolveFulfilPath({ cap, actor: "staff", requested: ROUTE, customerDefault: SHIP }),
      ).toBe(SHIP);
    });
    it("a customer default of PICKUP is honoured", () => {
      expect(resolveFulfilPath({ cap, actor: "staff", customerDefault: PICKUP })).toBe(PICKUP);
    });
    it("an explicit SHIP stays SHIP ('Ship this order instead'), even over a PICKUP default", () => {
      expect(resolveFulfilPath({ cap, actor: "staff", requested: SHIP })).toBe(SHIP);
      expect(
        resolveFulfilPath({ cap, actor: "staff", requested: SHIP, customerDefault: PICKUP }),
      ).toBe(SHIP);
    });
    it("an explicit PICKUP is PICKUP over a SHIP default", () => {
      expect(
        resolveFulfilPath({ cap, actor: "staff", requested: PICKUP, customerDefault: SHIP }),
      ).toBe(PICKUP);
    });
    it("buyer: PICKUP only (no request or PICKUP)", () => {
      expect(resolveFulfilPath({ cap, actor: "buyer" })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "buyer", requested: PICKUP })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "buyer", customerDefault: ROUTE })).toBe(PICKUP);
    });
    it.each([SHIP, ROUTE])(
      "buyer requesting %s is refused FULFIL_METHOD_NOT_OFFERED",
      (requested) => {
        const body = codeOf(() => resolveFulfilPath({ cap, actor: "buyer", requested }));
        expect(body.code).toBe("FULFIL_METHOD_NOT_OFFERED");
      },
    );
  });

  describe("10c. mode pickup_ship", () => {
    const cap = CAPS.pickup_ship;
    it("staff default is PICKUP; an explicit SHIP stays SHIP; ROUTE means no preference", () => {
      expect(resolveFulfilPath({ cap, actor: "staff" })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "staff", requested: SHIP })).toBe(SHIP);
      expect(resolveFulfilPath({ cap, actor: "staff", requested: ROUTE })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "staff", customerDefault: ROUTE })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "staff", customerDefault: SHIP })).toBe(SHIP);
    });
    it("buyer default is PICKUP; PICKUP and SHIP are honoured", () => {
      expect(resolveFulfilPath({ cap, actor: "buyer" })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "buyer", customerDefault: ROUTE })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "buyer", requested: PICKUP })).toBe(PICKUP);
      expect(resolveFulfilPath({ cap, actor: "buyer", requested: SHIP })).toBe(SHIP);
    });
    it("buyer requesting ROUTE is refused FULFIL_METHOD_NOT_OFFERED", () => {
      const body = codeOf(() => resolveFulfilPath({ cap, actor: "buyer", requested: ROUTE }));
      expect(body.code).toBe("FULFIL_METHOD_NOT_OFFERED");
    });
  });

  describe("10d. delivery / ship / both: unchanged", () => {
    it.each(["delivery", "ship", "both"] as const)(
      "%s resolves like today for both actors",
      (m) => {
        for (const actor of ["staff", "buyer"] as const) {
          expect(resolveFulfilPath({ cap: CAPS[m], actor })).toBe(ROUTE);
          expect(resolveFulfilPath({ cap: CAPS[m], actor, requested: SHIP })).toBe(SHIP);
          expect(resolveFulfilPath({ cap: CAPS[m], actor, customerDefault: SHIP })).toBe(SHIP);
          expect(
            resolveFulfilPath({ cap: CAPS[m], actor, requested: ROUTE, customerDefault: SHIP }),
          ).toBe(ROUTE);
          expect(() => resolveFulfilPath({ cap: CAPS[m], actor, requested: PICKUP })).toThrow(
            BadRequestException,
          );
        }
      },
    );
  });
});

describe("resolveCreateFulfilPath (the async edge create() calls)", () => {
  const reader = (cap: FulfilmentCapability | undefined) => ({
    get: jest.fn().mockResolvedValue(cap),
  });

  it("no reader (a spec or module that never bound one) = unset = today", async () => {
    await expect(
      resolveCreateFulfilPath(undefined, "t-1", { role: "OPERATOR", customerDefault: SHIP }),
    ).resolves.toBe(SHIP);
    await expect(resolveCreateFulfilPath(undefined, "t-1", { role: "OPERATOR" })).resolves.toBe(
      ROUTE,
    );
  });

  it("a reader that yields nothing is treated as unset", async () => {
    await expect(
      resolveCreateFulfilPath(reader(undefined), "t-1", { role: "CUSTOMER" }),
    ).resolves.toBe(ROUTE);
  });

  it("reads the capability of the caller's tenant", async () => {
    const r = reader(CAPS.pickup);
    await expect(resolveCreateFulfilPath(r, "t-1", { role: "OPERATOR" })).resolves.toBe(PICKUP);
    expect(r.get).toHaveBeenCalledWith("t-1");
  });

  it("CUSTOMER is the buyer actor; every other role is staff", async () => {
    const r = reader(CAPS.pickup);
    await expect(
      resolveCreateFulfilPath(r, "t-1", { role: "CUSTOMER", requested: SHIP }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      resolveCreateFulfilPath(r, "t-1", { role: "OPERATOR", requested: SHIP }),
    ).resolves.toBe(SHIP);
    await expect(
      resolveCreateFulfilPath(r, "t-1", { role: "DRIVER", requested: ROUTE }),
    ).resolves.toBe(PICKUP);
  });
});
