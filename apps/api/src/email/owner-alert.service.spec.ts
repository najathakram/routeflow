/**
 * W1 (COPY 2q): the owner's four trial alerts. Subjects and first lines are the shipped words; the service never throws;
 * no list set means no mail; one bad address never costs the others theirs; an account with a card sends no plan alert.
 */
import { OwnerAlertService } from "./owner-alert.service";

const TENANT = {
  id: "t-1",
  name: "Acme Foods",
  slug: "acme-trial",
  createdAt: new Date("2026-11-01T10:00:00.000Z"),
  status: "ACTIVE",
};

function build(sub: Record<string, unknown> | null = null, tenant: unknown = TENANT) {
  const prisma = {
    tenant: { findUnique: jest.fn(async () => tenant) },
    tenantSubscription: { findUnique: jest.fn(async () => sub) },
  };
  const email = { send: jest.fn(async () => ({ delivered: true, transport: "resend" })) };
  const svc = new OwnerAlertService(prisma as never, email as never);
  return { svc, prisma, email };
}

const ENV_KEYS = ["DEMO_BOOKING_ADMIN_EMAIL", "WEB_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEMO_BOOKING_ADMIN_EMAIL = "owner@example.test, second@example.test";
  process.env.WEB_URL = "https://app.example.test";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sentTo = (email: { send: jest.Mock }) =>
  email.send.mock.calls.map((c) => (c[0] as { to: string }).to);
const first = (email: { send: jest.Mock }) => email.send.mock.calls[0][0] as Record<string, string>;

describe("OwnerAlertService", () => {
  it("trial verified: subject, first line, contact, Workspace ID and the back-office link, one send per address", async () => {
    const { svc, email } = build();
    await svc.trialVerified("t-1", "jane@example.test");
    expect(sentTo(email)).toEqual(["owner@example.test", "second@example.test"]);
    const m = first(email);
    expect(m.subject).toBe("New RouteFlow trial: Acme Foods");
    expect(m.text.split("\n\n")[0]).toBe("Acme Foods just verified their email.");
    expect(m.text).toContain("Contact email: jane@example.test");
    expect(m.text).toContain("Workspace ID: acme-trial");
    expect(m.text).toContain("https://app.example.test/admin/tenants/t-1");
    expect(m.senderClass).toBe("platform");
  });

  it("verification mail failed: its own subject, and it says the account cannot sign in yet", async () => {
    const { svc, email } = build();
    await svc.verificationMailFailed("t-1", "jane@example.test");
    const m = first(email);
    expect(m.subject).toBe("New RouteFlow trial, verification email failed: Acme Foods");
    expect(m.text).toContain("can't sign in yet");
  });

  it("kept setup: 'Check this new account' with the half-set-up line", async () => {
    const { svc, email } = build();
    await svc.keptSetup("t-1");
    const m = first(email);
    expect(m.subject).toBe("Check this new account: Acme Foods");
    expect(m.text).toContain(
      "Acme Foods answered the first question, but its setup had already changed, so we left it alone. It may be half set up.",
    );
  });

  it("escapes the business name in the html body", async () => {
    const { svc, email } = build(null, { ...TENANT, name: "<b>Acme</b>" });
    await svc.keptSetup("t-1");
    expect(first(email).html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(first(email).html).not.toContain("<b>Acme</b>");
  });

  describe("plan change on an account with no card", () => {
    const noCard = {
      stripeSubId: null,
      planKey: "TEAM",
      cycle: "ANNUAL",
      periodEnd: new Date("2026-12-15T00:00:00.000Z"),
      downgradeToPlanKey: "STARTER",
      downgradeEffectiveAt: new Date("2026-12-15T00:00:00.000Z"),
    };
    const firstLine = async (kind: Parameters<OwnerAlertService["planChangeNoCard"]>[1]) => {
      const { svc, email } = build(noCard);
      await svc.planChangeNoCard("t-1", kind);
      const m = first(email);
      expect(m.subject).toBe("RouteFlow plan change, no card: Acme Foods");
      expect(m.text).toContain("Bill them by hand from there.");
      expect(m.text).toContain("/admin/tenants/t-1");
      return m.text.split("\n\n")[0];
    };

    it("subscribe", async () =>
      expect(await firstLine("subscribe")).toBe(
        "Acme Foods picked Team, billed annually. No card was taken.",
      ));
    it("upgrade", async () =>
      expect(await firstLine("upgrade")).toBe("Acme Foods moved up to Team."));
    it("downgrade", async () =>
      expect(await firstLine("downgrade")).toBe(
        "Acme Foods moves down to Starter on December 15, 2026.",
      ));
    it("cancel, with its end date", async () =>
      expect(await firstLine("cancel")).toBe(
        "Acme Foods cancelled. It ends on December 15, 2026.",
      ));
    it("resume", async () =>
      expect(await firstLine("resume")).toBe("Acme Foods undid its change."));

    it("cancel with no end date drops the date", async () => {
      const { svc, email } = build({ ...noCard, periodEnd: null });
      await svc.planChangeNoCard("t-1", "cancel");
      expect(first(email).text.split("\n\n")[0]).toBe("Acme Foods cancelled.");
    });

    it("an account with a Stripe subscription is billed by Stripe: nothing is sent", async () => {
      const { svc, email } = build({ ...noCard, stripeSubId: "sub_123" });
      await svc.planChangeNoCard("t-1", "upgrade");
      expect(email.send).not.toHaveBeenCalled();
    });

    it.each(["TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED"])(
      "%s: not an ACTIVE account, so nothing is billed by hand: nothing is sent",
      async (status) => {
        const { svc, email } = build(noCard, { ...TENANT, status });
        await svc.planChangeNoCard("t-1", "upgrade");
        expect(email.send).not.toHaveBeenCalled();
      },
    );

    it("an account with no subscription row sends nothing", async () => {
      const { svc, email } = build(null);
      await svc.planChangeNoCard("t-1", "upgrade");
      expect(email.send).not.toHaveBeenCalled();
    });
  });

  describe("never throws", () => {
    it("no list set: the demo-booking default address gets it, as the booking notices do", async () => {
      delete process.env.DEMO_BOOKING_ADMIN_EMAIL;
      const { svc, email } = build();
      await expect(svc.trialVerified("t-1", "jane@example.test")).resolves.toBeUndefined();
      expect(sentTo(email)).toEqual(["admin@routeflow.info"]);
    });

    it("an unknown tenant sends nothing", async () => {
      const { svc, email } = build(null, null);
      await svc.keptSetup("t-1");
      expect(email.send).not.toHaveBeenCalled();
    });

    it("a database error is swallowed", async () => {
      const { svc, prisma } = build();
      prisma.tenant.findUnique.mockRejectedValueOnce(new Error("db down"));
      await expect(svc.keptSetup("t-1")).resolves.toBeUndefined();
    });

    it("one address that throws does not cost the other its mail", async () => {
      const { svc, email } = build();
      email.send.mockRejectedValueOnce(new Error("bounce"));
      await expect(svc.keptSetup("t-1")).resolves.toBeUndefined();
      expect(email.send).toHaveBeenCalledTimes(2);
    });

    it("an undelivered result is logged, not thrown", async () => {
      const { svc, email } = build();
      email.send.mockResolvedValue({ delivered: false, transport: "none" } as never);
      await expect(svc.keptSetup("t-1")).resolves.toBeUndefined();
    });
  });
});
