/**
 * FG-1 WP9a (R19, T19 amended by SA-1108): a refusal message holds no registry key, no add-on key, no add-on SKU code
 * and no plan key (plans appear by display name), at ALL FOUR refusal seats. The wire fields are not touched.
 */
import { buildPlanGateBody } from "./plan-gate";
import { denialText, planDisplayName } from "./denial-text";
import { FEATURE_REGISTRY } from "./feature-registry";
import {
  ADDON_SKUS,
  FLAG_TO_ADDON_SKU,
  LEGACY_ADDON_KEY_TO_SKU,
  PLAN_KEYS,
  SELF_SERVICE_ADDON_SKUS,
} from "./plan-catalog.constants";
import { ProductsService } from "../products/products.service";
import { InlineReturnsService } from "../returns/inline-returns.service";

/** Everything a customer must never read in a refusal. */
const FORBIDDEN: readonly string[] = [
  ...FEATURE_REGISTRY.map((f) => f.key),
  ...FEATURE_REGISTRY.map((f) => f.grant.addonKey).filter((k): k is string => Boolean(k)),
  ...ADDON_SKUS,
  ...PLAN_KEYS,
  "INTERNAL_ADDON_KEYS",
];

/** The text with every registry label taken out (a label such as "MSRP pricing" may share letters with a code). */
const withoutLabels = (text: string): string =>
  FEATURE_REGISTRY.reduce((t, f) => t.split(f.label).join(""), text);

function expectNoRawKey(message: string): void {
  const rest = withoutLabels(message);
  const hits = FORBIDDEN.filter((k) => rest.includes(k));
  expect({ message, hits }).toEqual({ message, hits: [] });
}

describe("denialText: the one builder", () => {
  it("override-only key: Ask RouteFlow", () => {
    expect(denialText({ keys: ["email.connected_mailbox"] })).toMatch(
      /Ask RouteFlow to turn it on\.$/,
    );
  });

  it("a key only RouteFlow can turn on (an admin-only add-on): Ask RouteFlow, never Billing (F1)", () => {
    expect(denialText({ keys: ["tobacco_dealer"] })).toBe(
      "Regulated tobacco dealer program isn't turned on for your account. Ask RouteFlow to turn it on.",
    );
  });

  it("a self-serve add-on a business can buy itself: Add it in Billing (F1)", () => {
    expect(denialText({ keys: ["flag.forecasting"] })).toBe(
      "Inventory forecasting is an add-on. Add it in Billing.",
    );
  });

  it("class pin (F1): the message says Billing if and only if the row's SKU is self-serve", () => {
    const selfServe = new Set<string>(SELF_SERVICE_ADDON_SKUS);
    const seen = { billing: 0, ask: 0 };
    for (const row of FEATURE_REGISTRY) {
      const sku =
        FLAG_TO_ADDON_SKU[row.key] ??
        (row.grant.addonKey ? LEGACY_ADDON_KEY_TO_SKU[row.grant.addonKey] : undefined);
      const billing = sku !== undefined && selfServe.has(sku);
      const text = denialText({ keys: [row.key] });
      expect({ key: row.key, billing: /Billing/.test(text) }).toEqual({ key: row.key, billing });
      seen[billing ? "billing" : "ask"] += 1;
    }
    expect(seen.billing).toBeGreaterThan(0); // the pin really sees both outcomes
    expect(seen.ask).toBeGreaterThan(0);
  });

  it("a plan that includes it: the plan's display name", () => {
    expect(denialText({ keys: ["flag.reports"], planKey: "SCALE" })).toContain(
      "comes with the Scale plan and higher.",
    );
    expect(planDisplayName("LITE")).toBe("Lite");
    expect(planDisplayName("custom_acme")).toBeUndefined();
  });

  it("W9a-ocr (SA-1107): a refused LITE business is told Ask RouteFlow, never Included, never Billing", () => {
    const text = denialText({ keys: ["ocr"] });
    expect(text).toBe(
      "Bill scanning isn't turned on for your account. Ask RouteFlow to turn it on.",
    );
    expect(text).not.toMatch(/Included|included|comes with|Billing/);
  });

  it("an unknown key never leaks: a generic sentence", () => {
    const text = denialText({ keys: ["not_in_registry"] });
    expect(text).toBe(
      "This feature isn't turned on for your account. Ask RouteFlow to turn it on.",
    );
    expect(text).not.toContain("not_in_registry");
  });
});

