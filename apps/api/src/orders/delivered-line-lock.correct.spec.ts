import {
  assertDeliveredLinesUntouched,
  assertDeliveredToShape,
  DELIVERED_LINE_REMOVED_MESSAGE,
  assertQtyNotBelowDelivered,
  reduceDeliveredLineEntries,
  type DeliveredModes,
} from "./delivered-line-lock";
import {
  CORRECT_IDENTITY_MESSAGE,
  CORRECT_WITH_RETURN_MESSAGE,
  OPERATOR_BELOW_MESSAGE,
  OPERATOR_REMOVED_MESSAGE,
  lockedCopy,
  statusCopy,
} from "./delivered-line-copy";

/**
 * SA-1506 PR-1a: the guards take the decider's decisions. A CORRECT line passes the lock on every status with only a
 * quantity / box split / price change or a take-off; a swap, a product change or a unit-label change is 409 with the swap
 * sentence; an inline return in the same save is 409; an operator gets the admin sentence; a locked line says its reason.
 */
const held = [
  { id: "L1", productId: "p1", qty: 10, deliveredQty: 10, unitPrice: 1, unitLabel: null },
];
const modes = (d: any): DeliveredModes => new Map([["L1", d]]);
const CORRECT = modes({ mode: "CORRECT", basis: "OFFICE" });
const msg = (fn: () => void) => {
  try {
    fn();
  } catch (e: any) {
    return { code: e.getResponse().code, message: e.getResponse().message };
  }
  return null;
};
const run = (
  status: string,
  items: any[],
  m: DeliveredModes,
  extra: object = {},
  role = "TENANT_ADMIN",
) =>
  msg(() =>
    assertDeliveredLinesUntouched({ status }, held, { items, ...extra }, { role }, true, m),
  );

describe("assertDeliveredLinesUntouched with a CORRECT decision (SA-1506)", () => {
  it.each(["CONFIRMED", "PARTIALLY_DELIVERED"])(
    "a quantity cut, a price change and a take-off pass on %s",
    (status) => {
      expect(run(status, [{ id: "L1", qty: 8 }], CORRECT)).toBeNull();
      expect(run(status, [{ id: "L1", unitPrice: 2 }], CORRECT)).toBeNull();
      expect(run(status, [{ id: "L1", action: "CANCEL", deliveredTo: 0 }], CORRECT)).toBeNull();
      expect(run(status, [{ id: "L1", action: "DELETE", deliveredTo: 0 }], CORRECT)).toBeNull();
    },
  );

  // SA-1533 (s): a take-off is a correction only when it says so. A bare CANCEL / DELETE (mobile, an old build) is master's
  // removal 409, so trashing a delivered line on a phone never puts its stock back.
  it.each(["CONFIRMED", "PARTIALLY_DELIVERED"])(
    "a bare CANCEL or DELETE of a CORRECT line is master's removal 409 on %s",
    (status) => {
      for (const action of ["CANCEL", "DELETE"])
        expect(run(status, [{ id: "L1", action }], CORRECT)).toEqual({
          code: "LINE_ALREADY_DELIVERED",
          message: DELIVERED_LINE_REMOVED_MESSAGE,
        });
    },
  );

  it("without the decision the same cut is the legacy 409 on PARTIALLY_DELIVERED (the red value on base)", () => {
    expect(run("PARTIALLY_DELIVERED", [{ id: "L1", qty: 8 }], new Map())).toMatchObject({
      code: "LINE_ALREADY_DELIVERED",
    });
  });

  it("a substitution, a product change and a unit-label change are 409 with the swap sentence", () => {
    for (const change of [
      { substituteProductId: "p2" },
      { productId: "p2" },
      { unitLabel: "case" },
    ])
      expect(run("CONFIRMED", [{ id: "L1", ...change }], CORRECT)).toEqual({
        code: "LINE_ALREADY_DELIVERED",
        message: CORRECT_IDENTITY_MESSAGE,
      });
  });

  it("restating the same product id is not a product change", () => {
    expect(run("CONFIRMED", [{ id: "L1", productId: "p1", qty: 8 }], CORRECT)).toBeNull();
  });

  it("a correcting entry together with an inline return is 409 with the two-saves sentence", () => {
    expect(
      run("CONFIRMED", [{ id: "L1", qty: 8 }], CORRECT, { inlineReturn: { returnKey: "k" } }),
    ).toEqual({ code: "LINE_ALREADY_DELIVERED", message: CORRECT_WITH_RETURN_MESSAGE });
  });

  it("an inline return beside an entry that only restates the line is not refused", () => {
    expect(
      run("CONFIRMED", [{ id: "L1", qty: 10 }], CORRECT, { inlineReturn: { returnKey: "k" } }),
    ).toBeNull();
  });
});

