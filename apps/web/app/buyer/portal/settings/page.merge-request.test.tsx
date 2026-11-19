import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { BUYER_KEYS } from "@/lib/auth-keys";
import BuyerSettingsPage from "./page";

/**
 * W-1240: the merge request read its token from "buyerToken", a key nothing writes, so it always went
 * out with no Authorization header. It reads the buyer's access token through getBuyerAccessToken.
 */
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({ buyer: { id: "b1", email: "pat@acme.test", name: "Pat" } }),
}));

describe("BuyerSettingsPage merge request", () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: "Verification email sent." }),
    }) as unknown as typeof fetch;
  });

  async function submit() {
    render(<BuyerSettingsPage />);
    await userEvent.type(screen.getByPlaceholderText("other@example.com"), "pat2@acme.test");
    await userEvent.click(screen.getByRole("button", { name: /send verification email/i }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    return (global.fetch as jest.Mock).mock.calls[0];
  }

  it("sends the signed-in buyer's access token as the bearer", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, "buyer-access-token");
    const [url, init] = await submit();
    expect(String(url)).toMatch(/\/buyer\/auth\/merge-request$/);
    expect(init.headers.Authorization).toBe("Bearer buyer-access-token");
  });

  it("sends no Authorization header when nobody is signed in", async () => {
    const [, init] = await submit();
    expect(init.headers.Authorization).toBeUndefined();
  });
});
