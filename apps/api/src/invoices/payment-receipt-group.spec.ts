/**
 * SA-1208 D1 (M1-02): the read-only receipt reader. Red-first: each case below is written on the value a WRONG reader gives
 * (a merged null group, a later balance, a VOID number, a string compare, a credit tender, a leaked customer).
 * Mocked at the module boundary: `forTenant()` is the only door to the database, so a raw-client read throws.
 */
import { Test } from "@nestjs/testing";
import { groupWindowPayments } from "../orders/counter-sale/window-payment-groups";
import { pickupTenderGroupId } from "../orders/counter-sale/pickup-tender-group";
import { PrismaService } from "../prisma/prisma.service";
import { findPaymentById } from "./payment-list-query";
import { readReceiptGroup, receiptKeyOf } from "./payment-receipt-group";

type Row = Record<string, any>;
let seq = 0;

/** A payment row on an acme invoice. `over` wins; `customerId` / `invoice` shape the invoice side. */
function pay(over: Row = {}): Row {
  const n = ++seq;
  const {
    customerId = "cust-1",
    invoiceNumber = `INV-ACME-${n}`,
    orderId = null,
    order = null,
    ...rest
  } = over;
  return {
    id: `pay-${n}`,
    amount: 100,
    method: "CHECK",
    status: "PAID",
    reference: "1042",
    paymentNumber: null,
    paymentGroupId: null,
    checkStatus: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, n)),
    settledAt: null,
    paidAt: new Date("2026-11-01T12:00:00Z"),
    creditNoteId: null,
    advancePaymentId: null,
    invoice: { id: `inv-${n}`, invoiceNumber, customerId, orderId, order },
    ...rest,
  };
}

async function reader(payments: Row[], advances: Row[] = []) {
  const db = {
    invoicePayment: {
      findUnique: jest.fn(
        async ({ where }: any) => payments.find((p) => p.id === where.id) ?? null,
      ),
      // honours the where it is given, so a missing customer filter shows up as extra rows
      findMany: jest.fn(async ({ where }: any) =>
        payments.filter(
          (p) =>
            p.paymentGroupId === where.paymentGroupId &&
            (where.invoice?.customerId == null ||
              p.invoice.customerId === where.invoice.customerId),
        ),
      ),
    },
    advancePayment: {
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const rows = advances.filter(
          (a) =>
            a.customerId === where.customerId &&
            where.sourcePaymentId.in.includes(a.sourcePaymentId),
        );
        // honours orderBy [{ createdAt: "asc" }, { id: "asc" }] only when the reader asks for it
        return orderBy
          ? [...rows].sort(
              (x, y) =>
                new Date(x.createdAt ?? 0).getTime() - new Date(y.createdAt ?? 0).getTime() ||
                (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
            )
          : rows;
      }),
    },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: PrismaService, useValue: { forTenant: () => db } }],
  }).compile();
  return { prisma: moduleRef.get(PrismaService), db };
}

const office = (gid: string, over: Row = {}) => pay({ paymentGroupId: gid, ...over });

describe("receiptKeyOf: the five kinds, by existing predicates only", () => {
  it("names each kind and its key", () => {
    const orderId = "order-1";
    expect(receiptKeyOf({ id: "a", method: "ADVANCE", paymentGroupId: "g" })).toEqual({
      kind: "CREDIT_USE",
      key: "a",
    });
    expect(receiptKeyOf({ id: "b", method: "CASH", paymentGroupId: null })).toEqual({
      kind: "SINGLE",
      key: "b",
    });
    expect(
      receiptKeyOf({
        id: "c",
        method: "CASH",
        paymentGroupId: pickupTenderGroupId(orderId),
        invoice: { orderId },
      }),
    ).toEqual({ kind: "PICKUP_TENDERS", key: pickupTenderGroupId(orderId) });
    expect(receiptKeyOf({ id: "d", method: "CHECK", paymentGroupId: "g-1" })).toEqual({
      kind: "OFFICE_GROUP",
      key: "g-1",
    });
  });

  it("another order's pickup id is an office group of its own, never this order's pickup view", () => {
    const row = {
      id: "e",
      method: "CASH",
      paymentGroupId: pickupTenderGroupId("order-2"),
      invoice: { orderId: "order-1" },
    };
    expect(receiptKeyOf(row).kind).toBe("OFFICE_GROUP");
  });

  it("its credit methods equal groupWindowPayments' credit rule (no second predicate, L-368)", () => {
    for (const method of [
      "CASH",
      "CHECK",
      "CREDIT_CARD",
      "ACH",
      "ZELLE",
      "OTHER",
      "CREDIT_NOTE",
      "ADVANCE",
    ]) {
      const g = groupWindowPayments([
        { amount: 5, method, status: "PAID", paymentGroupId: "office-g", invoice: null },
      ]);
      const windowSaysCredit = g.byMethod.has(method) && g.notAtTill === 0;
      expect(
        receiptKeyOf({ id: "x", method, paymentGroupId: "office-g" }).kind === "CREDIT_USE",
      ).toBe(windowSaysCredit);
    }
  });
});

