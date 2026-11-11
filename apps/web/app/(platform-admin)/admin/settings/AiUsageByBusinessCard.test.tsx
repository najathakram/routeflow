import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AiUsageByBusinessCard } from "./AiUsageByBusinessCard";

const mockGet = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: (url: string) => mockGet(url) },
}));

const usage = (over: Record<string, unknown> = {}) => ({
  month: "2026-11",
  platformCapUsd: 10,
  businesses: [
    {
      tenantId: "t1",
      name: "Acme Foods",
      calls: 12,
      spendUsd: 10.5,
      capUsd: 10,
      percentUsed: 105,
      aiOff: false,
    },
    {
      tenantId: "t2",
      name: "Acme Bakery",
      calls: 3,
      spendUsd: 2,
      capUsd: 50,
      percentUsed: 4,
      aiOff: false,
    },
    {
      tenantId: "t3",
      name: "Acme Paused",
      calls: 0,
      spendUsd: 0,
      capUsd: 0,
      percentUsed: null,
      aiOff: true,
    },
  ],
  ...over,
});

beforeEach(() => mockGet.mockReset());

describe("AiUsageByBusinessCard", () => {
  it("asks for this UTC month and shows each business's spend, limit and percent; AI off reads as words, not $0", async () => {
    mockGet.mockResolvedValue({ data: usage() });
    render(<AiUsageByBusinessCard />);
    await screen.findByText("Acme Foods");
    expect(mockGet).toHaveBeenCalledWith(
      `/platform-admin/ai-usage/by-business?month=${new Date().toISOString().slice(0, 7)}`,
    );
    const food = within(screen.getByText("Acme Foods").closest("tr")!);
    expect(food.getByText("$10.50")).toBeTruthy();
    expect(food.getByText("$10")).toBeTruthy();
    expect(food.getByText("105%")).toBeTruthy();
    const paused = within(screen.getByText("Acme Paused").closest("tr")!);
    expect(paused.getByText("AI off")).toBeTruthy();
    expect(paused.getByText("–")).toBeTruthy();
  });

  it("changing the month asks the server for that month", async () => {
    mockGet.mockResolvedValue({ data: usage() });
    render(<AiUsageByBusinessCard />);
    await screen.findByText("Acme Foods");
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-02" } });
    await waitFor(() =>
      expect(mockGet).toHaveBeenLastCalledWith(
        "/platform-admin/ai-usage/by-business?month=2026-02",
      ),
    );
  });

  it("a failed load says so in plain words", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    render(<AiUsageByBusinessCard />);
    expect(await screen.findByText(/Couldn.t load AI use/)).toBeTruthy();
  });
});
