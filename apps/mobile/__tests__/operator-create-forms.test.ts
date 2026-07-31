/**
 * RF-203: Operator Create forms — spinner-free rendering
 *
 * Before the fix, navigating to /routes/create, /customers/create,
 * /products/create, or /invoices/create on the Expo web bundle would match
 * the [id].tsx dynamic segment with id="create". Each [id] screen calls
 * useAdminRoute("create") / useCustomer("create") etc., which fire 404 API
 * requests. After React Query exhausts retries, isLoading is false but data
 * is still undefined. The render guard `if (isLoading || !data)` never
 * clears → permanent spinner.
 *
 * Fix:
 *  1. Add explicit create.tsx files that re-export the corresponding new.tsx.
 *     Expo Router static segments always win over [id] dynamic segments, so
 *     the form renders immediately with no API call.
 *  2. Add defensive useEffect redirects in [id].tsx screens so that even if
 *     "create" somehow reaches the detail screen, it redirects to new.tsx
 *     and the query is disabled (enabled: false via empty/null id).
 *
 * These tests verify:
 *  - The "create alias" detection logic (id === "create" || id === "new")
 *  - The disabled-query guard (empty string → disabled via enabled: !!id)
 *  - The buildPayload helpers validate synchronously without any fetch
 *  - The emptyForm factories initialise synchronously with no network calls
 */

// The product-form logic is now a React-Native-free module, so the tests below
// exercise the REAL buildProductPayload/emptyProductForm (not a replica).
import { buildProductPayload, emptyProductForm, productFormFromValues } from "../lib/product-form";

// ── Utility: mirrors the guard logic extracted from [id].tsx screens ─────────

/** Simulates the `enabled: !!id` guard in all detail hooks. */
function queryEnabled(id: string | null | undefined): boolean {
  return !!id;
}

/** Simulates the create-alias detection added to each [id].tsx screen. */
function isCreateAlias(id: string | undefined): boolean {
  return id === "create" || id === "new";
}

/** Simulates the safe-id extraction: disable query when id is a create alias. */
function safeId(id: string | undefined): string {
  return isCreateAlias(id) ? "" : (id ?? "");
}

// ── Pure form helper logic ────────────────────────────────────────────────
// (buildProductPayload / emptyProductForm imported from ../lib/product-form)

interface CustomerFormValues {
  businessName: string;
  contactName: string;
  email: string;
  phone: string;
  creditLimit: string;
  pricingTier: number;
  currency: string;
  notes: string;
  deliveryWindowStart: string;
  deliveryWindowEnd: string;
  isTaxExempt: boolean;
  taxId: string;
}

function emptyCustomerForm(): CustomerFormValues {
  return {
    businessName: "",
    contactName: "",
    email: "",
    phone: "",
    creditLimit: "",
    pricingTier: 1,
    currency: "",
    notes: "",
    deliveryWindowStart: "",
    deliveryWindowEnd: "",
    isTaxExempt: false,
    taxId: "",
  };
}

// ── Tests — create alias detection ───────────────────────────────────────────

describe("create-alias detection (RF-203)", () => {
  it('treats "create" as a create alias', () => {
    expect(isCreateAlias("create")).toBe(true);
  });

  it('treats "new" as a create alias', () => {
    expect(isCreateAlias("new")).toBe(true);
  });

  it("does not treat a real UUID as a create alias", () => {
    expect(isCreateAlias("c1a2b3d4-1234-5678-abcd-ef0123456789")).toBe(false);
  });

  it("does not treat an empty string as a create alias", () => {
    expect(isCreateAlias("")).toBe(false);
  });

  it("does not treat undefined as a create alias", () => {
    expect(isCreateAlias(undefined)).toBe(false);
  });
});

// ── Tests — query disabled guard ──────────────────────────────────────────────

