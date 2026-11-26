import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  assertLivePaymentsAllowed,
  assertTenantLivePaymentsAllowed,
  recordLivePaymentsHeld,
  stripeKeyModeOf,
} from "./live-payments-wall";

/**
 * W-1464 PR-B (SA-1538 R5/R6): the one refusal in front of every Stripe session creator. Only a PRODUCTION business
 * may open one; any other class, a missing class and an unknown value are refused with the coded 409.
 */
describe("assertLivePaymentsAllowed", () => {
  it("lets a PRODUCTION business through (guard: today's behaviour)", () => {
    expect(() => assertLivePaymentsAllowed("PRODUCTION")).not.toThrow();
  });

  it.each(["TEST", "DEMO", "INTERNAL", "", "SANDBOX", "production", null, undefined])(
    "refuses class %p with the coded 409",
    (cls) => {
      let thrown: unknown;
      try {
        assertLivePaymentsAllowed(cls as string | null | undefined);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getStatus()).toBe(409);
      expect((thrown as ConflictException).getResponse()).toEqual({
        code: API_ERROR_CODES.LIVE_PAYMENTS_OFF,
        message: "This is a test business. Payments are switched off.",
      });
    },
  );
});

describe("assertTenantLivePaymentsAllowed", () => {
  const prismaWith = (row: { class?: string } | null) => ({
    tenant: { findUnique: jest.fn(async () => row) },
  });

  it("reads the class by primary key and lets PRODUCTION through", async () => {
    const prisma = prismaWith({ class: "PRODUCTION" });
    await expect(assertTenantLivePaymentsAllowed(prisma as any, "t1")).resolves.toBeUndefined();
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: "t1" },
      select: { class: true },
    });
  });

  it.each([{ class: "TEST" }, { class: "DEMO" }, {}, null])(
    "refuses a tenant read of %p",
    async (row) => {
      await expect(
        assertTenantLivePaymentsAllowed(prismaWith(row as any) as any, "t1"),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: API_ERROR_CODES.LIVE_PAYMENTS_OFF },
      });
    },
  );
});

describe("recordLivePaymentsHeld", () => {
  const held = { tenantId: "t1", entityType: "stripe_event", entityId: "evt_1", what: "a change" };

  it("writes one LIVE_PAYMENTS_HELD row and a domain-only warn line", async () => {
    const create = jest.fn().mockResolvedValue({});
    const warn = jest.fn();
    await recordLivePaymentsHeld({ prisma: { auditLog: { create } }, logger: { warn } }, held);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      action: "LIVE_PAYMENTS_HELD",
      entityType: "stripe_event",
      entityId: "evt_1",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is best effort: an audit write that fails does not throw (the warn line is the trail)", async () => {
    const create = jest.fn().mockRejectedValue(new Error("db down"));
    const warn = jest.fn();
    await expect(
      recordLivePaymentsHeld({ prisma: { auditLog: { create } }, logger: { warn } }, held),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts an unknown business (a dispatcher-level hold)", async () => {
    const create = jest.fn().mockResolvedValue({});
    await recordLivePaymentsHeld(
      { prisma: { auditLog: { create } }, logger: { warn: jest.fn() } },
      { ...held, tenantId: null },
    );
    expect(create.mock.calls[0][0].data.tenantId).toBeNull();
  });
});

/** SA-1547 S5: the wall reads the Stripe key mode. allowed = class === PRODUCTION || keyMode === "test". */
describe("stripeKeyModeOf (SA-1547 S5)", () => {
  it.each([
    ["sk_live_abc", "live"],
    ["rk_live_abc", "live"],
    ["sk_test_abc", "test"],
    ["rk_test_abc", "test"],
    ["", "none"],
    [undefined, "none"],
    ["pk_test_abc", "none"],
    ["whatever", "none"],
    ["SK_TEST_abc", "none"],
  ])("key %p is %s", (key, mode) => {
    expect(stripeKeyModeOf(key as string | undefined)).toBe(mode);
  });
});

describe("assertLivePaymentsAllowed with the key mode (SA-1547 S5 red cases a-d)", () => {
  it("(a) a TEST business with a live key is refused", () => {
    expect(() => assertLivePaymentsAllowed("TEST", "live")).toThrow(ConflictException);
  });
  it("(b) a TEST business with a test key is allowed", () => {
    expect(() => assertLivePaymentsAllowed("TEST", "test")).not.toThrow();
    expect(() => assertLivePaymentsAllowed("DEMO", "test")).not.toThrow();
    expect(() => assertLivePaymentsAllowed(null, "test")).not.toThrow();
  });
  it("(c) key none is refused for a non-PRODUCTION business", () => {
    expect(() => assertLivePaymentsAllowed("TEST", "none")).toThrow(ConflictException);
  });
  it("(d) a PRODUCTION business with a live key is allowed", () => {
    expect(() => assertLivePaymentsAllowed("PRODUCTION", "live")).not.toThrow();
  });
  it("the tenant-reading form takes the key mode too", async () => {
    const prisma = { tenant: { findUnique: jest.fn(async () => ({ class: "TEST" })) } };
    await expect(
      assertTenantLivePaymentsAllowed(prisma as any, "t1", "test"),
    ).resolves.toBeUndefined();
    await expect(
      assertTenantLivePaymentsAllowed(prisma as any, "t1", "live"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("with no explicit mode it reads the configured STRIPE_SECRET_KEY (unset = none = refused)", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    try {
      delete process.env.STRIPE_SECRET_KEY;
      expect(() => assertLivePaymentsAllowed("TEST")).toThrow(ConflictException);
      process.env.STRIPE_SECRET_KEY = "sk_test_x";
      expect(() => assertLivePaymentsAllowed("TEST")).not.toThrow();
      process.env.STRIPE_SECRET_KEY = "sk_live_x";
      expect(() => assertLivePaymentsAllowed("TEST")).toThrow(ConflictException);
    } finally {
      if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prev;
    }
  });
});
