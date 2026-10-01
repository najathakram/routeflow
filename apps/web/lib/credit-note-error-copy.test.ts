import { CREDIT_NOTE_ERROR_CODES } from "@routeflow/types";
import {
  CREDIT_NOTE_ERROR_COPY,
  UNCONFIRMED_COPY,
  creditNoteErrorCopy,
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
