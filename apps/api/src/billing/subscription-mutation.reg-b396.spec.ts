import { ConflictException, NotFoundException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/**
 * REG-B396 (SA-1167 R5): a TRIAL tenant could not cancel, because signup writes no TenantSubscription row and
 * `cancel()` threw 404 "No subscription to cancel." for it. The wrong value is that 404 (or a trial left
 * TRIAL). The service is built positionally, as every sibling spec does; every collaborator is mocked at
 * the module boundary.
 */
function make(opts: { status: string; sub?: unknown; casCount?: number; reRead?: string }) {
  const tx = {
    tenant: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue({ status: opts.reRead ?? "READ_ONLY" }),
    },
    tenantSubscription: { update: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: opts.status, class: "PRODUCTION", trialEndsAt: null }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(opts.sub ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const events = { emit: jest.fn().mockResolvedValue({}) };
  const entitlements = { invalidate: jest.fn() };
  const tenantStatus = { invalidate: jest.fn() };
  const stripe = {
    isConfigured: true,
    updateSubscription: jest.fn().mockResolvedValue({}),
    cancelSubscription: jest.fn().mockResolvedValue({}),
  };
  const svc = new SubscriptionMutationService(
    prisma as any,
    {} as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    entitlements as any,
    events as any,
    tenantStatus as any,
    stripe as any,
    {} as any,
    {} as any,
  );
  return { svc, tx, prisma, events, entitlements, tenantStatus, stripe };
}

describe("SubscriptionMutationService.cancel on a TRIAL tenant", () => {
  it("REG-B396: a TRIAL tenant with NO subscription row cancels into READ_ONLY/trial_cancelled, never a 404", async () => {
    const { svc, tx, events, entitlements, tenantStatus } = make({ status: "TRIAL", sub: null });

    await expect(svc.cancel("t-acme", "u-1")).resolves.toEqual({ cancelled: "trial" });

    expect(tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t-acme", status: "TRIAL" },
      data: {
        status: "READ_ONLY",
        readOnlyReason: "trial_cancelled",
        trialEndsAt: expect.any(Date),
      },
    });
    expect(events.emit).toHaveBeenCalledWith(
      "t-acme",
      BILLING_EVENTS.TRIAL_CANCELLED,
      expect.any(Object),
      expect.objectContaining({ tx }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t-acme");
    expect(tenantStatus.invalidate).toHaveBeenCalledWith("t-acme");
  });

  it("REG-B396: the row-less trial cancel never reads the subscription row, never writes one, never calls Stripe", async () => {
    const { svc, tx, prisma, stripe } = make({ status: "TRIAL", sub: null });
    await svc.cancel("t-acme");
    expect(prisma.tenantSubscription.findUnique).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("REG-B396: a lost compare-and-swap onto an ACTIVE tenant refuses; a trial cancel never overwrites a paying tenant", async () => {
    const { svc, events } = make({ status: "TRIAL", casCount: 0, reRead: "ACTIVE" });
    await expect(svc.cancel("t-acme")).rejects.toBeInstanceOf(ConflictException);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("REG-B396: the 404 is kept only for the genuine anomaly (ACTIVE with no row), not for a trial", async () => {
    const { svc } = make({ status: "ACTIVE", sub: null });
    await expect(svc.cancel("t-acme")).rejects.toBeInstanceOf(NotFoundException);
  });
});
