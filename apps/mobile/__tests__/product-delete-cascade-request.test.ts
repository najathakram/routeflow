const del = jest.fn();
let captured: { mutationFn: (arg: unknown) => Promise<unknown> } | undefined;

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: (opts: typeof captured) => {
    captured = opts;
    return {};
  },
  useQuery: jest.fn(),
  useInfiniteQuery: jest.fn(),
}));
jest.mock("../lib/api-client", () => ({
  apiClient: { delete: (...a: unknown[]) => del(...a), get: jest.fn(), patch: jest.fn() },
}));

import { useDeleteProduct } from "../lib/api/products";

describe("useDeleteProduct resend with confirmCascade", () => {
  beforeEach(() => del.mockReset().mockResolvedValue({ data: {} }));

  it("a plain id deletes without the flag; the confirmed resend carries confirmCascade=true", async () => {
    useDeleteProduct();
    await captured!.mutationFn("p1");
    expect(del).toHaveBeenLastCalledWith("/products/p1", undefined);
    await captured!.mutationFn({ id: "p1", confirmCascade: true });
    expect(del).toHaveBeenLastCalledWith("/products/p1", { params: { confirmCascade: "true" } });
  });
});
