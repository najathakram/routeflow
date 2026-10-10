import { ConflictException } from "@nestjs/common";
import { assertNotPaymentOverdue, assertTenantNotPaymentOverdue } from "./payment-overdue";

const OPEN = {
  status: "open",
  amountPaid: 0,
  amountDue: 4900,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 3,
  subscriptionId: "sub_1",
  amountRemaining: 4900,
  hostedInvoiceUrl: "https://pay.example.test/i/in_1",
};

function ctx(facts: any = OPEN, throws = false) {
  const stripe: any = {
    getInvoiceFacts: throws
      ? jest.fn().mockRejectedValue(new Error("stripe down"))
      : jest.fn().mockResolvedValue(facts),
  };
  const logger: any = { warn: jest.fn() };
  return { stripe, logger };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as any;
  }
}

// READ_ONLY defaults to the reason a pause writes; the other reasons are spelled out where they matter
const tenant = (
  status: string,
  readOnlyReason: string | null = status === "READ_ONLY" ? "payment_overdue" : null,
) => ({
  id: "t1",
  status,
  readOnlyReason,
});
const marker = { pastDueInvoiceId: "in_1" };

describe("assertNotPaymentOverdue(tenant, sub, mode, entryPoint) - 409 PAYMENT_OVERDUE (SA-733r M1, r3 N1)", () => {
  it("no owed marker: nothing is read from Stripe and nothing is refused", async () => {
    const c = ctx();
    expect(
      await refusal(
        assertNotPaymentOverdue(
          c,
          tenant("READ_ONLY"),
          { pastDueInvoiceId: null },
          "enforced",
          "upgrade",
        ),
      ),
    ).toBeNull();
    expect(
      await refusal(assertNotPaymentOverdue(c, tenant("ACTIVE"), null, "enforced", "upgrade")),
    ).toBeNull();
    expect(c.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("marker set + invoice still open on a READ_ONLY tenant: 409 PAYMENT_OVERDUE with hosted_invoice_url, in EVERY mode", async () => {
    for (const mode of ["off", "dark", "enforced"] as const) {
      const c = ctx();
      const body = await refusal(
        assertNotPaymentOverdue(c, tenant("READ_ONLY"), marker, mode, "subscribe"),
      );
      expect(body).toMatchObject({
        code: "PAYMENT_OVERDUE",
        hosted_invoice_url: "https://pay.example.test/i/in_1",
      });
      expect(c.stripe.getInvoiceFacts).toHaveBeenCalledWith("in_1");
    }
  });

  it("every-mode refusal is keyed on status + reason: READ_ONLY payment_overdue / subscription_cancelled only", async () => {
    for (const reason of ["payment_overdue", "subscription_cancelled"]) {
      for (const mode of ["off", "dark", "enforced"] as const) {
        const body = await refusal(
          assertNotPaymentOverdue(ctx(), tenant("READ_ONLY", reason), marker, mode, "upgrade"),
        );
        expect(body?.code).toBe("PAYMENT_OVERDUE");
      }
    }
  });

  it("dark: a TRIAL tenant that carries the marker is ALLOWED (with the would-refuse line), not refused", async () => {
    const c = ctx();
    expect(
      await refusal(assertNotPaymentOverdue(c, tenant("TRIAL"), marker, "dark", "subscribe")),
    ).toBeNull();
    expect(String(c.logger.warn.mock.calls[0][0])).toContain("entryPoint=subscribe");
  });

  it("dark: READ_ONLY(trial_expired / trial_cancelled) with the marker is ALLOWED (would-refuse logged)", async () => {
    for (const reason of ["trial_expired", "trial_cancelled", null]) {
      const c = ctx();
      expect(
        await refusal(
          assertNotPaymentOverdue(c, tenant("READ_ONLY", reason), marker, "dark", "subscribe"),
        ),
      ).toBeNull();
      expect(c.logger.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("enforced: those other states follow the ACTIVE rule and are refused", async () => {
    for (const t of [tenant("TRIAL"), tenant("READ_ONLY", "trial_expired")]) {
      expect(
        (await refusal(assertNotPaymentOverdue(ctx(), t, marker, "enforced", "subscribe")))?.code,
      ).toBe("PAYMENT_OVERDUE");
    }
  });

  it("an ACTIVE tenant with an owed invoice is refused in enforced", async () => {
    const body = await refusal(
      assertNotPaymentOverdue(ctx(), tenant("ACTIVE"), marker, "enforced", "upgrade"),
    );
    expect(body?.code).toBe("PAYMENT_OVERDUE");
  });

  it("dark: an ACTIVE tenant is ALLOWED, and a structured would-refuse line names the tenant and the entry point", async () => {
    const c = ctx();
    expect(
      await refusal(
        assertNotPaymentOverdue(c, tenant("ACTIVE"), marker, "dark", "admin_plan_change"),
      ),
    ).toBeNull();
    expect(c.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(c.logger.warn.mock.calls[0][0])).toBe(
      "billing.dunning.would_refuse code=PAYMENT_OVERDUE tenant=t1 entryPoint=admin_plan_change invoice=in_1",
    );
  });

  it("dark: no log when nothing is owed (paid / void / nothing remaining) and none for a tenant with no marker", async () => {
    for (const facts of [
      { ...OPEN, status: "paid", amountPaid: 4900, amountRemaining: 0 },
      { ...OPEN, status: "void" },
      { ...OPEN, amountRemaining: 0 },
    ]) {
      const c = ctx(facts);
      expect(
        await refusal(assertNotPaymentOverdue(c, tenant("ACTIVE"), marker, "dark", "upgrade")),
      ).toBeNull();
      expect(c.logger.warn).not.toHaveBeenCalled();
    }
  });

  it("dark with an unreadable Stripe allows (nothing is enforced) and says nothing; enforced fails CLOSED", async () => {
    const dark = ctx(OPEN, true);
    expect(
      await refusal(assertNotPaymentOverdue(dark, tenant("ACTIVE"), marker, "dark", "upgrade")),
    ).toBeNull();
    expect(dark.logger.warn).not.toHaveBeenCalled();
    const body = await refusal(
      assertNotPaymentOverdue(ctx(OPEN, true), tenant("ACTIVE"), marker, "enforced", "upgrade"),
    );
    expect(body?.code).toBe("PAYMENT_STATE_UNKNOWN");
    const ro = await refusal(
      assertNotPaymentOverdue(ctx(OPEN, true), tenant("READ_ONLY"), marker, "dark", "upgrade"),
    );
    expect(ro?.code).toBe("PAYMENT_STATE_UNKNOWN");
  });

  it("off: an ACTIVE tenant is never touched (no Stripe read, no log); a READ_ONLY one is still refused", async () => {
    const c = ctx();
    expect(
      await refusal(assertNotPaymentOverdue(c, tenant("ACTIVE"), marker, "off", "upgrade")),
    ).toBeNull();
    expect(c.stripe.getInvoiceFacts).not.toHaveBeenCalled();
    expect(c.logger.warn).not.toHaveBeenCalled();
    expect(
      (await refusal(assertNotPaymentOverdue(ctx(), tenant("READ_ONLY"), marker, "off", "upgrade")))
        ?.code,
    ).toBe("PAYMENT_OVERDUE");
  });

  it("the check is the marker + Stripe, never the reason text; an UNCOLLECTIBLE invoice is a write-off, not owed", async () => {
    expect(
      await refusal(
        assertNotPaymentOverdue(
          ctx({ ...OPEN, status: "uncollectible" }),
          tenant("READ_ONLY"),
          marker,
          "enforced",
          "resume",
        ),
      ),
    ).toBeNull();
  });

  it("an invoice Stripe now shows paid / void (or nothing left) is not owed: no refusal", async () => {
    for (const facts of [
      { ...OPEN, status: "paid", amountPaid: 4900, amountRemaining: 0 },
      { ...OPEN, status: "void" },
      { ...OPEN, amountRemaining: 0 },
      { ...OPEN, status: null },
    ]) {
      expect(
        await refusal(
          assertNotPaymentOverdue(ctx(facts), tenant("READ_ONLY"), marker, "enforced", "upgrade"),
        ),
      ).toBeNull();
    }
  });
});

describe("assertTenantNotPaymentOverdue (the convenience every entry point calls)", () => {
  function deps(o: { marker?: string | null; status?: string; facts?: any }) {
    const prisma: any = {
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({ pastDueInvoiceId: o.marker ?? null }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: "t1",
          status: o.status ?? "READ_ONLY",
          readOnlyReason: (o.status ?? "READ_ONLY") === "READ_ONLY" ? "payment_overdue" : null,
        }),
      },
    };
    const c = ctx(o.facts);
    return { prisma, ...c };
  }

  it("no marker: one cheap read, the tenant is not even loaded", async () => {
    const d = deps({ marker: null });
    await assertTenantNotPaymentOverdue(d, "t1", "subscribe", "enforced");
    expect(d.prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("marker + READ_ONLY: refuses with the code, naming nothing but the code and the pay link", async () => {
    const d = deps({ marker: "in_1" });
    const body = await refusal(assertTenantNotPaymentOverdue(d, "t1", "checkout", "dark"));
    expect(body).toMatchObject({
      code: "PAYMENT_OVERDUE",
      hosted_invoice_url: OPEN.hostedInvoiceUrl,
    });
  });

  it("marker + ACTIVE in dark: allows and logs the would-refuse line with the entry point", async () => {
    const d = deps({ marker: "in_1", status: "ACTIVE" });
    expect(await refusal(assertTenantNotPaymentOverdue(d, "t1", "downgrade", "dark"))).toBeNull();
    expect(String(d.logger.warn.mock.calls[0][0])).toContain("entryPoint=downgrade");
  });

  it("a tenant that no longer exists is not refused here (the caller 404s)", async () => {
    const d = deps({ marker: "in_1" });
    d.prisma.tenant.findUnique.mockResolvedValue(null);
    expect(await refusal(assertTenantNotPaymentOverdue(d, "t1", "upgrade", "enforced"))).toBeNull();
  });
});
