import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";

// UX wave 2 (row 538) F23: each return line shows Pieces + Reason; Note and the staff credit price
// sit behind a per-line inline "More". A credit price that differs from the sale price stays in the
// collapsed summary ("Credit $4.75/pc"): a wholesale buyer never needs More to see their credit.
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [
        { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null },
        { id: "prod-2", name: "Gadget", unit: "each", unitsPerBox: null },
      ],
    },
  }),
}));
const quoteMutate = jest.fn();
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: quoteMutate, isPending: false }),
}));
let authRole: string | undefined;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (authRole ? { user: { role: authRole } } : null),
}));

beforeEach(() => {
  jest.clearAllMocks();
  authRole = undefined;
});

async function addWidget(pieces = "2"): Promise<InlineReturnSectionState[]> {
  const states: InlineReturnSectionState[] = [];
  renderWithProviders(
    <InlineReturnSection customerId="cust-1" onStateChange={(s) => states.push(s)} />,
  );
  fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "wid" } });
  fireEvent.click(await screen.findByRole("button", { name: "Widget" }));
  fireEvent.change(screen.getByLabelText(/^pieces$/i), { target: { value: pieces } });
  return states;
}
const more = (name = "Widget") =>
  screen.getByRole("button", { name: new RegExp(`^more for ${name}`, "i") });

describe("F23 — a return line shows Pieces and Reason; the rest is behind More", () => {
  it("collapsed: Pieces and Reason only, no Note and no credit price", async () => {
    authRole = "OPERATOR";
    await addWidget();
    expect(screen.getByLabelText(/^pieces$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reason \(optional\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/note/i)).toBeNull();
    expect(screen.queryByLabelText(/credit price/i)).toBeNull();
    expect(screen.queryByLabelText(/why the lower price/i)).toBeNull();
    expect(more()).toHaveAttribute("aria-expanded", "false");
  });

  it("More opens Note, Credit price and Why in the line itself (inline, not a dialog)", async () => {
    authRole = "OPERATOR";
    await addWidget();
    fireEvent.click(more());
    expect(screen.getByLabelText(/note \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/credit price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/why the lower price/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^less for widget/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("a driver (no credit override) sees only Note behind More", async () => {
    authRole = "DRIVER";
    await addWidget();
    fireEvent.click(more());
    expect(screen.getByLabelText(/note \(optional\)/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/credit price/i)).toBeNull();
  });

  it("a typed note survives collapsing and still reaches the host state", async () => {
    const states = await addWidget();
    fireEvent.click(more());
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), {
      target: { value: "box torn" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^less for widget/i }));
    expect(screen.queryByLabelText(/note/i)).toBeNull();
    expect(screen.getByText(/note added/i)).toBeInTheDocument();
    expect(states[states.length - 1].lines[0]).toMatchObject({ note: "box torn" });
  });

  it("a credit price that differs from the sale price shows in the collapsed line", async () => {
    authRole = "OPERATOR";
    await addWidget();
    fireEvent.click(more());
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "4.75" } });
    fireEvent.change(screen.getByLabelText(/why the lower price/i), {
      target: { value: "dented" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^less for widget/i }));
    expect(screen.queryByLabelText(/credit price/i)).toBeNull();
    expect(screen.getByText("Credit $4.75/pc")).toBeInTheDocument();
  });

  it("no credit price entered: no credit summary", async () => {
    authRole = "OPERATOR";
    await addWidget();
    expect(screen.queryByText(/^credit \$/i)).toBeNull();
  });

  it("each line has its own More", async () => {
    authRole = "OPERATOR";
    await addWidget();
    fireEvent.change(screen.getByLabelText(/add another product/i), { target: { value: "gad" } });
    fireEvent.click(await screen.findByRole("button", { name: "Gadget" }));
    fireEvent.click(more("Widget"));
    expect(screen.getAllByLabelText(/note \(optional\)/i)).toHaveLength(1);
    expect(more("Gadget")).toHaveAttribute("aria-expanded", "false");
  });

  it("a price without a reason is still explained with More closed, and blocks Get quote", async () => {
    authRole = "OPERATOR";
    await addWidget();
    fireEvent.click(more());
    fireEvent.change(screen.getByLabelText(/credit price/i), { target: { value: "3.50" } });
    fireEvent.click(screen.getByRole("button", { name: /^less for widget/i }));
    expect(screen.getByText(/widget: say why the credit price is lower/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /get quote/i })).toBeDisabled();
    await waitFor(() => expect(quoteMutate).not.toHaveBeenCalled());
  });
});
