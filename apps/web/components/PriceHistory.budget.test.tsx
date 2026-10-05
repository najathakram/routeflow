import * as React from "react";
import { renderWithProviders, waitFor } from "@/test-utils/render";
import { PriceHistoryButton } from "./PriceHistory";
import { AUTO_FETCH_BUDGET } from "@/lib/api/price-history";

/**
 * A large order mounts a price-history button per line. Mount-time fetching is budgeted so one
 * order (or two operators behind one shop IP) cannot burn the 100/min API throttle: only the first
 * AUTO_FETCH_BUDGET distinct lines fetch on mount, the rest fetch when their popover opens.
 */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

describe("price-history mount-time fetch budget", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: { rows: [], summaries: [], costVisible: false } });
  });

  it("fetches for at most AUTO_FETCH_BUDGET of 12 distinct lines on mount", async () => {
    renderWithProviders(
      <ul>
        {Array.from({ length: 12 }, (_, i) => (
          <li key={i}>
            <PriceHistoryButton
              customerId="c1"
              productId={`p${i}`}
              productName={`P${i}`}
              onUsePrice={jest.fn()}
            />
          </li>
        ))}
      </ul>,
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(mockGet.mock.calls.length).toBe(AUTO_FETCH_BUDGET);
  });
});
