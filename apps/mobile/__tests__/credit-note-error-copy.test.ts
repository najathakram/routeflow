import { API_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_EXCEEDS_REFUNDABLE_COPY,
  CREDIT_NOTE_ERROR_COPY,
  RETURN_EXCEEDS_REFUNDABLE_COPY,
  RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  RETURN_MIXED_UNIT_PRODUCT_COPY,
  RETURN_NOTHING_BILLED_COPY,
  RETURN_REFUND_BASIS_CHANGED_COPY,
  REFUND_EXCEEDS_CASH_PAID_COPY,
  REFUND_NEEDS_PAID_INVOICE_COPY,
  REFUND_PAID_WITH_STORE_CREDIT_COPY,
  UNCONFIRMED_COPY,
  creditNoteErrorCopy,
  refundErrorMessage,
  refusalCopy,
} from "../lib/credit-note-error-copy";
import { voidConfirmMessage } from "../lib/credit-notes-logic";

const codes = Object.values(API_ERROR_CODES as Record<string, string>).filter((c) =>
  c.startsWith("CREDIT_NOTE_"),
);
const apiError = (data: Record<string, unknown>) => ({ response: { data } });

describe("credit-note error copy (#2418 U1: no raw server strings)", () => {
  it("has fixed copy for EVERY CREDIT_NOTE_* code and nothing else", () => {
    expect(codes.length).toBe(14);
    expect(Object.keys(CREDIT_NOTE_ERROR_COPY).sort()).toEqual([...codes].sort());
    for (const c of codes)
      expect(
        CREDIT_NOTE_ERROR_COPY[c as keyof typeof CREDIT_NOTE_ERROR_COPY].length,
      ).toBeGreaterThan(10);
  });

  it("maps a code to its copy and NEVER returns the server message", () => {
    for (const c of codes) {
      const out = creditNoteErrorCopy(apiError({ code: c, message: "RAW SERVER TEXT" }), "generic");
      expect(out).toBe(CREDIT_NOTE_ERROR_COPY[c as keyof typeof CREDIT_NOTE_ERROR_COPY]);
      expect(out).not.toContain("RAW SERVER");
    }
  });

  it("falls back to generic for missing/unknown/inherited codes and ignores the message", () => {
    for (const err of [
      apiError({ message: "RAW SERVER TEXT" }),
      apiError({ code: "NEW_THING", message: "RAW SERVER TEXT" }),
      apiError({ code: "toString" }),
      { message: "RAW SERVER TEXT" },
      null,
      undefined,
    ])
      expect(creditNoteErrorCopy(err, "generic")).toBe("generic");
  });

  it("refusalCopy maps a preview refusalCode, else the generic refusal line (never server text)", () => {
    expect(refusalCopy(API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED)).toBe(
      CREDIT_NOTE_ERROR_COPY[API_ERROR_CODES.CREDIT_NOTE_RETURN_BACKED],
    );
    expect(refusalCopy(null)).toMatch(/Nothing was changed/);
  });
});

describe("unconfirmed writes (timeout / network error)", () => {
  it("says it could not be confirmed instead of 'nothing was changed'", () => {
    for (const err of [
      { code: "ECONNABORTED", message: "timeout" },
      { message: "Network Error", request: {} },
    ])
      expect(creditNoteErrorCopy(err, "Nothing was changed.")).toBe(UNCONFIRMED_COPY);
    expect(creditNoteErrorCopy({ response: { data: {} } }, "generic")).toBe("generic");
  });
});

describe("voidConfirmMessage (#2418 U1)", () => {
  it("says what the void un-applies and which invoices it reopens", () => {
    expect(
      voidConfirmMessage("CN-7", [
        { invoiceNumber: "INV-9", amount: 30 },
        { invoiceNumber: "INV-4", amount: "12.5" },
      ]),
    ).toBe(
      "CN-7 will be voided and can't be undone. It first un-applies $30.00 from INV-9, $12.50 from INV-4, which reopens those invoices.",
    );
    expect(voidConfirmMessage("CN-7", [{ invoiceNumber: "INV-9", amount: 30 }])).toMatch(
      /reopens that invoice\./,
    );
  });
  it("is just the warning when nothing is applied", () => {
    expect(voidConfirmMessage("CN-7", [])).toBe("CN-7 will be voided and can't be undone.");
  });
});

