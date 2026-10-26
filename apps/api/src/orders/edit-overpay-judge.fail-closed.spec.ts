/**
 * W-871 (SA-948 §2 MUST 2): the overpay judge fails closed. When the in-place re-sync will restate the invoices
 * (`scope.resync`) but the projection cannot be built for a live invoice (an unclean partition: a manual line, a
 * line that lost its provenance), the judge used to read "nothing projected" as "nothing to judge" and let the edit
 * through, leaving the invoice PAID at its old total. Now it uses the new in-tx ORDER total as the projection and
 * refuses with the existing 409 ORDER_EDIT_WOULD_OVERPAY when the external money across the order's live invoices
 * exceeds it by more than half a cent. Increases still pass.
 */
import { assertEditCannotOverpay } from "./edit-overpay-judge";

type Inv = { id: string; status: string };
type Pay = { invoiceId: string; amount: number; method: string; status: string };

function fakeTx(invoices: Inv[], payments: Pay[], orderTotal: number) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    invoice: {
      findMany: jest.fn(async (args: any) =>
        invoices.filter(
          (i) => args.where.orderId === "ord-1" && i.status !== args.where.status?.not,
        ),
      ),
    },
    invoicePayment: {
      findMany: jest.fn(async (args: any) =>
        payments.filter(
          (p) =>
            args.where.invoiceId.in.includes(p.invoiceId) &&
            !(args.where.method?.notIn ?? []).includes(p.method) &&
            (args.where.status?.in ?? [p.status]).includes(p.status),
        ),
      ),
    },
    order: { findUnique: jest.fn().mockResolvedValue({ total: orderTotal }) },
  };
}

const judge = (
  tx: any,
  projected: Array<{ invoiceId: string; projectedTotal: number }>,
  scope: { resync: boolean; partials: boolean; priorOrderTotal?: number } = {
    resync: true,
    partials: false,
    priorOrderTotal: 10,
  },
) =>
  assertEditCannotOverpay(
    {
      invoices: { projectEditedInvoiceTotals: jest.fn().mockResolvedValue(projected) },
      tenantId: "test-tenant",
    },
    tx,
    "ord-1",
    scope,
  );

const PAID_10 = [{ invoiceId: "inv-1", amount: 10, method: "CASH", status: "PAID" }];
const LIVE = [{ id: "inv-1", status: "PAID" }];

describe("W-871: the overpay judge fails closed when the re-sync cannot project", () => {
  it("a qty cut to 7.00 on a 10.00 paid invoice the re-sync cannot project is 409 (master: passes)", async () => {
    const tx = fakeTx(LIVE, PAID_10, 7);
    await expect(judge(tx, [])).rejects.toMatchObject({
      status: 409,
      response: {
        code: "ORDER_EDIT_WOULD_OVERPAY",
        invoiceId: "inv-1",
        paid: 10,
        projectedTotal: 7,
        excess: 3,
      },
    });
  });

  it("only the DRAFT partials projected: the paid invoice it left out is still judged on the order total", async () => {
    const tx = fakeTx([...LIVE, { id: "inv-2", status: "DRAFT" }], PAID_10, 7);
    await expect(judge(tx, [{ invoiceId: "inv-2", projectedTotal: 0 }])).rejects.toMatchObject({
      response: { code: "ORDER_EDIT_WOULD_OVERPAY", projectedTotal: 7 },
    });
  });

  it("an increase passes (paid 10.00, new order total 12.00)", async () => {
    await expect(judge(fakeTx(LIVE, PAID_10, 12), [])).resolves.toBeUndefined();
  });

  it("half a cent of rounding passes", async () => {
    await expect(judge(fakeTx(LIVE, PAID_10, 9.996), [])).resolves.toBeUndefined();
  });

  it("credit notes, advances and VOID payments are not external money", async () => {
    const tx = fakeTx(
      LIVE,
      [
        { invoiceId: "inv-1", amount: 4, method: "CASH", status: "PAID" },
        { invoiceId: "inv-1", amount: 3, method: "CREDIT_NOTE", status: "PAID" },
        { invoiceId: "inv-1", amount: 3, method: "ADVANCE", status: "PAID" },
        { invoiceId: "inv-1", amount: 9, method: "CASH", status: "VOID" },
      ],
      5,
    );
    await expect(judge(tx, [])).resolves.toBeUndefined();
  });

  it("an in-flight PENDING check counts (it may clear)", async () => {
    const tx = fakeTx(
      LIVE,
      [{ invoiceId: "inv-1", amount: 10, method: "CHECK", status: "PENDING" }],
      7,
    );
    await expect(judge(tx, [])).rejects.toMatchObject({
      response: { code: "ORDER_EDIT_WOULD_OVERPAY" },
    });
  });

  it("no live invoice: nothing to judge", async () => {
    await expect(judge(fakeTx([], [], 0), [])).resolves.toBeUndefined();
  });

  it("every live invoice projected: the per-invoice judgement alone decides (no order-total fallback)", async () => {
    // inv-1 projects to 10.00 (an NSF fee on the invoice, say) while the order total is 7.00: not refused.
    const tx = fakeTx(LIVE, PAID_10, 7);
    await expect(judge(tx, [{ invoiceId: "inv-1", projectedTotal: 10 }])).resolves.toBeUndefined();
    expect(tx.order.findUnique).not.toHaveBeenCalled();
  });

  it("a pre-delivery edit (no re-sync) never takes the fallback", async () => {
    const tx = fakeTx(LIVE, PAID_10, 7);
    await expect(judge(tx, [], { resync: false, partials: true })).resolves.toBeUndefined();
    expect(tx.invoice.findMany).not.toHaveBeenCalled();
  });
});

/**
 * SA-956 Fix 1 (amends SA-948 MUST 2.2, SA-E111): the fallback judges a CUT, not a level. The fixture: order total 10.00,
 * one live invoice holding a 3.00 invoice-only line (a manual charge; `order.total` never holds it), CASH 13.00 paid, the
 * projection empty (an unclean partition). The prior total is read in the edit tx under the Order lock and passed in.
 */
describe("SA-956: only a cut is refused", () => {
  const PAID_13 = [{ invoiceId: "inv-1", amount: 13, method: "CASH", status: "PAID" }];
  const run = (newTotal: number, prior: number | undefined = 10) =>
    judge(fakeTx(LIVE, PAID_13, newTotal), [], {
      resync: true,
      partials: false,
      priorOrderTotal: prior,
    });

  it("(a) a qty increase to 11.00 passes (head: 409, the level 13.00 > 11.00)", async () => {
    await expect(run(11)).resolves.toBeUndefined();
  });
  it("(b) an edit that keeps 10.00 passes (head: 409)", async () => {
    await expect(run(10)).resolves.toBeUndefined();
  });
  it("(c) a cut to 9.00 is 409 ORDER_EDIT_WOULD_OVERPAY before and after", async () => {
    await expect(run(9)).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_EDIT_WOULD_OVERPAY", paid: 13, projectedTotal: 9, excess: 4 },
    });
  });
  it("half a cent of rounding on a cut is not a cut", async () => {
    await expect(run(9.996, 10)).resolves.toBeUndefined(); // half a cent of rounding is not a cut
  });
  it("an unreadable prior total fails closed (treated as a cut)", async () => {
    await expect(run(11, Number.NaN)).rejects.toMatchObject({ status: 409 });
    await expect(
      judge(fakeTx(LIVE, PAID_13, 11), [], { resync: true, partials: false }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
