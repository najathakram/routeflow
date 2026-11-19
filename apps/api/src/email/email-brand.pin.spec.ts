import { readFileSync } from "fs";
import { join } from "path";

/**
 * T-B6 (the T35 row for the API): the files that build platform mail name the brand only through
 * `common/brand.ts`. Comments count too (L-364): a comment that names the old brand is the next
 * rename's search hit. Only exact identifiers that must keep their spelling are removed first
 * (the look kind, the builder names and module path, workspace imports, the sender domain until
 * the sender moves).
 */
const SRC = join(__dirname, "..");

/** B1's and B1b's source files, relative to `apps/api/src`. */
const FILES = [
  "common/brand.ts",
  "email/email-layout.ts",
  "email/routeflow-mail.ts",
  "email/email.service.ts",
  "billing/billing-notification.templates.ts",
  "buyer/buyer-auth.service.ts",
  // lane B1b: what a new customer of the site receives on launch day, and the invoice document
  "demo-booking/demo-booking.service.ts",
  "onboarding/onboarding-intake.service.ts",
  "onboarding/onboarding-lifecycle.service.ts",
  "customers/portal-invite-email.ts",
  "messaging/providers/email-channel.provider.ts",
  "email/mailbox/mailbox-alert.copy.ts",
  "bookkeeping/invoice-template.tsx",
];

/** Identifiers that are never renamed (program B app allow-list) and the one typed host. */
const ALLOWED: RegExp[] = [
  /@routeflow\/[a-z-]+/g,
  /\brouteflow(?:Notice|FragmentMail)\b/g,
  /\/routeflow-mail/g,
  /\bkind(?::\s*|\s*===\s*)["']routeflow["']/g,
  /send\.routeflow\.info/g,
];

const BRAND_SHAPED = /route\s?flow|rovio|xrov|routeflow\.info|hello@/i;

const stripAllowed = (source: string) => ALLOWED.reduce((s, re) => s.replace(re, ""), source);

describe("T-B6: no typed brand in the platform-mail source files", () => {
  it.each(FILES)("%s has no brand-shaped literal or comment", (file) => {
    const lines = stripAllowed(readFileSync(join(SRC, file), "utf8")).split("\n");
    const hits = lines
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter(({ text }) => BRAND_SHAPED.test(text));
    expect(hits).toEqual([]);
  });

  it("the allow-list does not hide the sender host's neighbours", () => {
    expect(stripAllowed("a routeflow.info b")).toMatch(BRAND_SHAPED);
    expect(stripAllowed("https://www.routeflow.info/x")).toMatch(BRAND_SHAPED);
    expect(stripAllowed("invoices@send.routeflow.info")).not.toMatch(BRAND_SHAPED);
    expect(stripAllowed(`import x from "@routeflow/pricing";`)).not.toMatch(BRAND_SHAPED);
    expect(stripAllowed("Sent with RouteFlow")).toMatch(BRAND_SHAPED);
  });
});
