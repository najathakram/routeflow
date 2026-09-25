/**
 * B865 / SA-277 (T14): `emitAddonDelta` is the ONE add-on ledger writer (FIX-865A,
 * `addon-ledger.ts`) — every enable/disable call site (admin `AddonService` and the two
 * self-serve `SubscriptionMutationService` sites) routes through it inside its own tx. It
 * must lock the tenant row (SA-163 shape), read the paying-set inputs UNDER that lock, and
 * book ±priceSnapshot × deltaQty ONLY for a currently-paying row (`isPayingRow`,
 * `mrr.service.ts`) — a TRIAL tenant's add-on is booked once, at activation, from the same
 * stored snapshot, never here. This file does not exist yet (created by FIX-865A) — importing
 * it is the RED state for this task.
 */
import { emitAddonDelta } from "./addon-ledger";
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
  it("REG-B865-LEDGER emitAddonDelta books ±snapshot×deltaQty only for a paying row", async () => {
    // Paying tenant, deltaQty 2, stored snapshot 12 → books 24 and forwards the SAME tx to
    // the emit, so the row write and the ledger row are atomic.
    const tx = makeTx(PAYING_ROW);
    const events = { emit: jest.fn().mockResolvedValue({}) } as any;
    const amount = await emitAddonDelta(tx, events, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      priceSnapshot: 12,
      deltaQty: 2,
    });
    expect(amount).toBe(24);
    expect(events.emit).toHaveBeenCalledWith(
      "t1",
      BILLING_EVENTS.ADDON_ENABLED,
      expect.objectContaining({ sku: "CUSTOMER_PACK_100" }),
      expect.objectContaining({ amountDelta: 24, tx }),
    );
    // Lock-order pin (SA-277a D2 shape): the FOR UPDATE lock runs before the paying-set read.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tenant.findUniqueOrThrow.mock.invocationCallOrder[0],
    );

    // A TRIAL tenant books nothing — the delta is deferred to activation.
    const trialTx = makeTx(TRIAL_ROW);
    const trialEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const trialAmount = await emitAddonDelta(trialTx, trialEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      priceSnapshot: 12,
      deltaQty: 2,
    });
    expect(trialAmount).toBe(0);
    expect(trialEvents.emit).not.toHaveBeenCalled();

    // deltaQty 0 (an idempotent re-enable at the same qty) emits nothing.
    const zeroTx = makeTx(PAYING_ROW);
    const zeroEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const zeroAmount = await emitAddonDelta(zeroTx, zeroEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      priceSnapshot: 12,
      deltaQty: 0,
    });
    expect(zeroAmount).toBe(0);
    expect(zeroEvents.emit).not.toHaveBeenCalled();

    // A null stored snapshot (a free grant, D1) emits nothing.
    const nullSnapTx = makeTx(PAYING_ROW);
    const nullSnapEvents = { emit: jest.fn().mockResolvedValue({}) } as any;
    const nullSnapAmount = await emitAddonDelta(nullSnapTx, nullSnapEvents, {
      tenantId: "t1",
      sku: "CUSTOMER_PACK_100",
      priceSnapshot: null,
      deltaQty: 2,
    });
    expect(nullSnapAmount).toBe(0);
    expect(nullSnapEvents.emit).not.toHaveBeenCalled();
  });
});
