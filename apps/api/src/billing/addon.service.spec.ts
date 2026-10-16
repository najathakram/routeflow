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
import { fakeTenantAddonStore } from "../testing/fake-tenant-addon-store";
import { mrrEmits } from "../testing/mrr-emits";

beforeEach(() => {
  lockQueues.clear();
  mockWithAdvisoryLock.mockClear();
});

function published(skus: string[], includedAtPlan: Record<string, string> = {}) {
  return {
    definitions: [
      { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
      { planKey: "SCALE", name: "Scale", monthlyPrice: 499 },
    ],
    addonSkus: skus.map((sku) => ({
      sku,
      name: sku,
      monthlyPrice: 10,
      ...(includedAtPlan[sku] ? { includedAtPlan: includedAtPlan[sku] } : {}),
    })),
  };
}

interface Opts {
  existingAddon?: any;
  publishedSkus?: string[];
  /** SA-786: the catalog's `includedAtPlan` per published SKU. */
  includedAtPlan?: Record<string, string>;
  /** Override the default unconfigured Stripe mock — e.g. `{ isConfigured: true, client: { subscriptionItems: { del: jest.fn()... } } }`. */
  stripe?: any;
  /** Override tenantSubscription.findUnique's resolved value (default null — no Stripe sub). */
  subscription?: any;
  /** B524 fix round: `authority.assertFeatureRequiresMet` is a jest.fn() resolving/rejecting
   *  per this — the requires LOGIC itself now lives in
   *  `entitlement-authority.requires.spec.ts`, so this suite only needs to prove AddonService
   *  calls the shared check with the right (translated) key and surfaces its rejection. */
  assertFeatureRequiresMet?: jest.Mock;
  /** B865 / SA-277: the tenant row `emitAddonDelta` reads INSIDE the tx to decide whether an
   *  enable/disable books a ledger delta (status/class/deletedAt/subscription.planKey — the
   *  `isPayingRow` shape). Defaults to a paying (ACTIVE/PRODUCTION) row so the pre-existing
   *  priced-enable pins (T8/T9/T15, B342) keep booking unless a test overrides it. */
  tenantRow?: any;
}

function make(opts: Opts = {}) {
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }),
      // B865 / SA-277 (D2 lock shape): the ledger helper's paying-set read, under the tx lock.
      findUniqueOrThrow: jest.fn().mockResolvedValue(
        opts.tenantRow ?? {
          status: "ACTIVE",
          class: "PRODUCTION",
          deletedAt: null,
          subscription: { planKey: "SCALE" },
        },
      ),
    },
    tenantAddon: {
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      // #2188: findAddonRow reads via findFirst — delegate so each fixture's findUnique sequence still drives it.
      findFirst: jest.fn(function (this: any, args: unknown) {
        return this.findUnique(args);
      }),
      upsert: jest.fn().mockResolvedValue({ id: "addon1", active: true }),
      update: jest.fn().mockResolvedValue({ id: "addon1", active: false }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(opts.subscription ?? null) },
    // B865 / SA-277: enableAddon/disableAddon now write + book through the SAME tx.
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  const stripe = opts.stripe ?? ({ isConfigured: false, client: {} } as any);
  const entitlements = { invalidate: jest.fn() } as any;
  const catalog = {
    getPublishedCatalog: jest
      .fn()
      .mockResolvedValue(published(opts.publishedSkus ?? [], opts.includedAtPlan)),
  } as any;
  const featureResolver = { invalidate: jest.fn() } as any;
  const authority = {
    assertFeatureRequiresMet:
      opts.assertFeatureRequiresMet ?? jest.fn().mockResolvedValue(undefined),
  } as any;
  // B865 / SA-277: 7th ctor arg, the ledger's BillingEventService — cast the class to bypass
  // the (not-yet-updated) 6-arg constructor type until FIX-865B lands.
  const events = { emit: jest.fn().mockResolvedValue({}) } as any;
  const svc = new (AddonService as any)(
    prisma,
    stripe,
    entitlements,
    catalog,
    featureResolver,
    authority,
    events,
  );
  return { svc, prisma, entitlements, catalog, stripe, featureResolver, authority, events };
}

