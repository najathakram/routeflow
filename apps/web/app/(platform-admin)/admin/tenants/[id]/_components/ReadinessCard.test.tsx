import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { BusinessCapabilities } from "@/lib/platform-admin/readiness-contract";
import { ReadinessCard, type ReadinessTenant } from "./ReadinessCard";

// The card must not read the effective-features trace any more (BO-02): it asks the server once.
const mockFetchEffective = jest.fn();
jest.mock("@/lib/platform-admin/features", () => ({
  fetchTenantFeaturesEffective: (id: string) => mockFetchEffective(id),
}));

const mockFetchCaps = jest.fn();
jest.mock("@/lib/platform-admin/readiness-contract", () => ({
  fetchBusinessCapabilities: (id: string) => mockFetchCaps(id),
}));

const mockGet = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: (url: string) => mockGet(url) },
}));

type CardProps = React.ComponentProps<typeof ReadinessCard>;
/** The page owns the admin read; the card is handed it. Defaults to the module-level `admin`, loaded. */
function Card(p: Partial<CardProps> & Pick<CardProps, "tenant">) {
  return <ReadinessCard admin={admin as CardProps["admin"]} adminState="loaded" {...p} />;
}

function caps(over: Partial<BusinessCapabilities> = {}): BusinessCapabilities {
  return {
    configured: true,
    delivery: false,
    doorPayments: false,
    shipping: false,
    counter: true,
    opensAs: "counter",
    opensAsChoosable: false,
    counterCapability: "optional",
    fleetHeld: false,
    matchedPreset: null,
    ...over,
  };
}

function tenant(over: Partial<ReadinessTenant> = {}): ReadinessTenant {
  return {
    id: "t-1",
    name: "acme",
    businessName: "Acme Retail",
    status: "ACTIVE",
    trialEndsAt: null,
    counts: { products: 3 },
    ...over,
  };
}

let admin: unknown = { id: "u1", username: "boss", status: "ACTIVE" };

beforeEach(() => {
  jest.clearAllMocks();
  admin = { id: "u1", username: "boss", status: "ACTIVE" };
  mockGet.mockImplementation((url: string) =>
    /\/admin$/.test(url) ? Promise.resolve({ data: { admin } }) : Promise.resolve({ data: {} }),
  );
  mockFetchEffective.mockResolvedValue([]);
  mockFetchCaps.mockResolvedValue(caps());
});

async function loaded() {
  await screen.findByRole("heading", { name: "Ready to take a sale?" });
  await waitFor(() => expect(screen.queryAllByTestId("readiness-skeleton")).toHaveLength(0));
}

/** Loaded, with the rows visible (an all-green card starts collapsed: open it). */
async function ready() {
  await loaded();
  const toggle = screen.queryByRole("button", { name: "Show details" });
  if (toggle) fireEvent.click(toggle);
}

function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest("li") as HTMLElement;
}

