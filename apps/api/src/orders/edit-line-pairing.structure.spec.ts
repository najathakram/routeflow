import * as fs from "fs";
import * as path from "path";

/**
 * B297 row 373(b), the structural pin (same class as 340 / 343 / 352): the buyer, staff and driver replace edits
 * pair their entries with the stored lines through ONE helper, `pairEditLines`. If one of them stops calling it,
 * or a second site resolves pairings on its own, a re-created line is re-stamped as a new sale again.
 */
const read = (f: string) => fs.readFileSync(path.resolve(__dirname, f), "utf8");
const service = read("orders.service.ts");

describe("one pairing helper for the buyer, staff and driver edits (row 373b)", () => {
  it("orders.service.ts calls pairEditLines for the staff replace-all and for the buyer/driver replace", () => {
    expect(service).toContain(
      "pairEditLines(dto, order, productMap, operatorReplaceCategoryMap, user, opts)",
    );
    expect(service).toContain(
      "pairEditLines(dto, order, productMap, buyerCategoryMap, user, opts)",
    );
  });

  it("the strict fallback's 409 is raised before the linked-invoice revert commits (the pre-commit guard)", () => {
    expect(service).toContain("guardBuyerEditLineIds(order, dto, user, opts, isDiffPayload)");
    expect(read("buyer-edit-lines.ts")).toContain(
      "preflightEditLinePairing(items, order.lineItems",
    );
  });

  it("no site outside buyer-edit-lines.ts resolves pairings itself", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.ts$/.test(e.name) &&
          !/\.spec\.ts$/.test(e.name) &&
          !p.endsWith("buyer-edit-lines.ts")
        ) {
          const src = fs.readFileSync(p, "utf8");
          if (/\b(resolveBuyerEditLines|applyBuyerEditLines)\(/.test(src))
            offenders.push(path.relative(path.resolve(__dirname, ".."), p));
        }
      }
    };
    walk(path.resolve(__dirname, ".."));
    expect(offenders).toEqual([]);
  });

  it("a new OrderItem builder cannot bypass the helper: the writing files are a closed set, and createUnitLine overlays carriedLine", () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
          if (/\borderItem\.(create|createMany)\(/.test(fs.readFileSync(p, "utf8")))
            writers.push(path.relative(path.resolve(__dirname, ".."), p));
        }
      }
    };
    walk(path.resolve(__dirname, ".."));
    // A NEW file that writes OrderItems must be classified here (and carry a paired line's snapshot through
    // pairEditLines' `sourceLineId` / `carriedLine`) before it can land.
    expect(writers.sort()).toEqual([
      "invoices/invoices.service.ts",
      "orders/orders.service.ts",
      "orders/unit-line-edit.ts",
    ]);
    expect(read("unit-line-edit.ts")).toContain("item.carriedLine");
  });
});
