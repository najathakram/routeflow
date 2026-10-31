import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { BUYER_KEYS, OP_KEYS } from "@/lib/auth-keys";
import { documentNav } from "@/lib/document-nav";
import ChooseRolePage from "./page";

/**
 * W-839 / SA-937 (owner 2026-10-24: a user who is both a driver and a buyer is ASKED at sign-in which role to use).
 * Drive keeps today's landing. Shop ends the staff session (POST /auth/logout, staff keys cleared) and opens the web
 * buyer login with the email prefilled: no buyer token is minted from the staff session, and both are never live.
 */
const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: jest.fn() }) }));
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

const jwt = (payload: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify({ exp: 4102444800, ...payload })).toString("base64url")}.y`;
const signedInAs = (payload: Record<string, unknown>) => {
  localStorage.setItem(
    OP_KEYS.accessToken,
    jwt({ sub: "u1", username: "sam", tenantId: "t1", ...payload }),
  );
  localStorage.setItem(OP_KEYS.refreshToken, "refresh");
};

let nav: jest.SpyInstance;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  replace.mockClear();
  mockGet.mockReset();
  mockPost.mockReset().mockResolvedValue({ data: {} });
  nav = jest.spyOn(documentNav, "replace").mockImplementation(() => undefined);
});
afterEach(() => nav.mockRestore());

it("asks a driver who also buys which role to use", async () => {
  signedInAs({ role: "DRIVER" });
  mockGet.mockResolvedValue({ data: { alsoBuyer: true, email: "Sam@Acme.example" } });
  renderWithProviders(<ChooseRolePage />);
  expect(
    await screen.findByRole("heading", { name: "How do you want to use RouteFlow?" }),
  ).toBeVisible();
  expect(await screen.findByRole("button", { name: /Drive/ })).toBeVisible();
  expect(screen.getByRole("button", { name: /Shop/ })).toBeVisible();
});

it("Drive keeps today's landing", async () => {
  signedInAs({ role: "DRIVER" });
  mockGet.mockResolvedValue({ data: { alsoBuyer: true, email: "sam@acme.example" } });
  renderWithProviders(<ChooseRolePage />);
  await userEvent.click(await screen.findByRole("button", { name: /Drive/ }));
  expect(replace).toHaveBeenCalledWith("/routes/my-runs");
  expect(mockPost).not.toHaveBeenCalled();
});

it("Shop ends the staff session, writes no buyer keys, and opens the buyer login (email stashed, never in the URL)", async () => {
  signedInAs({ role: "DRIVER" });
  // the legacy keys the Google callback also writes (#3731 review 3)
  localStorage.setItem("accessToken", "legacy-a");
  localStorage.setItem("refreshToken", "legacy-r");
  mockGet.mockResolvedValue({ data: { alsoBuyer: true, email: "sam+1@acme.example" } });
  renderWithProviders(<ChooseRolePage />);
  await userEvent.click(await screen.findByRole("button", { name: /Shop/ }));
  await waitFor(() => expect(nav).toHaveBeenCalledWith("/buyer/login"));
  expect(sessionStorage.getItem("rf.buyerLogin.email")).toBe("sam+1@acme.example");
  expect(mockPost).toHaveBeenCalledWith("/auth/logout");
  expect(localStorage.getItem(OP_KEYS.accessToken)).toBeNull();
  expect(localStorage.getItem(OP_KEYS.refreshToken)).toBeNull();
  expect(localStorage.getItem("accessToken")).toBeNull();
  expect(localStorage.getItem("refreshToken")).toBeNull();
  expect(localStorage.getItem(BUYER_KEYS.accessToken)).toBeNull();
  expect(localStorage.getItem(BUYER_KEYS.refreshToken)).toBeNull();
});

it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
  ["a non-driver", { role: "OPERATOR" }, { alsoBuyer: true }, "/dashboard"],
  ["a driver who does not buy", { role: "DRIVER" }, { alsoBuyer: false }, "/routes/my-runs"],
])("%s reaching the page is sent on to today's landing", async (_l, who, me, landing) => {
  signedInAs(who);
  mockGet.mockResolvedValue({ data: me });
  renderWithProviders(<ChooseRolePage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith(landing));
  expect(screen.queryByRole("button", { name: /Shop/ })).toBeNull();
});

// #3731 review (2): Drive goes back to the landing of the path the user signed in on.
it("Drive after a Google sign-in keeps the Google landing (/dashboard)", async () => {
  signedInAs({ role: "DRIVER" });
  sessionStorage.setItem("rf.roleStep.landing", "/dashboard");
  mockGet.mockResolvedValue({ data: { alsoBuyer: true } });
  renderWithProviders(<ChooseRolePage />);
  await userEvent.click(await screen.findByRole("button", { name: /Drive/ }));
  expect(replace).toHaveBeenCalledWith("/dashboard");
});

// #3731 review (5): reached directly, a forced password change still goes first.
it("a forced password change goes first, even reached directly", async () => {
  signedInAs({ role: "DRIVER", forcePasswordChange: true });
  mockGet.mockResolvedValue({ data: { alsoBuyer: true } });
  renderWithProviders(<ChooseRolePage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/change-password"));
  expect(screen.queryByRole("button", { name: /Shop/ })).toBeNull();
  expect(mockGet).not.toHaveBeenCalledWith("/users/me");
});

it("signed out: the staff login", async () => {
  renderWithProviders(<ChooseRolePage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
});
