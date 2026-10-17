import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { CustomerPriceView, resetCustomerViewMemory } from "./CustomerPriceView";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

// K10c: F26 (the customer search is a real combobox), P18 (tier labels), F27 (heading is a focus target).
const mockPrices = jest.fn();
const mockCustomers = jest.fn();
let mockLabels: Record<string, string> = { "1": "Retail", "2": "Wholesale" };
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: (...a: unknown[]) => mockPrices(...a),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: (...a: unknown[]) => mockCustomers(...a),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: mockLabels }),
}));

const response = (tier: 1 | 2 | 3 | 4 | 5): CustomerUnitPricesResponse => ({
  customerId: "c1",
  customerName: "Corner Market",
  tier,
  total: 1,
  page: 1,
  limit: 10,
  products: [
    {
      productId: "p1",
      productName: "Cola",
      tier,
      orderUnit: null,
      orderUnitScope: "default",
      orderUnitLabel: "Case",
      revision: 1,
      rows: [
        {
          ref: "pack",
          label: "Case",
          factor: 24,
          kind: "pack",
          code: null,
          price: 21,
          listPrice: 24,
          tierPrice: 21,
          source: "tier",
        },
      ],
    },
  ],
});

const HITS = [
  { id: "c1", businessName: "Corner Market" },
  { id: "c2", businessName: "Corner Deli" },
  { id: "c3", businessName: "Corner Cafe" },
];

const setHits = (hits: typeof HITS) => mockCustomers.mockReturnValue({ data: { data: hits } });

beforeEach(() => {
  resetCustomerViewMemory();
  mockLabels = { "1": "Retail", "2": "Wholesale" };
  mockPrices.mockReset();
  mockCustomers.mockReset();
  setHits(HITS);
  mockPrices.mockImplementation((id: string | null) =>
    id
      ? { data: response(2), isLoading: false, isError: false }
      : { data: undefined, isLoading: false, isError: false },
  );
});

