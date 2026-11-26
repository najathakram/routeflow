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
  "billing/open-checkout-session.ts": 1, // openCheckoutSession: the ONE ordinary create (admin link + Pay now, W-1338)
  "billing/catchup-checkout.service.ts": 1, // CatchupCheckoutService.open (prorated catch-up session)
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

/**
 * SA-1139 R6: the embedded-Checkout keys are set in ONE place. `ui_mode` and `redirect_on_completion` appear in no
 * production file but the helper; `return_url:` only in the helper and in the Billing Portal call (a different Stripe
 * product, `StripeService.createBillingPortalSession`). A site that sets them itself would bypass `surface`.
 */
const EMBEDDED_KEYS = /\b(?:ui_mode|redirect_on_completion)\b/;
const RETURN_URL_KEY = /\breturn_url\s*:/;
const PORTAL_RETURN_URL_FILE = "billing/stripe.service.ts";

function strayEmbeddedKeys(file: string, text: string): string[] {
  const out: string[] = [];
  if (EMBEDDED_KEYS.test(text)) out.push("ui_mode/redirect_on_completion");
  if (RETURN_URL_KEY.test(text) && file !== PORTAL_RETURN_URL_FILE) out.push("return_url");
  return out;
}

describe("SA-1139 R6 - ui_mode / return_url / redirect_on_completion live only in checkout-session-params.ts", () => {
  it("no other production file under apps/api/src sets them", () => {
    // `testing/` holds the Stripe fakes: they MIRROR the response for an embedded request, they set nothing
    const bad = SCANNED.filter((s) => !s.file.startsWith("testing/"))
      .map((s) => ({
        file: s.file,
        keys: strayEmbeddedKeys(s.file, fs.readFileSync(path.join(SRC_ROOT, s.file), "utf8")),
      }))
      .filter((s) => s.keys.length > 0);
    expect(bad).toEqual([]);
  });

  it("the helper itself sets them (the pin is not vacuous)", () => {
    const text = fs.readFileSync(path.join(SRC_ROOT, HELPER_FILE), "utf8");
    expect(EMBEDDED_KEYS.test(text)).toBe(true);
    expect(RETURN_URL_KEY.test(text)).toBe(true);
    expect(/\bredirect_on_completion\b/.test(text)).toBe(true);
  });

  it("self-control: an injected ui_mode, redirect_on_completion or return_url is caught", () => {
    const f = "billing/billing.service.ts";
    expect(strayEmbeddedKeys(f, "x({ ui_mode: 'embedded_page' })")).toEqual([
      "ui_mode/redirect_on_completion",
    ]);
    expect(strayEmbeddedKeys(f, "x({ redirect_on_completion: 'never' })")).toEqual([
      "ui_mode/redirect_on_completion",
    ]);
    expect(strayEmbeddedKeys(f, "x({ return_url: u })")).toEqual(["return_url"]);
    expect(strayEmbeddedKeys(PORTAL_RETURN_URL_FILE, "x({ return_url: u })")).toEqual([]);
  });
});

/**
 * SA-1154 O11: an EMBEDDED `CheckoutStart` (the one that carries a `returnPath` the web pushes) is built in exactly one
 * place, `checkoutStartFromSession`, from the Stripe session itself. A second builder could invent a path the session
 * never returned to.
 */
