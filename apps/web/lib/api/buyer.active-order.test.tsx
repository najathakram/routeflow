/**
 * `useBuyerActiveOrder(path)`: the banner's read is scoped to the buyer's chosen fulfilment path
 * (the server's merge search is), so a different-path active order is never offered as a merge.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { useBuyerActiveOrder } from "./buyer";

jest.mock("@/lib/buyer-api-client", () => ({ buyerApiClient: { get: jest.fn() } }));
const get = buyerApiClient.get as jest.Mock;

function run(path?: string) {
  const client = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBuyerActiveOrder(path), { wrapper });
}

beforeEach(() => get.mockReset().mockResolvedValue({ data: null }));

describe("useBuyerActiveOrder", () => {
  it("sends the chosen path as fulfillPath", async () => {
    const { result } = run("SHIP");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/buyer/orders/active", { params: { fulfillPath: "SHIP" } });
  });

  it("no path: the request carries no params (today's read)", async () => {
    const { result } = run(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/buyer/orders/active", undefined);
  });
});
