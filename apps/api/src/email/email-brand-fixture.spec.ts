import { BRAND } from "../common/brand";
import { renderEmailLayout } from "./email-layout";
import { loadInvoiceModule, renderPlatformMails } from "../testing/render-platform-mail";

/**
 * T-B5 (the T45 row for mail): with the brand module mocked to a fixture, every platform mail the
 * B1 files render carries the fixture's name, logo and site and no trace of the real brand. A mail
 * that still reads a typed literal fails here, whatever the real brand.json holds. A dotted name
 * ("FIXTURE.TEST") also exposes a name that ends a sentence ("FIXTURE.TEST.").
 */
jest.mock("../common/brand", () => ({
  // not frozen: the former-name test flips `formerly`
  BRAND: {
    name: "FIXTURE.TEST",
    formerly: "Old Fixture",
    origin: "https://fixture.test",
    emailLogo: "/x/logo.png",
    emailLogoWidth: 113,
    emailLogoHeight: 32,
  },
  loadBrand: jest.fn(),
}));
jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
jest.mock("resend", () => ({ Resend: jest.fn() }));

/** Identifiers and the one host that stay typed (sender domain, until the sender moves). */
const ALLOWED = /send\.routeflow\.info/gi;

/** Outputs whose name-ending sentence is deliberately left for the wave-4 flip (see T-B4). */
const NAME_ENDS_SENTENCE = [
  "bill-trial-TRIAL_ENDING_7D",
  "bill-trial-TRIAL_ENDING_1D",
  "bill-trial-env",
  "svc-test-email",
];
const isNameEnder = (k: string) => NAME_ENDS_SENTENCE.some((p) => k.startsWith(p));

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let out: Record<string, string>;
beforeAll(async () => {
  out = await renderPlatformMails();
});

const own = (label: string) =>
  /^(verify|reset|signin-linked|new-login|password-set|notice|fragment|layout-own|branded-own|bill-|buyer-|svc-(merge|set-password|welcome|email-change|role-changed|mailbox-revoked)|demo-(booker|admin)|intake-|lifecycle-|portal-invite-own)/.test(
    label,
  );

