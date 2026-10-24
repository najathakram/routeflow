import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";

/**
 * #2717 M2 (SA-594) — structural recurrence guard for the ordered, children-first wipe lists.
 *
 * `Recipe.productId` / `familyProductId` / `RecipeComponent.componentProductId` are RESTRICT FKs into
 * Product, so a wipe list that deletes `product` without first deleting `recipeComponent`, `recipe`
 * fails with P2003. The rule, driven by `Prisma.dmmf` (the generated client: no DB): for EVERY model
 * M in a list, every model R holding a RESTRICT / NoAction FK INTO M must be listed EARLIER, or be
 * reached by an onDelete: Cascade chain from a model listed earlier (or from M itself). SetNull FKs
 * (ProductUnit.parent self-FK) never block a delete. Cascade children (ProductBarcode, ProductImage)
 * pass because of the Cascade, not because they are listed.
 *
 * List covered: NUKE_MODELS (apps/api/scripts/wipe-tenant-fresh-start.js, the tenant fresh-start wipe).
 * NOT covered: apps/api/scripts/reset-and-seed.ts (its ordered deleteMany names stale delegates such as
 * `invoiceLineItem` / `inventoryPurchase` that no longer exist in the schema, so it cannot run; the
 * "stale" test below pins that this is why it is excluded). The TRUNCATE ... CASCADE scripts (nuke-*, DANGER-*, reset-seed.js) carry no order and are safe by
 * construction. There is no app-side fresh-start list (grep: none deletes Product in bulk by order).
 */

const API_DIR = path.resolve(__dirname, "../..");
const MODELS = Prisma.dmmf.datamodel.models;
const byName = new Map(MODELS.map((m) => [m.name, m]));

interface Fk {
  holder: string; // the model that holds the FK columns
  field: string;
  target: string; // the model the FK points INTO
  onDelete: string;
}

/**
 * Runtime `Prisma.dmmf` in Prisma 7 keeps only names/kinds/types (relationFromFields, relationOnDelete
 * and isRequired are stripped from the generated client), so the FK edges are read from the schema
 * folder itself; `Prisma.dmmf` still proves every parsed model is a real, generated model.
 */
function parseFks(): Fk[] {
  const dir = path.join(API_DIR, "prisma", "schema");
  const fks: Fk[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".prisma"))) {
    let holder = "";
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      const head = /^model (\w+) \{/.exec(line);
      if (head) holder = head[1];
      else if (/^\}/.test(line)) holder = "";
      if (!holder) continue;
      const m = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?\s+@relation\(([^)]*)\)/.exec(line);
      if (!m || !/fields:\s*\[/.test(m[5])) continue;
      const optional = m[4] === "?";
      const od = /onDelete:\s*(\w+)/.exec(m[5])?.[1];
      // Prisma defaults: a required relation is Restrict, an optional one SetNull.
      fks.push({
        holder,
        field: m[1],
        target: m[2],
        onDelete: od ?? (optional ? "SetNull" : "Restrict"),
      });
    }
  }
  return fks;
}
const FKS = parseFks();

/** models deleted as a side effect of deleting `from` (transitive onDelete: Cascade) */
function cascadeClosure(from: string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...from];
  while (queue.length) {
    const cur = queue.pop() as string;
    for (const fk of FKS) {
      if (fk.target === cur && fk.onDelete === "Cascade" && !out.has(fk.holder)) {
        out.add(fk.holder);
        queue.push(fk.holder);
      }
    }
  }
  return out;
}

export interface Violation {
  list: string;
  model: string;
  referencing: string;
  field: string;
  onDelete: string;
}

export function checkOrder(listName: string, order: string[]): Violation[] {
  const violations: Violation[] = [];
  order.forEach((model, idx) => {
    const before = order.slice(0, idx + 1); // M itself counts: its own Cascade children die with it
    const reached = cascadeClosure(before);
    const earlier = new Set(order.slice(0, idx));
    for (const fk of FKS) {
      if (fk.target !== model) continue;
      if (fk.onDelete !== "Restrict" && fk.onDelete !== "NoAction") continue;
      if (fk.holder === model) continue; // a self-FK is one statement's problem, not an ordering one
      if (earlier.has(fk.holder) || reached.has(fk.holder)) continue;
      violations.push({
        list: listName,
        model,
        referencing: fk.holder,
        field: fk.field,
        onDelete: fk.onDelete,
      });
    }
  });
  return violations;
}

const toModel = (delegate: string): string =>
  delegate === "returnRecord" || delegate === "return"
    ? "Return"
    : delegate.charAt(0).toUpperCase() + delegate.slice(1);

function nukeModels(): string[] {
  const src = readFileSync(path.join(API_DIR, "scripts", "wipe-tenant-fresh-start.js"), "utf8");
  const body = /const NUKE_MODELS = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
  return [...body.replace(/\/\/.*$/gm, "").matchAll(/"(\w+)"/g)].map((m) => toModel(m[1]));
}

