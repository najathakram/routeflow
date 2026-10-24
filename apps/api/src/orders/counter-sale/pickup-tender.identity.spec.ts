import { isHandOverTender } from "./pickup-tender";
import { pickupTenderGroupId } from "./pickup-tender-group";

/**
 * SA-919: THIS completion's tender = a tender row of the order's hand-over group created at or after the claim's
 * `completionAt`. Each case is red on the wrong identity: time only, group only, or the order's deliveredAt.
 */
const ORDER = "ord-1";
const GROUP = pickupTenderGroupId(ORDER);
const AT = new Date("2026-10-23T12:00:00.000Z");
const row = (over: object) => ({
  id: "p",
  amount: 10,
  method: "CASH",
  status: "PAID",
  createdAt: new Date("2026-10-23T12:00:01.000Z"),
  paymentGroupId: GROUP,
  ...over,
});
const mine = isHandOverTender(ORDER, AT);

describe("isHandOverTender (SA-919)", () => {
  it("a group row made at or after completionAt is this completion's tender", () => {
    expect(mine(row({}))).toBe(true);
    expect(mine(row({ createdAt: AT }))).toBe(true);
  });

  it("a deposit or portal payment made AFTER the stamp, outside the group, is not (time alone is not the identity)", () => {
    expect(mine(row({ paymentGroupId: null }))).toBe(false);
    expect(mine(row({ paymentGroupId: pickupTenderGroupId("ord-2") }))).toBe(false);
  });

  it("a group row from an EARLIER completion (before a reopen) is not (the group alone is per order)", () => {
    expect(mine(row({ createdAt: new Date("2026-10-23T11:59:59.000Z") }))).toBe(false);
  });

  it("a legacy claim with no completionAt: every tender row of the group counts, never a deposit", () => {
    const legacy = isHandOverTender(ORDER, null);
    expect(legacy(row({ createdAt: new Date("2020-01-01T00:00:00.000Z") }))).toBe(true);
    expect(legacy(row({ paymentGroupId: null }))).toBe(false);
  });

  it("a non-tender row (a credit note) never counts", () => {
    expect(mine(row({ method: "CREDIT_NOTE" }))).toBe(false);
  });
});
