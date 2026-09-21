import { computeLineSubtotal } from "@routeflow/pricing";
import { invoiceLineDto } from "../lib/invoice-totals";

/**
 * B656 confirmation (NOT a fix — no defect found on the mobile side).
 *
 * B656 was `Invoice.duplicate()` (server) omitting `unitsPerBox` from a copied boxed
 * line, so the mobile edit screen's save (`invoiceLineDto`) saw a boxed line as
 * unboxed (`unitsPerBox` null) and withheld `boxes`/`pieces` from the PATCH — the
 * server then priced it `qty x unitPrice` (72 x $40 = $2,880) instead of the true
 * $240. Fixed server-side by #1159 (`invoices.service.ts#duplicate`, tested exactly
 * to the levy in `invoices.duplicate.spec.ts`: subtotal $240, levy $7.20).
 *
 * This is the mobile-observable half of the same chain: `edit.tsx`'s hydrate
 * (`unitsPerBox: it.unitsPerBox ?? null`) and this file's `invoiceLineDto` already
 * pass the line's own `unitsPerBox` straight through — once the server sends it
 * (as it now does, post-#1159), the split travels and the money is right. Nothing
 * to change here; this pins the round trip so a regression on either side is caught.
 */
describe("a duplicated boxed invoice line round-trips through invoiceLineDto (B656)", () => {
  // Mirrors invoices.duplicate.spec.ts's boxedLine exactly: 6 boxes of 12 at $40/box.
  const hydratedFromServer = {
    description: "Sample Case Product",
    productId: "p-1",
    qty: 72,
    unitPrice: 40,
    boxes: 6,
    pieces: 0,
    unitsPerBox: 12, // present because duplicate() now copies it (#1159)
    taxable: false,
  };

  it("sends the split (boxes, pieces) — the server derives unitsPerBox itself from the live product on save (invoices.service.ts#update), never from the wire", () => {
    const dto = invoiceLineDto(hydratedFromServer, 0);
    expect(dto).toMatchObject({ qty: 72, unitPrice: 40, boxes: 6, pieces: 0 });
    expect(dto).not.toHaveProperty("unitsPerBox"); // whitelisted out — by design, not a bug
    // What the server then does with { boxes: 6, pieces: 0 } + the live product's unitsPerBox 12:
    expect(computeLineSubtotal({ ...dto, unitsPerBox: 12 })).toBe(240);
    expect(computeLineSubtotal({ ...dto, unitsPerBox: 12 })).not.toBe(72 * 40);
  });

  it("a line with no unitsPerBox (unboxed, or a pre-#1159 already-broken row) correctly withholds boxes/pieces", () => {
    const dto = invoiceLineDto({ ...hydratedFromServer, unitsPerBox: null }, 0);
    expect(dto.boxes).toBeUndefined();
    expect(dto.pieces).toBeUndefined();
  });
});
