import * as fs from "fs";
import * as path from "path";
import {
  deactivateFailureToast,
  getReactivationRefusal,
  reactivationResolveLabel,
} from "./product-reactivation-refusal";

const err = (data: unknown) => ({ response: { status: 409, data } });
const holder = (over: Record<string, unknown> = {}) => ({
  code: "CODE_TAKEN",
  field: "sku",
  value: "COLA-6",
  productId: "h1",
  productName: "Cola 6pk",
  ...over,
});

describe("getReactivationRefusal — maps the 409 by code+field, never by the server message", () => {
  it("CODE_TAKEN sku -> the approved copy", () => {
    const r = getReactivationRefusal(err({ ...holder(), message: "RAW SERVER TEXT" }));
    expect(r).toMatchObject({ kind: "HOLDERS", canResolve: true, holderIds: ["h1"] });
    expect(r && r.kind === "HOLDERS" && r.holders[0].line).toBe(
      `Can't reactivate: the SKU "COLA-6" is now used by Cola 6pk. Change it on that product, or give this one a new SKU.`,
    );
  });

  it.each([
    ["unitSku", "the unit code", "a new unit code"],
    ["barcode", "the barcode", "a new barcode"],
  ])("%s wording", (field, what, fix) => {
    const code = field === "barcode" ? "BARCODE_TAKEN" : "CODE_TAKEN";
    const r = getReactivationRefusal(err(holder({ code, field, value: "X1" })));
    const line = r && r.kind === "HOLDERS" ? r.holders[0].line : "";
    expect(line).toBe(
      `Can't reactivate: ${what} "X1" is now used by Cola 6pk. Change it on that product, or give this one ${fix}.`,
    );
  });

  it("NAME_TAKEN -> a rename line, no field/value needed", () => {
    const r = getReactivationRefusal(
      err({
        code: "NAME_TAKEN",
        field: "name",
        value: "Cola 6pk",
        productId: "h9",
        productName: "Cola 6pk",
      }),
    );
    expect(r && r.kind === "HOLDERS" && r.holders[0].line).toBe(
      `Can't reactivate: an active product is already named "Cola 6pk". Rename one of them first.`,
    );
  });

  it("NAME_TAKEN without productId: a line naming the value, no holder to link, no one-call resolve", () => {
    const r = getReactivationRefusal(
      err({ code: "NAME_TAKEN", field: "name", value: "Cola 6pk", message: "RAW" }),
    );
    expect(r).toEqual({
      kind: "HOLDERS",
      holders: [
        {
          productId: "",
          productName: "",
          line: `Can't reactivate: an active product is already named "Cola 6pk". Rename one of them first.`,
          blocked: false,
        },
      ],
      holderIds: [],
      canResolve: false,
    });
  });

  it('an empty-string productId is never a holder: no resolve button can carry [""]', () => {
    const r = getReactivationRefusal(
      err({ ...holder({ productId: "" }), holders: [holder({ productId: "" })] }),
    );
    expect(r).toBeNull(); // a CODE_TAKEN with nothing to name
    const name = getReactivationRefusal(
      err({ code: "NAME_TAKEN", field: "name", value: "Cola", productId: "", productName: "Cola" }),
    );
    expect(name).toMatchObject({ kind: "HOLDERS", holderIds: [], canResolve: false });
  });

  it("a code clash with no productId stays null (nothing to name, generic toast)", () => {
    expect(
      getReactivationRefusal(err({ code: "CODE_TAKEN", field: "sku", value: "x" })),
    ).toBeNull();
  });

  it("holders[] is the full set: every holder gets a line, holderIds is exactly their ids (deduped)", () => {
    const r = getReactivationRefusal(
      err({
        ...holder(),
        holders: [
          holder(),
          holder({ field: "unitSku", value: "U1", productId: "h2", productName: "Cola single" }),
          holder({ field: "barcode", code: "BARCODE_TAKEN", value: "B1" }),
        ],
      }),
    );
    expect(r).toMatchObject({ kind: "HOLDERS", holderIds: ["h1", "h2"], canResolve: true });
    expect(r && r.kind === "HOLDERS" && r.holders).toHaveLength(3);
  });

  it("flat keys only (no holders[]) still yield one holder", () => {
    const r = getReactivationRefusal(err(holder()));
    expect(r).toMatchObject({ kind: "HOLDERS", holderIds: ["h1"] });
  });

  it("any holder blocked:HAS_ACTIVE_VARIANTS -> no one-call resolve", () => {
    const r = getReactivationRefusal(
      err({
        ...holder(),
        holders: [holder(), holder({ productId: "h2", blocked: "HAS_ACTIVE_VARIANTS" })],
      }),
    );
    expect(r).toMatchObject({ kind: "HOLDERS", canResolve: false });
  });

  it("the stale-holder-set code -> the retry kind", () => {
    expect(
      getReactivationRefusal(err({ code: "HOLDERS_CHANGED", message: "x", holders: [] })),
    ).toEqual({
      kind: "RETRY",
    });
  });

  it.each([
    ["an unrelated 409", err({ code: "SOMETHING_ELSE", message: "no" })],
    ["a 500", { response: { status: 500, data: { message: "boom" } } }],
    ["a network error", new Error("Network Error")],
    ["null", null],
  ])("%s -> null (caller shows a generic toast)", (_n, e) => {
    expect(getReactivationRefusal(e)).toBeNull();
  });

  it("product names are returned as plain strings (rendering escapes them)", () => {
    const r = getReactivationRefusal(
      err(holder({ productName: `<img src=x onerror=alert(1)> "A"` })),
    );
    expect(r && r.kind === "HOLDERS" && r.holders[0].productName).toBe(
      `<img src=x onerror=alert(1)> "A"`,
    );
  });
});

