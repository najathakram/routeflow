import { BillingNotificationService } from "./billing-notification.service";
import { cancelledTemplate } from "./billing-notification.templates";

/** Simulates the real (tenantId, milestone, key) unique constraint: the same tuple throws
 *  P2002 on a repeat create(), exactly like Postgres would. Used by every test that asserts
 *  dedup/non-dedup behavior — a plain always-succeeds mock would pass those tests for the
 *  wrong reason (never actually exercising the claim logic). */
function realUniqueConstraintImpl() {
  const seen = new Set<string>();
  return async (args: { data: { tenantId: string; milestone: string; key: string } }) => {
    const k = `${args.data.tenantId}/${args.data.milestone}/${args.data.key}`;
    if (seen.has(k)) {
      const err: any = new Error("duplicate key");
      err.code = "P2002";
      throw err;
    }
    seen.add(k);
    return {};
  };
}

function makeService(overrides?: {
  createImpl?: (...args: any[]) => Promise<any>;
  deleteImpl?: (...args: any[]) => Promise<any>;
  admins?: { email: string; username: string | null }[] | null;
  tenant?: { name: string | null; slug: string } | null;
  tenantConfig?: { timezone: string } | null;
  sendPlatformImpl?: (...args: any[]) => Promise<any>;
}) {
  const create = overrides?.createImpl
    ? jest.fn(overrides.createImpl)
    : jest.fn().mockResolvedValue({});
  const del = overrides?.deleteImpl
    ? jest.fn(overrides.deleteImpl)
    : jest.fn().mockResolvedValue({});
  const prisma = {
    billingNotificationLog: { create, delete: del },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          overrides?.admins === undefined
            ? [{ email: "admin@acme.test", username: "Jamie" }]
            : (overrides.admins ?? []),
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
    tenantConfig: {
      // SA-738: the zone is read through the one resolver, which uses findUnique.
      findUnique: jest
        .fn()
        .mockResolvedValue(overrides?.tenantConfig === undefined ? null : overrides.tenantConfig),
    },
  } as any;
  const sendPlatform = overrides?.sendPlatformImpl
    ? jest.fn(overrides.sendPlatformImpl)
    : jest.fn().mockResolvedValue({ delivered: true, transport: "resend" });
  const email = { sendPlatform } as any;
  return {
    svc: new BillingNotificationService(prisma, email),
    prisma,
    email,
    create,
    delete: del,
    sendPlatform,
  };
}

