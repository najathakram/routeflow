/**
 * SA-1099 §6 (WP5, R22 / T22) and B554: a SELF-SERVE enable that would add nothing is refused (409
 * ADDON_ALREADY_INCLUDED), the proration preview returns the same refusal, and the self-serve path now checks the
 * registry `requires` of the rows the SKU bills and clears the resolver's cache.
 *
 * Mocked at the module boundary: the entitlement authority (what the resolver says is effective, what `requires`
 * says), the prisma reads, and the advisory lock. A refusal throws BEFORE the lock, so "the lock was never taken" is
 * the proof that nothing reached Stripe, the row or the ledger; a sale that goes ahead is the lock mock running and
 * returning a fixed outcome.
 */
const mockWithAdvisoryLock = jest.fn(
  async (_opts: { key: string }, _fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: { changed: true, proratedNow: 0, billing: "UNBILLED" },
  }),
);
class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

// A registry with ONE extra row that bills FORECASTING and declares a `requires` (B554: no real self-serve row does yet).
// Every FORECASTING enable below therefore also runs the requires check; the customer pack never does.
jest.mock("./feature-registry", () => {
  const actual = jest.requireActual("./feature-registry");
  return {
    ...actual,
    FEATURE_REGISTRY: [
      ...actual.FEATURE_REGISTRY,
      {
        key: "flag.synthetic_needs_returns",
        kind: "boolean",
        area: "finance",
        label: "Synthetic",
        description: "B554 fixture",
        gate: { via: "none", state: "none", added: "2026-11-05", routes: [] },
        billing: { skus: ["FORECASTING"], selfService: true },
        requires: { allOf: ["flag.returns"] },
        defaultGranted: false,
      },
    ],
  };
});

import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: 25,
  stackable: false,
  grantsFlags: ["flag.forecasting", "flag.analytics"],
  meteredKey: null,
  capacityPerUnit: null,
  includedAtPlan: null,
};
const PACK = {
  sku: "CUSTOMER_PACK_100",
  name: "Customer pack",
  monthlyPrice: 12,
  stackable: true,
  grantsFlags: [] as string[],
  meteredKey: null,
  capacityPerUnit: 100,
  includedAtPlan: null,
};
const ALREADY = {
  code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
  message: "You already have Forecasting, so there is nothing to buy.",
};

type Opts = {
  catalog?: any[];
  /** key -> effective, as the resolver answers. */
  effective?: Record<string, boolean>;
  resolverDown?: boolean;
  heldRow?: Record<string, unknown> | null;
  requiresMissing?: string | null;
  /** The authority fails some other way (a plain Error, not FEATURE_REQUIRES_UNMET). */
  requiresError?: Error;
};

function make(opts: Opts = {}) {
  const catalog = { addonSkus: opts.catalog ?? [FORECASTING, PACK], definitions: [] };
  const prisma: any = {
    tenantAddon: { findFirst: jest.fn(async () => opts.heldRow ?? null) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({ planKey: "STARTER", planVersionId: null }),
    },
    tenant: { findUnique: jest.fn().mockResolvedValue({ plan: "STARTER", planVersionId: null }) },
  };
  const authority = {
    resolveAll: jest.fn(async () =>
      opts.resolverDown
        ? null
        : {
            byKey: new Map(
              Object.entries(opts.effective ?? {}).map(([k, v]) => [k, { effective: v }]),
            ),
          },
    ),
    assertFeatureRequiresMet: jest.fn(async (_t: string, key: string, ack?: boolean) => {
      if (key === "flag.synthetic_needs_returns" && opts.requiresError) throw opts.requiresError;
      if (key === "flag.synthetic_needs_returns" && opts.requiresMissing && !ack) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.FEATURE_REQUIRES_UNMET,
          key,
          missing: opts.requiresMissing,
          message: "internal wording",
        });
      }
    }),
    invalidate: jest.fn(),
  };
  const entitlements = { invalidate: jest.fn() };
  const svc = new SubscriptionMutationService(
    prisma,
    { getPublishedCatalog: jest.fn().mockResolvedValue(catalog) } as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({ planKey: "STARTER" }) } as any,
    entitlements as any,
    {} as any,
    {} as any,
    { isConfigured: false } as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    authority as any,
  );
  return { svc, prisma, authority, entitlements };
}

const COURTESY = { "flag.forecasting": true, "flag.analytics": true };

beforeEach(() => mockWithAdvisoryLock.mockClear());

