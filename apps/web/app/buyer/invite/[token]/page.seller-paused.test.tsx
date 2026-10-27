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
let mockSignedIn = false;
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: null,
    isLoading: false,
    isAuthenticated: mockSignedIn,
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
  beforeEach(() => {
    mockSignedIn = false;
  });

  it("403 SELLER_UNAVAILABLE reads as not available right now, never 'Invalid invite'", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x" }),
    );
    render(<BuyerInvitePage />);
    expect(await screen.findByText("Not available right now")).toBeInTheDocument();
    expect(screen.getByText(/isn't taking online orders right now/)).toBeInTheDocument();
    expect(screen.queryByText("Invalid invite")).toBeNull();
  });

  it("names the seller from the 403 body, and says the neutral sentence when no name came", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x", sellerName: "Acme Foods" }),
    );
    const named = render(<BuyerInvitePage />);
    expect(
      await screen.findByText(
        "Acme Foods isn't taking online orders right now. Please check back soon or contact them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme Foods is not available right now")).toBeInTheDocument();
    named.unmount();
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x" }),
    );
    render(<BuyerInvitePage />);
    expect(
      await screen.findByText(/^This seller isn't taking online orders right now/),
    ).toBeInTheDocument();
  });

  it("says the invite still works, with a neutral pause icon (not the red alert)", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x" }),
    );
    const { container } = render(<BuyerInvitePage />);
    expect(
      await screen.findByText("Your invite still works. Open this link again once they're back."),
    ).toBeInTheDocument();
    expect(container.querySelector("svg.text-danger")).toBeNull();
  });

  it("signed out: no 'Go to your portal'; signed in: it is offered", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(403, { code: "SELLER_UNAVAILABLE", message: "x" }),
    );
    const out = render(<BuyerInvitePage />);
    await screen.findByText("Not available right now");
    expect(screen.queryByText("Go to your portal")).toBeNull();
    out.unmount();
    mockSignedIn = true;
    render(<BuyerInvitePage />);
    expect(await screen.findByText("Go to your portal")).toBeInTheDocument();
  });

  it("control: an expired or unknown invite still reads Invalid invite with the server's message", async () => {
    mockGetInviteDetails.mockRejectedValue(
      refusal(410, { message: "This invite link has expired" }),
    );
    render(<BuyerInvitePage />);
    await waitFor(() => expect(screen.getByText("Invalid invite")).toBeInTheDocument());
    expect(screen.getByText("This invite link has expired")).toBeInTheDocument();
    expect(screen.getByText("Go to your portal")).toBeInTheDocument(); // unchanged, even signed out
    expect(screen.queryByText(/invite still works/)).toBeNull();
  });
});
