import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { LimitInPortalDialog } from "./LimitInPortalDialog";

/**
 * "Limit in portal…" (state-restrictions UX spec §2, C a–d): the title and the primary track the count and the
 * choice, the primary stays disabled until a state is picked, a server error keeps the input and says so in the
 * footer, and the toast Undo lifts exactly the rows this batch created.
 */
const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => mockPost(...a),
    get: (...a: unknown[]) => mockGet(...a),
  },
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "TENANT_ADMIN" } }),
}));

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

function open(props: Partial<React.ComponentProps<typeof LimitInPortalDialog>> = {}) {
  const onClose = jest.fn();
  const onDone = jest.fn();
  renderWithProviders(
    <LimitInPortalDialog
      open
      scope={{ kind: "products", productIds: ids(12) }}
      onClose={onClose}
      onDone={onDone}
      {...props}
    />,
  );
  return { onClose, onDone };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockImplementation(async (url: string) => {
    if (url.includes("unknown-state-customers"))
      return {
        data: {
          noAddress: { total: 3, rows: [], nextCursor: null },
          unusableState: { total: 1, rows: [], nextCursor: null },
          needsReview: { total: 0, rows: [], nextCursor: null },
        },
      };
    if (url === "/settings/restrictions") return { data: { enabled: false } };
    return { data: [] };
  });
});

async function pickTexas(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: /search states/i }), "tex");
  await user.click(screen.getByRole("checkbox", { name: /texas/i }));
}

describe("LimitInPortalDialog (C a-d)", () => {
  it("(a) the title and the primary track the count and the choice", async () => {
    const user = userEvent.setup();
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Limit 12 products in your portal")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^hide from/i })).toBeInTheDocument();

    await pickTexas(user);
    expect(within(dialog).getByRole("button", { name: "Hide from Texas" })).toBeEnabled();
    expect(
      within(dialog).getByText(
        "Customers in Texas won't see these 12 products in the portal. Your staff can still sell them.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: /all portal customers/i }));
    expect(within(dialog).getByRole("button", { name: "Hide from everyone" })).toBeEnabled();
  });

  it("(a) a category scope names the category and the later-added products", () => {
    open({
      scope: { kind: "category", categoryId: "c1", categoryName: "Vapes", productCount: 38 },
    });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Limit “Vapes” in your portal")).toBeInTheDocument();
  });

  it("the category live line is the spec's sentence", async () => {
    const user = userEvent.setup();
    open({
      scope: { kind: "category", categoryId: "c1", categoryName: "Vapes", productCount: 38 },
    });
    await pickTexas(user);
    expect(
      screen.getByText(
        "Customers in Texas won't see the 38 products labelled Vapes, or any you label later.",
      ),
    ).toBeInTheDocument();
  });

  it("a legal ban stops promising that staff can still sell them", async () => {
    const user = userEvent.setup();
    open();
    await pickTexas(user);
    await user.click(screen.getByRole("checkbox", { name: /legal ban/i }));
    expect(screen.queryByText(/your staff can still sell them/i)).toBeNull();
    expect(screen.getByText(/staff orders and invoices are blocked too/i)).toBeInTheDocument();
  });

  it("when every product already had the limit: says so, and offers no Undo", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ data: { created: 0, skipped: 12, createdIds: [] } });
    open();
    await pickTexas(user);
    await user.click(screen.getByRole("button", { name: "Hide from Texas" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe(
      "Nothing changed. 12 products were already hidden from Texas portal customers.",
    );
    expect(shown.action).toBeUndefined();
  });

  it("(b) the primary is disabled until a state is chosen", async () => {
    const user = userEvent.setup();
    open();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^hide from/i })).toBeDisabled();
    await pickTexas(user);
    expect(within(dialog).getByRole("button", { name: "Hide from Texas" })).toBeEnabled();
  });

  it("(b) more than 200 rows: the cap sentence, and no way to submit", () => {
    open({ scope: { kind: "products", productIds: ids(201) } });
    expect(
      screen.getByText("Select up to 200 products, or limit a whole category instead."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^hide from/i })).toBeDisabled();
  });

  it("(c) a server error keeps the input and says nothing was changed", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    const { onClose } = open();
    const dialog = screen.getByRole("dialog");
    await pickTexas(user);
    await user.type(within(dialog).getByLabelText(/note/i), "Not licensed in TX");
    await user.click(within(dialog).getByRole("button", { name: "Hide from Texas" }));

    expect(
      await within(dialog).findByText("Couldn't save. Nothing was changed. Try again."),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText(/note/i)).toHaveValue("Not licensed in TX");
    expect(within(dialog).getByRole("button", { name: "Hide from Texas" })).toBeEnabled();
  });

  it("sends one bulk request: the products, the state, the note, and surface BUYER_PORTAL", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({
      data: { created: 12, skipped: 0, unknownStateCustomerCount: 4, createdIds: ids(12) },
    });
    open();
    await pickTexas(user);
    await user.type(screen.getByLabelText(/note/i), "Not licensed in TX");
    await user.click(screen.getByRole("button", { name: "Hide from Texas" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/bulk", {
      productIds: ids(12),
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "BUYER_PORTAL",
      reason: "Not licensed in TX",
    });
  });

  it("Legal ban makes the rule apply to every sale (surface ALL)", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({
      data: { created: 12, skipped: 0, unknownStateCustomerCount: 0, createdIds: ids(12) },
    });
    open();
    await pickTexas(user);
    await user.click(screen.getByRole("checkbox", { name: /legal ban/i }));
    expect(
      screen.getByText("Staff orders are blocked once enforcement is on."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide from Texas" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost.mock.calls[0][1]).toEqual(expect.objectContaining({ surface: "ALL" }));
  });

  it("(d) the toast Undo lifts exactly the created ids with the fixed reason", async () => {
    const user = userEvent.setup();
    mockPost
      .mockResolvedValueOnce({
        data: { created: 10, skipped: 2, unknownStateCustomerCount: 0, createdIds: ids(10) },
      })
      .mockResolvedValueOnce({ data: { lifted: 10 } });
    const { onDone } = open();
    await pickTexas(user);
    await user.click(screen.getByRole("button", { name: "Hide from Texas" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("10 products hidden from Texas portal customers. 2 already were.");
    expect(shown.action.label).toBe("Undo");
    expect(shown.secondaryAction.label).toBe("View limits");
    shown.secondaryAction.onClick();
    expect(push).toHaveBeenCalledWith("/settings/restrictions/rules");
    expect(shown.duration).toBe(10_000);
    expect(onDone).toHaveBeenCalled();

    shown.action.onClick();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost.mock.calls[1]).toEqual([
      "/selling-restrictions/lift-batch",
      { ids: ids(10), reason: "Undone right after creating" },
    ]);
  });
});
