import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { BUYER_KEYS } from "@/lib/auth-keys";
import { BuyerInviteFlow } from "./invite-flow";
import { INVITE_HANDOFF_KEY } from "./invite-handoff";
import BuyerInvitePage from "./page";
import LegacyBuyerInvitePage from "./[token]/page";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));
import axios from "axios";

const push = jest.fn();
let routeParams: Record<string, string> = {};
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => routeParams,
}));

const authState = {
  buyer: null as { id: string; email: string; name: string } | null,
  isLoading: false,
  isAuthenticated: false,
  refreshSellers: jest.fn().mockResolvedValue(undefined),
};
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => authState,
}));

const post = axios.post as jest.Mock;
const get = axios.get as jest.Mock;
const TOKEN = "e".repeat(64);
const DETAILS = { sellerName: "Acme Foods", sellerSlug: "acme-foods", logoKey: null };

/** Every URL any request made through the page was built from. */
function requestedUrls(): string[] {
  return [...post.mock.calls, ...get.mock.calls].map((c) => String(c[0]));
}

describe("buyer invite page — the token never rides in a URL", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    post.mockReset();
    get.mockReset();
    push.mockReset();
    routeParams = {};
    authState.buyer = null;
    authState.isAuthenticated = false;
    authState.isLoading = false;
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/buyer/invite");
    post.mockResolvedValue({ data: DETAILS });
  });

  it("reads the fragment, scrubs the address bar and POSTs the token in the body of the details call", async () => {
    window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);

    render(<BuyerInvitePage />);

    expect(await screen.findByText("Acme Foods")).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/buyer\/invites\/details$/);
    expect(body).toEqual({ token: TOKEN });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(requestedUrls().join("\n")).not.toContain(TOKEN);
  });

  it("the legacy path route reads its path segment but still POSTs it in the body", async () => {
    routeParams = { token: TOKEN };

    render(<LegacyBuyerInvitePage />);

    expect(await screen.findByText("Acme Foods")).toBeInTheDocument();
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/buyer\/invites\/details$/);
    expect(url).not.toContain(TOKEN);
    expect(body).toEqual({ token: TOKEN });
    expect(get).not.toHaveBeenCalled();
  });

  it("shows fixed copy for a dead link and never the server's text", async () => {
    window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
    post.mockRejectedValue({ response: { data: { message: "SERVER-SIDE DETAIL row 42" } } });

    render(<BuyerInvitePage />);

    expect(
      await screen.findByText("This invite link is invalid or has expired."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("shows the invalid-link state, and calls nothing, when no token can be found", async () => {
    render(<BuyerInvitePage />);

    expect(
      await screen.findByText("This invite link is invalid or has expired."),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  describe("signed out: sign-in and register links carry /buyer/invite only", () => {
    it("the links hold no token; the token is handed over through sessionStorage when one is clicked", async () => {
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
      render(<BuyerInvitePage />);

      const signIn = await screen.findByRole("link", { name: "Sign in to accept" });
      const register = screen.getByRole("link", { name: "Create account to accept" });
      expect(signIn.getAttribute("href")).toBe("/buyer/login?redirect=/buyer/invite");
      expect(register.getAttribute("href")).toBe("/buyer/register?redirect=/buyer/invite");
      expect(window.sessionStorage.getItem(INVITE_HANDOFF_KEY)).toBeNull();

      // jsdom cannot navigate: swallow the default action, keep the click handler.
      signIn.addEventListener("click", (e) => e.preventDefault());
      await userEvent.click(signIn);
      expect(window.sessionStorage.getItem(INVITE_HANDOFF_KEY)).toBe(TOKEN);
    });

    it("on return the page takes the token from sessionStorage once and clears it", async () => {
      window.sessionStorage.setItem(INVITE_HANDOFF_KEY, TOKEN);

      render(<BuyerInvitePage />);

      expect(await screen.findByText("Acme Foods")).toBeInTheDocument();
      expect(post.mock.calls[0][1]).toEqual({ token: TOKEN });
      expect(window.sessionStorage.getItem(INVITE_HANDOFF_KEY)).toBeNull();
      expect(window.location.href).not.toContain(TOKEN);
    });

    it("a fragment wins over a stale handoff, and the handoff is cleared either way", async () => {
      window.sessionStorage.setItem(INVITE_HANDOFF_KEY, "stale-token");
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);

      render(<BuyerInvitePage />);

      await screen.findByText("Acme Foods");
      expect(post.mock.calls[0][1]).toEqual({ token: TOKEN });
      expect(window.sessionStorage.getItem(INVITE_HANDOFF_KEY)).toBeNull();
    });
  });

  describe("signed in: accept", () => {
    beforeEach(() => {
      authState.buyer = { id: "b1", email: "buyer@example.com", name: "Buyer" };
      authState.isAuthenticated = true;
      window.localStorage.setItem(BUYER_KEYS.accessToken, "access-jwt");
    });

    it("POSTs the token in the body with the session bearer; no URL carries it", async () => {
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
      render(<BuyerInvitePage />);

      await userEvent.click(await screen.findByRole("button", { name: /accept invite/i }));

      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      const [url, body, config] = post.mock.calls[1];
      expect(url).toMatch(/\/buyer\/invites\/accept$/);
      expect(body).toEqual({ token: TOKEN });
      expect(config.headers.Authorization).toBe("Bearer access-jwt");
      expect(requestedUrls().join("\n")).not.toContain(TOKEN);
      expect(authState.refreshSellers).toHaveBeenCalled();
    });

    it("shows fixed copy when the accept is refused", async () => {
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
      render(<BuyerInvitePage />);
      await screen.findByText("Acme Foods");
      post.mockRejectedValueOnce({ response: { data: { message: "SERVER-SIDE DETAIL row 42" } } });

      await userEvent.click(screen.getByRole("button", { name: /accept invite/i }));

      expect(await screen.findByText(/We could not accept this invite/)).toBeInTheDocument();
      expect(screen.queryByText(/SERVER-SIDE DETAIL/)).not.toBeInTheDocument();
    });
  });

  describe("Google sign-in", () => {
    it("starts through POST /auth/google/start with the token in the body only", async () => {
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
      render(<BuyerInviteFlow />);
      await screen.findByText("Acme Foods");
      post.mockResolvedValueOnce({ data: { url: "https://accounts.google.test/auth?state=abc" } });
      // jsdom has no navigation: the failure to navigate must not turn into the unavailable copy.
      jest.spyOn(console, "error").mockImplementation(() => {});

      await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));

      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      const [url, body] = post.mock.calls[1];
      expect(url).toMatch(/\/auth\/google\/start$/);
      expect(body).toEqual({ tenant: "acme-foods", context: "portal", inviteToken: TOKEN });
      expect(requestedUrls().join("\n")).not.toContain(TOKEN);
      expect(requestedUrls().join("\n")).not.toContain("invite_token");
    });

    it("shows fixed copy when Google cannot be started", async () => {
      window.history.replaceState(null, "", `/buyer/invite#t=${TOKEN}`);
      render(<BuyerInvitePage />);
      await screen.findByText("Acme Foods");
      post.mockRejectedValueOnce(new Error("boom"));

      await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));

      expect(
        await screen.findByText(
          "Google sign-in is unavailable. Please use email/password instead.",
        ),
      ).toBeInTheDocument();
    });
  });
});
