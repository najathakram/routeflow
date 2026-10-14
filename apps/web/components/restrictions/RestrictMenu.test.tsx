import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { RestrictMenu } from "./RestrictMenu";

/** Row 509 PR5: the catalog bulk bar's ONE "Restrict…" menu (New rule / Add to a rule / Remove from a rule). */
let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));
let mockReadOnly = false;
jest.mock("@/lib/read-only-gate", () => ({
  ...jest.requireActual("@/lib/read-only-gate"),
  useReadOnlyGate: () => ({ readOnly: mockReadOnly, line: "Read only", hintId: "h" }),
}));
const newRuleProps = jest.fn();
jest.mock("./NewRuleFromCatalog", () => ({
  NewRuleFromCatalog: (p: Record<string, unknown>) => {
    newRuleProps(p);
    return <div data-testid="new-rule-stub" />;
  },
}));
const chooserProps = jest.fn();
jest.mock("./RuleChooserDialog", () => ({
  RuleChooserDialog: (p: Record<string, unknown>) => {
    chooserProps(p);
    return <div data-testid="chooser-stub" />;
  },
}));

const sel = (n: number) => new Set(Array.from({ length: n }, (_, i) => `p${i + 1}`));

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  mockReadOnly = false;
});

describe("RestrictMenu", () => {
  it("is one button that opens exactly three items", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RestrictMenu selected={sel(8)} names={{}} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Restrict…" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "New rule with 8 products…",
      "Add to a rule…",
      "Remove from a rule…",
    ]);
  });

  it("says `1 product` for a single selection", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RestrictMenu selected={sel(1)} names={{}} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Restrict…" }));
    expect(screen.getByRole("menuitem", { name: "New rule with 1 product…" })).toBeInTheDocument();
  });

  it("OPERATOR may use it too (same gate as Limit in portal)", () => {
    mockRole = "OPERATOR";
    renderWithProviders(<RestrictMenu selected={sel(2)} names={{}} onDone={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Restrict…" })).toBeEnabled();
  });

  it.each(["DRIVER", "CUSTOMER", "VIEWER"])("is hidden from %s", (role) => {
    mockRole = role;
    renderWithProviders(<RestrictMenu selected={sel(2)} names={{}} onDone={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Restrict…" })).toBeNull();
  });

  it("stays visible but disabled while the workspace is read-only", () => {
    mockReadOnly = true;
    renderWithProviders(<RestrictMenu selected={sel(2)} names={{}} onDone={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Restrict…" })).toBeDisabled();
  });

  it("New rule with N products opens the new-rule dialog with the ids and names", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RestrictMenu selected={sel(2)} names={{ p1: "Mint Pod" }} onDone={jest.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Restrict…" }));
    await user.click(screen.getByRole("menuitem", { name: /new rule with 2 products/i }));
    expect(screen.getByTestId("new-rule-stub")).toBeInTheDocument();
    expect(newRuleProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ productIds: ["p1", "p2"], names: { p1: "Mint Pod" } }),
    );
  });

  it("Add to a rule and Remove from a rule open the chooser in the right mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RestrictMenu selected={sel(3)} names={{}} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Restrict…" }));
    await user.click(screen.getByRole("menuitem", { name: "Add to a rule…" }));
    expect(chooserProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "add", productIds: ["p1", "p2", "p3"], open: true }),
    );
  });

  it("Remove from a rule opens the chooser in remove mode", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RestrictMenu selected={sel(3)} names={{}} onDone={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Restrict…" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from a rule…" }));
    expect(chooserProps).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "remove" }));
  });
});
