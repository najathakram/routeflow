import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import type { PickedTarget } from "@/lib/rule-targets";
import { RuleTargetPicker } from "./RuleTargetPicker";

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a) },
}));
let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));

const CATS = [
  { id: "c1", name: "Hemp", archivedAt: null },
  { id: "c2", name: "Vapes", archivedAt: null },
];
const FAMILY = {
  id: "f1",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  variants: [
    { id: "v1", name: "Mango", variantName: "Mango", kind: "VARIANT", parentProductId: "f1" },
    { id: "v2", name: "Mint", variantName: "Mint", kind: "VARIANT", parentProductId: "f1" },
  ],
};
const GUMMIES = { id: "p9", name: "Gummies 10ct", sku: "G10", kind: "STANDARD" };
const CHEWS = { id: "p8", name: "Gummy Chews", sku: "GC", kind: "STANDARD" };

let products: unknown[] = [];
const respond = () =>
  get.mockImplementation((url: string, cfg?: { params?: { search?: string } }) => {
    if (url === "/product-categories") return Promise.resolve({ data: CATS });
    return Promise.resolve({ data: { data: products } });
  });

function Harness({
  initial = [],
  locked,
  onChange,
}: {
  initial?: PickedTarget[];
  locked?: string[];
  onChange?: (v: PickedTarget[]) => void;
}) {
  const [v, setV] = React.useState<PickedTarget[]>(initial);
  return (
    <RuleTargetPicker
      value={v}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
      lockedProductIds={locked}
    />
  );
}
const search = () => screen.getByRole("combobox", { name: "Search products" });
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
const option = (name: RegExp | string) => screen.findByRole("option", { name }, { timeout: 3000 });
const chips = () => screen.getByRole("list", { name: "Selected products and labels" });
const chipNames = () =>
  within(chips())
    .getAllByRole("listitem")
    .map((l) => l.textContent);

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  products = [GUMMIES, CHEWS, FAMILY];
  respond();
});

describe("RuleTargetPicker: multi-add", () => {
  it("starts with the empty-state copy and no count", () => {
    renderWithProviders(<Harness />);
    expect(
      screen.getByText("Search to add products. A family includes all its variants."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected products and labels" })).toBeNull();
  });

  it("asks the server for variants so a family can be expanded", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    await option(/Gummies 10ct/);
    const call = get.mock.calls.find((c) => c[0] === "/products");
    expect(call?.[1].params).toMatchObject({
      search: "gum",
      includeVariants: true,
      isActive: true,
    });
  });

  it("clicking results adds chips one after another; focus stays in the search, which clears", async () => {
    const onChange = jest.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    search().focus();
    type("gum");
    fireEvent.click(await option(/Gummies 10ct/));
    expect(chipNames()).toEqual(expect.arrayContaining([expect.stringContaining("Gummies 10ct")]));
    expect(search()).toHaveValue("");
    expect(search()).toHaveFocus();
    type("chew");
    fireEvent.click(await option(/Gummy Chews/));
    expect(chipNames()).toHaveLength(2);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "PRODUCT", id: "p9", name: "Gummies 10ct" }),
      expect.objectContaining({ kind: "PRODUCT", id: "p8", name: "Gummy Chews" }),
    ]);
    // the count line is live
    expect(screen.getByRole("status")).toHaveTextContent("2 products");
  });

  it("keyboard: arrows move the highlight, Enter adds it, and focus never leaves the search", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    await option(/Gummies 10ct/);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chipNames()).toEqual([expect.stringContaining("Gummy Chews")]);
    expect(search()).toHaveFocus();
  });

  it("Enter with nothing highlighted adds the first shown row, as the order pickers do", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    await option(/Gummies 10ct/);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chipNames()).toEqual([expect.stringContaining("Gummies 10ct")]);
  });

  it("Enter never submits an enclosing form", async () => {
    renderWithProviders(<Harness />);
    const notPrevented = fireEvent.keyDown(search(), { key: "Enter" });
    expect(notPrevented).toBe(false);
  });

  it("an already-picked row says Added and cannot be picked twice", async () => {
    renderWithProviders(
      <Harness initial={[{ kind: "PRODUCT", id: "p9", name: "Gummies 10ct" }]} />,
    );
    type("gum");
    const row = await option(/Gummies 10ct/);
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("Added")).toBeInTheDocument();
    fireEvent.click(row);
    expect(chipNames()).toHaveLength(1);
  });

  it("a row locked by the caller (already in the rule) says In rule and is disabled", async () => {
    renderWithProviders(<Harness locked={["p9"]} />);
    type("gum");
    const row = await option(/Gummies 10ct/);
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(within(row).getByText("In rule")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByRole("list", { name: "Selected products and labels" })).toBeNull();
  });

  it("says when nothing matches", async () => {
    products = [];
    renderWithProviders(<Harness />);
    type("zzz");
    expect(
      await screen.findByText("No matching products", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });
});

