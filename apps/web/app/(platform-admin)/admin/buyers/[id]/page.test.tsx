/**
 * UX guide B21: the buyer page showed the placeholder "Check DB" as if it were data. It now says whether a
 * Google account is linked, from the API's boolean (the provider's id is never sent to the browser).
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import BuyerDetailPage from "./page";

const mockGet = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "b1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const buyer = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  email: "pat@example.test",
  name: "Pat",
  phone: null,
  mobile: null,
  status: "ACTIVE",
  emailVerified: true,
  googleLinked: false,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  customerLinks: [],
  ...over,
});

describe("UX guide B21 buyer Google account row", () => {
  it("never renders the placeholder 'Check DB'", async () => {
    mockGet.mockResolvedValue({ data: buyer() });
    render(<BuyerDetailPage />);
    await screen.findByText("Google account");
    expect(screen.queryByText("Check DB")).toBeNull();
  });

  it("says Not linked for an email buyer and Linked for a Google buyer", async () => {
    mockGet.mockResolvedValue({ data: buyer() });
    const { unmount } = render(<BuyerDetailPage />);
    const label = await screen.findByText("Google account");
    expect(label.nextElementSibling).toHaveTextContent("Not linked");
    unmount();

    mockGet.mockResolvedValue({ data: buyer({ googleLinked: true }) });
    render(<BuyerDetailPage />);
    const label2 = await screen.findByText("Google account");
    expect(label2.nextElementSibling).toHaveTextContent("Linked");
    expect(label2.nextElementSibling).not.toHaveTextContent("Not linked");
  });
});
