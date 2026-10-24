/** B1220 — a confirmed suggestion or picked row takes the same standaloneOnly → parent branch. */
import { readFileSync } from "fs";
import { join } from "path";
import { resolvePickedProduct } from "../lib/picker-select";

describe("resolvePickedProduct", () => {
  type P = { id: string; parentProductId?: string | null };
  const variant: P = { id: "v1", parentProductId: "par" };
  const parent: P = { id: "par", parentProductId: null };
  const fetchParent = jest.fn(async (_id: string): Promise<P | null> => parent);

  beforeEach(() => fetchParent.mockClear());

  it("variant in a parent-only picker resolves to the parent", async () => {
    const r = await resolvePickedProduct(variant, { standaloneOnly: true, fetchParent });
    expect(r).toEqual({ product: parent, resolvedToParent: true });
    expect(fetchParent).toHaveBeenCalledWith("par");
  });
  it("variant in an ordinary picker is picked as-is", async () => {
    const r = await resolvePickedProduct(variant, { standaloneOnly: false, fetchParent });
    expect(r?.product).toBe(variant);
    expect(fetchParent).not.toHaveBeenCalled();
  });
  it("standalone product is picked as-is even in a parent-only picker", async () => {
    const r = await resolvePickedProduct(parent, { standaloneOnly: true, fetchParent });
    expect(r?.product).toBe(parent);
  });
  it("a parent that cannot be loaded picks nothing", async () => {
    const r = await resolvePickedProduct(variant, {
      standaloneOnly: true,
      fetchParent: async () => null,
    });
    expect(r).toBeNull();
  });
});

describe("ProductPickerSheet wiring", () => {
  const src = readFileSync(join(__dirname, "..", "components", "ProductPickerSheet.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  it("every commit path goes through resolvePickedProduct", () => {
    expect(src).toMatch(/resolvePickedProduct\(/);
    // the raw `pick(` is only invoked from the single commit helper
    const callsToPick = (src.match(/\bpick\(/g) ?? []).length;
    expect(callsToPick).toBe(0);
    expect(src).toMatch(/commitPick\(/);
  });
});
