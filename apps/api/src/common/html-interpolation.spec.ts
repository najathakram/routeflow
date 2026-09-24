import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { scanHtmlInterpolations } from "./testing/html-interpolation-scan";

/**
 * B809 (REG-B809) — no api source file puts an unescaped dynamic value into email HTML.
 * Generalizes B807's email.service guard to every file, with the Opus / SA-123 fixes:
 * entries are keyed by LOCATION (`enclosingFunction :: expression`), and values are followed
 * through consts, parameters, call sites and tag-less templates into the HTML they reach (see
 * testing/html-interpolation-scan.ts).
 *
 * ALLOWED holds what the scanner cannot prove, one list PER FILE, each entry with a reason.
 * Every list may only SHRINK: a new raw value fails, and so does an entry that no longer
 * matches.
 */
const TRANSPORT =
  "transport: forwards html a caller built, and every caller is scanned at its source";
const NUMBER = "a number: renders as digits, cannot carry markup";
/** SA-127: an href not built by safeLinkHref — the server's own URL, never tenant input. */
const ENV_LINK = "env base + server token";
const ALLOWED: Record<string, Record<string, string>> = {
  "email/email.service.ts": {
    "send :: params.html": TRANSPORT,
    "sendPlatform :: params.html": TRANSPORT,
    "buildInvoiceEmail :: freeUnits": NUMBER,
    "sendSetPasswordEmail :: params.expiryHours": NUMBER,
    "buildLowStockDigestEmail :: it.currentStock": NUMBER,
    "buildLowStockDigestEmail :: it.reorderPoint": NUMBER,
    "buildLowStockDigestEmail :: overflow": NUMBER,
    "buildLowStockDigestEmail :: params.items.length": NUMBER,
    "buildInvoiceEmail :: href escapeHtml(params.pdfUrl)": "the server's own PDF link",
  },
  "email/mailbox/mailbox-send.service.ts": {
    "buildMimeBuffer :: opts.html": TRANSPORT,
    "trySend :: params.html": TRANSPORT,
  },
  "billing/billing-notification.service.ts": {
    "sendIfClaimed :: tmpl.html":
      "built in billing-notification.templates.ts, which this guard scans (0 hits)",
  },
  "messaging/providers/email-channel.provider.ts": {
    "send :: html": "built by buildNotificationEmailHtml, which this guard scans (0 hits)",
  },
  "auth/auth.service.ts": {
    "requestPasswordReset :: href escapeHtml(resetUrl)": ENV_LINK,
  },
  "buyer/buyer-auth.service.ts": {
    "issueVerificationEmail :: href escapeHtml(verifyUrl)": ENV_LINK,
    "requestPasswordReset :: href escapeHtml(resetUrl)": ENV_LINK,
  },
  "customers/portal-invite-email.ts": {
    "portalInviteEmailHtml :: href url": ENV_LINK,
  },
  "demo-booking/demo-booking.service.ts": {
    "buildBookingEmail :: href escapeHtml(booking.meetUrl)":
      "the Meet link Google Calendar returned for the booking, never user input",
    "buildBookingEmail :: href escapeHtml(baseUrl)": ENV_LINK,
    "buildBookingEmail :: href escapeHtml(manageUrl)": ENV_LINK,
  },
  "tenants/tenants.service.ts": {
    "register :: href escapeHtml(verifyUrl)": ENV_LINK,
    "resendVerification :: href escapeHtml(verifyUrl)": ENV_LINK,
  },
  "customers/customers.service.ts": {
    "sendPortalInvite :: portalInviteEmailHtml(sellerName, inviteUrl)":
      "built in customers/portal-invite-email.ts, which this guard scans (0 hits)",
  },
  "platform-admin/platform-admin.service.ts": {
    "createTenant :: trialDays": NUMBER,
    "createTenant :: href escapeHtml(checkoutUrl)": "the Stripe checkout URL the API created",
  },
};

const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "testing"
        ? []
        : walk(join(dir, e.name))
      : /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

const hitsByFile = new Map<string, string[]>();
for (const abs of walk(SRC)) {
  const code = readFileSync(abs, "utf8");
  if (!/<[a-zA-Z!/]|html/i.test(code)) continue;
  const keys = scanHtmlInterpolations(code).map((h) => h.key);
  if (keys.length > 0) hitsByFile.set(relative(SRC, abs).split(sep).join("/"), keys);
}