describe("readReceiptGroup: the office check (case table D1)", () => {
  it("check 1042 opened from invoice B reads $4,000 across A $3,000 and B $1,000", async () => {
    const a = office("g-1042", { amount: 3000, paymentNumber: "PAY-ACME-0100" });
    const b = office("g-1042", { amount: 1000, paymentNumber: "PAY-ACME-0101" });
    const { prisma } = await reader([a, b]);
    const view = await readReceiptGroup(prisma, b.id);
    expect(view.kind).toBe("OFFICE_GROUP");
    expect(view.header).toMatchObject({
      key: "g-1042",
      total: 4000,
      reference: "1042",
      method: "CHECK",
      confirmed: true,
    });
    expect(view.applications.map((x) => [x.invoiceNumber, x.amount])).toEqual([
      [a.invoice.invoiceNumber, 3000],
      [b.invoice.invoiceNumber, 1000],
    ]);
    expect(view.tenders).toEqual([
      { method: "CHECK", reference: "1042", amount: 4000, voided: false, paymentIds: [a.id, b.id] },
    ]);
  });

  it("a group id planted on two customers in one tenant reads only the anchor customer's rows", async () => {
    const mine1 = office("g-shared", { amount: 3000, customerId: "cust-1" });
    const mine2 = office("g-shared", { amount: 1000, customerId: "cust-1" });
    const theirs = office("g-shared", { amount: 777, customerId: "cust-2" });
    const { prisma, db } = await reader([mine1, mine2, theirs]);
    const view = await readReceiptGroup(prisma, mine1.id);
    expect(view.header?.total).toBe(4000);
    expect(view.applications.map((x) => x.paymentId).sort()).toEqual([mine1.id, mine2.id].sort());
    expect((db.invoicePayment.findMany.mock.calls[0][0] as any).where.invoice.customerId).toBe(
      "cust-1",
    );
    const other = await readReceiptGroup(prisma, theirs.id);
    expect(other.header?.total).toBe(777);
    expect(other.applications).toHaveLength(1);
  });

  it("every read goes through forTenant (the raw client is never touched)", async () => {
    const row = office("g-t", { amount: 10 });
    const { prisma } = await reader([row]);
    expect((prisma as any).invoicePayment).toBeUndefined();
    await expect(readReceiptGroup(prisma, row.id)).resolves.toBeDefined();
  });

  it("a payment outside the tenant (not found through forTenant) is a 404, not an empty receipt", async () => {
    const { prisma } = await reader([]);
    await expect(readReceiptGroup(prisma, "nope")).rejects.toThrow("Payment not found");
  });
});

