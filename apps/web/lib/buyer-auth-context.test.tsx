import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BUYER_KEYS } from "./auth-keys";
import type { BuyerSeller } from "./buyer-auth";

// getStoredBuyer/getBuyerAccessToken are stubbed so the provider takes the
// stored-session branch without a JWT; the localStorage helpers
// (getStoredActiveSeller / storeActiveSeller / clearActiveSeller) stay REAL so
// the stored copy can be asserted directly.
jest.mock("@/lib/buyer-auth", () => ({
  ...jest.requireActual("@/lib/buyer-auth"),
  getStoredBuyer: () => ({ id: "b1", email: "buyer@example.com", name: "Buyer One" }),
  getBuyerAccessToken: () => "buyer-access-token",
  getBuyerSellers: jest.fn(),
}));

import { getBuyerSellers } from "@/lib/buyer-auth";
import { BuyerAuthProvider, useBuyerAuth } from "./buyer-auth-context";

function makeSeller(linkId: string, slug: string): BuyerSeller {
  return {
    linkId,
    linkStatus: "ACTIVE",
    tenant: { id: `t-${slug}`, slug, name: slug, logoKey: null, primaryColor: null },
    customer: { id: `c-${slug}`, businessName: `${slug} customer`, email: null },
  };
}

let switchTarget: BuyerSeller | null = null;

function ActiveSellerProbe() {
  const { activeSeller, refreshSellers, setActiveSeller } = useBuyerAuth();
  return (
    <div>
      <div data-testid="active-seller">{activeSeller?.linkId ?? "none"}</div>
      <button type="button" onClick={() => switchTarget && setActiveSeller(switchTarget)}>
        switch
      </button>
      <button type="button" onClick={() => void refreshSellers()}>
        refresh
      </button>
    </div>
  );
}

const testQueryClient = new QueryClient();

function renderProvider() {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <BuyerAuthProvider>
        <ActiveSellerProbe />
      </BuyerAuthProvider>
    </QueryClientProvider>,
  );
}

describe("BuyerAuthProvider — activeSeller reconciliation (B141)", () => {
  const removed = makeSeller("link-removed", "acme");
  const other = makeSeller("link-other", "globex");
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  it("REG-B141 W1: drops a stored activeSeller that the fetched sellers list no longer contains", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(removed));
    (getBuyerSellers as jest.Mock).mockResolvedValue([other]);

    renderProvider();

    // First test in the file pays the cold module-compile cost.
    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("none"), {
      timeout: 15_000,
    });
    expect(localStorage.getItem(BUYER_KEYS.activeSeller)).toBeNull();
  });

  it("B141 W2: keeps a stored activeSeller that is still in the fetched sellers list", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(removed));
    (getBuyerSellers as jest.Mock).mockResolvedValue([removed, other]);

    renderProvider();

    await waitFor(() => expect(getBuyerSellers).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("active-seller")).toHaveTextContent("link-removed"),
    );
    expect(localStorage.getItem(BUYER_KEYS.activeSeller)).not.toBeNull();
  });

  it("B141 W3: keeps the stored activeSeller when the sellers fetch fails", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(removed));
    (getBuyerSellers as jest.Mock).mockRejectedValue(new Error("network down"));

    renderProvider();

    await waitFor(() => expect(getBuyerSellers).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("active-seller")).toHaveTextContent("link-removed"),
    );
    expect(localStorage.getItem(BUYER_KEYS.activeSeller)).not.toBeNull();
  });

  it("REG-B141 W4: drops the activeSeller when refreshSellers() returns a list without it", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(removed));
    (getBuyerSellers as jest.Mock).mockResolvedValueOnce([removed, other]);

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("active-seller")).toHaveTextContent("link-removed"),
    );

    // The seller removes this buyer's customer record while the tab is open.
    (getBuyerSellers as jest.Mock).mockResolvedValueOnce([other]);
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("none"));
    expect(localStorage.getItem(BUYER_KEYS.activeSeller)).toBeNull();
  });

  it("B141 W5: keeps the activeSeller when refreshSellers() still returns it", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(removed));
    (getBuyerSellers as jest.Mock).mockResolvedValue([removed, other]);

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("active-seller")).toHaveTextContent("link-removed"),
    );

    await userEvent.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => expect(getBuyerSellers).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("active-seller")).toHaveTextContent("link-removed");
    expect(localStorage.getItem(BUYER_KEYS.activeSeller)).not.toBeNull();
  });
});

describe("BuyerAuthProvider: clears cached buyer data on seller switch", () => {
  const sellerA = makeSeller("link-a", "acme");
  const sellerB = makeSeller("link-b", "globex");

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    testQueryClient.clear();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("clears cached buyer data on seller switch", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(sellerA));
    (getBuyerSellers as jest.Mock).mockResolvedValue([sellerA, sellerB]);
    testQueryClient.setQueryData(["buyer", "dashboard"], { seller: "A" });
    switchTarget = sellerB;

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("link-a"));
    expect(testQueryClient.getQueryData(["buyer", "dashboard"])).toEqual({ seller: "A" });

    await userEvent.click(screen.getByRole("button", { name: "switch" }));

    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("link-b"));
    expect(testQueryClient.getQueryData(["buyer", "dashboard"])).toBeUndefined();
  });

  it("clears cached buyer data when the active seller is dropped", async () => {
    localStorage.setItem(BUYER_KEYS.activeSeller, JSON.stringify(sellerA));
    (getBuyerSellers as jest.Mock).mockResolvedValueOnce([sellerA, sellerB]);
    testQueryClient.setQueryData(["buyer", "dashboard"], { seller: "A" });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("link-a"));

    (getBuyerSellers as jest.Mock).mockResolvedValueOnce([sellerB]);
    await userEvent.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => expect(screen.getByTestId("active-seller")).toHaveTextContent("none"));
    expect(testQueryClient.getQueryData(["buyer", "dashboard"])).toBeUndefined();
  });
});
