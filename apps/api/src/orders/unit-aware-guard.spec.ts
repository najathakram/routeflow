import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  ORDER_HAS_NO_UNIT_AWARE_LINE,
  UNIT_AWARE_LINE,
  assertChangeTargetAllowed,
  assertInvoiceRewriteAllowed,
  assertNoUnitAwareLines,
  assertOrderEditAllowed,
  isUnitAwareLine,
} from "./unit-aware-guard";

describe("isUnitAwareLine", () => {
  it.each([
    [{ unitLabel: "Case" }, true],
    [{ unitLabel: "Piece", status: "PENDING" }, true],
    [{ unitLabel: null }, false],
    [{ unitLabel: "" }, false],
    [{}, false],
    [{ unitLabel: "Case", status: "CANCELLED" }, false],
    [null, false],
    [undefined, false],
  ])("%j -> %s", (li, want) => {
    expect(isUnitAwareLine(li as never)).toBe(want);
  });
});

describe("assertNoUnitAwareLines", () => {
  it("passes for pack lines, empty and missing input", () => {
    expect(() => assertNoUnitAwareLines([{ unitLabel: null }, {}])).not.toThrow();
    expect(() => assertNoUnitAwareLines([])).not.toThrow();
    expect(() => assertNoUnitAwareLines(undefined)).not.toThrow();
  });

  it("throws 409 UNIT_AWARE_LINE naming the unit and the action", () => {
    let err: ConflictException | undefined;
    try {
      assertNoUnitAwareLines([{ unitLabel: null }, { unitLabel: "Pallet" }], "duplicated");
    } catch (e) {
      err = e as ConflictException;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = err!.getResponse() as { code: string; message: string };
    expect(body.code).toBe(UNIT_AWARE_LINE);
    expect(body.message).toContain("Pallet");
    expect(body.message).toContain("duplicated");
  });
});

describe("ORDER_HAS_NO_UNIT_AWARE_LINE", () => {
  it("is the Prisma filter: no live line with a unitLabel", () => {
    expect(ORDER_HAS_NO_UNIT_AWARE_LINE).toEqual({
      lineItems: { none: { unitLabel: { not: null }, status: { not: "CANCELLED" } } },
    });
  });
});

const caseLine = { id: "li-case", productId: "p1", unitLabel: "Case", status: "PENDING" };
const packLine = { id: "li-pack", productId: "p2", unitLabel: null, status: "PENDING" };

describe("assertInvoiceRewriteAllowed", () => {
  // Parents ONLY (no invoiceItem/orderItem on the mock): a top-level line read would throw here.
  const db = (ownItems: unknown[], linkedItems: unknown[] | null) => ({
    invoice: { findFirst: jest.fn().mockResolvedValue({ items: ownItems }) },
    order: {
      findFirst: jest.fn().mockResolvedValue(linkedItems ? { lineItems: linkedItems } : null),
    },
  });

  it("refuses when an ORDER-LINKED invoice's own lines carry a unitLabel (read through the invoice relation)", async () => {
    const d = db([{ unitLabel: "Case" }], []);
    await expect(
      assertInvoiceRewriteAllowed(d as never, { id: "inv", orderId: "ord-1" }),
    ).rejects.toMatchObject({ response: { code: UNIT_AWARE_LINE } });
    expect(d.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: "inv" },
      select: { items: expect.objectContaining({ where: { unitLabel: { not: null } } }) },
    });
  });

  it("VU-4a (D3): an ORDER-LESS draft's own unit rows are editable; the invoice is still read (fail closed), no order read", async () => {
    const d = db([{ unitLabel: "Case" }], []);
    await expect(assertInvoiceRewriteAllowed(d as never, { id: "inv" })).resolves.toBeUndefined();
    expect(d.invoice.findFirst).toHaveBeenCalled();
    expect(d.order.findFirst).not.toHaveBeenCalled();
  });

  it("refuses when the invoice carries NO label but its LINKED ORDER holds a unit-aware line (the back-sync would write onto it)", async () => {
    const d = db([], [{ unitLabel: "Pallet", status: "PENDING" }]);
    await expect(
      assertInvoiceRewriteAllowed(d as never, { id: "inv", orderId: "ord-1" }),
    ).rejects.toMatchObject({ response: { code: UNIT_AWARE_LINE } });
    expect(d.order.findFirst).toHaveBeenCalledWith({
      where: { id: "ord-1" },
      select: {
        lineItems: expect.objectContaining({
          where: { unitLabel: { not: null }, status: { not: "CANCELLED" } },
        }),
      },
    });
  });

  it("passes a pack-only invoice, linked or not", async () => {
    await expect(
      assertInvoiceRewriteAllowed(db([], null) as never, { id: "i" }),
    ).resolves.toBeUndefined();
    await expect(
      assertInvoiceRewriteAllowed(db([], []) as never, { id: "i", orderId: "o" }),
    ).resolves.toBeUndefined();
  });

  it("FAILS CLOSED when a parent cannot be read (NULL-tenant / vanished): 409 UNIT_AWARE_LINE_UNVERIFIABLE", async () => {
    const noInvoice = {
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
      order: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      assertInvoiceRewriteAllowed(noInvoice as never, { id: "i" }),
    ).rejects.toMatchObject({ response: { code: "UNIT_AWARE_LINE_UNVERIFIABLE" } });
    // the invoice is readable but its LINKED order is not (e.g. NULL-tenant order)
    await expect(
      assertInvoiceRewriteAllowed(db([], null) as never, { id: "i", orderId: "o" }),
    ).rejects.toMatchObject({ response: { code: "UNIT_AWARE_LINE_UNVERIFIABLE" } });
  });
});

