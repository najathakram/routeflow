import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BulkDeleteButton, useOffPageSelection } from "./OffPageSelection";
import { SelectAllMatching } from "./SelectAllMatching";

/**
 * Row 509 PR5: the rule that keeps destructive bulk actions off a selection holding ids the page does not show.
 * The catalog page owns the real bar; this mounts the extracted rule next to the real banner.
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

const page = Array.from({ length: 50 }, (_, i) => `p${i + 1}`);
const matching = Array.from({ length: 640 }, (_, i) => `m${i + 1}`);
const onDelete = jest.fn();

function Bar() {
  const [selected, setSelected] = React.useState<Set<string>>(new Set(page));
  const { offPage, hint } = useOffPageSelection(selected, (id) => page.includes(id));
  return (
    <>
      <SelectAllMatching
        filters={{}}
        resetKey="k"
        selected={selected}
        setSelected={setSelected}
        pageIds={page}
        total={640}
      />
      <BulkDeleteButton count={selected.size} offPage={offPage} hint={hint} onClick={onDelete} />
      <button onClick={() => setSelected((s) => new Set([...s].filter((id) => id !== "m1")))}>
        untick-one
      </button>
      <output data-testid="n">{selected.size}</output>
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: { ids: matching, total: 640, capped: false } });
});

describe("Delete after Select all matching", () => {
  it("is enabled for a page selection", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bar />);
    const del = screen.getByRole("button", { name: "Delete 50 items" });
    expect(del).toBeEnabled();
    await user.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("is disabled, with the hint, once the selection holds off-page ids - and never fires", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bar />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await screen.findByText("All 640 matching are selected.");
    const del = screen.getByRole("button", { name: "Delete 640 items" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "Choose products on this page to use this action.");
    await user.click(del);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("stays disabled after un-ticking one row (639 off-page ids are still there)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bar />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await screen.findByText("All 640 matching are selected.");
    await user.click(screen.getByRole("button", { name: "untick-one" }));
    expect(screen.getByRole("button", { name: /^Delete \d+ items$/ })).toBeDisabled();
  });

  it("Clear selection returns to page selection", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Bar />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await user.click(await screen.findByRole("button", { name: "Clear selection" }));
    expect(screen.getByTestId("n")).toHaveTextContent("0");
  });
});
