import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { LINK_FORMAT_CUTOVER_AT_MS } from "@/lib/account-link-token";
import ResetPasswordPage from "./page";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
import { apiClient } from "@/lib/api-client";

const TOKEN = "f".repeat(64);
const PASSWORD = "Str0ng!Passw0rd";

async function fillAndSubmit() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("New password"), PASSWORD);
  await user.type(screen.getByLabelText("Confirm new password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: /set new password/i }));
}

describe("staff reset / set-password page — token in the fragment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    window.history.replaceState(null, "", "/reset-password");
  });

  it("reads the fragment token, scrubs the address bar and POSTs the token in the body only", async () => {
    window.history.replaceState(null, "", `/reset-password#t=${TOKEN}`);
    (apiClient.post as jest.Mock).mockResolvedValue({ data: {} });
    render(<ResetPasswordPage />);
    await fillAndSubmit();

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const [url, body] = (apiClient.post as jest.Mock).mock.calls[0];
    expect(url).toBe("/auth/reset-password");
    expect(url).not.toContain(TOKEN);
    expect(body).toEqual({ token: TOKEN, newPassword: PASSWORD });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(await screen.findByText("Password updated")).toBeInTheDocument();
  });

  it("falls back to the legacy ?token= query (still inside the legacy window) and scrubs it", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS - 1);
    window.history.replaceState(null, "", `/reset-password?token=${TOKEN}`);
    (apiClient.post as jest.Mock).mockResolvedValue({ data: {} });
    render(<ResetPasswordPage />);
    await fillAndSubmit();

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect((apiClient.post as jest.Mock).mock.calls[0][1]).toEqual({
      token: TOKEN,
      newPassword: PASSWORD,
    });
    expect(window.location.search).toBe("");
  });

  it("ignores the legacy query after the legacy window has passed", async () => {
    jest.spyOn(Date, "now").mockReturnValue(LINK_FORMAT_CUTOVER_AT_MS + 365 * 24 * 3_600_000);
    window.history.replaceState(null, "", `/reset-password?token=${TOKEN}`);
    render(<ResetPasswordPage />);
    expect(await screen.findByText(/invalid or incomplete/i)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("shows the invalid-link state without a token", async () => {
    render(<ResetPasswordPage />);
    expect(await screen.findByText(/invalid or incomplete/i)).toBeInTheDocument();
  });

  it("shows fixed copy on failure and never the server's text", async () => {
    window.history.replaceState(null, "", `/reset-password#t=${TOKEN}`);
    (apiClient.post as jest.Mock).mockRejectedValue({
      response: { data: { message: "SERVER-SIDE DETAIL token row 42 not found" } },
    });
    render(<ResetPasswordPage />);
    await fillAndSubmit();

    expect(
      await screen.findByText(/Could not reset your password\. The link may have expired\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
