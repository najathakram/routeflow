/**
 * #2660: on the split-invoice screen at 390 wide, a plain line's product name truncated to "Mixed …".
 * The name block was `{ flex: 1, minWidth: 0 }` inside a wrapping row, so it SHRANK to whatever the
 * qty input + None/Half/All + line total (~270pt) left over instead of letting them wrap. The name
 * block now keeps a real minimum width (so the controls drop to their own line on a narrow screen)
 * and the name may use two lines. Mobile Jest is pure-logic only (no renderer), so this pins the
 * layout contract in the component source; the 390/768/1440 captures prove it visually.
 */
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(__dirname, "..", "components", "SplitInvoiceScreen.tsx"), "utf8");

const styleBlock = (name: string): string => {
  const m = new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`style ${name} not found`);
  return m[1];
};
const num = (block: string, key: string): number | null => {
  const m = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(block);
  return m ? Number(m[1]) : null;
};

describe("split-invoice line: the product name is never squeezed to '…' (#2660)", () => {
  it("the line row wraps", () => {
    expect(styleBlock("itemRow")).toMatch(/flexWrap:\s*"wrap"/);
  });

  it("the name block keeps a real minimum width (so the controls wrap under it at 390)", () => {
    const block = styleBlock("itemNameBlock");
    expect(num(block, "minWidth")).toBeGreaterThanOrEqual(160);
    expect(num(block, "flexBasis")).toBeGreaterThanOrEqual(160);
    expect(block).toMatch(/flexGrow:\s*1/);
  });

  it("the row uses that block, not a shrink-to-zero inline block", () => {
    expect(src).toMatch(/<View style=\{styles\.itemNameBlock\}>/);
    expect(src).not.toMatch(
      /<View style=\{\{\s*flex:\s*1,\s*minWidth:\s*0\s*\}\}>\s*<Text style=\{styles\.itemName\}/,
    );
  });

  it("the name may use two lines", () => {
    expect(src).toMatch(/<Text style=\{styles\.itemName\} numberOfLines=\{2\}>/);
  });
});
