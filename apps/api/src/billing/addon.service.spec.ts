/**
 * B342 — `enableAddon` now serialises its check-then-act window through `withAdvisoryLock`
 * (`common/db-locks.ts`). This mock is a per-key FIFO mutex: a second call for the SAME lock
 * key does not start running its callback until the first call's callback has fully settled —
 * the same observable effect the real Postgres advisory lock gives across replicas. For every
 * existing (non-concurrent) test this behaves exactly like a bare pass-through; only the
 * dedicated B342 race test below relies on the actual serialisation.
 *
 * `MockLockTimeoutError`/`MockLockUnavailableError` mirror the real `db-locks.ts` exports so
 * `addon.service.ts`'s `instanceof` checks against the (mocked) module keep working.
 */
const lockQueues = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(async (opts: { key: string }, fn: () => Promise<unknown>) => {
  const prior = lockQueues.get(opts.key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((res) => {
    release = res;
  });
  lockQueues.set(
    opts.key,
    prior.then(() => done),
  );
  await prior;
  try {
    const value = await fn();
    return { acquired: true as const, value };
  } finally {
    release();
  }
});

class MockLockTimeoutError extends Error {
  constructor(
    public readonly family: string,
    public readonly key: string,
    public readonly waitMs: number,
  ) {
    super(`lock timeout: ${family}/${key} after ${waitMs}ms`);
    this.name = "LockTimeoutError";
  }
}

class MockLockUnavailableError extends Error {
  constructor(public readonly cause?: unknown) {
    super("lock unavailable");
    this.name = "LockUnavailableError";
  }
}

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AddonService } from "./addon.service";

beforeEach(() => {
  lockQueues.clear();
  mockWithAdvisoryLock.mockClear();
});

function published(skus: string[]) {
  return { addonSkus: skus.map((sku) => ({ sku, name: sku, monthlyPrice: 10 })) };
}

interface Opts {
  existingAddon?: any;
  publishedSkus?: string[];
  /** Override the default unconfigured Stripe mock — e.g. `{ isConfigured: true, client: { subscriptionItems: { del: jest.fn()... } } }`. */
  stripe?: any;
  /** Override tenantSubscription.findUnique's resolved value (default null — no Stripe sub). */
  subscription?: any;
  /** B524: registry keys this tenant currently has effective, for featureResolver.resolve()'s
   *  `byKey` map. Default `[]` (nothing effective). `null` simulates resolution FAILURE
   *  (DB down / unseeded catalog) — the resolver returns `null`, not a map. */
  effectiveKeys?: string[] | null;
}

function make(opts: Opts = {}) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }) },
    tenantAddon: {
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      upsert: jest.fn().mockResolvedValue({ id: "addon1", active: true }),
      update: jest.fn().mockResolvedValue({ id: "addon1", active: false }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(opts.subscription ?? null) },
  } as any;
  const stripe = opts.stripe ?? ({ isConfigured: false, client: {} } as any);
  const entitlements = { invalidate: jest.fn() } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue(published(opts.publishedSkus ?? [])),
  } as any;
  const resolvedValue =
    opts.effectiveKeys === null
      ? null
      : {
          byKey: new Map((opts.effectiveKeys ?? []).map((k) => [k, { key: k, effective: true }])),
        };
  const featureResolver = {
    invalidate: jest.fn(),
    resolve: jest.fn().mockResolvedValue(resolvedValue),
  } as any;
  const svc = new AddonService(prisma, stripe, entitlements, catalog, featureResolver);
  return { svc, prisma, entitlements, catalog, stripe, featureResolver };
}

