import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * SA-1222 PR-A (R3): a PURCHASE_ORDER draft resumes into the Create PO surface (`/purchase-orders`), reads
 * "PO draft · {supplier} · {n} items", and carries NO money figure (a PO draft's lines hold `unitCost`, which
 * the order total would misread as a price). Order drafts are unchanged.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/inventory",
}));
jest.mock("@/lib/use-guarded-router", () => ({ useGuardedRouter: () => ({ push }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: [
      {
        id: "po-d1",
        kind: "PURCHASE_ORDER",
        title: "Acme Supply",
        customerName: null,
        payload: {
          v: 1,
          supplierId: "sup-1",
          lines: [
            { productId: "p1", unitCost: 4.5, qty: 12 },
            { productId: "p2", unitCost: 2, qty: 3 },
            { productId: "p3", unitCost: 1, qty: 1 },
          ],
        },
        updatedAt: new Date().toISOString(),
      },
    ],
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  push.mockClear();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("DraftDock: a PURCHASE_ORDER draft", () => {
  it("R3: reads 'PO draft · Acme Supply · 3 items' with no money figure, and resumes to the Create PO surface", () => {
    render(
      <ToastProvider>
        <DraftDock />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /1 parked draft/ }));
    expect(screen.getByText("PO draft · Acme Supply · 3 items")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(push).toHaveBeenCalledWith("/purchase-orders?resumeDraft=po-d1");
  });
});