const deltasOf = (events: any, type: string) =>
  events.emit.mock.calls.filter((c: any[]) => c[1] === type).map((c: any[]) => c[3]?.amountDelta);

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

    // SA-788: written by id through the one writer (the row was read and locked under the tenant lock first).
    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "addon1" } }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    // REG-B509: see the matching note in enableAddon's test above.
    expect(featureResolver.invalidate).toHaveBeenCalledWith("t1");
  });

  // SA-788 A-R13: the admin who disables is on the ledger event AND on the per-change record. On the G1a head the
  // disable carried no actor at all (actorId null) and wrote no record.
  it("A-R13: admin disable records the admin as the actor (ledger event and addon.state_changed)", async () => {
    const { svc, events } = make({
      existingAddon: {
        id: "addon1",
        tenantId: "t1",
        addonKey: "msrp",
        sku: "MSRP",
        active: true,
        priceSnapshot: 20,
        quantity: 1,
      },
    });

    await svc.disableAddon("t1", "msrp", "admin-9");

    const disabled = events.emit.mock.calls.find((c: any[]) => c[1] === "addon.disabled");
    expect(disabled?.[3].actorId).toBe("admin-9");
    const record = events.emit.mock.calls.find((c: any[]) => c[1] === "addon.state_changed");
    expect(record?.[2]).toMatchObject({
      source: "admin.disable",
      actor: { kind: "PLATFORM_ADMIN", id: "admin-9" },
      changes: { active: [true, false] },
    });
    expect(record?.[3].amountDelta).toBeNull();
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
// SA-786 S7 / R11: an admin enable that carries a Stripe price at a plan which INCLUDES the SKU would book a charge
// the plan already covers (SA-785 Q3). It is refused before any Stripe call or row write; without a price it is the
// free grant (price 0, nothing booked) the owner ruling describes.
describe("AddonService.enableAddon - an included add-on is never billed on top (SA-786 S7)", () => {
  const includedAtScale = { REGULATED_ITEMS: "SCALE" };
  const atScale = (extra: Record<string, unknown> = {}) => ({
    stripeSubId: "sub_1",
    planKey: "SCALE",
    ...extra,
  });

  it("R11: WITH a stripePriceId at SCALE -> 409 ADDON_INCLUDED_IN_PLAN, zero Stripe calls, no row", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma, events } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: atScale(),
      publishedSkus: ["REGULATED_ITEMS"],
      includedAtPlan: includedAtScale,
    });

    const err: any = await svc
      .enableAddon("t1", "REGULATED_ITEMS", "price_x")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "ADDON_INCLUDED_IN_PLAN",
      message: "This add-on is included in Scale. Enable it without a price.",
    });
    expect(create).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(mrrEmits(events)).toHaveLength(0);
  });

  it("WITHOUT a price at SCALE it proceeds: the row is written at $0 and nothing is booked", async () => {
    const create = jest.fn();
    const { svc, prisma, events } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: atScale(),
      publishedSkus: ["REGULATED_ITEMS"],
      includedAtPlan: includedAtScale,
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS");

    expect(create).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ priceSnapshot: 0 }) }),
    );
    expect(mrrEmits(events)).toHaveLength(0);
  });

  it("below the including plan a priced enable is unchanged (GROWTH bills the item)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: atScale({ planKey: "GROWTH" }),
      publishedSkus: ["REGULATED_ITEMS"],
      includedAtPlan: includedAtScale,
    });
    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a catalog entry whose includedAtPlan names no plan fails a priced enable closed (409 ADDON_CATALOG_INVALID, B1102)", async () => {
    const create = jest.fn();
    const { svc, prisma } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: atScale(),
      publishedSkus: ["REGULATED_ITEMS"],
      includedAtPlan: { REGULATED_ITEMS: "SCAEL" },
    });
    const err: any = await svc
      .enableAddon("t1", "REGULATED_ITEMS", "price_x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "ADDON_CATALOG_INVALID" });
    expect(create).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });
});

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
      // #2188: findAddonRow reads via findFirst — delegate so each fixture's findUnique sequence still drives it.
      findFirst: jest.fn(function (this: any, args: unknown) {
        return this.findUnique(args);
      }),
      upsert: jest.fn(async ({ create }: any) => {
        row = { active: true, stripeItemId: create.stripeItemId };
        return { id: "addon1", ...row };
      }),
      update: jest.fn(),
    };
    const prisma: any = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }),
        // B865 / SA-277: the ledger helper's paying-set read under the tx lock (harness note).
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: "ACTIVE",
          class: "PRODUCTION",
          deletedAt: null,
          subscription: { planKey: "SCALE" },
        }),
      },
      tenantAddon,
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue({ stripeSubId: "sub_1" }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    let nextItemId = 0;
    const create = jest.fn(async () => ({ id: `si_${++nextItemId}` }));
    const stripe = { isConfigured: true, client: { subscriptionItems: { create } } } as any;
    const entitlements = { invalidate: jest.fn() } as any;
    // B865 / SA-277 harness note: a priced enable now looks up the catalog UNCONDITIONALLY
    // (not only for a bridged legacy key), so this race test moved off the unbridged
    // "ai_scanning" (whose catalog stub used to be a bare `jest.fn()`, deliberately never
    // resolved) onto "msrp" — bridged to the published "MSRP" SKU — so a priced enable can
    // still resolve a `skuDef` and reach the Stripe/upsert race this test exists to prove.
    const catalog = {
      getPublishedCatalog: jest
        .fn()
        .mockResolvedValue({ addonSkus: [{ sku: "MSRP", name: "MSRP", monthlyPrice: 10 }] }),
    } as any;
    const featureResolver = { invalidate: jest.fn() } as any;
    const authority = { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any;
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const svc = new (AddonService as any)(
      prisma,
      stripe,
      entitlements,
      catalog,
      featureResolver,
      authority,
      events,
    );

    const [a, b] = await Promise.allSettled([
      svc.enableAddon("t1", "msrp", "price_1"),
      svc.enableAddon("t1", "msrp", "price_1"),
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

    // Structural pin: the lock actually wraps the critical section, keyed per (tenantId, SKU) —
    // "msrp" bridges to "MSRP" (same lock-key shape as the pre-edit "addon:t1:ai_scanning").
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      expect.objectContaining({ key: "addon:t1:MSRP", mode: "wait" }),
      expect.any(Function),
    );
  });
});

