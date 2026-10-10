import { bulkCancelFailureTitle } from "./bulk-cancel-summary";

const carrier = () => ({
  response: { status: 409, data: { code: "ORDER_WITH_CARRIER_NO_CANCEL", message: "raw" } },
});
const other = () => ({ response: { status: 500, data: { message: "boom" } } });

describe("bulkCancelFailureTitle", () => {
  it("no failure is carrier-coded: the generic failure, unchanged", () => {
    expect(bulkCancelFailureTitle([other(), new Error("network")])).toBe(
      "Failed to cancel some orders",
    );
    expect(bulkCancelFailureTitle([])).toBe("Failed to cancel some orders");
  });

  it("N orders refused with ORDER_WITH_CARRIER_NO_CANCEL: names the carrier, with the count", () => {
    expect(bulkCancelFailureTitle([carrier(), carrier(), carrier()])).toBe(
      "3 orders are with the carrier and can't be cancelled",
    );
  });

  it("one order reads in the singular", () => {
    expect(bulkCancelFailureTitle([carrier()])).toBe(
      "1 order is with the carrier and can't be cancelled",
    );
  });

  it("a mix keeps the carrier message and counts the rest", () => {
    expect(bulkCancelFailureTitle([carrier(), carrier(), other()])).toBe(
      "2 orders are with the carrier and can't be cancelled; 1 other failed to cancel",
    );
    expect(bulkCancelFailureTitle([carrier(), other(), other()])).toBe(
      "1 order is with the carrier and can't be cancelled; 2 others failed to cancel",
    );
  });

  it("an error with no response (network, thrown string) is just a failure", () => {
    expect(bulkCancelFailureTitle([undefined, null, "x", {}])).toBe("Failed to cancel some orders");
  });
});
