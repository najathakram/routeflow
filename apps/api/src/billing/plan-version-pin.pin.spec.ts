/**
 * SA-815a (G1c-1) pins - the plan-version pin has ONE writer and ONE resolver.
 *
 *  P1  `plan-version-pin.ts` is the only code that writes `Tenant.planVersionId` / `TenantSubscription.planVersionId`:
 *      no `tenant.*` / `tenantSubscription.*` write under `apps/api/src` (specs and the catalog's own tables aside)
 *      carries a `planVersionId` key in its data. The seed / repair / audit scripts are EXEMPT (listed, with a reason).
 *  P2  every catalog read in billing / platform-admin (`getPublishedCatalog` / `getPublishedVersion` /
 *      `getVersionForTenant`) is in the inventory below with WHY it is not a pinned-inclusion judgment; the
 *      add-on inclusion judgments read through `inclusionCatalogFor`. A new read is a conscious edit here.
 *  P3  the sites SA-815 names call the resolver, and the entitlement resolver reads its version through it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_SRC_ROOT,
  balancedBraces,
  collectSourceFiles,
  findCalls,
  scanSource,
} from "../testing/source-scan";

const PIN = "billing/plan-version-pin.ts";
const WRITE_CALL =
  /\b(?:tenant|tenantSubscription)\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/;
const ACTIVE_HELPER = /\b(transitionToActiveTx)\s*\(/;
const PIN_KEY = /\bplanVersionId\s*(?::|,|\})/;

/** Scripts that write a pin directly, and why that is allowed (none are app code; all are id-pinned or test-only). */
export const EXEMPT_SCRIPTS: Readonly<Record<string, string>> = {
  "scripts/backfill-subscription-reconciliation.mjs":
    "the owner-run reconcile tool: dry-run first, id-pinned, writes the pin it was asked to mirror",
  "scripts/e2e-seed.js": "seeds the e2e test tenant only",
};
// Also exempt, outside this scan: `prisma/seed.ts`, `scripts/demo-seed.js` and the publish/repin tools, which seed or
// repair TEST/demo tenants or run owner-approved, id-pinned.

/** The call's data, with its `where` clause removed (a `where: { planVersionId }` is a read, not a write). */
function writtenData(args: string): string {
  const w = /\bwhere\s*:\s*\{/.exec(args);
  if (!w) return args;
  const open = w.index + w[0].length - 1;
  const body = balancedBraces(args, open);
  return args.slice(0, w.index) + args.slice(open + body.length + 2);
}

const pinWrites = (file: string, text: string) =>
  [...findCalls(file, text, WRITE_CALL), ...findCalls(file, text, ACTIVE_HELPER)].filter((s) =>
    PIN_KEY.test(writtenData(s.args)),
  );

describe("SA-815a P1 - plan-version-pin.ts is the only pin writer", () => {
  it("walks a non-trivial number of source files (an empty scan must not report green)", () => {
    expect(collectSourceFiles().length).toBeGreaterThan(200);
    expect(scanSource(WRITE_CALL).length).toBeGreaterThan(20);
  });

  it("the detector flags a planted pin write (also via transitionToActiveTx), and ignores a where-only mention and a comment", () => {
    const planted = `
      class Bad {
        async a(tx: any) {
          await tx.tenant.update({ where: { id }, data: { plan: "X", planVersionId: v } });
        }
        async b(tx: any) {
          await tx.tenantSubscription.upsert({ where: { tenantId }, create: { planVersionId: v }, update: {} });
        }
        async c(tx: any) {
          await transitionToActiveTx(tx, id, { data: { planVersionId: v } });
        }
        async d(tx: any) {
          await tx.tenantSubscription.updateMany({ where: { planVersionId: v }, data: { planKey: "X" } });
          // await tx.tenant.update({ data: { planVersionId: v } });
          await tx.tenant.findMany({ where: { planVersionId: v } });
        }
      }`.replace(/^ {6}/gm, "");
    expect(pinWrites("billing/planted.ts", planted).map((s) => s.fn)).toEqual(["a", "b", "c"]);
  });

  it("no tenant / tenantSubscription write outside plan-version-pin.ts carries a planVersionId key", () => {
    const offenders = collectSourceFiles()
      .map((f) => path.relative(API_SRC_ROOT, f).split(path.sep).join("/"))
      .filter((f) => f !== PIN)
      .flatMap((f) => pinWrites(f, fs.readFileSync(path.join(API_SRC_ROOT, f), "utf8")))
      .map((s) => `${s.file}#${s.fn}:${s.line}`);
    expect(offenders).toEqual([]);
  });

  it("the writer itself writes both pins", () => {
    const sites = findCalls(PIN, fs.readFileSync(path.join(API_SRC_ROOT, PIN), "utf8"), WRITE_CALL);
    expect(sites.map((s) => s.fn)).toEqual(["pinPlanVersionTx", "pinPlanVersionTx"]);
    expect(sites.every((s) => PIN_KEY.test(writtenData(s.args)))).toBe(true);
  });

  it("every script that writes a pin directly is listed EXEMPT with a reason (no silent new script)", () => {
    const apiRoot = path.resolve(API_SRC_ROOT, "..");
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(full);
        } else if (/\.(c|m)?js$/.test(e.name) && !/\.(spec|test)\./.test(e.name)) {
          const rel = path.relative(apiRoot, full).split(path.sep).join("/");
          if (pinWrites(rel, fs.readFileSync(full, "utf8")).length > 0) found.push(rel);
        }
      }
    };
    walk(path.join(apiRoot, "scripts"));
    expect(found.sort()).toEqual(Object.keys(EXEMPT_SCRIPTS).sort());
  });
});

