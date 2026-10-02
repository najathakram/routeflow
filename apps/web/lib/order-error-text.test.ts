import { orderErrorText } from "./order-error-text";

const axiosErr = (
  status: number,
  data: unknown,
  message = `Request failed with status code ${status}`,
) => Object.assign(new Error(message), { response: { status, data } });

describe("orderErrorText (B986-7 Opus fold): coded -> fixed copy, uncoded -> the server's own sentence, never axios text", () => {
  it("an UNCODED 409 shows the server's actionable sentence, not 'Request failed with status code 409'", () => {
    const sentence =
      "This order's invoice has recorded payments. Void the payments or the invoice first, then delete the order.";
    const text = orderErrorText(axiosErr(409, { statusCode: 409, message: sentence }));
    expect(text).toBe(sentence);
    expect(text).not.toMatch(/status code/i);
  });

  it("a coded refusal shows the fixed mapped sentence, never the server message", () => {
    const text = orderErrorText(
      axiosErr(409, { code: "ORDER_BELOW_RETURN_CREDIT", message: "server wording" }),
    );
    expect(text).not.toBe("server wording");
    expect(text.length).toBeGreaterThan(0);
  });

  it("no server sentence (no response / array body) falls to the fixed generic copy, never axios text", () => {
    expect(orderErrorText(axiosErr(500, {}))).not.toMatch(/status code/i);
    expect(orderErrorText(axiosErr(400, { message: ["a must be a string"] }))).not.toMatch(
      /status code|must be a string/i,
    );
    expect(orderErrorText(new Error("Network Error"))).not.toBe("Network Error");
  });
});
