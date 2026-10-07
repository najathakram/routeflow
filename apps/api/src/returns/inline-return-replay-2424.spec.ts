/**
 * #2424 fold (the lead's Opus FAIL on #2640 @ee8518c7, board #2554):
 *  (1) the ORDER-level Idempotency-Key replays (create's two exits via `assertReplayCarriesReturn`,
 *      the merge replay via `findOrderIdByKeyCheckingReturn`) compared only the returnKey, never
 *      the items: they now apply the same fingerprint 409;
 *  (2) the 409 says the earlier return WAS recorded and names it (returnId / returnNumber), so a
 *      client never re-submits the same goods as a "new" return and credits them twice;
 *  (3) the fingerprint uses the EFFECTIVE reason (the item's, else the request's);
 *  (4) the boxes/pieces wire shape the clients actually send is pinned;
 *  (5) a legacy row (no fingerprint) is accepted with a warning.
 * Red-first.
 */
import { ConflictException } from "@nestjs/common";
import {
  INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
  assertReplayItems,
  inlineReturnItemsFingerprint,
  replayItemsMatch,
} from "./inline-return-fingerprint";
import { assertReplayCarriesReturnKey } from "../orders/order-inline-return";
import { findOrderIdByKeyCheckingReturn } from "../orders/merge-idempotency";

const BOXED = [{ productId: "p1", boxes: 2, pieces: 3 }];
const row = (payload: unknown) => ({
  id: "ret-1",
  returnNumber: "RET-2026-0007",
  capturePayload: payload,
});
const bodyOf = (e: any) => e?.getResponse?.();

describe("#2424 fold: every returnKey replay compares items (the lead's Opus FAIL)", () => {
  describe("(1) the order-level replays", () => {
    const db = (found: unknown) => ({ return: { findFirst: jest.fn().mockResolvedValue(found) } });

    it("assertReplayCarriesReturnKey: same key, DIFFERENT items ⇒ the 409, naming the recorded return", async () => {
      const d = db(row(inlineReturnItemsFingerprint(BOXED)));
      const caught: any = await assertReplayCarriesReturnKey(
        d,
        { returnKey: "k", items: [{ productId: "p1", boxes: 2, pieces: 4 }] },
        "ord-1",
      ).catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(bodyOf(caught)).toMatchObject({
        code: INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
        returnId: "ret-1",
        returnNumber: "RET-2026-0007",
      });
      expect(d.return.findFirst.mock.calls[0][0].select).toMatchObject({ capturePayload: true });
    });

    it("assertReplayCarriesReturnKey: same key, SAME items ⇒ passes", async () => {
      const d = db(row(inlineReturnItemsFingerprint(BOXED)));
      await expect(
        assertReplayCarriesReturnKey(d, { returnKey: "k", items: BOXED }, "ord-1"),
      ).resolves.toBeUndefined();
    });

    it("the merge replay (findOrderIdByKeyCheckingReturn): a key hit with DIFFERENT return items ⇒ the 409", async () => {
      const client = {
        getTenantId: () => "t1",
        forTenant: () => ({
          orderIdempotencyKey: {
            // the merge wave's own key row, same cart (no requestHash given)
            findFirst: jest.fn().mockResolvedValue({ orderId: "ord-1", responseHash: "h" }),
          },
          order: { findFirst: jest.fn().mockResolvedValue({ id: "ord-1", lineItems: [] }) },
          return: {
            findFirst: jest.fn().mockResolvedValue(row(inlineReturnItemsFingerprint(BOXED))),
          },
        }),
      };
      const caught: any = await findOrderIdByKeyCheckingReturn(
        { prisma: client, logger: { warn: jest.fn() } } as any,
        "idem-1",
        "cust-1",
        undefined,
        { returnKey: "k", items: [{ productId: "p1", boxes: 9, pieces: 0 }] },
        { items: [] },
      ).catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(bodyOf(caught)?.code).toBe(INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS);
    });
  });

  describe("(2) the 409 tells the truth", () => {
    it("says the earlier return WAS recorded and names it; never 'nothing was recorded'", () => {
      let caught: any;
      try {
        assertReplayItems(row(inlineReturnItemsFingerprint(BOXED)), {
          items: [{ productId: "p1", boxes: 1, pieces: 0 }],
        });
      } catch (e) {
        caught = e;
      }
      const body = bodyOf(caught);
      expect(body.returnId).toBe("ret-1");
      expect(body.returnNumber).toBe("RET-2026-0007");
      expect(body.message).toMatch(/RET-2026-0007 was already recorded/);
      expect(body.message).not.toMatch(/start the return again|Nothing was recorded; start/i);
    });
  });

  describe("(3) the effective reason", () => {
    it("an item reason inherited from the request equals the same reason given on the item", () => {
      const stored = inlineReturnItemsFingerprint(
        [{ productId: "p1", boxes: 1, pieces: 0 }],
        "DAMAGED",
      );
      expect(
        replayItemsMatch(stored, [{ productId: "p1", boxes: 1, pieces: 0, reason: "DAMAGED" }]),
      ).toBe("match");
    });
    it("a different request-level reason is a different capture", () => {
      const stored = inlineReturnItemsFingerprint(
        [{ productId: "p1", boxes: 1, pieces: 0 }],
        "DAMAGED",
      );
      expect(
        replayItemsMatch(stored, [{ productId: "p1", boxes: 1, pieces: 0 }], "EXCESS_ORDER"),
      ).toBe("mismatch");
    });
  });

  describe("(4) the boxes/pieces wire shape", () => {
    const stored = inlineReturnItemsFingerprint([
      { productId: "p1", boxes: 2, pieces: 3 },
      { productId: "p2", boxes: 0, pieces: 5, condition: "OPENED", restock: false },
    ]);
    it("the same boxes/pieces lines in another order ⇒ match", () => {
      expect(
        replayItemsMatch(stored, [
          { productId: "p2", boxes: 0, pieces: 5, condition: "OPENED", restock: false },
          { productId: "p1", boxes: 2, pieces: 3 },
        ]),
      ).toBe("match");
    });
    it.each([
      ["one more piece", [{ productId: "p1", boxes: 2, pieces: 4 }]],
      ["one more box", [{ productId: "p1", boxes: 3, pieces: 3 }]],
      ["a line dropped", []],
      [
        "restock flipped",
        [{ productId: "p2", boxes: 0, pieces: 5, condition: "OPENED", restock: true }],
      ],
    ])("%s ⇒ mismatch", (_n, changed) => {
      const base = [
        { productId: "p1", boxes: 2, pieces: 3 },
        { productId: "p2", boxes: 0, pieces: 5, condition: "OPENED", restock: false },
      ];
      const items = [
        ...base.filter((b) => !changed.some((c: any) => c.productId === b.productId)),
        ...changed,
      ];
      if (_n === "a line dropped") items.splice(0, 1);
      expect(replayItemsMatch(stored, items)).toBe("mismatch");
    });
  });

  describe("(5) a legacy row (no fingerprint)", () => {
    it("is accepted, with a warning", () => {
      const warn = jest.fn();
      expect(() => assertReplayItems(row(null), { items: BOXED }, { warn })).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no capture fingerprint"));
    });
  });
});
