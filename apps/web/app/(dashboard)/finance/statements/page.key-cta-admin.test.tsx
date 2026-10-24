import * as React from "react";
import { fireEvent, screen, renderWithProviders } from "@/test-utils/render";
import StatementsPage from "./page";

/**
 * SA #3412 nit: the Claude key lives on an admin-only screen, so an AI_KEY_INVALID scan no longer offers an
 * operator a "Go to Settings" button that lands on "Only an admin can change this." It says who can fix it.
 */

let mockRole = "OPERATOR";

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", role: mockRole, firstName: "Ada", lastName: "Op", email: "a@example.com" },
    logout: jest.fn(),
  }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/statements",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/supplier-statements", () => ({
  ...jest.requireActual("@/lib/api/supplier-statements"),
  scanStatement: () =>
    Promise.reject({
      response: { status: 400, data: { code: "AI_KEY_INVALID", message: "Bad key" } },
    }),
  useSupplierStatementScan: () => ({ data: undefined, isLoading: false, isError: false }),
}));

async function scanWithBadKey() {
  const { container } = renderWithProviders(<StatementsPage />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["%PDF"], "statement.pdf", { type: "application/pdf" })] },
  });
  await screen.findByText("Bad key");
}

describe("Statements: an invalid Claude key (SA #3412 nit)", () => {
  it("an operator is told to ask an account admin, with no Go to Settings button", async () => {
    mockRole = "OPERATOR";
    await scanWithBadKey();
    expect(screen.getByText("Ask an account admin to update the key.")).toBeInTheDocument();
    expect(screen.queryByText("Go to Settings")).not.toBeInTheDocument();
  });

  it("an account admin still gets Go to Settings", async () => {
    mockRole = "TENANT_ADMIN";
    await scanWithBadKey();
    expect(screen.getByText("Go to Settings")).toBeInTheDocument();
  });
});
