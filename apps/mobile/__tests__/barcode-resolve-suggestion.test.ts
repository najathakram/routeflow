/**
 * B1220 — a lone FUZZY (name/SKU substring) search match is a suggestion, never an auto-add hit.
 * Exact code hits are unchanged.
 */
jest.mock("../lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

import { apiClient } from "../lib/api-client";
import { resolveProductByCode } from "../lib/barcode-resolve";

const get = apiClient.get as jest.Mock;
const notFound404 = { response: { status: 404 } };

describe("resolveProductByCode — suggestion (B1220)", () => {
  beforeEach(() => get.mockReset());

  it("a lone fuzzy match is a suggestion, not a plain hit", async () => {
    const p = { id: "p1", name: "Blue Widget", sku: "BW-100", isActive: true };
    get.mockRejectedValueOnce(notFound404).mockResolvedValueOnce({ data: { data: [p] } });
    const r: any = await resolveProductByCode("widget");
    expect(r).toEqual({
      product: p,
      source: "search",
      ambiguous: true,
      suggestion: true,
      matches: [p],
    });
  });

  it("an exact barcode hit stays a plain hit", async () => {
    const p = { id: "p1", name: "Blue Widget", isActive: true };
    get.mockResolvedValueOnce({ data: p });
    expect(await resolveProductByCode("123")).toEqual({ product: p, source: "barcode" });
  });

  it("an exact SKU hit on the search rung stays a plain hit", async () => {
    const p = { id: "p1", name: "Blue Widget", sku: "BW-100", isActive: true };
    get.mockRejectedValueOnce(notFound404).mockResolvedValueOnce({ data: { data: [p] } });
    expect(await resolveProductByCode("bw-100")).toEqual({ product: p, source: "sku" });
  });

  it("several fuzzy matches keep the existing ambiguous shape (no suggestion flag)", async () => {
    const a = { id: "a", name: "Widget A", isActive: true };
    const b = { id: "b", name: "Widget B", isActive: true };
    get.mockRejectedValueOnce(notFound404).mockResolvedValueOnce({ data: { data: [a, b] } });
    const r: any = await resolveProductByCode("widget");
    expect(r).toEqual({ product: a, source: "search", ambiguous: true, matches: [a, b] });
    expect(r.suggestion).toBeUndefined();
  });

  it("no match is notFound", async () => {
    get.mockRejectedValueOnce(notFound404).mockResolvedValueOnce({ data: { data: [] } });
    expect(await resolveProductByCode("zzz")).toEqual({ notFound: true });
  });
});