/**
 * F2 (pre-merge review, 2026-09-25): the pre-check `existing?.active` (line ~179) runs OUTSIDE
 * the tx, before the Stripe item is even created — `SubscriptionMutationService.enableAddon`
 * (the tenant self-serve path, `subscription-mutation.service.ts`) holds NO advisory lock
 * against this admin path (its own lock is keyed per its own call, not shared), so it can
 * activate the SAME row between this admin's pre-check and its tx. Before the fix, the tx
 * always booked `before: {0,0}` unconditionally — double-booking the add-on's contribution on
 * top of whatever the concurrent subscribe() already booked. The fix re-checks under the lock,
 * INSIDE the tx, and refuses (+ best-effort deletes the now-orphaned Stripe item) instead.
 */
describe("AddonService.enableAddon — F2 activation race with the tenant self-serve path", () => {
  it("F2: the row is already active by the time the lock is held — refuses instead of double-booking, and cleans up the orphan Stripe item", async () => {
    const del = jest.fn().mockResolvedValue({});
    const create = jest.fn().mockResolvedValue({ id: "si_orphan" });
    const { svc, prisma, events } = make({
      publishedSkus: ["MSRP"],
      stripe: { isConfigured: true, client: { subscriptionItems: { create, del } } },
      subscription: { stripeSubId: "sub_1" },
    });
    // Pre-check (outside the tx): not active yet — passes. Locked re-read (inside the tx,
    // after `lockTenantForLedger`): a concurrent subscribe() already activated it at qty 2.
    prisma.tenantAddon.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "addon1",
      active: true,
      quantity: 2,
      priceSnapshot: 10,
    });

    await expect(svc.enableAddon("t1", "msrp", "price_1")).rejects.toBeInstanceOf(
      ConflictException,
    );

    // The orphan Stripe item THIS call created is cleaned up best-effort.
    expect(del).toHaveBeenCalledWith("si_orphan");
    // No double-booked ledger event, and no row write from the losing call.
    expect(mrrEmits(events)).toHaveLength(0);
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });
});

