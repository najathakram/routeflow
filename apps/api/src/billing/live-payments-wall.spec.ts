import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertLivePaymentsAllowed, assertTenantLivePaymentsAllowed } from "./live-payments-wall";

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
