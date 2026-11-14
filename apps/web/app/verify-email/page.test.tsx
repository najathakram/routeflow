import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import VerifyEmailPage from "./page";

// B2: a verification link past its 24h expiry used to show the server's raw message with only
// "Sign up again" / "Back to sign in". The page now names the problem and offers a new link
// through the same resend endpoint the check-email page uses.

let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

const EXPIRED_COPY =
  "This link has expired. Links last 24 hours. Enter your email and we'll send you a new one.";
const INVALID_COPY = "This link didn't work. Enter your email and we'll send you a new one.";
// check-email's current resend copy, verbatim.
const RESEND_SENT_COPY = "If that address has a pending account, a new link is on its way.";
const RESEND_FAILED_COPY = "Something went wrong. Please try again in a moment.";

describe("VerifyEmailPage — expired link offers a new link (B2)", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSearchParams = new URLSearchParams({ token: "a.b.c" });
  });

  const expiredResponse = {
    ok: false,
    status: 400,
    json: async () => ({ code: "VERIFICATION_LINK_EXPIRED", message: "SERVER TEXT" }),
  } as unknown as Response;

  it("REG-B2 expired link shows the Link expired heading, fixed copy and a Send a new link button, never the server text", async () => {
    fetchSpy.mockResolvedValueOnce(expiredResponse);
    renderWithProviders(<VerifyEmailPage />);

    expect(await screen.findByRole("button", { name: "Send a new link" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Link expired" })).toBeInTheDocument();
    expect(screen.getByText(EXPIRED_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/SERVER TEXT/)).not.toBeInTheDocument();
  });

  it("REG-B2 submitting an email posts it to the resend endpoint and shows the success copy", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(expiredResponse);
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    renderWithProviders(<VerifyEmailPage />);

    await user.type(await screen.findByLabelText("Email"), "owner@acme.com");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(await screen.findByText(RESEND_SENT_COPY)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![0]).toContain("/public/tenants/resend-verification");
    expect(fetchSpy.mock.calls[1]![1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "owner@acme.com" }),
      }),
    );
  });

  it("REG-B2 a 400 with no code shows the invalid-link copy, not the server text", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: "SERVER TEXT" }),
    } as unknown as Response);
    renderWithProviders(<VerifyEmailPage />);

    expect(await screen.findByText(INVALID_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/SERVER TEXT/)).not.toBeInTheDocument();
  });

  it("REG-B2 a throttled resend (429) shows the failure copy", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValueOnce(expiredResponse);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    renderWithProviders(<VerifyEmailPage />);

    await user.type(await screen.findByLabelText("Email"), "owner@acme.com");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(await screen.findByText(RESEND_FAILED_COPY)).toBeInTheDocument();
    expect(screen.queryByText(RESEND_SENT_COPY)).not.toBeInTheDocument();
  });
});
