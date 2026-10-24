/**
 * B865 / SA-277 (T14): `emitAddonDelta` is the ONE add-on ledger writer (FIX-865A,
 * `addon-ledger.ts`) — every enable/disable call site (admin `AddonService` and the two
 * self-serve `SubscriptionMutationService` sites) routes through it inside its own tx. It
 * must lock the tenant row (SA-163 shape, via `lockTenantForLedger`), read the paying-set
 * inputs UNDER that lock, and book the CHANGE between `before` and `after` ONLY for a
 * currently-paying row (`isPayingRow`, `mrr.service.ts`) — a TRIAL tenant's add-on is booked
 * once, at activation, from the same stored snapshot, never here.
 *
 * SA-277: the helper's contract is `before`/`after` ({priceSnapshot, quantity}) rather than a
 * flat priceSnapshot+deltaQty — amountDelta = roundMoney(after.snap×after.qty −
 * before.snap×before.qty), and a zero delta (a free grant, or a no-op) writes NO event.
 */
import { emitAddonDelta, bookAddonsOnCrossing } from "./addon-ledger";
import { BILLING_EVENTS } from "./plan-catalog.constants";

function makeTx(tenantRow: any) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue(tenantRow) },
  } as any;
}

const PAYING_ROW = {
  status: "ACTIVE",
  class: "PRODUCTION",
  deletedAt: null,
  subscription: { planKey: "SCALE" },
};

const TRIAL_ROW = {
  status: "TRIAL",
  class: "PRODUCTION",
  deletedAt: null,
  subscription: { planKey: "SCALE" },
};

describe("addon-ledger.emitAddonDelta", () => {
  it("B1187: a payload carrying its own sku can never overwrite the real sku", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 0, quantity: 0 },
      after: { priceSnapshot: 12, quantity: 1 },
      payload: { sku: "other", quantity: 1 },
    });
    expect(events.emit.mock.calls[0][2]).toEqual({ sku: "CUSTOMER_PACK_100", quantity: 1 });
  });

  it("REG-B865-LEDGER emitAddonDelta books the before/after CHANGE only for a paying row", async () => {
    // Paying tenant, before {snap 0, qty 0} → after {snap 12, qty 2} → books 24 and forwards the
    // SAME tx to the emit, so the row write and the ledger row are atomic.
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const amount = await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 0, quantity: 0 },
      after: { priceSnapshot: 12, quantity: 2 },
    });
    expect(amount).toBe(24);
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_ENABLED,
      expect.objectContaining({ sku: "CUSTOMER_PACK_100" }),
      expect.objectContaining({ amountDelta: 24, tx }),
    );
    // Lock-order pin (SA-277a D2 shape): the FOR UPDATE lock runs before the paying-set read,
    // and the lock statement's argument is the tenantId.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tenant.findUniqueOrThrow.mock.invocationCallOrder[0],
    );
    expect(tx.$queryRaw.mock.calls[0][1]).toBe("t1");

    // A TRIAL tenant books nothing — the delta is deferred to activation/subscribe.
    const trialTx = makeTx(TRIAL_ROW);
    const trialEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const trialAmount = await emitAddonDelta(trialTx, trialEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 0, quantity: 0 },
      after: { priceSnapshot: 12, quantity: 2 },
    });
    expect(trialAmount).toBe(0);
    expect(trialEvents.emit).not.toHaveBeenCalled();
  });

  it("REG-B865-LEDGER negative branch: qty 2→0 books −2×snapshot as ADDON_DISABLED", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const amount = await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 12, quantity: 2 },
      after: { priceSnapshot: 12, quantity: 0 },
    });
    expect(amount).toBe(-24);
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_DISABLED,
      expect.objectContaining({ sku: "CUSTOMER_PACK_100" }),
      expect.objectContaining({ amountDelta: -24, tx }),
    );
  });

  it("SA-277a D1: a zero net change (e.g. a free grant, or an idempotent re-enable at the same price/qty) emits nothing — no lock, no read", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const amount = await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 12, quantity: 1 },
      after: { priceSnapshot: 12, quantity: 1 },
    });
    expect(amount).toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("price-only change (equal quantities): a snapshot bump books ADDON_ENABLED, a snapshot cut books ADDON_DISABLED", async () => {
    const upTx = makeTx(PAYING_ROW);
    const upEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const upAmount = await emitAddonDelta(upTx, upEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 10, quantity: 1 },
      after: { priceSnapshot: 15, quantity: 1 },
    });
    expect(upAmount).toBe(5);
    expect(upEvents.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_ENABLED,
      expect.anything(),
      expect.objectContaining({ amountDelta: 5 }),
    );

    const downTx = makeTx(PAYING_ROW);
    const downEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const downAmount = await emitAddonDelta(downTx, downEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 15, quantity: 1 },
      after: { priceSnapshot: 10, quantity: 1 },
    });
    expect(downAmount).toBe(-5);
    expect(downEvents.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_DISABLED,
      expect.anything(),
      expect.objectContaining({ amountDelta: -5 }),
    );
  });

  it("the label follows the MONEY, not the quantity: a quantity that shrank for a POSITIVE amount is ADDON_ENABLED, one that grew for a negative amount ADDON_DISABLED", async () => {
    // there is no quantity-change event type, and nothing reads the label (the run-rate is Σ amountDelta)
    const shrinkTx = makeTx(PAYING_ROW);
    const shrinkEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    // checkout adoption of a row the tenant set to qty 3 at a stored price 0, onto an item of qty 1 at 45
    const shrink = await emitAddonDelta(shrinkTx, shrinkEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 0, quantity: 3 },
      after: { priceSnapshot: 45, quantity: 1 },
    });
    expect(shrink).toBe(45);
    expect(shrinkEvents.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_ENABLED,
      expect.anything(),
      expect.objectContaining({ amountDelta: 45 }),
    );

    const growTx = makeTx(PAYING_ROW);
    const growEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const grow = await emitAddonDelta(growTx, growEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: 50, quantity: 1 },
      after: { priceSnapshot: 10, quantity: 3 },
    });
    expect(grow).toBe(-20);
    expect(growEvents.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_DISABLED,
      expect.anything(),
      expect.objectContaining({ amountDelta: -20 }),
    );
  });

  it("a null stored snapshot (a free grant, D1) prices as 0 on either side", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const amount = await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      before: { priceSnapshot: null, quantity: 0 },
      after: { priceSnapshot: null, quantity: 1 },
    });
    expect(amount).toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("addon-ledger.bookAddonsOnCrossing", () => {
  it("a never-paying tenant crossing into paying books each add-on's FULL stored contribution", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const total = await bookAddonsOnCrossing(
      tx,
      events,
      "t1",
      [{ sku: "A", priceSnapshot: 19, quantity: 1 }],
      false,
    );
    expect(total).toBe(19);
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_ENABLED,
      expect.objectContaining({ sku: "A" }),
      expect.objectContaining({ amountDelta: 19 }),
    );
  });

  it("an already-paying tenant's kept add-on nets 0 — it was already booked, no crossing to price", async () => {
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const total = await bookAddonsOnCrossing(
      tx,
      events,
      "t1",
      [{ sku: "A", priceSnapshot: 19, quantity: 1 }],
      true,
    );
    expect(total).toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
  });
});
