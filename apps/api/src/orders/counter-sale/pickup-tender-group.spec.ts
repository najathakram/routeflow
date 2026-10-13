import { uuidv5 } from "../../common/uuidv5";
import { PICKUP_TENDER_NS, pickupTenderGroupId } from "./pickup-tender-group";

describe("pickup tender group id", () => {
  it("pins the namespace literal (stored group ids are derived from it)", () => {
    expect(PICKUP_TENDER_NS).toBe("c88751da-b90f-4a39-9f0d-ff319309fe01");
  });

  it("is the v5 of `${orderId}:pickup:0` in that namespace", () => {
    const id = pickupTenderGroupId("11111111-2222-4333-8444-555555555555");
    expect(id).toBe(uuidv5("11111111-2222-4333-8444-555555555555:pickup:0", PICKUP_TENDER_NS));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs per order and is stable for one order", () => {
    expect(pickupTenderGroupId("order-a")).toBe(pickupTenderGroupId("order-a"));
    expect(pickupTenderGroupId("order-a")).not.toBe(pickupTenderGroupId("order-b"));
  });
});
