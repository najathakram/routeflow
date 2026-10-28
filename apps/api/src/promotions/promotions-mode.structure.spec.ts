import * as fs from "fs";
import * as path from "path";
import { promotionsOn as sharedPromotionsOn } from "@routeflow/types";
import { promotionsOn } from "./promotions-mode";

/**
 * SA-1032 structural pin: the `promotions` off switch holds only while every read of the
 * Promotion table goes through promotions.service.ts, the buyer-facing read checks the mode, and
 * every write path asserts it. A new read elsewhere (or a write that skips the assert) would let
 * an off business keep pricing or editing promotions.
 */
const SRC = path.resolve(__dirname, "..");
const service = fs.readFileSync(path.resolve(__dirname, "promotions.service.ts"), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("SA-1032 — promotions off switch has one door", () => {
  it("every Promotion read lives in promotions.service.ts (exactly 3 sites)", () => {
    const hits: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const n = (
        fs.readFileSync(f, "utf8").match(/\.promotion\.(find|count|aggregate|group)/g) ?? []
      ).length;
      for (let i = 0; i < n; i++) hits.push(path.relative(SRC, f).split(path.sep).join("/"));
    }
    expect(hits).toEqual([
      "promotions/promotions.service.ts",
      "promotions/promotions.service.ts",
      "promotions/promotions.service.ts",
    ]);
  });

  it("create, update, setActive and remove each assert the mode (4 calls)", () => {
    expect(service.match(/assertPromotionsOn\(/g) ?? []).toHaveLength(4);
  });

  it("activeForCatalog checks promotionsOn before serving", () => {
    const start = service.indexOf("activeForCatalog(");
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, service.indexOf("\n  }\n", start));
    expect(body).toContain("promotionsOn(");
  });

  it("the API promotionsOn mirror agrees with the shared reader", () => {
    for (const mode of [undefined, null, "", "on", "off", "beta"]) {
      expect(promotionsOn(mode)).toBe(sharedPromotionsOn(mode));
    }
  });
});
