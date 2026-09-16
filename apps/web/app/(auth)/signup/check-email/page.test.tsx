import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import CheckEmailPage from "./page";

// PR #778 added two branches this page previously had no coverage for: the
// account-created-but-email-failed banner driven by ?emailSent=false, and the
// resend-failed state — set whenever POST /public/tenants/resend-verification
// throws (network down) or returns non-2xx. Previously the resend button
// always claimed success even when the request itself failed.

let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

describe("CheckEmailPage — emailSent=false and resend-failed branches (PR #778)", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSearchParams = new URLSearchParams({ email: "owner@acme.com" });
  });

  it("shows the default 'we sent a verification link' copy when emailSent is absent", () => {
    renderWithProviders(<CheckEmailPage />);

    expect(screen.getByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByText(/we sent a verification link/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t send the verification email/i)).not.toBeInTheDocument();
  });

  // Fix-round visual review (PR #778): the heading must read as a problem —
  // not "Check your inbox" — when the account was created but the
  // verification email itself never went out, so the frame never contradicts
  // the danger-toned card/message underneath it.
  it("shows the failure heading + danger-toned banner when emailSent=false", () => {
    mockSearchParams = new URLSearchParams({ email: "owner@acme.com", emailSent: "false" });
    renderWithProviders(<CheckEmailPage />);

    expect(
      screen.getByRole("heading", { name: "We couldn't send your email" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Check your inbox" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/your account was created, but we couldn.t send the verification email/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^we sent a verification link/i)).not.toBeInTheDocument();
  });

  it("renders the resend-failed message when the resend request throws (network failure)", async () => {
    const user = userEvent.setup();
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    renderWithProviders(<CheckEmailPage />);

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(
      await screen.findByText("Something went wrong. Please try again in a moment."),
    ).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/public/tenants/resend-verification"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "owner@acme.com" }),
      }),
    );
  });

  it("renders the resend-failed message when the resend request returns a non-2xx response", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    renderWithProviders(<CheckEmailPage />);

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(
      await screen.findByText("Something went wrong. Please try again in a moment."),
    ).toBeInTheDocument();
  });

  it("does not show the resend-failed message on a successful resend", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    renderWithProviders(<CheckEmailPage />);

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));

    expect(await screen.findByText(/if that address has a pending account/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Something went wrong. Please try again in a moment."),
    ).not.toBeInTheDocument();
  });
});
