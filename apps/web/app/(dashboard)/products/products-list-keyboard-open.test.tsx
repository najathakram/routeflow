import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import ProductsPage from "./page";

/**
 * F10: a keyboard user could not open a product from /products. The card was a click-only div and the
 * list row had no focusable name. Each product name (grid card AND list row) is now a real link, so Tab
 * reaches it and Enter opens it; mouse users keep click-anywhere through the stretched-link overlay.
 * The REAL page mounts; only the network hooks and the heavy neighbours are mocked. `next/link` is mocked
 * the way Next behaves: the link's own onClick runs first and a default-prevented click does not navigate.
 */
const mockPush = jest.fn();
const mockNav = jest.fn();

const PRODUCTS = [
  {
    id: "p1",
    name: "Acme Cola 12oz",
    sku: "ACME-1",
    unit: "Case",
    pricePerUnit: "30",
    isActive: true,
    currentStock: 10,
  },
  {
    id: "p2",
    name: "Acme Lime Soda",
    sku: "ACME-2",
    unit: "Case",
    pricePerUnit: "12",
    isActive: true,
    currentStock: 4,
  },
  {
    id: "p3",
    name: "Acme Tracked Item",
    sku: "ACME-3",
    unit: "Case",
    pricePerUnit: "8",
    isActive: true,
    currentStock: 2,
    trackedCategoryId: "c-missing",
  },
];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/products",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    onClick,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        mockNav(href);
      }}
    >
      {children}
    </a>
  ),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: { data: PRODUCTS, meta: { total: 3, page: 1, limit: 50, totalPages: 1 } },
    isLoading: false,
    isError: false,
  }),
  useUpdateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteProducts: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/components/ProductCreateModal", () => ({ ProductCreateModal: () => null }));
jest.mock("@/components/GroupAsVariantsModal", () => ({ GroupAsVariantsModal: () => null }));
jest.mock("@/components/AssignToSectionModal", () => ({ AssignToSectionModal: () => null }));
jest.mock("@/components/family/NewFamilyButton", () => ({ NewFamilyButton: () => null }));
jest.mock("@/components/restrictions/RestrictMenu", () => ({ RestrictMenu: () => null }));
jest.mock("@/components/restrictions/SelectAllMatching", () => ({ SelectAllMatching: () => null }));
jest.mock("./_components/ProductsExportButton", () => ({ ProductsExportButton: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
});

const nameLink = (name: string) => screen.getByRole("link", { name: new RegExp(name) });

async function tabsFromSearchTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  const search = screen.getByRole("searchbox");
  search.focus();
  let n = 0;
  while (document.activeElement !== target && n < 15) {
    await user.tab();
    n++;
  }
  return n;
}

describe.each([
  ["grid", async (_user: ReturnType<typeof userEvent.setup>) => {}],
  [
    "list",
    async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByTitle("Table view"));
    },
  ],
] as const)("F10: %s view", (view, setup) => {
  it("each product name is a real link to its page, once", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    expect(nameLink("Acme Cola 12oz")).toHaveAttribute("href", "/products/p1");
    expect(nameLink("Acme Lime Soda")).toHaveAttribute("href", "/products/p2");
    expect(screen.getAllByRole("link", { name: /Acme Cola 12oz/ })).toHaveLength(1);
  });

  it("Tab reaches the name from the search box and Enter opens the product", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    const link = nameLink("Acme Cola 12oz");
    const tabs = await tabsFromSearchTo(user, link);
    expect(document.activeElement).toBe(link);
    // Today: category, hidden-only filter, per-page, grid, table, then the name = 6 Tabs. The F10 goal is 3;
    // that needs the toolbar order changed (a placement call), so this only ratchets it from getting worse.
    expect(tabs).toBeLessThanOrEqual(6);
    await user.keyboard("{Enter}");
    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(mockNav).toHaveBeenCalledWith("/products/p1");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("the link shows a visible focus style", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    expect(nameLink("Acme Cola 12oz").className).toMatch(/focus-visible:/);
  });

  it("clicking the link opens the product exactly once (no second push from the row/card)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    await user.click(nameLink("Acme Lime Soda"));
    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("in select mode the checkbox toggles and nothing navigates", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    await user.click(screen.getByRole("button", { name: /^select$/i }));
    const boxes = screen
      .getAllByRole("checkbox")
      .filter((b) => !/select all/i.test(b.closest("label")?.textContent ?? ""));
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    await user.click(boxes[boxes.length - 2]);
    expect(screen.getByText(/1 item selected/i)).toBeInTheDocument();
    expect(mockNav).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("F10: grid card keeps click-anywhere for the mouse", () => {
  it("clicking the thumbnail area opens the product (the card's own handler)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    const card = nameLink("Acme Cola 12oz").closest("div.relative") as HTMLElement;
    await user.click(within(card).getByText("ACME-1"));
    expect(mockPush).toHaveBeenCalledWith("/products/p1");
  });

  it("the stretched link overlays the card and in-card buttons sit above it", async () => {
    renderWithProviders(<ProductsPage />);
    const link = nameLink("Acme Cola 12oz");
    expect(link.className).toMatch(/after:absolute/);
    expect(link.className).toMatch(/after:inset-0/);
  });

  it("the tracked-type badge sits above the overlay so its title tooltip still shows", () => {
    renderWithProviders(<ProductsPage />);
    const badge = screen.getByTitle("Type");
    expect(badge).toHaveClass("relative", "z-10");
  });

  it("the badge text is reachable from the single product link (no hover, no extra tab stop)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    const link = nameLink("Acme Tracked Item");
    expect(link).toHaveAccessibleName(/Acme Tracked Item.*Type/);
    // the visual badge is hidden from AT so the text is announced once
    expect(screen.getByTitle("Type")).toHaveAttribute("aria-hidden", "true");
    expect(link.querySelector(".sr-only")).toHaveTextContent("Type"); // the sr-only copy
    // exactly one tab stop on the card: the link; nothing inside the card is focusable besides it
    const card = link.closest(".shadow-card") as HTMLElement;
    expect(card.querySelectorAll("a, button, [tabindex]:not([tabindex='-1'])")).toHaveLength(1);
    link.focus();
    await user.tab();
    expect(card.contains(document.activeElement)).toBe(false);
  });
});

describe.each([
  ["grid", async (_user: ReturnType<typeof userEvent.setup>) => {}],
  [
    "list",
    async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByTitle("Table view"));
    },
  ],
] as const)("K11-09: %s view, ArrowDown from the search", (_view, setup) => {
  it("moves focus to the first product link and Enter opens it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    const search = screen.getByRole("searchbox");
    await user.click(search);
    await user.keyboard("Acme");
    expect(document.activeElement).toBe(search);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(nameLink("Acme Cola 12oz"));
    await user.keyboard("{Enter}");
    expect(mockNav).toHaveBeenCalledTimes(1);
    expect(mockNav).toHaveBeenCalledWith("/products/p1");
  });

  it("leaves Tab order alone: the next Tab from the search is not the product link", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProductsPage />);
    await setup(user);
    const search = screen.getByRole("searchbox");
    search.focus();
    await user.tab();
    expect(document.activeElement).not.toBe(nameLink("Acme Cola 12oz"));
  });
});

describe("K11-09: the stretched focus ring is drawn inset", () => {
  it("the card link's ::after ring is inset so the card's overflow-hidden cannot clip it", () => {
    renderWithProviders(<ProductsPage />);
    const cls = nameLink("Acme Cola 12oz").className;
    expect(cls).toMatch(/focus-visible:after:ring-2/);
    expect(cls).toMatch(/focus-visible:after:ring-inset/);
  });
});
