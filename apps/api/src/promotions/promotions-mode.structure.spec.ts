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

  // SA-1032 §G4 / review-a 6506151572: the class is "every read AND every write of a Promotion row".
  // The inventory below is the 7 write sites at this change. A write added anywhere else, or in a
  // method of promotions.service.ts that does not call assertPromotionsOn, turns this red.
  const WRITE_CALL =
    /\.promotion(?:Product)?\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
  const RAW_WRITE =
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"public"\.)?"Promotion(?:Product)?"/i;

  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/.*$/gm, "");
  }

  /** The class member whose body holds `offset`: nearest 2-space-indented `name(` above it. */
  function enclosingMethod(text: string, offset: number): string {
    let name = "<top level>";
    const member = /^ {2}(?:(?:private|public|protected)\s+)?(?:async\s+)?(\w+)\(/gm;
    for (let m = member.exec(text); m && m.index < offset; m = member.exec(text)) name = m[1];
    return name;
  }

  function methodBody(text: string, method: string): string {
    const start = text.search(
      new RegExp(`^ {2}(?:(?:private|public|protected)\\s+)?(?:async\\s+)?${method}\\(`, "m"),
    );
    return start < 0 ? "" : text.slice(start, text.indexOf("\n  }\n", start));
  }

  it("every Promotion write lives in promotions.service.ts, in a method that asserts the mode (exactly 7 sites)", () => {
    const sites: string[] = [];
    const unasserted: string[] = [];
    const raw: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      const text = stripComments(fs.readFileSync(f, "utf8"));
      if (RAW_WRITE.test(text)) raw.push(rel);
      for (let m = WRITE_CALL.exec(text); m; m = WRITE_CALL.exec(text)) {
        const method = enclosingMethod(text, m.index);
        sites.push(`${rel}#${method}`);
        if (!/assertPromotionsOn\(/.test(methodBody(text, method)))
          unasserted.push(`${rel}#${method}`);
      }
    }
    expect(raw).toEqual([]);
    expect(unasserted).toEqual([]);
    expect(sites).toEqual([
      "promotions/promotions.service.ts#create", // promotion.create
      "promotions/promotions.service.ts#create", // promotionProduct.createMany
      "promotions/promotions.service.ts#update", // promotion.update
      "promotions/promotions.service.ts#update", // promotionProduct.deleteMany
      "promotions/promotions.service.ts#update", // promotionProduct.createMany
      "promotions/promotions.service.ts#setActive",
      "promotions/promotions.service.ts#remove",
    ]);
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