describe("RuleTargetPicker: families", () => {
  it("a family row starts collapsed; clicking it shows 'all variants' then each variant", async () => {
    renderWithProviders(<Harness />);
    type("pod");
    const fam = await option(/Sample Pod/);
    expect(screen.queryByRole("option", { name: /Sample Pod - Mango/ })).toBeNull();
    fireEvent.click(fam);
    expect(screen.getByRole("option", { name: /Sample Pod \(all variants\)/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sample Pod - Mango/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sample Pod - Mint/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected products and labels" })).toBeNull();
  });

  it("Enter on a family row EXPANDS it (it adds nothing); Enter again adds the first row under it", async () => {
    products = [FAMILY];
    renderWithProviders(<Harness />);
    type("pod");
    await option(/Sample Pod/);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(await screen.findByRole("option", { name: /Sample Pod - Mango/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected products and labels" })).toBeNull();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(chipNames()).toEqual([expect.stringContaining("Sample Pod (all variants)")]);
  });

  it("picks a family as a whole: ONE chip for the family id, flagged as covering variants", async () => {
    const onChange = jest.fn();
    products = [FAMILY];
    renderWithProviders(<Harness onChange={onChange} />);
    type("pod");
    fireEvent.click(await option(/Sample Pod/));
    fireEvent.click(screen.getByRole("option", { name: /Sample Pod \(all variants\)/ }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "PRODUCT", id: "f1", isFamily: true }),
    ]);
    expect(chipNames()).toEqual([expect.stringContaining("Sample Pod (all variants)")]);
  });

  it("picks one variant by its '<Family> - <Variant>' name", async () => {
    const onChange = jest.fn();
    products = [FAMILY];
    renderWithProviders(<Harness onChange={onChange} />);
    type("pod");
    fireEvent.click(await option(/Sample Pod/));
    fireEvent.click(screen.getByRole("option", { name: /Sample Pod - Mango/ }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "PRODUCT", id: "v1", name: "Sample Pod - Mango" }),
    ]);
  });

  it("once the family is picked its variants read Added (they are covered)", async () => {
    products = [FAMILY];
    renderWithProviders(
      <Harness
        initial={[{ kind: "PRODUCT", id: "f1", name: "Sample Pod (all variants)", isFamily: true }]}
      />,
    );
    type("pod");
    fireEvent.click(await option(/Sample Pod/));
    const mango = screen.getByRole("option", { name: /Sample Pod - Mango/ });
    expect(mango).toHaveAttribute("aria-disabled", "true");
    expect(within(mango).getByText("Added")).toBeInTheDocument();
  });

  it("a variant found on its own flavour is selectable without opening anything", async () => {
    products = [
      {
        id: "v1",
        name: "Mango",
        variantName: "Mango",
        kind: "VARIANT",
        parentProductId: "f1",
        parent: { id: "f1", name: "Sample Pod", kind: "FAMILY" },
      },
    ];
    renderWithProviders(<Harness />);
    type("mango");
    fireEvent.click(await option(/Sample Pod - Mango/));
    expect(chipNames()).toEqual([expect.stringContaining("Sample Pod - Mango")]);
  });
});

describe("RuleTargetPicker: labels", () => {
  it("adds a label from the select; it becomes a chip and leaves the options", async () => {
    const onChange = jest.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Add a label"), { target: { value: "c1" } });
    expect(onChange).toHaveBeenLastCalledWith([{ kind: "CATEGORY", id: "c1", name: "Hemp" }]);
    expect(chipNames()).toEqual([expect.stringContaining("Hemp")]);
    expect(screen.queryByRole("option", { name: "Hemp" })).toBeNull();
    expect(screen.getByRole("option", { name: "Vapes" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 label");
  });

  it("products and labels mix in one list and one count", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    fireEvent.click(await option(/Gummies 10ct/));
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Add a label"), { target: { value: "c1" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 product · 1 label");
  });

  it("with no labels it says so; an admin gets the link, anyone else is told to ask", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === "/product-categories" ? [] : { data: [] } }),
    );
    const { unmount } = renderWithProviders(<Harness />);
    expect(await screen.findByText("No product labels yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add product labels" })).toHaveAttribute(
      "href",
      "/settings/product-categories",
    );
    expect(screen.queryByLabelText("Add a label")).toBeNull();
    unmount();
    mockRole = "OPERATOR";
    renderWithProviders(<Harness />);
    expect(await screen.findByText("No product labels yet")).toBeInTheDocument();
    expect(screen.getByText("Ask an account admin to add product labels.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add product labels" })).toBeNull();
  });

  it("while labels load no empty-state shows, and the select is already there", () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness />);
    expect(screen.queryByText("No product labels yet")).toBeNull();
    expect(screen.getByLabelText("Add a label")).toBeInTheDocument();
  });
});

