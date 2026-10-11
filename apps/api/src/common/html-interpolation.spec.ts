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
/**
 * B821: an entry is a reason (the key may appear ONCE) or `{ reason, count }` (exactly `count`
 * times). The count is exact both ways, so a third identical site in the same function is a new
 * hit, never silently covered by the entry for the first two.
 */
type Allowed = string | { reason: string; count: number };
const allowedCount = (v: Allowed | undefined) =>
  v === undefined ? 0 : typeof v === "string" ? 1 : v.count;
/** Keys seen more often than their entry allows, as `key | xN, allowed xM`. */
function overAllowed(keys: readonly string[], entries: Record<string, Allowed> = {}): string[] {
  const tally = new Map<string, number>();
  for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);
  return [...tally]
    .filter(([key, n]) => n > allowedCount(entries[key]))
    .map(([key, n]) => `${key} | x${n}, allowed x${allowedCount(entries[key])}`);
}
/** Entries seen LESS often than they allow (a site was fixed: lower or drop the entry). */
function underAllowed(keys: readonly string[], entries: Record<string, Allowed> = {}): string[] {
  return Object.entries(entries)
    .map(([key, v]) => [key, keys.filter((k) => k === key).length, allowedCount(v)] as const)
    .filter(([, n, allowed]) => n < allowed)
    .map(([key, n, allowed]) => `${key} | x${n}, allowed x${allowed}`);
}
const ALLOWED: Record<string, Record<string, Allowed>> = {
  "email/email.service.ts": {
    "sendUnrecorded :: params.html": { reason: TRANSPORT, count: 5 },
    "sendPlatform :: params.html": { reason: TRANSPORT, count: 2 },
    "buildInvoiceEmail :: freeUnits": NUMBER,
    "sendSetPasswordEmail :: params.expiryHours": NUMBER,
    "sendTenantWelcomeEmail :: params.expiryHours": NUMBER,
    "sendTenantWelcomeEmail :: params.trialDays": NUMBER,
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
    "deliverToAdmins :: tmpl.html":
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
    "portalInviteEmailHtml :: href url": { reason: ENV_LINK, count: 2 },
  },
  "demo-booking/demo-booking.service.ts": {
    "buildBookingEmail :: href escapeHtml(booking.meetUrl)":
      "the Meet link Google Calendar returned for the booking, never user input",
    "buildBookingEmail :: href escapeHtml(baseUrl)": ENV_LINK,
    "buildBookingEmail :: href escapeHtml(manageUrl)": ENV_LINK,
  },
  "tenants/tenants.service.ts": {
    "register :: href escapeHtml(verifyUrl)": { reason: ENV_LINK, count: 2 },
    "performResend :: href escapeHtml(verifyUrl)": ENV_LINK,
  },
  "documents/receipt.service.ts": {
    "send :: html":
      "built in documents/render-order-receipt.ts (every dynamic value escapeHtml'd), which this guard scans (0 hits)",
  },
  "documents/render-order-receipt.ts": {
    'renderOrderReceipt :: tenantHeaderHtml(name || "Receipt")':
      "tenantHeaderHtml escapes the name (email/email.service.ts, which this guard scans)",
    "renderOrderReceipt :: html":
      "the shell renderBrandedEmail returns (email/email.service.ts): its heading and footer note are escaped there, the body is built and scanned here",
  },
  "customers/customers.service.ts": {
    "sendPortalInvite :: portalInviteEmailHtml(sellerName, inviteUrl)":
      "built in customers/portal-invite-email.ts, which this guard scans (0 hits)",
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

  // ─── B821: the gaps Opus found in the first version ─────────────────────────────────────────

  it("B821: the href rule holds for string concatenation and a prefix held in a const", () => {
    expect(
      keys("function f(u: string) { send({ html: '<a href=\"' + u + '\">x</a>' }); }"),
    ).toEqual(["f :: u", "f :: href u"]);
    const prefixed = `function f(u: string) {
      const open = '<a href="';
      return \`\${open}\${u}">x</a>\`;
    }`;
    expect(keys(prefixed)).toEqual(["f :: u", "f :: href u"]);
  });

  it.each([
    ['href=" ${u}"', "leading space inside the quote"],
    ["href='${u}'", "single quotes"],
    ['HREF="${u}"', "upper case"],
    ['href = "${u}"', "spaces around ="],
    ["href=${u}", "unquoted"],
    ['xlink:href="${u}"', "xlink:href"],
  ])("B821: %s (%s) is an href", (attr) => {
    const code = `function f(u: string) { return \`<a ${attr}>x</a>\`; }`;
    expect(keys(code)).toContain("f :: href u");
  });

  it("B821: an href from a safeLinkHref let that is reassigned is flagged", () => {
    const code = `function f(u: string) {
      let h = safeLinkHref(u, "f");
      h = u;
      return \`<a href="\${escapeHtml(h)}">x</a>\`;
    }`;
    expect(keys(code)).toContain("f :: href escapeHtml(h)");
  });

  it.each([
    ["({ v } = o);", "object destructuring"],
    ["[v] = arr;", "array destructuring"],
    ["for (v of arr) {}", "for...of"],
    ["for (v in o) {}", "for...in"],
    ["(v) = raw;", "a parenthesized left side"],
  ])("B821: a let rewritten by %s (%s) is never safe", (stmt) => {
    const code = `function f(raw: string, o: any, arr: string[]) {
      let v = escapeHtml("ok");
      ${stmt}
      return \`<p>\${v}</p>\`;
    }`;
    expect(keys(code)).toEqual(["f :: v"]);
  });

  it("B821: a var declared again in the same function is never safe", () => {
    const code = `function f(raw: string) {
      var v = escapeHtml("ok");
      var v = raw;
      return \`<p>\${v}</p>\`;
    }`;
    expect(keys(code)).toContain("f :: v");
  });

  it("B821: two identical raw values count as two hits (keyed by position, not line)", () => {
    expect(keys("function f(n: string) { return `<p>${n}${n}</p>`; }")).toEqual([
      "f :: n",
      "f :: n",
    ]);
  });

  it("B821: an allow-list entry covers exactly its count, so a third identical site is caught", () => {
    const entries: Record<string, Allowed> = { "f :: n": { reason: "r", count: 2 } };
    expect(overAllowed(["f :: n", "f :: n"], entries)).toEqual([]);
    expect(overAllowed(["f :: n", "f :: n", "f :: n"], entries)).toEqual([
      "f :: n | x3, allowed x2",
    ]);
    expect(overAllowed(["f :: n", "f :: n"], { "f :: n": "r" })).toEqual([
      "f :: n | x2, allowed x1",
    ]);
  });

  // ─── B821 round 2 (Opus, #1327 at 96c23c45) ───────────────────────────────────────────────

  it("B821r2: a concat href held in a const, or returned from a function, is flagged", () => {
    const heldInConst = `function f(u: string) {
      const a = '<a href="' + escapeHtml(u) + '">x</a>';
      return \`<p>\${a}</p>\`;
    }`;
    expect(keys(heldInConst)).toContain("f :: href escapeHtml(u)");
    const returned = `function link(u: string) { return '<a href="' + escapeHtml(u) + '">x</a>'; }
      function g(u: string) { send({ html: link(u) }); }`;
    expect(keys(returned)).toContain("link :: href escapeHtml(u)");
  });

  it.each(["&#32;", "&#x20;", "&Tab;", "&NewLine;", "&#9;", "&#10;", "&#13;", "&#0032;"])(
    "B821r2: entity-encoded whitespace %s after the quote is still an href",
    (entity) => {
      const code = `function f(u: string) { return \`<a href="${entity}\${escapeHtml(u)}">x</a>\`; }`;
      expect(keys(code)).toContain("f :: href escapeHtml(u)");
    },
  );

  it.each([
    ["v++;", "postfix ++"],
    ["--v;", "prefix --"],
    ['[v = "d"] = arr;', "a destructuring default"],
  ])("B821r2: a let rewritten by %s (%s) is never safe", (stmt) => {
    const code = `function f(raw: string, arr: any[]) {
      let v: any = escapeHtml("ok");
      ${stmt}
      return \`<p>\${v}</p>\`;
    }`;
    expect(keys(code)).toEqual(["f :: v"]);
  });

  it("B821r2: a reassigned prefix opens an href when ANY value it is given does", () => {
    const code = `function f(u: string) {
      let open = "<b>";
      open = '<a href="';
      return \`\${open}\${escapeHtml(u)}">x</a>\`;
    }`;
    expect(keys(code)).toContain("f :: href escapeHtml(u)");
  });

  it("B821r2: an entry seen LESS often than its count is stale (the list may only shrink)", () => {
    const entries: Record<string, Allowed> = { "f :: n": { reason: "r", count: 2 }, "g :: m": "r" };
    expect(underAllowed(["f :: n", "f :: n", "g :: m"], entries)).toEqual([]);
    expect(underAllowed(["f :: n", "g :: m"], entries)).toEqual(["f :: n | x1, allowed x2"]);
    expect(underAllowed(["f :: n", "f :: n"], entries)).toEqual(["g :: m | x0, allowed x1"]);
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
      for (const o of overAllowed(keys, ALLOWED[file])) offenders.push(`${file} | ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still matches a hit (each list may only shrink)", () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(ALLOWED)) {
      for (const u of underAllowed(hitsByFile.get(file) ?? [], entries))
        stale.push(`${file} | ${u}`);
    }
    expect(stale).toEqual([]);
  });
});
