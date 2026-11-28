/**
 * B1053 (SA-704) — unit pins for the order-merge row guard (merge-lock-recheck.ts). The real-Postgres
 * interleavings live in merge-eligibility-race-b1053.db.spec.ts; these pin the contract that needs no DB.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { ConflictException } from "@nestjs/common";
import { InvoiceStatus, ItemStatus, OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ORDER_LINE_ORDER_BY } from "./line-position";
import { ORDER_HAS_NO_LIVE_DELIVERED_LINE } from "./delivered-line-lock";
import { isMergeContention, mapLockError } from "./merge-contention";
import {
  deleteLoserGuarded,
  lockAndRecheckMergeInputs,
  MERGE_NO_CREDIT_INTENT,
  MERGE_NO_DRAFT_PAYMENT,
  mergeEligibleWhere,
  mergeInputFingerprint,
  readKeptSeparate,
  readMergeGroup,
} from "./merge-lock-recheck";

const line = (over: Record<string, unknown> = {}) => ({
  id: "li-1",
  productId: "p-1",
  status: ItemStatus.PENDING,
  qty: 2,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 5,
  subtotal: 10,
  position: 0,
  ...over,
});
const order = (id: string, over: Record<string, unknown> = {}, lines = [line({ id: `${id}-l` })]) =>
  ({
    id,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    fulfillPath: "ROUTE",
    shippedAt: null,
    lineItems: lines,
    ...over,
  }) as any;

function fakeTx(rereadRows: any[]) {
  const calls: string[] = [];
  const tx: any = {
    calls,
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      calls.push(`sql:${strings.join("?").trim()}`);
      return 0;
    }),
    order: {
      findMany: jest.fn(async () => {
        calls.push("findMany");
        return rereadRows;
      }),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    orderItem: { deleteMany: jest.fn(async () => ({ count: 1 })) },
  };
  return tx;
}

describe("mergeEligibleWhere — one predicate per path", () => {
  it("force never takes an order with a billed Invoice or a Transaction (the FK SET NULL would orphan it)", () => {
    expect(mergeEligibleWhere("force")).toEqual({
      status: OrderStatus.PENDING,
      transaction: { is: null },
      invoices: { none: { status: { not: InvoiceStatus.DRAFT } } },
      returns: { none: {} },
      deliveryMutations: { none: {} },
      ...ORDER_HAS_NO_LIVE_DELIVERED_LINE, // SA-1149: a live delivered line is never a winner or a loser
      // SA-1330 (B1343): money on the order keeps it out: a credit intent (both kinds) and, force, a DRAFT holding a payment
      orderCreditNotes: { none: {} },
      AND: [{ invoices: { none: { status: InvoiceStatus.DRAFT, payments: { some: {} } } } }],
    });
  });
  it("both kinds exclude an order with delivery evidence (a DeliveryMutation, FK RESTRICT)", () => {
    expect((mergeEligibleWhere("force") as any).deliveryMutations).toEqual({ none: {} });
    expect((mergeEligibleWhere("auto") as any).deliveryMutations).toEqual({ none: {} });
  });
  it("auto keeps every historic condition", () => {
    expect(mergeEligibleWhere("auto")).toEqual({
      status: OrderStatus.PENDING,
      routeRunId: null,
      routeRunStopId: null,
      transaction: { is: null },
      invoices: { none: {} },
      returns: { none: {} },
      deliveryMutations: { none: {} },
      skipAutoMerge: false,
      ...ORDER_HAS_NO_LIVE_DELIVERED_LINE, // SA-1149
      orderCreditNotes: { none: {} }, // SA-1330: a credit intent is never folded (the loser delete would cascade it)
    });
  });
  it("force skips a loser with two DRAFT invoices at the pre-read (C')", async () => {
    const db = {
      order: { findMany: jest.fn(async () => [order("a"), order("b")]) },
      invoice: {
        findMany: jest.fn(async () => [
          { orderId: "b", deliveryBatchId: null },
          { orderId: "b", deliveryBatchId: null },
        ]),
      },
    };
    const { group } = await readMergeGroup(db, "c-1", "force");
    expect(group.map((o: any) => o.id)).toEqual(["a"]);
    const one = {
      ...db,
      invoice: { findMany: jest.fn(async () => [{ orderId: "b", deliveryBatchId: null }]) },
    };
    expect((await readMergeGroup(one, "c-1", "force")).group).toHaveLength(2);
  });
  it("readMergeGroup reads through that predicate, newest first, lines in display order", async () => {
    const db = {
      order: { findMany: jest.fn(async () => [order("a")]) },
      invoice: { findMany: jest.fn(async () => []) },
    };
    await readMergeGroup(db, "c-1", "force");
    const args = (db.order.findMany.mock.calls[0] as any[])[0];
    expect(args.where).toEqual({ customerId: "c-1", ...mergeEligibleWhere("force") });
    expect(args.orderBy).toEqual({ updatedAt: "desc" });
    expect(args.include.lineItems.orderBy).toEqual(ORDER_LINE_ORDER_BY);
  });
});

describe("lockAndRecheckMergeInputs", () => {
  const pre = [order("a"), order("b")];

  it("locks the fold orders FOR UPDATE NOWAIT BEFORE the separate re-read statement", async () => {
    const tx = fakeTx([order("a"), order("b")]);
    await lockAndRecheckMergeInputs(tx, { customerId: "c", kind: "auto", pre });
    const iLock = tx.calls.findIndex((c: string) => /FOR UPDATE NOWAIT/.test(c));
    const iRead = tx.calls.indexOf("findMany");
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iRead).toBeGreaterThan(iLock);
    expect(tx.calls.some((c: string) => /lock_timeout = '3s'/.test(c))).toBe(true);
  });

  it("a lock held by a writer (55P03) defers as MERGE_IN_PROGRESS, before the re-read", async () => {
    const tx = fakeTx(pre);
    tx.$executeRaw.mockRejectedValueOnce(
      Object.assign(new Error("x"), { meta: { code: "55P03" } }),
    );
    const err = await lockAndRecheckMergeInputs(tx, { customerId: "c", kind: "auto", pre }).catch(
      (e) => e,
    );
    expect(isMergeContention(err)).toBe(true);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.MERGE_IN_PROGRESS);
    expect(tx.order.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an order left the group (cancelled / invoiced / routed)", [order("a")]],
    [
      "the winner order changed (newer updatedAt)",
      [order("a", { updatedAt: new Date() }), order("b")],
    ],
    ["the group order changed", [order("b"), order("a")]],
    [
      "a loser line's qty changed between the pre-read and the lock",
      [order("a"), order("b", {}, [line({ id: "b-l", qty: 7 })])],
    ],
    ["a new order joined the group", [order("a"), order("b"), order("c")]],
    ...["promoFreeUnits", "priceType", "originalPrice"].map((f) => [
      `a loser line's ${f} changed between the pre-read and the lock`,
      [order("a"), order("b", {}, [line({ id: "b-l", [f]: "CHANGED" })])],
    ]),
  ])("%s -> deferred, nothing written", async (_n, now) => {
    const tx = fakeTx(now as any[]);
    const err = await lockAndRecheckMergeInputs(tx, { customerId: "c", kind: "auto", pre }).catch(
      (e) => e,
    );
    expect(isMergeContention(err)).toBe(true);
  });

  it("unit-aware lines appearing under the lock defer too (the units_v1 bail)", async () => {
    const tx = fakeTx([order("a"), order("b")]);
    const unitLine = line({ id: "b-l", unitLabel: "case" });
    const unitAwareRows = [order("a"), order("b", {}, [unitLine])];
    tx.order.findMany.mockResolvedValueOnce(unitAwareRows);
    const err = await lockAndRecheckMergeInputs(tx, { customerId: "c", kind: "auto", pre }).catch(
      (e) => e,
    );
    expect(isMergeContention(err)).toBe(true);
  });

  it("the fingerprint is stable for identical inputs", () => {
    expect(mergeInputFingerprint([order("a")])).toBe(mergeInputFingerprint([order("a")]));
  });
});

describe("deleteLoserGuarded", () => {
  it("deletes by id AND the eligibility predicate", async () => {
    const tx = fakeTx([]);
    await deleteLoserGuarded(tx, "loser-1", "force");
    expect(tx.order.deleteMany).toHaveBeenCalledWith({
      where: { id: "loser-1", ...mergeEligibleWhere("force"), invoices: { none: {} } },
    });
  });
  it("force skips a loser whose only DRAFT is a batch draft (a permanent 409 otherwise)", async () => {
    const db = {
      order: { findMany: jest.fn(async () => [order("a"), order("b")]) },
      invoice: { findMany: jest.fn(async () => [{ orderId: "b", deliveryBatchId: "batch-1" }]) },
    };
    expect((await readMergeGroup(db, "c-1", "force")).group.map((o: any) => o.id)).toEqual(["a"]);
  });
  it("force's delete guard fails closed on ANY remaining invoice (C')", async () => {
    const tx = fakeTx([]);
    await deleteLoserGuarded(tx, "loser-1", "force");
    expect((tx.order.deleteMany.mock.calls[0] as any[])[0].where.invoices).toEqual({ none: {} });
  });
  it("count !== 1 aborts the fold as contention (never a silent delete-by-id)", async () => {
    const tx = fakeTx([]);
    tx.order.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(isMergeContention(await deleteLoserGuarded(tx, "l", "auto").catch((e) => e))).toBe(true);
  });
});

const safeMap = (e: unknown) => {
  try {
    mapLockError(e);
  } catch (x) {
    return x;
  }
};

describe("contention mapping + caller wiring", () => {
  it.each(["55P03", "40P01", "40001", "P2034"])(
    "a raw %s inside the merge tx maps to MERGE_IN_PROGRESS (D)",
    (code) => {
      let err: any;
      try {
        mapLockError(Object.assign(new Error("x"), { meta: { code } }));
      } catch (e) {
        err = e;
      }
      expect(isMergeContention(err)).toBe(true);
    },
  );
  it("a message that merely contains P2034 / P2025, with no code, is NOT contention", () => {
    expect(isMergeContention(safeMap(new Error("P2034 something")))).toBe(false);
  });
  it("an unexpected FK error (P2003 / P2025) from the loser delete propagates and is NOT contention", async () => {
    for (const code of ["P2003", "P2025"]) {
      const tx = fakeTx([]);
      tx.order.deleteMany.mockRejectedValueOnce(Object.assign(new Error("fk"), { code }));
      const err = await deleteLoserGuarded(tx, "l", "force").catch((e) => e);
      expect(err.code).toBe(code);
      expect(isMergeContention(err)).toBe(false);
      expect(isMergeContention(safeMap(err))).toBe(false);
    }
  });
  it("a message that merely contains a code, with no code field, is NOT contention", () => {
    for (const c of ["40001", "55P03", "40P01"]) {
      expect(isMergeContention(safeMap(new Error(`value ${c} out of range`)))).toBe(false);
    }
  });
  it("a raw 55P03 from the write phase maps to MERGE_IN_PROGRESS; other errors pass through", () => {
    expect(() =>
      mapLockError(
        Object.assign(new Error("canceling statement due to lock timeout"), {
          meta: { code: "55P03" },
        }),
      ),
    ).toThrow(ConflictException);
    expect(() => mapLockError(new Error("boom"))).toThrow("boom");
  });

  // Every post-commit caller defers on the existing coded body: pin that each call site of
  // mergeAllPendingForCustomer sits in a try whose catch asks isMergeContention.
  it.each([
    ["buyer/buyer.controller.ts", 2],
    ["orders/orders.controller.ts", 2],
    ["order-templates/order-templates.service.ts", 1],
  ])("%s: every mergeAllPendingForCustomer call is guarded by isMergeContention", (rel, calls) => {
    const src = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    expect(src.match(/mergeAllPendingForCustomer\(/g)).toHaveLength(calls);
    expect((src.match(/!isMergeContention\(e\)/g) ?? []).length).toBeGreaterThanOrEqual(calls);
  });
});

describe("SA-1330 (B1343): money on an order keeps it out of a merge", () => {
  it("7: the guarded loser delete keeps both money clauses (force) and the intent clause (auto)", async () => {
    const force = fakeTx([]);
    await deleteLoserGuarded(force, "loser-1", "force");
    const fw = (force.order.deleteMany.mock.calls[0] as any[])[0].where;
    expect(fw.orderCreditNotes).toEqual({ none: {} });
    expect(fw.AND).toEqual([
      { invoices: { none: { status: InvoiceStatus.DRAFT, payments: { some: {} } } } },
    ]);
    expect(fw.invoices).toEqual({ none: {} }); // the override is only `invoices`
    const auto = fakeTx([]);
    await deleteLoserGuarded(auto, "loser-1", "auto");
    expect((auto.order.deleteMany.mock.calls[0] as any[])[0].where.orderCreditNotes).toEqual({
      none: {},
    });
  });

  it("12: mergeEligibleWhere and the reason read use the SAME exported clause objects, never a copy", async () => {
    const force = mergeEligibleWhere("force") as any;
    expect(force.orderCreditNotes).toBe(MERGE_NO_CREDIT_INTENT.orderCreditNotes);
    expect(force.AND).toBe(MERGE_NO_DRAFT_PAYMENT.AND);
    expect((mergeEligibleWhere("auto") as any).orderCreditNotes).toBe(
      MERGE_NO_CREDIT_INTENT.orderCreditNotes,
    );
    const db = { order: { findMany: jest.fn(async () => []) } };
    await readKeptSeparate(db, "c-1", []);
    const where = (db.order.findMany.mock.calls[0] as any[])[0].where;
    expect(where.OR[0].NOT).toBe(MERGE_NO_CREDIT_INTENT);
    expect(where.OR[1].NOT).toBe(MERGE_NO_DRAFT_PAYMENT);
  });

  it("the reason read looks only at the customer's otherwise-eligible PENDING orders, not at the two money clauses", async () => {
    const db = { order: { findMany: jest.fn(async () => []) } };
    await readKeptSeparate(db, "c-1", []);
    const where = (db.order.findMany.mock.calls[0] as any[])[0].where;
    expect(where.customerId).toBe("c-1");
    expect(where.status).toBe(OrderStatus.PENDING);
    expect(where.invoices).toEqual({ none: { status: { not: InvoiceStatus.DRAFT } } });
    expect(where).not.toHaveProperty("orderCreditNotes");
    expect(where).not.toHaveProperty("AND");
  });

  it("8-10: each kept-out order carries its id, number and reason; a multi-draft skip is MULTI_DRAFT", async () => {
    const db = {
      order: {
        findMany: jest.fn(async () => [{ id: "m1", orderNumber: "ORD-0007" }]),
      },
    };
    const rows = await readKeptSeparate(db, "c-1", [order("d1", { orderNumber: "ORD-0009" })]);
    expect(rows).toEqual([
      { orderId: "m1", orderNumber: "ORD-0007", reason: "MONEY_ON_ORDER" },
      { orderId: "d1", orderNumber: "ORD-0009", reason: "MULTI_DRAFT" },
    ]);
  });

  it("11: nothing kept out reads as an empty list", async () => {
    const db = { order: { findMany: jest.fn(async () => []) } };
    expect(await readKeptSeparate(db, "c-1", [])).toEqual([]);
  });

  it("force reports the orders its multi-draft skip removed (the reason read's MULTI_DRAFT input)", async () => {
    const db = {
      order: { findMany: jest.fn(async () => [order("a"), order("b")]) },
      invoice: {
        findMany: jest.fn(async () => [
          { orderId: "b", deliveryBatchId: null },
          { orderId: "b", deliveryBatchId: null },
        ]),
      },
    };
    const read = await readMergeGroup(db, "c-1", "force");
    expect(read.group.map((o: any) => o.id)).toEqual(["a"]);
    expect(read.multiDraftSkipped.map((o: any) => o.id)).toEqual(["b"]);
    const auto = await readMergeGroup(db, "c-1", "auto");
    expect(auto.multiDraftSkipped).toEqual([]);
  });
});
