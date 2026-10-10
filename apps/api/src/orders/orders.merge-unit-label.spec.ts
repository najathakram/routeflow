/**
 * B649 — the staff `POST /orders` merge (mergeChoice: "merge") drops a Case's
 * `unitLabel` on the way through `foldMergeItems`, so a unit-sold line merged into an
 * open order is silently repriced as a pack. RE-VERIFIED against the current tree (this
 * bug was filed from a source-only read of an older master snapshot, code-read only,
 * never run) before this fix: `MergeIncomingItem` (merge-items.ts) has no `unitLabel`
 * field, `foldMergeItems` never reads or forwards one, and the existing unit-aware fence
 * (`assertOrderEditAllowed`, called inside `updateOrderItems`) only inspects the ORDER's
 * pre-fold `lineItems` — by the time it runs, the fold has already happened and the
 * label is already gone. Fixed by refusing the merge (409 UNIT_AWARE_LINE) while the
 * real `unitLabel` is still on the wire, in `OrdersController.create`'s merge branch,
 * before `foldMergeItems` ever sees the payload — same fail-closed posture as every
 * other un-converted rewrite path (see unit-aware-guard.ts's own doc comment).
 *
 * Harness: the same pattern as `orders.merge-idempotency.spec.ts`'s T1-T3 tests — a
 * hand-built fake `OrdersService` (not a real one; `foldMergeItems`/the new guard are
 * the real code under test, both called directly by the real `OrdersController`) wired
 * into a real `OrdersController`. jest.mock blocks for InvoicesService/
 * NotificationsService/db-locks copied verbatim from that file — required because
 * `OrdersController` imports `OrdersService`, which transitively imports ESM-only
 * modules Jest cannot traverse.
 */

// Mock InvoicesService before it's imported — prevents Jest from traversing
// invoice-pdf.service.ts which imports @react-pdf/renderer (ESM-only module).
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    createInvoiceFromOrder: jest
      .fn()
      .mockResolvedValue([{ id: "inv-1", invoiceNumber: "INV-1", total: 0 }]),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue(undefined),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
  })),
}));

// Mock NotificationsService — it imports expo-server-sdk which is ESM-only
// and fails Jest's CommonJS parser.
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
  })),
}));

// See orders.scan-hardening.spec.ts for the full rationale: an in-memory FIFO
// per-key serializer standing in for the real Postgres advisory lock, so the
// controller's merge branch (which imports `withAdvisoryLock` from this
// module) runs its critical section exactly as in production, without
// touching Postgres.
jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public readonly family: string,
      public readonly key: string,
      public readonly waitMs: number,
    ) {
      super(`advisory lock timeout: ${family}:${key} after ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public readonly cause?: unknown) {
      super("advisory lock unavailable");
      this.name = "LockUnavailableError";
    }
  }
  const chains = new Map<string, Promise<unknown>>();
  const withAdvisoryLock = jest.fn(
    async (
      opts: { family: string; key: string; mode: "wait" | "try"; waitMs?: number },
      fn: () => Promise<unknown>,
    ) => {
      const chainKey = `${opts.family}:${opts.key}`;
      const prior = chains.get(chainKey) ?? Promise.resolve();
      const turn = prior.catch(() => undefined).then(async () => fn());
      chains.set(
        chainKey,
        turn.then(
          () => undefined,
          () => undefined,
        ),
      );
      const value = await turn;
      return { acquired: true, value };
    },
  );
  return { withAdvisoryLock, LockTimeoutError, LockUnavailableError };
});

import { ConflictException } from "@nestjs/common";
import { OrdersController } from "./orders.controller";
import { UNIT_AWARE_LINE } from "./unit-aware-guard";

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const buildController = (svc: any) => new OrdersController(svc, {} as any, {} as any, {} as any);

const activeOrderFixture = {
  id: "ord-active",
  orderNumber: "ORD-1",
  status: "PENDING",
  createdAt: new Date(),
  customerId: "cust-1",
  total: 96,
  // No existing unit-aware line — the gap B649 covers is a NEW unit line arriving in
  // the merge payload, which the existing fence (order.lineItems-only) never sees.
  lineItems: [
    {
      id: "li-1",
      productId: "prod-1",
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitPrice: 20,
      unitsPerBox: 24,
    },
  ],
};

function fakeOrdersService() {
  return {
    findActiveOrder: jest.fn(async () => ({ ...activeOrderFixture })),
    findOrderIdByIdempotencyKey: jest.fn().mockResolvedValue(null),
    updateOrderItems: jest.fn().mockResolvedValue(undefined),
    recordIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    // Post-commit sweep, unrelated to this bug — always reached on a non-replayed merge.
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    findOne: jest.fn().mockResolvedValue({ id: "ord-active" }),
  };
}

const mergeDto = (item: Record<string, unknown>) =>
  ({ customerId: "cust-1", mergeChoice: "merge", items: [item] }) as any;

describe("OrdersController.create — staff merge refuses a unit-aware incoming line (B649)", () => {
  it("a Case-labeled incoming item is refused with 409 UNIT_AWARE_LINE, before foldMergeItems ever runs", async () => {
    const svc = fakeOrdersService();
    const controller = buildController(svc);

    await expect(
      controller.create(
        mergeDto({ productId: "prod-2", qty: 3, unitLabel: "Case" }),
        operatorPayload as any,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: UNIT_AWARE_LINE }),
    });

    // The refusal happens BEFORE the fold — updateOrderItems must never be reached,
    // so a Case count can never be silently written as pack pieces.
    expect(svc.updateOrderItems).not.toHaveBeenCalled();
  });

  it("SA-142: the refusal message points at the CREATE-path remedy, not the edit-an-existing-order one", async () => {
    const svc = fakeOrdersService();
    const controller = buildController(svc);

    let message = "";
    try {
      await controller.create(
        mergeDto({ productId: "prod-2", qty: 3, unitLabel: "Case" }),
        operatorPayload as any,
      );
    } catch (err: any) {
      message = err.response?.message ?? "";
    }
    expect(message).toContain("Create as a separate order");
    expect(message).not.toContain("Edit it from the web order screen");
  });

  it("RED PROOF — reverting the guard reproduces the exact drop this bug is about: the merge proceeds and unitLabel is gone from the folded payload", async () => {
    // The real (buggy) shape, reconstructed here rather than reverted in source: what
    // foldMergeItems ALONE produces for a unit-labeled incoming item, with no guard in
    // front of it. This is exactly what orders.controller.ts called before this fix.
    const { foldMergeItems } = require("./merge-items");
    // foldMergeItems returns { items, livePackFallbackProductIds } (B776/SA-124, merged in
    // alongside this test) -- was a plain array when this test was first written.
    const { items: merged } = foldMergeItems(
      [],
      [{ productId: "prod-2", qty: 3, unitLabel: "Case" } as any],
    );

    expect(merged).toHaveLength(1);
    // The bug, stated as a value: unitLabel never survives the fold, so
    // updateOrderItems (and the pricing it does) never learns this was a Case line.
    expect(merged[0]).not.toHaveProperty("unitLabel");
    expect((merged[0] as any).qty).toBe(3); // 3 Cases silently became "3 loose pieces"
  });

  it("a plain (non-unit) merge is unaffected — still reaches updateOrderItems, byte-identical behaviour", async () => {
    const svc = fakeOrdersService();
    const controller = buildController(svc);

    await controller.create(mergeDto({ productId: "prod-1", qty: 5 }), operatorPayload as any);

    expect(svc.updateOrderItems).toHaveBeenCalledTimes(1);
  });
});
