import { BillingService } from "./billing.service";
import { PAYMENT_FAILED_EMAIL_REDUPE_DAYS } from "./dunning-config";

/**
 * Row 346: master's #2440 failed-payment e-mail (the off/dark path) went out once per Stripe
 * `invoice.payment_failed` EVENT, so every Stripe retry of the same invoice e-mailed the admin
 * again. It is now sent at most once per invoice per PAYMENT_FAILED_EMAIL_REDUPE_DAYS, deduped on the
 * EXISTING EmailDelivery marker (tenant + kind + entityType + entityId), no schema change.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SUB = {
  tenantId: "t1",
  stripeSubId: "sub_1",
  stripeCustomerId: "cus_1",
  failedPaymentCount: 0,
  tenant: { id: "t1", slug: "acme", name: "Acme" },
};
const failed = (id: string | null = "in_1") => ({
  id,
  customer: "cus_1",
  parent: { subscription_details: { subscription: "sub_1" } },
});

interface Row {
  tenantId: string;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  status: string;
  createdAt: Date;
}

/** A BillingService whose e-mail send RECORDS an EmailDelivery row, and whose findFirst honours the where. */
function make(opts: { rows?: Row[]; lookupError?: Error } = {}) {
  const rows: Row[] = opts.rows ?? [];
  const prisma = {
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(SUB),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue({ email: "admin@example.test", username: "admin" }),
    },
    emailDelivery: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (opts.lookupError) throw opts.lookupError;
        return (
          rows.find(
            (r) =>
              r.tenantId === where.tenantId &&
              r.kind === where.kind &&
              r.entityType === where.entityType &&
              r.entityId === where.entityId &&
              r.createdAt >= where.createdAt.gte &&
              (where.status?.in ? where.status.in.includes(r.status) : true),
          ) ?? null
        );
      }),
    },
  } as any;
  const email = {
    send: jest.fn(async (p: any) => {
      rows.push({
        tenantId: p.delivery.tenantId,
        kind: p.delivery.kind,
        entityType: p.delivery.entityType ?? null,
        entityId: p.delivery.entityId ?? null,
        status: "SENT",
        createdAt: new Date(),
      });
      return { delivered: true };
    }),
  } as any;
  const svc = new BillingService(
    prisma,
    {} as any,
    email,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(svc as any, "syncCoupon").mockResolvedValue(undefined);
  jest.spyOn(svc as any, "portalUrlOrEmpty").mockResolvedValue("https://billing.example.test/p/1");
  const warn = jest.spyOn((svc as any).logger, "warn").mockImplementation(() => undefined);
  return { svc, prisma, email, rows, warn };
}

describe("row 346: the #2440 failed-payment e-mail is deduped per invoice", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "dark";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  it("the window is a named constant of a sensible length (a week: the dunning ladder's span)", () => {
    expect(PAYMENT_FAILED_EMAIL_REDUPE_DAYS).toBe(7);
  });

  it("the FIRST payment_failed for an invoice sends one e-mail, recorded under the invoice id", async () => {
    const { svc, email, prisma } = make();
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].delivery).toEqual({
      tenantId: "t1",
      kind: "PAYMENT_FAILED",
      entityType: "StripeInvoice",
      entityId: "in_1",
    });
    // The lookup is tenant + kind + entity scoped, windowed, and ignores rows that never left the building.
    const where = prisma.emailDelivery.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: "t1",
      kind: "PAYMENT_FAILED",
      entityType: "StripeInvoice",
      entityId: "in_1",
    });
    expect(where.status.in).not.toContain("FAILED");
    // only a real send suppresses: FAILED, WOULD_SEND and QUEUED (written before a handoff) never do
    expect(where.status.in).toEqual(["SENT"]);
    const ageMs = Date.now() - where.createdAt.gte.getTime();
    expect(Math.abs(ageMs - PAYMENT_FAILED_EMAIL_REDUPE_DAYS * DAY_MS)).toBeLessThan(60_000);
  });

  it("a Stripe retry (a second payment_failed) for the SAME invoice inside the window sends nothing", async () => {
    const { svc, email, prisma } = make();
    await (svc as any).onPaymentFailed(failed());
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
    // The failure is still COUNTED on every event; only the e-mail is deduped.
    expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(2);
  });

  it("the same invoice again AFTER the window sends again", async () => {
    const old = new Date(Date.now() - (PAYMENT_FAILED_EMAIL_REDUPE_DAYS * DAY_MS + 60 * 60 * 1000));
    const { svc, email } = make({
      rows: [
        {
          tenantId: "t1",
          kind: "PAYMENT_FAILED",
          entityType: "StripeInvoice",
          entityId: "in_1",
          status: "SENT",
          createdAt: old,
        },
      ],
    });
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("a row just inside the window still suppresses", async () => {
    const recent = new Date(
      Date.now() - (PAYMENT_FAILED_EMAIL_REDUPE_DAYS * DAY_MS - 60 * 60 * 1000),
    );
    const { svc, email } = make({
      rows: [
        {
          tenantId: "t1",
          kind: "PAYMENT_FAILED",
          entityType: "StripeInvoice",
          entityId: "in_1",
          status: "SENT",
          createdAt: recent,
        },
      ],
    });
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).not.toHaveBeenCalled();
  });

  it("a DIFFERENT invoice for the same tenant still sends", async () => {
    const { svc, email } = make();
    await (svc as any).onPaymentFailed(failed("in_1"));
    await (svc as any).onPaymentFailed(failed("in_2"));
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send.mock.calls[1][0].delivery.entityId).toBe("in_2");
  });

  it("an earlier FAILED delivery (nothing was sent) does NOT suppress the retry's e-mail", async () => {
    const { svc, email } = make({
      rows: [
        {
          tenantId: "t1",
          kind: "PAYMENT_FAILED",
          entityType: "StripeInvoice",
          entityId: "in_1",
          status: "FAILED",
          createdAt: new Date(),
        },
      ],
    });
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("another tenant's row for the same invoice id does not suppress", async () => {
    const { svc, email } = make({
      rows: [
        {
          tenantId: "t_other",
          kind: "PAYMENT_FAILED",
          entityType: "StripeInvoice",
          entityId: "in_1",
          status: "SENT",
          createdAt: new Date(),
        },
      ],
    });
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("a lookup error fails OPEN: the e-mail still goes, a warn is logged, the handler never throws", async () => {
    const { svc, email, prisma, warn } = make({ lookupError: new Error("db blip") });
    await expect((svc as any).onPaymentFailed(failed())).resolves.toBeUndefined();
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(prisma.tenantSubscription.update).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c: any[]) => /dedupe|db blip/i.test(String(c[0])))).toBe(true);
  });

  it("an invoice event with no id cannot be deduped: it sends (no marker to key on)", async () => {
    const { svc, email, prisma } = make();
    await (svc as any).onPaymentFailed(failed(null));
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(prisma.emailDelivery.findFirst).not.toHaveBeenCalled();
  });

  it("off behaves like dark", async () => {
    process.env.BILLING_PAUSE_MODE = "off";
    const { svc, email } = make();
    await (svc as any).onPaymentFailed(failed());
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("enforced is unchanged: no legacy e-mail at all and no dedupe lookup", async () => {
    process.env.BILLING_PAUSE_MODE = "enforced";
    const { svc, email, prisma } = make();
    await (svc as any).onPaymentFailed(failed());
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.emailDelivery.findFirst).not.toHaveBeenCalled();
  });
});
