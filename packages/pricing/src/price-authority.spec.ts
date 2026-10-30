import {
  priceAuthority,
  type PriceAuthorityKind,
  type PriceAuthorityLevel,
  type PriceAuthorityMode,
} from "./price-authority";

const KINDS: PriceAuthorityKind[] = ["STANDARD", "FAMILY", "VARIANT", "RECIPE"];
const MODES: PriceAuthorityMode[] = ["off", "on"];
const LEVELS: PriceAuthorityLevel[] = ["base", "other"];

type Shape = {
  name: string;
  product: {
    kind: PriceAuthorityKind;
    parentProductId: string | null;
    familyPriceOverride: boolean;
    recipeFamilyId: string | null;
  };
};

const SHAPES: Shape[] = [
  {
    name: "standalone",
    product: {
      kind: "STANDARD",
      parentProductId: null,
      familyPriceOverride: false,
      recipeFamilyId: null,
    },
  },
  {
    name: "family",
    product: {
      kind: "FAMILY",
      parentProductId: null,
      familyPriceOverride: false,
      recipeFamilyId: null,
    },
  },
  {
    name: "variant",
    product: {
      kind: "VARIANT",
      parentProductId: "fam-1",
      familyPriceOverride: false,
      recipeFamilyId: null,
    },
  },
  {
    name: "variant with override",
    product: {
      kind: "VARIANT",
      parentProductId: "fam-1",
      familyPriceOverride: true,
      recipeFamilyId: null,
    },
  },
  {
    name: "standard with a parent",
    product: {
      kind: "STANDARD",
      parentProductId: "fam-1",
      familyPriceOverride: false,
      recipeFamilyId: null,
    },
  },
  {
    name: "recipe with override",
    product: {
      kind: "RECIPE",
      parentProductId: null,
      familyPriceOverride: true,
      recipeFamilyId: "fam-1",
    },
  },
  {
    name: "recipe with family link",
    product: {
      kind: "RECIPE",
      parentProductId: null,
      familyPriceOverride: false,
      recipeFamilyId: "fam-1",
    },
  },
  {
    name: "recipe without link",
    product: {
      kind: "RECIPE",
      parentProductId: null,
      familyPriceOverride: false,
      recipeFamilyId: null,
    },
  },
];

type Answer = "own" | "family" | "family-page";

// The whole table, written out: shape x mode x level.
const EXPECTED: Record<string, Record<PriceAuthorityMode, Record<PriceAuthorityLevel, Answer>>> = {
  standalone: { off: { base: "own", other: "own" }, on: { base: "own", other: "own" } },
  family: {
    off: { base: "family-page", other: "family-page" },
    on: { base: "family-page", other: "family-page" },
  },
  variant: { off: { base: "own", other: "own" }, on: { base: "family", other: "own" } },
  // a variant's override flag does not move authority (the write-through decision handles it)
  "variant with override": {
    off: { base: "own", other: "own" },
    on: { base: "family", other: "own" },
  },
  "standard with a parent": {
    off: { base: "own", other: "own" },
    on: { base: "family", other: "own" },
  },
  "recipe with override": { off: { base: "own", other: "own" }, on: { base: "own", other: "own" } },
  "recipe with family link": {
    off: { base: "own", other: "own" },
    on: { base: "family", other: "own" },
  },
  "recipe without link": { off: { base: "own", other: "own" }, on: { base: "own", other: "own" } },
};

describe("priceAuthority (U-a0)", () => {
  for (const shape of SHAPES) {
    for (const mode of MODES) {
      for (const level of LEVELS) {
        const want = EXPECTED[shape.name][mode][level];
        it(`${shape.name} / mode ${mode} / ${level} -> ${want}`, () => {
          expect(priceAuthority(shape.product, mode, level)).toBe(want);
        });
      }
    }
  }

  it("covers every kind", () => {
    expect(new Set(SHAPES.map((s) => s.product.kind))).toEqual(new Set(KINDS));
  });

  it("a variant's non-base unit levels stay its own in both modes (owner Q1)", () => {
    const v = SHAPES.find((s) => s.name === "variant")!.product;
    expect(priceAuthority(v, "on", "other")).toBe("own");
    expect(priceAuthority(v, "off", "other")).toBe("own");
  });

  it("mode off never answers family for anything but a FAMILY page", () => {
    for (const shape of SHAPES) {
      for (const level of LEVELS) {
        const a = priceAuthority(shape.product, "off", level);
        expect(a === "family").toBe(false);
      }
    }
  });
});