describe("T22: self-serve enable of an add-on that adds nothing", () => {
  it("Starter, both Forecasting flags already effective: 409 ADDON_ALREADY_INCLUDED, fixed copy, the lock never taken", async () => {
    const m = make({ effective: COURTESY });
    const err: any = await m.svc.enableAddon("t1", "FORECASTING", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject(ALREADY);
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    expect(m.entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("the customer pack is a capacity SKU: sold (200), and the resolver is not even read", async () => {
    const m = make({ effective: COURTESY });
    await expect(m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(m.authority.resolveAll).not.toHaveBeenCalled();
  });

  it("a capacity SKU is never refused even if its row grants an effective flag", async () => {
    const m = make({
      catalog: [{ ...PACK, grantsFlags: ["flag.forecasting"] }],
      effective: COURTESY,
    });
    await expect(m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("an empty grantsFlags is never 'already effective': sold", async () => {
    const m = make({ catalog: [{ ...FORECASTING, grantsFlags: [] }], effective: COURTESY });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("one granted flag still missing: sold (it adds something)", async () => {
    const m = make({ effective: { "flag.forecasting": true, "flag.analytics": false } });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("a flag the resolver does not know counts as not effective: sold, never a refusal on a guess", async () => {
    const m = make({ effective: { "flag.forecasting": true } });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
  });

  it("a plan that is strict (nothing effective without the add-on): sold", async () => {
    const m = make({ effective: { "flag.forecasting": false, "flag.analytics": false } });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
  });

  it("a workspace that already holds the SKU's row keeps the idempotent repeat / buy-more path (no refusal, resolver unread)", async () => {
    const m = make({
      effective: COURTESY,
      heldRow: { id: "a1", sku: "FORECASTING", addonKey: "FORECASTING", active: true },
    });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(m.authority.resolveAll).not.toHaveBeenCalled();
  });

  it("an INACTIVE old row is not 'held': the refusal applies", async () => {
    const m = make({
      effective: COURTESY,
      heldRow: { id: "a1", sku: "FORECASTING", addonKey: "FORECASTING", active: false },
    });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("a resolver that cannot answer sells as before (fail open to today's behaviour), nothing thrown", async () => {
    const m = make({ resolverDown: true });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  it("without an authority wired (older construction) nothing changes", async () => {
    const m = make({ effective: COURTESY });
    const bare = new SubscriptionMutationService(
      m.prisma,
      {
        getPublishedCatalog: jest
          .fn()
          .mockResolvedValue({ addonSkus: [FORECASTING], definitions: [] }),
      } as any,
      {} as any,
      { getSubscription: jest.fn().mockResolvedValue({}) } as any,
      m.entitlements as any,
      {} as any,
      {} as any,
      { isConfigured: false } as any,
      {} as any,
      {} as any,
    );
    await expect(bare.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
  });
});

describe("the proration preview agrees with the enable call", () => {
  it("returns the SAME refusal object the enable throws", async () => {
    const m = make({ effective: COURTESY });
    const preview = await m.svc.addonEnableRefusal("t1", "FORECASTING");
    const err: any = await m.svc.enableAddon("t1", "FORECASTING", 1, "u1").catch((e) => e);
    expect(preview).toMatchObject(ALREADY);
    expect(err.getResponse()).toMatchObject(preview as object);
  });

  it("no refusal where the enable sells (the pack; a strict plan)", async () => {
    expect(
      await make({ effective: COURTESY }).svc.addonEnableRefusal("t1", "CUSTOMER_PACK_100"),
    ).toBeNull();
    expect(
      await make({ effective: { "flag.forecasting": false } }).svc.addonEnableRefusal(
        "t1",
        "FORECASTING",
      ),
    ).toBeNull();
  });
});

describe("B554: the self-serve enable checks the registry `requires` and clears the resolver", () => {
  const STRICT = { "flag.forecasting": false, "flag.analytics": false };

  it("a SKU whose billed row `requires` something the workspace lacks: 409 FEATURE_REQUIRES_UNMET, fixed copy, before the lock", async () => {
    const m = make({ effective: STRICT, requiresMissing: "Returns" });
    const err: any = await m.svc.enableAddon("t1", "FORECASTING", 1, "u1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      code: API_ERROR_CODES.FEATURE_REQUIRES_UNMET,
      message: "Forecasting needs Returns first, which your workspace does not have yet.",
    });
    expect(mockWithAdvisoryLock).not.toHaveBeenCalled();
    // the tenant can never acknowledge: the authority is always asked with acknowledge = false
    expect(m.authority.assertFeatureRequiresMet).toHaveBeenCalledWith(
      "t1",
      "flag.synthetic_needs_returns",
      false,
    );
  });

  it("the preview shows the same refusal", async () => {
    const m = make({ effective: STRICT, requiresMissing: "Returns" });
    expect(await m.svc.addonEnableRefusal("t1", "FORECASTING")).toEqual({
      code: API_ERROR_CODES.FEATURE_REQUIRES_UNMET,
      message: "Forecasting needs Returns first, which your workspace does not have yet.",
    });
  });

  it("requires met: sold", async () => {
    const m = make({ effective: STRICT, requiresMissing: null });
    await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
  });

  // SA-1099 A-3 note 5 (R-3): an outage of the requires check is not a refusal. It matches the already-included
  // check beside it (a resolver that cannot answer sells, with a warning): the sale goes ahead and the log says why.
  it("R-3: the requires check fails with a plain Error (not FEATURE_REQUIRES_UNMET): the sale goes ahead and a warning is logged", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const m = make({ effective: STRICT, requiresError: new Error("registry read failed") });
      await expect(m.svc.enableAddon("t1", "FORECASTING", 1, "u1")).resolves.toBeDefined();
      expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("FORECASTING"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires"));
    } finally {
      warn.mockRestore();
    }
  });

  it("R-3: the preview does not refuse on that failure either", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const m = make({ effective: STRICT, requiresError: new Error("registry read failed") });
      expect(await m.svc.addonEnableRefusal("t1", "FORECASTING")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("a SKU billing no requires-bearing row (the customer pack) is not asked", async () => {
    const m = make({ requiresMissing: "Returns" });
    await m.svc.enableAddon("t1", "CUSTOMER_PACK_100", 1, "u1");
    expect(m.authority.assertFeatureRequiresMet).not.toHaveBeenCalled();
  });

  it("a successful enable clears the feature resolver's cache as well as the entitlements', once", async () => {
    const m = make({ effective: STRICT });
    await m.svc.enableAddon("t1", "FORECASTING", 1, "u1");
    expect(m.entitlements.invalidate).toHaveBeenCalledWith("t1");
    expect(m.authority.invalidate).toHaveBeenCalledTimes(1);
    expect(m.authority.invalidate).toHaveBeenCalledWith("t1");
  });
});
