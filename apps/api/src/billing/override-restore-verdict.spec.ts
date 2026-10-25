import type { Prisma } from "@prisma/client";
import {
  coverageOf,
  overrideRestoreVerdict,
  type OverrideVerdictContext,
} from "./override-restore-verdict";
import { TenantConfigSnapshotService } from "./tenant-config-snapshot.service";

// Stub registry rows layered over the real one: A is a billable add-on, B requires A (the cascade).
jest.mock("./feature-registry", () => {
  const actual = jest.requireActual("./feature-registry");
  const stub: Record<string, unknown> = {
    stub_a: {
      key: "stub_a",
      gate: { via: "RequireAddon" },
      billing: { skus: ["STUB_A"] },
      defaultGranted: false,
    },
    stub_b: {
      key: "stub_b",
      gate: { via: "RequirePlanFlag" },
      billing: { skus: [] },
      defaultGranted: false,
      requires: { allOf: ["stub_a"] },
    },
  };
  return { ...actual, featureDefByKey: (k: string) => stub[k] ?? actual.featureDefByKey(k) };
});

const TX = {} as Prisma.TransactionClient;
const grant = (featureKey: string, kind = "COMP") => ({
  featureKey,
  effect: "GRANT" as const,
  kind,
  reason: "r",
  expiresAt: null,
  createdById: null,
});
const cov = (over: Record<string, unknown> = {}) => ({
  priceOf: () => null,
  includedAt: () => false,
  planFlags: new Set<string>(),
  grantsFlagsOf: () => [] as string[],
  ...over,
});
const ctx = (
  over: Partial<OverrideVerdictContext> = {},
  coverage?: unknown,
): OverrideVerdictContext => ({
  planAllows: Object.assign(() => true, coverage ? { coverage } : {}) as never,
  pendingAddonKeys: [],
  effects: [],
  loadAddonRows: async () => [],
  ...over,
});
const BRIDGE = cov({
  grantsFlagsOf: (sku: string) => (sku === "OTHER_SKU" ? ["flag.returns"] : []),
});

describe("overrideRestoreVerdict (row 640)", () => {
  it("a requires on a FLAG key reads the plan flags plus the grantsFlags of the tenant ACTIVE add-on rows, never every SKU in the version", async () => {
    const returns = grant("orders_inline_returns"); // requires flag.returns
    expect(await overrideRestoreVerdict(TX, "t", returns, ctx({}, BRIDGE))).toBe("REQUIRES_UNMET");
    const planHas = cov({ planFlags: new Set(["flag.returns"]) });
    expect(await overrideRestoreVerdict(TX, "t", returns, ctx({}, planHas))).toBeNull();
    const rows = [{ addonKey: "bridge", sku: "OTHER_SKU", active: true }];
    expect(
      await overrideRestoreVerdict(
        TX,
        "t",
        returns,
        ctx({ loadAddonRows: async () => rows }, BRIDGE),
      ),
    ).toBeNull();
    expect(
      await overrideRestoreVerdict(
        TX,
        "t",
        returns,
        ctx({ loadAddonRows: async () => rows.map((r) => ({ ...r, active: false })) }, BRIDGE),
      ),
    ).toBe("REQUIRES_UNMET");
  });

  it("a SKU the same transaction activates (pending add-on key) bridges its flags too", async () => {
    const v = await overrideRestoreVerdict(
      TX,
      "t",
      grant("orders_inline_returns"),
      ctx({ pendingAddonKeys: ["OTHER_SKU"] }, BRIDGE),
    );
    expect(v).toBeNull();
  });

  it("a PENDING add-on key covers a non-COMP GRANT for payment only never (the row it writes may be a trial row at price 0), yet still counts for requires", async () => {
    const ocr = grant("ocr", "TRIAL");
    for (const pending of ["ocr", "OCR_PACK_250"]) {
      expect(
        await overrideRestoreVerdict(TX, "t", ocr, ctx({ pendingAddonKeys: [pending] }, cov())),
      ).toBe("ADDON_NOT_PAID");
    }
    // requires: the feature is on while its row exists, so a pending fleet key still satisfies it
    expect(
      await overrideRestoreVerdict(
        TX,
        "t",
        grant("driver_payments"),
        ctx({ pendingAddonKeys: ["order_delivery"] }, cov()),
      ),
    ).toBeNull();
  });

  it("coverageOf prices from the supplied map (pinned, else published) and judges inclusion on the target version", () => {
    const c = coverageOf(
      {
        addonSkus: [{ sku: "A", monthlyPrice: 3, includedAtPlan: null, grantsFlags: ["f"] }],
        planFlags: ["p"],
        priceBySku: new Map([
          ["A", 3],
          ["B", 9],
        ]),
      },
      "starter",
    );
    expect(c.priceOf("A")).toBe(3);
    expect(c.priceOf("B")).toBe(9);
    expect(c.priceOf("Z")).toBeNull();
    expect([...c.planFlags]).toEqual(["p"]);
    expect(c.grantsFlagsOf("A")).toEqual(["f"]);
  });

  it("cascade: a held grant stops satisfying another grant requires (A held ADDON_NOT_PAID, so B is held REQUIRES_UNMET)", async () => {
    const payload = {
      version: 1,
      configs: [],
      overrides: [grant("stub_a", "PILOT"), grant("stub_b")],
    };
    const tx = {
      tenantFeatureConfigSnapshot: {
        findFirst: async () => ({
          id: "s1",
          tenantId: "t",
          planKey: "p",
          takenAt: new Date("2026-09-01T00:00:00Z"),
          restoredAt: null,
          payload,
        }),
      },
      tenantFeatureConfig: { findMany: async () => [] },
      tenantFeatureOverride: { findMany: async () => [] },
      tenantAddon: { findMany: async () => [] },
    } as unknown as Prisma.TransactionClient;
    const svc = new TenantConfigSnapshotService();
    const allows = Object.assign(() => true, { coverage: cov() }) as never;
    const pre = await svc.previewRestore(tx, "t", "s1", new Date("2026-10-01T00:00:00Z"), allows);
    expect(pre!.held.map((h) => [h.featureKey, h.reason])).toEqual([
      ["stub_a", "ADDON_NOT_PAID"],
      ["stub_b", "REQUIRES_UNMET"],
    ]);
    expect(pre!.plan!.overrides.create).toEqual([]);
  });
});
