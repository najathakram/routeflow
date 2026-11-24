import * as fs from "fs";
import * as path from "path";

/**
 * W-1338 / SA-1267 PR-1 inventory pin: the ONE class "two sessions, or a stale session, for one business" is closed by
 * two entry points of `open-checkout-session.ts`. Every call site is listed here; a new one fails until named.
 *  - `openCheckoutSession(`: the only way an ordinary subscription Checkout Session is created (admin link + Pay now).
 *  - `expireOpenCheckoutSessions(`: every plan or price writer, before it commits (completion writes planKey from the session).
 */
const SRC = path.resolve(__dirname, "..");

const OPEN: Record<string, number> = {
  "billing/billing.service.ts": 1, // BillingService.createCheckoutSession (both surfaces)
};
const EXPIRE_FIRST: Record<string, number> = {
  "billing/subscription-mutation.service.ts": 3, // subscribe, upgradeLocked, downgrade
  "platform-admin/platform-admin.service.ts": 1, // updateTenantPriceOverrideLocked (the custom-fee save)
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

function sites(call: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join("/");
    if (rel === "billing/open-checkout-session.ts") continue;
    const n = fs.readFileSync(f, "utf8").split(`${call}(`).length - 1;
    if (n) found[rel] = n;
  }
  return found;
}

describe("W-1338 open-checkout-session call-site inventory", () => {
  it("openCheckoutSession has exactly the listed callers", () => {
    expect(sites("openCheckoutSession")).toEqual(OPEN);
  });
  it("expireOpenCheckoutSessions has exactly the listed callers", () => {
    expect(sites("expireOpenCheckoutSessions")).toEqual(EXPIRE_FIRST);
  });
});