describe("ReadinessCard (SA-3, BO-02)", () => {
  it("never fetches the admin itself and updates the row when the admin prop changes", async () => {
    const { rerender } = render(<Card tenant={tenant()} admin={null} adminState="loaded" />);
    await ready();
    expect(within(rowOf("Has an admin")).getByText(/Not ready/)).toBeInTheDocument();
    rerender(<Card tenant={tenant()} admin={{ status: "ACTIVE" }} adminState="loaded" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
    expect(within(rowOf("Has an admin")).getByText("Ready")).toBeInTheDocument();
    expect(within(rowOf("Has an admin")).queryByText(/Not ready/)).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockFetchCaps).toHaveBeenCalledTimes(1);
    expect(mockFetchCaps).toHaveBeenCalledWith("t-1");
  });

  it("a failed page admin read leaves the row Not checked, never green", async () => {
    render(<Card tenant={tenant()} admin={null} adminState="failed" />);
    await ready();
    const r = rowOf("Has an admin");
    expect(within(r).getByText("Not checked")).toBeInTheDocument();
    expect(within(r).queryByText("Ready")).toBeNull();
  });

  it("T1 READ_ONLY: Account can sell fails with Activate linking to the billing tab", async () => {
    render(<Card tenant={tenant({ status: "READ_ONLY" })} />);
    await ready();
    const r = rowOf("Account can sell");
    expect(within(r).getByText(/Not ready/)).toBeInTheDocument();
    const link = within(r).getByRole("link", { name: "Activate Acme Retail" });
    expect(link).toHaveAttribute("href", "/admin/tenants/t-1?tab=billing");
  });

  it("T1 TRIAL passes and shows the trial end", async () => {
    render(<Card tenant={tenant({ status: "TRIAL", trialEndsAt: "2026-11-07T12:00:00.000Z" })} />);
    await ready();
    const r = rowOf("Account can sell");
    expect(within(r).getByText("Trial ends Nov 7, 2026")).toBeInTheDocument();
    expect(within(r).getByText(/Ready/)).toBeInTheDocument();
  });

  it("T2 no TENANT_ADMIN fails and links to the Admin Account focus target", async () => {
    admin = null;
    render(<Card tenant={tenant()} />);
    await ready();
    const r = rowOf("Has an admin");
    expect(within(r).getByRole("link", { name: "Create admin for Acme Retail" })).toHaveAttribute(
      "href",
      "/admin/tenants/t-1?focus=admin-account",
    );
  });

  describe("the server answer decides what the card shows", () => {
    it("(a) configured with the counter optional, an admin, an ACTIVE account and a product is all green", async () => {
      mockFetchCaps.mockResolvedValue(caps({ configured: true, counterCapability: "optional" }));
      render(<Card tenant={tenant()} />);
      await loaded();
      expect(await screen.findByText("Ready to take a sale")).toBeInTheDocument();
      expect(screen.queryByText(/Not ready/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show details" }));
      expect(screen.queryByText(/Not ready/)).toBeNull();
    });

    it("(a) a Delivery + counter tenant is green too", async () => {
      mockFetchCaps.mockResolvedValue(
        caps({ delivery: true, counter: true, counterCapability: "optional" }),
      );
      render(<Card tenant={tenant()} />);
      await loaded();
      expect(await screen.findByText("Ready to take a sale")).toBeInTheDocument();
    });

    it("(b) not configured shows ONE neutral line, never amber, no rows, no counter wording", async () => {
      mockFetchCaps.mockResolvedValue(caps({ configured: false, counter: false }));
      const { container } = render(<Card tenant={tenant()} />);
      expect(await screen.findByText(/Choose how this business sells/)).toBeInTheDocument();
      expect(container.querySelectorAll("li")).toHaveLength(0);
      expect(container.innerHTML).not.toMatch(/amber/);
      expect(screen.queryByText(/Not ready/)).toBeNull();
      expect(screen.queryByText(/Counter sales/)).toBeNull();
      expect(screen.queryByText("Has an admin")).toBeNull();
      expect(screen.queryByText("Account can sell")).toBeNull();
      expect(screen.queryByText("Has at least one product")).toBeNull();
      expect(screen.queryByText("Ready to take a sale")).toBeNull();
      expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
    });

    it("(b) the unset line links Choose to the Setup tab's capabilities target", async () => {
      mockFetchCaps.mockResolvedValue(caps({ configured: false, counter: false }));
      render(<Card tenant={tenant()} />);
      const link = await screen.findByRole("link", { name: "Choose how Acme Retail sells" });
      expect(link).toHaveTextContent("Choose");
      expect(link).toHaveAttribute("href", "/admin/tenants/t-1?tab=setup&focus=capabilities");
      expect(link.className).toMatch(/admin-tap-text/);
    });

    it("(b) the unset line does not wait for the page's admin read", async () => {
      mockFetchCaps.mockResolvedValue(caps({ configured: false, counter: false }));
      render(<Card tenant={tenant()} admin={null} adminState="loading" />);
      expect(await screen.findByText(/Choose how this business sells/)).toBeInTheDocument();
      expect(screen.queryAllByTestId("readiness-skeleton")).toHaveLength(0);
    });

    it("(c) configured with no counter (delivery or shipping only) hides the card", async () => {
      mockFetchCaps.mockResolvedValue(
        caps({ delivery: true, counter: false, counterCapability: "off" }),
      );
      const { container } = render(<Card tenant={tenant()} />);
      await waitFor(() => expect(mockFetchCaps).toHaveBeenCalled());
      await waitFor(() => expect(container).toBeEmptyDOMElement());
      expect(screen.queryByText("Ready to take a sale?")).toBeNull();
    });

    it("(d) makes no request to the effective-features trace", async () => {
      render(<Card tenant={tenant()} />);
      await ready();
      expect(mockFetchEffective).not.toHaveBeenCalled();
    });

    it("shows ONE counter row from the server, named Sells at the counter, and no in-store row", async () => {
      mockFetchCaps.mockResolvedValue(caps({ counterCapability: "always" }));
      render(<Card tenant={tenant()} />);
      await ready();
      expect(within(rowOf("Sells at the counter")).getByText("Ready")).toBeInTheDocument();
      expect(screen.queryByText("Sells in store")).toBeNull();
      expect(screen.queryByText("Counter sales is on")).toBeNull();
      expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        expect.stringContaining("Has an admin"),
        expect.stringContaining("Account can sell"),
        expect.stringContaining("Sells at the counter"),
        expect.stringContaining("Has at least one product"),
        expect.stringContaining("Payment at the till"),
      ]);
    });
  });

  it("T5 zero products is amber with no link; a missing count is Not checked, never green", async () => {
    const { unmount } = render(<Card tenant={tenant({ counts: { products: 0 } })} />);
    await ready();
    const r = rowOf("Has at least one product");
    expect(within(r).getByText("Acme Retail adds products in Products.")).toBeInTheDocument();
    expect(within(r).queryByRole("link")).toBeNull();
    expect(within(r).getByText(/Not ready/)).toBeInTheDocument();
    unmount();

    render(<Card tenant={tenant({ counts: { users: 1 } as never })} />);
    await ready();
    const r2 = rowOf("Has at least one product");
    expect(within(r2).getByText("Not checked")).toBeInTheDocument();
    expect(within(r2).queryByText(/^Ready/)).toBeNull();
    // A not-checked row also keeps the card from collapsing as "all green".
    expect(screen.queryByText("Ready to take a sale")).toBeNull();
  });

  it("T5 the payment row is info only and never fails", async () => {
    render(<Card tenant={tenant({ counts: { products: 0 } })} />);
    await ready();
    expect(
      screen.getByText("Payment at the till: cash, card, check and on account all work."),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing to set up.")).toBeInTheDocument();
  });

  it("T6 all green collapses to one line and Show details toggles the rows", async () => {
    render(<Card tenant={tenant()} />);
    await loaded();
    const line = await screen.findByText("Ready to take a sale");
    expect(line).toBeInTheDocument();
    expect(screen.queryByText("Has an admin")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("Has an admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("T7 a failed read says Couldn't check, never green, and Retry reloads", async () => {
    mockFetchCaps.mockRejectedValueOnce(new Error("boom"));
    render(<Card tenant={tenant()} />);
    expect(await screen.findByText("Couldn't check this tenant.")).toBeInTheDocument();
    expect(screen.queryByText("Ready to take a sale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockFetchCaps).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Ready to take a sale")).toBeInTheDocument();
  });

  it("T7 loading shows one skeleton row until the capabilities resolve, then the real row count", async () => {
    let resolve!: (c: BusinessCapabilities) => void;
    mockFetchCaps.mockReturnValue(new Promise<BusinessCapabilities>((r) => (resolve = r)));
    render(<Card tenant={tenant()} admin={null} adminState="loading" />);
    expect(screen.getAllByTestId("readiness-skeleton")).toHaveLength(1);
    resolve(caps());
    // admin read still pending: the skeleton now matches the five rows that will render
    await waitFor(() => expect(screen.getAllByTestId("readiness-skeleton")).toHaveLength(5));
  });

  it.each(["READ_ONLY", "SUSPENDED", "CANCELLED", "ACTIVE"])(
    "T8 pin: %s never links or names Extend Trial",
    async (status) => {
      render(<Card tenant={tenant({ status })} />);
      await ready();
      expect(screen.queryByText(/Extend Trial/i)).toBeNull();
      expect(screen.queryByRole("link", { name: /Extend/i })).toBeNull();
    },
  );

  it("T8 pin: a TRIAL tenant's only account link is Activate", async () => {
    render(<Card tenant={tenant({ status: "TRIAL", trialEndsAt: "2026-11-07T12:00:00.000Z" })} />);
    await ready();
    expect(screen.queryByRole("link", { name: /Extend/i })).toBeNull();
  });
});
