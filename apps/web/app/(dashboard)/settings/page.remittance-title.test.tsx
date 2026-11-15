import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import SettingsPage from "./page";

// SA-1151 §3 (UX guide F03): the screen the "How customers pay you" row opens carries the same words as the row.

const get = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: "TENANT_ADMIN" } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=remittance"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: {} });
});

describe("SettingsPage: the remittance screen title (F03)", () => {
  it("?tab=remittance is titled 'How customers pay you', not 'How to pay'", async () => {
    renderWithProviders(<SettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "How customers pay you" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "How to pay" })).not.toBeInTheDocument();
  });
});
