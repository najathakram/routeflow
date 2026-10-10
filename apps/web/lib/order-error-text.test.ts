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

  it('a 5xx never shows the server message ("Internal server error" and the like): fixed generic copy', () => {
    for (const message of ["Internal server error", "Cannot read properties of undefined"]) {
      const text = orderErrorText(axiosErr(500, { statusCode: 500, message }));
      expect(text).not.toContain(message);
      expect(text).toMatch(/our side|try again/i);
    }
    expect(orderErrorText(axiosErr(503, { message: "Service Unavailable" }))).not.toContain(
      "Service Unavailable",
    );
  });

  it('a 403 never shows "Forbidden resource": the permission copy, or the coded copy when a code is present', () => {
    const text = orderErrorText(axiosErr(403, { statusCode: 403, message: "Forbidden resource" }));
    expect(text).not.toContain("Forbidden resource");
    expect(text).toMatch(/permission/i);
    const coded = orderErrorText(
      axiosErr(403, { code: "READ_ONLY", message: "Forbidden resource" }),
    );
    expect(coded).not.toContain("Forbidden resource");
    expect(coded).toMatch(/read-only/i);
  });

  it("the server sentence passes through for 400, 404, 409 and 422 only", () => {
    for (const status of [400, 404, 409, 422]) {
      expect(orderErrorText(axiosErr(status, { message: "Void the invoice first." }))).toBe(
        "Void the invoice first.",
      );
    }
    for (const status of [401, 403, 429, 500, 502]) {
      expect(orderErrorText(axiosErr(status, { message: "Void the invoice first." }))).not.toBe(
        "Void the invoice first.",
      );
    }
  });
});
