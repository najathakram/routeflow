import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CustomersWithoutState } from "./CustomersWithoutState";

/**
 * Addendum D (C rows): the amber "Customers without a state on file" card fixes customers in place: a row per
 * customer under each bucket, Save removes the row and decrements the counts at once, an error keeps the input,
 * Enter saves and moves to the next row, read-only shows no Save, and nothing is red.
 */
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
  },
}));
let mockReadOnly = false;
jest.mock("@/lib/read-only-gate", () => ({
  ...jest.requireActual("@/lib/read-only-gate"),
  useReadOnlyGate: () => ({
    readOnly: mockReadOnly,
    line: mockReadOnly ? "Read-only." : null,
    hintId: "h",
  }),
  ReadOnlyHint: () => (mockReadOnly ? <p data-testid="read-only-line">Read-only.</p> : null),
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));

const row = (id: string, over: Record<string, unknown> = {}) => ({
  customerId: `c-${id}`,
  name: `Customer ${id}`,
  addressId: null,
  addressText: null,
  suggestedState: null,
  ...over,
});
const bucket = (rows: unknown[], total = rows.length) => ({ total, rows, nextCursor: null });
const data = (over: Record<string, unknown> = {}) => ({
  noAddress: bucket([row("a"), row("b"), row("c")]),
  unusableState: bucket([
    row("u", {
      addressId: "ad-u",
      addressText: "12 Main St, Dallas, Texs 75201",
      suggestedState: "TX",
    }),
  ]),
  needsReview: bucket([
    row("r", { addressId: "ad-r", addressText: "Dallas, Tx 75201", suggestedState: "TX" }),
  ]),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReadOnly = false;
  mockGet.mockResolvedValue({ data: data() });
  mockPost.mockResolvedValue({ data: { customerId: "c-a", addressId: "ad", state: "TX" } });
  mockPatch.mockResolvedValue({ data: { customerId: "c-u", addressId: "ad-u", state: "TX" } });
});

const openBucket = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  const btn = await screen.findByRole("button", { name });
  await user.click(btn);
};

describe("CustomersWithoutState (Addendum D)", () => {
  it("shows the header count and one collapsed disclosure per bucket, with Fix / Review", async () => {
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(
      await screen.findByText(
        "5 customers need a state. They can still order — state limits just can't reach them until it's set.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("3 have no address")).toBeInTheDocument();
    expect(screen.getByText("1 address has no usable state")).toBeInTheDocument();
    expect(screen.getByText("1 address needs a state check")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fix" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByText("Customer a")).toBeNull();
  });

  it("is amber, never red", async () => {
    renderWithProviders(<CustomersWithoutState canFix />);
    const card = await screen.findByTestId("customers-without-state");
    expect(card.className).toMatch(/warning/);
    expect(card.className).not.toMatch(/danger|red/);
  });

  it("all clear reads `Every customer has a state on file.` and has no Check readiness button", async () => {
    mockGet.mockResolvedValue({
      data: {
        noAddress: bucket([]),
        unusableState: bucket([]),
        needsReview: bucket([]),
      },
    });
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(await screen.findByText("Every customer has a state on file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check readiness/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("Save on a no-address row creates the minimal address, removes the row and decrements the counts", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    const first = screen.getByTestId("state-row-c-a");
    await user.selectOptions(within(first).getByLabelText(/state for customer a/i), "TX");
    await user.type(within(first).getByLabelText(/zip/i), "75201");
    await user.click(within(first).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/customers/c-a/addresses/minimal", {
        state: "TX",
        zip: "75201",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("state-row-c-a")).toBeNull());
    expect(screen.getByText("2 have no address")).toBeInTheDocument();
    expect(screen.getByText(/^4 customers need a state\./)).toBeInTheDocument();
  });

  it("an error keeps the row and the input, with the message under the field", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    const first = screen.getByTestId("state-row-c-a");
    await user.selectOptions(within(first).getByLabelText(/state for customer a/i), "NY");
    await user.click(within(first).getByRole("button", { name: "Save" }));

    expect(await within(first).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId("state-row-c-a")).toBeInTheDocument();
    expect(within(first).getByLabelText(/state for customer a/i)).toHaveValue("NY");
    expect(toast).not.toHaveBeenCalled();
  });

  it("Enter saves, and focus lands on the next row's state field", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    const first = screen.getByTestId("state-row-c-a");
    const select = within(first).getByLabelText(/state for customer a/i);
    await user.selectOptions(select, "TX");
    select.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("state-row-c-b")).getByLabelText(/state for customer b/i),
      ).toHaveFocus(),
    );
  });

  it("an unusable-state row prefills the suggested state and saves with PATCH", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /1 address has no usable state/);
    const r = screen.getByTestId("state-row-c-u");
    expect(within(r).getByText("12 Main St, Dallas, Texs 75201")).toBeInTheDocument();
    expect(within(r).getByLabelText(/state for customer u/i)).toHaveValue("TX");
    await user.click(within(r).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/c-u/addresses/ad-u/state", {
        state: "TX",
      }),
    );
  });

  it("a review row says what we read, and `Looks right` confirms it", async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValueOnce({
      data: { customerId: "c-r", addressId: "ad-r", state: "TX" },
    });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /1 address needs a state check/);
    const r = screen.getByTestId("state-row-c-r");
    expect(within(r).getByText('We read TX from "Dallas, Tx 75201"')).toBeInTheDocument();
    await user.click(within(r).getByRole("button", { name: "Looks right" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/c-r/addresses/ad-r/state", {
        state: "TX",
        confirmReview: true,
      }),
    );
  });

  it("read-only: rows render with no Save, and the shared read-only line shows", async () => {
    const user = userEvent.setup();
    mockReadOnly = true;
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    expect(screen.getByTestId("read-only-line")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /set state for all shown/i })).toBeNull();
  });

  it("a user who cannot fix sees the list without any control", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersWithoutState canFix={false} />);
    await openBucket(user, /3 have no address/);
    expect(screen.getByText("Customer a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Set state for all shown… confirms the exact count, applies one state, and Undo restores", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ data: { changed: 3, changedAddressIds: ["x1", "x2", "x3"] } });
    mockPost.mockResolvedValueOnce({ data: { restored: 3 } });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    await user.click(screen.getByRole("button", { name: /set state for all shown/i }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/state/i), "TX");
    expect(within(dialog).getByText("Set Texas for 3 customers?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Set state" }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        "/settings/restrictions/unknown-state-customers/bulk-state",
        { bucket: "noAddress", customerIds: ["c-a", "c-b", "c-c"], state: "TX" },
      ),
    );
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const shown = toast.mock.calls[0][0];
    expect(shown.title).toBe("Texas set for 3 customers");
    expect(shown.action.label).toBe("Undo");
    expect(shown.duration).toBe(10_000);
    await shown.action.onClick();
    await waitFor(() =>
      expect(mockPost).toHaveBeenLastCalledWith(
        "/settings/restrictions/unknown-state-customers/bulk-state/undo",
        { changedAddressIds: ["x1", "x2", "x3"] },
      ),
    );
  });
});
