import {
  InvalidLineCursorError,
  attributeCreditNote,
  attributeExternalRefund,
  compareLineKeysDesc,
  csvCell,
  decodeLineCursor,
  encodeLineCursor,
  perPieceOf,
  purchaseEventKey,
  returnNettingDate,
  salePackOf,
  salePiecesOf,
} from "./sales-facts.rules";

/**
 * #2118 — the pure rules of the sales-facts layer. Each is the ONE definition both the
 * product path (ProductInsightsService) and the tenant path (SalesFactsService.
 * tenantCreditAttribution) call, so the per-product figures and the tenant identities can
 * never drift apart (L-167).
 */
describe("sales-facts rules", () => {
  describe("salePackOf — the selling unit comes from the line's own snapshot (plan A6)", () => {
    it("a boxed line with its split uses its sale-time snapshot, never today's pack", () => {
      expect(salePackOf({ boxes: 2, pieces: 3, unitsPerBox: 12 }, 24)).toBe(12);
    });

    it("a factor-1 unit line (snapshot 1, no split) sells by the piece", () => {
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: 1 }, 12)).toBe(1);
    });

    it("a piece line on a never-boxed product (writers store a null snapshot) sells by the piece", () => {
      // Modern writers snapshot `unitsPerBox: boxes != null && upb > 1 ? upb : null`, so a null
      // snapshot is NOT evidence of a legacy row by itself. The live pack is a GATE only.
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: null }, null)).toBe(1);
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: null }, 1)).toBe(1);
    });

    it("no snapshot on a product that is boxed today is unknown — never guessed from today's pack", () => {
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: null }, 12)).toBeNull();
    });

    it("a split with no snapshot (pre-snapshot row) is unknown", () => {
      expect(salePackOf({ boxes: 2, pieces: 0, unitsPerBox: null }, null)).toBeNull();
    });

    it("a boxed snapshot with NO split is the B644 shape (qty may count boxes) — unknown", () => {
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: 12 }, 12)).toBeNull();
    });

    it("an unknown product (live pack not supplied) never unlocks the piece fallback", () => {
      expect(salePackOf({ boxes: null, pieces: null, unitsPerBox: null }, undefined)).toBeNull();
    });
  });

  describe("salePiecesOf — pieces from the stored line's OWN evidence (pack-snapshot rule)", () => {
    it("a split line's qty is pieces, whatever its snapshot", () => {
      expect(salePiecesOf({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 }, 24)).toBe(27);
      expect(salePiecesOf({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: null }, 12)).toBe(27);
    });

    it("a no-split line with a BOXED snapshot (B644: qty may count boxes) is unknown — never x pack", () => {
      expect(salePiecesOf({ qty: 3, unitsPerBox: 12 }, 12)).toBeNull();
      // …and today's pack never rescues it: the product being unboxed now changes nothing.
      expect(salePiecesOf({ qty: 3, unitsPerBox: 12 }, null)).toBeNull();
      expect(salePiecesOf({ qty: 3, unitsPerBox: 12 }, 1)).toBeNull();
    });

    it("a snapshot of 1 is pieces even when the product is boxed today (the snapshot decides)", () => {
      expect(salePiecesOf({ qty: 6, unitsPerBox: 1 }, 12)).toBe(6);
    });

    it("no snapshot: today's pack is a GATE only — not boxed → pieces; boxed or unknown → unknown", () => {
      expect(salePiecesOf({ qty: 10 }, null)).toBe(10);
      expect(salePiecesOf({ qty: 10 }, 1)).toBe(10);
      expect(salePiecesOf({ qty: 10 }, 12)).toBeNull();
      expect(salePiecesOf({ qty: 10 }, undefined)).toBeNull();
    });

    it("a zero qty is zero pieces on any axis (a fee line)", () => {
      expect(salePiecesOf({ qty: 0, unitsPerBox: 12 }, 12)).toBe(0);
    });
  });

  describe("perPieceOf", () => {
    it("is the effective price per piece, rounded to cents", () => {
      // A $43.75 box of 6 → 7.2916… → 7.29.
      expect(perPieceOf(43.75, 6)).toBe(7.29);
    });

    it("is null for a zero-quantity (fee) line — revenue only, never a price", () => {
      expect(perPieceOf(5, 0)).toBeNull();
    });
  });

  describe("purchaseEventKey", () => {
    it("one event per order however many invoices it was billed on; an order-less invoice is its own event", () => {
      expect(purchaseEventKey("o1", "i1")).toBe(purchaseEventKey("o1", "i2"));
      expect(purchaseEventKey(null, "i1")).not.toBe(purchaseEventKey(null, "i2"));
      expect(purchaseEventKey(null, "o1")).not.toBe(purchaseEventKey("o1", "x"));
    });
  });

  describe("attributeCreditNote — stored CreditNoteItem facts only (plan A3)", () => {
    const lines = new Map<string, string | null>([
      ["line-a", "prod-a"],
      ["line-b", "prod-b"],
      ["line-adhoc", null],
    ]);

    it("attributes each line item to its line's product; the rest is unattributed; the parts sum to the amount", () => {
      const out = attributeCreditNote(
        {
          amount: 100,
          items: [
            { invoiceItemId: "line-a", amount: 30 },
            { invoiceItemId: "line-b", amount: 20.5 },
          ],
        },
        lines,
      );
      expect(Object.fromEntries(out.byProduct)).toEqual({ "prod-a": 30, "prod-b": 20.5 });
      expect(out.unlisted).toBe(0);
      expect(out.unattributed).toBe(49.5);
    });

    it("SA-289: an ordinary-product line credit attributes to that product (regulated or not is never read)", () => {
      // The rule's input has no category at all: a line item on ANY listed line attributes.
      const out = attributeCreditNote(
        { amount: 12, items: [{ invoiceItemId: "line-b", amount: 12 }] },
        lines,
      );
      expect(Object.fromEntries(out.byProduct)).toEqual({ "prod-b": 12 });
      expect(out.unlisted).toBe(0);
      expect(out.unattributed).toBe(0);
    });

    it("a header-only credit note is wholly unattributed", () => {
      const out = attributeCreditNote({ amount: 80, items: [] }, lines);
      expect(out.byProduct.size).toBe(0);
      expect(out.unattributed).toBe(80);
    });

    it("an item on an unlisted line is attributed (to no product), never unattributed; a rotated (dangling) line id or no line id is unattributed", () => {
      const out = attributeCreditNote(
        {
          amount: 60,
          items: [
            { invoiceItemId: "line-adhoc", amount: 10 },
            { invoiceItemId: "line-gone", amount: 20 },
            { invoiceItemId: null, amount: 30 },
          ],
        },
        lines,
      );
      expect(out.byProduct.size).toBe(0);
      expect(out.unlisted).toBe(10);
      expect(out.unattributed).toBe(50);
    });

    it("merges two items on the same product and rounds to cents before the residual (parts stay exact)", () => {
      const out = attributeCreditNote(
        {
          amount: 0.3,
          items: [
            { invoiceItemId: "line-a", amount: 0.1 },
            { invoiceItemId: "line-a", amount: 0.2 },
          ],
        },
        lines,
      );
      expect(out.byProduct.get("prod-a")).toBe(0.3);
      expect(out.unlisted).toBe(0);
      expect(out.unattributed).toBe(0);
    });
  });

  describe("attributeExternalRefund", () => {
    it("an INLINE refund attributes each line's stored subtotal; the remainder (tax) is unattributed", () => {
      const out = attributeExternalRefund({
        kind: "INLINE",
        refundAmount: 32.4,
        items: [
          { productId: "prod-a", subtotal: 20 },
          { productId: "prod-a", subtotal: 5 },
          { productId: "prod-b", subtotal: 5 },
          { productId: "prod-c", subtotal: null },
        ],
      });
      expect(Object.fromEntries(out.byProduct)).toEqual({ "prod-a": 25, "prod-b": 5 });
      expect(out.unattributed).toBe(2.4);
    });

    it("a STANDARD refund carries no per-line money — wholly unattributed (never prorated at read time)", () => {
      const out = attributeExternalRefund({
        kind: "STANDARD",
        refundAmount: 50,
        items: [{ productId: "prod-a", subtotal: null }],
      });
      expect(out.byProduct.size).toBe(0);
      expect(out.unattributed).toBe(50);
    });
  });

  describe("returnNettingDate — a return's quantity nets on the SAME event its money does", () => {
    const createdAt = new Date("2026-06-10T15:00:00Z");
    const refundedAt = new Date("2026-06-09T15:00:00Z");
    // Only netting notes: the readers' ACCRUAL_CREDIT_NOTE_FILTER keeps a VOID note out.
    const cns = new Map([["cn-live", { createdAt }]]);

    it("an external refund nets on refundedAt (the Return term of B440)", () => {
      expect(
        returnNettingDate({ refundMethod: "EXTERNAL_REFUND", refundedAt, creditNoteId: null }, cns),
      ).toBe(refundedAt);
    });

    it("a credit-note return nets on its credit note's createdAt (the CreditNote term), not refundedAt", () => {
      expect(
        returnNettingDate(
          { refundMethod: "CREDIT_NOTE", refundedAt, creditNoteId: "cn-live" },
          cns,
        ),
      ).toBe(createdAt);
      // Legacy rows predate the resolution snapshot: no refundMethod/refundedAt, CN linked.
      expect(
        returnNettingDate({ refundMethod: null, refundedAt: null, creditNoteId: "cn-live" }, cns),
      ).toBe(createdAt);
    });

    it("a note absent from the map (VOID — never read — or missing), or no resolution, nets nothing", () => {
      expect(
        returnNettingDate(
          { refundMethod: "CREDIT_NOTE", refundedAt, creditNoteId: "cn-void" },
          cns,
        ),
      ).toBeNull();
      expect(
        returnNettingDate({ refundMethod: "CREDIT_NOTE", refundedAt, creditNoteId: "cn-x" }, cns),
      ).toBeNull();
      // A stranded CREDIT_NOTE resolution whose mint never landed: no money moved, no netting.
      expect(
        returnNettingDate({ refundMethod: "CREDIT_NOTE", refundedAt, creditNoteId: null }, cns),
      ).toBeNull();
      expect(
        returnNettingDate({ refundMethod: null, refundedAt: null, creditNoteId: null }, cns),
      ).toBeNull();
    });
  });

  describe("line cursor", () => {
    const key = {
      issueDate: new Date("2026-06-05T00:00:00.000Z"),
      invoiceCreatedAt: new Date("2026-06-05T14:03:00.120Z"),
      invoiceId: "inv-9",
      lineCreatedAt: new Date("2026-06-05T14:03:00.200Z"),
      lineId: "line-3",
    };

    it("round-trips every sort key exactly", () => {
      expect(decodeLineCursor(encodeLineCursor(key))).toEqual(key);
    });

    it("is URL-safe", () => {
      expect(encodeLineCursor(key)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("refuses a tampered or foreign cursor with a typed error (the controller maps it to 400)", () => {
      for (const bad of ["", "not-base64!", Buffer.from("{}").toString("base64url"), "e30"]) {
        expect(() => decodeLineCursor(bad)).toThrow(InvalidLineCursorError);
      }
    });

    it("orders newest first: issue date, then invoice entry, invoice id, line entry, line id", () => {
      const older = { ...key, issueDate: new Date("2026-06-04T00:00:00.000Z") };
      const sameDayLaterInvoice = {
        ...key,
        invoiceCreatedAt: new Date("2026-06-05T15:00:00.000Z"),
      };
      const sameInvoiceLaterLine = { ...key, lineId: "line-4" };
      expect(compareLineKeysDesc(key, older)).toBeLessThan(0);
      expect(compareLineKeysDesc(sameDayLaterInvoice, key)).toBeLessThan(0);
      expect(compareLineKeysDesc(sameInvoiceLaterLine, key)).toBeLessThan(0);
      expect(compareLineKeysDesc(key, key)).toBe(0);
    });
  });

  describe("csvCell", () => {
    it("quotes separators, quotes and newlines", () => {
      expect(csvCell('Acme, "North"\nStore')).toBe('"Acme, ""North""\nStore"');
      expect(csvCell("plain")).toBe("plain");
    });

    it("neutralizes a spreadsheet formula in a TEXT cell (CSV injection)", () => {
      expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
      expect(csvCell("+1e5")).toBe("'+1e5");
      expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
      expect(csvCell("@cmd")).toBe("'@cmd");
      expect(csvCell("-2+3")).toBe("'-2+3");
    });

    it("neutralizes a formula behind a leading line feed (still quoted: it holds a newline)", () => {
      expect(csvCell("\n=HYPERLINK(1)")).toBe(`"'\n=HYPERLINK(1)"`);
    });

    it("neutralizes a full-width ＝ (and its ＋ － ＠ siblings) — some locales normalize them to ASCII", () => {
      expect(csvCell("\uFF1DHYPERLINK(1)")).toBe("'\uFF1DHYPERLINK(1)");
      expect(csvCell("\uFF0B1")).toBe("'\uFF0B1");
      expect(csvCell("\uFF0D1")).toBe("'\uFF0D1");
      expect(csvCell("\uFF20cmd")).toBe("'\uFF20cmd");
      // A full-width character that is NOT a formula lead is left alone.
      expect(csvCell("\uFF21cme")).toBe("\uFF21cme");
    });

    it("writes numbers as-is (a negative amount stays a number) and null/undefined as empty", () => {
      expect(csvCell(-12.5)).toBe("-12.5");
      expect(csvCell(0)).toBe("0");
      expect(csvCell(null)).toBe("");
      expect(csvCell(undefined)).toBe("");
      expect(csvCell(true)).toBe("true");
    });
  });
});