describe("readReceiptGroup: red tests (cross.md, the Bug skeptic's seven)", () => {
  it("1. null groups of $100, $200 and $300 across two customers: the $100 row reads $100, never merged", async () => {
    const r100 = pay({ amount: 100, customerId: "cust-1", reference: null });
    const r200 = pay({ amount: 200, customerId: "cust-1", reference: null });
    const r300 = pay({ amount: 300, customerId: "cust-2", reference: null });
    const { prisma, db } = await reader([r100, r200, r300]);
    const view = await readReceiptGroup(prisma, r100.id);
    expect(view.kind).toBe("SINGLE");
    expect(view.header?.total).toBe(100);
    expect(view.header?.key).toBe(r100.id);
    expect(view.tenders).toHaveLength(1);
    expect(view.applications).toHaveLength(1);
    expect(db.invoicePayment.findMany).not.toHaveBeenCalled(); // a null group is never a sibling lookup
  });

  it("2. unused credit is the advance's ORIGINAL amount, not its later balance; unlinked reads not recorded (null), never 0", async () => {
    const a = office("g-2", { amount: 3000 });
    const linked = {
      id: "adv-1",
      customerId: "cust-1",
      sourcePaymentId: a.id,
      amount: 500,
      balance: 0,
    };
    const { prisma } = await reader([a], [linked]);
    expect((await readReceiptGroup(prisma, a.id)).unapplied).toEqual({
      amount: 500,
      advancePaymentId: "adv-1",
    });

    const none = await reader([a], []);
    expect((await readReceiptGroup(none.prisma, a.id)).unapplied).toEqual({
      amount: null,
      advancePaymentId: null,
    });

    const otherCustomers = await reader([a], [{ ...linked, customerId: "cust-2" }]);
    expect((await readReceiptGroup(otherCustomers.prisma, a.id)).unapplied.amount).toBeNull();
  });

  it("3. a VOID row is struck through (voided tender), excluded from the total, and the number never comes from it", async () => {
    const live = office("g-3", { amount: 4000, paymentNumber: "PAY-ACME-0102" });
    const voided = office("g-3", { amount: 999, status: "VOID", paymentNumber: "PAY-ACME-0001" });
    const { prisma } = await reader([live, voided]);
    const view = await readReceiptGroup(prisma, live.id);
    expect(view.header?.total).toBe(4000);
    expect(view.header?.number).toBe("PAY-ACME-0102");
    expect(view.header?.partlyVoided).toBe(true);
    expect(view.tenders.find((t) => t.voided)).toMatchObject({
      amount: 999,
      paymentIds: [voided.id],
    });
    expect(view.applications.find((x) => x.paymentId === voided.id)?.status).toBe("VOID");
  });

  it("4. the number compares numerically (0099 before 0102; 9999 before 10000); a null number falls back to the reference", async () => {
    const p1 = office("g-4", { paymentNumber: "PAY-ACME-0102" });
    const p2 = office("g-4", { paymentNumber: "PAY-ACME-0099" });
    expect((await readReceiptGroup((await reader([p1, p2])).prisma, p1.id)).header?.number).toBe(
      "PAY-ACME-0099",
    );

    const q1 = office("g-4b", { paymentNumber: "PAY-ACME-10000" });
    const q2 = office("g-4b", { paymentNumber: "PAY-ACME-9999" });
    expect((await readReceiptGroup((await reader([q1, q2])).prisma, q1.id)).header?.number).toBe(
      "PAY-ACME-9999",
    );

    const n = office("g-4c", { paymentNumber: null, reference: "CHK-77" });
    expect((await readReceiptGroup((await reader([n])).prisma, n.id)).header?.number).toBe(
      "CHK-77",
    );
  });

  it("5. CREDIT_NOTE and ADVANCE rows are never a receipt, and never a tender inside a group", async () => {
    for (const method of ["CREDIT_NOTE", "ADVANCE"]) {
      const credit = office("g-5", {
        method,
        amount: 500,
        advancePaymentId: "adv-9",
        creditNoteId: "cn-9",
      });
      const view = await readReceiptGroup((await reader([credit])).prisma, credit.id);
      expect(view.kind).toBe("CREDIT_USE");
      expect(view.header).toBeNull();
      expect(view.tenders).toEqual([]);
    }
    const check = office("g-5b", { amount: 3000 });
    const credit = office("g-5b", { method: "ADVANCE", amount: 500 });
    const view = await readReceiptGroup((await reader([check, credit])).prisma, check.id);
    expect(view.header?.total).toBe(3000);
    expect(view.tenders.map((t) => t.method)).toEqual(["CHECK"]);
    expect(view.applications).toHaveLength(1);
  });

  it("7. an advance-only check is a credits entry (links to its advance), never an empty receipt", async () => {
    const use = pay({
      method: "ADVANCE",
      amount: 250,
      advancePaymentId: "adv-7",
      paymentGroupId: null,
    });
    const view = await readReceiptGroup((await reader([use])).prisma, use.id);
    expect(view.header).toBeNull();
    expect(view.tenders).toEqual([]);
    expect(view.applications).toEqual([
      expect.objectContaining({ paymentId: use.id, amount: 250, advancePaymentId: "adv-7" }),
    ]);
  });
});

