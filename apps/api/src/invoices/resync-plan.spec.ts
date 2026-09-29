import { InvoiceItemSystemKind } from "@prisma/client";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import { partitionInvoiceLines, RESYNC_ITEM_SELECT } from "./resync-plan";

/**
 * #2268 — `partitionInvoiceLines` skips a system NSF fee line instead of bailing, so an invoice
 * that carries one still resyncs after a post-delivery order edit. Every other bail is unchanged.
 */
describe("partitionInvoiceLines (#2268)", () => {
  const stamped = { orderItemId: null, systemKind: InvoiceItemSystemKind.NSF_FEE };
  const legacy = {
    orderItemId: null,
    systemKind: null,
    description: `${NSF_FEE_DESCRIPTION_PREFIX} check #1`,
  };

  it.each([
    ["a stamped NSF_FEE line", stamped],
    ["a legacy prefix-only NSF line", legacy],
  ])("skips %s and maps the order lines", (_n, nsf) => {
    const map = partitionInvoiceLines([{ id: "inv-1", items: [{ orderItemId: "oi-1" }, nsf] }]);
    expect(map).toEqual(new Map([["oi-1", "inv-1"]]));
  });

  it("an invoice holding ONLY an NSF line partitions clean (it owns no order line)", () => {
    const map = partitionInvoiceLines([
      { id: "inv-1", items: [{ orderItemId: "oi-1" }] },
      { id: "inv-2", items: [stamped] },
    ]);
    expect(map).toEqual(new Map([["oi-1", "inv-1"]]));
  });

  it("still bails on a freeform (non-NSF) line with no provenance — the rebuild would drop it", () => {
    const freeform = { orderItemId: null, systemKind: null, description: "Handling" };
    expect(
      partitionInvoiceLines([{ id: "inv-1", items: [{ orderItemId: "oi-1" }, stamped, freeform] }]),
    ).toBeNull();
  });

  it("still bails on a line billed by two invoices", () => {
    expect(
      partitionInvoiceLines([
        { id: "inv-a", items: [{ orderItemId: "oi-1" }, stamped] },
        { id: "inv-b", items: [{ orderItemId: "oi-1" }] },
      ]),
    ).toBeNull();
  });

  it("the resync's item select carries both isNsfLine reads", () => {
    expect(RESYNC_ITEM_SELECT).toMatchObject({ systemKind: true, description: true });
  });
});
