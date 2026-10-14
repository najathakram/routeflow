import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { LimitInPortalDialog } from "./LimitInPortalDialog";

/**
 * L5: "Hide from all portal customers" is account-admin only. An operator sees the choice disabled with the fixed
 * line "Ask an account admin" (the state choice still works); an admin keeps it. The server's refusal shows fixed copy.
 */
const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => mockPost(...a),
    get: (...a: unknown[]) => mockGet(...a),
  },
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));
let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));

function open() {
  renderWithProviders(
    <LimitInPortalDialog
      open
      scope={{ kind: "products", productIds: ["p1", "p2"] }}
      onClose={jest.fn()}
    />,
  );
  return screen.getByRole("dialog");
}

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  mockGet.mockImplementation(async (url: string) =>
    url === "/settings/restrictions" ? { data: { enabled: true } } : { data: [] },
  );
});

describe("LimitInPortalDialog: all-portal hide is admin-only (L5)", () => {
  it("an operator sees 'Hide from all portal customers' disabled with 'Ask an account admin'", () => {
    const dialog = open();
    expect(within(dialog).getByRole("radio", { name: /all portal customers/i })).toBeDisabled();
    expect(within(dialog).getByText("Ask an account admin")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /certain states/i })).toBeEnabled();
  });

  it("an admin sees it enabled and no admin line", () => {
    role = "TENANT_ADMIN";
    const dialog = open();
    expect(within(dialog).getByRole("radio", { name: /all portal customers/i })).toBeEnabled();
    expect(within(dialog).queryByText("Ask an account admin")).toBeNull();
  });
});