describe("refusal words by reason (SA-1506 A2 section D)", () => {
  it("an operator whom an admin could correct is told so, on a removal and on the floor", () => {
    const m = modes({ mode: "LOCKED", reason: "ROLE", operatorNote: true });
    expect(run("CONFIRMED", [{ id: "L1", action: "CANCEL" }], m, {}, "OPERATOR")?.message).toBe(
      OPERATOR_REMOVED_MESSAGE,
    );
    expect(() => assertQtyNotBelowDelivered(10, 10, 8, m.get("L1"))).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ message: OPERATOR_BELOW_MESSAGE }),
      }),
    );
  });

  it("an operator an admin could not correct keeps today's words", () => {
    const m = modes({ mode: "LOCKED", reason: "ROLE", operatorNote: false });
    expect(run("CONFIRMED", [{ id: "L1", action: "CANCEL" }], m, {}, "OPERATOR")?.message).toMatch(
      /^This line was delivered, so it can't be removed\. To take goods back, record a return\.$/,
    );
  });

  it("a locked line says its own reason (ROUTE, WRITTEN_OFF with the number, STATUS by status)", () => {
    expect(
      run("CONFIRMED", [{ id: "L1", action: "CANCEL" }], modes({ mode: "LOCKED", reason: "ROUTE" }))
        ?.message,
    ).toBe(lockedCopy("ROUTE"));
    expect(
      run(
        "CONFIRMED",
        [{ id: "L1", action: "CANCEL" }],
        modes({ mode: "LOCKED", reason: "WRITTEN_OFF", invoiceNumber: "INV-7" }),
      )?.message,
    ).toBe(lockedCopy("WRITTEN_OFF", { invoiceNumber: "INV-7" }));
    expect(
      run(
        "PENDING",
        [{ id: "L1", action: "CANCEL" }],
        modes({ mode: "LOCKED", reason: "STATUS", status: "PENDING" }),
      )?.message,
    ).toBe(statusCopy("PENDING"));
  });

  it("the quantity floor skips a CORRECT line and judges every other decision as before", () => {
    expect(() =>
      assertQtyNotBelowDelivered(10, 10, 8, { mode: "CORRECT", basis: "OFFICE" }),
    ).not.toThrow();
    expect(() => assertQtyNotBelowDelivered(10, 10, 8)).toThrow();
    expect(() => assertQtyNotBelowDelivered(10, 10, 8, { mode: "LOCKED", reason: "UNIT" })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          message: expect.stringContaining("can't be less than what was delivered"),
        }),
      }),
    );
  });
});

describe("reduceDeliveredLineEntries (A1 B7 / B8, A2 M8)", () => {
  const live = [
    { id: "L1", productId: "p1", qty: 10, deliveredQty: 10, unitPrice: 1, status: "PENDING" },
  ];

  it("a DELETE of a CORRECT line is a take-off: it reaches the loop as CANCEL, never as DELETE", () => {
    const out = reduceDeliveredLineEntries(
      { status: "CONFIRMED" },
      live,
      [{ id: "L1", action: "DELETE" }],
      CORRECT,
    );
    expect(out).toEqual([{ id: "L1", action: "CANCEL" }]);
  });

  it("a real change on a CORRECT line reaches the write loop; a restated price is dropped (A3 LOW 9)", () => {
    const items = [{ id: "L1", qty: 8, unitPrice: 1 }];
    expect(reduceDeliveredLineEntries({ status: "CONFIRMED" }, live, items, CORRECT)).toEqual([
      { id: "L1", qty: 8 },
    ]);
    const repriced = [{ id: "L1", qty: 8, unitPrice: 2 }];
    expect(reduceDeliveredLineEntries({ status: "CONFIRMED" }, live, repriced, CORRECT)).toEqual(
      repriced,
    );
  });

  it("a restated CORRECT entry is cut to its note (it never reprices from live promotions)", () => {
    const out = reduceDeliveredLineEntries(
      { status: "CONFIRMED" },
      live,
      [{ id: "L1", qty: 10, unitPrice: 1, notes: "n" }],
      CORRECT,
    );
    expect(out).toEqual([{ id: "L1", notes: "n" }]);
  });

  it("M8: on CONFIRMED an OPERATOR's restated entry for a live delivered line is cut too; a real change is not", () => {
    const op: DeliveredModes = modes({ mode: "LOCKED", reason: "ROLE", operatorNote: true });
    expect(
      reduceDeliveredLineEntries(
        { status: "CONFIRMED" },
        live,
        [{ id: "L1", qty: 10, unitPrice: 1 }],
        op,
      ),
    ).toEqual([{ id: "L1" }]);
    const real = [{ id: "L1", qty: 12 }];
    expect(reduceDeliveredLineEntries({ status: "CONFIRMED" }, live, real, op)).toEqual(real);
  });

  it("a status outside CONFIRMED / PARTIALLY_DELIVERED with no CORRECT line returns the items untouched", () => {
    const items = [{ id: "L1", qty: 10, unitPrice: 1 }];
    expect(reduceDeliveredLineEntries({ status: "DELIVERED" }, live, items, new Map())).toBe(items);
  });
});

describe("assertDeliveredToShape (SA-1533 (s))", () => {
  const code = (items: any[]) => {
    try {
      assertDeliveredToShape(items);
    } catch (e: any) {
      return e.getStatus();
    }
    return null;
  };

  it("0 on a CANCEL or DELETE passes; no field passes", () => {
    expect(code([{ id: "L1", action: "CANCEL", deliveredTo: 0 }])).toBeNull();
    expect(code([{ id: "L1", action: "DELETE", deliveredTo: 0 }])).toBeNull();
    expect(
      code([
        { id: "L1", qty: 4 },
        { id: "L2", action: "CANCEL" },
      ]),
    ).toBeNull();
  });

  it("any other figure, or 0 without a take-off, is a 400", () => {
    expect(code([{ id: "L1", action: "CANCEL", deliveredTo: 3 }])).toBe(400);
    expect(code([{ id: "L1", action: "DELETE", deliveredTo: -1 }])).toBe(400);
    expect(code([{ id: "L1", qty: 4, deliveredTo: 0 }])).toBe(400);
    expect(code([{ id: "L1", action: "UPDATE", deliveredTo: 0 }])).toBe(400);
  });
});
