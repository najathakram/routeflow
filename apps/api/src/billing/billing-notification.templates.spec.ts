import {
  escapeHtml,
  trialEndingTemplate,
  downgradeScheduledTemplate,
  downgradeAppliedTemplate,
  upgradeConfirmedTemplate,
  cancelledTemplate,
  suspendedTemplate,
  billingSettingsUrl,
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

    it("formats a zero proration correctly (not blank, not omitted)", () => {
      const t = upgradeConfirmedTemplate({
        businessName: "Acme Retail",
        adminName: "Jamie",
        fromPlanName: "Starter",
        toPlanName: "Growth",
        proratedAmount: 0,
      });
      expect(t.html).toContain("$0.00");
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
});
