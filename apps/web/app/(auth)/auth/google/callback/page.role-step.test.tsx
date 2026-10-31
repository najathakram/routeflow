import * as React from "react";
import { renderWithProviders, waitFor } from "@/test-utils/render";
import { documentNav } from "@/lib/document-nav";
import GoogleCallbackPage from "./page";

/**
 * W-839 / SA-937 MUST 6: the Google staff branch goes through the same role step as the password login. It used to go
 * straight to /dashboard; a driver who is also an ACTIVE buyer of this tenant is now asked which role to use.
 */
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => mockSearchParams,
}));
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

/** An unsigned JWT the web's getStoredUser can decode (it only reads the payload). */
const jwt = (payload: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify({ exp: 4102444800, ...payload })).toString("base64url")}.y`;

function exchange(payload: Record<string, unknown>) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      accessToken: jwt({ sub: "u1", username: "sam", tenantId: "t1", ...payload }),
      refreshToken: "r",
      role: payload.role,
      tenantSlug: "acme",
    }),
  });
}

let nav: jest.SpyInstance;
beforeEach(() => {
  localStorage.clear();
  mockGet.mockReset();
  global.fetch = jest.fn() as unknown as typeof fetch;
  mockSearchParams = new URLSearchParams({ code: "one-time-code" });
  nav = jest.spyOn(documentNav, "replace").mockImplementation(() => undefined);
});
afterEach(() => nav.mockRestore());

it("a Google-signed-in driver who also buys goes to the role step (Drive will land on /dashboard)", async () => {
  sessionStorage.clear();
  exchange({ role: "DRIVER" });
  mockGet.mockResolvedValue({ data: { alsoBuyer: true } });
  renderWithProviders(<GoogleCallbackPage />);
  await waitFor(() => expect(nav).toHaveBeenCalledWith("/choose-role"));
  expect(mockGet).toHaveBeenCalledWith("/users/me");
  expect(sessionStorage.getItem("rf.roleStep.landing")).toBe("/dashboard");
});

// #3731 review (5): the Google path never asks before a forced password change either.
it("a Google-signed-in driver who must change their password is not asked", async () => {
  exchange({ role: "DRIVER", forcePasswordChange: true });
  mockGet.mockResolvedValue({ data: { alsoBuyer: true } });
  renderWithProviders(<GoogleCallbackPage />);
  await waitFor(() => expect(nav).toHaveBeenCalled());
  expect(nav).not.toHaveBeenCalledWith("/choose-role");
  expect(mockGet).not.toHaveBeenCalled();
});

it("a Google-signed-in driver who does not buy keeps today's landing (/dashboard)", async () => {
  exchange({ role: "DRIVER" });
  mockGet.mockResolvedValue({ data: { alsoBuyer: false } });
  renderWithProviders(<GoogleCallbackPage />);
  await waitFor(() => expect(nav).toHaveBeenCalledWith("/dashboard"));
});

it("a Google-signed-in operator keeps /dashboard and never pays for the /users/me read", async () => {
  exchange({ role: "OPERATOR" });
  renderWithProviders(<GoogleCallbackPage />);
  await waitFor(() => expect(nav).toHaveBeenCalledWith("/dashboard"));
  expect(mockGet).not.toHaveBeenCalled();
});
