import {
  buildTokenWeights,
  composedProductName,
  matchLine,
  type CatalogProduct,
} from "./product-matcher";

const product = (overrides: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: "p-1",
  name: "Widget",
  sku: null,
  barcode: null,
  unitSku: null,
  parentProductId: null,
  parent: null,
  ...overrides,
});

describe("composedProductName", () => {
  it("returns the bare name for a standalone product (no parent)", () => {
    expect(composedProductName(product({ name: "Big Red Chewing Gum" }))).toBe(
      "Big Red Chewing Gum",
    );
  });

  it("prefixes the parent name for a variant row", () => {
    const variant = product({
      name: "Cinnamon",
      parentProductId: "parent-1",
      parent: { name: "Big Red Chewing Gum" },
    });
    expect(composedProductName(variant)).toBe("Big Red Chewing Gum - Cinnamon");
  });

  it("falls back to the bare name when parentProductId is set but parent isn't loaded", () => {
    const variant = product({ name: "Cinnamon", parentProductId: "parent-1", parent: null });
    expect(composedProductName(variant)).toBe("Cinnamon");
  });

  it("doesn't double-prefix a legacy variant name that already carries the parent prefix", () => {
    const variant = product({
      name: "Big Red Chewing Gum Cinnamon",
      parentProductId: "parent-1",
      parent: { name: "Big Red Chewing Gum" },
    });
    expect(composedProductName(variant)).toBe("Big Red Chewing Gum Cinnamon");
  });
});

