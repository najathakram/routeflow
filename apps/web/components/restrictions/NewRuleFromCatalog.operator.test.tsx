import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { ADMIN_ONLY_CHANGE_HINT } from "@/lib/restriction-rules";
import { NewRuleFromCatalog } from "./NewRuleFromCatalog";

/**
 * Row 509 PR5 (SA review MUST 1): the catalog is open to OPERATORs, and a rule that applies everywhere (FEDERAL)
 * is admin-only (owner L5). The real rule editor must offer an operator no way to pick it and say why.
 */
let mockRole = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

const NOTE = ADMIN_ONLY_CHANGE_HINT;

function open() {
  renderWithProviders(
    <NewRuleFromCatalog productIds={["p1", "p2"]} names={{ p1: "Mint Pod" }} onClose={jest.fn()} />,
  );
}

describe("NewRuleFromCatalog roles", () => {
  it("an operator cannot pick `everywhere`, and the note says why", () => {
    mockRole = "OPERATOR";
    open();
    expect(screen.getByRole("radio", { name: /everywhere \(federal\)/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /specific states/i })).toBeChecked();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s can pick it, with no note", (role) => {
    mockRole = role;
    open();
    expect(screen.getByRole("radio", { name: /everywhere \(federal\)/i })).toBeEnabled();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
