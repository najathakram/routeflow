import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { SelectAllMatching } from "./SelectAllMatching";

/**
 * Row 509 PR5 (owner Q5): the catalog's "Select all N matching" banner. It appears when the page checkbox selected
 * every row and more rows match than the page shows; it fetches ids with the CURRENT filters (cap 1,000); any filter
 * or page change clears it (REG-B154's reset, mirrored here by `resetKey`).
 */
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

const idsOf = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

function Harness({
  total,
  filters = { search: "pod", stockStatus: "IN_STOCK" as const },
  resetKey = "k1",
  initial = idsOf(50),
}: {
  total: number;
  filters?: Record<string, unknown>;
  resetKey?: string;
  initial?: string[];
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set(initial));
  return (
    <div>
      <SelectAllMatching
        filters={filters}
        resetKey={resetKey}
        selected={selected}
        setSelected={setSelected}
        pageIds={idsOf(50)}
        total={total}
      />
      <output data-testid="count">{selected.size}</output>
      <button onClick={() => setSelected(new Set())}>clear-all</button>
    </div>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SelectAllMatching", () => {
  it("offers to select every match once the whole page is selected", () => {
    renderWithProviders(<Harness total={640} />);
    expect(screen.getByText(/All 50 on this page are selected\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select all 640 matching" })).toBeInTheDocument();
  });

  it("shows nothing when only part of the page is selected, or nothing more matches", () => {
    const { unmount } = renderWithProviders(<Harness total={640} initial={idsOf(10)} />);
    expect(screen.queryByRole("button", { name: /select all/i })).toBeNull();
    unmount();
    renderWithProviders(<Harness total={50} />);
    expect(screen.queryByRole("button", { name: /select all/i })).toBeNull();
  });

  it("fetches ids with the current filters and selects them all", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { ids: idsOf(640, "m"), total: 640, capped: false } });
    renderWithProviders(<Harness total={640} />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("640"));
    expect(mockGet).toHaveBeenCalledWith("/products/ids", {
      params: { search: "pod", stockStatus: "IN_STOCK" },
    });
    expect(screen.getByText("All 640 matching are selected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeInTheDocument();
  });

  it("Clear selection empties the selection", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { ids: idsOf(640, "m"), total: 640, capped: false } });
    renderWithProviders(<Harness total={640} />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await user.click(await screen.findByRole("button", { name: "Clear selection" }));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.queryByText(/matching are selected/)).toBeNull();
  });

  it("caps at 1,000 and says so before and after", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { ids: idsOf(1000, "m"), total: 3214, capped: true } });
    renderWithProviders(<Harness total={3214} />);
    const btn = screen.getByRole("button", { name: "Select the first 1,000 of 3,214 matching" });
    expect(screen.getByText(/up to 1,000 products at once/i)).toBeInTheDocument();
    await user.click(btn);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1000"));
    expect(screen.getByText("The first 1,000 of 3,214 matching are selected.")).toBeInTheDocument();
    expect(screen.getByText(/narrow the filters/i)).toBeInTheDocument();
  });

  it("a filter or page change (resetKey) clears the all-matching state", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { ids: idsOf(640, "m"), total: 640, capped: false } });
    const { rerender } = renderWithProviders(<Harness total={640} />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await screen.findByText("All 640 matching are selected.");
    rerender(<Harness total={640} resetKey="k2" initial={idsOf(640, "m")} />);
    expect(screen.queryByText("All 640 matching are selected.")).toBeNull();
  });

  it("a result that lands after the filters changed is dropped", async () => {
    const user = userEvent.setup();
    let release!: (v: unknown) => void;
    mockGet.mockReturnValue(new Promise((r) => (release = r)));
    const { rerender } = renderWithProviders(<Harness total={640} />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    rerender(<Harness total={640} resetKey="k2" />);
    release({ data: { ids: idsOf(640, "m"), total: 640, capped: false } });
    await new Promise((r) => setTimeout(r, 20));
    // still the 50 the page had; the stale 640 never replaced them
    expect(screen.getByTestId("count")).toHaveTextContent("50");
    expect(screen.queryByText("All 640 matching are selected.")).toBeNull();
  });

  it("deselecting one row drops the all-matching banner", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { ids: idsOf(640, "m"), total: 640, capped: false } });
    const Wrap = () => {
      const [selected, setSelected] = React.useState<Set<string>>(new Set(idsOf(50)));
      return (
        <>
          <SelectAllMatching
            filters={{}}
            resetKey="k"
            selected={selected}
            setSelected={setSelected}
            pageIds={idsOf(50)}
            total={640}
          />
          <button
            onClick={() =>
              setSelected((s) => {
                const n = new Set(s);
                n.delete("m1");
                return n;
              })
            }
          >
            drop-one
          </button>
        </>
      );
    };
    renderWithProviders(<Wrap />);
    await user.click(screen.getByRole("button", { name: "Select all 640 matching" }));
    await screen.findByText("All 640 matching are selected.");
    await user.click(screen.getByRole("button", { name: "drop-one" }));
    expect(screen.queryByText("All 640 matching are selected.")).toBeNull();
  });
});