describe("matchLine — exact matches", () => {
  it("matches an exact BARE name case-insensitively → high confidence", () => {
    const products = [product({ id: "p1", name: "Flour 25lb" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("FLOUR 25LB", null, products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p1",
      matchedProductName: "Flour 25lb",
      confidence: "high",
    });
  });

  it("matches an exact COMPOSED name (parent + variant) case-insensitively → high confidence", () => {
    const variant = product({
      id: "p2",
      name: "Cinnamon",
      parentProductId: "parent-1",
      parent: { name: "Big Red Chewing Gum" },
    });
    const products = [variant];
    const weights = buildTokenWeights(products);
    const result = matchLine("big red chewing gum - cinnamon", null, products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p2",
      matchedProductName: "Big Red Chewing Gum - Cinnamon",
      confidence: "high",
    });
  });

  it("matches an exact scanned SKU (case-insensitive) → high confidence, even against unrelated raw text", () => {
    const products = [product({ id: "p3", name: "Widget", sku: "ABC-123" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Totally unrelated description", "abc-123", products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p3",
      matchedProductName: "Widget",
      confidence: "high",
    });
  });

  it("matches an exact barcode against the raw text → high confidence", () => {
    const products = [product({ id: "p4", name: "Widget", barcode: "0123456789012" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("0123456789012", null, products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p4",
      matchedProductName: "Widget",
      confidence: "high",
    });
  });

  it("matches an exact unit code (case-insensitive) against the raw text → high confidence", () => {
    const products = [product({ id: "p5", name: "Widget", unitSku: "UNIT-555" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("unit-555", null, products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p5",
      matchedProductName: "Widget",
      confidence: "high",
    });
  });

  it("matches an exact scanned unit code (case-insensitive) → high confidence, even against unrelated raw text", () => {
    const products = [product({ id: "p6", name: "Widget", unitSku: "UNIT-777" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Totally unrelated description", "unit-777", products, weights);
    expect(result).toMatchObject({
      matchedProductId: "p6",
      matchedProductName: "Widget",
      confidence: "high",
    });
  });
});

describe("matchLine — the canonical variant trap", () => {
  it("resolves 'Big Red Cinnamon Gum' to the VARIANT (high, ~0.81), ranking the bare standalone 2nd (~0.70)", () => {
    const standalone = product({ id: "p-std", name: "Big Red Chewing Gum" });
    const variant = product({
      id: "p-var",
      name: "Cinnamon",
      parentProductId: "parent-1",
      parent: { name: "Big Red Chewing Gum" },
    });
    const products = [standalone, variant];
    const weights = buildTokenWeights(products);

    const result = matchLine("Big Red Cinnamon Gum", null, products, weights);

    expect(result.matchedProductId).toBe("p-var");
    expect(result.matchedProductName).toBe("Big Red Chewing Gum - Cinnamon");
    expect(result.confidence).toBe("high");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates?.[0]).toMatchObject({ productId: "p-var", score: 0.81 });
    expect(result.candidates?.[1]).toMatchObject({
      productId: "p-std",
      name: "Big Red Chewing Gum",
      score: 0.7,
    });
  });
});

describe("matchLine — confidence thresholds (fuzzy path)", () => {
  it("score >= 0.8 → auto-assigned, confidence high", () => {
    // Word-order-scrambled full match — not an exact string match, so this
    // exercises the fuzzy path, not the exact-name shortcut.
    const products = [product({ id: "p1", name: "Fresh Orange Juice" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Juice Orange Fresh", null, products, weights);
    expect(result.matchedProductId).toBe("p1");
    expect(result.confidence).toBe("high");
  });

  it("0.6 <= score < 0.8 → auto-assigned, confidence medium", () => {
    const products = [product({ id: "p1", name: "Fresh Orange Juice" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Orange Juice", null, products, weights);
    expect(result.matchedProductId).toBe("p1");
    expect(result.confidence).toBe("medium");
    expect(result.candidates?.[0]).toMatchObject({ productId: "p1", score: 0.67 });
  });

  it("0.35 <= score < 0.6 → NOT auto-assigned: null id, confidence low, non-empty candidates", () => {
    const products = [product({ id: "p1", name: "Wheat Bread" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Wheat Bread Multigrain Extra", null, products, weights);
    expect(result.matchedProductId).toBeNull();
    expect(result.matchedProductName).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.candidates).toEqual([
      expect.objectContaining({ productId: "p1", name: "Wheat Bread", score: 0.39 }),
    ]);
  });

  it("score < 0.35 → confidence none, null id, but weak candidates still surfaced (score >= 0.25)", () => {
    // "item" must be a COMMON token for a single shared token to score below the
    // 0.35 floor: six "Item …" rows push its document frequency to 6 (weight
    // 1/log2(8) ≈ 0.333), so "Item" vs "Item Alpha" scores ≈0.346 — under 0.35,
    // so NOT matched (confidence "none"), yet still rounds to a 0.35 candidate chip.
    const names = [
      "Item Alpha",
      "Item Bravo",
      "Item Charlie",
      "Item Delta",
      "Item Echo",
      "Item Foxtrot",
    ];
    const products = names.map((name, i) => product({ id: `p${i}`, name }));
    const weights = buildTokenWeights(products);
    const result = matchLine("Item", null, products, weights);
    expect(result.matchedProductId).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.candidates?.[0]).toMatchObject({ score: 0.35 });
  });

  it("no overlap at all → confidence none, no candidates", () => {
    const products = [product({ id: "p1", name: "Wheat Bread" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("Completely Unrelated Thing", null, products, weights);
    expect(result).toEqual({
      matchedProductId: null,
      matchedProductName: null,
      confidence: "none",
    });
  });

  it("empty raw and no scanned sku → confidence none immediately", () => {
    const products = [product({ id: "p1", name: "Wheat Bread" })];
    const weights = buildTokenWeights(products);
    const result = matchLine("   ", null, products, weights);
    expect(result).toEqual({
      matchedProductId: null,
      matchedProductName: null,
      confidence: "none",
    });
  });
});

describe("matchLine — deterministic tie-breaks", () => {
  it("equal score → higher raw hit count wins", () => {
    // "Zzz" (1 matched token) and "Mmm Nnn" (2 matched tokens) are engineered
    // via document-frequency weights (df=1 vs df=7 tokens) to tie exactly at
    // score 0.5 — hit count must be the tiebreaker. The 6 "junk" fillers only
    // exist to push mmm/nnn's df to 7; their own score (0.25, diluted by 3
    // extra unique tokens each) is deliberately lower so they don't interfere
    // with the score-0.5 tie between the two products under test.
    const names = [
      "Zzz",
      "Mmm Nnn",
      "Mmm Nnn Junk1a Junk1b Junk1c",
      "Mmm Nnn Junk2a Junk2b Junk2c",
      "Mmm Nnn Junk3a Junk3b Junk3c",
      "Mmm Nnn Junk4a Junk4b Junk4c",
      "Mmm Nnn Junk5a Junk5b Junk5c",
      "Mmm Nnn Junk6a Junk6b Junk6c",
    ];
    const products = names.map((name, i) => product({ id: `p${i}`, name }));
    const weights = buildTokenWeights(products);

    const result = matchLine("Zzz Mmm Nnn", null, products, weights);

    expect(result.candidates?.[0]).toMatchObject({ name: "Mmm Nnn", score: 0.5 });
    expect(result.candidates?.[1]).toMatchObject({ name: "Zzz", score: 0.5 });
  });

  it("equal score AND hit count → exact-prefix match wins", () => {
    // Both catalog names share the exact same token set {wheat, bread}, so
    // score and hit count tie identically — only the prefix flag differs.
    const products = [
      product({ id: "p-wb", name: "Wheat Bread" }),
      product({ id: "p-bw", name: "Bread Wheat" }),
    ];
    const weights = buildTokenWeights(products);

    const result = matchLine("Wheat Bread Rye", null, products, weights);

    expect(result.candidates?.[0]).toMatchObject({ productId: "p-wb", score: 0.5 });
    expect(result.candidates?.[1]).toMatchObject({ productId: "p-bw", score: 0.5 });
  });

  it("equal score, hit count AND prefix → falls back to name ascending", () => {
    const products = [
      product({ id: "p-beta", name: "Beta Widget" }),
      product({ id: "p-alpha", name: "Alpha Widget" }),
    ];
    const weights = buildTokenWeights(products);

    const result = matchLine("Widget", null, products, weights);

    expect(result.candidates?.[0]).toMatchObject({ productId: "p-alpha", name: "Alpha Widget" });
    expect(result.candidates?.[1]).toMatchObject({ productId: "p-beta", name: "Beta Widget" });
  });
});

describe("matchLine — candidates list shape", () => {
  it("caps candidates at 5, sorted best-first, with scores rounded to 2dp", () => {
    const names = [
      "Item Alpha",
      "Item Bravo",
      "Item Charlie",
      "Item Delta",
      "Item Echo",
      "Item Foxtrot",
    ];
    const products = names.map((name, i) => product({ id: `p${i}`, name }));
    const weights = buildTokenWeights(products);

    const result = matchLine("Item", null, products, weights);

    expect(result.candidates).toHaveLength(5);
    // Deterministic tie-break (all tie on score/hits/prefix) → name ascending.
    expect(result.candidates?.map((c) => c.name)).toEqual([
      "Item Alpha",
      "Item Bravo",
      "Item Charlie",
      "Item Delta",
      "Item Echo",
    ]);
    for (const c of result.candidates ?? []) {
      expect(c.score).toBe(0.35);
    }
  });
});