describe("F26: the customer search is a WAI-ARIA combobox", () => {
  const input = () => screen.getByTestId(T.search);

  it("exposes combobox semantics wired to a listbox of options", () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    expect(box).toHaveAttribute("role", "combobox");
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-autocomplete", "list");
    const list = screen.getByRole("listbox", { name: "Customers" });
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    expect(box).not.toHaveAttribute("aria-activedescendant");
  });

  it("ArrowDown moves the active option and Enter picks it, no Tab needed", () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    const first = screen.getByTestId(T.result("c1"));
    expect(box.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    const second = screen.getByTestId(T.result("c2"));
    expect(box.getAttribute("aria-activedescendant")).toBe(second.id);
    expect(first).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId(T.chosen)).toBeInTheDocument();
    expect(mockPrices).toHaveBeenLastCalledWith("c2", "p1", expect.anything());
  });

  it("ArrowUp moves back and stops at the first option", () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByTestId(T.result("c1")).id);
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByTestId(T.result("c1")).id);
  });

  it("Home and End jump to the first and last option", () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "End" });
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByTestId(T.result("c3")).id);
    fireEvent.keyDown(box, { key: "Home" });
    expect(box.getAttribute("aria-activedescendant")).toBe(screen.getByTestId(T.result("c1")).id);
  });

  it("Enter on a single match picks it without moving first", () => {
    setHits([HITS[0]]);
    render(<CustomerPriceView productId="p1" />);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId(T.chosen)).toBeInTheDocument();
    expect(mockPrices).toHaveBeenLastCalledWith("c1", "p1", expect.anything());
  });

  it("Enter with several matches and none highlighted picks nothing", () => {
    render(<CustomerPriceView productId="p1" />);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.queryByTestId(T.chosen)).toBeNull();
  });

  it("Escape closes the list and keeps focus in the input; typing reopens it", () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(box).not.toHaveAttribute("aria-activedescendant");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "cor" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-expanded", "true");
  });

  it("typing filters through the customers list and clears the highlight", async () => {
    render(<CustomerPriceView productId="p1" />);
    const box = input();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.change(box, { target: { value: "deli" } });
    expect(box).not.toHaveAttribute("aria-activedescendant");
    await waitFor(() =>
      expect(mockCustomers).toHaveBeenCalledWith(expect.objectContaining({ search: "deli" })),
    );
  });

  it("a mouse click still picks, and options are 44px touch targets", () => {
    render(<CustomerPriceView productId="p1" />);
    const opt = screen.getByTestId(T.result("c3"));
    expect(opt.className).toContain("min-h-11");
    fireEvent.click(opt);
    expect(screen.getByTestId(T.chosen)).toBeInTheDocument();
    expect(mockPrices).toHaveBeenLastCalledWith("c3", "p1", expect.anything());
  });

  it("says so when nothing matches", async () => {
    setHits([]);
    render(<CustomerPriceView productId="p1" />);
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(await screen.findByText("No customer matches that name.")).toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("P18: tier labels", () => {
  it("prints an unlabeled tier once: header 'Tier 3', never 'Tier 3 tier'", () => {
    mockLabels = {};
    mockPrices.mockImplementation(() => ({
      data: response(3),
      isLoading: false,
      isError: false,
    }));
    render(<CustomerPriceView customerId="c1" />);
    const heads = within(screen.getByTestId(T.prices("p1"))).getAllByRole("columnheader");
    expect(heads[3]).toHaveTextContent(/^Tier 3$/);
    expect(document.body.textContent).not.toMatch(/Tier 3 tier/i);
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent("Tier 3");
  });

  it("keeps a configured label as the header and the caption", () => {
    mockPrices.mockImplementation(() => ({
      data: response(2),
      isLoading: false,
      isError: false,
    }));
    render(<CustomerPriceView customerId="c1" />);
    const heads = within(screen.getByTestId(T.prices("p1"))).getAllByRole("columnheader");
    expect(heads[3]).toHaveTextContent(/^Wholesale$/);
    expect(screen.getByTestId(T.row("p1", "pack"))).toHaveTextContent("Wholesale tier");
  });

  it("names tier 1 with the tenant label, never 'Tier 1', and drops the duplicate column", () => {
    mockLabels = { "1": "Standard" };
    mockPrices.mockImplementation(() => ({
      data: response(1),
      isLoading: false,
      isError: false,
    }));
    render(<CustomerPriceView customerId="c1" />);
    expect(document.body.textContent).not.toContain("Tier 1");
    const heads = within(screen.getByTestId(T.prices("p1"))).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual(["Unit", "Price", "Standard"]);
    expect(screen.getByTestId(T.blurb)).toHaveTextContent("pays Standard prices");
  });

  it("falls back to Retail for an unlabeled tier 1", () => {
    mockLabels = {};
    mockPrices.mockImplementation(() => ({
      data: response(1),
      isLoading: false,
      isError: false,
    }));
    render(<CustomerPriceView customerId="c1" />);
    expect(document.body.textContent).not.toContain("Tier 1");
    expect(screen.getByTestId(T.blurb)).toHaveTextContent("pays Retail prices");
  });

  it("the list-price column follows the tenant's tier 1 label", () => {
    mockLabels = { "1": "Standard", "2": "Wholesale" };
    mockPrices.mockImplementation(() => ({
      data: response(2),
      isLoading: false,
      isError: false,
    }));
    render(<CustomerPriceView customerId="c1" />);
    const heads = within(screen.getByTestId(T.prices("p1"))).getAllByRole("columnheader");
    expect(heads[2]).toHaveTextContent(/^Standard$/);
  });

  it("a tenant label for tier 1 ('Walk-in') names the list column and a tier 1 customer, never 'Retail'", () => {
    mockLabels = { "1": "Walk-in", "2": "Wholesale" };
    mockPrices.mockImplementation((id: string | null) => ({
      data: id ? response(2) : undefined,
      isLoading: false,
      isError: false,
    }));
    const { unmount } = render(<CustomerPriceView customerId="c1" />);
    const heads = within(screen.getByTestId(T.prices("p1"))).getAllByRole("columnheader");
    expect(heads[2]).toHaveTextContent(/^Walk-in$/);
    expect(document.body.textContent).not.toMatch(/Retail|Tier 1/);
    unmount();
    mockPrices.mockImplementation(() => ({ data: response(1), isLoading: false, isError: false }));
    render(<CustomerPriceView customerId="c1" />);
    expect(screen.getByTestId(T.blurb)).toHaveTextContent("pays Walk-in prices");
    expect(document.body.textContent).not.toMatch(/Retail|Tier 1/);
  });

  it("source pin: no hard-coded 'Tier 1', no raw tierLabel import, uses productTierLabel", () => {
    const src = fs
      .readFileSync(path.join(__dirname, "CustomerPriceView.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/Tier 1\b/);
    // No literal "Retail" printed either: the default comes from the helper.
    expect(src).not.toMatch(/Retail/);
    expect(src).not.toMatch(/\btierOneLabel\b/);
    expect(src).not.toMatch(/import \{[^}]*\btierLabel\b[^}]*\} from "@\/lib\/tier-label"/);
    expect(src).not.toMatch(/\btierLabel\(/);
    expect(src).toMatch(/from "@\/lib\/tier-one-label"/);
    expect(src).toMatch(/productTierLabel\(/);
  });
});

describe("F27 seam: the Customer view heading is a focus target", () => {
  it("is an h2 with a stable id and tabindex -1 so a jump link can scroll to and focus it", () => {
    render(<CustomerPriceView productId="p1" />);
    const h = screen.getByTestId(T.heading);
    expect(h.tagName).toBe("H2");
    expect(h.id).toBe("units-v2-h-cust");
    expect(h).toHaveAttribute("tabindex", "-1");
    h.focus();
    expect(document.activeElement).toBe(h);
  });
});
