import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * W-1163 — every html email goes through the shared layout (`email-layout.ts`).
 *
 * This spec lists EVERY non-spec source file that hands html to a mail transport or builds html for
 * one. A new file that does is RED until it is added here and classified:
 *   - layout:    builds its html with `email-layout` / `routeflow-mail` (the file must import one);
 *   - transport: carries html it was given to a provider; `EmailService.send` / `sendPlatform` wrap
 *                any html that skipped the layout, and log an error (pinned below);
 *   - pending:   still builds its own html. A shrink-only list: once a file imports the layout it
 *                must move to `layout`, and a file that no longer sends must leave the list.
 */

const SRC = join(__dirname, "..");

type Role = "layout" | "transport" | "pending";

const FILES: Record<string, Role> = {
  // Built on the layout (RouteFlow's own mail)
  "auth/apple-oauth.service.ts": "layout",
  "onboarding/onboarding-lifecycle.service.ts": "layout",
  "onboarding/onboarding-intake.service.ts": "layout",
  "email/owner-alert.service.ts": "layout",
  "demo-booking/demo-booking.service.ts": "layout",
  "crm/gohighlevel/gohighlevel-poll.service.ts": "layout",
  "billing/billing.service.ts": "layout",
  "billing/addon-invariant.job.ts": "layout",
  "auth/auth.service.ts": "layout",
  "auth/google-oauth.service.ts": "layout",
  "billing/billing-notification.templates.ts": "layout",
  "buyer/buyer-auth.service.ts": "layout",
  "documents/render-order-receipt.ts": "layout",
  "email/email.service.ts": "layout",
  "tenants/tenants.service.ts": "layout",
  // Hand the finished html to a provider
  "billing/billing-notification.service.ts": "transport",
  "documents/receipt-channels.ts": "transport",
  "orders/counter-sale/day-close/day-close.service.ts": "transport",
  "messaging/providers/email-channel.provider.ts": "transport",
  // PR-2: still builds its own html (RouteFlow's own alerts and tenant-to-store mail)
  "authorizations/authorization-expiry.service.ts": "pending",
  "authorizations/authorizations.service.ts": "pending",
  "buyer/buyer.service.ts": "pending",
  "customers/customer-statement-email.ts": "pending",
  "customers/customers.service.ts": "pending",
  "customers/portal-invite-email.ts": "pending",
  "messaging/providers/email-notification-template.ts": "pending",
  "messaging/staff-order-email.ts": "pending",
  "orders/counter-sale/day-close/z-report-email.ts": "pending",
  "platform-admin/platform-admin.service.ts": "pending",
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "testing" || e.name === "node_modules"
        ? []
        : walk(join(dir, e.name))
      : /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

/** The source with comments removed, so a sentence about `html:` is not mistaken for one. */
const code = (abs: string) =>
  readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SENDS = /(\.send\(|sendPlatform\(|sendMail\(|\.emails\.send\(|sendEmail\()/;
const HTML_PROP = /\bhtml\s*[:,}]/;
const USES_LAYOUT = /email-layout|routeflow-mail/;
/** A string or template literal that builds email markup. */
const BUILDS_HTML = /[`'"][^`'"]*<(p|table|tr|td|div|h[1-6]|ul|ol|li|span|strong|b|a|br|img)[\s>/]/;
/** `send({ to, ...fooMail(n) })`: a builder's html travels in a spread, with no `html:` in sight. */
const SPREAD_SEND =
  /(emailService|EmailService|this\.email\w*)[\w.]*\.send(Platform)?\(\s*\{[^}]*\.\.\./;
/** A bare markup literal assigned to `html:`, which a file built on the layout must not do. */
const BARE_HTML_PROP = /\bhtml\s*:\s*[`'"]/;

const all = walk(SRC).map((abs) => ({
  file: relative(SRC, abs).split(sep).join("/"),
  src: code(abs),
}));

/** A file is a send path when it passes an `html` property to a send, or builds it with the layout. */
const sendPaths = all.filter(
  ({ file, src }) =>
    !/^email\/email-layout\.ts$|^email\/routeflow-mail\.ts$/.test(file) &&
    ((HTML_PROP.test(src) && SENDS.test(src)) ||
      SPREAD_SEND.test(src) ||
      USES_LAYOUT.test(src) ||
      BUILDS_HTML.test(src)),
);

describe("W-1163 — every html send path is classified", () => {
  it("finds the send paths (never passes vacuously)", () => {
    expect(sendPaths.length).toBeGreaterThan(20);
  });

  it("no unclassified file hands html to a send", () => {
    const unknown = sendPaths.map((f) => f.file).filter((f) => !(f in FILES));
    expect(unknown).toEqual([]);
  });

  it("no listed file is gone or no longer sends (the list may only shrink)", () => {
    const live = new Set(sendPaths.map((f) => f.file));
    expect(Object.keys(FILES).filter((f) => !live.has(f))).toEqual([]);
  });

  it("a `layout` file imports the layout", () => {
    const bad = sendPaths
      .filter(({ file }) => FILES[file] === "layout")
      .filter(({ src }) => !USES_LAYOUT.test(src) && !/renderBrandedEmail/.test(src))
      .map((f) => f.file);
    expect(bad).toEqual([]);
  });

  it("a `layout` file never hands a bare markup literal to `html:`", () => {
    const bad = sendPaths
      .filter(({ file }) => FILES[file] === "layout")
      .filter(({ src }) => BARE_HTML_PROP.test(src))
      .map((f) => f.file);
    expect(bad).toEqual([]);
  });

  it("a `pending` file that now uses the layout must move to `layout`", () => {
    const bad = sendPaths
      .filter(({ file }) => FILES[file] === "pending")
      .filter(({ src }) => USES_LAYOUT.test(src))
      .map((f) => f.file);
    expect(bad).toEqual([]);
  });
});

describe("W-1163 — the layout stays the single, honest shell", () => {
  const svc = all.find((f) => f.file === "email/email.service.ts")!.src;

  it("both send entry points put unlayouted html through the guard", () => {
    expect(svc).toMatch(/params = await this\.ensureLayout\(params, true\)/);
    expect(svc).toMatch(/params = await this\.ensureLayout\(params, false\)/);
  });

  it("no mail carries a List-Unsubscribe header (this is transactional mail)", () => {
    const hits = all.filter(({ src }) => /list-unsubscribe/i.test(src)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it("only email-layout.ts renders the document shell", () => {
    const owners = all
      .filter(({ src }) => /<!DOCTYPE html>|<!doctype html>/i.test(src))
      .map((f) => f.file)
      .sort();
    expect(owners).toEqual(
      ["email/email-layout.ts", ...owners.filter((o) => FILES[o] === "pending")].sort(),
    );
  });
});
