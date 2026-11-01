import * as React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";

/**
 * SA-1066 F27: the "Add scanned item to a draft?" prompt over the receipt screen was a plain div: Escape did nothing and Tab
 * reached the Print button behind it. It is now a dialog: named by its question, first focus on the first draft, Escape and
 * the backdrop close it, Tab stays inside. A second scan while it is open is neither a new prompt nor an Enter on the
 * focused draft (a wedge scanner ends every code with Enter).
 */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/orders",
}));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: ["d1", "d2"].map((id) => ({
      id,
      kind: "ORDER",
      title: null,
      customerName: `Cust ${id}`,
      payload: { lineItems: [{ productId: "p1" }] },
      updatedAt: new Date().toISOString(),
    })),
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

const PROMPT = "Add scanned item to a draft?";
const burst = (code: string) => {
  for (const key of code) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
};
const open = () => {
  render(
    <ToastProvider>
      <button type="button">Print receipt</button>
      <DraftDock />
    </ToastProvider>,
  );
  burst("0123456789");
  return screen.getByRole("dialog", { name: PROMPT });
};

beforeEach(() => mockPush.mockClear());
afterEach(cleanup);

describe("DraftDock scan prompt is a dialog (F27)", () => {
  it("is a dialog named by its question, and shows the scanned code", () => {
    const dialog = open();
    expect(dialog).toHaveAttribute("data-state", "open");
    expect(dialog).toHaveTextContent("0123456789");
  });

  it("first focus lands on the first draft choice", () => {
    const dialog = open();
    const first = dialog.querySelector("ul button") as HTMLElement;
    expect(first).toHaveTextContent("Cust d1");
    expect(document.activeElement).toBe(first);
  });

  it("Escape closes it without resuming anything", async () => {
    open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: PROMPT })).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Tab loops inside the dialog and never reaches the button behind it", async () => {
    const dialog = open();
    const behind = screen.getByText("Print receipt");
    for (let i = 0; i < 8; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(behind);
    }
    for (let i = 0; i < 8; i++) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("a second scan while it is open is ignored: same code, and its Enter does not press the focused draft", async () => {
    const dialog = open();
    await userEvent.keyboard("9876543210{Enter}");
    expect(screen.getByRole("dialog", { name: PROMPT })).toBe(dialog);
    expect(dialog).toHaveTextContent("0123456789");
    expect(dialog).not.toHaveTextContent("9876543210");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a deliberate Enter on the focused draft (a person, not a burst) still adds the scan to it", async () => {
    open();
    await act(() => new Promise<void>((r) => setTimeout(r, 250)));
    await userEvent.keyboard("{Enter}");
    expect(mockPush).toHaveBeenCalledTimes(1);
    const url = new URL(mockPush.mock.calls[0]![0] as string, "http://x.test");
    expect(url.searchParams.get("resumeDraft")).toBe("d1");
    expect(url.searchParams.get("scan")).toBe("0123456789");
  });
});
