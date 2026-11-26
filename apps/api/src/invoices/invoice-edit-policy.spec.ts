import { InvoiceStatus, UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import {
  EDITABLE_ISSUED_STATUSES,
  INVOICE_EDIT_REFUSAL_MESSAGES,
  invoiceEditDecision,
  invoiceStaffDetailFields,
  loadInvoiceEditInputs,
  type InvoiceEditInputs,
} from "./invoice-edit-policy";
import { INVOICE_EDIT_BLOCK_REASONS } from "@routeflow/types";

// the send state is its own module's concern (and its own specs); here it is a stub
jest.mock("./invoice-send-state", () => ({
  sendFieldsFor: jest.fn().mockResolvedValue({ sendState: "unchanged", sendLocked: null }),
}));

/**
 * SA-1508 commit 4 (policy). Red on master: the module does not exist. Every cell of the SA-1508 section 6 state
 * table for a standalone and an order-linked invoice, the A2-6 precedence, admin vs operator, and the tenantless
 * caller that never reaches the loader.
 */
const base = (over: Partial<InvoiceEditInputs> = {}): InvoiceEditInputs => ({
  admin: true,
  status: InvoiceStatus.SENT,
  orderId: null,
  payments: { live: 0, confirmed: 0 },
  openRequests: { cash: false, online: false },
  creditAgainst: false,
  hasUnitLine: false,
  ...over,
});
const reasonOf = (i: InvoiceEditInputs, change?: Parameters<typeof invoiceEditDecision>[1]) =>
  invoiceEditDecision(i, change).blocked?.reason ?? null;

describe("invoiceEditDecision: the state table (SA-1508 section 6)", () => {
  it.each([InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE])(
    "an admin may edit a standalone %s invoice nobody has paid",
    (status) => {
      expect(invoiceEditDecision(base({ status }))).toEqual({ action: "EDIT", blocked: null });
    },
  );

  it.each([InvoiceStatus.PARTIAL, InvoiceStatus.PAID])(
    "a %s standalone invoice is refused PAID (PR-3), even for a figure-free save",
    (status) => {
      expect(reasonOf(base({ status }))).toBe("PAID");
      expect(reasonOf(base({ status }), { money: false })).toBe("PAID");
    },
  );

  it("VOID and WRITTEN_OFF are refused for everyone, ahead of NOT_ADMIN", () => {
    for (const admin of [true, false]) {
      expect(reasonOf(base({ status: InvoiceStatus.VOID, admin }))).toBe("VOID");
      expect(reasonOf(base({ status: InvoiceStatus.WRITTEN_OFF, admin }))).toBe("WRITTEN_OFF");
    }
  });

  it("an operator is NOT_ADMIN and nothing else is judged (the loader inputs are not even read)", () => {
    const boom = new Proxy(
      {},
      {
        get: () => {
          throw new Error("read");
        },
      },
    ) as never;
    expect(
      reasonOf({
        ...base({ admin: false }),
        payments: boom,
        openRequests: boom,
        creditAgainst: undefined,
      }),
    ).toBe("NOT_ADMIN");
  });

  it("NOT_ADMIN carries the order for the 'Edit order' button", () => {
    const d = invoiceEditDecision(base({ admin: false, orderId: "o1", orderNumber: "1001" }));
    expect(d).toEqual({
      action: null,
      blocked: { reason: "NOT_ADMIN", orderId: "o1", orderNumber: "1001" },
    });
  });

  it("an order-linked issued invoice edits on the order (EDIT_ORDER) with the order named", () => {
    const d = invoiceEditDecision(
      base({ orderId: "o1", orderNumber: "1001", orderReach: "REACHES" }),
    );
    expect(d.action).toBe("EDIT_ORDER");
    expect(d.blocked).toEqual({ reason: "ORDER_LINKED", orderId: "o1", orderNumber: "1001" });
  });

  it("an order edit that cannot reach the invoice is PART_OF_ORDER, with no action", () => {
    expect(
      invoiceEditDecision(base({ orderId: "o1", orderNumber: "1001", orderReach: "PART" })),
    ).toEqual({
      action: null,
      blocked: { reason: "PART_OF_ORDER", orderId: "o1", orderNumber: "1001" },
    });
  });

  it("a DRAFT is today's rule: edit, or edit the order while it is the order's pending mirror", () => {
    expect(invoiceEditDecision(base({ status: InvoiceStatus.DRAFT, admin: false }))).toEqual({
      action: "EDIT",
      blocked: null,
    });
    expect(
      invoiceEditDecision(
        base({ status: InvoiceStatus.DRAFT, orderId: "o1", pendingMirror: true }),
      ),
    ).toEqual({ action: "EDIT_ORDER", blocked: null });
    expect(
      invoiceEditDecision(
        base({ status: InvoiceStatus.DRAFT, orderId: "o1", pendingMirror: false }),
      ).action,
    ).toBe("EDIT");
  });
});

describe("invoiceEditDecision: money gates and precedence (A2-6)", () => {
  it.each<[string, Partial<InvoiceEditInputs>, string]>([
    ["filed month", { filedBlocked: true }, "FILED"],
    ["cash declaration waiting", { openRequests: { cash: true, online: false } }, "PAYING_CASH"],
    ["card request open", { openRequests: { cash: false, online: true } }, "PAYING_ONLINE"],
    ["a payment row not yet confirmed", { payments: { live: 1, confirmed: 0 } }, "PENDING_PAYMENT"],
    ["a confirmed payment", { payments: { live: 1, confirmed: 1 } }, "PAID"],
    ["a credit note or return", { creditAgainst: true }, "CREDIT"],
    ["a unit line", { hasUnitLine: true }, "UNIT_LINE"],
    ["a stored total no line explains", { totalNotFromLines: true }, "TOTAL_NOT_FROM_LINES"],
  ])("a money edit with %s is refused %s", (_what, over, reason) => {
    expect(reasonOf(base(over), { money: true })).toBe(reason);
    expect(reasonOf(base(over))).toBe(reason); // the detail read judges the screen's money edit
  });

  it("a figure-free save passes every money gate", () => {
    const all = base({
      filedBlocked: true,
      openRequests: { cash: true, online: true },
      payments: { live: 2, confirmed: 1 },
      creditAgainst: true,
      hasUnitLine: true,
      totalNotFromLines: true,
    });
    expect(invoiceEditDecision(all, { money: false })).toEqual({ action: "EDIT", blocked: null });
  });

  it("precedence, first hit wins: FILED, PAYING_CASH, PAYING_ONLINE, PENDING_PAYMENT, PAID, CREDIT, UNIT_LINE, TOTAL_NOT_FROM_LINES", () => {
    let i = base({
      filedBlocked: true,
      openRequests: { cash: true, online: true },
      payments: { live: 2, confirmed: 1 },
      creditAgainst: true,
      hasUnitLine: true,
      totalNotFromLines: true,
    });
    const seen: string[] = [];
    seen.push(reasonOf(i)!);
    i = { ...i, filedBlocked: false };
    seen.push(reasonOf(i)!);
    i = { ...i, openRequests: { cash: false, online: true } };
    seen.push(reasonOf(i)!);
    i = { ...i, openRequests: { cash: false, online: false } };
    seen.push(reasonOf(i)!); // live 2 > confirmed 1: pending first
    i = { ...i, payments: { live: 1, confirmed: 1 } };
    seen.push(reasonOf(i)!);
    i = { ...i, payments: { live: 0, confirmed: 0 } };
    seen.push(reasonOf(i)!);
    i = { ...i, creditAgainst: false };
    seen.push(reasonOf(i)!);
    i = { ...i, hasUnitLine: false };
    seen.push(reasonOf(i)!);
    expect(seen).toEqual([
      "FILED",
      "PAYING_CASH",
      "PAYING_ONLINE",
      "PENDING_PAYMENT",
      "PAID",
      "CREDIT",
      "UNIT_LINE",
      "TOTAL_NOT_FROM_LINES",
    ]);
  });

  it("order and field rules come ahead of the money gates", () => {
    const money = { payments: { live: 1, confirmed: 1 } };
    expect(reasonOf(base({ ...money, orderId: "o1", orderReach: "PART" }))).toBe("PART_OF_ORDER");
    expect(reasonOf(base(money), { money: true, issueDateChanged: true })).toBe("ISSUE_DATE");
    expect(reasonOf(base(money), { money: true, depositChanged: true })).toBe("DEPOSIT");
  });

  it("a figure-free save may still be refused for the date and deposit fields", () => {
    expect(reasonOf(base(), { money: false, issueDateChanged: true })).toBe("ISSUE_DATE");
    expect(reasonOf(base(), { money: false, depositChanged: true })).toBe("DEPOSIT");
  });

  it("a total of zero or less is ZERO_TOTAL on a money edit; a positive one passes", () => {
    expect(reasonOf(base(), { money: true, newTotal: 0 })).toBe("ZERO_TOTAL");
    expect(reasonOf(base(), { money: true, newTotal: -5 })).toBe("ZERO_TOTAL");
    expect(reasonOf(base(), { money: true, newTotal: 0.01 })).toBeNull();
    expect(reasonOf(base(), { money: false, newTotal: 0 })).toBeNull();
  });

  it("every refusal reason has words, and every reason the policy returns is a declared reason", () => {
    expect(Object.keys(INVOICE_EDIT_REFUSAL_MESSAGES).sort()).toEqual(
      [...INVOICE_EDIT_BLOCK_REASONS].sort(),
    );
    expect([...EDITABLE_ISSUED_STATUSES].sort()).toEqual(["OVERDUE", "SENT", "VIEWED"]);
  });
});

describe("loadInvoiceEditInputs and invoiceStaffDetailFields", () => {
  const dbOf = (over: Record<string, any> = {}) => ({
    invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
    buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: { count: jest.fn().mockResolvedValue(0) },
    returnItem: { count: jest.fn().mockResolvedValue(0) },
    order: { findUnique: jest.fn() },
    customer: { findFirst: jest.fn().mockResolvedValue({ isTaxExempt: false }) },
    ...over,
  });
  const inv = (over: Record<string, any> = {}) => ({
    id: "inv-1",
    customerId: "cust-1",
    orderId: null,
    status: InvoiceStatus.SENT,
    sentAt: new Date("2026-01-01"),
    deliveryBatchId: null,
    subtotal: 200,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 200,
    items: [
      { id: "l1", subtotal: 100, taxRate: 0 },
      { id: "l2", subtotal: 100, taxRate: 0 },
    ],
    ...over,
  });

  it("reads payments, open requests by kind, credit notes and returns through the client it is given", async () => {
    const db = dbOf({
      invoicePayment: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ status: "PAID" }, { status: "VOID" }, { status: "DRAFT" }]),
      },
      buyerPaymentRequest: { findMany: jest.fn().mockResolvedValue([{ kind: "CARD" }]) },
      creditNote: { count: jest.fn().mockResolvedValue(1) },
    });
    const r = await loadInvoiceEditInputs(db, inv());
    expect(r.payments).toEqual({ live: 2, confirmed: 1 }); // the VOID row carries no money and never blocks
    expect(r.openRequests).toEqual({ cash: false, online: true });
    expect(r.creditAgainst).toBe(true);
    expect(db.buyerPaymentRequest.findMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: { in: ["PENDING", "SETTLING"] } },
      select: { kind: true },
    });
    expect(db.creditNote.count).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1", status: { not: "VOID" } },
    });
  });

  it("a return that cites one of the lines counts as credit; none cited reads nothing", async () => {
    const db = dbOf({ returnItem: { count: jest.fn().mockResolvedValue(2) } });
    expect((await loadInvoiceEditInputs(db, inv())).creditAgainst).toBe(true);
    expect(db.returnItem.count).toHaveBeenCalledWith({
      where: {
        sourceInvoiceItemId: { in: ["l1", "l2"] },
        return: { status: { notIn: ["REJECTED", "CANCELLED"] } },
      },
    });
    const none = dbOf();
    await loadInvoiceEditInputs(none, inv({ items: [] }));
    expect(none.returnItem.count).not.toHaveBeenCalled();
  });

  it("reuses the payment rows the lock already read instead of reading them again", async () => {
    const db = dbOf();
    const r = await loadInvoiceEditInputs(db, inv(), { payments: [{ status: "PAID" }] });
    expect(r.payments).toEqual({ live: 1, confirmed: 1 });
    expect(db.invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("a line sold by a unit is flagged", async () => {
    const r = await loadInvoiceEditInputs(
      dbOf(),
      inv({ items: [{ id: "l1", unitLabel: "Case" }] }),
    );
    expect(r.hasUnitLine).toBe(true);
  });

  it("before delivery an order edit reaches the invoice only while it has no live payment row", async () => {
    const order = {
      findUnique: jest.fn().mockResolvedValue({ orderNumber: "1001", deliveredAt: null }),
    };
    const free = await loadInvoiceEditInputs(dbOf({ order }), inv({ orderId: "o1" }));
    expect(free.orderReach).toBe("REACHES");
    expect(free.orderNumber).toBe("1001");
    const paid = await loadInvoiceEditInputs(
      dbOf({
        order,
        invoicePayment: { findMany: jest.fn().mockResolvedValue([{ status: "DRAFT" }]) },
      }),
      inv({ orderId: "o1" }),
    );
    expect(paid.orderReach).toBe("PART");
  });

  const fieldsFor = (
    actor: Partial<JwtPayload>,
    tenantId: string | null,
    db = dbOf(),
    over = {},
  ) => {
    const prisma = { getTenantId: () => tenantId, forTenant: jest.fn(() => db) };
    const featureConfig = {};
    return {
      prisma,
      run: () =>
        invoiceStaffDetailFields(prisma, featureConfig, actor as JwtPayload, inv(over) as any),
    };
  };

  it("a tenantless super admin is refused NOT_ADMIN before any read", async () => {
    const db = dbOf();
    const f = fieldsFor({ role: UserRole.SUPER_ADMIN }, null, db);
    const out = await f.run();
    expect(out.editAction).toBeNull();
    expect(out.editBlocked).toEqual({ reason: "NOT_ADMIN" });
    expect(f.prisma.forTenant).not.toHaveBeenCalled(); // the policy loader never ran
    expect(db.invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("a tenant admin with a tenant reads the loader once and may edit an unpaid sent invoice", async () => {
    const db = dbOf();
    const f = fieldsFor({ role: UserRole.TENANT_ADMIN }, "t1", db);
    const out = await f.run();
    expect(out.editAction).toBe("EDIT");
    expect(out.editBlocked).toBeNull();
    expect(db.invoicePayment.findMany).toHaveBeenCalledTimes(1);
  });

  it("restampRate (A3-M1): null when the lines reproduce the stored tax, null on a DRAFT, the verified rate on a stale legacy invoice", async () => {
    const admin = { role: UserRole.TENANT_ADMIN };
    expect((await fieldsFor(admin, "t1").run()).restampRate).toBeNull();
    const stale = { subtotal: 200, taxAmount: 16.5, total: 216.5 };
    expect((await fieldsFor(admin, "t1", dbOf(), stale).run()).restampRate).toBe(0.0825);
    const draft = await fieldsFor(admin, "t1", dbOf(), {
      ...stale,
      status: InvoiceStatus.DRAFT,
    }).run();
    expect(draft.restampRate).toBeNull();
    const op = await fieldsFor({ role: UserRole.OPERATOR }, "t1", dbOf(), stale).run();
    expect(op.restampRate).toBeNull();
  });

  it("an operator reads nothing and is NOT_ADMIN; a DRAFT reads nothing and is EDIT", async () => {
    const db = dbOf();
    const op = fieldsFor({ role: UserRole.OPERATOR }, "t1", db);
    expect((await op.run()).editBlocked).toEqual({ reason: "NOT_ADMIN" });
    const draft = fieldsFor({ role: UserRole.TENANT_ADMIN }, "t1", db, {
      status: InvoiceStatus.DRAFT,
    });
    expect((await draft.run()).editAction).toBe("EDIT");
    expect(db.invoicePayment.findMany).not.toHaveBeenCalled();
    expect(db.buyerPaymentRequest.findMany).not.toHaveBeenCalled();
  });

  it("the wire carries the send state beside the edit fields", async () => {
    const out = await fieldsFor({ role: UserRole.TENANT_ADMIN }, "t1", dbOf(), {
      status: InvoiceStatus.DRAFT,
    }).run();
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(["sendState", "sendLocked", "editAction", "editBlocked"]),
    );
  });
});
