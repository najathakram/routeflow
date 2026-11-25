import { normalizeItemName, itemSourceKey } from "./normalize-item-name";
import { groupNearNames, suggestNearNames } from "./near-names";
import { resolveItem } from "./resolve-item";
import type { CatalogItemRow, ItemAliasRow } from "./types";

// T53 (SA-1295 A2, B1): the normaliser and near-name groups SUGGEST only.
// Pure: catalog and alias rows are passed in; nothing here reads or writes a database.

const catalog: CatalogItemRow[] = [
  { id: "p-cola", name: "Acme Cola 12 oz" },
  { id: "p-chips", name: "Acme Chips Large" },
  { id: "p-gum", name: "Acme Gum" },
];

describe("T53 normalizeItemName", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeItemName("  ACME   Cola  ")).toBe("acme cola");
  });

  it("drops punctuation and reads & as and", () => {
    expect(normalizeItemName("Acme Salt & Pepper, 12-oz.")).toBe("acme salt and pepper 12 oz");
  });

  it("splits a unit glued to its number so 12oz equals 12 oz", () => {
    expect(normalizeItemName("Acme Cola 12oz")).toBe(normalizeItemName("ACME COLA 12 OZ"));
  });

  it("keeps the Parent:Child separator in the normalised form", () => {
    expect(normalizeItemName("Acme Drinks : Cola 12oz")).toBe("acme drinks:cola 12 oz");
  });
});

describe("T53 itemSourceKey", () => {
  it("keeps the full Parent:Child name, never only the child", () => {
    expect(itemSourceKey("  Acme Drinks:Cola 12oz ")).toBe("Acme Drinks:Cola 12oz");
  });

  it("does not case-fold or strip punctuation (it is a source key, not a match key)", () => {
    expect(itemSourceKey("ACME Cola, 12-oz.")).toBe("ACME Cola, 12-oz.");
  });
});

describe("T53 resolveItem", () => {
  it("an exact alias wins over an exact catalog name", () => {
    const aliases: ItemAliasRow[] = [
      { sourceItemKey: "Acme Gum", productId: "p-chips", ignore: false },
    ];
    const r = resolveItem("Acme Gum", catalog, aliases);
    expect(r.kind).toBe("ALIAS");
    expect(r.productId).toBe("p-chips");
  });

  it("an alias marked ignore resolves to no product and is not suggested", () => {
    const aliases: ItemAliasRow[] = [{ sourceItemKey: "Acme Gum", productId: null, ignore: true }];
    const r = resolveItem("Acme Gum", catalog, aliases);
    expect(r.kind).toBe("ALIAS");
    expect(r.productId).toBeNull();
    expect(r.ignore).toBe(true);
    expect(r.suggestions).toEqual([]);
  });

  it("an alias is matched on the full Parent:Child key, not the child alone", () => {
    const aliases: ItemAliasRow[] = [
      { sourceItemKey: "Acme Drinks:Acme Gum", productId: "p-chips", ignore: false },
    ];
    const r = resolveItem("Acme Gum", catalog, aliases);
    expect(r.kind).toBe("EXACT");
    expect(r.productId).toBe("p-gum");
  });

  it("an alias key is exact: a differently cased source name does not hit the alias", () => {
    const aliases: ItemAliasRow[] = [
      { sourceItemKey: "ACME GUM", productId: "p-chips", ignore: false },
    ];
    expect(resolveItem("Acme Gum", catalog, aliases).kind).toBe("EXACT");
  });

  it("a placeholder alias with no product and no ignore flag is not a match", () => {
    const aliases: ItemAliasRow[] = [{ sourceItemKey: "Acme Gum", productId: null, ignore: false }];
    expect(resolveItem("Acme Gum", catalog, aliases).kind).toBe("EXACT");
  });

  it("matches an exact catalog name", () => {
    const r = resolveItem("Acme Chips Large", catalog, []);
    expect(r.kind).toBe("EXACT");
    expect(r.productId).toBe("p-chips");
  });

  it("matches one catalog row by normalised name", () => {
    const r = resolveItem("ACME COLA 12OZ", catalog, []);
    expect(r.kind).toBe("NORMALISED");
    expect(r.productId).toBe("p-cola");
  });

  it("two catalog rows with the same normalised name are AMBIGUOUS and pick none", () => {
    const dup: CatalogItemRow[] = [
      { id: "p-1", name: "Acme Cola" },
      { id: "p-2", name: "ACME  COLA" },
    ];
    const r = resolveItem("acme cola.", dup, []);
    expect(r.kind).toBe("AMBIGUOUS");
    expect(r.productId).toBeNull();
    expect(r.suggestions.map((s) => s.productId).sort()).toEqual(["p-1", "p-2"]);
  });

  it("a near name SUGGESTS but never sets a product", () => {
    const r = resolveItem("Acme Cola 12 oz Can", catalog, []);
    expect(r.kind).toBe("SUGGESTED");
    expect(r.productId).toBeNull();
    expect(r.suggestions[0].productId).toBe("p-cola");
  });

  it("a name with no near catalog row stays as text", () => {
    const r = resolveItem("Zzz Unrelated Thing", catalog, []);
    expect(r.kind).toBe("UNMATCHED");
    expect(r.productId).toBeNull();
    expect(r.suggestions).toEqual([]);
  });

  it("keeps the full source key on every result", () => {
    expect(resolveItem(" Acme Drinks:Cola 12oz ", catalog, []).sourceKey).toBe(
      "Acme Drinks:Cola 12oz",
    );
  });

  it("does not mutate the catalog or alias rows passed in", () => {
    const c = JSON.parse(JSON.stringify(catalog)) as CatalogItemRow[];
    const a: ItemAliasRow[] = [{ sourceItemKey: "X", productId: "p-gum", ignore: false }];
    resolveItem("Acme Cola 12 oz Can", c, a);
    expect(c).toEqual(catalog);
    expect(a).toEqual([{ sourceItemKey: "X", productId: "p-gum", ignore: false }]);
  });
});