describe("assertOrderEditAllowed", () => {
  const order = { customerId: "c1", lineItems: [caseLine, packLine] };
  const owner = (id: string | null) => jest.fn().mockResolvedValue(id ? { id } : null);

  it("passes an order with no unit-aware line without any owner lookup", async () => {
    const f = owner("c1");
    await assertOrderEditAllowed(
      { customerId: "c1", lineItems: [packLine] },
      { replaceAll: true },
      { role: "CUSTOMER" },
      f,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("units_v1 (A1): OPERATOR and TENANT_ADMIN pass a non-replaceAll diff on a unit-aware order unconditionally — CONVERTED, not guarded; no owner lookup, no product/DB dependency", async () => {
    const f = owner(null);
    const diff = { replaceAll: false, items: [{ id: "li-case", unitLabel: "Case", qty: 3 }] };
    await expect(
      assertOrderEditAllowed(order, diff, { role: "OPERATOR" }, f),
    ).resolves.toBeUndefined();
    await expect(
      assertOrderEditAllowed(order, diff, { role: "TENANT_ADMIN" }, f),
    ).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("units_v1 (A1, hardening): a staff replaceAll against a unit-aware order is refused — a full replace has no per-line id to preserve a unit through and would silently re-denominate it to the pack", async () => {
    const f = owner(null);
    await expect(
      assertOrderEditAllowed(order, { replaceAll: true, items: [] }, { role: "OPERATOR" }, f),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      assertOrderEditAllowed(order, { replaceAll: true, items: [] }, { role: "TENANT_ADMIN" }, f),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f).not.toHaveBeenCalled();
  });

  it("a staff replaceAll against a PACK-only order is NOT refused (nothing to re-denominate)", async () => {
    const f = owner(null);
    await expect(
      assertOrderEditAllowed(
        { customerId: "c1", lineItems: [packLine] },
        { replaceAll: true, items: [] },
        { role: "OPERATOR" },
        f,
      ),
    ).resolves.toBeUndefined();
  });

  it("DRIVER stays refused on a unit-aware order (only staff is converted)", async () => {
    await expect(
      assertOrderEditAllowed(
        order,
        { replaceAll: false, items: [{ id: "li-case", qty: 3 }] },
        { role: "DRIVER" },
        owner(null),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("allows a diff of ONLY CANCEL/DELETE entries, but not a mixed one, nor a replace-all (DRIVER — a non-staff role still refused; units_v1 A1 converts staff only)", async () => {
    const strike = {
      replaceAll: false,
      items: [
        { id: "a", action: "CANCEL" },
        { id: "b", action: "DELETE" },
      ],
    };
    await expect(
      assertOrderEditAllowed(order, strike, { role: "DRIVER" }, owner(null)),
    ).resolves.toBeUndefined();
    const mixed = {
      replaceAll: false,
      items: [
        { id: "a", action: "CANCEL" },
        { id: "b", action: "UPDATE" },
      ],
    };
    await expect(
      assertOrderEditAllowed(order, mixed, { role: "DRIVER" }, owner(null)),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      assertOrderEditAllowed(
        order,
        { replaceAll: true, items: [{ id: "a", action: "CANCEL" }] },
        { role: "DRIVER" },
        owner(null),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      assertOrderEditAllowed(
        order,
        { replaceAll: false, items: [] },
        { role: "DRIVER" },
        owner(null),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("a buyer's ownership is settled FIRST: non-owner -> bare 403, owner -> readable 409", async () => {
    await expect(
      assertOrderEditAllowed(order, { items: [] }, { role: "CUSTOMER" }, owner("someone-else")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      assertOrderEditAllowed(order, { items: [] }, { role: "CUSTOMER" }, owner(null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      assertOrderEditAllowed(order, { items: [] }, { role: "CUSTOMER" }, owner("c1")),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("assertChangeTargetAllowed — only the line the request targets", () => {
  const lines = [caseLine, packLine];
  it("CHANGE_QTY on the unit-aware line is refused; on an unrelated pack line it passes", () => {
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "CHANGE_QTY", orderItemId: "li-case" }, null),
    ).toThrow(ConflictException);
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "CHANGE_QTY", orderItemId: "li-pack" }, null),
    ).not.toThrow();
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "CHANGE_QTY" }, { orderItemId: "li-pack" }),
    ).not.toThrow();
  });

  it("ADD_ITEM into a product that has a unit-aware line is refused; a different product passes", () => {
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "ADD_ITEM", productId: "p1" }, null),
    ).toThrow(ConflictException);
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "ADD_ITEM" }, { productId: "p2" }),
    ).not.toThrow();
    expect(() => assertChangeTargetAllowed(lines, { type: "ADD_ITEM" }, {})).not.toThrow();
  });

  it("REMOVE_ITEM only strikes a line off — never refused", () => {
    expect(() =>
      assertChangeTargetAllowed(lines, { type: "REMOVE_ITEM", orderItemId: "li-case" }, null),
    ).not.toThrow();
  });
});
