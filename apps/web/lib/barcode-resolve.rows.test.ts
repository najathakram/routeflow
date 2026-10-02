/**
 * #2717 M4a-1: the web search rung must also recognise ProductBarcode row codes carried on the
 * list's additive `barcodes[]` (M1), the way it already recognises exact sku / unitSku — and the
 * result keeps the product's scanMatch/barcodes untouched for the handler.
 * RED (M4a-1): today the search rung ignores barcodes[], so two substring hits come back `ambiguous`.
 */
import { resolveProductByCode } from "./barcode-resolve";

const mockGet = jest.fn();
jest.mock("./api-client", () => ({ apiClient: { get: (...a: unknown[]) => mockGet(...a) } }));

const notFound = () => Promise.reject({ response: { status: 404 } });

describe("resolveProductByCode — row codes on the search rung", () => {
  beforeEach(() => jest.clearAllMocks());

  it("an exact ProductBarcode row code on ONE listed product resolves it (not ambiguous)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.startsWith("/products/barcode/")
        ? notFound()
        : Promise.resolve({
            data: {
              data: [
                {
                  id: "p1",
                  name: "Alpha 6-pack",
                  sku: "A-6",
                  isActive: true,
                  barcodes: [{ code: "ROW-X", level: "UNIT" }],
                },
                { id: "p2", name: "Alpha ROW-X special", sku: "B-6", isActive: true, barcodes: [] },
              ],
            },
          }),
    );
    const r: any = await resolveProductByCode("ROW-X");
    expect(r.ambiguous).toBeFalsy();
    expect(r.product?.id).toBe("p1");
  });

  it("the barcode rung's product comes back with its barcodes[] and scanMatch intact", async () => {
    const product = {
      id: "p1",
      isActive: true,
      barcodes: [{ code: "ROW-X", level: "UNIT" }],
      scanMatch: { code: "ROW-X", levels: ["UNIT"] },
    };
    mockGet.mockResolvedValue({ data: product });
    const r: any = await resolveProductByCode("ROW-X");
    expect(r.product.scanMatch).toEqual({ code: "ROW-X", levels: ["UNIT"] });
    expect(r.product.barcodes).toHaveLength(1);
    expect(r.source).toBe("barcode");
  });
});
