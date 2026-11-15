import * as fs from "fs";
import * as path from "path";
import {
  BILLING_CANCEL_PATH,
  BILLING_PORTAL_RETURN_PATH,
  BILLING_RETURN_PATHS,
} from "@routeflow/types";
import {
  API_BILLING_CANCEL_PATH,
  API_BILLING_PORTAL_RETURN_PATH,
  API_BILLING_RETURN_PATHS,
  billingReturnUrl,
} from "./billing-return-paths";

// SA-1146 B-1 (B446): one home for every Checkout success / cancel / return address.

describe("billing return paths: the API copy equals the shared allowlist", () => {
  // Compiled API code cannot value-import @routeflow/types (no-runtime-types-import.spec), so the API keeps a
  // local copy; this spec is what keeps the two from drifting.
  it("the three return paths are the shared ones, key for key", () => {
    expect(API_BILLING_RETURN_PATHS).toEqual(BILLING_RETURN_PATHS);
  });
  it("the portal return is its own constant in both copies, and NOT a Checkout return path", () => {
    expect(API_BILLING_PORTAL_RETURN_PATH).toBe(BILLING_PORTAL_RETURN_PATH);
    expect(API_BILLING_PORTAL_RETURN_PATH).toBe("/settings/billing");
    expect(Object.values(BILLING_RETURN_PATHS)).not.toContain(BILLING_PORTAL_RETURN_PATH);
    expect(Object.values(API_BILLING_RETURN_PATHS)).not.toContain(API_BILLING_PORTAL_RETURN_PATH);
  });
  it("the cancel path is the shared one", () => {
    expect(API_BILLING_CANCEL_PATH).toBe(BILLING_CANCEL_PATH);
    expect(API_BILLING_CANCEL_PATH).toBe("/settings/billing?checkout=cancelled");
  });
  it("joins a path to the web base without a doubled slash", () => {
    expect(billingReturnUrl("https://app.test/", API_BILLING_RETURN_PATHS.plan)).toBe(
      "https://app.test/settings/billing?checkout=success",
    );
    expect(billingReturnUrl("https://app.test", API_BILLING_CANCEL_PATH)).toBe(
      "https://app.test/settings/billing?checkout=cancelled",
    );
  });
});

/** Every non-spec .ts under `dir`, recursively. */
function scan(dir: string): { f: string; text: string }[] {
  const out: { f: string; text: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scan(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
      out.push({
        f: path.relative(SRC, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
  }
  return out;
}
const SRC = path.resolve(__dirname, "..");
const sources = scan(SRC);
const HOME = "billing/billing-return-paths.ts";

describe("billing return paths: no literal Checkout return address outside the one home", () => {
  it("there are sources to scan, and the home file exists", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.f === HOME)).toBe(true);
  });

  it("no `/settings/billing?...` literal outside billing-return-paths.ts", () => {
    const hits = sources
      .filter((s) => s.f !== HOME && /\/settings\/billing\?/.test(s.text))
      .map((s) => s.f);
    expect(hits).toEqual([]);
  });

  it("no `/billing/success` or `/billing/cancel` anywhere (those were never pages)", () => {
    const hits = sources
      .filter((s) => /\/billing\/(success|cancel)\b/.test(s.text))
      .map((s) => s.f);
    expect(hits).toEqual([]);
  });
});

/**
 * SA-1146 pin (b), the KEYED form: every `success_url` / `cancel_url` / `return_url` / `successUrl` / `cancelUrl` /
 * `returnUrl` property in a non-spec billing or platform-admin source has a value that reads the constant or the
 * helper, or sits on the exact, count-pinned pass-through list below (a value only handed on from a caller that did).
 * A literal scan misses a split template, a `?`-less inline path and a joined array; this one asks what each value IS.
 * Scope: billing/ and platform-admin/ (the Checkout and portal returns of a tenant's own subscription). The
 * payment-requests/ flow (a customer paying an invoice, returning to `backTo`) is another producer, not read here.
 */
const KEYS = /\b(success_url|cancel_url|return_url|successUrl|cancelUrl|returnUrl)\b(\??)\s*:/g;
const READS_THE_HOME = /API_BILLING_RETURN_PATHS|API_BILLING_CANCEL_PATH|billingReturnUrl\(/;
const TYPE_ONLY = /^(string|string \| null|string \| undefined|string \| null \| undefined)$/;

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

/** The value text after a key's colon: up to the first top-level comma, semicolon or closing bracket. */
function valueAfter(text: string, from: number): string {
  let depth = 0;
  let tpl = false;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "`") tpl = !tpl;
    if (tpl) continue;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) break;
  }
  return text.slice(from, i).replace(/\s+/g, " ").trim();
}

