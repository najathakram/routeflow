import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { CUSTOMER_ORDER_ITEM_FIELDS } from "../common/staff-only-fields";

/**
 * SA-714 R1 / SA-716 pins: `OrderItem.backorderedPieces` is INFORMATIONAL. Written only by the locked
 * stock section (and carried by the merge fold); no money, invoice, stock or status reader consumes
 * it; no restock job or cron rewrites it; a buyer never sees it.
 */
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
const files = walk(SRC).filter((f) => !/\.(spec|test)\.ts$/.test(f) && !f.includes("/testing/"));
const mentions = files
  .filter((f) => readFileSync(f, "utf8").includes("backorderedPieces"))
  .map((f) => relative(SRC, f))
  .sort();

describe("backorderedPieces stays informational", () => {
  it("is mentioned ONLY by the marker module, its DB half, the merge fold's carry and the slip's display tag", () => {
    expect(mentions).toEqual([
      "orders/backorder-marker-writes.ts",
      "orders/backorder-marker.ts",
      "orders/merge-line-writes.ts",
      "orders/orders.service.ts",
      "orders/packing-slip-data.ts", // display only: the slip's "Backorder" tag
    ]);
  });

  it("orders.service.ts only CARRIES it (merge fold creates) and hands create()'s value to the nested create", () => {
    const src = readFileSync(join(SRC, "orders/orders.service.ts"), "utf8");
    const lines = src.split("\n").filter((l) => l.includes("backorderedPieces"));
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.includes("write.data.backorderedPieces"))).toHaveLength(2);
    expect(
      lines.filter((l) =>
        l.includes("Object.assign(li, { backorderedPieces: markers?.get(li) ?? 0 })"),
      ),
    ).toHaveLength(1);
  });

  it("only the marker module's DB half writes the column outside the merge fold", () => {
    const src = readFileSync(join(SRC, "orders/backorder-marker-writes.ts"), "utf8");
    expect(src.match(/data: \{ backorderedPieces/g)).toHaveLength(1);
  });

  it("no scheduled job rewrites it", () => {
    // orders.service.ts hosts crons too; its three mentions are pinned line-by-line above.
    const jobs = files.filter(
      (f) =>
        !f.endsWith("orders/orders.service.ts") && readFileSync(f, "utf8").includes("@LeaderCron("),
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const f of jobs) expect(readFileSync(f, "utf8")).not.toContain("backorderedPieces");
  });

  it("is NOT a buyer field (CUSTOMER_ORDER_ITEM_FIELDS)", () => {
    expect(CUSTOMER_ORDER_ITEM_FIELDS as readonly string[]).not.toContain("backorderedPieces");
  });
});
