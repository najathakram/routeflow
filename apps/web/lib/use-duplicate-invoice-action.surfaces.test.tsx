import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { useDuplicateInvoiceAction } from "./use-duplicate-invoice-action";

/**
 * B644 - the server refuses to duplicate an order-linked invoice (400) and an invoice holding a unit line
 * (409 UNIT_AWARE_LINE). The Duplicate button adds NO error handling of its own; this proves the refusal is
 * still VISIBLE, once, through the REAL global MutationCache handler in app/providers.tsx (the real
 * ToastProvider renders the toast). A refusal that vanished would be the fail-open we are fixing.
 */

const post = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// pass-through the app-level wrappers that need a session/network; the ToastProvider and the
// MutationCache handler under test stay REAL
jest.mock("@/lib/auth-context", () => ({ AuthProvider: ({ children }: any) => children }));
jest.mock("@/lib/buyer-auth-context", () => ({
  BuyerAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/i18n", () => ({ I18nProvider: ({ children }: any) => children }));

function DuplicateButton() {
  const { duplicate } = useDuplicateInvoiceAction();
  return <button onClick={() => duplicate("inv-1")}>Duplicate</button>;
}

const renderIt = () =>
  render(
    <Providers>
      <DuplicateButton />
    </Providers>,
  );

describe("Duplicate refusals surface visibly through the real global handler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("an ORDER-LINKED invoice: the fixed copy is shown (B980), exactly once", async () => {
    const copy =
      "This invoice came from an order, so it can't be duplicated. Create a new invoice or issue a credit note instead.";
    const message =
      "Cannot duplicate an order-linked invoice. Create a new invoice or issue a credit note instead.";
    post.mockRejectedValue({ response: { status: 400, data: { message } } });
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getAllByText(copy)).toHaveLength(1);
    expect(screen.queryByText(message)).toBeNull();
  });

  it("an invoice with a UNIT line (409 UNIT_AWARE_LINE): the fixed copy is shown (B980), exactly once", async () => {
    const copy =
      "A line on this order is sold by a unit such as a case, so this action isn't available for it yet.";
    const message =
      "A line on this order is sold by the Case, so it can't be duplicated yet. Edit it from the web order screen.";
    post.mockRejectedValue({
      response: { status: 409, data: { code: "UNIT_AWARE_LINE", message } },
    });
    renderIt();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getAllByText(copy)).toHaveLength(1);
    expect(screen.queryByText(message)).toBeNull();
  });
});