describe("refundErrorMessage (SA-628, B946)", () => {
  it("RETURN_MIXED_UNIT_PRODUCT shows the FIXED copy, never the server message (B965)", () => {
    const err = {
      response: { data: { code: "RETURN_MIXED_UNIT_PRODUCT", message: "raw server text" } },
    };
    expect(refundErrorMessage(err, "raw server text")).toBe(RETURN_MIXED_UNIT_PRODUCT_COPY);
    expect(RETURN_MIXED_UNIT_PRODUCT_COPY).not.toMatch(/raw server text/);
  });

  it("RETURN_REFUND_OVER_LINE_HEADROOM shows the FIXED copy, never the server message", () => {
    const err = {
      response: { data: { code: "RETURN_REFUND_OVER_LINE_HEADROOM", message: "raw server text" } },
    };
    expect(refundErrorMessage(err, "raw server text")).toBe(RETURN_REFUND_OVER_LINE_HEADROOM_COPY);
    expect(RETURN_REFUND_OVER_LINE_HEADROOM_COPY).not.toMatch(/raw server text/);
  });
  it("any other refusal keeps the caller's own text (the existing refund refusals name the invoice)", () => {
    expect(
      refundErrorMessage({ response: { data: { code: "OTHER" } } }, "named invoice text"),
    ).toBe("named invoice text");
    expect(refundErrorMessage(new Error("x"), undefined)).toBeUndefined();
  });
});

describe("SA-740r2: the refund refusals have fixed copy that names the exits", () => {
  const err = (code: string) => ({ response: { data: { code, message: "RAW SERVER TEXT" } } });

  it.each([
    ["REFUND_NEEDS_PAID_INVOICE", REFUND_NEEDS_PAID_INVOICE_COPY],
    ["REFUND_PAID_WITH_STORE_CREDIT", REFUND_PAID_WITH_STORE_CREDIT_COPY],
    ["REFUND_EXCEEDS_CASH_PAID", REFUND_EXCEEDS_CASH_PAID_COPY],
    ["RETURN_REFUND_BASIS_CHANGED", RETURN_REFUND_BASIS_CHANGED_COPY],
  ])("%s is mapped to its fixed copy, never the server text", (code, copy) => {
    expect(refundErrorMessage(err(code), "other")).toBe(copy);
    expect(copy).not.toMatch(/RAW SERVER/);
  });

  it("the exit of a refused STANDARD refund is store credit when billable, else cancel the return", () => {
    expect(REFUND_NEEDS_PAID_INVOICE_COPY).toMatch(/store credit/i);
    expect(REFUND_NEEDS_PAID_INVOICE_COPY).toMatch(/cancel the return/i);
    expect(RETURN_NOTHING_BILLED_COPY).toMatch(/cancel the return/i);
    expect(RETURN_REFUND_OVER_LINE_HEADROOM_COPY).toMatch(/store credit/i);
    expect(RETURN_REFUND_OVER_LINE_HEADROOM_COPY).toMatch(/cancel the return/i);
    expect(RETURN_MIXED_UNIT_PRODUCT_COPY).toMatch(/cancel the return/i);
  });

  it("no refusal copy sends the operator to refund 'outside RouteFlow' or to settle it 'manually'", () => {
    for (const copy of [
      REFUND_NEEDS_PAID_INVOICE_COPY,
      REFUND_PAID_WITH_STORE_CREDIT_COPY,
      REFUND_EXCEEDS_CASH_PAID_COPY,
      RETURN_REFUND_BASIS_CHANGED_COPY,
      RETURN_NOTHING_BILLED_COPY,
      RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
      RETURN_MIXED_UNIT_PRODUCT_COPY,
    ]) {
      expect(copy).not.toMatch(/outside RouteFlow|manually/i);
    }
  });
});

describe("SA-773: the refundable-remainder refusals have fixed copy that names what is left", () => {
  const err = (code: string, extra: Record<string, unknown> = {}) => ({
    response: { data: { code, message: "RAW SERVER TEXT", ...extra } },
  });

  it.each([
    ["RETURN_EXCEEDS_REFUNDABLE", RETURN_EXCEEDS_REFUNDABLE_COPY],
    ["CREDIT_EXCEEDS_REFUNDABLE", CREDIT_EXCEEDS_REFUNDABLE_COPY],
  ])(
    "%s is the fixed copy, never the server text, plus 'up to' when the body has it",
    (code, copy) => {
      expect(refundErrorMessage(err(code), "other")).toBe(copy);
      expect(refundErrorMessage(err(code, { remainingValue: 12 }), "other")).toBe(
        `${copy} Up to $12.00 can still be given back.`,
      );
      expect(refundErrorMessage(err(code, { remainingValue: "12" }), "other")).toBe(copy);
      expect(refundErrorMessage(err(code, { remainingValue: -1 }), "other")).toBe(copy);
      expect(copy).not.toMatch(/RAW SERVER|outside RouteFlow|manually/i);
    },
  );
});