describe("T19 (amended): no refusal message names a key, a SKU code or a plan key", () => {
  it("the builder, for every registry row and add-on key, under every next step", () => {
    for (const row of FEATURE_REGISTRY) {
      for (const key of [row.key, row.grant.addonKey].filter((k): k is string => Boolean(k))) {
        expectNoRawKey(denialText({ keys: [key] }));
        expectNoRawKey(denialText({ keys: [key], addonSku: "FORECASTING" }));
        expectNoRawKey(denialText({ keys: [key], planKey: "SCALE" }));
      }
    }
  });

  it("seat 1, the plan gate: no SKU code and no plan key in the message; the wire fields are unchanged", () => {
    const upgrade = {
      planKey: "SCALE",
      planMonthlyPrice: "99",
      addonSku: "MSRP",
      addonMonthlyPrice: "10",
    };
    const body = buildPlanGateBody("flag.msrp", upgrade);
    expectNoRawKey(body.message);
    expect(body).toMatchObject({
      code: "PLAN_GATE",
      state: "INLINE_RESOLVE",
      flag: "flag.msrp",
      upgrade,
    });
    // F1: MSRP is admin-only, so the offered SKU is not a Billing step; the wire state is unchanged.
    expect(body.message).not.toContain("Billing");
    expect(body.message).toBe("MSRP pricing comes with the Scale plan and higher.");
    expect(buildPlanGateBody("flag.msrp", { ...upgrade, planKey: null }).message).toContain(
      "Ask RouteFlow",
    );
    const buyable = buildPlanGateBody("flag.forecasting", {
      ...upgrade,
      addonSku: "FORECASTING",
    });
    expect(buyable.message).toBe("Inventory forecasting is an add-on. Add it in Billing.");
    expect(buyable.state).toBe("INLINE_RESOLVE");
    const locked = buildPlanGateBody("flag.reports", { ...upgrade, addonSku: null });
    expectNoRawKey(locked.message);
    expect(locked.state).toBe("LOCKED_PAGE");
    expect(locked.message).toContain("Scale plan and higher");
  });

  it("seat 2, products: the tobacco refusal holds no add-on key", async () => {
    const svc = Object.create(ProductsService.prototype) as any;
    svc.prisma = { getTenantId: () => "t1" };
    svc.addonService = { hasAddon: jest.fn().mockResolvedValue(false) };
    const err = await svc.assertCanFlagTobacco(true).catch((e: Error) => e);
    expectNoRawKey(err.message);
    expect(err.message).toContain("Ask RouteFlow");
    expect(err.message).not.toContain("Billing");
  });

  it("seat 3, inline returns: the refusal holds no add-on key (a customer reads this verbatim today)", async () => {
    const svc = Object.create(InlineReturnsService.prototype) as any;
    svc.addonService = { hasAddon: jest.fn().mockResolvedValue(false) };
    const err = await svc.assertGranted("t1").catch((e: Error) => e);
    expectNoRawKey(err.message);
    expect(err.message).toContain("Returns at order entry");
  });

  it("seat 4, the add-on guard, is pinned in addon.guard.spec.ts (messages for 1, 2, internal and unknown keys)", () => {
    // The guard spec builds the real guard; this pin only checks it still calls the one builder.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "addon.guard.ts"),
      "utf8",
    );
    expect(src).toContain("denialText(");
    expect(src).not.toMatch(/requires the \$\{|requires one of these/);
  });
});
