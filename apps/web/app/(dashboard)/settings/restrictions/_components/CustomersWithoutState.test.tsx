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
    mockPost.mockResolvedValueOnce({
      data: { changed: 3, changedAddressIds: ["x1", "x2", "x3"], actionId: "act-1" },
    });
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
        { actionId: "act-1", changedAddressIds: ["x1", "x2", "x3"] },
      ),
    );
  });

  it("after a bulk Undo the bucket is back (the card re-reads; the list that raised it is gone)", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({
      data: { changed: 3, changedAddressIds: ["x1", "x2", "x3"], actionId: "act-1" },
    });
    mockPost.mockResolvedValueOnce({ data: { restored: 3 } });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    await user.click(screen.getByRole("button", { name: /set state for all shown/i }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/state/i), "TX");
    await user.click(within(dialog).getByRole("button", { name: "Set state" }));
    await waitFor(() => expect(screen.queryByText("3 have no address")).toBeNull());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    toast.mock.calls[0][0].action.onClick();
    expect(await screen.findByText("3 have no address")).toBeInTheDocument();
  });

  it("a refresh after saving rows never subtracts them twice", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    const first = screen.getByTestId("state-row-c-a");
    await user.selectOptions(within(first).getByLabelText(/state for customer a/i), "TX");
    await user.click(within(first).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("2 have no address")).toBeInTheDocument());
    // the server now agrees: two left
    mockGet.mockResolvedValue({
      data: data({ noAddress: bucket([row("b"), row("c")]) }),
    });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("2 have no address")).toBeInTheDocument());
    expect(screen.queryByText("1 has no address")).toBeNull();
  });

  it("the header counts distinct customers (customersTotal), not address rows", async () => {
    mockGet.mockResolvedValue({
      data: data({ customersTotal: 4 }),
    });
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(await screen.findByText(/^4 customers need a state\./)).toBeInTheDocument();
    // bucket rows keep their own counts
    expect(screen.getByText("3 have no address")).toBeInTheDocument();
  });

  it("shows one business-state line with a link when a legal ban cannot be judged", async () => {
    mockGet.mockResolvedValue({ data: data({ businessStateMissing: true }) });
    renderWithProviders(<CustomersWithoutState canFix />);
    const line = await screen.findByTestId("business-state-missing");
    expect(line).toHaveTextContent(
      "Add your business address in Settings › Business so counter sales can check state rules.",
    );
    expect(within(line).getByRole("link", { name: "Add business address" })).toHaveAttribute(
      "href",
      "/settings?tab=profile",
    );
  });

  it("shows no business-state line otherwise", async () => {
    renderWithProviders(<CustomersWithoutState canFix />);
    await screen.findByText(/need a state/);
    expect(screen.queryByTestId("business-state-missing")).toBeNull();
  });
});