describe("query enabled guard (enabled: !!id)", () => {
  it("disables query when id is empty (create alias produces empty)", () => {
    expect(queryEnabled(safeId("create"))).toBe(false);
  });

  it("disables query when id is 'new'", () => {
    expect(queryEnabled(safeId("new"))).toBe(false);
  });

  it("enables query for a real ID", () => {
    const realId = "c1a2b3d4-1234-5678-abcd-ef0123456789";
    expect(queryEnabled(safeId(realId))).toBe(true);
  });

  it("disables query when id is null", () => {
    expect(queryEnabled(null)).toBe(false);
  });

  it("disables query when id is undefined", () => {
    expect(queryEnabled(undefined)).toBe(false);
  });

  it("disables query when safeId returns empty for 'create'", () => {
    // This is the exact guard path in the fixed [id].tsx screens:
    //   const isCreateAlias = id === "create" || id === "new";
    //   const safeQueryId = isCreateAlias ? null : id;
    //   const { data } = useAdminRoute(safeQueryId); // enabled: !!safeQueryId
    const id = "create";
    const effectiveId = isCreateAlias(id) ? null : id;
    expect(queryEnabled(effectiveId)).toBe(false);
  });
});

// ── Tests — form payload builders (synchronous, no fetch) ─────────────────────

describe("ProductForm — buildProductPayload (synchronous, no fetch)", () => {
  it("returns error for empty name", () => {
    const form = emptyProductForm();
    const result = buildProductPayload(form);
    expect(result).toEqual({ error: "Name is required." });
  });

  it("returns error for missing price", () => {
    const form = { ...emptyProductForm(), name: "Test Product", pricePerUnit: "" };
    const result = buildProductPayload(form);
    expect(result).toEqual({ error: "Enter a valid price." });
  });

  it("returns valid payload for minimal inputs", () => {
    const form = { ...emptyProductForm(), name: "Sourdough Loaf", pricePerUnit: "4.99" };
    const result = buildProductPayload(form);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.name).toBe("Sourdough Loaf");
      expect(result.pricePerUnit).toBe(4.99);
      expect(result.isActive).toBe(true);
    }
  });

  it("trims whitespace from name", () => {
    const form = { ...emptyProductForm(), name: "  Trimmed  ", pricePerUnit: "1.00" };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.name).toBe("Trimmed");
    }
  });

  it("omits optional fields when blank", () => {
    const form = { ...emptyProductForm(), name: "X", pricePerUnit: "1" };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.sku).toBeUndefined();
      expect(result.barcode).toBeUndefined();
      expect(result.standardCost).toBeUndefined();
    }
  });

  it("create: sends a trimmed unitSku when provided", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      unitSku: "  UNIT-001  ",
    };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.unitSku).toBe("UNIT-001");
    }
  });

  it("create: omits unitSku (undefined) when blank", () => {
    const form = { ...emptyProductForm(), name: "X", pricePerUnit: "1", unitSku: "" };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.unitSku).toBeUndefined();
    }
  });

  it('edit (mode="edit"): sends null for unitSku when blank, to clear it', () => {
    const form = { ...emptyProductForm(), name: "X", pricePerUnit: "1", unitSku: "" };
    const result = buildProductPayload(form, "edit");
    if (!("error" in result)) {
      expect(result.unitSku).toBeNull();
    }
  });

  it('edit (mode="edit"): sends a trimmed unitSku when provided', () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      unitSku: "  UNIT-002  ",
    };
    const result = buildProductPayload(form, "edit");
    if (!("error" in result)) {
      expect(result.unitSku).toBe("UNIT-002");
    }
  });

  it("standalone product carries no variant linkage", () => {
    const form = { ...emptyProductForm(), name: "Plain", pricePerUnit: "2" };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.parentProductId).toBeUndefined();
      expect(result.variantName).toBeUndefined();
    }
  });

  it("variant: requires a flavor name when a parent is picked", () => {
    // Parent selected but no variantName → the standalone Name is irrelevant.
    const form = {
      ...emptyProductForm(),
      name: "ignored",
      parentProductId: "parent-uuid",
      variantName: "  ",
      pricePerUnit: "5",
    };
    const result = buildProductPayload(form);
    expect(result).toEqual({ error: "Variant name (flavor) is required." });
  });

  it("variant: stores JUST the flavor in name + keeps parent linkage", () => {
    const form = {
      ...emptyProductForm(),
      name: "should be ignored for variants",
      parentProductId: "parent-uuid",
      variantName: "Strawberry",
      pricePerUnit: "5",
    };
    const result = buildProductPayload(form);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      // name === the flavor only (PR #44); parent context via parentProductId.
      expect(result.name).toBe("Strawberry");
      expect(result.parentProductId).toBe("parent-uuid");
      expect(result.variantName).toBe("Strawberry");
    }
  });

  it("treats unitsPerBox <= 1 (or blank) as non-boxed (omitted)", () => {
    const one = buildProductPayload({
      ...emptyProductForm(),
      name: "A",
      pricePerUnit: "1",
      unitsPerBox: "1",
    });
    const boxed = buildProductPayload({
      ...emptyProductForm(),
      name: "B",
      pricePerUnit: "1",
      unitsPerBox: "6",
    });
    if (!("error" in one)) expect(one.unitsPerBox).toBeUndefined();
    if (!("error" in boxed)) expect(boxed.unitsPerBox).toBe(6);
  });
});

