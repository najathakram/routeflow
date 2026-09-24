import { InvoiceStatus } from "@prisma/client";
import { resolvePostReconcileOrderTotals } from "./complete-payment-reconcile";

describe("resolvePostReconcileOrderTotals (B663/I2 — DELIVERED notification total)", () => {
  it("returns an empty map with no order ids, never querying the db", async () => {
    const db = { invoice: { findMany: jest.fn() } };

    const result = await resolvePostReconcileOrderTotals(db, []);

    expect(result.size).toBe(0);
    expect(db.invoice.findMany).not.toHaveBeenCalled();
  });

  it("sums a single order's non-void invoice totals, rounded", async () => {
    const db = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { orderId: "ord-1", total: 6.001 },
          { orderId: "ord-1", total: 3.999 },
        ]),
      },
    };

    const result = await resolvePostReconcileOrderTotals(db, ["ord-1"]);

    expect(result.get("ord-1")).toBeCloseTo(10, 2);
    expect(db.invoice.findMany).toHaveBeenCalledWith({
      where: { orderId: { in: ["ord-1"] }, status: { not: InvoiceStatus.VOID } },
      select: { orderId: true, total: true },
    });
  });

  // No non-void invoice at all (shouldn't happen for a routed order, but never
  // silently notify a wrong amount): the map simply has no entry for that order,
  // so the caller's `?? Number(o.total)` fallback applies.
  it("an order with no non-void invoice at all has no entry (caller falls back to o.total)", async () => {
    const db = { invoice: { findMany: jest.fn().mockResolvedValue([]) } };

    const result = await resolvePostReconcileOrderTotals(db, ["ord-1"]);

    expect(result.has("ord-1")).toBe(false);
  });

  // Opus review of #1292: by the time this runs, the stop is already committed and
  // saved (fire-and-forget notification prep, post-tx) — a throw here must never
  // surface as a 500 (the caller would see the stop fail to save even though it
  // didn't, the idempotency key would never get stored, and a retry would find
  // "Stop is already completed"). Falls back to an empty map so every order hits
  // the caller's own o.total fallback, exactly like the no-invoice-found case.
  it("a lookup that throws falls back to an empty map instead of propagating", async () => {
    const db = { invoice: { findMany: jest.fn().mockRejectedValue(new Error("boom")) } };
    const logger = { warn: jest.fn() };

    const result = await resolvePostReconcileOrderTotals(db, ["ord-1"], logger);

    expect(result.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("a lookup that throws with no logger given still falls back cleanly", async () => {
    const db = { invoice: { findMany: jest.fn().mockRejectedValue(new Error("boom")) } };

    await expect(resolvePostReconcileOrderTotals(db, ["ord-1"])).resolves.toEqual(new Map());
  });
});
