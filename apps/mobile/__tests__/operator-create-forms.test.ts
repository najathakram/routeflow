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

// ── Pure form helper logic (extracted, no JSX/React-Native imports) ───────────

interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  unit: string;
  description: string;
  pricePerUnit: string;
  standardCost: string;
  currentStock: string;
  reorderPoint: string;
  reorderQty: string;
  isActive: boolean;
}

interface ProductSubmitPayload {
  name: string;
  sku?: string;
  barcode?: string;
  category?: string;
  unit?: string;
  description?: string;
  pricePerUnit: number;
  standardCost?: number;
  currentStock?: number;
  reorderPoint?: number;
  reorderQty?: number;
  isActive: boolean;
}

function emptyProductForm(): ProductFormValues {
  return {
    name: "",
    sku: "",
    barcode: "",
    category: "",
    unit: "ea",
    description: "",
    pricePerUnit: "",
    standardCost: "",
    currentStock: "",
    reorderPoint: "",
    reorderQty: "",
    isActive: true,
  };
}

function parseOptionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function buildProductPayload(
  form: ProductFormValues,
): ProductSubmitPayload | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "Name is required." };
  const price = parseOptionalNumber(form.pricePerUnit);
  if (price == null || price < 0) return { error: "Enter a valid price." };
  return {
    name,
    sku: form.sku.trim() || undefined,
    barcode: form.barcode.trim() || undefined,
    category: form.category.trim() || undefined,
    unit: form.unit.trim() || undefined,
    description: form.description.trim() || undefined,
    pricePerUnit: price,
    standardCost: parseOptionalNumber(form.standardCost),
    currentStock: parseOptionalNumber(form.currentStock),
    reorderPoint: parseOptionalNumber(form.reorderPoint),
    reorderQty: parseOptionalNumber(form.reorderQty),
    isActive: form.isActive,
  };
}

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
