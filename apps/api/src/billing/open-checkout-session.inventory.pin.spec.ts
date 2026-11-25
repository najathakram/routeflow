import * as fs from "fs";
import * as path from "path";
import { codeOnly, findCalls } from "../testing/source-scan";

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
  "platform-admin/platform-admin.service.ts": 2, // updatePlanLocked (plan edit), updateTenantPriceOverrideLocked (fee save)
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

/** A term read on the right of `=` (const, let, destructuring, assignment) or returned: a value bound outside the slot's lock. */
const BOUND_READ =
  /(?:\b(?:const|let|var)\b[^;]*?=|[\w\]}]\s*=(?!=)|\breturn\b)\s*(?:await\s+)?(?:[\w.]+\.)?(?:checkoutPriceData|resolveTenantPricing|checkoutAddonLines|planCheckoutAnchor)\s*\(/;
const TERM_READS = [
  "checkoutAddonLines",
  "planCheckoutAnchor",
  "resolveTenantPricing",
  "checkoutPriceData",
];

/**
 * Violations in one file's text, for each `openCheckoutSession(` call: the enclosing function binds no term read
 * before the call, the call passes `readOffer:`, and the method `readOffer` points at makes all four reads.
 */
function slotCallerViolations(file: string, text: string): string[] {
  const out: string[] = [];
  const code = codeOnly(text);
  for (const c of findCalls(file, text, /\b(openCheckoutSession)\(/)) {
    const bound = BOUND_READ.exec(c.scope);
    if (bound) out.push(`${file}#${c.fn}: binds a term read: ${bound[0].trim().slice(0, 70)}`);
    const reader = /\breadOffer:\s*\(\)\s*=>\s*this\.(\w+)\(/.exec(c.args);
    if (!reader) {
      out.push(`${file}#${c.fn}: openCheckoutSession is not given readOffer`);
      continue;
    }
    const decl = new RegExp(`^ {2}(?:private\\s+)?(?:async\\s+)?${reader[1]}\\s*\\(`, "m").exec(
      code,
    );
    const rest = decl ? code.slice(decl.index + decl[0].length) : "";
    const next = rest.search(/^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?\w+\s*\(/m);
    const body = next < 0 ? rest : rest.slice(0, next);
    for (const need of TERM_READS) {
      if (!new RegExp(`\\b${need}\\(`).test(body))
        out.push(`${file}: ${reader[1]} does not read ${need}`);
    }
  }
  return out;
}

describe("W-1338 callers hand the slot ids and a reader, never terms", () => {
  it("every openCheckoutSession caller passes readOffer and binds no term read before it", () => {
    const files = Object.keys(OPEN);
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap((rel) =>
      slotCallerViolations(rel, fs.readFileSync(path.join(SRC, rel), "utf8")),
    );
    expect(bad).toEqual([]);
  });

  it("self-test: every shape of a bound read is flagged; an unbound read-only gate passes", () => {
    const caller = (before: string, args = "readOffer: () => this.offer(id)") => `
class S {
  async start(id: string) {
${before}
    return openCheckoutSession(d, { id, ${args} });
  }
  private async offer(id: string) {
    await this.m.checkoutAddonLines(id);
    planCheckoutAnchor(new Date());
    const p = await this.pricing.resolveTenantPricing(id);
    return this.pricing.checkoutPriceData(id);
  }
}`;
    const bound = [
      "      const pricing = await this.pricing.resolveTenantPricing(id);",
      "      const { unit } = await this.pricing.checkoutPriceData(id, 'month');",
      "      let anchor = planCheckoutAnchor(new Date());",
      "      let addons; addons = await this.m.checkoutAddonLines(id, 'month');",
      "      const pricing = this.pricing.resolveTenantPricing(id);",
    ];
    for (const sh of bound) expect(slotCallerViolations("f.ts", caller(sh))).not.toEqual([]);
    const gate =
      "      await this.pricing.checkoutPriceData(id, 'month', undefined, { readOnly: true });";
    expect(slotCallerViolations("f.ts", caller(gate))).toEqual([]);
    expect(slotCallerViolations("f.ts", caller("", "terms: {}, params: {}"))).toEqual([
      "f.ts#start: openCheckoutSession is not given readOffer",
    ]);
  });
});

describe("W-1338 open-checkout-session call-site inventory", () => {
  it("openCheckoutSession has exactly the listed callers", () => {
    expect(sites("openCheckoutSession")).toEqual(OPEN);
  });
  it("expireOpenCheckoutSessions has exactly the listed callers", () => {
    expect(sites("expireOpenCheckoutSessions")).toEqual(EXPIRE_FIRST);
  });
});