describe("AddonService.enableAddon — B524 requires enforcement (delegates to EntitlementAuthority)", () => {
  // The requires LOGIC (allOf/anyOf, fail-open, the ack short-circuit) is tested once, directly
  // on `EntitlementAuthority.assertFeatureRequiresMet` (`entitlement-authority.requires.spec.ts`
  // — see the B524 fix round comment there). This suite only proves AddonService calls that
  // shared check with the right (namespace-translated) key/tenant/ack, and stops the write when
  // it rejects.

  it("calls authority.assertFeatureRequiresMet with the bare addonKey unchanged for an unbridged key", async () => {
    const { svc, authority } = make();
    await svc.enableAddon("t1", "driver_payments", undefined, true);
    expect(authority.assertFeatureRequiresMet).toHaveBeenCalledWith("t1", "driver_payments", true);
  });

  // F2 (Opus review): the two RequirePlanFlag-bridged legacy addon keys must be translated to
  // their REGISTRY key before the shared check runs, or it silently looks up nothing.
  it("translates a bridged legacy addonKey (msrp) to its registry key (flag.msrp) via ADDON_KEY_TO_REGISTRY_KEY", async () => {
    const { svc, authority } = make({ publishedSkus: ["MSRP"] });
    await svc.enableAddon("t1", "msrp");
    expect(authority.assertFeatureRequiresMet).toHaveBeenCalledWith("t1", "flag.msrp", undefined);
  });

  it("propagates the shared check's rejection and writes nothing", async () => {
    const rejecting = jest.fn().mockRejectedValue(new BadRequestException("depends on X"));
    const { svc, prisma } = make({ assertFeatureRequiresMet: rejecting });
    await expect(svc.enableAddon("t1", "driver_payments")).rejects.toThrow(BadRequestException);
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });

  it("proceeds to write when the shared check resolves (met, acknowledged, or fail-open — all indistinguishable to AddonService)", async () => {
    const { svc, prisma } = make();
    await svc.enableAddon("t1", "driver_payments");
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
  });
});

// B865 / SA-277: the admin add-on path wrote no `priceSnapshot` and never booked a ledger
// delta at all — see cause-ruling.md SA-277. `enableAddon`/`disableAddon` now route through
// the ONE add-on ledger helper (`emitAddonDelta`, `addon-ledger.ts`, FIX-865A): the row is
// upserted inside a tx, the STORED snapshot is written explicitly (0 for a free grant — D1),
// and the emit is gated on `isPayingRow` read under the tenant lock inside the SAME tx.
describe("AddonService.enableAddon/disableAddon — B865 ledger (SA-277)", () => {
  it("REG-B865-ADMIN priced enable writes priceSnapshot and books +10 for a paying tenant (flips REG-ADMIN-ADDON-MRR, SA-277)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma, events } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["REGULATED_ITEMS"],
      tenantRow: {
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      },
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ priceSnapshot: 10 }),
        update: expect.objectContaining({ priceSnapshot: 10 }),
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      "addon.enabled",
      expect.anything(),
      expect.objectContaining({ amountDelta: 10 }),
    );
  });

  it("REG-B865-ADMIN priced enable on a TRIAL tenant writes the snapshot but books nothing", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma, events } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["REGULATED_ITEMS"],
      tenantRow: {
        status: "TRIAL",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      },
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS", "price_x");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ priceSnapshot: 10 }) }),
    );
    expect(deltasOf(events, "addon.enabled")).toEqual([]);
  });

  it("REG-B865-ADMIN disable books −priceSnapshot×qty from the STORED snapshot", async () => {
    const { svc, events } = make({
      existingAddon: {
        id: "addon1",
        addonKey: "REGULATED_ITEMS",
        active: true,
        priceSnapshot: 10,
        quantity: 2,
        stripeItemId: null,
      },
      tenantRow: {
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      },
    });

    await svc.disableAddon("t1", "REGULATED_ITEMS");

    expect(deltasOf(events, "addon.disabled")).toEqual([-20]);
  });

  it("REG-B865-ADMIN a stripePriceId whose key has no catalog SKU is a 400 before Stripe", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: [],
    });

    await expect(svc.enableAddon("t1", "not_in_catalog", "price_x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
  });

  it("PIN P5 (SA-277a D1): a free grant (no stripePriceId) of a published SKU writes priceSnapshot 0 explicitly and books nothing", async () => {
    const { svc, prisma, events } = make({
      publishedSkus: ["REGULATED_ITEMS"],
      tenantRow: {
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      },
    });

    await svc.enableAddon("t1", "REGULATED_ITEMS");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ priceSnapshot: 0 }),
        update: expect.objectContaining({ priceSnapshot: 0 }),
      }),
    );
    expect(mrrEmits(events)).toHaveLength(0);
  });

  it("PIN P6: an unbridged key with no SKU and no price (developer_mode) still resolves, no emit", async () => {
    const { svc, prisma, events } = make({
      tenantRow: {
        status: "ACTIVE",
        class: "PRODUCTION",
        deletedAt: null,
        subscription: { planKey: "SCALE" },
      },
    });

    await expect(svc.enableAddon("t1", "developer_mode")).resolves.toBeDefined();
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(mrrEmits(events)).toHaveLength(0);
  });
});