describe("T-B5: platform mail under a fixture brand", () => {
  it("renders the whole set (a vacuous empty render would pass every check below)", () => {
    expect(Object.keys(out).length).toBeGreaterThan(100);
    expect(BRAND.name).toBe("FIXTURE.TEST");
  });

  it("no output names the real brand, outside the allow-listed sender domain", () => {
    const leaks = Object.entries(out)
      .filter(([, v]) => /route\s?flow/i.test(v.replace(ALLOWED, "")))
      .map(([k]) => k);
    expect(leaks).toEqual([]);
  });

  it("every own-look html header takes src, alt, size and the typed wordmark from the brand", () => {
    const labels = Object.keys(out).filter((k) => k.endsWith("#html") && own(k));
    expect(labels.length).toBeGreaterThan(40);
    for (const label of labels) {
      const html = out[label];
      expect(html).toContain(`src="${BRAND.origin}${BRAND.emailLogo}"`);
      expect(html).toContain(`width="${BRAND.emailLogoWidth}" height="${BRAND.emailLogoHeight}"`);
      expect(html).toContain(`alt="${BRAND.name}"`);
      expect(html).toContain(`>${BRAND.name.toLowerCase()}.</span>`);
    }
  });

  it("the former-name line shows in the own-look footer when the names differ", () => {
    expect(out["layout-own#html"]).toContain(`${BRAND.name}, formerly ${BRAND.formerly}`);
    expect(out["layout-own#text"]).toContain(`${BRAND.name}, formerly ${BRAND.formerly}`);
    // a tenant's own mail and the neutral look never carry it
    expect(out["layout-tenant#html"]).not.toContain("formerly");
    expect(out["layout-neutral#html"]).not.toContain("formerly");
  });

  it("a tenant's mail keeps the tenant's look and names the platform only in 'Sent with'", () => {
    const html = out["layout-tenant#html"];
    expect(html).toContain("Acme Foods");
    expect(html).toContain(
      `Sent with <a href="${BRAND.origin}" style="color:#536579;">${BRAND.name}</a>`,
    );
    expect(html).not.toContain(`src="${BRAND.origin}${BRAND.emailLogo}"`);
    expect(out["layout-tenant#text"]).toContain(`\nSent with ${BRAND.name}`);
    const neutral = out["layout-neutral#html"];
    expect(neutral).not.toContain(BRAND.name);
    expect(neutral).not.toContain(BRAND.origin);
  });

  it("the sender, the 'via' name and the fallback name come from the brand", () => {
    expect(out["from-env"]).toBe(`${BRAND.name} <invoices@send.routeflow.info>`);
    expect(out["from-env-bare"]).toBe(`${BRAND.name} <invoices@send.routeflow.info>`);
    expect(out["from-default"]).toBe(`${BRAND.name} <invoices@send.routeflow.info>`);
    expect(out["from-smtp-no-env"]).toBe(`${BRAND.name} <u@send.test>`);
    expect(out["from-via"]).toBe(`Acme Foods via ${BRAND.name} <invoices@send.routeflow.info>`);
    expect(out["business-name-default"]).toBe(BRAND.name);
    expect(out["svc-test-message"]).toContain(`via ${BRAND.name}'s mail service`);
  });

  it("billing links fall back to the brand's site when no WEB_URL is set", () => {
    expect(out["bill-trial-TRIAL_ENDING_7D#html"]).toContain(`${BRAND.origin}/settings/billing`);
    expect(out["bill-trial-env#html"]).toContain("https://app.test/settings/billing");
  });

  it("the platform footers and subjects carry the brand name", () => {
    expect(out["svc-set-password#html"]).toContain(`${BRAND.name} Platform`);
    expect(out["svc-merge-verify#subject"]).toBe(`Confirm account merge — ${BRAND.name}`);
    expect(out["svc-welcome-nopay#subject"]).toContain(`Welcome to ${BRAND.name}`);
    expect(out["verify#subject"]).toBe(`Verify your email to activate ${BRAND.name}`);
    expect(out["buyer-0#subject"]).toBe(`Verify your email for ${BRAND.name}`);
    expect(out["bill-rfinv-d0#subject"]).toContain(`${BRAND.name} invoice`);
  });
});

/** Every label the B1b files produce, sorted. */
const LABELS = [
  "channel-default-neutral#html",
  "channel-default-neutral#layout",
  "channel-default-neutral#subject",
  "channel-default-neutral#text",
  "channel-default-tenant#html",
  "channel-default-tenant#layout",
  "channel-default-tenant#subject",
  "channel-default-tenant#text",
  "channel-given-subject#html",
  "channel-given-subject#layout",
  "channel-given-subject#subject",
  "channel-given-subject#text",
  "demo-admin-booked#html",
  "demo-admin-booked#subject",
  "demo-admin-booked#text",
  "demo-admin-cancelled#html",
  "demo-admin-cancelled#subject",
  "demo-admin-cancelled#text",
  "demo-admin-rescheduled#html",
  "demo-admin-rescheduled#subject",
  "demo-admin-rescheduled#text",
  "demo-booker-booked#html",
  "demo-booker-booked#subject",
  "demo-booker-booked#text",
  "demo-booker-cancelled#html",
  "demo-booker-cancelled#subject",
  "demo-booker-cancelled#text",
  "demo-booker-rescheduled#html",
  "demo-booker-rescheduled#subject",
  "demo-booker-rescheduled#text",
  "demo-event#subject",
  "demo-event#text",
  "intake-link#html",
  "intake-link#subject",
  "intake-link#text",
  "intake-sentback#html",
  "intake-sentback#subject",
  "intake-sentback#text",
  "invoice-text-paid",
  "invoice-text-unpaid",
  "invoice-tree-paid",
  "invoice-tree-unpaid",
  "lifecycle-reminder#html",
  "lifecycle-reminder#subject",
  "lifecycle-reminder#text",
  "mailalert-revoked-GOOGLE-false#subject",
  "mailalert-revoked-GOOGLE-false#text",
  "mailalert-revoked-GOOGLE-false-inapp#text",
  "mailalert-revoked-GOOGLE-true#subject",
  "mailalert-revoked-GOOGLE-true#text",
  "mailalert-revoked-GOOGLE-true-inapp#text",
  "mailalert-revoked-MICROSOFT-false#subject",
  "mailalert-revoked-MICROSOFT-false#text",
  "mailalert-revoked-MICROSOFT-false-inapp#text",
  "mailalert-revoked-MICROSOFT-true#subject",
  "mailalert-revoked-MICROSOFT-true#text",
  "mailalert-revoked-MICROSOFT-true-inapp#text",
  "mailalert-throttled-GOOGLE-false#text",
  "mailalert-throttled-GOOGLE-true#text",
  "mailalert-throttled-MICROSOFT-false#text",
  "mailalert-throttled-MICROSOFT-true#text",
  "portal-invite-neutral#html",
  "portal-invite-neutral#subject",
  "portal-invite-neutral#text",
  "portal-invite-own#html",
  "portal-invite-own#subject",
  "portal-invite-own#text",
  "portal-invite-tenant#html",
  "portal-invite-tenant#subject",
  "portal-invite-tenant#text",
];

