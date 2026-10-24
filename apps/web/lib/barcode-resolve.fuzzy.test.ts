/**
 * B1219: with NO exact code match (barcode / sku / unit sku / ProductBarcode row), exactly one
 * fuzzy (name / substring) hit must come back as a SUGGESTION the caller confirms, never as a
 * plain hit that gets auto-added. Exact hits, not-found and several-hit behaviour are unchanged.
 */
import { resolveProductByCode } from "./barcode-resolve";

const mockGet = jest.fn();
jest.mock("./api-client", () => ({ apiClient: { get: (...a: unknown[]) => mockGet(...a) } }));

const notFound = () => Promise.reject({ response: { status: 404 } });
const list = (rows: unknown[]) => Promise.resolve({ data: { data: rows } });
const row = (o: Record<string, unknown>) => ({ isActive: true, barcodes: [], ...o });

function stubSearch(rows: unknown[]) {
  mockGet.mockImplementation((url: string) =>
    url.startsWith("/products/barcode/") ? notFound() : list(rows),
  );
}

describe("resolveProductByCode — fuzzy single hit (B1219)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("one fuzzy hit and no exact code is a suggestion, not a plain hit", async () => {
    stubSearch([row({ id: "p1", name: "Cola 12345 Zero", sku: "COLA-Z" })]);
    const r: any = await resolveProductByCode("12345");
    expect(r.suggestion).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.product.id).toBe("p1");
    expect(r.matches).toEqual([expect.objectContaining({ id: "p1" })]);
  });

  it("an exact sku hit still auto-adds (no suggestion)", async () => {
    stubSearch([row({ id: "p1", name: "Cola", sku: "COLA-1" })]);
    const r: any = await resolveProductByCode("cola-1");
    expect(r.suggestion).toBeFalsy();
    expect(r.ambiguous).toBeFalsy();
    expect(r.source).toBe("sku");
  });

  it("an exact unit sku hit still auto-adds", async () => {
    stubSearch([row({ id: "p1", name: "Cola", sku: "C", unitSku: "COLA-U" })]);
    const r: any = await resolveProductByCode("COLA-U");
    expect(r.suggestion).toBeFalsy();
    expect(r.source).toBe("unitSku");
  });

  it("an exact ProductBarcode row hit still auto-adds", async () => {
    stubSearch([row({ id: "p1", name: "Cola", sku: "C", barcodes: [{ code: "ROW-1" }] })]);
    const r: any = await resolveProductByCode("ROW-1");
    expect(r.suggestion).toBeFalsy();
    expect(r.source).toBe("barcode");
  });

  it("an exact Product.barcode hit (barcode endpoint) still auto-adds", async () => {
    mockGet.mockResolvedValue({ data: { id: "p1", name: "Cola", isActive: true } });
    const r: any = await resolveProductByCode("0123");
    expect(r.suggestion).toBeFalsy();
    expect(r.source).toBe("barcode");
    expect(r.product.id).toBe("p1");
  });

  it("no hit at all is not-found", async () => {
    stubSearch([]);
    expect(await resolveProductByCode("nope")).toEqual({ notFound: true });
  });

  it("several fuzzy hits stay the ambiguous picker (not a suggestion)", async () => {
    stubSearch([row({ id: "p1", name: "Cola A" }), row({ id: "p2", name: "Cola B" })]);
    const r: any = await resolveProductByCode("cola");
    expect(r.ambiguous).toBe(true);
    expect(r.suggestion).toBeFalsy();
    expect(r.matches).toHaveLength(2);
  });

  it("a single ARCHIVED fuzzy hit is still archived, not a suggestion", async () => {
    stubSearch([row({ id: "p1", name: "Cola", isActive: false })]);
    const r: any = await resolveProductByCode("col");
    expect(r.archived).toBe(true);
    expect(r.suggestion).toBeFalsy();
  });
});