// #2188 / SA-385 (5): an add-on keyed two ways must never become two rows or a doubled ledger.
// A stateful store proves ROW COUNTS; the DB lane (F2) proves the same on real Postgres.
describe("#2188 one add-on row whichever way it is keyed (SA-385)", () => {
  const booked = (events: any) =>
    events.emit.mock.calls.reduce((sum: number, c: any[]) => sum + (c[3]?.amountDelta ?? 0), 0);
  const priced = (seed: Parameters<typeof fakeTenantAddonStore>[0]) => {
    const create = jest.fn().mockResolvedValue({ id: "si_1" });
    const del = jest.fn().mockResolvedValue({});
    const made = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create, del } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["MSRP"],
    });
    const store = fakeTenantAddonStore(seed);
    made.prisma.tenantAddon = store;
    return { ...made, store, create };
  };

  it("SA-385b (a): legacy key then SKU key — refused, still ONE row, booked once", async () => {
    const { svc, store, events, create } = priced([]);
    await svc.enableAddon("t1", "msrp", "price_msrp");
    await expect(svc.enableAddon("t1", "MSRP", "price_msrp")).rejects.toThrow(ConflictException);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ addonKey: "msrp", sku: "MSRP", active: true });
    expect(create).toHaveBeenCalledTimes(1); // one Stripe item
    expect(booked(events)).toBe(10); // +X once
  });

  it("SA-385b (a) reverse: SKU key then legacy key — refused, still ONE row, booked once", async () => {
    const { svc, store, events, create } = priced([]);
    await svc.enableAddon("t1", "MSRP", "price_msrp");
    await expect(svc.enableAddon("t1", "msrp", "price_msrp")).rejects.toThrow(ConflictException);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ addonKey: "MSRP", sku: "MSRP", active: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(booked(events)).toBe(10);
  });

  // SA-385b (b): the row subscribe() writes is SKU-keyed (addonKey = sku = code); seeded in that
  // exact shape, then an admin legacy-key enable must find it. (subscribe() itself only accepts
  // SELF_SERVICE_ADDON_SKUS today, none legacy-mapped — the shape is the reachable part.)
  it("SA-385b (b): a subscribe()-shaped SKU row, then admin enable by the legacy key — one row, no second booking", async () => {
    const { svc, store, events } = priced([
      { addonKey: "MSRP", sku: "MSRP", active: true, priceSnapshot: 10 },
    ]);
    await expect(svc.enableAddon("t1", "msrp", "price_msrp")).rejects.toThrow(ConflictException);
    expect(store.rows).toHaveLength(1);
    expect(booked(events)).toBe(0);
  });

  it("SA-385b (c): disable by EITHER key finds the row and books −X once", async () => {
    for (const key of ["msrp", "MSRP"]) {
      const { svc, store, events } = priced([
        { addonKey: "MSRP", sku: "MSRP", active: true, priceSnapshot: 10 },
      ]);
      await svc.disableAddon("t1", key);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0].active).toBe(false);
      expect(booked(events)).toBe(-10);
    }
  });

  it("SA-385b (c): re-enable after disable re-activates the SAME row in place (still one row)", async () => {
    const { svc, store, events } = priced([
      { addonKey: "msrp", sku: "MSRP", active: false, priceSnapshot: 10 },
    ]);
    await svc.enableAddon("t1", "MSRP", "price_msrp");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ id: "row1", addonKey: "msrp", active: true });
    expect(booked(events)).toBe(10);
  });

  it("hasAddon resolves the add-on after either path wrote it", async () => {
    for (const seedKey of ["msrp", "MSRP"]) {
      const { svc } = priced([{ addonKey: seedKey, sku: "MSRP", active: true }]);
      await expect(svc.hasAddon("t1", "msrp")).resolves.toBe(true);
      await expect(svc.hasAddon("t1", "MSRP")).resolves.toBe(true);
    }
  });
});
