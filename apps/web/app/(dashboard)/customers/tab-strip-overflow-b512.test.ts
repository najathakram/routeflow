import fs from "fs";
import path from "path";

/**
 * B512 (C2 390px audit): the customer-detail Tabs.List holds 10 triggers with
 * no wrap and no scroll affordance, so on a 390px viewport tabs from roughly
 * "Special Prices" onward (Comments, Documents, Licenses) were pushed off
 * the visible strip with no way to reach them. jsdom has no layout engine, so
 * it can't prove the strip actually scrolls at 390px — that's the proof
 * runner's job — but it can pin the source-level facts: the strip scrolls
 * horizontally instead of wrapping, triggers don't shrink/wrap their labels
 * before that scroll kicks in, and a tab selected via `?tab=` (or any
 * programmatic change) is scrolled into view so a deep link never lands on
 * an apparently-random strip.
 */
function read(): string {
  return fs.readFileSync(path.join(__dirname, "[id]", "page.tsx"), "utf8");
}

describe("B512 — customer-detail tab strip scrolls instead of hiding tabs", () => {
  it("Tabs.List scrolls horizontally and is wired to a ref", () => {
    const src = read();
    expect(src).toMatch(
      /<Tabs\.List\s+ref=\{tabsListRef\}\s+className="flex overflow-x-auto border-b border-surface-border"/,
    );
  });

  it("TabTrigger labels don't shrink or wrap before the strip scrolls", () => {
    const src = read();
    expect(src).toContain(
      '"-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors"',
    );
  });

  it("scrolls the active tab into view whenever activeTab changes", () => {
    const src = read();
    expect(src).toContain("const tabsListRef = React.useRef<HTMLDivElement>(null);");
    expect(src).toMatch(
      /React\.useEffect\(\(\) => \{\s*const activeEl = tabsListRef\.current\?\.querySelector<HTMLElement>\('\[data-state="active"\]'\);\s*activeEl\?\.scrollIntoView\(\{ inline: "center", block: "nearest" \}\);\s*\}, \[activeTab\]\);/,
    );
  });
});
