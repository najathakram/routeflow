/**
 * Row 541: the web apiClient has no request timeout, so a lookup that never answers blocked the order builder's FIFO
 * scan queue for good. `resolveProductByCode` takes an optional per-request deadline; callers that pass none are
 * unchanged.
 */
import { resolveProductByCode } from "./barcode-resolve";

const mockGet = jest.fn();
jest.mock("./api-client", () => ({ apiClient: { get: (...a: unknown[]) => mockGet(...a) } }));

const notFound = () => Promise.reject({ response: { status: 404 } });

describe("resolveProductByCode: the lookup deadline (row 541)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((url: string) =>
      url.startsWith("/products/barcode/") ? notFound() : Promise.resolve({ data: { data: [] } }),
    );
  });

  it("with a deadline, both rungs' requests carry it as the axios timeout", async () => {
    await resolveProductByCode("0123", { timeoutMs: 6000 });
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0][1]).toEqual({ timeout: 6000 });
    expect(mockGet.mock.calls[1][1]).toEqual(expect.objectContaining({ timeout: 6000 }));
  });

  it("without one, the requests are exactly as before (no timeout key)", async () => {
    await resolveProductByCode("0123");
    expect(mockGet.mock.calls[0]).toHaveLength(1);
    expect(mockGet.mock.calls[1][1]).not.toHaveProperty("timeout");
  });
});