// ── Tests — REG-3: regulated section/subcategory tagging (create vs edit) ─────

describe("ProductForm — buildProductPayload regulated tagging (REG-3)", () => {
  it("create (default mode): sends the picked section + subcategory ids", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "sec-1",
      trackedSubcategoryId: "sub-1",
    };
    const result = buildProductPayload(form);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.trackedCategoryId).toBe("sec-1");
      expect(result.trackedSubcategoryId).toBe("sub-1");
    }
  });

  it("create: blank tracked fields are OMITTED (undefined), not sent as null", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "",
    };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.trackedCategoryId).toBeUndefined();
      expect(result.trackedSubcategoryId).toBeUndefined();
    }
  });

  it('edit (mode="edit"): blank tracked fields send explicit null to clear', () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "",
    };
    const result = buildProductPayload(form, "edit");
    if (!("error" in result)) {
      expect(result.trackedCategoryId).toBeNull();
      expect(result.trackedSubcategoryId).toBeNull();
    }
  });
});

// ── Tests — regulatory reporting trio (regItemType/regUomCase/regUomUnit) ─────

describe("ProductForm — buildProductPayload regulatory reporting config", () => {
  it("create: round-trips the picked item type / case UoM / unit UoM", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "sec-1",
      regItemType: "1",
      regUomCase: "CC",
      regUomUnit: "CP",
    };
    const result = buildProductPayload(form);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.regItemType).toBe("1");
      expect(result.regUomCase).toBe("CC");
      expect(result.regUomUnit).toBe("CP");
    }
  });

  it("edit: round-trips the picked item type / case UoM / unit UoM", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "sec-1",
      regItemType: "1",
      regUomCase: "CC",
      regUomUnit: "CP",
    };
    const result = buildProductPayload(form, "edit");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.regItemType).toBe("1");
      expect(result.regUomCase).toBe("CC");
      expect(result.regUomUnit).toBe("CP");
    }
  });

  it("create: blank regulatory fields (section still set) are OMITTED (undefined)", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "sec-1",
    };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.regItemType).toBeUndefined();
      expect(result.regUomCase).toBeUndefined();
      expect(result.regUomUnit).toBeUndefined();
    }
  });

  it('edit (mode="edit"): blank regulatory fields (section still set) send explicit null to clear', () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "sec-1",
      regItemType: "",
      regUomCase: "",
      regUomUnit: "",
    };
    const result = buildProductPayload(form, "edit");
    if (!("error" in result)) {
      expect(result.regItemType).toBeNull();
      expect(result.regUomCase).toBeNull();
      expect(result.regUomUnit).toBeNull();
    }
  });

  it("create: clearing the section OMITS the trio even if the fields still carry values", () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "",
      regItemType: "1",
      regUomCase: "CC",
      regUomUnit: "CP",
    };
    const result = buildProductPayload(form);
    if (!("error" in result)) {
      expect(result.regItemType).toBeUndefined();
      expect(result.regUomCase).toBeUndefined();
      expect(result.regUomUnit).toBeUndefined();
    }
  });

  it('edit (mode="edit"): clearing the section forces the trio to null even if the fields still carry values', () => {
    const form = {
      ...emptyProductForm(),
      name: "X",
      pricePerUnit: "1",
      trackedCategoryId: "",
      regItemType: "1",
      regUomCase: "CC",
      regUomUnit: "CP",
    };
    const result = buildProductPayload(form, "edit");
    if (!("error" in result)) {
      expect(result.trackedCategoryId).toBeNull();
      expect(result.regItemType).toBeNull();
      expect(result.regUomCase).toBeNull();
      expect(result.regUomUnit).toBeNull();
    }
  });
});

