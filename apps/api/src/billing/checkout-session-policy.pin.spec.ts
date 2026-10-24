/**
 * F1 structural pin: every platform Checkout Session create in `apps/api/src` hands its params through
 * `withCheckoutPolicy(` (Managed Payments off, no automatic tax - owner ruling 2026-10-06), so no create call
 * can skip it. Walks the tree instead of asserting per file: a NEW `checkout.sessions.create(` anywhere
 * fails here until it is wrapped or named in EXCLUDED with a reason.
 *
 * Detection is textual: `checkout . sessions . create (` (whitespace tolerant) and a raw `/checkout/sessions`
 * endpoint string. An aliased client (`const c = x.checkout; c.sessions.create(`) is NOT detected; the
 * behaviour specs of each site (managed_payments in the captured create params) are the second net.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const HELPER_FILE = path.join("billing", "checkout-session-params.ts");

/** Sites wrapped via the helper: file (relative to src, posix) -> exact number of create calls. */
const WRAPPED: Record<string, number> = {
  "billing/billing.service.ts": 1, // BillingService.createCheckoutSession (inline price_data, anchored)
  "billing/catchup-checkout.service.ts": 1, // CatchupCheckoutService.open (prorated catch-up session)
  "billing/stripe.service.ts": 1, // StripeService.createCheckoutSession (pre-created price subscription)
};

/**
 * Named exclusions: file -> reason. Each MUST still contain an unwrapped create (a stale entry fails).
 */
const EXCLUDED: Record<string, string> = {
  "payment-requests/provider/stripe-payment-provider.ts":
    "Stripe Connect one-off `mode: payment` sessions created ON the tenant's connected account " +
    "(`{ stripeAccount }`). Managed Payments is a platform-account merchant-of-record feature for the " +
    "platform's own subscription checkout; it does not apply to a connected account's direct charge, and " +
    "this call is not part of the F1 failure (platform catch-up). The param is deliberately NOT sent: it " +
    "was not verified against a connected-account create. Revisit only with Stripe evidence.",
};

const CREATE_CALL = /checkout\s*\.\s*sessions\s*\.\s*create\s*\(/g;
const RAW_ENDPOINT = /\/v1\/checkout\/sessions|["'`]\/?checkout\/sessions["'`]/;

interface Finding {
  kind: "unwrapped-create" | "raw-endpoint";
  index: number;
}

/** First argument text of the call whose `(` is at `open`; skips string / template literals. */
function firstArgument(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    } else if (c === "," && depth === 1) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every create call that does NOT start its argument with `withCheckoutPolicy(`, plus raw endpoints. */
function scan(text: string): { wrapped: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let wrapped = 0;
  for (const m of text.matchAll(CREATE_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (/^\s*withCheckoutPolicy\s*\(/.test(firstArgument(text, open))) wrapped++;
    else findings.push({ kind: "unwrapped-create", index: m.index ?? 0 });
  }
  const raw = RAW_ENDPOINT.exec(text);
  if (raw) findings.push({ kind: "raw-endpoint", index: raw.index });
  return { wrapped, findings };
}

function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") collect(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");
const SCANNED = collect(SRC_ROOT)
  .filter((f) => rel(f) !== HELPER_FILE.split(path.sep).join("/"))
  .map((f) => ({ file: rel(f), ...scan(fs.readFileSync(f, "utf8")) }));

describe("F1 - every Checkout Session create goes through withCheckoutPolicy", () => {
  it("scans the real tree (guards against an empty walk)", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  it("no unwrapped create or raw checkout-sessions endpoint outside the named exclusions", () => {
    const bad = SCANNED.filter((s) => s.findings.length > 0 && !(s.file in EXCLUDED)).map(
      (s) => `${s.file}: ${s.findings.map((f) => f.kind).join(", ")}`,
    );
    expect(bad).toEqual([]);
  });

  it("the wrapped sites are exactly the named ones, with the named counts", () => {
    const actual = Object.fromEntries(
      SCANNED.filter((s) => s.wrapped > 0).map((s) => [s.file, s.wrapped]),
    );
    expect(actual).toEqual(WRAPPED);
  });

  it("a wrapped site has no unwrapped create beside its wrapped one", () => {
    for (const file of Object.keys(WRAPPED)) {
      expect(SCANNED.find((s) => s.file === file)?.findings).toEqual([]);
    }
  });

  it.each(Object.entries(EXCLUDED))("exclusion %s is live and carries a reason", (file, reason) => {
    expect(reason.length).toBeGreaterThan(40);
    expect(SCANNED.find((s) => s.file === file)?.findings.length).toBeGreaterThan(0);
  });
});

describe("F1 pin self-controls (the scanner itself catches a skipped helper)", () => {
  it("passes a create whose argument is withCheckoutPolicy(...)", () => {
    const ok =
      "await this.client.checkout.sessions.create(withCheckoutPolicy({ mode: 'payment' }), { a: 1 });";
    expect(scan(ok)).toEqual({ wrapped: 1, findings: [] });
    const spaced =
      "x.checkout\n  .sessions\n  .create(\n    withCheckoutPolicy(params),\n    { idempotencyKey: k },\n  )";
    expect(scan(spaced).wrapped).toBe(1);
  });

  it("fails an injected create({ without the helper", () => {
    const bad =
      "const s = await this.stripe.client.checkout.sessions.create({ mode: 'subscription' });";
    expect(scan(bad).findings.map((f) => f.kind)).toEqual(["unwrapped-create"]);
  });

  it("fails a create that only mentions the helper deeper in its params", () => {
    const sneaky =
      "x.checkout.sessions.create({ mode: 'payment', metadata: { n: 'withCheckoutPolicy(' } });";
    expect(scan(sneaky).findings.map((f) => f.kind)).toEqual(["unwrapped-create"]);
    const params = "x.checkout.sessions.create(params, { idempotencyKey: withCheckoutPolicy(k) });";
    expect(scan(params).findings.map((f) => f.kind)).toEqual(["unwrapped-create"]);
  });

  it("fails a raw /v1/checkout/sessions fetch", () => {
    const raw = 'await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST" });';
    expect(scan(raw).findings.map((f) => f.kind)).toEqual(["raw-endpoint"]);
  });

  it("an unlisted file with an unwrapped create is reported by the tree rule (not excluded)", () => {
    const injected = { file: "billing/new-thing.ts", ...scan("c.checkout.sessions.create({});") };
    expect(injected.findings.length > 0 && !(injected.file in EXCLUDED)).toBe(true);
  });
});
