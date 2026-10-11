import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { LINK_FORMAT_CUTOVER_AT_MS } from "@/lib/account-link-token";
import BuyerVerifyEmailPage from "./page";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));
import axios from "axios";

const post = axios.post as jest.Mock;
const TOKEN = "d".repeat(64);

describe("buyer email verification page — token in the fragment", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    post.mockReset();
    window.history.replaceState(null, "", "/buyer/verify-email");
  });

  it("reads the fragment token, scrubs the address bar and POSTs the token in the body only", async () => {
    window.history.replaceState(null, "", `/buyer/verify-email#t=${TOKEN}`);
    post.mockResolvedValue({ data: { message: "ok" } });
    render(<BuyerVerifyEmailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /verify my email/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/buyer\/auth\/verify-email$/);
    expect(url).not.toContain(TOKEN);
    expect(body).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(await screen.findByText("Email verified")).toBeInTheDocument();
  });

  it("does not verify on load: it waits for the button click", async () => {
    window.history.replaceState(null, "", `/buyer/verify-email#t=${TOKEN}`);
    render(<BuyerVerifyEmailPage />);
    await screen.findByRole("button", { name: /verify my email/i });
    expect(post).not.toHaveBeenCalled();
  });

  it("falls back to the legacy ?token= query inside the legacy window and scrubs it", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS - 1);
    window.history.replaceState(null, "", `/buyer/verify-email?token=${TOKEN}`);
    post.mockResolvedValue({ data: { message: "ok" } });
    render(<BuyerVerifyEmailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /verify my email/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({ token: TOKEN });
    expect(window.location.search).toBe("");
  });

  it("shows the invalid-link state without a token", async () => {
    render(<BuyerVerifyEmailPage />);
    expect(await screen.findByText(/invalid or incomplete/i)).toBeInTheDocument();
  });

  it("shows fixed copy on failure and never the server's text", async () => {
    window.history.replaceState(null, "", `/buyer/verify-email#t=${TOKEN}`);
    post.mockRejectedValue({ response: { data: { message: "SERVER-SIDE DETAIL row 42" } } });
    render(<BuyerVerifyEmailPage />);
    await userEvent.click(await screen.findByRole("button", { name: /verify my email/i }));

    expect(
      await screen.findByText(/Could not verify your email\. The link may have expired\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
