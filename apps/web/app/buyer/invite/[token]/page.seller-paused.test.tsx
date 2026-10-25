import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import BuyerInvitePage from "./page";

/**
 * Row 397: the invite preview of a paused seller (suspended / cancelled / read-only) answers 403 SELLER_UNAVAILABLE up
 * front. The page says so ("isn't taking online orders right now") instead of "Invalid invite"; a really invalid
 * invite still reads "Invalid invite".
 */
jest.mock("next/navigation", () => ({
  useParams: () => ({ token: "tok" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: null,
    isLoading: false,
    isAuthenticated: false,
    refreshSellers: jest.fn(),
  }),
}));
jest.mock("@/lib/in-shell", () => ({ isInShell: () => false }));
const mockGetInviteDetails = jest.fn();
jest.mock("@/lib/buyer-auth", () => ({
  getInviteDetails: (...a: unknown[]) => mockGetInviteDetails(...a),
  acceptInvite: jest.fn(),
  getBuyerAccessToken: jest.fn(),
}));

const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

describe("buyer invite page: a paused seller", () => {
  it("403 SELLER_UNAVAILABLE reads as not available right now, never 'Invalid invite'", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x" }),
    );
    render(<BuyerInvitePage />);
    expect(await screen.findByText("Not available right now")).toBeInTheDocument();
    expect(screen.getByText(/isn't taking online orders right now/)).toBeInTheDocument();
    expect(screen.queryByText("Invalid invite")).toBeNull();
  });

  it("control: an expired or unknown invite still reads Invalid invite with the server's message", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(410, { message: "This invite link has expired" }),
    );
    render(<BuyerInvitePage />);
    await waitFor(() => expect(screen.getByText("Invalid invite")).toBeInTheDocument());
    expect(screen.getByText("This invite link has expired")).toBeInTheDocument();
  });
});
