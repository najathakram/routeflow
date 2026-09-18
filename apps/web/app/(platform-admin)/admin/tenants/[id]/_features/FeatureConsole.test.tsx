import * as React from "react";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { ADDON_ROW_KEY_BY_REGISTRY_KEY, FeatureConsole } from "./FeatureConsole";
import { REGISTRY_FIXTURE } from "./__fixtures__/registry.fixtures";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";
import { diffsFixture } from "./__fixtures__/diffs.fixtures";
import { previewFixture } from "./__fixtures__/preview.fixtures";

const mockFetchRegistry = jest.fn();
const mockFetchEffective = jest.fn();
const mockFetchDiffs = jest.fn();
const mockFetchMode = jest.fn();
const mockPreview = jest.fn();
const mockWriteConfig = jest.fn();
const mockFetchBilling = jest.fn();
const mockEnableAddon = jest.fn();

jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () => mockFetchRegistry(),
  fetchTenantFeaturesEffective: (tenantId: string) => mockFetchEffective(tenantId),
  fetchTenantFeatureDiffs: (tenantId: string) => mockFetchDiffs(tenantId),
  fetchEntitlementsMode: () => mockFetchMode(),
  previewTenantFeatures: (tenantId: string, req: unknown) => mockPreview(tenantId, req),
  writeTenantFeatureConfig: (tenantId: string, key: string, req: unknown) =>
    mockWriteConfig(tenantId, key, req),
  fetchTenantBillingInfo: (tenantId: string) => mockFetchBilling(tenantId),
  enableTenantAddon: (tenantId: string, addonKey: string, stripePriceId?: string) =>
    mockEnableAddon(tenantId, addonKey, stripePriceId),
}));

const TENANT_ID = "tenant-1";

function setSuperAdminToken() {
  const payload = window.btoa(JSON.stringify({ role: "SUPER_ADMIN" }));
  window.localStorage.setItem("superAdminToken", `h.${payload}.s`);
}

function defaultMocks() {
  mockFetchRegistry.mockResolvedValue(REGISTRY_FIXTURE);
  mockFetchEffective.mockResolvedValue(EFFECTIVE_FIXTURE);
  mockFetchDiffs.mockResolvedValue(diffsFixture(TENANT_ID));
  mockFetchMode.mockResolvedValue({ mode: "shadow" });
  mockFetchBilling.mockResolvedValue({ stripeConfigured: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  setSuperAdminToken();
  defaultMocks();
});

describe("FeatureConsole — SUPER_ADMIN-only rendering", () => {
  it("renders nothing but the restriction notice when no super-admin token is present", async () => {
    window.localStorage.clear();
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(
      screen.getByText("Feature console is available to super admins only."),
    ).toBeInTheDocument();
    // Give any in-flight fetch a chance to resolve — the registry must never render.
    await waitFor(() => expect(mockFetchRegistry).toHaveBeenCalled());
    expect(screen.queryByText("compliance")).not.toBeInTheDocument();
  });

  it("renders the console for a super-admin token", async () => {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(await screen.findByText("compliance")).toBeInTheDocument();
  });
});

describe("FeatureConsole — loading / empty / error states (test 5)", () => {
  it("shows a loading state before the fetches resolve", () => {
    mockFetchRegistry.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(screen.getByText("Loading feature console...")).toBeInTheDocument();
  });

  it("shows the empty state when the registry has no rows, never a blank tab", async () => {
    mockFetchRegistry.mockResolvedValue([]);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(await screen.findByText("No features are registered yet.")).toBeInTheDocument();
  });

  it("shows an error alert when a fetch fails, never a blank tab", async () => {
    mockFetchRegistry.mockRejectedValue(new Error("network down"));
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(
      await screen.findByText("Could not load the feature console. Try again."),
    ).toBeInTheDocument();
  });

  it("shows the error alert (never freezes on the loading state) when a fetch resolves with the wrong shape", async () => {
    // Regression for the real wrapper-shape mismatch caught against the live backend
    // (`{ effective: [...] }`, not a bare array) — even if a client function's own unwrap
    // regresses, the console must fail into the existing error state, not crash mid-render.
    mockFetchEffective.mockResolvedValue({ effective: [] } as never);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect(
      await screen.findByText("Could not load the feature console. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading feature console...")).not.toBeInTheDocument();
  });
});

describe("FeatureConsole — data-driven badges (test 1)", () => {
  it("renders 3 areas, 5 visible rows (internal hidden), and a badge matching each fixture's source", async () => {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    expect(screen.getByText("routes")).toBeInTheDocument();
    expect(screen.getByText("platform")).toBeInTheDocument();

    // internal key hidden by default
    expect(screen.queryByText("Developer mode")).not.toBeInTheDocument();

    const table: Array<[string, string]> = [
      ["tobacco_dealer", "Removed"],
      ["msrp", "Grandfathered"],
      ["recurring_routes", "Purchased"],
      ["route_optimization", "Inherited"],
      ["boxes_pieces_mode", "Off"],
    ];
    for (const [key, badge] of table) {
      const row = document.querySelector(`[data-feature-key="${key}"]`) as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).getByTestId("badge")).toHaveTextContent(badge);
    }

    // Toggle "show internal" reveals the 6th row with its own badge.
    fireEvent.click(screen.getByLabelText("Show internal"));
    const devRow = document.querySelector('[data-feature-key="developer_mode"]') as HTMLElement;
    expect(within(devRow).getByTestId("badge")).toHaveTextContent("Added");
  });
});

