import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  API_ERROR_CODES,
  NO_STORE_STATE_LINE,
  noStateOnFileLine,
  type RestrictionWarningError,
  type RestrictionWarningLine,
} from "@routeflow/types";
import { RestrictionWarningDialog } from "./RestrictionWarningDialog";
import {
  NO_STATE_FIXER_HREF,
  RestrictionRemedyActions,
  STORE_STATE_HREF,
} from "./RestrictionRemedyActions";
import { REMEDY_COPY, RESTRICTION_COPY } from "@/lib/api/restriction-warning";

/**
 * Row 672 (SA-844 R7, the jest half; the Playwright half at 1440/768/390 runs on the Windows stack): a warned line whose
 * state can't be resolved shows "No state on file for {customer}: add one" BESIDE the override (never instead of it).
 * The fixer opens in place for that customer, saves through the same writes as "Customers without a state", and "Check
 * the sale again" re-runs the save with no ack. A store with no state links to Settings > Business address.
 */
let mockCustomer: Record<string, unknown> = {};
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string, ...a: unknown[]) => mockGet(url, ...a),
    post: (url: string, ...a: unknown[]) => mockPost(url, ...a),
    patch: (url: string, ...a: unknown[]) => mockPatch(url, ...a),
  },
}));

const unresolved = (over: Partial<RestrictionWarningLine> = {}): RestrictionWarningLine => ({
  lineKey: "n:0",
  productId: "p1",
  displayName: "Acme Gummies",
  outcome: "INDETERMINATE",
  rules: [
    {
      id: "r1",
      states: ["CA"],
      legal: true,
      reasonText:
        "This customer's state can't be determined — add or correct the customer's address.",
    },
  ],
  remedy: "ADD_CUSTOMER_STATE",
  customerId: "cust-1",
  ...over,
});
const warningOf = (lines: RestrictionWarningLine[]): RestrictionWarningError => ({
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "This sale includes a restricted product.",
  warningHash: "rw1:abc",
  lines,
});

function open(lines: RestrictionWarningLine[]) {
  const onRecheck = jest.fn();
  const onConfirm = jest.fn();
  renderWithProviders(
    <RestrictionWarningDialog
      view={{ kind: "warning", warning: warningOf(lines) }}
      onConfirm={onConfirm}
      onCancel={jest.fn()}
      onRecheck={onRecheck}
    />,
  );
  return { onRecheck, onConfirm };
}

describe("RestrictionWarningDialog: the row-672 remedy beside the override", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomer = { id: "cust-1", businessName: "Acme Market", addresses: [] };
    mockGet.mockImplementation(async () => ({ data: mockCustomer }));
    mockPost.mockResolvedValue({ data: {} });
    mockPatch.mockResolvedValue({ data: {} });
  });

  it("names the customer and keeps 'Sell anyway' on screen (the remedy is beside the override, not instead)", async () => {
    open([unresolved()]);
    expect(
      await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RESTRICTION_COPY.sellAnyway })).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/customers/cust-1");
  });

  it("no address: saves the minimal default address with the chosen state, then 'Check the sale again' re-runs the save", async () => {
    const { onRecheck, onConfirm } = open([unresolved()]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    fireEvent.change(screen.getByLabelText(REMEDY_COPY.stateLabel), { target: { value: "NV" } });
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.save }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/customers/cust-1/addresses/minimal", { state: "NV" }),
    );
    expect(await screen.findByText(REMEDY_COPY.saved)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.checkAgain }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled(); // no ack: the server judges the cart afresh
  });

  it("the server-named governing address (e.g. a state awaiting review): sets and confirms the state on it", async () => {
    mockCustomer = {
      id: "cust-1",
      businessName: "Acme Market",
      addresses: [
        { id: "a-1", isDefault: true },
        { id: "a-2", isDefault: false },
      ],
    };
    open([unresolved({ addressId: "a-1" })]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    await screen.findByLabelText(REMEDY_COPY.stateLabel);
    fireEvent.change(screen.getByLabelText(REMEDY_COPY.stateLabel), { target: { value: "TX" } });
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.save }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/cust-1/addresses/a-1/state", {
        state: "TX",
        confirmReview: true,
      }),
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("one address and no default (SA-924): the engine reads it, so the state is set on it, not 'choose a default'", async () => {
    mockCustomer = {
      id: "cust-1",
      businessName: "Acme Market",
      addresses: [{ id: "a-9", isDefault: false }],
    };
    open([unresolved({ addressId: "a-9" })]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    fireEvent.change(await screen.findByLabelText(REMEDY_COPY.stateLabel), {
      target: { value: "TX" },
    });
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.save }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/customers/cust-1/addresses/a-9/state", {
        state: "TX",
        confirmReview: true,
      }),
    );
    expect(screen.queryByText(REMEDY_COPY.chooseDefault)).not.toBeInTheDocument();
  });

  it("several addresses and no single default: points to the full fixer instead of guessing which address governs", async () => {
    mockCustomer = {
      id: "cust-1",
      businessName: "Acme Market",
      addresses: [
        { id: "a-1", isDefault: false },
        { id: "a-2", isDefault: false },
      ],
    };
    open([unresolved()]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    expect(await screen.findByRole("link", { name: REMEDY_COPY.openFixer })).toHaveAttribute(
      "href",
      NO_STATE_FIXER_HREF,
    );
    expect(screen.queryByLabelText(REMEDY_COPY.stateLabel)).not.toBeInTheDocument();
  });

  it("a save that fails keeps the field and says so", async () => {
    mockPost.mockRejectedValue(new Error("boom"));
    open([unresolved()]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    fireEvent.change(screen.getByLabelText(REMEDY_COPY.stateLabel), { target: { value: "NV" } });
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.save }));
    expect(await screen.findByText(REMEDY_COPY.failed)).toBeInTheDocument();
    expect(screen.queryByText(REMEDY_COPY.saved)).not.toBeInTheDocument();
  });

  it("a store with no state links to Settings > Business address in a new tab (the cart stays)", () => {
    open([unresolved({ remedy: "ADD_STORE_STATE", customerId: undefined })]);
    const link = screen.getByRole("link", { name: NO_STORE_STATE_LINE });
    expect(link).toHaveAttribute("href", STORE_STATE_HREF);
    expect(link).toHaveAttribute("target", "_blank");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("two lines for the same customer offer ONE action; a line with no remedy offers none", async () => {
    open([
      unresolved(),
      unresolved({ lineKey: "n:1", productId: "p2" }),
      unresolved({
        lineKey: "n:2",
        productId: "p3",
        outcome: "BLOCK",
        remedy: undefined,
        customerId: undefined,
      }),
    ]);
    expect(
      await screen.findAllByRole("button", { name: noStateOnFileLine("Acme Market") }),
    ).toHaveLength(1);
  });
});