describe("BillingNotificationService", () => {
  describe("idempotency", () => {
    it("sends once, then a second call for the SAME (tenant, milestone, key) is a no-op", async () => {
      let calls = 0;
      const { svc, sendPlatform } = makeService({
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
      expect(sendPlatform).toHaveBeenCalledTimes(1);
    });

    it("a DIFFERENT effective date for the same tenant+plan sends again", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
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
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("fix round (finding 3): a CORRECTED downgrade target at the SAME effective date is NOT suppressed", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      const effectiveAt = new Date("2026-10-01T00:00:00.000Z");
      await svc.notifyDowngradeScheduled("t1", "Scale", "Lite", effectiveAt);
      await svc.notifyDowngradeScheduled("t1", "Scale", "Starter", effectiveAt); // corrected target, same date
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("fix round (finding 6): notifyUpgradeConfirmed keys on periodEnd, not a fresh timestamp — a duplicate call in the SAME period is deduped", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      const periodEnd = new Date("2026-10-01T00:00:00.000Z");
      await svc.notifyUpgradeConfirmed("t1", "Starter", "Growth", 42.5, periodEnd);
      await svc.notifyUpgradeConfirmed("t1", "Starter", "Growth", 42.5, periodEnd);
      expect(sendPlatform).toHaveBeenCalledTimes(1);
    });

    it("fix round (finding 6): a NEW periodEnd (next billing cycle) sends again", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      await svc.notifyUpgradeConfirmed(
        "t1",
        "Starter",
        "Growth",
        42.5,
        new Date("2026-10-01T00:00:00.000Z"),
      );
      await svc.notifyUpgradeConfirmed(
        "t1",
        "Starter",
        "Growth",
        42.5,
        new Date("2026-11-01T00:00:00.000Z"),
      );
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("fix round (finding 6): a null periodEnd (upgrade before any period is set) falls back to a day-granularity key that still dedupes within the day", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      await svc.notifyUpgradeConfirmed("t1", "Starter", "Growth", 42.5, null);
      await svc.notifyUpgradeConfirmed("t1", "Starter", "Growth", 42.5, null);
      expect(sendPlatform).toHaveBeenCalledTimes(1);
    });

    it("fix round (finding 7): an EXTENDED trial (new trialEndsAt) re-warns instead of reading as already-sent", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_7D", new Date("2026-09-20T00:00:00.000Z"));
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_7D", new Date("2026-09-27T00:00:00.000Z")); // extended
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("the SAME trialEndsAt for the same milestone is deduped as before", async () => {
      const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
      const trialEndsAt = new Date("2026-09-20T00:00:00.000Z");
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_7D", trialEndsAt);
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_7D", trialEndsAt);
      expect(sendPlatform).toHaveBeenCalledTimes(1);
    });

    it("a claim error OTHER than a unique violation also suppresses the send (fail closed, not duplicate-prone)", async () => {
      const { svc, sendPlatform } = makeService({
        createImpl: async () => {
          throw new Error("connection reset");
        },
      });
      await svc.notifyCancelled("t1");
      expect(sendPlatform).not.toHaveBeenCalled();
    });
  });

  describe("pr3 pin: an existing sendIfClaimed caller is byte-identical", () => {
    it("notifyCancelled sends EXACTLY {to, subject, html, text} - no replyTo key, template output unchanged", async () => {
      const { svc, sendPlatform } = makeService();
      await svc.notifyCancelled("t1");
      const expected = cancelledTemplate({ businessName: "Acme Retail", adminName: "Jamie" });
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(sendPlatform.mock.calls[0][0]).toStrictEqual({
        to: "admin@acme.test",
        subject: expected.subject,
        html: expected.html,
        text: expected.text,
      });
      expect(Object.keys(sendPlatform.mock.calls[0][0])).toEqual(["to", "subject", "html", "text"]);
      expect(expected.subject).toBe("Subscription cancelled — Acme Retail");
    });
  });

  describe("fix round (finding 2): the claim is released when nothing was actually delivered", () => {
    it("EmailService.sendPlatform() returning delivered:false releases the claim, so a retry can send", async () => {
      const {
        svc,
        create,
        delete: del,
      } = makeService({
        sendPlatformImpl: async () => ({ delivered: false, transport: "none" }),
      });
      await svc.notifyCancelled("t1");
      expect(create).toHaveBeenCalledTimes(1); // claimed
      expect(del).toHaveBeenCalledTimes(1); // then released — no transport configured
    });

    it("a SUCCESSFUL delivery never releases the claim", async () => {
      const { svc, delete: del } = makeService();
      await svc.notifyCancelled("t1");
      expect(del).not.toHaveBeenCalled();
    });

    it("no admin found ALSO releases the claim (same 'nothing delivered' rule)", async () => {
      const { svc, create, delete: del, sendPlatform } = makeService({ admins: [] });
      await svc.notifyCancelled("t1");
      expect(create).toHaveBeenCalledTimes(1);
      expect(sendPlatform).not.toHaveBeenCalled();
      expect(del).toHaveBeenCalledTimes(1);
    });

    it("with MULTIPLE admins, at least one successful delivery keeps the claim (no release)", async () => {
      let call = 0;
      const { svc, delete: del } = makeService({
        admins: [
          { email: "a@acme.test", username: "A" },
          { email: "b@acme.test", username: "B" },
        ],
        sendPlatformImpl: async () => {
          call++;
          return { delivered: call === 1, transport: call === 1 ? "resend" : "none" };
        },
      });
      await svc.notifyCancelled("t1");
      expect(del).not.toHaveBeenCalled();
    });

    it("a release() that itself fails is swallowed, never thrown", async () => {
      const { svc } = makeService({
        sendPlatformImpl: async () => ({ delivered: false, transport: "none" }),
        deleteImpl: async () => {
          throw new Error("row already gone");
        },
      });
      await expect(svc.notifyCancelled("t1")).resolves.toBeUndefined();
    });
  });

  describe("fail-closed behavior — never throws into the caller", () => {
    it("no tenant admin found: does not send, does not throw", async () => {
      const { svc, sendPlatform } = makeService({ admins: [] });
      await expect(svc.notifyCancelled("t1")).resolves.toBeUndefined();
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("EmailService.sendPlatform() rejecting never propagates out of a notify* call", async () => {
      const { svc } = makeService({
        sendPlatformImpl: async () => {
          throw new Error("Resend down");
        },
      });
      await expect(svc.notifySuspended("t1", "overdue payment")).resolves.toBeUndefined();
    });

    it("notifySuspended passes the reason through: 'subscription canceled' gets the choose-a-plan copy", async () => {
      const { svc, sendPlatform } = makeService();
      await svc.notifySuspended("t1", "subscription canceled");
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      const mail = sendPlatform.mock.calls[0][0];
      expect(mail.text).toContain(
        "Your subscription was canceled. Choose a plan to restore access.",
      );
      expect(mail.text).not.toMatch(/payment details/i);
    });

    it("notifyCheckoutPlanNotApplied emails the admin once per checkout session and never throws", async () => {
      const { svc, sendPlatform } = makeService();
      await svc.notifyCheckoutPlanNotApplied("t1", "SCALE", "cs_1");
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(sendPlatform.mock.calls[0][0].subject).toContain("plan not changed");
    });

    it("a missing tenant row falls back to a generic businessName instead of throwing", async () => {
      const { svc, sendPlatform } = makeService({ tenant: null });
      await svc.notifyCancelled("t1");
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(sendPlatform.mock.calls[0][0].html).toContain("your account");
    });
  });

  describe("fix round (finding 8): every ACTIVE tenant admin is notified", () => {
    it("two admins both receive the email", async () => {
      const { svc, sendPlatform } = makeService({
        admins: [
          { email: "a@acme.test", username: "A" },
          { email: "b@acme.test", username: "B" },
        ],
      });
      await svc.notifyCancelled("t1");
      expect(sendPlatform).toHaveBeenCalledTimes(2);
      expect(sendPlatform.mock.calls.map((c: any[]) => c[0].to)).toEqual([
        "a@acme.test",
        "b@acme.test",
      ]);
    });

    it("the admin query filters status ACTIVE, role TENANT_ADMIN, deletedAt null, ordered by createdAt asc", async () => {
      const { svc, prisma } = makeService();
      await svc.notifyCancelled("t1");
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
        select: { email: true, username: true },
        orderBy: { createdAt: "asc" },
      });
    });
  });

  describe("fix round (finding 9): tenant-timezone display dates", () => {
    it("formats in the tenant's own timezone when TenantConfig has one", async () => {
      const { svc, sendPlatform } = makeService({
        tenantConfig: { timezone: "America/Los_Angeles" },
      });
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_1D", new Date("2026-09-17T05:00:00.000Z"));
      // 2026-09-17T05:00 UTC is 2026-09-16T22:00 Pacific — a different calendar day.
      expect(sendPlatform.mock.calls[0][0].html).toContain("Sep 16, 2026");
      expect(sendPlatform.mock.calls[0][0].html).not.toContain("(UTC)");
    });

    it("falls back to UTC, explicitly labelled, when the tenant has no TenantConfig row", async () => {
      const { svc, sendPlatform } = makeService({ tenantConfig: null });
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_1D", new Date("2026-09-17T05:00:00.000Z"));
      expect(sendPlatform.mock.calls[0][0].html).toContain("2026-09-17 (UTC)");
    });

    it("an invalid/unrecognised IANA zone fails safe to UTC instead of throwing", async () => {
      const { svc, sendPlatform } = makeService({ tenantConfig: { timezone: "Not/AZone" } });
      await expect(
        svc.notifyTrialEnding("t1", "TRIAL_ENDING_1D", new Date("2026-09-17T05:00:00.000Z")),
      ).resolves.toBeUndefined();
      expect(sendPlatform.mock.calls[0][0].html).toContain("(UTC)");
    });
  });

  describe("per-milestone content and routing", () => {
    it("notifyUpgradeConfirmed passes the exact proratedAmount through to the template, unrounded/unmodified", async () => {
      const { svc, sendPlatform } = makeService();
      await svc.notifyUpgradeConfirmed(
        "t1",
        "Starter",
        "Growth",
        42.5,
        new Date("2026-10-01T00:00:00.000Z"),
      );
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(sendPlatform.mock.calls[0][0].html).toContain("$42.50");
    });

    it("notifyTrialEnding sends to the resolved admin's email with the milestone-specific subject", async () => {
      const { svc, sendPlatform } = makeService();
      await svc.notifyTrialEnding("t1", "TRIAL_ENDING_1D", new Date("2026-09-17T00:00:00.000Z"));
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(sendPlatform.mock.calls[0][0].to).toBe("admin@acme.test");
      expect(sendPlatform.mock.calls[0][0].subject).toContain("tomorrow");
    });

    it("notifyDowngradeApplied and notifyDowngradeScheduled are independent milestones — both send for the same tenant/date", async () => {
      const { svc, sendPlatform } = makeService();
      const at = new Date("2026-10-01T00:00:00.000Z");
      await svc.notifyDowngradeScheduled("t1", "Growth", "Starter", at);
      await svc.notifyDowngradeApplied("t1", "Growth", "Starter", at);
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("sends via EmailService.sendPlatform, never the tenant-branded send()", async () => {
      const { svc, email, sendPlatform } = makeService();
      await svc.notifyCancelled("t1");
      expect(sendPlatform).toHaveBeenCalledTimes(1);
      expect(email.send).toBeUndefined(); // the mock never even defines .send — proves nothing else was called
    });
  });
});

describe("BillingNotificationService - dunning notices (SA-733r7 PR-B3)", () => {
  const extra = { payUrl: "https://pay.example.test/i/in_1" };

  it("claims (tenant, milestone, invoiceId): the same milestone for the same invoice sends once", async () => {
    const { svc, sendPlatform, create } = makeService({ createImpl: realUniqueConstraintImpl() });
    expect((await svc.notifyDunning("t1", "DUNNING_D3", "in_1", "d3", extra)).status).toBe("sent");
    expect((await svc.notifyDunning("t1", "DUNNING_D3", "in_1", "d3", extra)).status).toBe(
      "skipped",
    );
    expect(sendPlatform).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { tenantId: "t1", milestone: "DUNNING_D3", key: "in_1" },
    });
  });

  it("a NEW invoice failing later gets its own d0 / d3 / d6 run", async () => {
    const { svc, sendPlatform } = makeService({ createImpl: realUniqueConstraintImpl() });
    await svc.notifyDunning("t1", "DUNNING_D0", "in_1", "d0", extra);
    await svc.notifyDunning("t1", "DUNNING_D0", "in_2", "d0", extra);
    expect(sendPlatform).toHaveBeenCalledTimes(2);
  });

  it("a send nobody accepted releases the claim so the next sweep retries", async () => {
    const { svc, delete: del } = makeService({
      sendPlatformImpl: async () => ({ delivered: false }),
    });
    expect((await svc.notifyDunning("t1", "DUNNING_D0", "in_1", "d0", extra)).status).toBe(
      "failed",
    );
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("the copy is truthful per kind: d6 names no date, final names the local date, paused says read-only now", async () => {
    const { svc, sendPlatform } = makeService();
    await svc.notifyDunning("t1", "DUNNING_D6", "in_1", "d6", { ...extra, byDate: "Nov 8, 2026" });
    // dark's d6 must not threaten what will not happen (SA r-note 2): neutral, and it names the date
    expect(sendPlatform.mock.calls[0][0].html).not.toMatch(/read-only|read only/i);
    expect(sendPlatform.mock.calls[0][0].text).not.toMatch(/read-only|read only/i);
    expect(sendPlatform.mock.calls[0][0].subject).not.toMatch(/read-only|read only/i);
    expect(sendPlatform.mock.calls[0][0].text).toContain("update your card by Nov 8, 2026");
    await svc.notifyDunning("t1", "DUNNING_FINAL", "in_1", "final", {
      ...extra,
      readOnlyOn: "Nov 9, 2026",
    });
    expect(sendPlatform.mock.calls[1][0].text).toContain("read-only on Nov 9, 2026");
    await svc.notifyDunning("t1", "DUNNING_PAUSED", "in_1", "paused", extra);
    expect(sendPlatform.mock.calls[2][0].subject).toContain("now read-only");
    // every notice links to the invoice's hosted page
    for (const c of sendPlatform.mock.calls) expect(c[0].text).toContain(extra.payUrl);
  });

  it("paused_still_owed (SA G8): still read-only, names the invoice number and amount, links to the hosted page, no alarm words", async () => {
    const { svc, sendPlatform } = makeService();
    await svc.notifyDunning(
      "t1",
      "DUNNING_PAUSED_STILL_OWED",
      "in_1:2026-11-09T04:00:00.000Z",
      "paused_still_owed",
      {
        ...extra,
        invoiceNumber: "INV-0042",
        amountCents: 4900,
        currency: "usd",
      },
    );
    const mail = sendPlatform.mock.calls[0][0];
    expect(mail.text).toMatch(/still read-only/i);
    expect(mail.text).toContain("INV-0042");
    expect(mail.text).toContain("$49.00");
    expect(mail.text).toMatch(/pay/i);
    expect(mail.text).toContain(extra.payUrl);
    // neutral wording: the workspace is already read-only, so nothing here threatens or accuses
    for (const part of [mail.subject, mail.text]) {
      expect(part).not.toMatch(/overdue|failed|final|suspend|delinquen|urgent|immediately/i);
    }
  });

  it("paused_still_owed without an invoice number or amount still reads cleanly", async () => {
    const { svc, sendPlatform } = makeService();
    await svc.notifyDunning("t1", "DUNNING_PAUSED_STILL_OWED", "k", "paused_still_owed", extra);
    const text = sendPlatform.mock.calls[0][0].text;
    expect(text).toMatch(/still read-only/i);
    expect(text).not.toMatch(/undefined|null|NaN/);
  });

  it("recordDunningMilestone is the claim alone: no email", async () => {
    const { svc, sendPlatform, create } = makeService({ createImpl: realUniqueConstraintImpl() });
    expect(await svc.recordDunningMilestone("t1", "DUNNING_FINAL", "in_1")).toBe(true);
    expect(await svc.recordDunningMilestone("t1", "DUNNING_FINAL", "in_1")).toBe(false);
    expect(sendPlatform).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
