import { safeTextBodyCopy, safeTextErrorCopy } from "./safe-text-error-copy";

/** H3b (SA): a refused price-override reason shows one fixed sentence with an example, on web and mobile alike. */
const COPY = "A reason can't start with -, =, + or @. Try 'Discount 5% agreed'.";
const refusal = (field: string) => ({
  statusCode: 400,
  code: "TEXT_CELL_FORMULA_LEAD",
  field,
  message: "overrideReason must not start with = + - @ or a tab/line break",
});

describe("override reason formula-lead copy", () => {
  it("an overrideReason refusal reads the fixed sentence, never the server message", () => {
    expect(safeTextBodyCopy(refusal("overrideReason"))).toBe(COPY);
    expect(safeTextErrorCopy({ response: { data: refusal("overrideReason") } })).toBe(COPY);
  });

  it("other fields keep their labelled copy", () => {
    expect(safeTextBodyCopy(refusal("businessName"))).toBe(
      "Business name can't start with =, +, -, @ or a tab/line break.",
    );
  });
});
