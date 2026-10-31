import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * W-854 inventory pin (SA-940 MUST 6, A-1.3, L-305): every place that starts a sale, in one list. A new one is a new row
 * here, with its ruling. `ship=1` is here until W-855 retires it.
 */
const WEB = resolve(__dirname, "..");
const read = (file: string) => readFileSync(join(WEB, file), "utf8");
const ORDERS = "app/(dashboard)/orders/page.tsx";
const DASHBOARD = "app/(dashboard)/dashboard/page.tsx";

const ENTRIES: ReadonlyArray<[string, string, string]> = [
  ["Orders header", ORDERS, "<NewOrderButton"],
  ["dashboard, both branches", DASHBOARD, "<NewOrderButton"],
  ["sidebar Counter leaf", "app/(dashboard)/layout.tsx", 'href: "/orders/counter-sale"'],
  ["palette New Order", "components/CommandPalette.tsx", '"New Order"'],
  ["palette New counter sale", "components/CommandPalette.tsx", "/orders/counter-sale"],
  ["g t", "lib/nav-shortcuts.ts", "/orders/counter-sale"],
  [
    "settings index",
    "app/(dashboard)/settings/_components/settings-index.ts",
    "/orders/counter-sale",
  ],
  ["/orders/new", "app/(dashboard)/orders/new/page.tsx", 'builder: "1"'],
  [
    "place a new order",
    "app/(dashboard)/orders/[id]/ShippedOrderExits.tsx",
    '"/orders?action=new"',
  ],
  [
    "create an order with this product",
    "app/(dashboard)/products/[id]/SalesHistoryCard.tsx",
    '"/orders?action=new"',
  ],
  [
    "scan to add order",
    "app/(dashboard)/routes/my-runs/page.tsx",
    '"/orders?action=new&builder=1"',
  ],
  ["new order at door", "components/ArrivedStopSheet.tsx", '"/orders?action=new&builder=1"'],
  ["draft dock scan", "components/DraftDock.tsx", 'params.set("scan", scanCode)'],
  [
    "ship this order instead",
    "app/(dashboard)/orders/_components/CounterSaleScreen.tsx",
    "action=new&ship=1",
  ],
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("every place that starts a sale", () => {
  it.each(ENTRIES)("%s", (_name, file, marker) => {
    expect(read(file)).toContain(marker);
  });

  it.each([ORDERS, DASHBOARD])("%s renders no second sale button", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/>\s*Counter sale\s*</);
    expect(source).not.toMatch(/>\s*Invoice a customer\s*</);
    expect(source).not.toMatch(/>\s*New order\s*</);
  });

  it("no web source reads the retired gate fields", () => {
    const hits = ["app", "components", "lib"]
      .flatMap((d) => sources(join(WEB, d)))
      .filter((f) =>
        /opensAsCounter|offerInvoiceOrder|quickCreateRule/.test(readFileSync(f, "utf8")),
      );
    expect(hits).toEqual([]);
  });
});