describe("B809 — the HTML interpolation scanner (never passes vacuously)", () => {
  const keys = (code: string) => scanHtmlInterpolations(code).map((h) => h.key);

  it("flags a raw value in a tagged template, keyed by its enclosing function", () => {
    expect(keys("function f(n: string) { return `<p>${n}</p>`; }")).toEqual(["f :: n"]);
  });

  it("accepts escaped, literal, currency-formatted and ternary-of-safe values", () => {
    const code = `function f(n: string, ok: boolean) {
      const fmt = (x: number) => new Intl.NumberFormat("en-US").format(x);
      return \`<p>\${escapeHtml(n)} \${fmt(3)} \${ok ? "a" : "b"} \${1}</p>\`;
    }`;
    expect(keys(code)).toEqual([]);
  });

  it("follows a const into a tag-less template that reaches HTML", () => {
    const code = "function f(who: string) { const b = `${who} said`; return `<p>${b}</p>`; }";
    // `who` is a parameter of f with no call site in the file, so it cannot be proven safe.
    expect(keys(code)).toEqual(["f :: who"]);
  });

  it("follows a parameter to EVERY call site (a raw caller is caught, a safe one is not)", () => {
    const wrap = "function wrap(inner: string) { return `<div>${inner}</div>`; }";
    expect(keys(`${wrap} function a(x: string) { return wrap(escapeHtml(x)); }`)).toEqual([]);
    expect(keys(`${wrap} function a(x: string) { return wrap(\`Hi \${x}\`); }`)).toEqual([
      "a :: x",
    ]);
  });

  it("follows params.x into each call's object argument", () => {
    const shell =
      "function shell(p: { bodyHtml: string }) { return `<main>${p.bodyHtml}</main>`; }";
    expect(
      keys(`${shell} function a(n: string) { return shell({ bodyHtml: \`<b>\${n}</b>\` }); }`),
    ).toEqual(["a :: n"]);
  });

  it("treats an html: property as a sink, even with no template", () => {
    expect(keys("function f(x: string) { send({ html: '<p>' + x }); }")).toEqual(["f :: x"]);
  });

  it("follows a destructured { html } from a same-file builder, including this.method calls", () => {
    const build = "function build(n: string) { return { html: `<p>${n}</p>`, text: n }; }";
    const call = (arg: string) =>
      `${build} function a(n: string) { const { html } = build(${arg}); send({ html }); }`;
    expect(keys(call("escapeHtml(n)"))).toEqual([]);
    // Reported where the raw value ENTERS the HTML: build's parameter.
    expect(keys(call("n"))).toEqual(["build :: n"]);
    // The same through a class method called as this.build(…).
    const cls = (arg: string) =>
      `class S { build(n: string) { return { html: \`<p>\${n}</p>\` }; }
         a(n: string) { const built = this.build(${arg}); send({ html: built.html }); } }`;
    expect(keys(cls("escapeHtml(n)"))).toEqual([]);
    expect(keys(cls("n"))).toEqual(["build :: n"]);
  });

  it("ignores a bare `<` that is not an email tag (an error message naming `<area>.<method>`)", () => {
    expect(
      keys('function f(n: string) { throw new Error(`bad "${n}" (expected "<area>.<method>")`); }'),
    ).toEqual([]);
  });

  it("SA-127: an href is accepted only from safeLinkHref; a raw or merely escaped one is flagged", () => {
    expect(keys('function f(u: string) { return `<a href="${u}">x</a>`; }')).toEqual([
      "f :: u",
      "f :: href u",
    ]);
    expect(keys('function f(u: string) { return `<a href="${escapeHtml(u)}">x</a>`; }')).toEqual([
      "f :: href escapeHtml(u)",
    ]);
    const guarded = `function f(u: string) {
      const href = safeLinkHref(u, "f");
      return \`<a href="\${escapeHtml(href)}">x</a>\`;
    }`;
    expect(keys(guarded)).toEqual([]);
  });

  it("Opus: a reassigned let is never safe, even when its initializer was", () => {
    const code = `function f(raw: string) {
      let v = escapeHtml("ok");
      v += raw;
      return \`<p>\${v}</p>\`;
    }`;
    expect(keys(code)).toEqual(["f :: v"]);
    // The same binding without a reassignment stays safe.
    expect(keys('function f() { let v = escapeHtml("ok"); return `<p>${v}</p>`; }')).toEqual([]);
  });

  it("keys two uses of the same text in different functions separately", () => {
    const code =
      "function a(n: string) { return `<p>${n}</p>`; } function b(n: string) { return `<p>${n}</p>`; }";
    expect(keys(code)).toEqual(["a :: n", "b :: n"]);
  });
});

describe("B809 — no unescaped value reaches email HTML in any api file (REG-B809)", () => {
  it("every hit in every file is on that file's reasoned allow-list", () => {
    const offenders: string[] = [];
    for (const [file, keys] of hitsByFile) {
      for (const key of keys)
        if (!(key in (ALLOWED[file] ?? {}))) offenders.push(`${file} | ${key}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still matches a hit (each list may only shrink)", () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(ALLOWED)) {
      const keys = new Set(hitsByFile.get(file) ?? []);
      for (const key of Object.keys(entries)) if (!keys.has(key)) stale.push(`${file} | ${key}`);
    }
    expect(stale).toEqual([]);
  });
});