function resetAndSeedDelegates(): string[] {
  const src = readFileSync(path.join(API_DIR, "scripts", "reset-and-seed.ts"), "utf8");
  return [...src.matchAll(/prisma\.(\w+)\.deleteMany\(/g)].map((m) => toModel(m[1]));
}

/**
 * Pre-existing gaps (NOT M1/M2) the pin found on its first run. Allow-listed by
 * `list|model|referencing` so a NEW violation still fails; each is reported, not fixed silently.
 */
const L = "wipe-tenant-fresh-start.js NUKE_MODELS";
const GAP =
  "pre-existing gap: model is missing from NUKE_MODELS (a tenant holding rows fails P2003)";
const ALLOWED_PREEXISTING = new Map<string, string>([
  [`${L}|Invoice|CommissionAccrual`, GAP],
  [`${L}|Order|Return`, "pre-existing order gap: `returnRecord` is listed AFTER `order`"],
  [`${L}|Expense|CommissionPayout`, GAP],
  [`${L}|Transaction|Payment`, "pre-existing order gap: `payment` is listed AFTER `transaction`"],
  [`${L}|Customer|CustomerCommissionRate`, GAP],
  [`${L}|Customer|AgentAssignment`, GAP],
  [`${L}|Customer|CommissionAccrual`, GAP],
  [`${L}|Product|SupplierProduct`, GAP],
  [`${L}|Supplier|SupplierProduct`, GAP],
  [`${L}|Supplier|SupplierCredit`, GAP],
]);

const key = (v: Violation) => `${v.list}|${v.model}|${v.referencing}`;

// Any FUTURE child of Product with a Restrict FK (e.g. row 509's SellingRestrictionTarget) must be listed in
// NUKE_MODELS ahead of "product", or this pin goes red: children are deleted before the rows they point at.
describe("wipe / fresh-start order lists respect RESTRICT FKs (SA-594)", () => {
  const lists: Record<string, () => string[]> = {
    "wipe-tenant-fresh-start.js NUKE_MODELS": nukeModels,
  };

  it("the parsed lists are non-trivial and name real models where they claim to", () => {
    expect(nukeModels().length).toBeGreaterThan(40);
    expect(nukeModels()).toContain("Product");
    for (const m of nukeModels()) expect(byName.has(m)).toBe(true);
  });

  for (const [name, get] of Object.entries(lists)) {
    it(`${name}: no un-allow-listed RESTRICT/NoAction referrer is missing or listed later`, () => {
      const order = get().filter((m) => byName.has(m)); // stale delegate names cannot be checked
      const bad = checkOrder(name, order).filter((v) => !ALLOWED_PREEXISTING.has(key(v)));
      expect(bad.map((v) => `${v.model} <- ${v.referencing}.${v.field} (${v.onDelete})`)).toEqual(
        [],
      );
    });
  }

  it("reset-and-seed.ts is excluded because its list names delegates that are not models", () => {
    expect(resetAndSeedDelegates().filter((m) => !byName.has(m)).length).toBeGreaterThan(0);
  });

  it("every allow-list entry still fires (a fixed gap must leave the allow-list)", () => {
    const fired = new Set<string>();
    for (const [name, get] of Object.entries(lists))
      for (const v of checkOrder(
        name,
        get().filter((m) => byName.has(m)),
      ))
        fired.add(key(v));
    for (const k of ALLOWED_PREEXISTING.keys()) expect(fired.has(k)).toBe(true);
  });

  describe("the checker is not vacuous", () => {
    it("every parsed FK holder and target is a real generated model, and the parse sees the FKs", () => {
      expect(FKS.length).toBeGreaterThan(200);
      for (const fk of FKS) {
        expect(byName.has(fk.holder)).toBe(true);
        expect(byName.has(fk.target)).toBe(true);
      }
    });

    it("Recipe / RecipeComponent are RESTRICT referrers of Product", () => {
      const ref = (h: string) =>
        FKS.filter((k) => k.holder === h && k.target === "Product" && k.onDelete === "Restrict")
          .map((k) => k.field)
          .sort();
      expect(ref("Recipe")).toEqual(["family", "product"]);
      expect(ref("RecipeComponent")).toEqual(["componentProduct"]);
    });

    it("a synthetic list with product BEFORE recipe fails", () => {
      const v = checkOrder("synthetic", ["RecipeComponent", "Product", "Recipe"]);
      expect(v.map((x) => `${x.model}<-${x.referencing}`)).toContain("Product<-Recipe");
    });

    it("a synthetic list with recipeComponent < recipe < product passes for the recipe tables", () => {
      const v = checkOrder("synthetic", ["RecipeComponent", "Recipe", "Product"]).filter(
        (x) => x.referencing === "Recipe" || x.referencing === "RecipeComponent",
      );
      expect(v).toEqual([]);
    });

    it("Recipe listed after RecipeComponent is fine; Recipe before Product but without RecipeComponent passes only via Cascade", () => {
      const v = checkOrder("synthetic", ["Recipe", "Product"]).filter(
        (x) => x.referencing === "RecipeComponent",
      );
      expect(v).toEqual([]); // RecipeComponent cascades from Recipe
    });

    it("M1 tables pass because of the Cascade, not by being listed", () => {
      const v = checkOrder("synthetic", ["Product"]);
      expect(v.filter((x) => x.referencing === "ProductBarcode")).toEqual([]);
      expect(v.filter((x) => x.referencing === "ProductImage")).toEqual([]);
      for (const t of ["ProductBarcode", "ProductImage"]) {
        const fk = FKS.find((k) => k.holder === t && k.target === "Product");
        expect(fk?.onDelete).toBe("Cascade");
      }
    });

    it("ProductUnit's parent self-FK is SetNull and never an ordering violation", () => {
      const fk = FKS.find((k) => k.holder === "ProductUnit" && k.target === "ProductUnit");
      expect(fk?.onDelete).toBe("SetNull");
      expect(
        checkOrder("synthetic", ["ProductUnit"]).filter((x) => x.referencing === "ProductUnit"),
      ).toEqual([]);
    });
  });
});