/**
 * Every catalog read in billing / platform-admin app code, by enclosing function, and why it is NOT a pinned add-on
 * inclusion judgment. TARGET = the version a plan move lands on (the published one); LIST = list price / existence of
 * a SKU or plan; PIN = reads the tenant's own pinned version for a non-inclusion purpose; RESOLVER = the resolver.
 */
const CATALOG_READ =
  /\b(?:catalog|planCatalogService|planCatalog)\s*\.\s*(getPublishedCatalog|getPublishedVersion|getVersionForTenant)\s*\(/;
export const CATALOG_READS: Readonly<Record<string, string>> = {
  "billing/addon-inclusion.ts#targetVersionFor.getPublishedVersion":
    "TARGET: the version a scheduled move re-pins to when the pinned one lacks the plan",
  "billing/addon.service.ts#enableAddon.getPublishedCatalog":
    "LIST: existence of the SKU (and the fallback); the row's price and the inclusion verdict are the pinned catalog's (inclusionContextOf, pricedAddonSku)",
  "billing/addon.service.ts#uncompAddon.getPublishedCatalog":
    "LIST: existence of the SKU (and the fallback); the manual-invoice price and the inclusion verdict are the pinned catalog's (inclusionCatalogFor, pricedAddonSku)",
  "billing/entitlements.service.ts#compute.getVersionForTenant":
    "RESOLVER: the version id is resolvePlanVersionId(sub, tenant)",
  "billing/entitlements.service.ts#compute.getPublishedVersion":
    "FLAGS: flags gain forward from the published plan (not an add-on inclusion judgment)",
  "billing/feature-preview.service.ts#preview.getPublishedCatalog":
    "TARGET: a hypothetical plan swap lands on the published catalog",
  "billing/feature-preview.service.ts#preview.getVersionForTenant":
    "RESOLVER: reads ent.planVersionId, which the entitlement resolver already resolved",
  "billing/feature-resolver.service.ts#compute.getVersionForTenant":
    "RESOLVER: reads ent.planVersionId, which the entitlement resolver already resolved",
  "billing/feature-resolver.service.ts#compute.getPublishedVersion":
    "FLAGS: flags gain forward from the published plan",
  "billing/plan-transition-config.service.ts#planAllowsFor.getVersionForTenant":
    "PIN: whether a plan allows a transition, on the transition's own target version id",
  "billing/plan-version-pin.ts#inclusionCatalogFor.getVersionForTenant":
    "RESOLVER: the one place a pinned id becomes a catalog",
  "billing/plan-version-pin.ts#pricedAddonSku.getPublishedCatalog":
    "LIST: the fallback of the one price rule - a SKU the pinned version predates is priced at the published one",
  "billing/platform-pricing.service.ts#resolve.getVersionForTenant":
    "PIN: price resolution; its version id is resolvePlanVersionId(sub, tenant)",
  "billing/proration.service.ts#quote.getPublishedCatalog": "TARGET: the quoted plan's price",
  "billing/proration.service.ts#prorationPreview.getPublishedCatalog":
    "LIST: existence of the add-on SKU; the quoted price is the pinned version's (addonSkuFor)",
  "billing/scheduled-price-change.ts#isDowngradePricePushed.getVersionForTenant":
    "PIN: the scheduled downgrade's PRICE, from the subscription's own pin (no add-on inclusion)",
  "billing/scheduled-price-change.ts#isDowngradePricePushed.getPublishedVersion":
    "TARGET: the version the move re-pins to when the pin lacks the plan",
  "billing/scheduled-price-change.ts#restoreIfPushedLocked.getVersionForTenant":
    "PIN: the scheduled downgrade's PRICE, from the subscription's own pin (no add-on inclusion)",
  "billing/scheduled-price-change.ts#restoreIfPushedLocked.getPublishedVersion":
    "TARGET: the version the move re-pins to when the pin lacks the plan",
  "billing/scheduled-price-change.ts#applyLocked.getVersionForTenant":
    "PIN: the scheduled downgrade's PRICE, from the subscription's own pin (no add-on inclusion)",
  "billing/scheduled-price-change.ts#applyLocked.getPublishedVersion":
    "TARGET: the version the move re-pins to when the pin lacks the plan",
  "billing/subscription-mutation.service.ts#subscribe.getPublishedCatalog":
    "TARGET: the plan the pick lands on; the plan LEFT is judged by pinnedVersionOf",
  "billing/subscription-mutation.service.ts#planChangePreview.getPublishedCatalog":
    "TARGET: the previewed plan; the plan LEFT is judged by pinnedVersionOf",
  "billing/subscription-mutation.service.ts#pinnedSkuOf.getPublishedCatalog":
    "LIST: existence + the fallback of a self-serve row's SKU; its price and inclusion are the pinned catalog's (judgeAddon -> pricedAddonSku)",
  "billing/subscription-mutation.service.ts#upgradeLocked.getPublishedCatalog":
    "TARGET: the plan the upgrade lands on; the plan LEFT is judged by pinnedVersionOf",
  "billing/subscription-mutation.service.ts#downgrade.getPublishedCatalog":
    "TARGET: the scheduled plan's price",
  "billing/subscription-mutation.service.ts#enableAddon.getPublishedCatalog":
    "LIST: existence of a self-serve SKU (and the fallback). the row's price and the included-at-plan refusal are the tenant's pinned SKU (judgeAddon)",
  "billing/subscription-mutation.service.ts#addonEnableRefusal.getPublishedCatalog":
    "LIST: as enableAddon. the included-at-plan refusal reads the tenant's pinned SKU (judgeAddon)",
  "billing/subscription-mutation.service.ts#checkoutAddonLines.getPublishedCatalog":
    "LIST: existence of each add-on line's SKU. its price and the refusal are the tenant's pinned SKU (judgeAddon)",
  "billing/subscription-mutation.service.ts#disableAddonLocked.getPublishedCatalog":
    "LIST: the SKU's display name for a STOP notice",
  "billing/subscription.service.ts#getSubscription.getVersionForTenant":
    "RESOLVER: reads ent.planVersionId, which the entitlement resolver already resolved",
  "billing/subscription.service.ts#getRecommendation.getPublishedCatalog":
    "TARGET: the recommended plan's price",
  "platform-admin/platform-admin.service.ts#resolvePublishedPlan.getPublishedVersion":
    "TARGET: the published plan an admin move lands on (every pin writer pairs it with pinPlanVersionTx)",
  "platform-admin/platform-admin.service.ts#updatePlanPrices.getPublishedVersion":
    "TARGET: the published plan whose catalog price an admin edit changes",
};

describe("SA-815a P2 - every catalog read is inventoried; none is an unreviewed inclusion judgment", () => {
  const sites = () =>
    scanSource(CATALOG_READ)
      .filter((s) => /^(billing|platform-admin)\//.test(s.file))
      .map((s) => `${s.file}#${s.fn}.${s.method}`);

  it("the inventory is exactly the catalog reads in billing and platform-admin (a new read is a conscious edit)", () => {
    expect(sites()).toEqual(Object.keys(CATALOG_READS));
  });

  it("no inventory entry is left OPEN: every published-catalog read is a TARGET, LIST, FLAGS, PIN or RESOLVER read", () => {
    expect(Object.entries(CATALOG_READS).filter(([, why]) => /OPEN/.test(why))).toEqual([]);
    expect(
      Object.values(CATALOG_READS).every((why) => /^(TARGET|LIST|FLAGS|PIN|RESOLVER):/.test(why)),
    ).toBe(true);
  });

  it("the six SA-815 sites read no catalog directly: checkout-completed, admin updatePlan, manual activation", () => {
    const all = sites();
    // checkout-completed (`inclusionCatalog`) goes through the resolver only
    expect(
      all.filter((s) => s.startsWith("billing/subscription-mutation.service.ts#inclusionCatalog")),
    ).toEqual([]);
    // admin updatePlan / manual activation: the only direct read is `resolvePublishedPlan` (the TARGET)
    expect(
      all.filter((s) =>
        /platform-admin\.service\.ts#(updatePlanLocked|activateManualSubscription)/.test(s),
      ),
    ).toEqual([]);
  });
});

describe("SA-815a P3 - the named sites read through the resolver", () => {
  const callers = (re: RegExp) =>
    scanSource(re)
      .map((s) => `${s.file}#${s.fn}`)
      .sort();

  it("inclusionCatalogFor is called by exactly the inclusion readers", () => {
    // (the definition in plan-version-pin.ts is not a caller)
    expect(
      callers(/\b(inclusionCatalogFor)\s*\(/).filter(
        (s) => !s.startsWith("billing/plan-version-pin.ts"),
      ),
    ).toEqual(
      [
        "billing/addon-invariant.job.ts#skusFor",
        "billing/addon.service.ts#inclusionContextOf",
        "billing/addon.service.ts#uncompAddon",
        "billing/billing-cron.service.ts#applyScheduledDowngrades",
        "billing/subscription-mutation.service.ts#addonPricingCatalog",
        "billing/subscription-mutation.service.ts#inclusionCatalog",
        "billing/subscription-mutation.service.ts#judgeAddon",
        "billing/subscription-mutation.service.ts#pinnedVersionOf",
        "billing/subscription-mutation.service.ts#planChangePreview",
        "platform-admin/platform-admin.service.ts#activateManualSubscription",
        "platform-admin/platform-admin.service.ts#updatePlanLocked",
      ].sort(),
    );
  });

  it("SA-815e: every add-on PRICE the app writes, quotes or bills is read through the one rule (pricedAddonSku / addonSkuFor)", () => {
    // enable (admin + self-serve), un-comp, the preview, the checkout lines + (c) loop + unbilled-row billing.
    // Plan-change paths (quote, subscribe, the scheduled downgrade) price the TARGET version and are not here.
    // (the definitions in plan-version-pin.ts are not callers)
    expect(
      callers(/\b(pricedAddonSku|addonSkuFor|addonPriceFor)\s*\(/).filter(
        (s) => !s.startsWith("billing/plan-version-pin.ts"),
      ),
    ).toEqual(
      [
        "billing/addon.service.ts#enableAddon",
        "billing/addon.service.ts#uncompAddon",
        "billing/plan-transition-config.service.ts#planAllowsFor", // row 640: the restored-GRANT coverage price
        "billing/proration.service.ts#prorationPreview",
        "billing/subscription-mutation.service.ts#adoptCheckoutAddons",
        "billing/subscription-mutation.service.ts#billUnbilledRow",
        "billing/subscription-mutation.service.ts#judgeAddon",
      ].sort(),
    );
  });

  it("the entitlement resolver and the pricing resolver derive their plan version through resolvePlanVersionId", () => {
    expect(callers(/\b(resolvePlanVersionId)\s*\(/)).toEqual(
      expect.arrayContaining([
        "billing/entitlements.service.ts#compute",
        "billing/platform-pricing.service.ts#resolve",
      ]),
    );
  });

  it("every pin move calls pinPlanVersionTx (subscribe, upgrade, admin plan, manual activation, scheduled downgrade)", () => {
    expect(
      callers(/\b(pinPlanVersionTx)\s*\(/).filter(
        (s) => !s.startsWith("billing/plan-version-pin.ts"),
      ),
    ).toEqual(
      [
        "billing/billing-cron.service.ts#applyScheduledDowngrades",
        "billing/subscription-mutation.service.ts#subscribe",
        "billing/subscription-mutation.service.ts#upgradeLocked",
        "platform-admin/platform-admin.service.ts#activateManualSubscription",
        "platform-admin/platform-admin.service.ts#updatePlanLocked",
      ].sort(),
    );
  });
});
