import { extractRefusalMessage } from "@routeflow/returns";
import { readOnlyLine } from "@/lib/subscription-banner-state";
import { REFUND_COPY, TERMINAL_REFUND_ERRORS, refundErrorKind } from "./refund-copy";

/**
 * A refund refused by a READ_ONLY workspace is a 403 with code READ_ONLY. It used to classify as "forbidden"
 * ("You don't have permission to refund this return."), which is wrong: the user has the permission, the workspace is read-only.
 */
const readOnly403 = { response: { status: 403, data: { code: "READ_ONLY", message: "RAW" } } };

describe("refund copy: READ_ONLY", () => {
  it("a 403 READ_ONLY is its own kind, ending the refund (Close only), not 'forbidden'", () => {
    expect(refundErrorKind(readOnly403)).toBe("readOnly");
    expect(TERMINAL_REFUND_ERRORS.has("readOnly")).toBe(true);
  });

  it("the readOnly sentence is B4's line", () => {
    expect(REFUND_COPY.readOnly).toBe(readOnlyLine(null));
  });

  it("a plain 403 is still 'forbidden'", () => {
    expect(refundErrorKind({ response: { status: 403, data: {} } })).toBe("forbidden");
  });

  it("the capture refusal text (extractRefusalMessage) is the same line, never the server text", () => {
    expect(extractRefusalMessage(readOnly403)).toBe(readOnlyLine(null));
  });
});
