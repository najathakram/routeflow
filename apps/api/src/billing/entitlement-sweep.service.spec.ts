import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_REGISTRY } from "./feature-registry";
import { servedAnswer } from "./served-answer";
import { EntitlementSweepService } from "./entitlement-sweep.service";

/**
 * SA-1100 §3 (WP1): what the sweep puts on the wire, with every collaborator faked. The real
 * collaborators are covered by `entitlement-sweep.controller.db.spec.ts` (DB lane).
 *   - `courtesy` is on every key and set row, from the ONE predicate in `plan-flag-policy.ts`;
 *   - the credit row's `old` comes from `servedAnswer` like every other row (SA-1099 A-1): the sweep
 *     carries no copy of the credit rule, and the fake authority below runs the real function;
 *   - `inputsHash` covers whether each override is still live at sweep time, so an override that
 *     lapses between two sweeps reads as a moved input, not as an unexplained change.
 */
type Effect = "GRANT" | "DENY";
interface Setup {
  planKey?: string;
  planFlags?: string[];
  addons?: string[];
  overrides?: Record<string, Effect>;
  overrideRows?: { featureKey: string; effect: Effect; kind: string; expiresAt: Date | null }[];
  hasFlag?: boolean;
  mode?: "shadow" | "live";
  modeError?: boolean;
  effective?: (key: string) => boolean;
  /** The resolver's strict answer (FG-1 WP2); defaults to the effective one. */
  strict?: (key: string) => boolean;
}

function build(setup: Setup = {}) {
  const planKey = setup.planKey ?? "STARTER";
  // `hasFlag: true` = the plan carries the credit flag (the guard reads override first, then the plan)
  const planFlags = [...(setup.planFlags ?? []), ...(setup.hasFlag ? ["flag.credit_limits"] : [])];
  const overrides = new Map(Object.entries(setup.overrides ?? {})) as Map<string, Effect>;
  const hasFlag = jest.fn(async () => setup.hasFlag ?? false);
  const prisma = {
    tenant: { findMany: jest.fn(async () => [{ id: "tenant-1", class: "PRODUCTION" }]) },
    tenantAddon: {
      findMany: jest.fn(async () =>
        (setup.addons ?? []).map((addonKey) => ({
          addonKey,
          sku: null,
          quantity: 1,
          active: true,
          isComp: false,
        })),
      ),
    },
    tenantFeatureOverride: { findMany: jest.fn(async () => setup.overrideRows ?? []) },
  };
  const entitlements = {
    invalidate: jest.fn(),
    resolve: jest.fn(async () => ({ planKey, flags: planFlags })),
    hasFlag,
  };
  const featureOverrides = { invalidate: jest.fn(), allActive: jest.fn(async () => overrides) };
  const resolver = {
    invalidate: jest.fn(),
    resolve: jest.fn(async () => ({
      planKey,
      catalogVersionId: "v1",
      byKey: new Map(
        FEATURE_REGISTRY.map((f) => {
          const effective = setup.effective?.(f.key) ?? false;
          return [f.key, { effective, strict: setup.strict?.(f.key) ?? effective }];
        }),
      ),
    })),
  };
  const authority = {
    // today's guards: everything true, except the env-switched credit gate, which is the REAL
    // `servedAnswer` over this setup's facts (its answer used to be computed inside the sweep)
    computeOldPathAll: jest.fn(
      async () =>
        new Map(
          FEATURE_REGISTRY.map((f) => [
            f.key,
            f.gate.via === "service" && f.gate.envSwitched
              ? servedAnswer(f, {
                  ent: { planKey, flags: planFlags },
                  overrides,
                  activeAddonKeys: new Set(setup.addons ?? []),
                  isAlwaysEnforced: planKey === "LITE",
                })
              : true,
          ]),
        ),
    ),
  };
  const modeService = {
    invalidate: jest.fn(),
    getMode: jest.fn(async () => "shadow"),
    getModeStrict: jest.fn(async () => {
      if (setup.modeError) throw new Error("db down");
      return setup.mode ?? "shadow";
    }),
  };
  const addons = {
    getActiveAddons: jest.fn(async () => setup.addons ?? []),
  };
  const addonAccess = { decide: jest.fn(async () => ({ outcome: "denied" })) };
  const service = new EntitlementSweepService(
    prisma as never,
    entitlements as never,
    featureOverrides as never,
    resolver as never,
    authority as never,
    modeService as never,
    addons as never,
    addonAccess as never,
  );
  return { service, hasFlag };
}