describe("readReceiptGroup: pins H1-H4, P4 and the pickup grain", () => {
  it("a mixed-status group shows each row's status and totals the confirmed rows only", async () => {
    const ok = office("g-6", { amount: 3000 });
    const bounced = office("g-6", { amount: 1000, status: "VOID", checkStatus: "BOUNCED" });
    const view = await readReceiptGroup((await reader([ok, bounced])).prisma, ok.id);
    expect(view.header).toMatchObject({ total: 3000, partlyVoided: true, confirmed: true });
    expect(view.applications.map((x) => [x.status, x.checkStatus])).toEqual([
      ["PAID", null],
      ["VOID", "BOUNCED"],
    ]);
  });

  it("a group with no confirmed row reads not confirmed, and its excess is never offered as available credit", async () => {
    const pending = office("g-7", { amount: 3000, status: "PENDING" });
    const advance = {
      id: "adv-2",
      customerId: "cust-1",
      sourcePaymentId: pending.id,
      amount: 500,
      balance: 500,
    };
    const view = await readReceiptGroup((await reader([pending], [advance])).prisma, pending.id);
    expect(view.header).toMatchObject({ confirmed: false, total: 0 });
    expect(view.unapplied).toEqual({ amount: null, advancePaymentId: null });
  });

  it("a pickup hand-over is ONE view per order: its tenders by method, a voided re-take struck and excluded", async () => {
    const orderId = "order-1";
    const gid = pickupTenderGroupId(orderId);
    const order = { counterSale: false, orderNumber: "ORD-ACME-1" };
    const voidedCash = pay({
      paymentGroupId: gid,
      orderId,
      order,
      method: "CASH",
      amount: 60,
      status: "VOID",
      reference: null,
    });
    const cash = pay({
      paymentGroupId: gid,
      orderId,
      order,
      method: "CASH",
      amount: 40,
      reference: null,
    });
    const card = pay({
      paymentGroupId: gid,
      orderId,
      order,
      method: "CREDIT_CARD",
      amount: 25,
      reference: null,
    });
    const foreign = pay({
      paymentGroupId: gid,
      orderId,
      order,
      method: "ACH",
      amount: 999,
      reference: null,
    });
    const { prisma } = await reader([voidedCash, cash, card, foreign]);
    const view = await readReceiptGroup(prisma, cash.id);
    expect(view.kind).toBe("PICKUP_TENDERS");
    expect(view.header).toMatchObject({ orderId, orderNumber: "ORD-ACME-1", total: 65, key: gid });
    expect(view.tenders.map((t) => [t.method, t.amount, t.voided])).toEqual([
      ["CASH", 60, true],
      ["CASH", 40, false],
      ["CREDIT_CARD", 25, false],
    ]);
  });
});

describe("findPaymentById goes through the reader", () => {
  it("returns the payment as before, plus the receipt it covered", async () => {
    const a = office("g-8", { amount: 3000 });
    const b = office("g-8", { amount: 1000 });
    const { prisma, db } = await reader([a, b]);
    (db.invoicePayment.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
      [a, b].find((p) => p.id === where.id),
    );
    const out: any = await findPaymentById(prisma, a.id);
    expect(out.id).toBe(a.id);
    expect(out.invoice.invoiceNumber).toBe(a.invoice.invoiceNumber);
    expect(out.receipt.header.total).toBe(4000);
  });

  it("a missing payment is still a 404", async () => {
    const { prisma } = await reader([]);
    await expect(findPaymentById(prisma, "nope")).rejects.toThrow("Payment not found");
  });
});

