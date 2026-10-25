import fs from "fs";
import path from "path";

/** K14 P07: layout is not measurable in jsdom; pin the classes that put the label above, at the select's width. */
it("PRICING UNIT has its label above the select, same min width as DEFAULT ORDER UNIT, full-width select", () => {
  const src = fs.readFileSync(path.join(__dirname, "OrderUnitDraft.tsx"), "utf8");
  expect(src).toContain("mb-1 block");
  expect(src).toContain("min-w-[12rem]");
  expect(src).toContain("w-full");
  expect(src).not.toContain("flex items-center gap-2");
});
