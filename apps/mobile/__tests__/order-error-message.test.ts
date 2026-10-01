import { orderErrorMessage } from "../lib/order-error-message";

const stock = (extra: object = {}) => ({
  response: {
    status: 409,
    data: {
      code: "INSUFFICIENT_STOCK",
      message: "Insufficient stock: Mango 5ct (available: 4, requested: 6)",
      lines: [{ productId: "m", name: "Mango 5ct", available: 4, requested: 6 }],
      ...extra,
    },
  },
});

describe("orderErrorMessage (gap 05)", () => {
  it("create path: a stock shortfall is a sentence, never the server text", () => {
    const msg = orderErrorMessage(stock(), "fallback");
    expect(msg).toBe("Only 4 pieces of Mango 5ct left.");
    expect(msg).not.toMatch(/Insufficient stock|available:/);
  });

  it("edit path: the legacy single-line body reads the same way", () => {
    const msg = orderErrorMessage(
      {
        response: {
          data: {
            code: "INSUFFICIENT_STOCK",
            message: "Not enough stock for Mango 5ct (available: 4, requested: 9).",
            productId: "m",
            available: 4,
            requested: 9,
          },
        },
      },
      "fallback",
    );
    expect(msg).not.toMatch(/Not enough stock|available:/);
    expect(msg).toMatch(/^Only 4 pieces/);
  });

  it("several short lines and an out-of-stock line", () => {
    const msg = orderErrorMessage(
      stock({
        lines: [
          { productId: "m", name: "Mango", available: 4, requested: 6 },
          { productId: "l", name: "Lime", available: 0, requested: 2 },
        ],
      }),
      "x",
    );
    expect(msg).toBe("Only 4 pieces of Mango left. Lime is out of stock.");
  });

  it("any other failure keeps the server message, then the error message, then the fallback", () => {
    expect(orderErrorMessage({ response: { data: { message: "Boom" } } }, "f")).toBe("Boom");
    expect(orderErrorMessage(new Error("net down"), "f")).toBe("net down");
    expect(orderErrorMessage({}, "f")).toBe("f");
  });
});