describe("readReceiptGroup: read B of #4406 (H1, L1 to L4)", () => {
  const pickupOrder = { counterSale: false, orderNumber: "ORD-ACME-1" };
  const gid = pickupTenderGroupId("order-1");
  const pickupCheck = (amount: number, over: Row = {}) =>
    pay({
      paymentGroupId: gid,
      orderId: "order-1",
      order: pickupOrder,
      method: "CHECK",
      reference: "1042",
      amount,
      ...over,
    });

  it("H1. a pickup check deposited after the hand-over still reads $4,000 across both invoices, from either row", async () => {
    const a = pickupCheck(3000, { checkStatus: "DEPOSITED" });
    const b = pickupCheck(1000, { checkStatus: "DEPOSITED" });
    const { prisma } = await reader([a, b]);
    for (const anchor of [a, b]) {
      const view = await readReceiptGroup(prisma, anchor.id);
      expect(view.kind).toBe("PICKUP_TENDERS");
      expect(view.header?.total).toBe(4000);
      expect(view.applications).toHaveLength(2);
    }
  });

  it("H1. a deposited check beside a still-recorded sibling reads $4,000 too", async () => {
    const a = pickupCheck(3000, { checkStatus: "DEPOSITED" });
    const b = pickupCheck(1000, { checkStatus: "RECORDED" });
    const { prisma } = await reader([a, b]);
    expect((await readReceiptGroup(prisma, a.id)).header?.total).toBe(4000);
    expect((await readReceiptGroup(prisma, b.id)).header?.total).toBe(4000);
  });

  it("H1. a credit row that carries the pickup id is still never a tender", async () => {
    const a = pickupCheck(3000, { checkStatus: "DEPOSITED" });
    const credit = pickupCheck(40, { method: "ADVANCE" });
    const { prisma } = await reader([a, credit]);
    const view = await readReceiptGroup(prisma, a.id);
    expect(view.header?.total).toBe(3000);
    expect(view.applications.map((x) => x.paymentId)).toEqual([a.id]);
  });

  it('L1. an empty-string group is no group: two rows keyed "" are two one-row receipts, never merged', async () => {
    const a = pay({ paymentGroupId: "", amount: 10 });
    const b = pay({ paymentGroupId: "", amount: 20 });
    const { prisma, db } = await reader([a, b]);
    expect(receiptKeyOf({ id: a.id, method: "CASH", paymentGroupId: "" })).toEqual({
      kind: "SINGLE",
      key: a.id,
    });
    const view = await readReceiptGroup(prisma, a.id);
    expect(view.kind).toBe("SINGLE");
    expect(view.header?.total).toBe(10);
    expect(db.invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("L2. the one-payment read is at most 3 queries (the anchor is read once and handed to the reader)", async () => {
    const a = office("g-l2", { amount: 3000 });
    const b = office("g-l2", { amount: 1000 });
    const { prisma, db } = await reader(
      [a, b],
      [{ id: "adv-1", customerId: "cust-1", sourcePaymentId: a.id, amount: 5, balance: 5 }],
    );
    const out: any = await findPaymentById(prisma, a.id);
    expect(out.receipt.header.total).toBe(4000);
    const queries =
      db.invoicePayment.findUnique.mock.calls.length +
      db.invoicePayment.findMany.mock.calls.length +
      db.advancePayment.findMany.mock.calls.length;
    expect(queries).toBeLessThanOrEqual(3);
  });

  it("L3. the row clicked is always on its own view, even when the sibling read does not return it", async () => {
    const a = office("g-l3", { amount: 3000 });
    const b = office("g-l3", { amount: 1000 });
    const { prisma, db } = await reader([a, b]);
    (db.invoicePayment.findMany as jest.Mock).mockResolvedValueOnce([b]); // the anchor's own row is missing from the read
    const view = await readReceiptGroup(prisma, a.id);
    expect(view.applications.map((x) => x.paymentId).sort()).toEqual([a.id, b.id].sort());
    expect(view.header?.total).toBe(4000);
  });

  it("L4. with two advances linked to the check, the link is the earliest one, whatever order the database returns", async () => {
    const a = office("g-l4", { amount: 3000 });
    const later = {
      id: "adv-b",
      customerId: "cust-1",
      sourcePaymentId: a.id,
      amount: 200,
      balance: 200,
      createdAt: new Date("2026-11-02T00:00:00Z"),
    };
    const first = {
      ...later,
      id: "adv-z",
      amount: 100,
      balance: 0,
      createdAt: new Date("2026-11-01T00:00:00Z"),
    };
    const { prisma } = await reader([a], [later, first]); // listed newest first: an unordered read picks the wrong one
    const view = await readReceiptGroup(prisma, a.id);
    expect(view.unapplied.advancePaymentId).toBe("adv-z");
    expect(view.unapplied.amount).toBe(300);
  });
});
