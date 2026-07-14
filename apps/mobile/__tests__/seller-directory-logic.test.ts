import { sellerStatusPill, canOpenSeller, canCancelRequest } from "../lib/seller-directory-logic";

describe("sellerStatusPill", () => {
  it("maps ACTIVE to green", () => {
    expect(sellerStatusPill("ACTIVE")).toEqual({ variant: "green", label: "Active" });
  });
  it("maps PENDING_SELLER_APPROVAL to orange", () => {
    expect(sellerStatusPill("PENDING_SELLER_APPROVAL")).toEqual({
      variant: "orange",
      label: "Pending approval",
    });
  });
  it("maps INVITED to yellow", () => {
    expect(sellerStatusPill("INVITED")).toEqual({ variant: "yellow", label: "Invited" });
  });
  it("falls back to gray + the raw status for unknown values", () => {
    expect(sellerStatusPill("SUSPENDED")).toEqual({ variant: "gray", label: "SUSPENDED" });
  });
});

describe("canOpenSeller / canCancelRequest", () => {
  it("only ACTIVE can be opened", () => {
    expect(canOpenSeller({ linkStatus: "ACTIVE" })).toBe(true);
    expect(canOpenSeller({ linkStatus: "PENDING_SELLER_APPROVAL" })).toBe(false);
    expect(canOpenSeller({ linkStatus: "INVITED" })).toBe(false);
  });
  it("PENDING_SELLER_APPROVAL and INVITED can cancel; ACTIVE cannot", () => {
    expect(canCancelRequest({ linkStatus: "PENDING_SELLER_APPROVAL" })).toBe(true);
    expect(canCancelRequest({ linkStatus: "INVITED" })).toBe(true);
    expect(canCancelRequest({ linkStatus: "ACTIVE" })).toBe(false);
  });
});