describe("AddonService.enableAddon", () => {
  it("400s a bridged key whose SKU is missing from the published catalog, and writes nothing", async () => {
    const { svc, prisma, entitlements } = make({ publishedSkus: [] }); // MSRP not published

    await expect(svc.enableAddon("t1", "msrp")).rejects.toThrow(BadRequestException);
    await expect(svc.enableAddon("t1", "msrp")).rejects.toThrow(
      "Addon 'msrp' maps to SKU 'MSRP' which is not in the published catalog",
    );
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("enables a bridged key whose SKU IS published, writes the row, and invalidates entitlements", async () => {
    const { svc, prisma, entitlements, featureResolver } = make({ publishedSkus: ["MSRP"] });

    await svc.enableAddon("t1", "msrp");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_addonKey: { tenantId: "t1", addonKey: "msrp" } },
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    // REG-B509: the resolver cache backing the Feature Console needs its own invalidation —
    // entitlements.invalidate() alone leaves it stale for up to 30s.
    expect(featureResolver.invalidate).toHaveBeenCalledWith("t1");
  });

  it("allows an unbridged legacy key (developer_mode) unchanged, and still invalidates", async () => {
    const { svc, prisma, entitlements, catalog, featureResolver } = make({ publishedSkus: [] });

    await svc.enableAddon("t1", "developer_mode");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    expect(featureResolver.invalidate).toHaveBeenCalledWith("t1");
    // No SKU to validate → the published catalog is never even fetched.
    expect(catalog.getPublishedCatalog).not.toHaveBeenCalled();
  });
});

describe("AddonService.disableAddon", () => {
  it("invalidates entitlements after disabling", async () => {
    const { svc, prisma, entitlements, featureResolver } = make({
      existingAddon: { id: "addon1", addonKey: "msrp", active: true },
    });

    await svc.disableAddon("t1", "msrp");

    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_addonKey: { tenantId: "t1", addonKey: "msrp" } },
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    // REG-B509: see the matching note in enableAddon's test above.
    expect(featureResolver.invalidate).toHaveBeenCalledWith("t1");
  });

  it("REG-B107 T7 refuses when the Stripe delete fails (non-missing error)", async () => {
    const del = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "api_error", statusCode: 500 }));
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_1", active: true },
    });

    const attempt = svc.disableAddon("t1", "msrp");
    // Message oracle first: T7/T8/T9 all reject, and two of them share a class — only the
    // message separates "the Stripe delete failed" from the other two refusals.
    await expect(attempt).rejects.toThrow(/Could not remove the Stripe subscription item/);
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The refusal must follow a REAL Stripe attempt — a blanket throw whenever Stripe is
    // configured would otherwise satisfy this test for the wrong reason.
    expect(del).toHaveBeenCalled();
    expect(prisma.tenantAddon.update).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("PIN T11: a Stripe 'resource_missing' (404) delete still RESOLVES and clears the pointer — over-refusal turns this red", async () => {
    const del = jest.fn().mockRejectedValue(
      Object.assign(new Error("No such subscription item"), {
        code: "resource_missing",
        statusCode: 404,
      }),
    );
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_1", active: true },
    });

    await expect(svc.disableAddon("t1", "msrp")).resolves.toBeDefined();
    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, stripeItemId: null } }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("PIN T14: a successful Stripe delete removes the item and clears the local pointer", async () => {
    const del = jest.fn().mockResolvedValue({ id: "si_9", deleted: true });
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_9", active: true },
    });

    await expect(svc.disableAddon("t1", "msrp")).resolves.toBeDefined();

    expect(del).toHaveBeenCalledWith("si_9");
    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, stripeItemId: null } }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });
});

