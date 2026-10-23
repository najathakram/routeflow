/**
 * W-758: the vendor-bill line picker uses the shared popup behaviour (Tab/blur close, ArrowDown/ArrowUp/Enter/Escape),
 * not its own copy. The behaviour itself is pinned in lib/use-dismiss-on-leave.test.tsx; this pins that the picker is wired to it.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("vendor-bills line picker uses useDismissOnLeave (W-758)", () => {
  it("imports and calls the hook with the live result count and a pick handler", () => {
    expect(src).toMatch(/import \{ useDismissOnLeave \} from "@\/lib\/use-dismiss-on-leave"/);
    expect(src).toMatch(
      /useDismissOnLeave\(setOpen, \{[\s\S]*?count: products\.length[\s\S]*?onPick:/,
    );
  });

  it("spreads inputProps on the input, listProps on the popup and optionProps on each result", () => {
    expect(src).toMatch(/\{\.\.\.leave\.inputProps\}/);
    expect(src).toMatch(/\{\.\.\.leave\.listProps\}/);
    expect(src).toMatch(/\{\.\.\.leave\.optionProps\(i\)\}/);
  });
});
