import * as React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { EffectiveFeature } from "../_features/types";
import { ReadinessCard, type ReadinessTenant } from "./ReadinessCard";

const mockFetchEffective = jest.fn();
jest.mock("@/lib/platform-admin/features", () => ({
  fetchTenantFeaturesEffective: (id: string) => mockFetchEffective(id),
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

function row(key: string, value: string): EffectiveFeature {
  return {
    key,
    area: "setup",
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: "PROFESSIONAL", catalogVersionId: "v1", enforced: true },
    billing: { charged: false },
    mode: { value, effective: value, source: "TENANT", allowed: [], blocked: [] },
  };
}

function effective(fulfilment: string, counter = "unset"): EffectiveFeature[] {
  return [row("fulfilment_model", fulfilment), row("counter_sales", counter)];
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
  mockFetchEffective.mockResolvedValue(effective("pickup"));
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

describe("ReadinessCard (SA-3)", () => {
  it("never fetches the admin itself and updates the row when the admin prop changes", async () => {
    const { rerender } = render(<Card tenant={tenant()} admin={null} adminState="loaded" />);
    await ready();
    expect(within(rowOf("Has an admin")).getByText(/Not ready/)).toBeInTheDocument();
    rerender(<Card tenant={tenant()} admin={{ status: "ACTIVE" }} adminState="loaded" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
    expect(within(rowOf("Has an admin")).getByText("Ready")).toBeInTheDocument();
    expect(within(rowOf("Has an admin")).queryByText(/Not ready/)).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockFetchEffective).toHaveBeenCalledTimes(1);
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

  it("T2 no TENANT_ADMIN fails and links to #admin-account", async () => {
    admin = null;
    render(<Card tenant={tenant()} />);
    await ready();
    const r = rowOf("Has an admin");
    expect(within(r).getByRole("link", { name: "Create admin for Acme Retail" })).toHaveAttribute(
      "href",
      "#admin-account",
    );
  });

  it("T3 shipping-only and delivery-only tenants hide the card", async () => {
    mockFetchEffective.mockResolvedValue(effective("ship"));
    const { container, rerender } = render(<Card tenant={tenant()} />);
    await waitFor(() => expect(mockFetchEffective).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    mockFetchEffective.mockResolvedValue(effective("delivery"));
    rerender(<Card key="d" tenant={tenant()} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText("Ready to take a sale?")).toBeNull();
  });

  it("T3 a tenant with no profile yet shows the card with a Set up link", async () => {
    mockFetchEffective.mockResolvedValue(effective("unset"));
    render(<Card tenant={tenant()} />);
    await ready();
    const r = rowOf("Sells in store");
    expect(within(r).getByRole("link", { name: /Set up .*Acme Retail/ })).toHaveAttribute(
      "href",
      "/admin/tenants/t-1?tab=setup",
    );
  });

  it("T3 delivery with counter_sales on still shows the card (counter-intended)", async () => {
    mockFetchEffective.mockResolvedValue(effective("delivery", "on"));
    render(<Card tenant={tenant()} />);
    await ready();
    expect(within(rowOf("Counter sales is on")).getByText(/Ready/)).toBeInTheDocument();
  });

  it("T4 counter capability off while the mode is pickup-less fails with the #features link", async () => {
    mockFetchEffective.mockResolvedValue(effective("unset", "unset"));
    render(<Card tenant={tenant()} />);
    await ready();
    const r = rowOf("Counter sales is on");
    expect(within(r).getByText(/Not ready/)).toBeInTheDocument();
    expect(within(r).getByRole("link", { name: /Set up counter sales/ })).toHaveAttribute(
      "href",
      "/admin/tenants/t-1?tab=setup#features",
    );
  });

  it("T4 pickup mode makes the counter capability always on (passes)", async () => {
    render(<Card tenant={tenant()} />);
    await ready();
    expect(within(rowOf("Counter sales is on")).getByText(/Ready/)).toBeInTheDocument();
    expect(within(rowOf("Sells in store")).getByText(/Ready/)).toBeInTheDocument();
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
    mockFetchEffective.mockRejectedValueOnce(new Error("boom"));
    render(<Card tenant={tenant()} />);
    expect(await screen.findByText("Couldn't check this tenant.")).toBeInTheDocument();
    expect(screen.queryByText("Ready to take a sale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mockFetchEffective).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Ready to take a sale")).toBeInTheDocument();
  });

  it("T7 loading shows six skeleton rows", () => {
    mockFetchEffective.mockReturnValue(new Promise(() => {}));
    render(<Card tenant={tenant()} />);
    expect(screen.getAllByTestId("readiness-skeleton")).toHaveLength(6);
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