// No REG token in the describe: the two REG tests carry their own tokens, and `PIN T12` below
// must stay OUT of `-t "REG-B(58|73|107)"` (jest matches the full concatenated name) — L-060.
describe("AddonService.enableAddon Stripe refusal", () => {
  it("REG-B107 T8 with a price refuses when the Stripe create fails", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "api_error", statusCode: 500 }));
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["MSRP"],
    });

    const attempt = svc.enableAddon("t1", "msrp", "price_1");
    // Message oracle first — T8 and T9 reject on the same resolved fixture, so without the
    // message they are separated only by the exception class.
    await expect(attempt).rejects.toThrow(/Could not create the Stripe subscription item/);
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Separates T8 from T9: T8 refuses only AFTER a real Stripe create attempt (503),
    // T9 refuses BEFORE ever calling Stripe (409). Without this the two are indistinguishable.
    expect(create).toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("REG-B107 T9 with a price refuses a tenant without a Stripe subscription", async () => {
    const create = jest.fn();
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: null },
      publishedSkus: ["MSRP"],
    });

    const attempt = svc.enableAddon("t1", "msrp", "price_1");
    // Message oracle first — see T8: the class is the only other separator between them.
    await expect(attempt).rejects.toThrow(/has no active Stripe subscription/);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("PIN T12: no stripePriceId (free-grant) resolves without touching Stripe, even when Stripe is configured", async () => {
    const create = jest.fn();
    const { svc, prisma } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      publishedSkus: ["MSRP"],
    });

    await expect(svc.enableAddon("t1", "msrp")).resolves.toBeDefined();
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("PIN T15: a successful Stripe create persists the real Stripe item id on the row", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["MSRP"],
    });

    await expect(svc.enableAddon("t1", "msrp", "price_1")).resolves.toBeDefined();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ subscription: "sub_1", price: "price_1" }),
    );
    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ stripeItemId: "si_9", active: true }),
        update: expect.objectContaining({ stripeItemId: "si_9", active: true }),
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });
});

// B342: enabling a priced add-on twice created TWO Stripe subscription items while only ONE
// `stripeItemId` pointer survived the final upsert — double billing with a single handle to stop
// it. The sequential case was already guarded (`existing?.active` throws `ConflictException`
// before Stripe is ever touched); the live defect was a check-then-act RACE with no lock around
// the existing-check -> Stripe-create -> upsert sequence, so two concurrent calls could both pass
// the guard. `enableAddon` now serialises that whole window per (tenantId, addonKey) through
// `withAdvisoryLock` (`common/db-locks.ts`), the same primitive customer-order merges use.
describe("AddonService.enableAddon — B342 concurrency lock", () => {
  it("REG-B342 guard (sequential, unchanged): a second enable while the row is already active is refused before Stripe, no second item created", async () => {
    const create = jest.fn();
    const { svc, prisma } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      existingAddon: { id: "addon1", addonKey: "ai_scanning", active: true },
    });

    await expect(svc.enableAddon("t1", "ai_scanning", "price_1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(create).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });

  // FINDING-3 (round 3 review): both add-on paths took a lock, but on DIFFERENT keys — this
  // admin path on the raw addonKey, the tenant self-serve path in subscription-mutation on the
  // SKU. For the four LEGACY_ADDON_KEY_TO_SKU-bridged add-ons that meant two locks for one
  // entitlement, so the paths raced each other despite both being "locked". The key is now
  // normalised to the SKU on this side.
  it("REG-B342 a bridged addonKey locks on its SKU, so the admin path serialises against the tenant self-serve path", async () => {
    mockWithAdvisoryLock.mockClear();
    const { svc } = make({
      stripe: { isConfigured: false },
      existingAddon: { id: "addon1", addonKey: "tobacco_dealer", active: true },
    });

    await expect(svc.enableAddon("t1", "tobacco_dealer")).rejects.toBeInstanceOf(ConflictException);

    // RED before the fix, which passed "addon:t1:tobacco_dealer" and never met the tenant path.
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "billing", key: "addon:t1:REGULATED_ITEMS" }),
      expect.any(Function),
    );
  });

  it("guard: an UNBRIDGED addonKey has no tenant-path equivalent and still keys on itself", async () => {
    mockWithAdvisoryLock.mockClear();
    const { svc } = make({
      stripe: { isConfigured: false },
      existingAddon: { id: "addon1", addonKey: "developer_mode", active: true },
    });

    await expect(svc.enableAddon("t1", "developer_mode")).rejects.toBeInstanceOf(ConflictException);

    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ family: "billing", key: "addon:t1:developer_mode" }),
      expect.any(Function),
    );
  });

  it("REG-B342 race: two concurrent enableAddon calls for the same tenant+addon create exactly ONE Stripe item and ONE row — the loser is refused, never double-billed", async () => {
    // A STATEFUL TenantAddon "row", unlike the static mocks above: the second call, once
    // serialised behind the first by the (mocked) advisory lock, must observe the FIRST call's
    // committed write — exactly what a real Postgres advisory lock guarantees across replicas.
    // Before the fix (no lock at all) both calls read `null` here regardless of order, which is
    // precisely how B342 double-bills: both pass the existing-addon guard, both call Stripe.
    let row: { active: boolean; stripeItemId: string | null } | null = null;
    const tenantAddon = {
      findUnique: jest.fn(async () => (row ? { ...row } : null)),
      upsert: jest.fn(async ({ create }: any) => {
        row = { active: true, stripeItemId: create.stripeItemId };
        return { id: "addon1", ...row };
      }),
      update: jest.fn(),
    };
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }) },
      tenantAddon,
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue({ stripeSubId: "sub_1" }) },
    } as any;
    let nextItemId = 0;
    const create = jest.fn(async () => ({ id: `si_${++nextItemId}` }));
    const stripe = { isConfigured: true, client: { subscriptionItems: { create } } } as any;
    const entitlements = { invalidate: jest.fn() } as any;
    // "ai_scanning" is not in LEGACY_ADDON_KEY_TO_SKU, so the catalog is never consulted.
    const catalog = { getPublishedCatalog: jest.fn() } as any;
    const featureResolver = { invalidate: jest.fn() } as any;
    const svc = new AddonService(prisma, stripe, entitlements, catalog, featureResolver);

    const [a, b] = await Promise.allSettled([
      svc.enableAddon("t1", "ai_scanning", "price_1"),
      svc.enableAddon("t1", "ai_scanning", "price_1"),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    // The whole point of the lock: only ONE Stripe subscription item is ever created and only
    // ONE row write happens — the loser never reaches Stripe at all.
    expect(create).toHaveBeenCalledTimes(1);
    expect(tenantAddon.upsert).toHaveBeenCalledTimes(1);

    // Structural pin: the lock actually wraps the critical section, keyed per (tenantId, addonKey).
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "addon:t1:ai_scanning", mode: "wait" }),
      expect.any(Function),
    );
  });
});

