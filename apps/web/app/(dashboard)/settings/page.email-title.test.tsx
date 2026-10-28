import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import SettingsPage from "./page";

// Row 376: the email screen's title follows the renamed hub row ("Email sending (SMTP)"), so the row, the breadcrumb and the
// page it opens all say the same thing.

let mockRole = "TENANT_ADMIN";
let mockTab: string | null = null;
const get = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
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
  mockRole = "TENANT_ADMIN";
  mockTab = "email";
  get.mockResolvedValue({ data: {} });
});

describe("SettingsPage — Email screen title (row 376)", () => {
  it("?tab=email is titled 'Email sending (SMTP)', not the old label", async () => {
    renderWithProviders(<SettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "Email sending (SMTP)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Email (SMTP)" })).not.toBeInTheDocument();
  });
});
