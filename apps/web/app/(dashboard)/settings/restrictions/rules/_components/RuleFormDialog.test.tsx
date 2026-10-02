import * as React from "react";
import { render } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RuleFormDialog } from "./RuleFormDialog";

const get = jest.fn();
const post = jest.fn();
const toast = jest.fn();
// The REAL global mutation handler (app/providers.tsx) runs in the refusal spec below; its toast and
// the component's own success toast both land here so "exactly one" is observable.
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const CATS = [
  {
    id: "c1",
    name: "Hemp",
    archivedAt: null,
    createdAt: "",
    productCount: 0,
    activeRestrictionCount: 0,
  },
];
beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/product-categories" ? CATS : { data: [] } }),
  );
});

const open = (onClose = jest.fn()) => {
  renderWithProviders(<RuleFormDialog open onClose={onClose} />);
  return onClose;
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

describe("RuleFormDialog", () => {
  it("shows plain-words errors and makes no request for an empty form", async () => {
    open();
    submit();
    expect(await screen.findByText("Pick a category")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one state")).toBeInTheDocument();
    expect(screen.getByText("Add a reason")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the shaped request for a state rule, then closes", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    const onClose = open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  State ban  " } });
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/selling-restrictions", {
      categoryId: "c1",
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "ALL",
      reason: "State ban",
    });
  });

  it("a federal rule hides the state picker and sends no states", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere (federal)" }));
    expect(screen.queryByRole("group", { name: "States" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Federal ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).not.toHaveProperty("states");
  });

  it("a refused create raises exactly ONE toast, the fixed copy, and keeps the values", async () => {
    post.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: { status: 400, data: { message: "That category is archived" } },
      }),
    );
    const onClose = jest.fn();
    render(
      <Providers>
        <RuleFormDialog open onClose={onClose} />
      </Providers>,
    );
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Ban" } });
    submit();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Some details aren't valid. Check what you entered and try again.",
      variant: "error",
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Ban");
  });

  it("sends the window as instants: start inclusive, end exclusive (a one-day rule ends next midnight)", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere (federal)" }));
    fireEvent.change(screen.getByLabelText(/Starts on/), { target: { value: "2026-12-15" } });
    fireEvent.change(screen.getByLabelText(/Ends on/), { target: { value: "2026-12-15" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "One-day ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({
      effectiveFrom: new Date("2026-12-15T00:00:00").toISOString(),
      effectiveTo: new Date("2026-12-16T00:00:00").toISOString(),
    });
  });

  it("an error clears when its field is corrected, and Enter in product search does not submit", async () => {
    open();
    submit();
    expect(await screen.findByText("Add a reason")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } });
    expect(screen.queryByText("Add a reason")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "One product" }));
    // fireEvent returns false when the handler called preventDefault (which is what stops the
    // browser's implicit form submission; jsdom does not perform that submission itself).
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("Search products"), {
      key: "Enter",
    });
    expect(notPrevented).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("a product rule: search, pick by name, send productId", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/product-categories"
            ? CATS
            : { data: [{ id: "p9", name: "Gummies 10ct", sku: "G10" }] },
      }),
    );
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    fireEvent.click(screen.getByRole("radio", { name: "One product" }));
    fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "gum" } });
    fireEvent.click(await screen.findByRole("button", { name: /Gummies 10ct/ }, { timeout: 2000 }));
    expect(screen.getByText("Gummies 10ct")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere (federal)" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Federal ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ productId: "p9", jurisdiction: "FEDERAL" });
    expect(post.mock.calls[0][1]).not.toHaveProperty("categoryId");
  });

  it("Escape returns focus to the button that opened it", async () => {
    function Harness() {
      const [on, setOn] = React.useState(false);
      return (
        <>
          <button onClick={() => setOn(true)}>New rule</button>
          {on && <RuleFormDialog open onClose={() => setOn(false)} />}
        </>
      );
    }
    renderWithProviders(<Harness />);
    const opener = screen.getByRole("button", { name: "New rule" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "New selling restriction" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("product search says when the list is at its limit of 8, and only then", async () => {
    const products = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Gummies ${i}`, sku: `G${i}` }));
    for (const [count, hint] of [
      [8, true],
      [7, false],
    ] as const) {
      get.mockImplementation((url: string) =>
        Promise.resolve({ data: url === "/product-categories" ? CATS : { data: products(count) } }),
      );
      const { unmount } = renderWithProviders(<RuleFormDialog open onClose={jest.fn()} />);
      fireEvent.click(screen.getByRole("radio", { name: "One product" }));
      fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "gum" } });
      await screen.findByRole("button", { name: /Gummies 0/ }, { timeout: 2000 });
      expect(!!screen.queryByText(/Showing the first 8\. Refine your search\./)).toBe(hint);
      unmount();
    }
  });
});
