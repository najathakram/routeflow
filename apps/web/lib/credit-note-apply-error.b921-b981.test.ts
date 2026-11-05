import * as fs from "fs";
import * as path from "path";
import { API_ERROR_CODES } from "@routeflow/types";
import { creditNoteErrorCopy } from "./credit-note-error-copy";
import { customerFormErrorCopy } from "./customer-form-error-copy";
import { genericToastCopy } from "./generic-toast-copy";
import { rawMessageReads } from "./raw-message-scan";

/**
 * B921: the credit-note Apply refusals show FIXED copy chosen by `body.code`, never the server message.
 * B981: the two customer-create refusals carry a code, so the form and the global toast map by code.
 */
const axiosErr = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

const SECRET = "RAW SERVER TEXT cn=CN-2026-0042 cust=Acme Mart";

describe("B921: credit-note Apply refusals map by code", () => {
  const cases: Array<[string, string]> = [
    [API_ERROR_CODES.CREDIT_NOTE_NOT_APPLICABLE, "This credit note can't be applied any more."],
    [API_ERROR_CODES.CREDIT_NOTE_EXPIRED, "This credit note has expired, so it can't be applied."],
    [
      API_ERROR_CODES.CREDIT_NOTE_CUSTOMER_MISMATCH,
      "This credit note belongs to a different customer than the invoice.",
    ],
    [
      API_ERROR_CODES.CREDIT_NOTE_INVOICE_NOT_APPLICABLE,
      "This invoice is already paid, void or written off, so it can't take a credit.",
    ],
    [
      API_ERROR_CODES.CREDIT_NOTE_NOTHING_TO_APPLY,
      "There's nothing to apply: the credit note has no balance left, or the invoice is fully paid.",
    ],
  ];

  it.each(cases)("%s reads as fixed copy, never the server message", (code, copy) => {
    const err = axiosErr(400, { code, message: SECRET });
    expect(creditNoteErrorCopy(err, "Please try again.")).toBe(copy);
    expect(genericToastCopy(err)).toBe(copy);
  });

  it("the credit-note page reads no server message and routes its Apply toast through the copy map", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../app/(dashboard)/credit-notes/[id]/page.tsx"),
      "utf8",
    );
    expect(rawMessageReads(src)).toEqual([]);
    expect(src).toContain("creditNoteErrorCopy(");
  });
});

describe("B981: customer create refusals map by code", () => {
  it("CUSTOMER_EMAIL_OR_USERNAME_TAKEN reads as the email copy even when the message differs", () => {
    const err = axiosErr(400, {
      code: API_ERROR_CODES.CUSTOMER_EMAIL_OR_USERNAME_TAKEN,
      message: SECRET,
    });
    expect(customerFormErrorCopy(err)).toBe("That email is already in use. Use a different email.");
    expect(genericToastCopy(err)).toBe("That email is already in use. Use a different email.");
  });

  it("CUSTOMER_SALES_AGENT_UNKNOWN reads as the sales-agent copy even when the message differs", () => {
    const err = axiosErr(400, {
      code: API_ERROR_CODES.CUSTOMER_SALES_AGENT_UNKNOWN,
      message: SECRET,
    });
    expect(customerFormErrorCopy(err)).toBe(
      "That sales agent is no longer available. Pick another.",
    );
    expect(genericToastCopy(err)).toBe("That sales agent is no longer available. Pick another.");
  });
});