const EMBEDDED_START_LITERAL = /\buiMode\s*:\s*["']embedded["']/g;

function embeddedStartBuilders(files: { file: string; text: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const n = (f.text.match(EMBEDDED_START_LITERAL) ?? []).length;
    if (n > 0) out[f.file] = n;
  }
  return out;
}

describe("SA-1154 O11 - an embedded CheckoutStart is built only by checkoutStartFromSession", () => {
  it("exactly one production site writes uiMode: 'embedded', in the helper", () => {
    const files = collect(SRC_ROOT).map((f) => ({
      file: rel(f),
      text: fs.readFileSync(f, "utf8"),
    }));
    expect(embeddedStartBuilders(files)).toEqual({
      [HELPER_FILE.split(path.sep).join("/")]: 1,
    });
  });

  it("self-control: a second builder is counted", () => {
    expect(
      embeddedStartBuilders([
        { file: "billing/x.ts", text: 'return { uiMode: "embedded", returnPath: p };' },
        { file: "billing/y.ts", text: "return { uiMode: 'hosted' };" },
      ]),
    ).toEqual({ "billing/x.ts": 1 });
  });
});

/**
 * W-1464 PR-B (SA-1538 R5, T7): every file that makes a Stripe call that opens a session, a portal, a customer or a
 * Connect grant sits behind the live-payments wall (`billing/live-payments-wall.ts`). Walks the tree like F1 above:
 * a NEW creator anywhere fails here until it is listed with the file that holds its wall call. Zero creators found is
 * a failure, not a pass. Detection is textual (whitespace tolerant); an aliased client is not detected.
 */
const STRIPE_CREATE =
  /\b(?:checkout\s*\.\s*sessions|billingPortal\s*\.\s*sessions|customers)\s*\.\s*create\s*\(|\boauth\s*\.\s*token\s*\(/g;
const WALL_CALL = /\bassert(?:Tenant)?LivePaymentsAllowed\s*\(/g;

/** creator file -> the file holding the wall call(s) in front of it, and the least number of wall calls there. */
const BEHIND_WALL: Record<string, { wall: string; atLeast: number; creates: number }> = {
  "billing/open-checkout-session.ts": {
    wall: "billing/open-checkout-session.ts",
    atLeast: 1,
    creates: 1,
  },
  "billing/catchup-checkout.service.ts": {
    wall: "billing/catchup-checkout.service.ts",
    atLeast: 1,
    creates: 1,
  },
  // the customer create and the portal create: BillingService is the only caller of each
  "billing/stripe.service.ts": { wall: "billing/billing.service.ts", atLeast: 2, creates: 2 },
  "payment-requests/provider/stripe-payment-provider.ts": {
    wall: "payment-requests/payment-requests.service.ts",
    atLeast: 1,
    creates: 1,
  },
  // the code exchange (callback) and the link start both sit in StripeConnectService
  "stripe-connect/provider/stripe-connect-oauth.provider.ts": {
    wall: "stripe-connect/stripe-connect.service.ts",
    atLeast: 2,
    creates: 1,
  },
};

const countOf = (re: RegExp, text: string) => (text.match(re) ?? []).length;
const WALL_SCAN = collect(SRC_ROOT)
  .filter((f) => !rel(f).startsWith("testing/"))
  .map((f) => {
    // comments and doc blocks name the calls without making them
    const text = fs
      .readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    return { file: rel(f), creates: countOf(STRIPE_CREATE, text), walls: countOf(WALL_CALL, text) };
  });

describe("W-1464 PR-B - every Stripe session creator sits behind the live-payments wall", () => {
  it("the creators found are exactly the named ones, with the named counts (zero found is a failure)", () => {
    const found = Object.fromEntries(
      WALL_SCAN.filter((s) => s.creates > 0).map((s) => [s.file, s.creates]),
    );
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(
      Object.fromEntries(Object.entries(BEHIND_WALL).map(([f, v]) => [f, v.creates])),
    );
  });

  it.each(Object.entries(BEHIND_WALL))(
    "%s: its wall file holds enough wall calls",
    (_creator, { wall, atLeast }) => {
      expect(WALL_SCAN.find((s) => s.file === wall)?.walls ?? 0).toBeGreaterThanOrEqual(atLeast);
    },
  );

  it("self-control: the scanner counts an injected creator and a wall call", () => {
    expect(countOf(STRIPE_CREATE, "x.billingPortal\n .sessions\n .create({})")).toBe(1);
    expect(countOf(STRIPE_CREATE, "c.oauth.token({}); c.customers.create(p)")).toBe(2);
    expect(countOf(STRIPE_CREATE, "c.checkout.sessions.expire(id)")).toBe(0);
    expect(countOf(WALL_CALL, "await assertTenantLivePaymentsAllowed(p, t);")).toBe(1);
  });
});
