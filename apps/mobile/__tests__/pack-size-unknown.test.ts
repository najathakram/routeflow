import { readFileSync } from "fs";
import { join } from "path";
import {
  LOOSE_PIECES_CONSEQUENCE,
  getPackSizeUnknownError,
  packSizeUnknownPrompt,
  type PackSizeUnknownError,
} from "../lib/pack-size-unknown";

/** B743 PR C (REG-B743-mobile): the mobile receive screen makes loose pieces an explicit choice. */
const payload: PackSizeUnknownError = {
  code: "PACK_SIZE_UNKNOWN",
  message: '"Sample Cola" doesn\'t state units per case.',
  packSizeUnknownItems: [
    {
      id: "vbi-1",
      lineIndex: 0,
      description: "Sample Cola",
      productId: "p-1",
      productName: "Sample Cola 12pk",
      qty: 2,
      unitCost: 30,
      productPack: 12,
    },
  ],
};

describe("B743 — mobile PACK_SIZE_UNKNOWN prompt (REG-B743-mobile)", () => {
  it("spells out the loose-pieces consequence, the same line as web", () => {
    expect(LOOSE_PIECES_CONSEQUENCE).toBe("Stock counts each as 1 piece; cost is per piece.");
    const p = packSizeUnknownPrompt(payload);
    expect(p.title).toBe("Units per case missing");
    expect(p.confirmText).toBe("Receive as loose pieces");
    expect(p.message).toContain(`Receiving as loose pieces: ${LOOSE_PIECES_CONSEQUENCE}`);
    expect(p.message).toContain("• Sample Cola (usually a case of 12)");
    // SA-146a: mobile has no bill-line editor, so the way out points at the web dashboard.
    expect(p.message).toContain(
      "cancel and set the case sizes on the bill's lines in the web dashboard.",
    );
  });

  it("caps the list at 5 lines and counts the rest", () => {
    const many = {
      ...payload,
      packSizeUnknownItems: Array.from({ length: 7 }, (_, i) => ({
        ...payload.packSizeUnknownItems[0],
        lineIndex: i,
        description: `Line ${i}`,
      })),
    };
    expect(packSizeUnknownPrompt(many).message).toContain("…and 2 more");
  });

  it("getPackSizeUnknownError recognises only the PACK_SIZE_UNKNOWN 409", () => {
    expect(getPackSizeUnknownError({ response: { data: payload } })).toBe(payload);
    expect(getPackSizeUnknownError({ response: { data: { code: "UNLINKED_ITEMS" } } })).toBeNull();
  });

  it("the bill screen checks the pack refusal first and acknowledges ONLY from the prompt", () => {
    const screen = readFileSync(
      join(__dirname, "..", "app", "(operator)", "vendor-bills", "[id].tsx"),
      "utf8",
    );
    const onError = screen.slice(screen.indexOf("onError: (e: any) => {"));
    expect(onError.indexOf("getPackSizeUnknownError(e)")).toBeGreaterThan(-1);
    expect(onError.indexOf("getPackSizeUnknownError(e)")).toBeLessThan(
      onError.indexOf("getUnlinkedItemsError(e)"),
    );
    const acknowledging = (screen.match(/onReceive\([^)]*\)/g) ?? []).filter((c) =>
      /,\s*true\)$/.test(c),
    );
    expect(acknowledging).toEqual(["onReceive(acknowledgeUnlinked, true)"]);
  });
});