describe("lane B1b: launch-day mail and strings under a fixture brand", () => {
  it("renders exactly the B1b label set (a label that stops being produced goes red)", () => {
    const own = /^(demo-|intake-|lifecycle-|portal-invite|channel-|mailalert-|invoice-)/;
    expect(
      Object.keys(out)
        .filter((k) => own.test(k))
        .sort(),
    ).toEqual(LABELS);
  });

  it("subjects, headings and the calendar event carry the brand name", () => {
    for (const kind of ["booked", "rescheduled", "cancelled"]) {
      expect(out[`demo-booker-${kind}#subject`]).toContain(`Your ${BRAND.name} demo`);
    }
    expect(out["demo-event#subject"]).toBe(`${BRAND.name} demo — Acme Foods`);
    expect(out["demo-event#text"]).toContain(
      `${BRAND.name} product walkthrough with Sam Buyer (Acme Foods).`,
    );
    expect(out["intake-link#subject"]).toBe(`Your ${BRAND.name} order and setup questionnaire`);
    expect(out["lifecycle-reminder#subject"]).toBe(`Your ${BRAND.name} setup is waiting for you`);
    expect(out["portal-invite-tenant#subject"]).toBe(
      `Acme Foods invited you to their ${BRAND.name} buyer portal`,
    );
    expect(out["channel-default-neutral#subject"]).toBe(`Update from ${BRAND.name}`);
    expect(out["channel-given-subject#subject"]).toBe("Order ready");
    expect(out["mailalert-revoked-GOOGLE-true#subject"]).toBe(
      `${BRAND.name} can no longer send from m@acme.test`,
    );
  });

  it("the site fallback of the demo and intake links is the brand's origin", () => {
    expect(out["demo-booker-booked#html"]).toContain(`${BRAND.origin}/book-a-demo/manage#token=`);
    expect(out["intake-link#html"]).toContain(`${BRAND.origin}/onboarding#token=tok-1`);
  });

  it("a name with a special character is escaped in the html that interpolates it", async () => {
    const brand = BRAND as { name: string };
    const original = brand.name;
    brand.name = "A&B";
    try {
      const re = await renderPlatformMails();
      for (const label of ["intake-link#html", "lifecycle-reminder#html"]) {
        expect(re[label]).toContain("A&amp;B");
        expect(re[label]).not.toMatch(/A&B/);
      }
    } finally {
      brand.name = original;
    }
  });
});