const SWITCH = "PLAN_FLAG_ENFORCEMENT";
const saved = process.env[SWITCH];
afterEach(() => {
  jest.useRealTimers();
  if (saved === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = saved;
});
beforeEach(() => {
  delete process.env[SWITCH];
});

describe("EntitlementSweepService: the courtesy bit (SA-1100 §3)", () => {
  it("is on every key row and every set row", async () => {
    const { service } = build();
    const { tenants } = await service.sweep({});
    const row = tenants[0];
    for (const bits of Object.values(row.keys)) expect(typeof bits.courtesy).toBe("boolean");
    expect(Object.keys(row.sets)).toHaveLength(2);
    for (const bits of Object.values(row.sets)) expect(typeof bits.courtesy).toBe("boolean");
  });

  it("Starter, no rows, switch off: dark flags, the dark add-on and the credit row are courtesy; an enforced add-on is not", async () => {
    const { service } = build();
    const { keys } = (await service.sweep({})).tenants[0];
    expect(keys["flag.reports"].courtesy).toBe(true);
    expect(keys["ocr"].courtesy).toBe(true);
    expect(keys["flag.credit_limits"].courtesy).toBe(true);
    expect(keys["tobacco_dealer"].courtesy).toBe(false);
  });

  it("a plan that carries the flag, and a Lite tenant, are not courtesy", async () => {
    const growth = (
      await build({ planKey: "GROWTH", planFlags: ["flag.reports"] }).service.sweep({})
    ).tenants[0].keys;
    expect(growth["flag.reports"].courtesy).toBe(false);
    const lite = (await build({ planKey: "LITE" }).service.sweep({})).tenants[0].keys;
    expect(lite["flag.reports"].courtesy).toBe(false);
    expect(lite["ocr"].courtesy).toBe(false);
    // the credit row has no always-enforced exception (SA-1099 §1)
    expect(lite["flag.credit_limits"].courtesy).toBe(true);
  });

  it("switch 'on': the credit row is no longer courtesy and the dark flags stop being courtesy", async () => {
    process.env[SWITCH] = "on";
    const { keys } = (await build().service.sweep({})).tenants[0];
    expect(keys["flag.credit_limits"].courtesy).toBe(false);
    expect(keys["flag.reports"].courtesy).toBe(false);
  });
});

describe("EntitlementSweepService: the credit row's `old` is the guard's served answer", () => {
  it("switch 'on': old follows the tenant's flag (override first, then the plan)", async () => {
    process.env[SWITCH] = "on";
    const yes = build({ hasFlag: true });
    expect((await yes.service.sweep({})).tenants[0].keys["flag.credit_limits"].old).toBe(true);
    const no = build({ hasFlag: false });
    expect((await no.service.sweep({})).tenants[0].keys["flag.credit_limits"].old).toBe(false);
  });

  // SA-1099 A-1 / SV-6: one home for the rule. The sweep reads `old` from `computeOldPathAll` for
  // EVERY key; it holds no copy of the credit rule and makes no entitlements.hasFlag call of its own.
  it("SV-6 census: the sweep source has no credit-key literal and no hasFlag call", () => {
    const source = readFileSync(join(__dirname, "entitlement-sweep.service.ts"), "utf8");
    expect(source).not.toContain('"flag.credit_limits"');
    expect(source).not.toMatch(/hasFlag\(/);
    expect(source).not.toContain("creditLimitCheckApplies");
  });

  it("makes no hasFlag read per tenant (one fewer query)", async () => {
    const { service, hasFlag } = build({ hasFlag: false });
    await service.sweep({});
    expect(hasFlag).not.toHaveBeenCalled();
  });

  it("switch off: old is true whatever the flag says", async () => {
    const { service } = build({ hasFlag: false });
    expect((await service.sweep({})).tenants[0].keys["flag.credit_limits"].old).toBe(true);
  });
});

describe("EntitlementSweepService: inputsHash covers whether each override is live", () => {
  const T0 = new Date("2026-11-04T10:00:00.000Z");
  const expiry = new Date("2026-11-04T12:00:00.000Z");
  const row = (expiresAt: Date | null) => ({
    featureKey: "flag.reports",
    effect: "GRANT" as Effect,
    kind: "PILOT",
    expiresAt,
  });
  const hashAt = async (now: Date, expiresAt: Date | null) => {
    jest.useFakeTimers({ now });
    const { service } = build({ overrideRows: [row(expiresAt)] });
    return (await service.sweep({})).tenants[0].inputsHash;
  };

  it("an override that lapses between two sweeps moves the hash (same row, same expiresAt)", async () => {
    const before = await hashAt(T0, expiry);
    const after = await hashAt(new Date("2026-11-04T13:00:00.000Z"), expiry);
    expect(after).not.toBe(before);
  });

  it("two sweeps while it is still live have the same hash, and so do never-expiring rows", async () => {
    expect(await hashAt(T0, expiry)).toBe(
      await hashAt(new Date("2026-11-04T11:00:00.000Z"), expiry),
    );
    expect(await hashAt(T0, null)).toBe(await hashAt(new Date("2027-01-01T00:00:00.000Z"), null));
  });
});

describe("EntitlementSweepService: the mode on page 1 (SA-1100 §3, S1 reads it)", () => {
  it("reports the stored mode, live included, read without the fail-open fallback", async () => {
    expect((await build({ mode: "live" }).service.sweep({})).mode).toBe("live");
    expect((await build({ mode: "shadow" }).service.sweep({})).mode).toBe("shadow");
  });

  it("a failed mode read is recorded as modeReadFailed and never reported as shadow", async () => {
    const page = await build({ modeError: true }).service.sweep({});
    expect(page.modeReadFailed).toBe(true);
    expect(page.mode).toBeUndefined();
    expect(page.planFlagEnforcement).toBe("off");
  });

  it("later pages carry neither", async () => {
    const { service } = build();
    const first = await service.sweep({ limit: 1 });
    expect(first.modeReadFailed).toBeUndefined();
  });
});

describe("EntitlementSweepService: the strict bit comes from the resolver (FG-1 WP2)", () => {
  it("a key served by courtesy is effective but not strict; a set is strict when any of its keys is", async () => {
    const { service } = build({
      effective: () => true,
      strict: (key) =>
        key !== "flag.reports" && key !== "order_delivery" && key !== "developer_mode",
    });
    const row = (await service.sweep({})).tenants[0];
    expect(row.keys["flag.reports"]).toMatchObject({ effective: true, strict: false });
    expect(row.keys["flag.msrp"]).toMatchObject({ effective: true, strict: true });
    // recurring_routes is strict, so the three-key set is; the two-key set holds only courtesy keys
    expect(row.sets["recurring_routes|order_delivery|developer_mode"]).toMatchObject({
      strict: true,
    });
    expect(row.sets["order_delivery|developer_mode"]).toMatchObject({
      effective: true,
      strict: false,
    });
  });
});
