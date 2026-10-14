import { listCommitTierPatch } from "../lib/product-form";

/** Audit 2026-10-14: mobile's list field moves tiers by the same rule as web (applyListChange). */
const form = (a: string, b: string, c: string, d: string) => ({
  priceTier2: a,
  priceTier3: b,
  priceTier4: c,
  priceTier5: d,
});

describe("listCommitTierPatch", () => {
  it("10/10/10/10 with list 10 → 12 gives 12/12/12/12", () => {
    expect(listCommitTierPatch("10", "12", form("10", "10", "10", "10"), new Set())).toEqual({
      priceTier2: "12.00",
      priceTier3: "12.00",
      priceTier4: "12.00",
      priceTier5: "12.00",
    });
  });

  it("9/10/0/10 → 12 moves only the 10s; a list cut 10 → 8 caps the 9", () => {
    expect(listCommitTierPatch("10", "12", form("9", "10", "0", "10"), new Set())).toEqual({
      priceTier3: "12.00",
      priceTier5: "12.00",
    });
    expect(listCommitTierPatch("10", "8", form("9", "10", "0", "10"), new Set())).toEqual({
      priceTier2: "8.00",
      priceTier3: "8.00",
      priceTier5: "8.00",
    });
  });

  it("a tier the operator typed this session wins; a blank tier stays blank", () => {
    expect(
      listCommitTierPatch("10", "12", form("10", "10", "", "10"), new Set(["priceTier3"])),
    ).toEqual({ priceTier2: "12.00", priceTier5: "12.00" });
  });

  it("an unchanged or unreadable list changes nothing", () => {
    expect(listCommitTierPatch("10", "10.00", form("10", "10", "10", "10"), new Set())).toEqual({});
    expect(listCommitTierPatch("10", "", form("10", "10", "10", "10"), new Set())).toEqual({});
  });
});