describe("lane B1b: the invoice PDF under a fixture brand", () => {
  const labels = ["paid", "unpaid"];

  it("prints the brand's name, host and initials, and no trace of the real brand", () => {
    for (const l of labels) {
      const tree = out[`invoice-tree-${l}`];
      const text = out[`invoice-text-${l}`];
      expect(tree).toContain(`"author": "${BRAND.name}"`);
      expect(text).toContain(BRAND.name);
      expect(text).toContain(`Austin, TX · fixture.test`);
      expect(text).toContain(`${BRAND.name} · Austin, TX · fixture.test`);
      expect(text.split("\n")).toContain("FT");
      expect(`${tree}${text}`).not.toMatch(/route\s?flow/i);
    }
  });

  it("the clock is pinned: every invoice prints the fixed 'Generated' date", () => {
    for (const l of ["paid", "unpaid"]) {
      expect(out[`invoice-text-${l}`].split("\n")).toContain("Mar 4, 2026");
      expect(out[`invoice-tree-${l}`]).toContain("Mar 4, 2026");
    }
  });

  it("the money lines are untouched by the brand (totals print as rounded cents)", () => {
    expect(out["invoice-text-paid"]).toContain("$24.51");
    expect(out["invoice-text-paid"]).toContain("$20.01");
  });

  it("derives initials from the name: two words, a camel hump, a dotted name, a short name", () => {
    const { brandInitials } = loadInvoiceModule() as { brandInitials(n: string): string };
    expect(brandInitials("RouteFlow")).toBe("RF");
    expect(brandInitials("FIXTURE.TEST")).toBe("FT");
    expect(brandInitials("Acme Foods Inc")).toBe("AF");
    expect(brandInitials("Acme")).toBe("AC");
    expect(brandInitials("a")).toBe("A");
    expect(brandInitials("  ")).toBe("");
  });
});

describe("T-B4: the name never ends a sentence in the sign-up mail", () => {
  const signup = ["verify", "verify-resend", "reset", "reset-tenant"].flatMap((l) => [
    `${l}#html`,
    `${l}#text`,
  ]);

  const stop = () => new RegExp(`${escaped(BRAND.name)}\\.(?![a-z])`);

  it("no non-subject output has the name directly followed by a full stop, bar the named exemptions", () => {
    const labels = Object.keys(out).filter((k) => !k.endsWith("#subject") && !isNameEnder(k));
    expect(labels.length).toBeGreaterThan(100);
    expect(labels.filter((k) => stop().test(out[k]))).toEqual([]);
    expect(signup.every((k) => k in out)).toBe(true);
  });

  it("the exempted outputs still end a sentence on the name (red when reworded: delete the exemption)", () => {
    for (const prefix of NAME_ENDS_SENTENCE) {
      const labels = Object.keys(out).filter(
        (k) => k.startsWith(prefix) && !k.endsWith("#subject"),
      );
      expect(labels.length).toBeGreaterThan(0);
      expect({ prefix, still: labels.some((k) => stop().test(out[k])) }).toEqual({
        prefix,
        still: true,
      });
    }
  });

  it("no subject ends in a full stop, and the fixed part stays within 60 characters", () => {
    const subjects = Object.entries(out).filter(([k]) => k.endsWith("#subject"));
    expect(subjects.length).toBeGreaterThan(30);
    for (const [k, v] of subjects) {
      expect({ k, ends: v.endsWith(".") }).toEqual({ k, ends: false });
      // the booking subjects end in the slot's date, which is data, not the fixed part
      const fixed = k.startsWith("demo-booker-") ? v.split(" — ")[0] : v;
      expect({ k, long: fixed.length > 60 }).toEqual({ k, long: false });
    }
  });
});

describe("the former-name line", () => {
  it("is absent when the brand has no former name (both names equal)", () => {
    const brand = BRAND as { formerly: string };
    const original = brand.formerly;
    brand.formerly = BRAND.name;
    try {
      const { html, text } = renderEmailLayout({
        look: { kind: "routeflow" },
        heading: "H",
        bodyHtml: "<p>x</p>",
        bodyText: ["x"],
        footerNote: "Note.",
      });
      expect(html).toContain(BRAND.name);
      expect(html).not.toContain("formerly");
      expect(text).not.toContain("formerly");
    } finally {
      brand.formerly = original;
    }
  });
});
