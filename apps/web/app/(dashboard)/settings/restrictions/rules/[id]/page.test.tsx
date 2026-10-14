import * as React from "react";
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import RuleDetailPage from "./page";

/**
 * Row 509 rule detail. The REAL global mutation handler (app/providers.tsx) runs around the REAL page,
 * only the network is mocked, so "exactly one toast per failure" is observable on `toast`.
 */
const get = jest.fn();
const post = jest.fn();
const put = jest.fn();
const toast = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useParams: () => ({ id: "r1" }),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
let role = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
}));

const target = (n: number, over: Record<string, unknown> = {}) => ({
  id: `t${n}`,
  kind: "PRODUCT",
  productId: `p${n}`,
  categoryId: null,
  name: `Sample Pod - Flavor ${n}`,
  sku: `SP${n}`,
  isFamily: false,
  variantCount: null,
  addedAt: "2026-10-01T12:00:00Z",
  addedByName: "Pat Admin",
  ...over,
});
const TARGETS = [target(1), target(2), target(3)];
const detail = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  tenantId: "t0",
  categoryId: null,
  productId: null,
  categoryName: null,
  productName: null,
  jurisdiction: "STATE",
  states: ["TX", "CA"],
  surface: "ALL",
  effectiveFrom: "2026-03-05T12:00:00Z",
  effectiveTo: null,
  reason: "State ban on pods",
  createdById: "u1",
  createdByName: "Pat Admin",
  createdAt: "2026-03-04T12:00:00Z",
  liftedById: null,
  liftedByName: null,
  liftedAt: null,
  liftReason: null,
  status: "ACTIVE",
  revision: 2,
  targetSummary: { products: 3, categories: 0, preview: [] },
  targets: TARGETS,
  nextCursor: null,
  revisions: [
    {
      revision: 2,
      jurisdiction: "STATE",
      states: ["TX", "CA"],
      surface: "ALL",
      effectiveFrom: "2026-03-05T12:00:00Z",
      effectiveTo: null,
      reason: "State ban on pods",
      editedByName: "Sam Admin",
      editedAt: "2026-10-05T12:00:00Z",
      note: "Added California",
    },
    {
      revision: 1,
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "ALL",
      effectiveFrom: "2026-03-05T12:00:00Z",
      effectiveTo: null,
      reason: "State ban on pods",
      editedByName: "Pat Admin",
      editedAt: "2026-03-04T12:00:00Z",
      note: null,
    },
  ],
  targetEvents: [
    { kind: "ADDED", count: 3, byName: "Pat Admin", at: "2026-10-01T12:00:00Z", reason: null },
    {
      kind: "REMOVED",
      count: 1,
      byName: "Sam Admin",
      at: "2026-10-02T12:00:00Z",
      reason: "Discontinued",
    },
  ],
  ...over,
});

const PICK_PRODUCTS = [
  { id: "p9", name: "Gummies 10ct", sku: "G10", kind: "STANDARD" },
  { id: "p8", name: "Gummy Chews", sku: "GC", kind: "STANDARD" },
];
let current: any;
const serve = () =>
  get.mockImplementation((url: string, cfg?: { params?: { cursor?: string } }) => {
    if (url === "/selling-restrictions/r1") {
      const d = typeof current === "function" ? current(cfg?.params?.cursor) : current;
      return Promise.resolve({ data: d });
    }
    if (url === "/product-categories") return Promise.resolve({ data: [] });
    if (url === "/products") return Promise.resolve({ data: { data: PICK_PRODUCTS } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
const reject = (status: number, data: object) =>
  Object.assign(new Error("Request failed"), { response: { status, data } });

const open = async () => {
  render(
    <Providers>
      <RuleDetailPage />
    </Providers>,
  );
  await screen.findByRole("heading", { name: /Products & labels \(/ });
};
const tick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name }));

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  current = detail();
  serve();
});

