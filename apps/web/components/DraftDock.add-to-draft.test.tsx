import * as React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * While a draft is parked, a wedge-scanner burst anywhere (not in a field, not under an open dialog) asks
 * "Add scanned item to a draft?": one tap joins the scan to that draft, or it starts a new order. Pins the one-tap path.
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush, replace: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: [
      {
        id: "d1",
        kind: "ORDER",
        title: null,
        customerName: "Acme",
        payload: { lineItems: [{ productId: "p1" }] },
        updatedAt: new Date().toISOString(),
      },
    ],
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

const ui = () => (
  <ToastProvider>
    <DraftDock />
  </ToastProvider>
);
const burst = (code: string, target: Element | Window = window) => {
  for (const key of code) fireEvent.keyDown(target, { key });
  fireEvent.keyDown(target, { key: "Enter" });
};
const PROMPT = "Add scanned item to a draft?";

beforeEach(() => mockPush.mockClear());
afterEach(cleanup);

describe("DraftDock: add a scan to a parked draft", () => {
  it("a scan burst asks which draft, shows the code, and one tap on the draft resumes it WITH the scan", () => {
    render(ui());
    burst("0123456789");
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByText("0123456789")).toBeInTheDocument();
    const prompt = screen.getByText(PROMPT).closest("div")!.parentElement!;
    fireEvent.click(within(prompt).getByRole("button", { name: /Acme/ }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = new URL(mockPush.mock.calls[0]![0] as string, "http://x.test");
    expect(url.pathname).toBe("/orders");
    expect(url.searchParams.get("resumeDraft")).toBe("d1");
    expect(url.searchParams.get("scan")).toBe("0123456789");
  });

  it("'Start a new order instead' opens a new order carrying the scan", () => {
    render(ui());
    burst("0123456789");
    fireEvent.click(screen.getByRole("button", { name: "Start a new order instead" }));
    const url = new URL(mockPush.mock.calls[0]![0] as string, "http://x.test");
    expect(url.pathname).toBe("/orders");
    expect(url.searchParams.get("action")).toBe("new");
    expect(url.searchParams.get("scan")).toBe("0123456789");
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("a burst typed into a field is the user's typing, never a scan", () => {
    render(
      <>
        <input aria-label="search" />
        {ui()}
      </>,
    );
    burst("0123456789", screen.getByLabelText("search"));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("a short burst (under 6 characters) is not a scan", () => {
    render(ui());
    burst("12345");
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("an open dialog handles its own scans", () => {
    render(
      <>
        <div role="dialog" data-state="open" />
        {ui()}
      </>,
    );
    burst("0123456789");
    expect(screen.queryByText(PROMPT)).toBeNull();
  });
});