describe("CustomersWithoutState: needsDefault (row 414)", () => {
  const choice = (id: string, text: string, type: string, state: string | null) => ({
    addressId: id,
    addressText: text,
    addressType: type,
    state,
    isDefault: false,
  });
  const nd = (id: string) =>
    row(id, {
      choices: [
        choice(`ad-${id}1`, "1 Main St, Dallas, TX", "BILLING", "TX"),
        choice(`ad-${id}2`, "9 Elm St, Albany, NY", "SHIPPING", "NY"),
      ],
    });
  const withDefaults = (rows: unknown[]) =>
    data({
      noAddress: bucket([]),
      unusableState: bucket([]),
      needsReview: bucket([]),
      needsDefault: bucket(rows),
      customersTotal: rows.length,
    });

  it("the disclosure row reads the exact copy, pluralised, with `Choose default`", async () => {
    mockGet.mockResolvedValue({ data: withDefaults([nd("d"), nd("e")]) });
    const { unmount } = renderWithProviders(<CustomersWithoutState canFix />);
    expect(
      await screen.findByText("2 customers have more than one address and no default"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose default" })).toBeInTheDocument();
    unmount();
    mockGet.mockResolvedValue({ data: withDefaults([nd("d")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(
      await screen.findByText("1 customer has more than one address and no default"),
    ).toBeInTheDocument();
  });

  it("expanded: the supporting line and hint, a radio per address, Open customer, and no bulk set", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: withDefaults([nd("d")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address and no default/);
    expect(
      screen.getByText(
        "We can't tell which state applies. Legal bans still keep those products hidden, but other state limits won't reach them until you choose.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Choose the address that sets their state.")).toBeInTheDocument();
    const r = screen.getByTestId("state-row-c-d");
    expect(within(r).getAllByRole("radio")).toHaveLength(2);
    expect(within(r).getByLabelText("1 Main St, Dallas, TX · Billing · TX")).toBeInTheDocument();
    expect(within(r).getByRole("link", { name: "Open customer" })).toHaveAttribute(
      "href",
      "/customers/c-d",
    );
    expect(within(r).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /set state for all shown/i })).toBeNull();
  });

  it("Save sends only isDefault to the address PATCH; the refetch drops the row and sets the counts", async () => {
    const user = userEvent.setup();
    mockGet
      .mockResolvedValueOnce({ data: withDefaults([nd("d"), nd("e")]) })
      .mockResolvedValue({ data: withDefaults([nd("e")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /2 customers have more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    await user.click(within(r).getByLabelText(/Albany, NY/));
    await user.click(within(r).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/c-d/addresses/ad-d2", {
        isDefault: true,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("state-row-c-d")).toBeNull());
    expect(
      screen.getByText("1 customer has more than one address and no default"),
    ).toBeInTheDocument();
    expect(screen.getByText(/^1 customer needs a state\./)).toBeInTheDocument();
  });

  it("an error keeps the row and the choice, with the message under it", async () => {
    const user = userEvent.setup();
    mockPatch.mockRejectedValueOnce({ response: { status: 500, data: {} } });
    mockGet.mockResolvedValue({ data: withDefaults([nd("d")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    await user.click(within(r).getByLabelText(/Dallas, TX/));
    await user.click(within(r).getByRole("button", { name: "Save" }));
    expect(await within(r).findByText("Couldn't save. Try again.")).toBeInTheDocument();
    expect(within(r).getByLabelText(/Dallas, TX/)).toBeChecked();
  });

  it("Enter on a chosen address saves", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: withDefaults([nd("d"), nd("e")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    await user.click(within(r).getByLabelText(/Dallas, TX/));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/c-d/addresses/ad-d1", {
        isDefault: true,
      }),
    );
  });

  it("read-only: the choices render disabled with no Save; Open customer stays", async () => {
    const user = userEvent.setup();
    mockReadOnly = true;
    mockGet.mockResolvedValue({ data: withDefaults([nd("d")]) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    expect(within(r).queryByRole("button", { name: "Save" })).toBeNull();
    for (const radio of within(r).getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(within(r).getByRole("link", { name: "Open customer" })).toBeInTheDocument();
  });

  it("an older API without needsDefault still renders the other buckets", async () => {
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(await screen.findByText("3 have no address")).toBeInTheDocument();
    expect(screen.queryByText(/no default/)).toBeNull();
  });
});

describe("CustomersWithoutState: SA rows R2 + undo by action id", () => {
  it("a truncated list never reads as all clear (no check, the partial line instead)", async () => {
    mockGet.mockResolvedValue({
      data: {
        noAddress: bucket([]),
        unusableState: bucket([]),
        needsReview: bucket([]),
        needsDefault: bucket([]),
        customersTotal: 0,
        truncated: true,
      },
    });
    renderWithProviders(<CustomersWithoutState canFix />);
    expect(
      await screen.findByText(
        "Your customer list is too large to check all at once, so some customers may still need a state.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Every customer has a state on file.")).toBeNull();
  });

  it("a bulk set that changed nothing (actionId null) offers no Undo", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ data: { changed: 0, changedAddressIds: [], actionId: null } });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    await user.click(screen.getByRole("button", { name: /set state for all shown/i }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/state/i), "TX");
    await user.click(within(dialog).getByRole("button", { name: "Set state" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0].action).toBeUndefined();
  });
});

describe("CustomersWithoutState: SA C-M1 (needsDefault saves are server-truth)", () => {
  const choice = (id: string, text: string, state: string | null) => ({
    addressId: id,
    addressText: text,
    addressType: "BILLING",
    state,
    isDefault: false,
  });
  const ndRow = row("d", {
    choices: [choice("ad-1", "1 Main St, Dallas", "TX"), choice("ad-2", "Back lot", null)],
  });
  const only = (over: Record<string, unknown>) => ({
    noAddress: bucket([]),
    unusableState: bucket([]),
    needsReview: bucket([]),
    needsDefault: bucket([]),
    customersTotal: 0,
    truncated: false,
    ...over,
  });

  it("a choice with no state reads `No state` and cannot be chosen", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: only({ needsDefault: bucket([ndRow]), customersTotal: 1 }) });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    const blank = within(r).getByLabelText(/Back lot/);
    expect(within(r).getByText(/Back lot · Billing · No state/)).toBeInTheDocument();
    expect(blank).toBeDisabled();
    expect(within(r).getByLabelText(/1 Main St, Dallas/)).toBeEnabled();
  });

  it("after a default save the counts come from the refetch, never a local removal", async () => {
    const user = userEvent.setup();
    mockGet
      .mockResolvedValueOnce({ data: only({ needsDefault: bucket([ndRow]), customersTotal: 1 }) })
      // the server says the customer is still unresolved, now in another bucket
      .mockResolvedValue({
        data: only({
          unusableState: bucket([row("d", { addressId: "ad-1", addressText: "x" })]),
          customersTotal: 1,
        }),
      });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /more than one address/);
    const r = screen.getByTestId("state-row-c-d");
    await user.click(within(r).getByLabelText(/1 Main St, Dallas/));
    await user.click(within(r).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("1 address has no usable state")).toBeInTheDocument();
    expect(screen.getByText(/^1 customer needs a state\./)).toBeInTheDocument();
    expect(screen.queryByText("Every customer has a state on file.")).toBeNull();
  });

  it.each([409, 404])("an undo the API rejects (%i) shows `Couldn't undo`", async (status) => {
    const user = userEvent.setup();
    mockPost
      .mockResolvedValueOnce({
        data: { changed: 3, changedAddressIds: ["x1", "x2", "x3"], actionId: "act-1" },
      })
      .mockRejectedValueOnce({ response: { status, data: {} } });
    renderWithProviders(<CustomersWithoutState canFix />);
    await openBucket(user, /3 have no address/);
    await user.click(screen.getByRole("button", { name: /set state for all shown/i }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/state/i), "TX");
    await user.click(within(dialog).getByRole("button", { name: "Set state" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    toast.mock.calls[0][0].action.onClick();
    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith({
        title: "Couldn't undo. Nothing was changed.",
        variant: "error",
      }),
    );
  });
});
