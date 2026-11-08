/**
 * FG-1 WP9a (R19, T19 amended by SA-1108): a refusal message holds no registry key, no add-on key, no add-on SKU code
 * and no plan key (plans appear by display name), at ALL FOUR refusal seats. The wire fields are not touched.
 */
import { buildPlanGateBody } from "./plan-gate";
import { buildPlanFlagDenial } from "./plan-flag-denial";
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
      /ask RouteFlow to turn this on\.$/,
    );
  });

  it("a key only RouteFlow can turn on (an admin-only add-on): Ask RouteFlow, never Billing (F1)", () => {
    expect(denialText({ keys: ["tobacco_dealer"] })).toBe(
      "To use Regulated tobacco dealer program, ask RouteFlow to turn this on.",
    );
  });

  it("a self-serve add-on a business can buy itself: Add it in Billing (F1)", () => {
    expect(denialText({ keys: ["flag.forecasting"] })).toBe(
      "To use Inventory forecasting, add it in Billing.",
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
      "Included with the Scale plan and higher: Bookkeeping reports.",
    );
    expect(planDisplayName("LITE")).toBe("Lite");
    expect(planDisplayName("custom_acme")).toBeUndefined();
  });

  it("W9a-ocr (SA-1107): a refused LITE business is told Ask RouteFlow, never Included, never Billing", () => {
    const text = denialText({ keys: ["ocr"] });
    expect(text).toBe("To use Bill scanning, ask RouteFlow to turn this on.");
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
    expect(body.message).toBe("Included with the Scale plan and higher: MSRP pricing.");
    expect(buildPlanGateBody("flag.msrp", { ...upgrade, planKey: null }).message).toContain(
      "ask RouteFlow",
    );
    const buyable = buildPlanGateBody("flag.forecasting", {
      ...upgrade,
      addonSku: "FORECASTING",
    });
    expect(buyable.message).toBe("To use Inventory forecasting, add it in Billing.");
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
    expect(err.message).toContain("ask RouteFlow");
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

describe("an explicit 'no add-on offered' from the plan gate is authoritative (reader B MUST-1)", () => {
  const none = { planKey: null, planMonthlyPrice: null, addonSku: null, addonMonthlyPrice: null };
  const deps = (override: string | null, catalog: jest.Mock) => ({
    featureOverrides: { get: jest.fn().mockResolvedValue(override) },
    entitlements: { resolve: jest.fn().mockResolvedValue({}) },
    catalog: { upgradeTargetForFlag: catalog },
    logger: { warn: jest.fn(), error: jest.fn() },
  });

  it.each(["flag.forecasting", "flag.analytics"])(
    "the builder: %s with addonSku null never points to Billing",
    (flag) => {
      const text = denialText({ keys: [flag], addonSku: null, planKey: null });
      expect(text).toContain("ask RouteFlow");
      expect(text).not.toContain("Billing");
    },
  );

  it("the plan gate body with no upgrade target never says Billing for a buyable flag", () => {
    const body = buildPlanGateBody("flag.forecasting", none);
    expect(body.message).toContain("ask RouteFlow");
    expect(body.message).not.toContain("Billing");
  });

  it("a DENY override on flag.forecasting: Ask RouteFlow, not Billing", async () => {
    const catalog = jest.fn();
    const err: any = await buildPlanFlagDenial(
      deps("DENY", catalog) as any,
      "t1",
      "flag.forecasting",
    );
    expect(err.getResponse().message).not.toContain("Billing");
    expect(err.getResponse().message).toContain("ask RouteFlow");
  });

  it("a failed catalog read on flag.analytics: Ask RouteFlow, not Billing", async () => {
    const catalog = jest.fn().mockRejectedValue(new Error("no catalog"));
    const err: any = await buildPlanFlagDenial(deps(null, catalog) as any, "t1", "flag.analytics");
    expect(err.getResponse().message).not.toContain("Billing");
  });

  it("a caller that says nothing about the add-on (the guards) still reads the row", () => {
    expect(denialText({ keys: ["flag.forecasting"] })).toContain("Billing");
  });
});

describe("the sentence reads right for a plural and a singular name (reader B MUST-2)", () => {
  it("a plural name: no verb that must agree with it", () => {
    expect(denialText({ keys: ["flag.estimates"], planKey: "SCALE" })).toBe(
      "Included with the Scale plan and higher: Estimates.",
    );
    expect(denialText({ keys: ["sales_agents"] })).toBe(
      "To use Sales agents & commissions, ask RouteFlow to turn this on.",
    );
  });

  it("a singular name reads the same way", () => {
    expect(denialText({ keys: ["flag.msrp"], planKey: "SCALE" })).toBe(
      "Included with the Scale plan and higher: MSRP pricing.",
    );
  });

  it("class pin: no registry label is ever followed by is / isn't / comes, whatever the path", () => {
    const bad = /^ (?:is|isn't|comes|are|aren't)\b/; // the word right after the name
    for (const row of FEATURE_REGISTRY) {
      const texts = [
        denialText({ keys: [row.key] }),
        denialText({ keys: [row.key], planKey: "SCALE" }),
        denialText({ keys: [row.key], addonSku: "FORECASTING" }),
        denialText({ keys: [row.key], addonSku: null }),
      ];
      for (const text of texts) {
        const at = text.indexOf(row.label);
        if (at === -1) continue; // PLAIN_NAME rows (ocr) read their own plain name
        expect({ key: row.key, text, after: bad.test(text.slice(at + row.label.length)) }).toEqual({
          key: row.key,
          text,
          after: false,
        });
      }
    }
  });
});
