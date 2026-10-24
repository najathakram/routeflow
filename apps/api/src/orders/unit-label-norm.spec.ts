import { unitNameKey } from "@routeflow/pricing";
import { keepsHeldUnit, norm } from "./unit-label-norm";
import { replayLineKey } from "./unit-line-build";

const NFC = "Caf\u00e9";
const NFD = "Cafe\u0301";

describe("the order-side unit-label key is the shared NFC key", () => {
  it("norm IS pricing's unitNameKey (one implementation)", () => {
    expect(norm).toBe(unitNameKey);
  });

  it("a line held as Café (NFC) re-sent as Café (NFD) is the SAME held unit, not re-denominated", () => {
    expect(NFC).not.toBe(NFD);
    expect(keepsHeldUnit(NFD, NFC)).toBe(true);
    expect(keepsHeldUnit(NFC, NFD)).toBe(true);
    expect(keepsHeldUnit(`  ${NFD.toUpperCase()} `, NFC)).toBe(true);
  });

  it("another label, a cleared label and an absent label behave as before", () => {
    expect(keepsHeldUnit("Case", NFC)).toBe(false);
    expect(keepsHeldUnit("", NFC)).toBe(false);
    expect(keepsHeldUnit(null, NFC)).toBe(false);
    expect(keepsHeldUnit(undefined, NFC)).toBe(true);
    expect(keepsHeldUnit(NFC, null)).toBe(false);
  });

  it("an ASCII label keys exactly as before (trim + case-fold)", () => {
    for (const [a, b] of [
      ["case", " Case"],
      ["CASE", "case "],
      ["Box", "box"],
    ]) {
      expect(keepsHeldUnit(a, b)).toBe(true);
    }
  });

  it("the replay key of a line is the same for the NFC and the NFD spelling of its unit", () => {
    const line = { productId: "p1", qty: 2, unitLabel: NFC };
    expect(replayLineKey({ ...line, unitLabel: NFD }, false)).toBe(replayLineKey(line, false));
    expect(replayLineKey({ ...line, unitLabel: ` ${NFD} ` }, true)).toBe(
      replayLineKey({ ...line, unitLabel: NFC }, true),
    );
  });
});
