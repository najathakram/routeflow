/**
 * SA-763r P-3 wiring pins (M4): the overpay judge sits at the TAIL of updateOrderItems' edit transaction,
 * after the order header (subtotal, tax, shipping fee) is written and before the merge key / inline return,
 * and `skipInPlaceResync` comes out of that transaction computed from the HELD lines (read under the Order
 * lock), never from the pre-lock snapshot.
 */
import fs from "node:fs";
import path from "node:path";

const src = fs
  .readFileSync(path.join(__dirname, "orders.service.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
const start = src.indexOf("async updateOrderItems(");
const body = src.slice(start, src.indexOf("\n  }\n", start));
const at = (needle: string, from = 0) => {
  const i = body.indexOf(needle, from);
  expect(i).toBeGreaterThan(-1);
  return i;
};

describe("updateOrderItems: the overpay judge is wired at the tail of the edit tx", () => {
  it("runs after the order header update and before the merge key and the inline return", () => {
    const orderUpdate = at("await tx.order.update(");
    const judge = at("judgeEditTail(");
    expect(judge).toBeGreaterThan(orderUpdate);
    expect(judge).toBeLessThan(at("recordMergeIdempotencyKey(", orderUpdate));
    expect(judge).toBeLessThan(at("applyReturn(", orderUpdate));
    // and inside the retried transaction callback, not after it
    expect(judge).toBeLessThan(at("return { subtotal, tax, total, shouldRevert, shippingFee }"));
  });

  it("skipInPlaceResync is computed from the in-tx held lines and returned by the tx", () => {
    expect(body).toContain("heldItems, postDeliveryEdit");
    expect(body).toContain("skipInPlaceResync = await judgeEditTail(");
    expect(body).not.toContain("const skipInPlaceResync = postDeliveryEdit"); // the pre-lock post-commit read is gone
  });

  it("the DRAFT-partial price follow runs only for a staff edit that no rebuild path restated", () => {
    const m = src.indexOf("private async reconcileOrderAfterEdit(");
    const tail = src.slice(m, src.indexOf("\n  }\n", m));
    expect(tail).toContain("staffEdit && !rebuilt");
    expect(tail).toContain("followPartialPrices(");
    expect(tail.indexOf("followPartialPrices(")).toBeGreaterThan(
      tail.indexOf("reconcileOrderDraftInvoice("),
    );
  });
});

describe("judgeEditTail: the scope the edit hands the judge", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { judgeEditTail } = require("./edit-overpay-judge");
  const run = async (edit: any) => {
    const projectEditedInvoiceTotals = jest.fn().mockResolvedValue([]);
    const tx = { $executeRaw: jest.fn(), invoicePayment: { findMany: jest.fn() } };
    const skip = await judgeEditTail(
      { invoices: { projectEditedInvoiceTotals }, tenantId: "t" },
      tx,
      "ord-1",
      edit,
    );
    return { skip, scope: projectEditedInvoiceTotals.mock.calls[0]?.[2] };
  };
  const held = (qty: number, invoicedQty: number) => [{ qty, invoicedQty }];

  it("pre-delivery staff edit: only the DRAFT partials can be restated", async () => {
    expect(
      await run({ heldItems: held(10, 6), postDeliveryEdit: false, role: "OPERATOR" }),
    ).toEqual({
      skip: false,
      scope: { resync: false, partials: true },
    });
  });
  it("post-delivery, wholly invoiced: the re-sync restates (the partial scope is a superset the projection drops)", async () => {
    expect(
      await run({ heldItems: held(10, 10), postDeliveryEdit: true, role: "TENANT_ADMIN" }),
    ).toEqual({
      skip: false,
      scope: { resync: true, partials: true },
    });
  });
  it("post-delivery, partially invoiced (held lines): the re-sync is skipped, the DRAFT partials still follow", async () => {
    expect(await run({ heldItems: held(10, 6), postDeliveryEdit: true, role: "OPERATOR" })).toEqual(
      {
        skip: true,
        scope: { resync: false, partials: true },
      },
    );
  });
  it("a buyer or driver edit never reaches the partials; a skipped post-delivery buyer edit judges nothing", async () => {
    expect(await run({ heldItems: held(10, 6), postDeliveryEdit: true, role: "CUSTOMER" })).toEqual(
      {
        skip: true,
        scope: undefined,
      },
    );
  });
});
