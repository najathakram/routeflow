/**
 * invoicesNeedReview's orphan test recognises an UNLISTED invoice line (productId null) only by its
 * description equalling a live custom line's name. Two edits defeat that. Both are KNOWN GAPS
 * (B1090 follow-up): these pin today's behaviour, so a later fix flips them deliberately.
 */
import { invoicesNeedReview } from "./invoice-partition";

/** A tenant client whose order has one invoice with ONE orphaned (orderItemId null) unlisted line. */
const dbWith = (invoiceLineDescription: string, customLineName: string) =>
  ({
    invoice: {
      findMany: jest.fn().mockResolvedValue([
        {
          items: [
            {
              orderItemId: null,
              productId: null,
              systemKind: null,
              description: invoiceLineDescription,
              qty: 1,
            },
          ],
        },
      ]),
    },
    // the re-created custom line: invoicedQty back at 0, so a remainder exists
    orderItem: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: "oi-new", name: customLineName, qty: 1, invoicedQty: 0 }]),
    },
  }) as never;

describe("invoicesNeedReview — orphaned UNLISTED line gaps", () => {
  it("control: an orphaned unlisted line whose description still matches the custom line IS flagged", async () => {
    await expect(invoicesNeedReview(dbWith("Misc part", "Misc part"), "ord-1")).resolves.toBe(true);
  });

  it("KNOWN GAP (B1090 follow-up): the custom line is RENAMED in the same replace-all edit, so the orphan is NOT flagged", async () => {
    await expect(invoicesNeedReview(dbWith("Misc part", "Misc part v2"), "ord-1")).resolves.toBe(
      false,
    );
  });

  it("KNOWN GAP (B1090 follow-up): staff edited the draft line's description before the replace-all, so the orphan is NOT flagged", async () => {
    await expect(
      invoicesNeedReview(dbWith("Misc part (edited by staff)", "Misc part"), "ord-1"),
    ).resolves.toBe(false);
  });
});