describe("reactivationResolveLabel", () => {
  it("1 holder -> by name; 2 -> 'A and B'; 3+ -> a count", () => {
    expect(reactivationResolveLabel(["Cola 6pk"])).toBe(
      'Deactivate "Cola 6pk" and reactivate this',
    );
    expect(reactivationResolveLabel(["A", "B"])).toBe('Deactivate "A" and "B" and reactivate this');
    expect(reactivationResolveLabel(["A", "B", "C"])).toBe(
      "Deactivate 3 products and reactivate this",
    );
  });
});

describe("deactivateFailureToast — CODES_CHANGED on the deactivate/delete paths (#2860)", () => {
  it("CODES_CHANGED -> the fixed retry sentence, never the server message", () => {
    const t = deactivateFailureToast(
      err({ code: "CODES_CHANGED", message: "RAW SERVER TEXT" }),
      "Failed to delete product",
    );
    expect(t).toEqual({
      title: "Failed to delete product",
      description: "Someone changed this product's codes at the same time. Refresh and try again.",
      variant: "error",
    });
  });

  it("CATALOG_TOO_LARGE_FOR_CLEAR_ALL (clear-all and bulk delete above the lock cap) -> the fixed select-fewer sentence", () => {
    const t = deactivateFailureToast(
      err({ code: "CATALOG_TOO_LARGE_FOR_CLEAR_ALL", message: "RAW SERVER TEXT" }),
      "Failed to delete products",
    );
    expect(t).toEqual({
      title: "Failed to delete products",
      description: "Too many products to remove at once. Select fewer and try again.",
      variant: "error",
    });
  });

  it.each([
    ["another 409", err({ code: "CODE_TAKEN", message: "RAW" })],
    ["a 500", { response: { status: 500, data: { message: "boom" } } }],
    ["a network error", new Error("Network Error")],
    ["null", null],
  ])("%s -> just the title, no server text", (_n, e) => {
    const t = deactivateFailureToast(e, "Couldn't deactivate this product");
    expect(t).toEqual({ title: "Couldn't deactivate this product", variant: "error" });
  });
});

describe("the deactivate / delete call sites use deactivateFailureToast (source pin)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

  it("product detail: Delete (header + variant Deactivate live in useReactivateFlow)", () => {
    const src = read("../app/(dashboard)/products/[id]/page.tsx");
    expect((src.match(/deactivateFailureToast\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(read("../app/(dashboard)/products/[id]/useReactivateFlow.tsx")).toMatch(
      /deactivateFailureToast\(/,
    );
  });
  it("products list: bulk delete", () => {
    expect(read("../app/(dashboard)/products/page.tsx")).toMatch(/deactivateFailureToast\(/);
  });
});
