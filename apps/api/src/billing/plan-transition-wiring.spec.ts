/**
 * Meta-spec for Lane B A2 step b: every code path that WRITES a tenant's plan is either wired to
 * `PlanTransitionConfigService.onPlanChange` (downgrade → snapshot the feature config, upgrade →
 * restore it) or carries a named reason it is exempt. A new file that starts writing
 * `currentPlan:` therefore fails this spec until someone decides which it is — the same
 * "checks must be able to check" shape as `no-bare-cron.spec.ts`.
 *
 * What counts as a plan write: a non-spec `.ts` file with a `currentPlan:` data property (a
 * `select: { currentPlan: true }` is a read and is ignored). Match the wiring by call count so a
 * function that gains or loses its hook call is caught, not just a file.
 */
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
const files = walk(SRC).map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));

/** file → how many `onPlanChange(` calls it must contain. */
const WIRED: Record<string, number> = {
  // subscribe() and upgrade()
  "billing/subscription-mutation.service.ts": 2,
  // applyScheduledDowngrades()
  "billing/billing-cron.service.ts": 1,
  // updatePlan() instant branch and activateManualSubscription(). NOT wired, by design (they
  // emit PLAN_CHANGED or write `currentPlan` but move no rank): the scheduled-downgrade branch of
  // updatePlan() (the cron applies it later), setPriceOverride, updatePlanPrices, updateStatus's
  // NULL-planKey fill-in, and createTenant (no prior plan).
  "platform-admin/platform-admin.service.ts": 2,
  // Stripe onCheckoutCompleted (B593) — the ONE wired write in this file. The other `currentPlan:`
  // there is ensureStripeCustomer's upsert, which copies Tenant.plan and never sets `planKey`, so
  // no rank moves; the status moves (cancel/CANCELLED, past-due) touch no plan either.
  "billing/billing.service.ts": 1,
};

/** Plan-writing files that are deliberately NOT wired, each with the reason. */
const EXEMPT: Record<string, string> = {
  "tenants/tenants.service.ts":
    "register(): creates the tenant + subscription at STARTER — no prior plan to snapshot",
  "customers/customers.service.ts":
    "grace-window stub upsert: planKey stays null and no rank moves",
};

const hookCalls = (text: string) => (text.match(/\.onPlanChange\(/g) ?? []).length;

describe("plan-transition wiring (A2b meta-spec)", () => {
  it("every file that writes a plan is wired or exempt (a new plan writer fails here)", () => {
    const writers = files
      .filter((f) => /\bcurrentPlan:\s*(?!true\b)/.test(f.text))
      .map((f) => f.file)
      .sort();
    const known = [...Object.keys(WIRED), ...Object.keys(EXEMPT)].sort();
    expect(writers).toEqual(known);
  });

  it("the hook is called exactly where it is wired — no more, no fewer", () => {
    const actual: Record<string, number> = {};
    for (const f of files) {
      if (f.file === "billing/plan-transition-config.service.ts") continue; // the definition
      const n = hookCalls(f.text);
      if (n > 0) actual[f.file] = n;
    }
    expect(actual).toEqual(WIRED);
  });

  it("each wired site calls prepare() before opening its transaction", () => {
    for (const file of Object.keys(WIRED)) {
      const text = files.find((f) => f.file === file)!.text;
      const prepares = (text.match(/planTransition\.prepare\(/g) ?? []).length;
      expect(prepares).toBe(WIRED[file]);
    }
  });

  it("no exempt entry has gone stale (each still exists and still writes a plan)", () => {
    for (const file of Object.keys(EXEMPT)) {
      const f = files.find((x) => x.file === file);
      expect(f).toBeDefined();
      expect(/\bcurrentPlan:\s*(?!true\b)/.test(f!.text)).toBe(true);
    }
  });
});