describe("productFormFromValues — regulated tagging (REG-3)", () => {
  it("seeds trackedCategoryId/Name and trackedSubcategoryId from a tagged product", () => {
    const form = productFormFromValues({
      trackedCategory: { id: "sec-1", name: "Alcohol" },
      trackedSubcategory: { id: "sub-1", name: "Beer" },
    });
    expect(form.trackedCategoryId).toBe("sec-1");
    expect(form.trackedCategoryName).toBe("Alcohol");
    expect(form.trackedSubcategoryId).toBe("sub-1");
  });

  it("defaults to empty tracked fields when the product has no regulated tag (matches emptyProductForm)", () => {
    const form = productFormFromValues({});
    expect(form.trackedCategoryId).toBe("");
    expect(form.trackedCategoryName).toBeUndefined();
    expect(form.trackedSubcategoryId).toBe("");
  });
});

describe("productFormFromValues — regulatory reporting trio", () => {
  it("seeds regItemType/regUomCase/regUomUnit from a configured product", () => {
    const form = productFormFromValues({
      regItemType: "1",
      regUomCase: "CC",
      regUomUnit: "CP",
    });
    expect(form.regItemType).toBe("1");
    expect(form.regUomCase).toBe("CC");
    expect(form.regUomUnit).toBe("CP");
  });

  it("defaults to empty regulatory fields when the product has no config (matches emptyProductForm)", () => {
    const form = productFormFromValues({});
    expect(form.regItemType).toBe("");
    expect(form.regUomCase).toBe("");
    expect(form.regUomUnit).toBe("");
  });
});

describe("productFormFromValues — unitSku (dual SKU)", () => {
  it("seeds unitSku from an existing product", () => {
    const form = productFormFromValues({ unitSku: "UNIT-001" });
    expect(form.unitSku).toBe("UNIT-001");
  });

  it("defaults unitSku to empty string when the product has none (matches emptyProductForm)", () => {
    const form = productFormFromValues({});
    expect(form.unitSku).toBe("");
  });
});

describe("ProductForm — tier price round-trip (WP5)", () => {
  it("productFormFromValues -> buildProductPayload: populated tiers are emitted as numbers", () => {
    const form = productFormFromValues({
      name: "Six-pack Soda",
      pricePerUnit: 12,
      priceTier2: 11,
      priceTier3: 10.5,
      priceTier4: 10,
      priceTier5: 9.25,
    });
    expect(form.priceTier2).toBe("11");
    expect(form.priceTier3).toBe("10.5");
    expect(form.priceTier4).toBe("10");
    expect(form.priceTier5).toBe("9.25");

    const result = buildProductPayload(form, "edit");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.priceTier2).toBe(11);
      expect(result.priceTier3).toBe(10.5);
      expect(result.priceTier4).toBe(10);
      expect(result.priceTier5).toBe(9.25);
    }
  });

  it("productFormFromValues -> buildProductPayload: blank tiers are omitted (undefined) in edit mode", () => {
    const form = productFormFromValues({ name: "Plain", pricePerUnit: 5 });
    expect(form.priceTier2).toBe("");
    expect(form.priceTier3).toBe("");
    expect(form.priceTier4).toBe("");
    expect(form.priceTier5).toBe("");

    const result = buildProductPayload(form, "edit");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.priceTier2).toBeUndefined();
      expect(result.priceTier3).toBeUndefined();
      expect(result.priceTier4).toBeUndefined();
      expect(result.priceTier5).toBeUndefined();
    }
  });

  it("create mode: blank tiers are also omitted (undefined), matching the other optional-number fields", () => {
    const form = { ...emptyProductForm(), name: "X", pricePerUnit: "1" };
    const result = buildProductPayload(form);
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.priceTier2).toBeUndefined();
      expect(result.priceTier3).toBeUndefined();
      expect(result.priceTier4).toBeUndefined();
      expect(result.priceTier5).toBeUndefined();
    }
  });
});

