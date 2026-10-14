import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { RuleChooserDialog } from "./RuleChooserDialog";

/**
 * Row 509 PR5: the rule chooser behind the catalog's "Add to a rule…" / "Remove from a rule…" and the product page's
 * "Add to a rule…". Mocked API at the client boundary; the toast, router and role are mocked.
 */
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

const rule = (over: Record<string, unknown>) => ({
  id: "r1",
  jurisdiction: "STATE",
  states: ["TX", "CA"],
  surface: "BUYER_PORTAL",
  reason: "Vape ban TX",
  status: "ACTIVE",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  liftedAt: null,
  categoryName: null,
  productName: null,
  targetSummary: { products: 12, categories: 0, preview: [] },
  ...over,
});

const RULES = [
  rule({ id: "r1" }),
  rule({
    id: "r2",
    jurisdiction: "FEDERAL",
    states: [],
    surface: "ALL",
    reason: "Everything banned",
    targetSummary: { products: 3, categories: 0, preview: [] },
  }),
  rule({ id: "r3", status: "LIFTED", reason: "Old lifted rule" }),
  rule({ id: "r4", status: "SCHEDULED", reason: "Summer promo", states: ["NY"] }),
];

function open(props: Partial<React.ComponentProps<typeof RuleChooserDialog>> = {}) {
  const onClose = jest.fn();
  const onDone = jest.fn();
  renderWithProviders(
    <RuleChooserDialog
      open
      mode="add"
      productIds={ids(8)}
      onClose={onClose}
      onDone={onDone}
      {...props}
    />,
  );
  return { onClose, onDone };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/selling-restrictions") return { data: RULES };
    return { data: [] };
  });
  mockPost.mockImplementation(async (url: string) => {
    if (url === "/selling-restrictions/holding")
      return { data: { items: [{ rule: RULES[0], holds: 5 }] } };
    return { data: {} };
  });
});

