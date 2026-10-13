import { CREDIT_NOTE_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_NOTE_ERROR_COPY,
  RETURN_NOTHING_BILLED_COPY,
  RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
  RETURN_MIXED_UNIT_PRODUCT_COPY,
  REFUND_EXCEEDS_CASH_PAID_COPY,
  REFUND_NEEDS_PAID_INVOICE_COPY,
  REFUND_PAID_WITH_STORE_CREDIT_COPY,
  UNCONFIRMED_COPY,
  creditNoteErrorCopy,
  refundErrorMessage,
} from "./credit-note-error-copy";

const apiError = (data: Record<string, unknown>) => ({ response: { data } });

describe("creditNoteErrorCopy (#2418 U1: no raw server strings)", () => {
  it("has non-empty fixed copy for EVERY code in the closed set", () => {
    for (const code of CREDIT_NOTE_ERROR_CODES) {
      expect(CREDIT_NOTE_ERROR_COPY[code]).toEqual(expect.any(String));
      expect(CREDIT_NOTE_ERROR_COPY[code].length).toBeGreaterThan(10);
    }
    expect(Object.keys(CREDIT_NOTE_ERROR_COPY).sort()).toEqual([...CREDIT_NOTE_ERROR_CODES].sort());
  });

  it("B949: on the credit-note screens CREDIT_NOTE_SOURCE_GONE says the note can't be changed and to VOID IT (never a void-first loop), from fixed copy, never the server text", () => {
    const out = creditNoteErrorCopy(
      apiError({
        code: "CREDIT_NOTE_SOURCE_GONE",
        message:
          "Credit note CN-2026-0042 came from a deleted invoice. Void that credit note first.",
      }),
      "generic",
    );
    expect(out).toBe(
      "This credit note came from a deleted invoice, so it can't be changed. Void it instead.",
    );
    expect(out).not.toContain("first"); // "void that credit note first" leads nowhere when you are ON the credit note
    expect(out).not.toContain("CN-2026-0042");
  });

  it("maps a code to its fixed copy and NEVER returns the server message", () => {
    const secret = "RAW SERVER TEXT cn=CN-2026-0042 cust=Acme Mart";
    for (const code of CREDIT_NOTE_ERROR_CODES) {
      const out = creditNoteErrorCopy(apiError({ code, message: secret }), "generic");
      expect(out).toBe(CREDIT_NOTE_ERROR_COPY[code]);
      expect(out).not.toContain("RAW SERVER");
    }
  });

  it("falls back to the generic line for a missing, unknown or malformed code, still ignoring the message", () => {
    const secret = "RAW SERVER TEXT";
    for (const err of [
      apiError({ message: secret }),
      apiError({ code: "SOMETHING_NEW", message: secret }),
      apiError({ code: 7, message: secret }),
      { message: secret },
      null,
      undefined,
    ])
      expect(creditNoteErrorCopy(err, "generic")).toBe("generic");
  });

  it("does not treat inherited object keys as codes", () => {
    expect(creditNoteErrorCopy(apiError({ code: "toString" }), "generic")).toBe("generic");
    expect(creditNoteErrorCopy(apiError({ code: "constructor" }), "generic")).toBe("generic");
  });

  it("a timeout / dropped connection (no response) says it could not be confirmed, never 'nothing was changed'", () => {
    for (const err of [
      { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" },
      { message: "Network Error", request: {} },
      { request: {}, message: "boom" },
    ])
      expect(creditNoteErrorCopy(err, "Nothing was changed.")).toBe(UNCONFIRMED_COPY);
    // a real HTTP response without a known code keeps the caller's fallback
    expect(creditNoteErrorCopy({ response: { data: { message: "x" } } }, "generic")).toBe(
      "generic",
    );
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

describe("B959 RETURN_NOTHING_BILLED copy", () => {
  it("the refund toast shows fixed copy for the code (never the server text) and falls back otherwise", () => {
    const err = {
      response: { data: { code: "RETURN_NOTHING_BILLED", message: "RAW SERVER TEXT" } },
    };
    expect(refundErrorMessage(err, "other")).toBe(RETURN_NOTHING_BILLED_COPY);
    expect(refundErrorMessage(err, "other")).not.toContain("RAW SERVER");
    expect(refundErrorMessage({ response: { data: { code: "SOMETHING_ELSE" } } }, "other")).toBe(
      "other",
    );
  });
});

describe("SA-740r2: the refund refusals have fixed copy that names the exits", () => {
  const err = (code: string) => ({ response: { data: { code, message: "RAW SERVER TEXT" } } });

  it.each([
    ["REFUND_NEEDS_PAID_INVOICE", REFUND_NEEDS_PAID_INVOICE_COPY],
    ["REFUND_PAID_WITH_STORE_CREDIT", REFUND_PAID_WITH_STORE_CREDIT_COPY],
    ["REFUND_EXCEEDS_CASH_PAID", REFUND_EXCEEDS_CASH_PAID_COPY],
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
      RETURN_NOTHING_BILLED_COPY,
      RETURN_REFUND_OVER_LINE_HEADROOM_COPY,
      RETURN_MIXED_UNIT_PRODUCT_COPY,
    ]) {
      expect(copy).not.toMatch(/outside RouteFlow|manually/i);
    }
  });
});
