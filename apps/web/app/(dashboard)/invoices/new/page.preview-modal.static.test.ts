import * as fs from "fs";
import * as path from "path";

/**
 * P7 (SA-1074): below `sm` the invoice preview is the whole visible screen, so both buttons fit at 320. jsdom can't lay
 * this out, so the classes are pinned here and the phone row in `e2e/80-pdf-preview-touch.spec.ts` measures it.
 */
const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const modal = source.slice(source.indexOf("Print-ready preview modal"));

describe("P7: the invoice preview modal on a phone", () => {
  it("has no outer padding below sm", () => {
    expect(modal).toMatch(/bg-black\/60 sm:p-6/);
  });

  it("is full height in the house dvh form, and keeps 90vh from sm", () => {
    expect(modal).toMatch(/h-screen[^"]*supports-\[height:100dvh\]:h-dvh/);
    expect(modal).toMatch(
      /sm:h-\[90vh\][^"]*sm:rounded-xl[^"]*sm:supports-\[height:100dvh\]:h-\[90vh\]/,
    );
  });

  it("clears the safe area, and truncates the title before a button", () => {
    expect(modal).toMatch(/pt-\[max\(0\.75rem,env\(safe-area-inset-top\)\)\]/);
    expect(modal).toMatch(/min-w-0 truncate/);
    expect(modal.match(/shrink-0 max-sm:h-11/g)).toHaveLength(2);
  });
});
