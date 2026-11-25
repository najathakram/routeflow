import { normalizeItemName, itemSourceKey } from "./normalize-item-name";
import { groupNearNames, nearNameScore, suggestNearNames } from "./near-names";
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

// R-180 follow-up: each case names the wrong value it guards against.
describe("T53 hard gates (R-180 F1, F2, F3)", () => {
  const long = "Acme Paper Cups White Premium Large";

  it("numbers gate: names that differ only in one number score 0 (wrong value: 0.9+)", () => {
    expect(nearNameScore(`${long} 12 oz`, `${long} 20 oz`)).toBe(0);
    expect(groupNearNames([`${long} 12 oz`, `${long} 20 oz`])).toEqual([]);
    const rows: CatalogItemRow[] = [{ id: "p-20", name: `${long} 20 oz` }];
    expect(resolveItem(`${long} 12 oz`, rows, []).kind).toBe("UNMATCHED");
  });

  it("numbers gate is ordered: 6 x 12oz vs 12 x 6oz scores 0 (wrong value: 0.8667)", () => {
    const a = "Acme Paper Cups White Premium 6 x 12oz";
    const b = "Acme Paper Cups White Premium 12 x 6oz";
    expect(nearNameScore(a, b)).toBe(0);
    expect(groupNearNames([a, b])).toEqual([]);
    expect(resolveItem(a, [{ id: "p-b", name: b }], []).kind).toBe("UNMATCHED");
  });

  it("numbers gate reads the parent too: Cups 12oz:Lid vs Lid scores 0 (wrong value: 1)", () => {
    expect(nearNameScore("Cups 12oz:Lid", "Lid")).toBe(0);
    expect(suggestNearNames("Cups 12oz:Lid", [{ id: "p-lid", name: "Lid" }])).toEqual([]);
  });

  it("parent gate: different parents score 0 (wrong value: 1)", () => {
    expect(nearNameScore("Acme East:Cola 12 oz", "Acme West:Cola 12 oz")).toBe(0);
  });

  it("a parentless name does not bridge two parents into one group (wrong value: 3 members)", () => {
    const groups = groupNearNames(["Acme East:Cola 12 oz", "Cola 12 oz", "Acme West:Cola 12 oz"]);
    for (const g of groups) {
      const both =
        g.members.includes("Acme East:Cola 12 oz") && g.members.includes("Acme West:Cola 12 oz");
      expect(both).toBe(false);
    }
  });

  it("a parentless name does not bridge two sizes in the parent (wrong value: 3 members)", () => {
    const groups = groupNearNames(["Cups 12oz:Lid", "Lid", "Cups 16oz:Lid"]);
    expect(groups).toEqual([]);
  });
});

describe("T53 edge cases (R-180 F4 to F7)", () => {
  it("a blank name is UNMATCHED even beside a blank catalog row (wrong value: EXACT)", () => {
    const r = resolveItem("   ", [{ id: "g", name: "   " }], []);
    expect(r.kind).toBe("UNMATCHED");
    expect(r.productId).toBeNull();
  });

  it("a trailing or leading colon does not normalise like the plain name (wrong value: equal)", () => {
    expect(normalizeItemName("Acme Gum:")).not.toBe(normalizeItemName("Acme Gum"));
    expect(normalizeItemName(":Acme Gum")).not.toBe(normalizeItemName("Acme Gum"));
    expect(resolveItem(":Acme Gum", [{ id: "p-gum", name: "Acme Gum" }], []).productId).toBeNull();
  });

  it("AMBIGUOUS suggestions do not depend on catalog order (wrong value: [z, a])", () => {
    const a: CatalogItemRow = { id: "a", name: "Acme Cola" };
    const z: CatalogItemRow = { id: "z", name: "ACME  COLA" };
    const one = resolveItem("acme cola.", [z, a], []).suggestions.map((s) => s.productId);
    const two = resolveItem("acme cola.", [a, z], []).suggestions.map((s) => s.productId);
    expect(one).toEqual(two);
  });

  it("duplicate aliases for one key that disagree are AMBIGUOUS, in any order (wrong value: first wins)", () => {
    const x: ItemAliasRow = { sourceItemKey: "Acme Gum", productId: "p-chips", ignore: false };
    const y: ItemAliasRow = { sourceItemKey: "Acme Gum", productId: "p-cola", ignore: false };
    for (const aliases of [
      [x, y],
      [y, x],
    ]) {
      const r = resolveItem("Acme Gum", catalog, aliases);
      expect(r.kind).toBe("AMBIGUOUS");
      expect(r.productId).toBeNull();
    }
  });

  it("duplicate aliases that agree still resolve", () => {
    const x: ItemAliasRow = { sourceItemKey: "Acme Gum", productId: "p-chips", ignore: false };
    expect(resolveItem("Acme Gum", catalog, [x, { ...x }]).productId).toBe("p-chips");
  });

  it("member order is code-point, not locale (wrong value: lowercase first)", () => {
    const groups = groupNearNames(["acme Gum Large", "Acme Gum Large"]);
    expect(groups[0].members).toEqual(["Acme Gum Large", "acme Gum Large"]);
  });
});
