/**
 * Row 404: a link scanner's prefetch must not complete the account merge. The emailed link opens
 * this page; it must make NO request on mount and confirm only on an explicit click, which POSTs
 * the single-use token in the body (never in the URL).
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...a: unknown[]) => mockPost(...a),
    get: (...a: unknown[]) => mockGet(...a),
  },
}));

let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

import VerifyMergePage from "./page";

const TOKEN = "f".repeat(64);

describe("buyer verify-merge page: confirm only on click", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockSearchParams = new URLSearchParams({ token: TOKEN });
  });

  it("makes no request on mount and shows the confirm card", async () => {
    render(<VerifyMergePage />);

    expect(
      await screen.findByRole("heading", { name: "Confirm account merge" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm account merge/i })).toBeEnabled();
    // let any mount effect flush before asserting nothing went out
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("clicking confirm POSTs the token in the body (not the URL) and shows success", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ data: { success: true, message: "server text" } });
    render(<VerifyMergePage />);

    await user.click(await screen.findByRole("button", { name: /confirm account merge/i }));

    expect(await screen.findByRole("heading", { name: "Account Verified!" })).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(url).toMatch(/\/buyer\/auth\/verify-merge$/);
    expect(url).not.toContain(TOKEN);
    expect(body).toEqual({ token: TOKEN });
    expect(screen.getByText(/your account ownership is confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to login/i })).toHaveAttribute(
      "href",
      "/buyer/login",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the server's error (e.g. an expired link) in the failure state", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce({
      response: {
        status: 410,
        data: { message: "Verification token has expired. Please initiate a new merge request." },
      },
    });
    render(<VerifyMergePage />);

    await user.click(await screen.findByRole("button", { name: /confirm account merge/i }));

    expect(await screen.findByRole("heading", { name: "Verification Failed" })).toBeInTheDocument();
    expect(screen.getByText(/verification token has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/submit a new merge request/i)).toBeInTheDocument();
  });

  it("falls back to a neutral error when the request fails without a message", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce(new Error("Network Error"));
    render(<VerifyMergePage />);

    await user.click(await screen.findByRole("button", { name: /confirm account merge/i }));

    expect(await screen.findByRole("heading", { name: "Verification Failed" })).toBeInTheDocument();
    expect(screen.getByText("Verification failed.")).toBeInTheDocument();
  });

  it("a double click confirms once", async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => {};
    mockPost.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<VerifyMergePage />);

    const btn = await screen.findByRole("button", { name: /confirm account merge/i });
    await user.dblClick(btn);
    resolve({ data: { success: true } });

    expect(await screen.findByRole("heading", { name: "Account Verified!" })).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("with no token, shows the failure state, no button and no request", async () => {
    mockSearchParams = new URLSearchParams();
    render(<VerifyMergePage />);

    expect(await screen.findByRole("heading", { name: "Verification Failed" })).toBeInTheDocument();
    expect(screen.getByText("No verification token provided.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
    expect(mockPost).not.toHaveBeenCalled();
  });
});