/**
 * Keyboard-focus follow-up to row 672 (R7 focus pass on the PR's head): the dialog is driven by keyboard alone, so focus
 * has to follow the flow. Opening the fixer lands on its State field, saving lands on "Check the sale again" (the Save
 * button it replaces would otherwise drop focus to the dialog container), and the remedy shows the same teal ring as
 * the other controls instead of the browser default outline.
 */
describe("RestrictionRemedyActions: focus follows the keyboard flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCustomer = { id: "cust-1", businessName: "Acme Market", addresses: [] };
    mockGet.mockImplementation(async () => ({ data: mockCustomer }));
    mockPost.mockResolvedValue({ data: {} });
    mockPatch.mockResolvedValue({ data: {} });
  });

  it("opening the fixer moves focus to the State field", async () => {
    open([unresolved()]);
    const remedy = await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") });
    expect(screen.queryByLabelText(REMEDY_COPY.stateLabel)).not.toBeInTheDocument();
    expect(remedy).not.toHaveAttribute("aria-expanded", "true");
    fireEvent.click(remedy);
    expect(await screen.findByLabelText(REMEDY_COPY.stateLabel)).toHaveFocus();
  });

  it("closing the fixer again does not pull focus anywhere", async () => {
    open([unresolved()]);
    const remedy = await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") });
    fireEvent.click(remedy);
    await screen.findByLabelText(REMEDY_COPY.stateLabel);
    remedy.focus();
    fireEvent.click(remedy);
    expect(screen.queryByLabelText(REMEDY_COPY.stateLabel)).not.toBeInTheDocument();
    expect(remedy).toHaveFocus();
  });

  it("after Save state, focus lands on 'Check the sale again'", async () => {
    open([unresolved()]);
    fireEvent.click(await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") }));
    fireEvent.change(await screen.findByLabelText(REMEDY_COPY.stateLabel), {
      target: { value: "NV" },
    });
    fireEvent.click(screen.getByRole("button", { name: REMEDY_COPY.save }));
    expect(await screen.findByRole("button", { name: REMEDY_COPY.checkAgain })).toHaveFocus();
  });

  it("the remedy action and the store-state link carry the teal focus ring (not the browser default)", async () => {
    const { unmount } = renderWithProviders(
      <RestrictionRemedyActions lines={[unresolved()]} onRecheck={jest.fn()} />,
    );
    const remedy = await screen.findByRole("button", { name: noStateOnFileLine("Acme Market") });
    expect(remedy).toHaveClass("focus-visible:outline-none", "focus-visible:ring-2");
    expect(remedy).toHaveClass("focus-visible:ring-accent");
    unmount();
    renderWithProviders(
      <RestrictionRemedyActions
        lines={[unresolved({ remedy: "ADD_STORE_STATE", customerId: undefined })]}
      />,
    );
    const link = screen.getByRole("link", { name: NO_STORE_STATE_LINE });
    expect(link).toHaveClass("focus-visible:outline-none", "focus-visible:ring-2");
    expect(link).toHaveClass("focus-visible:ring-accent");
  });
});
