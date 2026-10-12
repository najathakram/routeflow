import { Logger } from "@nestjs/common";
import {
  escapeHtml,
  trialEndingTemplate,
  downgradeScheduledTemplate,
  downgradeAppliedTemplate,
  upgradeConfirmedTemplate,
  cancelledTemplate,
  suspendedTemplate,
  checkoutPlanNotAppliedTemplate,
  billingSettingsUrl,
  dunningTemplate,
} from "./billing-notification.templates";

describe("billing-notification.templates", () => {
  describe("escapeHtml", () => {
    it("escapes the five HTML-significant characters", () => {
      expect(escapeHtml(`<script>alert("xss")</script> & 'quote'`)).toBe(
        "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &#39;quote&#39;",
      );
    });
  });

  describe("fix round (finding 4): the layout brand is always RouteFlow, never the tenant's business name", () => {
    const ORIGINAL_ENV = process.env;
    afterEach(() => {
      process.env = ORIGINAL_ENV;
    });

    it("a hostile/unusual business name never leaks into the header brand slot", () => {
      const t = trialEndingTemplate({
        businessName: "NOT RouteFlow Inc",
        adminName: "Jamie",
        milestone: "TRIAL_ENDING_7D",
        trialEndsAt: "Sep 23, 2026",
      });
      // The header/footer brand text is "RouteFlow" exactly, appearing before any
      // tenant-supplied text — the tenant's own business name still appears in the body.
      expect(t.html).toMatch(/font-weight:700;color:#ffffff;letter-spacing:-0\.5px;">RouteFlow</);
      expect(t.html).toContain("This is an automated email from RouteFlow.");
      expect(t.html).toContain("NOT RouteFlow Inc"); // still present, in the body copy
    });
  });

  describe("fix round (finding 5): the CTA base URL uses WEB_URL, not FRONTEND_URL/localhost", () => {
    const ORIGINAL_ENV = process.env;
    afterEach(() => {
      process.env = ORIGINAL_ENV;
    });

    it("uses WEB_URL when set, stripping a trailing slash", () => {
      process.env = { ...ORIGINAL_ENV, WEB_URL: "https://app.routeflow.info/" };
      expect(billingSettingsUrl()).toBe("https://app.routeflow.info/settings/billing");
    });

    it("falls back to FRONTEND_URL when WEB_URL is unset", () => {
      process.env = {
        ...ORIGINAL_ENV,
        WEB_URL: undefined,
        FRONTEND_URL: "https://legacy.routeflow.info",
      };
      expect(billingSettingsUrl()).toBe("https://legacy.routeflow.info/settings/billing");
    });

    it("falls back to the real production domain, never localhost, when NEITHER is set", () => {
      process.env = { ...ORIGINAL_ENV, WEB_URL: undefined, FRONTEND_URL: undefined };
      expect(billingSettingsUrl()).toBe("https://www.routeflow.info/settings/billing");
      expect(billingSettingsUrl()).not.toContain("localhost");
    });

    it("B809: a non-http(s) base URL never becomes the CTA's href; the email still renders (REG-B809)", () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      process.env = { ...ORIGINAL_ENV, WEB_URL: "javascript:alert(1)//" };
      const t = trialEndingTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        milestone: "TRIAL_ENDING_7D",
        trialEndsAt: "2026-09-23",
      });
      expect(t.html).not.toContain('href="javascript:');
      expect(t.html).toMatch(/<span [^>]*>Choose a plan<\/span>/);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^ctaButtonHtml: refused/));
      errorSpy.mockRestore();
    });
  });

  describe("trialEndingTemplate", () => {
    const base = {
      businessName: "Acme Retail",
      adminName: "Jamie",
      trialEndsAt: "2026-09-23",
    };

    it("7-day milestone: subject and body name the tenant and the date", () => {
      const t = trialEndingTemplate({ ...base, milestone: "TRIAL_ENDING_7D" });
      expect(t.subject).toContain("Acme Retail");
      expect(t.subject).toContain("7 days");
      expect(t.html).toContain("Hi Jamie");
      expect(t.html).toContain("2026-09-23");
      expect(t.html).toContain("/settings/billing");
      expect(t.text).toContain("Choose a plan:");
    });

    it("1-day milestone reads 'tomorrow', not '7 days'", () => {
      const t = trialEndingTemplate({ ...base, milestone: "TRIAL_ENDING_1D" });
      expect(t.subject).toContain("tomorrow");
      expect(t.subject).not.toContain("7 days");
    });

    it("expiry milestone says the trial HAS ended and the account is read-only", () => {
      const t = trialEndingTemplate({ ...base, milestone: "TRIAL_ENDING_EXPIRY" });
      expect(t.subject).toContain("has ended");
      expect(t.html).toContain("read-only");
    });

    it("escapes an XSS-shaped business name in both subject-adjacent html and text", () => {
      const t = trialEndingTemplate({
        ...base,
        businessName: `<img src=x onerror=alert(1)>`,
        milestone: "TRIAL_ENDING_7D",
      });
      expect(t.html).not.toContain("<img src=x");
      expect(t.html).toContain("&lt;img");
    });
  });

  describe("downgradeScheduledTemplate", () => {
    it("names both plans and the effective date, with a manage-plan link", () => {
      const t = downgradeScheduledTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Growth",
        toPlanName: "Starter",
        effectiveAt: "2026-10-01",
      });
      expect(t.subject).toContain("Downgrade scheduled");
      expect(t.html).toContain("Growth");
      expect(t.html).toContain("Starter");
      expect(t.html).toContain("2026-10-01");
      expect(t.html).toContain("/settings/billing");
      expect(t.text).toContain("Growth");
      expect(t.text).toContain("Starter");
    });
  });

  describe("downgradeAppliedTemplate", () => {
    it("subject and body confirm the NEW plan is now active", () => {
      const t = downgradeAppliedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Growth",
        toPlanName: "Starter",
      });
      expect(t.subject).toContain("Starter");
      expect(t.html).toContain("Growth");
      expect(t.html).toContain("Starter");
      expect(t.html).toContain("effective today");
    });
  });

  describe("upgradeConfirmedTemplate", () => {
    it("formats the SERVER-supplied proratedAmount as USD, never recomputing it", () => {
      const t = upgradeConfirmedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Starter",
        toPlanName: "Growth",
        proratedAmount: 42.5,
      });
      expect(t.subject).toContain("Upgrade confirmed");
      expect(t.html).toContain("$42.50");
      expect(t.html).toContain("Starter");
      expect(t.html).toContain("Growth");
      expect(t.text).toContain("$42.50");
    });

    it("labels the local figure an ESTIMATE — Stripe computes the real proration (SA-733 D8)", () => {
      const t = upgradeConfirmedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Starter",
        toPlanName: "Growth",
        proratedAmount: 42.5,
      });
      expect(t.html).toContain("estimate");
      expect(t.text).toContain("We estimate a prorated charge of $42.50");
      expect(t.text).toContain("shown on your next invoice");
      expect(t.html).not.toContain("has been applied");
      expect(t.text).not.toContain("has been applied");
    });

    it("formats a zero proration correctly (not blank, not omitted)", () => {
      const t = upgradeConfirmedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Starter",
        toPlanName: "Growth",
        proratedAmount: 0,
      });
      // No charge applies: the email must not claim a prorated charge of $0.00.
      expect(t.html).toContain("No prorated charge applies now");
      expect(t.text).toContain("No prorated charge applies now");
      expect(t.html).not.toContain("estimate");
    });
  });

  describe("cancelledTemplate", () => {
    it("names the tenant and offers a resubscribe link", () => {
      const t = cancelledTemplate({ businessName: "Acme Retail", adminName: "Jamie" });
      expect(t.subject).toContain("cancelled");
      expect(t.html).toContain("Acme Retail");
      expect(t.html).toContain("read-only access");
      expect(t.html).toContain("/settings/billing");
    });
  });

  describe("suspendedTemplate", () => {
    it("names the reason and offers a payment-update link", () => {
      const t = suspendedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        reason: "overdue payment",
      });
      expect(t.subject).toContain("suspended");
      expect(t.html).toContain("overdue payment");
      expect(t.html).toContain("/settings/billing");
    });

    // Lead ruling: a canceled subscription is not a payment problem - the copy says so and the CTA picks a plan.
    it("reason 'subscription canceled': says the subscription was canceled and to choose a plan, never 'payment details'", () => {
      const t = suspendedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        reason: "subscription canceled",
      });
      const sentence = "Your subscription was canceled. Choose a plan to restore access.";
      expect(t.html).toContain(sentence);
      expect(t.text).toContain(sentence);
      expect(t.html).toContain("Choose a plan");
      expect(t.html).toContain("/settings/billing");
      for (const part of [t.html, t.text]) expect(part).not.toMatch(/payment details/i);
    });

    it("any other reason keeps the payment-details copy", () => {
      const t = suspendedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        reason: "overdue payment",
      });
      expect(t.html).toContain("update your payment details to restore access");
      expect(t.text).toContain("update your payment details to restore access");
      expect(t.html).not.toContain("Choose a plan to restore access");
    });

    it("escapes a hostile reason string", () => {
      const t = suspendedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        reason: `<b>hacked</b>`,
      });
      expect(t.html).not.toContain("<b>hacked</b>");
      expect(t.html).toContain("&lt;b&gt;hacked&lt;/b&gt;");
    });
  });

  describe("checkoutPlanNotAppliedTemplate", () => {
    it("says money was received but the plan did NOT change, and escapes hostile input", () => {
      const t = checkoutPlanNotAppliedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        requestedPlanKey: "<b>SCALE</b>",
      });
      expect(t.subject).toContain("plan not changed");
      expect(t.text).toContain("NOT changed");
      expect(t.html).toContain("/settings/billing");
      expect(t.html).not.toContain("<b>SCALE</b>");
    });
  });

  describe("dunning d0 copy is keyed by whether Stripe ATTEMPTED the invoice (SA r-note 5 A1)", () => {
    const base = {
      kind: "d0" as const,
      businessName: "Acme",
      adminName: "Sam",
      payUrl: "https://pay.example.test/i/in_1",
    };

    it("attempted: 'We couldn't process your payment ... we'll try again'", () => {
      const t = dunningTemplate({ ...base, attempted: true });
      expect(t.text).toMatch(/couldn't process/i);
      expect(t.text).toMatch(/try again/i);
      expect(t.subject).toMatch(/payment failed/i);
    });

    it("never attempted: 'Your <period> invoice for $X is open - pay it here', no failure language", () => {
      const t = dunningTemplate({
        ...base,
        attempted: false,
        periodLabel: "October 2026",
        amountCents: 4900,
        currency: "usd",
      });
      expect(t.text).toContain("Your October 2026 invoice for $49.00 is open");
      expect(t.text).toMatch(/pay it here/i);
      expect(t.text).toContain(base.payUrl);
      for (const part of [t.subject, t.text]) {
        expect(part).not.toMatch(/couldn't process|unable to process|payment failed|try again/i);
      }
    });

    it("never attempted, no period or amount known: still truthful ('Your subscription invoice is open')", () => {
      const t = dunningTemplate({ ...base, attempted: false });
      expect(t.text).toContain("Your subscription invoice is open");
      expect(t.text).not.toMatch(/undefined|null|NaN/);
    });

    it("the attempted flag is absent (older callers): behaves as attempted, the long-standing copy", () => {
      expect(dunningTemplate({ ...base }).text).toMatch(/couldn't process/i);
    });
  });
});