describe("AddonService.enableAddon — B524 requires enforcement", () => {
  it("a key with no registry entry is a no-op passthrough (never calls featureResolver.resolve)", async () => {
    const { svc, prisma, featureResolver } = make();
    await svc.enableAddon("t1", "some_legacy_key_not_in_registry");
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(featureResolver.resolve).not.toHaveBeenCalled();
  });

  it("a registered key with no `requires` is a no-op passthrough", async () => {
    // "recurring_routes" is a real FEATURE_REGISTRY row with no `requires` and, unlike "msrp",
    // isn't SKU-bridged — no publishedSkus fixture needed to get past an unrelated check first.
    const { svc, prisma, featureResolver } = make();
    await svc.enableAddon("t1", "recurring_routes");
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(featureResolver.resolve).not.toHaveBeenCalled();
  });

  it("400s driver_payments (requires anyOf recurring_routes/order_delivery) when neither is effective, writes nothing", async () => {
    const { svc, prisma } = make({ effectiveKeys: [] });
    await expect(svc.enableAddon("t1", "driver_payments")).rejects.toThrow(BadRequestException);
    await expect(svc.enableAddon("t1", "driver_payments")).rejects.toThrow(
      /depends on .*acme.*does not currently have/,
    );
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });

  it("enables driver_payments when ONE of the anyOf prerequisites is effective", async () => {
    const { svc, prisma } = make({ effectiveKeys: ["recurring_routes"] });
    await svc.enableAddon("t1", "driver_payments");
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
  });

  it("enables driver_payments with neither prerequisite when acknowledgeUnmetRequires is true", async () => {
    const { svc, prisma, featureResolver } = make({ effectiveKeys: [] });
    await svc.enableAddon("t1", "driver_payments", undefined, true);
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    // Acknowledged — the check short-circuits before ever resolving effective keys.
    expect(featureResolver.resolve).not.toHaveBeenCalled();
  });

  it("proceeds (fails open) when featureResolver.resolve itself fails (returns null) — a separate, already-surfaced failure mode", async () => {
    const { svc, prisma } = make({ effectiveKeys: null });
    await svc.enableAddon("t1", "driver_payments");
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
  });
});
