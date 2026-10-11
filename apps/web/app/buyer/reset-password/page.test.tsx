import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { LINK_FORMAT_CUTOVER_AT_MS } from "@/lib/account-link-token";
import BuyerResetPasswordPage from "./page";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));
import axios from "axios";

const post = axios.post as jest.Mock;
const TOKEN = "e".repeat(64);
const PASSWORD = "Str0ng!Passw0rd";

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("New password"), PASSWORD);
  await user.type(screen.getByLabelText("Confirm new password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: /set new password/i }));
}

describe("buyer reset page — token in the fragment", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    post.mockReset();
    window.history.replaceState(null, "", "/buyer/reset-password");
  });

  it("reads the fragment token, scrubs the address bar and POSTs the token in the body only", async () => {
    window.history.replaceState(null, "", `/buyer/reset-password#t=${TOKEN}`);
    post.mockResolvedValue({ data: {} });
    render(<BuyerResetPasswordPage />);
    await fillAndSubmit();

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/buyer\/auth\/reset-password$/);
    expect(url).not.toContain(TOKEN);
    expect(body).toEqual({ token: TOKEN, newPassword: PASSWORD });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(await screen.findByText("Password updated")).toBeInTheDocument();
  });

  it("falls back to the legacy ?token= query inside the legacy window and scrubs it", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS - 1);
    window.history.replaceState(null, "", `/buyer/reset-password?token=${TOKEN}`);
    post.mockResolvedValue({ data: {} });
    render(<BuyerResetPasswordPage />);
    await fillAndSubmit();

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({ token: TOKEN, newPassword: PASSWORD });
    expect(window.location.search).toBe("");
  });

  it("shows the invalid-link state without a token", async () => {
    render(<BuyerResetPasswordPage />);
    expect(await screen.findByText(/invalid or incomplete/i)).toBeInTheDocument();
  });

  it("shows fixed copy on failure and never the server's text", async () => {
    window.history.replaceState(null, "", `/buyer/reset-password#t=${TOKEN}`);
    post.mockRejectedValue({ response: { data: { message: "SERVER-SIDE DETAIL row 42" } } });
    render(<BuyerResetPasswordPage />);
    await fillAndSubmit();

    expect(
      await screen.findByText(/Could not reset your password\. The link may have expired\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