/** Every key/value in `text` that is neither a type member nor a read of the home: "key | value". */
function urlPropertiesNotReadingTheHome(text: string): string[] {
  const code = stripComments(text);
  const out: string[] = [];
  for (const m of code.matchAll(KEYS)) {
    if (m[2] === "?") continue; // an optional TYPE member: `successUrl?: string`
    if (
      code
        .slice(0, m.index ?? 0)
        .trimEnd()
        .endsWith("?")
    )
      continue; // a ternary branch, not a property
    const value = valueAfter(code, (m.index ?? 0) + m[0].length);
    if (TYPE_ONLY.test(value) || READS_THE_HOME.test(value)) continue;
    out.push(`${m[1]} | ${value}`);
  }
  return out;
}

/** The pass-through list, quoted in full: "file | key | value". Count-pinned. */
const PASS_THROUGH: string[] = [
  // The caller's own override, handed on (the caller reads the home, or is the dto).
  "billing/billing.controller.ts | successUrl | dto.successUrl",
  "billing/billing.controller.ts | cancelUrl | dto.cancelUrl",
  // The catch-up Checkout: the path comes from safePath(opts.successPath, API_BILLING_RETURN_PATHS.plan) and the
  // cancel one from safePath(..., API_BILLING_CANCEL_PATH) (catchup-checkout.service.ts), then joins the web base.
  "billing/catchup-checkout.service.ts | successUrl | `${base}${successPath}`",
  "billing/catchup-checkout.service.ts | cancelUrl | `${base}${cancelPath}`",
  // The pure param builder hands its input's URLs to Stripe.
  "billing/catchup-session-params.ts | success_url | i.successUrl",
  "billing/catchup-session-params.ts | cancel_url | i.cancelUrl",
  // The terms fingerprint blanks the URLs (they are not part of the terms).
  'billing/catchup-session-terms.ts | successUrl | ""',
  'billing/catchup-session-terms.ts | cancelUrl | ""',
  // Embedded mode: success_url becomes return_url (+ session_id); cancel_url is dropped (Stripe refuses it).
  "billing/checkout-session-params.ts | cancel_url | _cancel",
  'billing/checkout-session-params.ts | return_url | success_url.includes("session_id=") ? success_url : `${success_url}${success_url.includes("?") ? "&" : "?"}${sessionParam}`',
  // The StripeService wrapper hands the caller's return URL on (its only caller reads the home).
  "billing/stripe.service.ts | return_url | params.returnUrl",
];
const PASS_THROUGH_COUNT = 11;

describe("billing return paths: the keyed pin (b)", () => {
  it("catches each spelling a literal scan missed, and the portal literal, once each", () => {
    // 1. a split template
    expect(
      urlPropertiesNotReadingTheHome(
        "x({ success_url: `${base}/settings/${page}?checkout=success` })",
      ),
    ).toHaveLength(1);
    // 2. a `?`-less inline path
    expect(
      urlPropertiesNotReadingTheHome('x({ return_url: base + "/settings/billing" })'),
    ).toHaveLength(1);
    // 3. a joined array
    expect(
      urlPropertiesNotReadingTheHome('x({ cancelUrl: [base, "settings", "billing"].join("/") })'),
    ).toHaveLength(1);
    // 4. the portal literal master carried
    expect(
      urlPropertiesNotReadingTheHome(
        "x({ returnUrl: returnUrl ?? `${baseUrl}/settings/billing` })",
      ),
    ).toHaveLength(1);
  });

  it("does not flag a read of the home, a type member or an optional type member", () => {
    expect(
      urlPropertiesNotReadingTheHome(
        "x({ success_url: billingReturnUrl(b, API_BILLING_RETURN_PATHS.plan), cancelUrl: billingReturnUrl(b, API_BILLING_CANCEL_PATH) });" +
          " interface I { successUrl: string; returnUrl?: string; cancel_url: string | null }",
      ),
    ).toEqual([]);
  });

  it("every URL property in billing/ and platform-admin/ reads the home or is on the pass-through list", () => {
    const found: string[] = [];
    for (const s of sources.filter((x) => /^(billing|platform-admin)\//.test(x.f)))
      for (const p of urlPropertiesNotReadingTheHome(s.text)) found.push(`${s.f} | ${p}`);
    expect(found.sort()).toEqual([...PASS_THROUGH].sort());
    expect(PASS_THROUGH).toHaveLength(PASS_THROUGH_COUNT);
  });
});
