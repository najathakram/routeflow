import { InvoiceStatus, UserRole } from "@prisma/client";
import type { EditedLine } from "./invoice-edit-plan";
import type { IssuedEditCtx, LockedInvoiceForEdit } from "./locked-invoice-edit";
import { writeIfFigureFree } from "./issued-invoice-edit";

jest.mock("../regulated/filing-lock", () => ({
  assertSalesNotLockedForEdit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../orders/unit-aware-guard", () => ({
  assertInvoiceRewriteAllowed: jest.fn().mockResolvedValue(undefined),
}));

/**
 * SA-1508 commit 5 (gate): the figure-free write (A2-N1 rule 3 and 5). Red on master: the module does not exist (master
 * refuses the save). A figure-free save writes only the header fields, `pdfUrl: null` and the lines' description, notes
 * and position; it never touches a figure, the ledger or the commission; a save that changes nothing writes nothing.
 */
const ADMIN = { sub: "u1", role: UserRole.TENANT_ADMIN } as any;
const stored = {
  id: "r1",
  productId: "p1",
  description: "Widget",
  notes: null,
  position: 0,
  qty: 2,
  boxes: null,
  pieces: null,
  unitPrice: 50,
  discount: 0,
  taxRate: 0,
  subtotal: 100,
  unitLabel: null,
  categoryTaxAmount: 0,
  orderItemId: null,
};
const cur = {
  id: "inv-1",
  customerId: "c1",
  orderId: null,
  status: InvoiceStatus.SENT,
  discount: 0,
  shippingFee: 0,
  total: 100,
  issueDate: new Date("2026-11-01T00:00:00Z"),
  dueDate: new Date("2099-12-01T00:00:00Z"),
  notes: null,
  depositPercent: null,
  depositDueDate: null,
};
const locked = (): LockedInvoiceForEdit => ({
  invoice: { ...cur },
  storedRows: [{ ...stored }],
  isTaxExempt: false,
  payments: [{ status: "PENDING" }], // a waiting payment must not stop a figure-free save
});
const line = (over: Record<string, any> = {}, untouched = true): EditedLine => ({
  rowId: "r1",
  untouched,
  data: { ...stored, ...over },
});
const ctx = (over: Partial<IssuedEditCtx> = {}): IssuedEditCtx => ({
  mode: "ISSUED",
  actor: ADMIN,
  tenantId: "t1",
  dto: {},
  due: { dueDate: null, depositDueDate: null },
  ...over,
});
const fakeTx = (): any => ({
  invoice: {
    update: jest.fn().mockResolvedValue({ ...cur, updated: true, items: [stored] }),
    findUnique: jest.fn().mockResolvedValue({ id: "inv-1", reread: true }),
  },
  invoiceItem: { update: jest.fn().mockResolvedValue({}) },
  auditLog: { create: jest.fn().mockResolvedValue({}) }, // SA-1508 commit 7: the epilogue row
  tenantConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
  creditNote: { count: jest.fn().mockResolvedValue(0) },
  returnItem: { count: jest.fn().mockResolvedValue(0) },
  order: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn() },
  // stampEditedPositions reads the order's line ranks only for an order-linked invoice (none here)
});

