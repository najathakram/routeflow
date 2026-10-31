import { RETURN_MIXED_UNIT_PRODUCT_COPY } from "./credit-note-error-copy";
import { createReturnErrorText } from "./return-error-text";

const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("createReturnErrorText", () => {
  it("shows the server's cap refusal: the form cannot know what earlier returns took", () => {
    const message = "Return qty exceeds what is left on this line: 100 pcs (10 boxes).";
    expect(createReturnErrorText(refusal(400, { message }))).toBe(message);
  });

  it("shows the server's count-shape sentence", () => {
    const message = "This line is counted in its own unit: send qty.";
    expect(createReturnErrorText(refusal(400, { code: "RETURN_LINE_COUNT_SHAPE", message }))).toBe(
      message,
    );
  });

  it("gives a mixed-unit refusal fixed copy, coded or plain, and never its product id", () => {
    const message = "Product 123e4567 is on order lines with different pack sizes (10, 12).";
    expect(createReturnErrorText(refusal(409, { message }))).toBe(RETURN_MIXED_UNIT_PRODUCT_COPY);
    expect(
      createReturnErrorText(refusal(409, { code: "RETURN_MIXED_UNIT_PRODUCT", message })),
    ).toBe(RETURN_MIXED_UNIT_PRODUCT_COPY);
  });

  it("keeps the fallback for everything else", () => {
    const fallback = "Please try again.";
    expect(createReturnErrorText(new Error("Network Error"))).toBe(fallback);
    expect(createReturnErrorText(refusal(500, { message: "Internal server error" }))).toBe(
      fallback,
    );
    expect(
      createReturnErrorText(refusal(400, { message: "Invalid reason for product p-1." })),
    ).toBe(fallback);
    expect(createReturnErrorText(refusal(400, { message: ["items must be an array"] }))).toBe(
      fallback,
    );
    expect(
      createReturnErrorText(refusal(409, { code: "RETURN_LINE_NOT_ON_ORDER", message: "x" })),
    ).toBe(fallback);
  });
});