describe("RuleChooserDialog, add mode", () => {
  it("lists only ACTIVE and SCHEDULED rules, one sentence each", async () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: /vape ban tx/i })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Hidden in TX, CA · portal only · 12 products"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /everything banned/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /summer promo/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /old lifted rule/i })).toBeNull();
  });

  it("the search box narrows the list", async () => {
    const user = userEvent.setup();
    open();
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("button", { name: /vape ban tx/i });
    await user.type(within(dialog).getByRole("searchbox", { name: /search rules/i }), "summer");
    expect(within(dialog).queryByRole("button", { name: /vape ban tx/i })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /summer promo/i })).toBeInTheDocument();
  });

  it("an all-customer (FEDERAL) rule is disabled with a reason for an operator (owner L5)", async () => {
    mockRole = "OPERATOR";
    open();
    const dialog = screen.getByRole("dialog");
    const fed = await within(dialog).findByRole("button", { name: /everything banned/i });
    expect(fed).toBeDisabled();
    expect(
      within(dialog).getByText(
        "Only an admin can change a rule that hides products from everyone.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /vape ban tx/i })).toBeEnabled();
  });

  it("an admin can pick the FEDERAL rule", async () => {
    open();
    const fed = await screen.findByRole("button", { name: /everything banned/i });
    expect(fed).toBeEnabled();
  });

  it("asks for a count confirmation before writing anything", async () => {
    const user = userEvent.setup();
    open({ productIds: ids(640) });
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add 640 products to “Vape ban TX”?")).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(await within(dialog).findByRole("button", { name: /vape ban tx/i })).toBeInTheDocument();
  });

  it("adds, toasts `8 added · 2 already in it` with Undo and View rule, and Undo removes only the added", async () => {
    const user = userEvent.setup();
    mockPost.mockImplementation(async (url: string) => {
      if (url === "/selling-restrictions/r1/targets")
        return {
          data: { added: 6, skippedIds: ["p1", "p2"], addedTargetIds: [], activeTargets: 18 },
        };
      return { data: { removed: 6, notInRule: [], activeTargets: 12 } };
    });
    const { onClose, onDone } = open();
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    await user.click(screen.getByRole("button", { name: "Add 8 products" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/r1/targets", {
      productIds: ids(8),
    });
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("6 added · 2 already in it");
    expect(shown.variant).toBe("success");
    expect(shown.action.label).toBe("Undo");
    expect(shown.secondaryAction.label).toBe("View rule");
    shown.secondaryAction.onClick();
    expect(push).toHaveBeenCalledWith("/settings/restrictions/rules/r1");
    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    shown.action.onClick();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1][0]).toBe("/selling-restrictions/r1/targets/remove");
    expect(mockPost.mock.calls[1][1]).toEqual(
      expect.objectContaining({ productIds: ["p3", "p4", "p5", "p6", "p7", "p8"] }),
    );
  });

  it("when nothing was added the toast says so and offers no Undo", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({
      data: { added: 0, skippedIds: ids(8), addedTargetIds: [], activeTargets: 12 },
    });
    open();
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    await user.click(screen.getByRole("button", { name: "Add 8 products" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("Nothing changed. All 8 were already in it.");
    expect(shown.action).toBeUndefined();
  });

  it("a rule the product is already in cannot be picked", async () => {
    open({ productIds: ["p1"], alreadyInRuleIds: ["r1"] });
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: /vape ban tx/i })).toBeDisabled();
    expect(within(dialog).getByText("Already in this rule.")).toBeInTheDocument();
  });

  it("RULE_TARGET_LIMIT names the cap in plain words and keeps the dialog open", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue({
      response: { status: 400, data: { code: "RULE_TARGET_LIMIT", field: "rule", max: 5000 } },
    });
    const { onClose } = open();
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    await user.click(screen.getByRole("button", { name: "Add 8 products" }));
    expect(await screen.findByText(/a rule can cover up to 5,000 products/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("more than 1,000 products cannot be sent: says so and disables the pick", async () => {
    open({ productIds: ids(1001) });
    expect(await screen.findByText("Select up to 1,000 products at a time.")).toBeInTheDocument();
  });
});

describe("RuleChooserDialog, remove mode", () => {
  it("lists only the rules that hold some of the products, with `holds 5 of your 8`", async () => {
    open({ mode: "remove" });
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: /vape ban tx/i })).toBeInTheDocument();
    expect(within(dialog).getByText("holds 5 of your 8")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /summer promo/i })).toBeNull();
    expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/holding", { productIds: ids(8) });
    expect(mockGet).not.toHaveBeenCalledWith("/selling-restrictions", expect.anything());
  });

  it("nothing holds them: an honest empty state", async () => {
    mockPost.mockResolvedValue({ data: { items: [] } });
    open({ mode: "remove" });
    expect(
      await screen.findByText("None of these products is in a rule on its own."),
    ).toBeInTheDocument();
  });

  it("removes, toasts `5 removed` with Undo that re-adds, and View rule", async () => {
    const user = userEvent.setup();
    mockPost.mockImplementation(async (url: string) => {
      if (url === "/selling-restrictions/holding")
        return { data: { items: [{ rule: RULES[0], holds: 5 }] } };
      if (url === "/selling-restrictions/r1/targets/remove")
        return { data: { removed: 5, notInRule: ["p6", "p7", "p8"], activeTargets: 7 } };
      return { data: { added: 5, skippedIds: [], addedTargetIds: [], activeTargets: 12 } };
    });
    open({ mode: "remove" });
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    expect(screen.getByText("Remove 5 products from “Vape ban TX”?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove 5 products" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/r1/targets/remove", {
      productIds: ids(8),
    });
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("5 removed");
    expect(shown.action.label).toBe("Undo");
    expect(shown.secondaryAction.label).toBe("View rule");

    shown.action.onClick();
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/r1/targets", {
        productIds: ["p1", "p2", "p3", "p4", "p5"],
      }),
    );
  });

  it("RULE_NEEDS_A_TARGET offers to lift the rule instead, with a link to it", async () => {
    const user = userEvent.setup();
    mockPost.mockImplementation(async (url: string) => {
      if (url === "/selling-restrictions/holding")
        return { data: { items: [{ rule: RULES[0], holds: 5 }] } };
      throw { response: { status: 409, data: { code: "RULE_NEEDS_A_TARGET" } } };
    });
    const { onClose } = open({ mode: "remove" });
    await user.click(await screen.findByRole("button", { name: /vape ban tx/i }));
    await user.click(screen.getByRole("button", { name: "Remove 5 products" }));
    expect(
      await screen.findByText(
        "This would leave “Vape ban TX” covering nothing. Lift the rule instead?",
      ),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /go to the rule/i });
    expect(link).toHaveAttribute("href", "/settings/restrictions/rules/r1");
    expect(onClose).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
