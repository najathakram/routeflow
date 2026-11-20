/**
 * @jest-environment node
 */
// B1371 (SA-1175 R1, #4393 read B H-1): no plan limits logins (entitlements caps.seats is null) and a downgrade never
// turns a login off (billing-cron.service.ts has no seat block). Class pin: no customer-facing copy may say a login,
// user, seat or team member can be turned off, deactivated or cut off, or sits "over the limit". It scans every
// public site page and script, the web app, its components and lib, the mobile app, and the api's email templates.
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../../..");
const ROOTS = [
  "apps/web/public/site",
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/mobile/app",
  "apps/mobile/src",
  "apps/mobile/components",
  "apps/api/src/email",
];
// The api's customer-facing email copy outside src/email.
const FILES = ["apps/api/src/billing/billing-notification.templates.ts"];

export const CUTOFF_CLAIMS: RegExp[] = [
  /\b(logins?|users?|staff|drivers?|seats?|team members?)\b[^.<\n]{0,80}\b(can|will|may|could|would|might) be (turned off|switched off|deactivated|cut off|disabled|removed)\b/i,
  /\b(logins?|users?|seats?)\s+over\s+(its|the|your|their|a)\s+(plan'?s?\s+)?(limit|cap)\b/i,
  /\bover\s+(its|the|your|their)\s+(seat|login|user)\s+(limit|cap)\b/i,
];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (
        name !== "node_modules" &&
        name !== ".next" &&
        name !== "__tests__" &&
        name !== "__mocks__"
      )
        walk(p, out);
    } else if (/\.(html|js|mjs|tsx?)$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const sources = (): string[] => [
  ...ROOTS.flatMap((r) => walk(path.join(REPO, r))),
  ...FILES.map((f) => path.join(REPO, f)),
];

describe("no copy says a login can be cut off (B1371 H-1)", () => {
  it("the scan is not vacuous: it reads the site pages, the app and the email templates", () => {
    const files = sources().map((f) => path.relative(REPO, f).replace(/\\/g, "/"));
    for (const must of [
      "apps/web/public/site/product.html",
      "apps/web/public/site/pricing.html",
      "apps/web/public/site/home.html",
      "apps/web/app/(dashboard)/settings/billing/page.tsx",
      "apps/web/app/(dashboard)/choose-plan/page.tsx",
      "apps/api/src/billing/billing-notification.templates.ts",
    ])
      expect(files).toContain(must);
    expect(files.length).toBeGreaterThan(500);
  });

  it("the patterns catch the retired sentence and its variants (a pattern typo cannot pass silently)", () => {
    for (const old of [
      "If you move to a smaller plan, staff or driver logins over its limit can be turned off.",
      "these users will be deactivated",
      "Users over your seat limit",
      "Seats over the plan's limit may be switched off",
    ])
      expect(CUTOFF_CLAIMS.some((re) => re.test(old))).toBe(true);
    for (const fine of [
      "Ten wrong tries lock a login for 15 minutes.",
      "Over your limit. You get 7 days. After that, you can't add new customers.",
      "There are four kinds of login. Each one reaches different things.",
    ])
      expect(CUTOFF_CLAIMS.some((re) => re.test(fine))).toBe(false);
  });

  it("no site page, app screen, component or email template carries such a claim", () => {
    const hits: string[] = [];
    for (const file of sources()) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (CUTOFF_CLAIMS.some((re) => re.test(line)))
            hits.push(`${path.relative(REPO, file).replace(/\\/g, "/")}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