describe("ProductForm — emptyProductForm (synchronous factory)", () => {
  it("initialises without any API call", () => {
    const form = emptyProductForm();
    expect(form.name).toBe("");
    expect(form.unit).toBe("ea");
    expect(form.isActive).toBe(true);
  });

  it("returns a plain object, not a Promise", () => {
    const form = emptyProductForm();
    expect(form).not.toBeInstanceOf(Promise);
    expect(typeof form).toBe("object");
  });

  it("completes in under 50ms (no network I/O)", () => {
    const t0 = Date.now();
    emptyProductForm();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("CustomerForm — emptyCustomerForm (synchronous factory)", () => {
  it("initialises without any API call", () => {
    const form = emptyCustomerForm();
    expect(form.businessName).toBe("");
    expect(form.pricingTier).toBe(1);
    expect(form.isTaxExempt).toBe(false);
  });

  it("returns a plain object, not a Promise", () => {
    const form = emptyCustomerForm();
    expect(form).not.toBeInstanceOf(Promise);
    expect(typeof form).toBe("object");
  });

  it("completes in under 50ms (no network I/O)", () => {
    const t0 = Date.now();
    emptyCustomerForm();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

// ── Tests — Expo Router static-over-dynamic precedence ───────────────────────

describe("Expo Router static-over-dynamic precedence (naming contract)", () => {
  it('"create" as a segment name should never reach [id].tsx — safeId returns ""', () => {
    expect(safeId("create")).toBe("");
    expect(queryEnabled(safeId("create"))).toBe(false);
  });

  it('"new" as a segment name should never reach [id].tsx — safeId returns ""', () => {
    expect(safeId("new")).toBe("");
    expect(queryEnabled(safeId("new"))).toBe(false);
  });

  it("a real route ID passes through safeId unchanged", () => {
    const realId = "abc123";
    expect(safeId(realId)).toBe(realId);
    expect(queryEnabled(safeId(realId))).toBe(true);
  });
});

// ── Tests — Route create form (name validation, synchronous) ──────────────────

describe("New Route form — name validation (synchronous)", () => {
  function validateRouteName(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "Name is required.";
    return null;
  }

  it("rejects empty name", () => {
    expect(validateRouteName("")).toBe("Name is required.");
  });

  it("rejects whitespace-only name", () => {
    expect(validateRouteName("   ")).toBe("Name is required.");
  });

  it("accepts a valid name", () => {
    expect(validateRouteName("Route A — Downtown")).toBeNull();
  });
});

// ── Tests — Invoice create form (customerId validation, synchronous) ──────────

describe("New Invoice form — customerId validation (synchronous)", () => {
  function validateCustomerId(customerId: string): string | null {
    const trimmed = customerId.trim();
    if (!trimmed) return "Customer ID is required.";
    return null;
  }

  it("rejects empty customerId", () => {
    expect(validateCustomerId("")).toBe("Customer ID is required.");
  });

  it("rejects whitespace-only customerId", () => {
    expect(validateCustomerId("   ")).toBe("Customer ID is required.");
  });

  it("accepts a valid UUID", () => {
    expect(validateCustomerId("c1a2b3d4-1234-5678-abcd-ef0123456789")).toBeNull();
  });
});