describe("rule detail: what it shows", () => {
  it("says what the rule does, its status, who can lift it, and counts its products", async () => {
    await open();
    expect(screen.getByText("Banned in Texas and California · All sales")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Products & labels (3)" })).toBeInTheDocument();
    for (const n of [1, 2, 3])
      expect(screen.getByText(`Sample Pod - Flavor ${n}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lift rule" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Portal limits & rules/ })).toHaveAttribute(
      "href",
      "/settings/restrictions/rules",
    );
  });

  it("shows the read-only settings with an Edit settings button, and the history", async () => {
    await open();
    expect(screen.getByText("State ban on pods", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeEnabled();
    const history = screen.getByRole("list", { name: "History" });
    expect(within(history).getByText(/3 added by Pat Admin/)).toBeInTheDocument();
    expect(within(history).getByText(/1 removed by Sam Admin/)).toBeInTheDocument();
    expect(within(history).getByText("Discontinued")).toBeInTheDocument();
    expect(within(history).getByText(/Settings changed by Sam Admin/)).toBeInTheDocument();
    expect(within(history).getByText("Added California")).toBeInTheDocument();
    expect(within(history).getByText(/Rule created by Pat Admin/)).toBeInTheDocument();
  });

  it("a family row says it covers its variants; a label row is marked as a label", async () => {
    current = detail({
      targets: [
        target(1, { name: "Sample Pod", isFamily: true, variantCount: 4 }),
        { ...target(2), kind: "CATEGORY", productId: null, categoryId: "c1", name: "Vapes" },
      ],
      targetSummary: { products: 1, categories: 1, preview: [] },
    });
    await open();
    expect(screen.getByText("Includes all 4 variants")).toBeInTheDocument();
    expect(screen.getByText("Label")).toBeInTheDocument();
  });

  it("searches within the loaded products", async () => {
    await open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search these products" }), {
      target: { value: "flavor 2" },
    });
    expect(screen.queryByText("Sample Pod - Flavor 1")).toBeNull();
    expect(screen.getByText("Sample Pod - Flavor 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search these products" }), {
      target: { value: "nothing like it" },
    });
    expect(screen.getByText("No products match your search")).toBeInTheDocument();
  });

  it("a rule that cannot be loaded says so, with a retry", async () => {
    get.mockRejectedValue({ response: { status: 404 } });
    render(
      <Providers>
        <RuleDetailPage />
      </Providers>,
    );
    expect(await screen.findByText("This rule no longer exists.")).toBeInTheDocument();
  });

  it("keyset paging: Show more fetches the next page by cursor and appends it", async () => {
    current = (cursor?: string) =>
      cursor === "cur2"
        ? detail({ targets: [target(3)], nextCursor: null })
        : detail({ targets: [target(1), target(2)], nextCursor: "cur2" });
    await open();
    expect(screen.queryByText("Sample Pod - Flavor 3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Sample Pod - Flavor 3")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/selling-restrictions/r1", { params: { cursor: "cur2" } });
    expect(screen.getByText("Sample Pod - Flavor 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("rule detail: add products", () => {
  const openAdd = async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add products" }));
    await screen.findByRole("dialog", { name: "Add products" });
  };
  const pick = async (term: string, name: RegExp) => {
    fireEvent.change(screen.getByRole("combobox", { name: "Search products" }), {
      target: { value: term },
    });
    fireEvent.click(await screen.findByRole("option", { name }, { timeout: 3000 }));
  };

  it("opens with focus in the search, and Escape gives focus back to the button", async () => {
    await open();
    const opener = screen.getByRole("button", { name: "Add products" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Add products" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Search products" })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("Add products is the one primary; the picker adds several, then one click saves them", async () => {
    post.mockResolvedValueOnce({
      data: { added: 2, skippedIds: [], addedTargetIds: ["x", "y"], activeTargets: 5 },
    });
    await openAdd();
    const submit = screen.getByRole("button", { name: "Add" });
    expect(submit).toBeDisabled();
    await pick("gum", /Gummies 10ct/);
    await pick("gum", /Gummy Chews/);
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/targets", {
        productIds: ["p9", "p8"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add products" })).toBeNull());
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "2 added", variant: "success" });
    expect(toast.mock.calls[0][0].action.label).toBe("Undo");
  });

  it("Undo removes exactly what was added", async () => {
    post.mockResolvedValueOnce({
      data: { added: 2, skippedIds: [], addedTargetIds: ["x", "y"], activeTargets: 5 },
    });
    post.mockResolvedValueOnce({ data: { removed: 2, notInRule: [], activeTargets: 3 } });
    await openAdd();
    await pick("gum", /Gummies 10ct/);
    await pick("gum", /Gummy Chews/);
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    toast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith("/selling-restrictions/r1/targets/remove", {
      productIds: ["p9", "p8"],
      reason: "Undone right after adding",
    });
  });

  it("products the rule already had are reported, and Undo leaves them alone", async () => {
    post.mockResolvedValueOnce({
      data: { added: 1, skippedIds: ["p8"], addedTargetIds: ["x"], activeTargets: 4 },
    });
    post.mockResolvedValueOnce({ data: { removed: 1, notInRule: [], activeTargets: 3 } });
    await openAdd();
    await pick("gum", /Gummies 10ct/);
    await pick("gum", /Gummy Chews/);
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].title).toBe("1 added · 1 already in it");
    toast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({ productIds: ["p9"] });
  });

  it("products already shown in the rule are disabled in the picker (In rule)", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/selling-restrictions/r1") return Promise.resolve({ data: current });
      if (url === "/product-categories") return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: { data: [{ id: "p1", name: "Sample Pod - Flavor 1", kind: "STANDARD" }] },
      });
    });
    await openAdd();
    fireEvent.change(screen.getByRole("combobox", { name: "Search products" }), {
      target: { value: "sample" },
    });
    const row = await screen.findByRole("option", { name: /Flavor 1/ }, { timeout: 3000 });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("In rule")).toBeInTheDocument();
  });

  it("a refused add raises exactly ONE toast (fixed copy, never the server sentence) and keeps the dialog", async () => {
    post.mockRejectedValueOnce(
      reject(409, {
        code: "RULE_TARGETS_NOT_FOUND",
        message: "raw server sentence",
        notFoundIds: ["p9"],
      }),
    );
    await openAdd();
    await pick("gum", /Gummies 10ct/);
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).not.toMatch(/raw server sentence/);
    expect(toast.mock.calls[0][0].title).toMatch(/no longer exists/);
    expect(screen.getByRole("dialog", { name: "Add products" })).toBeInTheDocument();
  });
});

describe("rule detail: remove products", () => {
  it("Remove N appears only once rows are ticked; Clear drops the ticks", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /^Remove \d/ })).toBeNull();
    tick("Select Sample Pod - Flavor 1");
    expect(screen.getByRole("button", { name: "Remove 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: /^Remove \d/ })).toBeNull();
  });

  it("confirms with an optional reason, removes, and Undo puts them back", async () => {
    post.mockResolvedValueOnce({ data: { removed: 2, notInRule: [], activeTargets: 1 } });
    post.mockResolvedValueOnce({
      data: { added: 2, skippedIds: [], addedTargetIds: ["a", "b"], activeTargets: 3 },
    });
    await open();
    tick("Select Sample Pod - Flavor 1");
    tick("Select Sample Pod - Flavor 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove 2" }));
    const dlg = await screen.findByRole("dialog", { name: "Remove 2 from this rule?" });
    fireEvent.change(within(dlg).getByLabelText("Reason (optional)"), {
      target: { value: "  Discontinued  " },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/targets/remove", {
        productIds: ["p1", "p2"],
        reason: "Discontinued",
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0]).toMatchObject({ title: "2 removed", variant: "success" });
    toast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith("/selling-restrictions/r1/targets", {
      productIds: ["p1", "p2"],
    });
  });

  it("with no reason typed, none is sent (the server's default stands)", async () => {
    post.mockResolvedValueOnce({ data: { removed: 1, notInRule: [], activeTargets: 2 } });
    await open();
    tick("Select Sample Pod - Flavor 3");
    fireEvent.click(screen.getByRole("button", { name: "Remove 1" }));
    const dlg = await screen.findByRole("dialog", { name: "Remove 1 from this rule?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ productIds: ["p3"] });
  });

  it("removing a label sends categoryIds, and Undo re-adds it as one", async () => {
    current = detail({
      targets: [
        target(1),
        { ...target(2), kind: "CATEGORY", productId: null, categoryId: "c1", name: "Vapes" },
      ],
      targetSummary: { products: 1, categories: 1, preview: [] },
    });
    post.mockResolvedValueOnce({ data: { removed: 1, notInRule: [], activeTargets: 1 } });
    post.mockResolvedValueOnce({
      data: { added: 1, skippedIds: [], addedTargetIds: ["a"], activeTargets: 2 },
    });
    await open();
    tick("Select Vapes");
    fireEvent.click(screen.getByRole("button", { name: "Remove 1" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toEqual({ categoryIds: ["c1"] });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    toast.mock.calls[0][0].action.onClick();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toEqual({ categoryIds: ["c1"] });
  });
});

describe("rule detail: the last product", () => {
  it("removing every product asks to lift the rule instead, and sends nothing", async () => {
    await open();
    tick("Select all shown");
    fireEvent.click(screen.getByRole("button", { name: "Remove 3" }));
    const guard = await screen.findByRole("alert");
    expect(guard).toHaveTextContent("This rule would cover nothing. Lift the rule instead?");
    expect(screen.queryByRole("dialog", { name: /Remove 3/ })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    // the ticks are still there: nothing was lost
    expect(screen.getByRole("button", { name: "Remove 3" })).toBeInTheDocument();
  });

  it("[Lift rule] in the guard opens the existing lift dialog", async () => {
    await open();
    tick("Select all shown");
    fireEvent.click(screen.getByRole("button", { name: "Remove 3" }));
    const guard = await screen.findByRole("alert");
    fireEvent.click(within(guard).getByRole("button", { name: "Lift rule" }));
    expect(await screen.findByRole("dialog", { name: "Lift this rule?" })).toBeInTheDocument();
  });

  it("the server's 409 RULE_NEEDS_A_TARGET lands on the same guard, with NO toast", async () => {
    post.mockRejectedValueOnce(reject(409, { code: "RULE_NEEDS_A_TARGET", message: "raw" }));
    await open();
    tick("Select Sample Pod - Flavor 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove 1" }));
    const dlg = await screen.findByRole("dialog", { name: "Remove 1 from this rule?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    const guard = await screen.findByRole("alert");
    expect(guard).toHaveTextContent("This rule would cover nothing. Lift the rule instead?");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("rule detail: roles, ended rules", () => {
  it("an operator on a rule that applies everywhere (L5) cannot add, remove or edit, and is told why", async () => {
    role = "OPERATOR";
    current = detail({ jurisdiction: "FEDERAL", states: [] });
    await open();
    expect(screen.getByRole("button", { name: "Add products" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Select Sample Pod - Flavor 1" })).toBeDisabled();
    expect(
      screen.getAllByText("Only an account admin can change a rule that applies everywhere.")
        .length,
    ).toBeGreaterThan(0);
  });

  it("an operator on a state rule can add, remove and edit", async () => {
    role = "OPERATOR";
    await open();
    expect(screen.getByRole("button", { name: "Add products" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Select Sample Pod - Flavor 1" })).toBeEnabled();
    // lifting the whole rule stays with the account admin
    expect(screen.queryByRole("button", { name: "Lift rule" })).toBeNull();
  });

  it("an account admin can change an everywhere rule", async () => {
    current = detail({ jurisdiction: "FEDERAL", states: [] });
    await open();
    expect(screen.getByRole("button", { name: "Add products" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeEnabled();
  });

  it("a lifted rule is read-only: the list shows, nothing can be changed", async () => {
    current = detail({
      status: "LIFTED",
      liftedAt: "2026-04-01T12:00:00Z",
      liftedByName: "Sam Admin",
      liftReason: "Law repealed",
    });
    await open();
    expect(screen.getByText("Lifted", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Sample Pod - Flavor 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add products" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lift rule" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.getByText("This rule has ended, so its list can't be changed."),
    ).toBeInTheDocument();
  });
});
