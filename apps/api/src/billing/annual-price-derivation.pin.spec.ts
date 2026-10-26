/**
 * Row 280 (class fix) — structural pin: an annual price is derived in ONE place.
 *
 * `monthly * 10` is whole cents only after `roundMoney` (33.33 * 10 is 333.29999999999995), and it
 * is the number Stripe bills, so the settings view, checkout and the plan-change push must all
 * read `resolvePlanPrice` (`plan-price.ts`) rather than each multiplying. This walks the source and
 * counts lines that multiply a monthly operand by 10, per file; a new one fails here instead of
 * showing a tenant one price and billing another (the settings view did exactly that).
 *
 * Counts are shrink-only. Excluded: `*.spec.ts` and comment-only lines.
 */

import * as fs from "fs";
import * as path from "path";

const API_SRC = path.resolve(__dirname, "..");
const WEB_ROOT = path.resolve(__dirname, "../../../web");

/** A monthly-named operand times 10: `monthly * 10`, `Number(draft.monthly) * 10`, `priceOverrideMonthly) * 10`. */
const MONTHLY_TIMES_10 = /monthly\w*\)?\s*\*\s*10\b/i;

/** repo-relative path -> allowed line count, each with the reason it may multiply. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "apps/api/src/billing/plan-price.ts": {
    count: 1,
    why: "the one rule: annualFromMonthly() = roundMoney(monthly * 10); resolvePlanPrice and billing-math both call it",
  },
  "apps/web/app/(platform-admin)/admin/plans/page.tsx": {
    count: 1,
    why: "admin editor preview, formatted by usd(); the saved value comes from the API",
  },
  "apps/web/app/(platform-admin)/admin/tenants/[id]/_components/TenantPricingCard.tsx": {
    count: 1,
    why: "admin editor preview, formatted by usd(); the saved value comes from the API",
  },
};

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", "coverage"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function countMonthlyTimes10(source: string): number {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return MONTHLY_TIMES_10.test(line.replace(/\/\/.*$/, ""));
  }).length;
}

describe("annual price derivation pin (row 280)", () => {
  const repoRoot = path.resolve(API_SRC, "../../..");
  const files = [
    ...collect(API_SRC),
    ...["app", "lib", "components"]
      .map((d) => path.join(WEB_ROOT, d))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => collect(d)),
  ];
  const found = new Map<string, number>();
  for (const f of files) {
    const n = countMonthlyTimes10(fs.readFileSync(f, "utf8"));
    if (n > 0) found.set(path.relative(repoRoot, f).split(path.sep).join("/"), n);
  }

  it("only the allow-listed files multiply a monthly price by 10, at most their counted times", () => {
    const over = [...found.entries()]
      .filter(([file, n]) => n > (ALLOWED[file]?.count ?? 0))
      .map(([file, n]) => `${file}: ${n} (allowed ${ALLOWED[file]?.count ?? 0})`);
    expect(over).toEqual([]);
  });

  it("an allow-list entry that no longer multiplies is removed (shrink-only)", () => {
    const stale = Object.entries(ALLOWED)
      .filter(([file, { count }]) => (found.get(file) ?? 0) < count)
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });

  it("the detector sees the shapes it is meant to catch", () => {
    expect(countMonthlyTimes10("const a = monthly * 10;")).toBe(1);
    expect(countMonthlyTimes10("x: Number(sub.priceOverrideMonthly) * 10,")).toBe(1);
    expect(countMonthlyTimes10("usd(Number(draft.monthly) * 10)")).toBe(1);
    expect(countMonthlyTimes10("// annual = monthly * 10")).toBe(0);
    expect(countMonthlyTimes10("return Math.round(m * 10) / 10;")).toBe(0);
  });
});