describe("RuleTargetPicker: chips", () => {
  const some = (n: number): PickedTarget[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "PRODUCT", id: `p${i}`, name: `Item ${i}` }));

  it("each chip removes itself with an accessible name, a 44px target at phone width", () => {
    const onChange = jest.fn();
    renderWithProviders(<Harness initial={some(2)} onChange={onChange} />);
    const remove = screen.getByRole("button", { name: "Remove Item 0" });
    expect(remove.className).toMatch(/h-11|min-h-\[44px\]/);
    fireEvent.click(remove);
    expect(chipNames()).toEqual([expect.stringContaining("Item 1")]);
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: "p1" })]);
  });

  it("up to 8 stay as chips, with no collapse", () => {
    renderWithProviders(<Harness initial={some(8)} />);
    expect(chipNames()).toHaveLength(8);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("past 8 they collapse to a count with Show all, which opens a searchable list with Remove", () => {
    renderWithProviders(
      <Harness initial={[...some(9), { kind: "CATEGORY", id: "c1", name: "Hemp" }]} />,
    );
    expect(screen.queryByRole("list", { name: "Selected products and labels" })).toBeNull();
    expect(screen.getByText("9 products · 1 label")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    const list = screen.getByRole("list", { name: "Selected products and labels" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search added" }), {
      target: { value: "item 3" },
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: "Remove Item 3" }));
    expect(screen.getByText("8 products · 1 label")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("searchbox", { name: "Search added" })).toBeNull();
  });
});

describe("RuleTargetPicker: long names and the scrollable results", () => {
  const LONG = "Sample Pod - Extra Long Flavour Name That Will Not Fit On A Phone";
  const sizes = (client: number, scroll: number) => {
    const c = jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(client);
    const sw = jest.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scroll);
    return () => {
      c.mockRestore();
      sw.mockRestore();
    };
  };
  afterEach(() => jest.restoreAllMocks());

  it("a name truncates on one line and keeps its full name in a title", async () => {
    products = [{ ...GUMMIES, name: LONG }];
    renderWithProviders(<Harness />);
    type("sample");
    const row = await option(/Extra Long/);
    const name = within(row).getByText(LONG);
    expect(name.className).toMatch(/truncate/);
    expect(name).toHaveAttribute("title", LONG);
    // not cut off, so no second line
    expect(within(row).getAllByText(LONG)).toHaveLength(1);
  });

  it("when the name is actually cut off, the full name also shows on a second muted line", async () => {
    const restore = sizes(100, 400);
    products = [{ ...GUMMIES, name: LONG }];
    renderWithProviders(<Harness />);
    type("sample");
    const row = await option(/Extra Long/);
    await waitFor(() => expect(within(row).getAllByText(LONG)).toHaveLength(2));
    restore();
  });

  it("rows keep the 44px target at phone width", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    const row = await option(/Gummies 10ct/);
    expect(row.className).toMatch(/min-h-\[44px\]/);
  });

  it("the results list fades at the bottom only while there is more to scroll to", async () => {
    renderWithProviders(<Harness />);
    type("gum");
    await option(/Gummies 10ct/);
    const list = screen.getByRole("listbox", { name: "Matching products" });
    expect(list).toHaveAttribute("data-more-below", "false");
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 256 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-more-below", "true");
    expect(list.className).toMatch(/mask-image:linear-gradient/);
    (list as HTMLElement).scrollTop = 244;
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-more-below", "false");
    expect(list.className).not.toMatch(/mask-image/);
  });
});
