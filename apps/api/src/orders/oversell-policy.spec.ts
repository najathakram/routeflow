import { UserRole } from "@prisma/client";
import {
  backorderPiecesForLine,
  backorderPiecesForEditDelta,
  backorderPiecesForLines,
  orderableAndBackorder,
  parseOversellPolicy,
  resolveOversellAllowed,
  type OversellPolicyReader,
  type OversellSource,
} from "./oversell-policy";

function fakeReader(value: unknown | (() => unknown)) {
  const read = jest.fn(async () =>
    typeof value === "function" ? (value as () => unknown)() : value,
  );
  return { reader: { read } as OversellPolicyReader, read };
}

describe("parseOversellPolicy", () => {
  it('yields "backorder" only for the exact string', () => {
    expect(parseOversellPolicy("backorder")).toBe("backorder");
  });

  it.each(["off", "yes", "BACKORDER", "allow", "", null, undefined, 1, {}, " backorder"])(
    "fails closed to off for %p",
    (raw) => {
      expect(parseOversellPolicy(raw)).toBe("off");
    },
  );
});

describe("resolveOversellAllowed", () => {
  const policies: unknown[] = ["off", "backorder", undefined, "garbage"];
  const base = { tenantId: "t1", source: "staff_entry" as OversellSource };
  const CREATE_SOURCES: OversellSource[] = ["staff_entry", "buyer", "promotion"];

  // CURRENT behaviour being pinned, not changed: create() (orders.service.ts `isStaffRole`) treats
  // ONLY OPERATOR and TENANT_ADMIN as staff; SUPER_ADMIN is blocked on create today.
  it.each([...CREATE_SOURCES, "template_cron"] as OversellSource[])(
    "create-path source %s: OPERATOR and TENANT_ADMIN are allowed without reading the policy",
    async (source) => {
      for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN]) {
        for (const p of policies) {
          const { reader, read } = fakeReader(p);
          await expect(resolveOversellAllowed(reader, { ...base, source, role })).resolves.toBe(
            true,
          );
          expect(read).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(CREATE_SOURCES)(
    "create-path source %s: SUPER_ADMIN and a missing role are NOT staff (current create() rule)",
    async (source) => {
      for (const role of [UserRole.SUPER_ADMIN, undefined, null]) {
        const { reader, read } = fakeReader("backorder");
        await expect(resolveOversellAllowed(reader, { ...base, source, role })).resolves.toBe(
          false,
        );
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  // CURRENT behaviour being pinned, not changed: settleStockForEdit only refuses CUSTOMER and
  // DRIVER, so on an edit SUPER_ADMIN may oversell although create() blocks it (asymmetry).
  it.each([UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN])(
    "edit: %s is allowed without reading the policy",
    async (role) => {
      const { reader, read } = fakeReader("off");
      await expect(resolveOversellAllowed(reader, { ...base, source: "edit", role })).resolves.toBe(
        true,
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    "edit: a missing user (%p) is allowed — matches settleStockForEdit today",
    async (role) => {
      const { reader, read } = fakeReader("off");
      await expect(resolveOversellAllowed(reader, { ...base, source: "edit", role })).resolves.toBe(
        true,
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["edit", "staff_entry", "buyer", "promotion"] as OversellSource[])(
    "DRIVER is never allowed and never reads (source %s), even under backorder",
    async (source) => {
      const { reader, read } = fakeReader("backorder");
      await expect(
        resolveOversellAllowed(reader, { ...base, source, role: UserRole.DRIVER }),
      ).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("template_cron is allowed under off without reading: current behaviour (pending owner Q6)", async () => {
    for (const role of [UserRole.CUSTOMER, UserRole.SUPER_ADMIN, undefined]) {
      const { reader, read } = fakeReader("off");
      await expect(
        resolveOversellAllowed(reader, { ...base, role, source: "template_cron" }),
      ).resolves.toBe(true);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each([["off"], [undefined], [null], ["garbage"], [42]])(
    "CUSTOMER is denied for policy %p",
    async (p) => {
      const { reader } = fakeReader(p);
      await expect(
        resolveOversellAllowed(reader, { ...base, role: UserRole.CUSTOMER, source: "buyer" }),
      ).resolves.toBe(false);
    },
  );

  it("CUSTOMER is denied when the reader throws, and never rejects", async () => {
    const { reader } = fakeReader(() => {
      throw new Error("boom");
    });
    await expect(
      resolveOversellAllowed(reader, { ...base, role: UserRole.CUSTOMER, source: "buyer" }),
    ).resolves.toBe(false);
  });

  it("CUSTOMER is allowed under backorder, reading exactly once with customerId passed through", async () => {
    const { reader, read } = fakeReader("backorder");
    await expect(
      resolveOversellAllowed(reader, {
        ...base,
        role: UserRole.CUSTOMER,
        source: "buyer",
        customerId: "c1",
      }),
    ).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ tenantId: "t1", customerId: "c1" });
  });

  it("customer-scope override is the reader's job: backorder only for c1", async () => {
    const read = jest.fn(async (a: { tenantId: string; customerId?: string | null }) =>
      a.customerId === "c1" ? "backorder" : "off",
    );
    const reader: OversellPolicyReader = { read };
    const args = { tenantId: "t1", role: UserRole.CUSTOMER, source: "buyer" as OversellSource };
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c1" })).resolves.toBe(true);
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c2" })).resolves.toBe(
      false,
    );
  });

  it("tenant-level backorder with a customer-level off for c2", async () => {
    const read = jest.fn(async (a: { tenantId: string; customerId?: string | null }) =>
      a.customerId === "c2" ? "off" : "backorder",
    );
    const reader: OversellPolicyReader = { read };
    const args = { tenantId: "t1", role: UserRole.CUSTOMER, source: "buyer" as OversellSource };
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c1" })).resolves.toBe(true);
    await expect(resolveOversellAllowed(reader, { ...args, customerId: "c2" })).resolves.toBe(
      false,
    );
  });
});

describe("backorderPiecesForLine (pieces, like the stock paths)", () => {
  const plain = (qty: number) => ({ qty, boxes: null, pieces: null, unitLabel: "Units" });
  const bp = (args: Parameters<typeof backorderPiecesForLine>[0]) => backorderPiecesForLine(args);

  it("a plain piece line: 6 vs 5 -> 1", () => {
    expect(bp({ line: plain(6), availablePieces: 5, allowOversell: true })).toBe(1);
  });

  it("a boxed box-unaware line: 2 boxes of 12 (pack 12) = 24 pieces vs 20 -> 4", () => {
    expect(
      bp({
        line: { qty: 2, boxes: null, pieces: null },
        productPack: 12,
        availablePieces: 20,
        allowOversell: true,
      }),
    ).toBe(4);
  });

  it("a box-split line: boxes 2 + pieces 3 of 12 = 27 pieces; vs 30 -> 0, vs 10 -> 17", () => {
    const line = { qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 };
    expect(bp({ line, availablePieces: 30, allowOversell: true })).toBe(0);
    expect(bp({ line, availablePieces: 10, allowOversell: true })).toBe(17);
  });

  it("allowOversell=false -> 0", () => {
    expect(bp({ line: plain(6), availablePieces: 5, allowOversell: false })).toBe(0);
  });

  it("negative available is treated as 0", () => {
    expect(bp({ line: plain(6), availablePieces: -2, allowOversell: true })).toBe(6);
  });

  it("rounds to 3 decimals", () => {
    expect(bp({ line: plain(0.3), availablePieces: 0.1, allowOversell: true })).toBe(0.2);
  });
});

describe("backorderPiecesForLines (sums per product before subtracting)", () => {
  it("mixed: 2 boxes of 12 + 5 loose pieces = 29 vs 28 available -> 1", () => {
    const lines = [
      { qty: 2, boxes: null, pieces: null },
      { qty: 5, boxes: null, pieces: null, unitLabel: "Units" },
    ];
    expect(
      backorderPiecesForLines({ lines, productPack: 12, availablePieces: 28, allowOversell: true }),
    ).toBe(1);
  });

  it("allowOversell=false -> 0; negative available counts as 0", () => {
    const lines = [{ qty: 5, boxes: null, pieces: null, unitLabel: "Units" }];
    expect(backorderPiecesForLines({ lines, availablePieces: 1, allowOversell: false })).toBe(0);
    expect(backorderPiecesForLines({ lines, availablePieces: -3, allowOversell: true })).toBe(5);
  });
});

describe("orderableAndBackorder", () => {
  it.each([
    [10, true, { orderable: true, backorder: false }],
    [3, false, { orderable: true, backorder: false }],
    [0, true, { orderable: true, backorder: true }],
    [0, false, { orderable: false, backorder: false }],
    [-1, true, { orderable: true, backorder: true }],
    [-1, false, { orderable: false, backorder: false }],
    [10, false, { orderable: true, backorder: false }],
    [3, true, { orderable: true, backorder: false }],
  ])("stock %p allow %p", (stock, allowOversell, want) => {
    expect(orderableAndBackorder({ stock, allowOversell })).toEqual(want);
  });
});

describe("backorderPiecesForLines: negative lines are a caller bug (SA ruling N5)", () => {
  const line = (qty: number) => ({ qty, boxes: null, pieces: null, unitLabel: "Units" });

  // Pinned by exception CLASS only, never a message.
  it("a negative line throws a RangeError (not clamped to 0)", () => {
    expect(() =>
      backorderPiecesForLines({ lines: [line(-3)], availablePieces: 5, allowOversell: true }),
    ).toThrow(RangeError);
  });

  it("[-10, +10] is NOT netted to 0: it throws", () => {
    expect(() =>
      backorderPiecesForLines({
        lines: [line(-10), line(10)],
        availablePieces: 0,
        allowOversell: true,
      }),
    ).toThrow(RangeError);
  });

  it("throws even when allowOversell is false (a caller bug is not hidden by the policy)", () => {
    expect(() =>
      backorderPiecesForLines({ lines: [line(-1)], availablePieces: 5, allowOversell: false }),
    ).toThrow(RangeError);
  });

  it("backorderPiecesForLine inherits it", () => {
    expect(() =>
      backorderPiecesForLine({ line: line(-1), availablePieces: 5, allowOversell: true }),
    ).toThrow(RangeError);
  });

  it("zero and positive lines still work (a zero line is not negative)", () => {
    expect(
      backorderPiecesForLines({
        lines: [line(0), line(7)],
        availablePieces: 5,
        allowOversell: true,
      }),
    ).toBe(2);
  });
});

describe("backorderPiecesForEditDelta (per-product DELTA from settleStockForEdit)", () => {
  const m = (o: Record<string, number>) => new Map(Object.entries(o));

  it("an edit raising a line by +5 against 2 available backorders 3", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ p1: 5 }),
      availableByProduct: m({ p1: 2 }),
      allowOversell: true,
    });
    expect(r.get("p1")).toBe(3);
  });

  it("a lowered product is 0 and has no effect on another product", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ lowered: -4, raised: 5 }),
      availableByProduct: m({ lowered: 0, raised: 2 }),
      allowOversell: true,
    });
    expect(r.get("lowered")).toBe(0);
    expect(r.get("raised")).toBe(3);
  });

  it("an unchanged product (delta 0) is 0", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ p1: 0 }),
      availableByProduct: m({ p1: 0 }),
      allowOversell: true,
    });
    expect(r.get("p1")).toBe(0);
  });

  it("allowOversell=false yields 0 for every product", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ a: 5, b: 9 }),
      availableByProduct: m({ a: 0, b: 1 }),
      allowOversell: false,
    });
    expect([...r.entries()]).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("a negative or missing available counts as 0", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ neg: 4, missing: 6 }),
      availableByProduct: m({ neg: -3 }),
      allowOversell: true,
    });
    expect(r.get("neg")).toBe(4);
    expect(r.get("missing")).toBe(6);
  });

  it("enough stock for the raise backorders nothing", () => {
    const r = backorderPiecesForEditDelta({
      deltaByProduct: m({ p1: 5 }),
      availableByProduct: m({ p1: 5 }),
      allowOversell: true,
    });
    expect(r.get("p1")).toBe(0);
  });
});

describe("CUSTOMER follows the policy on every non-cron source with exactly one read (C5)", () => {
  it.each(["staff_entry", "buyer", "promotion", "edit"] as OversellSource[])(
    "source %s: backorder -> true, off -> false, one read with the customerId",
    async (source) => {
      for (const [policy, want] of [
        ["backorder", true],
        ["off", false],
      ] as const) {
        const { reader, read } = fakeReader(policy);
        await expect(
          resolveOversellAllowed(reader, {
            tenantId: "t1",
            role: UserRole.CUSTOMER,
            source,
            customerId: "c1",
          }),
        ).resolves.toBe(want);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith({ tenantId: "t1", customerId: "c1" });
      }
    },
  );

  it("template_cron stays true for CUSTOMER with NO read (current behaviour, pending owner question Q6)", async () => {
    const { reader, read } = fakeReader("off");
    await expect(
      resolveOversellAllowed(reader, {
        tenantId: "t1",
        role: UserRole.CUSTOMER,
        source: "template_cron",
        customerId: "c1",
      }),
    ).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
