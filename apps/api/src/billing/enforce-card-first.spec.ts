import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/**
 * SA-774 chunk 1: the wiring of `enforceCardFirst` (flag off = no-op, flag on = the pure gate decides). The
 * decision table itself is pinned in `self-serve-plan-gate.spec.ts`; this proves the service reads the facts
 * and turns the outcome into the coded 409.
 */
function service(opts: {
  flag?: boolean | "absent";
  tenant?: { status: string; readOnlyReason?: string | null } | null;
  sub?: { stripeSubId: string | null; externalPayment: boolean } | null;
}) {
  const prisma = {
    tenant: { findUnique: jest.fn(async () => opts.tenant ?? null) },
    tenantSubscription: { findUnique: jest.fn(async () => opts.sub ?? null) },
    auditLog: { findFirst: jest.fn(async () => null) },
  };
  const svc = Object.create(SubscriptionMutationService.prototype) as Record<string, unknown>;
  svc.prisma = prisma;
  if (opts.flag !== "absent")
    svc.cardFirst = { isEnabled: jest.fn(async () => opts.flag === true) };
  const run = (op: "subscribe" | "upgrade" | "downgrade") =>
    (svc.enforceCardFirst as (t: string, o: string) => Promise<void>).call(svc, "t1", op);
  return { run, prisma };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse()["code"] as string;
  }
}

describe("SubscriptionMutationService.enforceCardFirst (SA-774 chunk 1)", () => {
  it("is a no-op when the flag service is absent or the flag is off (no reads at all)", async () => {
    for (const flag of ["absent", false] as const) {
      const { run, prisma } = service({ flag, tenant: { status: "TRIAL" } });
      await expect(run("subscribe")).resolves.toBeUndefined();
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    }
  });

  it("flag on: a card payer upgrades and downgrades, but subscribe is told to use Change plan", async () => {
    const f = {
      tenant: { status: "ACTIVE" },
      sub: { stripeSubId: "sub_acme", externalPayment: false },
    };
    await expect(service({ flag: true, ...f }).run("upgrade")).resolves.toBeUndefined();
    await expect(service({ flag: true, ...f }).run("downgrade")).resolves.toBeUndefined();
    expect(await codeOf(service({ flag: true, ...f }).run("subscribe"))).toBe(
      API_ERROR_CODES.USE_PLAN_CHANGE,
    );
  });

  it("flag on: a manual-pay tenant is refused with the catch-up code", async () => {
    const f = { tenant: { status: "ACTIVE" }, sub: { stripeSubId: null, externalPayment: true } };
    expect(await codeOf(service({ flag: true, ...f }).run("upgrade"))).toBe(
      API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP,
    );
  });

  it("flag on: a trial tenant with no subscription row is sent to checkout (refused until the builder lands)", async () => {
    expect(
      await codeOf(service({ flag: true, tenant: { status: "TRIAL" } }).run("subscribe")),
    ).toBe(API_ERROR_CODES.CHOOSE_PLAN_AT_CHECKOUT);
  });

  it("flag on: a missing tenant is left to the caller's own not-found handling", async () => {
    await expect(service({ flag: true, tenant: null }).run("subscribe")).resolves.toBeUndefined();
  });
});