describe("writeIfFigureFree (items branch)", () => {
  it("a DRAFT is never handled here", async () => {
    const tx = fakeTx();
    expect(await writeIfFigureFree(tx, locked(), [line()], ctx({ mode: "DRAFT" }))).toBeNull();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("a changed line is a money edit: null, nothing written", async () => {
    const tx = fakeTx();
    expect(await writeIfFigureFree(tx, locked(), [line({ qty: 3 }, false)], ctx())).toBeNull();
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.invoiceItem.update).not.toHaveBeenCalled();
  });

  it("a moved discount or shipping is a money edit too", async () => {
    const tx = fakeTx();
    expect(
      await writeIfFigureFree(tx, locked(), [line()], ctx({ dto: { discount: 5 } })),
    ).toBeNull();
    expect(
      await writeIfFigureFree(tx, locked(), [line()], ctx({ dto: { shippingFee: 4 } })),
    ).toBeNull();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("a dropped line is a money edit", async () => {
    const tx = fakeTx();
    expect(await writeIfFigureFree(tx, locked(), [], ctx())).toBeNull();
  });

  it("a notes change writes ONE invoice update (notes + pdfUrl null) and no figure", async () => {
    const tx = fakeTx();
    const out = await writeIfFigureFree(
      tx,
      locked(),
      [line()],
      ctx({ dto: { notes: "gate code 42" } }),
    );
    expect(out).toMatchObject({ id: "inv-1", updated: true });
    expect(tx.invoice.update).toHaveBeenCalledTimes(1);
    const data = tx.invoice.update.mock.calls[0][0].data;
    expect(data).toEqual({ notes: "gate code 42", pdfUrl: null });
    for (const k of ["subtotal", "taxAmount", "discount", "shippingFee", "total", "items"])
      expect(data).not.toHaveProperty(k);
    expect(tx.invoiceItem.update).not.toHaveBeenCalled();
  });

  it("a line's description and notes patch in place; the price columns never do", async () => {
    const tx = fakeTx();
    const l = line({ description: "Widget (blue)", notes: "fragile", unitPrice: 999, subtotal: 1 });
    await writeIfFigureFree(tx, locked(), [l], ctx());
    expect(tx.invoiceItem.update).toHaveBeenCalledTimes(1);
    expect(tx.invoiceItem.update.mock.calls[0][0]).toEqual({
      where: { id: "r1" },
      data: { description: "Widget (blue)", notes: "fragile" },
    });
  });

  it("an unchanged screen payload writes NOTHING and returns the invoice as stored (A2-N1 rule 5)", async () => {
    const tx = fakeTx();
    const out = await writeIfFigureFree(
      tx,
      locked(),
      [line()],
      ctx({
        dto: { notes: undefined },
        issueDate: cur.issueDate,
        due: { dueDate: cur.dueDate, depositDueDate: null },
      }),
    );
    expect(out).toEqual({ id: "inv-1", reread: true });
    expect(tx.invoice.update).not.toHaveBeenCalled();
    expect(tx.invoiceItem.update).not.toHaveBeenCalled();
  });

  it("the gate runs first: an operator, a moved issue date and a paid invoice are refused before any write", async () => {
    for (const [over, lk, reason] of [
      [{ actor: { role: UserRole.OPERATOR } as any }, locked(), "NOT_ADMIN"],
      [{ issueDate: new Date("2026-11-09T00:00:00Z") }, locked(), "ISSUE_DATE"],
      [{}, { ...locked(), invoice: { ...cur, status: InvoiceStatus.PAID } }, "PAID"],
    ] as const) {
      const tx = fakeTx();
      await expect(writeIfFigureFree(tx, lk, [line()], ctx(over))).rejects.toMatchObject({
        response: { code: "INVOICE_EDIT_REFUSED", reason },
      });
      expect(tx.invoice.update).not.toHaveBeenCalled();
    }
  });
});

describe("writeIfFigureFree (header-only branch, no lines in the save)", () => {
  it("discount and shipping equal to the locked row are figure-free: header fields only, no re-price", async () => {
    const tx = fakeTx();
    const out = await writeIfFigureFree(
      tx,
      locked(),
      null,
      ctx({ dto: { discount: 0, shippingFee: 0, notes: "n" } }),
    );
    expect(out).toMatchObject({ id: "inv-1", updated: true });
    expect(tx.invoice.update.mock.calls[0][0].data).toEqual({ notes: "n", pdfUrl: null });
  });

  it("a figure that moves by a cent is a money edit: null", async () => {
    const tx = fakeTx();
    expect(
      await writeIfFigureFree(tx, locked(), null, ctx({ dto: { discount: 0.01 } })),
    ).toBeNull();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });

  it("a header-only save of nothing new writes nothing", async () => {
    const tx = fakeTx();
    const out = await writeIfFigureFree(tx, locked(), null, ctx({ dto: {} }));
    expect(out).toEqual({ id: "inv-1", reread: true });
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});
