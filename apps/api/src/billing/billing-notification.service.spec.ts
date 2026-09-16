import { BillingNotificationService } from "./billing-notification.service";

function makeService(overrides?: {
  createImpl?: (...args: any[]) => Promise<any>;
  adminUser?: { email: string; username: string } | null;
  tenant?: { name: string | null; slug: string } | null;
  sendImpl?: (...args: any[]) => Promise<any>;
}) {
  const create = overrides?.createImpl
    ? jest.fn(overrides.createImpl)
    : jest.fn().mockResolvedValue({});
  const prisma = {
    billingNotificationLog: { create },
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides?.adminUser === undefined
            ? { email: "admin@acme.test", username: "Jamie" }
            : overrides.adminUser,
        ),
    },
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          overrides?.tenant === undefined
            ? { name: "Acme Retail", slug: "acme" }
            : overrides.tenant,
        ),
    },
  } as any;
  const send = overrides?.sendImpl
    ? jest.fn(overrides.sendImpl)
    : jest.fn().mockResolvedValue({ delivered: true });
  const email = { send } as any;
  return { svc: new BillingNotificationService(prisma, email), prisma, email, create, send };
}

describe("BillingNotificationService", () => {
  describe("idempotency", () => {
    it("sends once, then a second call for the SAME (tenant, milestone, key) is a no-op", async () => {
      let calls = 0;
      const { svc, send } = makeService({
        createImpl: async () => {
          calls++;
          if (calls > 1) {
            const err: any = new Error("duplicate key");
            err.code = "P2002";
            throw err;
          }
          return {};
        },
      });
      const at = new Date("2026-10-01T00:00:00.000Z");
      await svc.notifyDowngradeScheduled("t1", "Growth", "Starter", at);
      await svc.notifyDowngradeScheduled("t1", "Growth", "Starter", at);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("a DIFFERENT key for the same tenant+milestone (a re-scheduled downgrade) sends again", async () => {
      const { svc, send } = makeService();
      await svc.notifyDowngradeScheduled(
        "t1",
        "Growth",
        "Starter",
        new Date("2026-10-01T00:00:00.000Z"),
      );
      await svc.notifyDowngradeScheduled(
        "t1",
        "Growth",
        "Starter",
        new Date("2026-11-01T00:00:00.000Z"),
      );
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("a claim error OTHER than a unique violation also suppresses the send (fail closed, not duplicate-prone)", async () => {
      const { svc, send } = makeService({
        createImpl: async () => {
          throw new Error("connection reset");
        },
      });
      await svc.notifyCancelled("t1");
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("fail-closed behavior — never throws into the caller", () => {
    it("no tenant admin found: does not send, does not throw", async () => {
      const { svc, send } = makeService({ adminUser: null });
      await expect(svc.notifyCancelled("t1")).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it("EmailService.send() rejecting never propagates out of a notify* call", async () => {
      const { svc } = makeService({
        sendImpl: async () => {
          throw new Error("SMTP down");
        },
      });
      await expect(svc.notifySuspended("t1", "overdue payment")).resolves.toBeUndefined();
    });

    it("a missing tenant row falls back to a generic businessName instead of throwing", async () => {
      const { svc, send } = makeService({ tenant: null });
      await svc.notifyCancelled("t1");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].html).toContain("your account");
    });
  });

  describe("per-milestone content and routing", () => {
    it("notifyUpgradeConfirmed passes the exact proratedAmount through to the template, unrounded/unmodified", async () => {
      const { svc, send } = makeService();
      await svc.notifyUpgradeConfirmed("t1", "Starter", "Growth", 42.5);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].html).toContain("$42.50");
    });

    it("notifyTrialEnding sends to the resolved admin's email with the milestone-specific subject", async () => {
      const { svc, send } = makeService();
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_1D", new Date("2026-09-17T00:00:00.000Z"));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].to).toBe("admin@acme.test");
      expect(send.mock.calls[0][0].subject).toContain("tomorrow");
    });

    it("notifyDowngradeApplied and notifyDowngradeScheduled are independent milestones — both send for the same tenant/date", async () => {
      const { svc, send } = makeService();
      const at = new Date("2026-10-01T00:00:00.000Z");
      await svc.notifyDowngradeScheduled("t1", "Growth", "Starter", at);
      await svc.notifyDowngradeApplied("t1", "Growth", "Starter", at);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