describe("FeatureConsole — mode selector (test 2)", () => {
  it("disables a blocked mode option with the missing key named in its title, and shows Both for a mixed value", async () => {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    const row = document.querySelector('[data-feature-key="route_optimization"]') as HTMLElement;
    expect(within(row).getByText("Both")).toBeInTheDocument();

    const scheduled = within(row).getByRole("radio", { name: "Scheduled dispatch" });
    expect(scheduled).toBeDisabled();
    expect(scheduled.closest("label")).toHaveAttribute(
      "title",
      expect.stringContaining("route_scheduling_addon"),
    );

    const manual = within(row).getByRole("radio", { name: "Manual dispatch" });
    expect(manual).not.toBeDisabled();
  });
});

describe("FeatureConsole — tier change preview → confirm → apply (test 3)", () => {
  it("opens the preview drawer with changed[]; confirm calls the existing plan-change action exactly once", async () => {
    const onChangePlan = jest.fn().mockResolvedValue(undefined);
    mockPreview.mockResolvedValueOnce(previewFixture({ planKey: "STARTER" }));

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={onChangePlan}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "STARTER" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tier change" }));

    expect(await screen.findByText("Preview tier change", { selector: "h3" })).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, { planKey: "STARTER" });
    // The diff this fixture produces: Recurring routes flips from purchased/on to off.
    expect(
      within(screen.getByTestId("preview-diff")).getByText("Recurring routes"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onChangePlan).toHaveBeenCalledTimes(1));
    expect(onChangePlan).toHaveBeenCalledWith("STARTER");
  });

  it("cancel closes the drawer and calls nothing", async () => {
    const onChangePlan = jest.fn();
    mockPreview.mockResolvedValueOnce(previewFixture({ planKey: "STARTER" }));

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={onChangePlan}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "STARTER" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tier change" }));
    await screen.findByText("Preview tier change", { selector: "h3" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Preview tier change", { selector: "h3" })).not.toBeInTheDocument();
    expect(onChangePlan).not.toHaveBeenCalled();
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // Opus review of 73668ac2, item 4: a failed apply must surface, not silently look like success.
  it("a failed plan-change surfaces an error and keeps the preview drawer open", async () => {
    const onChangePlan = jest.fn().mockRejectedValue(new Error("plan patch failed"));
    mockPreview.mockResolvedValueOnce(previewFixture({ planKey: "STARTER" }));

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={onChangePlan}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "STARTER" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tier change" }));
    await screen.findByText("Preview tier change", { selector: "h3" });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onChangePlan).toHaveBeenCalledTimes(1));

    // Still open — a failure must not look like success by silently closing the drawer.
    expect(screen.getByText("Preview tier change", { selector: "h3" })).toBeInTheDocument();
    expect(await screen.findByText("Could not apply that change. Try again.")).toBeInTheDocument();
  });
});

describe("FeatureConsole — mode change preview → confirm → apply (test 5)", () => {
  it("confirm sends {mode, reason} to writeTenantFeatureConfig for a mode-only change (Confirm stays enabled)", async () => {
    mockPreview.mockResolvedValueOnce(previewFixture({ modes: { route_optimization: "manual" } }));
    mockWriteConfig.mockResolvedValueOnce({});

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    const row = document.querySelector('[data-feature-key="route_optimization"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("radio", { name: "Manual dispatch" }));

    expect(await screen.findByText("Preview mode change", { selector: "h3" })).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, {
      modes: { route_optimization: "manual" },
    });
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(mockWriteConfig).toHaveBeenCalledTimes(1));
    expect(mockWriteConfig).toHaveBeenCalledWith(TENANT_ID, "route_optimization", {
      mode: "manual",
      reason: expect.any(String),
    });
    // Regression: brief C's real PUT requires a non-empty `reason` (400 without one) — this
    // caught it live (curled against the local backend), so pin it can't silently regress.
    const sentReason = mockWriteConfig.mock.calls[0][2].reason as string;
    expect(sentReason.length).toBeGreaterThan(0);
  });

  it("cancel closes the drawer and calls writeTenantFeatureConfig with nothing", async () => {
    mockPreview.mockResolvedValueOnce(previewFixture({ modes: { route_optimization: "manual" } }));

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    const row = document.querySelector('[data-feature-key="route_optimization"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("radio", { name: "Manual dispatch" }));
    await screen.findByText("Preview mode change", { selector: "h3" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Preview mode change", { selector: "h3" })).not.toBeInTheDocument();
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });
});

describe("FeatureConsole — 'Enable as add-on' action (B2b)", () => {
  // Pinned exact contents (owner/lead ruling 2026-09-17): a hardcoded registry-key ->
  // legacy-addonKey map is a drift trap — this must fail loudly, and show up as a reviewed
  // diff, the moment anyone adds/removes/renames an entry rather than silently doing nothing
  // for a 9th flag-gated key. Mirrors LEGACY_ADDON_KEY_TO_SKU in
  // apps/api/src/billing/plan-catalog.constants.ts — update both together.
  it("pins ADDON_ROW_KEY_BY_REGISTRY_KEY's exact contents", () => {
    expect(ADDON_ROW_KEY_BY_REGISTRY_KEY).toEqual({
      tobacco_dealer: "tobacco_dealer",
      driver_payments: "driver_payments",
      recurring_routes: "recurring_routes",
      order_delivery: "order_delivery",
      ocr: "ocr",
      developer_mode: "developer_mode",
      "flag.msrp": "msrp",
      "flag.sales_agents": "sales_agents",
    });
  });

  it("shows the button only on addon-keyed rows, never on a plan-flag/service/guard row that isn't addon-provisioned", async () => {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        tenantLabel="Acme Wholesale"
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    // tobacco_dealer (RequireAddon) and recurring_routes (RequireAddon) get the button.
    expect(
      within(
        document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement,
      ).getByRole("button", { name: "Enable Regulated items (tobacco) as an add-on" }),
    ).toBeInTheDocument();
    expect(
      within(
        document.querySelector('[data-feature-key="recurring_routes"]') as HTMLElement,
      ).getByRole("button", { name: "Enable Recurring routes as an add-on" }),
    ).toBeInTheDocument();

    // msrp (via "service") and route_optimization (via "RequirePlanFlag") do not.
    const msrpRow = document.querySelector('[data-feature-key="msrp"]') as HTMLElement;
    expect(within(msrpRow).queryByRole("button", { name: /Enable .* as an add-on/ })).toBeNull();
    const routeOptRow = document.querySelector(
      '[data-feature-key="route_optimization"]',
    ) as HTMLElement;
    expect(
      within(routeOptRow).queryByRole("button", { name: /Enable .* as an add-on/ }),
    ).toBeNull();

    // boxes_pieces_mode is gate.via "guard" but is NOT one of the six named addon-backed keys —
    // via alone must never be sufficient (it would also wrongly light up this display setting).
    const boxesRow = document.querySelector(
      '[data-feature-key="boxes_pieces_mode"]',
    ) as HTMLElement;
    expect(within(boxesRow).queryByRole("button", { name: /Enable .* as an add-on/ })).toBeNull();
  });

  it("clicking 'Enable as add-on' never calls onCustomise — the override path stays untouched", async () => {
    const onCustomise = jest.fn();
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        tenantLabel="Acme Wholesale"
        onChangePlan={jest.fn()}
        onCustomise={onCustomise}
      />,
    );
    await screen.findByText("compliance");

    const row = document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", { name: "Enable Regulated items (tobacco) as an add-on" }),
    );

    expect(await screen.findByText(/this will be a free grant, not billed/)).toBeInTheDocument();
    expect(onCustomise).not.toHaveBeenCalled();
  });

  it("a plan-flag row whose registry key needs translating to a legacy addonKey (flag.msrp -> msrp) still gets the button and enables the right key", async () => {
    mockFetchRegistry.mockResolvedValueOnce([
      ...REGISTRY_FIXTURE,
      {
        key: "flag.msrp",
        kind: "boolean",
        area: "catalog",
        label: "MSRP pricing",
        description: "Manufacturer-suggested retail price fields on products and bulk edit.",
        lifecycle: "ga",
        internal: false,
        gate: { via: "RequirePlanFlag", state: "enforced" },
        billing: { skus: ["MSRP"] },
      },
    ]);

    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        tenantLabel="Acme Wholesale"
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");

    const row = document.querySelector('[data-feature-key="flag.msrp"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Enable MSRP pricing as an add-on" }));

    await screen.findByText(/this will be a free grant, not billed/);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/No Stripe subscription item will be created/);

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // The addon-row write uses the legacy "msrp" addonKey the resolver reads via
    // useHasAddon(), NOT the registry row's own "flag.msrp" key.
    await waitFor(() => expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "msrp", undefined));
  });
});
