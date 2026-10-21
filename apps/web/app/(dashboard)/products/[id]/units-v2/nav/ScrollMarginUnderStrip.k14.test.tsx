import fs from "fs";
import path from "path";

/** K14: focus targets keep clear of the sticky jump strip. jsdom has no layout; pin the shared-variable class. */
const MARGIN = "scroll-mt-[var(--jump-offset,0px)]";
const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

it.each([
  ["customer search field", "../customer/CustomerPicker.tsx"],
  ["chosen-customer line", "../customer/CustomerPriceView.tsx"],
  ["settled Saved line", "../confirm/SaveStatusLine.tsx"],
])("%s clears the strip via --jump-offset", (_n, rel) => {
  expect(read(rel)).toContain(MARGIN);
});