describe("T53 near-name groups suggest only", () => {
  it("groups spelling variants of one item", () => {
    const groups = groupNearNames([
      "Acme Cola 12oz",
      "ACME COLA 12 OZ.",
      "Acme Cola 12 oz",
      "Acme Gum",
    ]);
    expect(groups).toHaveLength(1);
    expect([...groups[0].members].sort()).toEqual(
      ["ACME COLA 12 OZ.", "Acme Cola 12 oz", "Acme Cola 12oz"].sort(),
    );
  });

  it("never marks a group confirmed", () => {
    const groups = groupNearNames(["Acme Cola 12oz", "Acme Cola 12 oz"]);
    expect(groups[0].confirmed).toBe(false);
  });

  it("does not group different sizes of the same product line", () => {
    expect(groupNearNames(["Acme Cola 12 oz", "Acme Cola 20 oz"])).toEqual([]);
  });

  it("does not fold Parent:Child names that differ only in the parent", () => {
    expect(groupNearNames(["Acme East:Cola 12 oz", "Acme West:Cola 12 oz"])).toEqual([]);
  });

  it("keeps the full source name of every member", () => {
    const groups = groupNearNames(["Acme Drinks:Cola 12oz", "Acme Drinks:Cola 12 oz"]);
    expect(groups[0].members).toEqual(
      expect.arrayContaining(["Acme Drinks:Cola 12oz", "Acme Drinks:Cola 12 oz"]),
    );
  });

  it("is deterministic regardless of input order", () => {
    const a = groupNearNames([
      "Acme Cola 12oz",
      "Acme Chips Large",
      "Acme Cola 12 oz",
      "Acme Chips Lrg",
    ]);
    const b = groupNearNames([
      "Acme Chips Lrg",
      "Acme Cola 12 oz",
      "Acme Chips Large",
      "Acme Cola 12oz",
    ]);
    expect(a).toEqual(b);
  });

  it("suggestNearNames ranks by score, best first, limited", () => {
    const s = suggestNearNames("Acme Cola 12 oz Can", catalog, 2);
    expect(s.length).toBeLessThanOrEqual(2);
    expect(s[0].productId).toBe("p-cola");
    expect(s[0].score).toBeGreaterThan(0.5);
    for (let i = 1; i < s.length; i++) expect(s[i - 1].score).toBeGreaterThanOrEqual(s[i].score);
  });
});
