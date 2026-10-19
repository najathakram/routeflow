import * as React from "react";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { ADDON_ROW_KEY_BY_REGISTRY_KEY, FeatureConsole } from "./FeatureConsole";
import {
  FULFILMENT_MODEL_ROW,
  REGISTRY_FIXTURE,
  UNCHECKED_SETTING_ROW,
} from "./__fixtures__/registry.fixtures";
import {
  EFFECTIVE_FIXTURE,
  fulfilmentModeEffective,
  uncheckedSettingEffective,
} from "./__fixtures__/effective.fixtures";
import { diffsFixture } from "./__fixtures__/diffs.fixtures";
import { BADGE_COLORS } from "./badge";
import type { EffectiveFeature, FeatureRegistryRow } from "./types";
import { previewFixture } from "./__fixtures__/preview.fixtures";
import { fulfilmentModeLabel } from "./setup-copy";

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

describe("FeatureConsole — data-driven readouts (test 1, BO-12)", () => {
  it("renders 3 areas, 5 visible rows (internal hidden), and one readout per row that matches each fixture's source", async () => {
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

    // The source badge is folded into the one readout (BO-12): Inherited and Off are dropped.
    const table: Array<[string, string]> = [
      ["tobacco_dealer", "Off, removed by override"],
      ["msrp", "On, kept from an earlier plan"],
      ["recurring_routes", "On, paid add-on"],
      ["route_optimization", "On"],
      ["boxes_pieces_mode", "Off"],
    ];
    for (const [key, readout] of table) {
      const row = document.querySelector(`[data-feature-key="${key}"]`) as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).getAllByTestId("readout")).toHaveLength(1);
      expect(within(row).getByTestId("readout").textContent).toBe(readout);
    }

    // Toggle "show internal" reveals the 6th row with its own readout.
    fireEvent.click(screen.getByLabelText("Show internal"));
    const devRow = document.querySelector('[data-feature-key="developer_mode"]') as HTMLElement;
    expect(within(devRow).getByTestId("readout")).toHaveTextContent("On, added by override");
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
    fireEvent.click(screen.getByRole("button", { name: "Preview plan change" }));

    expect(await screen.findByText("Preview plan change", { selector: "h3" })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Preview plan change" }));
    await screen.findByText("Preview plan change", { selector: "h3" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Preview plan change", { selector: "h3" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Preview plan change" }));
    await screen.findByText("Preview plan change", { selector: "h3" });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onChangePlan).toHaveBeenCalledTimes(1));

    // Still open — a failure must not look like success by silently closing the drawer.
    expect(screen.getByText("Preview plan change", { selector: "h3" })).toBeInTheDocument();
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

describe("FeatureConsole — 'Turn on as add-on' action (B2b)", () => {
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
      ).getByRole("button", { name: "Turn on Regulated items (tobacco) as an add-on" }),
    ).toBeInTheDocument();
    expect(
      within(
        document.querySelector('[data-feature-key="recurring_routes"]') as HTMLElement,
      ).getByRole("button", { name: "Turn on Recurring routes as an add-on" }),
    ).toBeInTheDocument();

    // msrp (via "service") and route_optimization (via "RequirePlanFlag") do not.
    const msrpRow = document.querySelector('[data-feature-key="msrp"]') as HTMLElement;
    expect(within(msrpRow).queryByRole("button", { name: /Turn on .* as an add-on/ })).toBeNull();
    const routeOptRow = document.querySelector(
      '[data-feature-key="route_optimization"]',
    ) as HTMLElement;
    expect(
      within(routeOptRow).queryByRole("button", { name: /Turn on .* as an add-on/ }),
    ).toBeNull();

    // boxes_pieces_mode is gate.via "guard" but is NOT one of the six named addon-backed keys —
    // via alone must never be sufficient (it would also wrongly light up this display setting).
    const boxesRow = document.querySelector(
      '[data-feature-key="boxes_pieces_mode"]',
    ) as HTMLElement;
    expect(within(boxesRow).queryByRole("button", { name: /Turn on .* as an add-on/ })).toBeNull();
  });

  it("clicking 'Turn on as add-on' never calls onCustomise — the override path stays untouched", async () => {
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
      within(row).getByRole("button", { name: "Turn on Regulated items (tobacco) as an add-on" }),
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
    fireEvent.click(within(row).getByRole("button", { name: "Turn on MSRP pricing as an add-on" }));

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

// B1132 (demo D14): after a business profile is applied the "Current setup" card says "Ship by carrier",
// so the "Where orders go" row must say the same, from the same stored mode: not the plan
// default ("Inherited / Off") and not a "the new resolver disagrees" note.
describe("FeatureConsole — fulfilment_model row after a profile is applied (B1132)", () => {
  const FULFILMENT_ROW = {
    key: "fulfilment_model",
    kind: "boolean",
    area: "routes",
    label: "Where orders go",
    description: "Whether orders go out on delivery runs, ship by carrier, or both.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "none", state: "none" },
    billing: { skus: [] },
    config: {
      fallbackMode: "unset",
      modes: [
        { key: "unset", label: "Not configured (today's behavior)", lifecycle: "ga" },
        { key: "delivery", label: "Own delivery", lifecycle: "ga" },
        { key: "ship", label: "Ship by carrier", lifecycle: "ga" },
      ],
    },
  };
  // The real wire shape for this tenant: the old path serves it OFF, the resolver says ON from the
  // SCALE plan default, and the API now also carries the applied mode with its source.
  const effectiveRow = (mode: Record<string, unknown> | undefined) => ({
    key: "fulfilment_model",
    area: "routes",
    serving: false,
    resolver: true,
    source: "PRESET",
    detail: { planKey: "SCALE", catalogVersionId: "catalog-v11", term: "default", enforced: false },
    billing: { charged: false },
    ...(mode ? { mode } : {}),
  });

  async function renderWith(mode: Record<string, unknown> | undefined) {
    mockFetchRegistry.mockResolvedValue([...REGISTRY_FIXTURE, FULFILMENT_ROW]);
    mockFetchEffective.mockResolvedValue([...EFFECTIVE_FIXTURE, effectiveRow(mode)]);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "SCALE" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    return document.querySelector('[data-feature-key="fulfilment_model"]') as HTMLElement;
  }

  it("shows the applied mode and its source, the same mode the Current setup card shows", async () => {
    const row = await renderWith({
      value: "ship",
      effective: "ship",
      source: "TENANT",
      allowed: ["unset", "delivery", "ship"],
      blocked: [],
    });
    const shown = within(row).getByTestId("applied-mode").textContent ?? "";
    expect(shown).toBe("Ship by carrier");
    // the card renders fulfilmentModeLabel(<stored value>); the row's label is the start of it
    expect(fulfilmentModeLabel("ship").startsWith(shown)).toBe(true);
    expect(within(row).getByTestId("applied-mode-source")).toHaveTextContent(
      "Set for this business",
    );
    // the plan-default reading is gone: no Inherited badge, no On/Off
    expect(within(row).queryByTestId("badge")).not.toBeInTheDocument();
    expect(within(row).queryByText("Off")).not.toBeInTheDocument();
    expect(within(row).queryByText("On")).not.toBeInTheDocument();
  });

  it("the Why popover explains the applied profile, not the SCALE plan default or a resolver disagreement", async () => {
    const row = await renderWith({
      value: "ship",
      effective: "ship",
      source: "TENANT",
      allowed: [],
      blocked: [],
    });
    fireEvent.click(within(row).getByRole("button", { name: /Details for Where orders go/ }));
    const panel = document.getElementById("why-panel-fulfilment_model") as HTMLElement;
    expect(panel).toHaveTextContent(/Set to "Ship by carrier" for this business/);
    expect(panel).toHaveTextContent(/business profile/);
    expect(panel).not.toHaveTextContent(/SCALE/);
    expect(panel).not.toHaveTextContent(/resolver disagrees/);
  });

  it("a tenant that was never set reads as the default, not as a tenant setting", async () => {
    const row = await renderWith({
      value: "unset",
      effective: "unset",
      source: "REGISTRY_DEFAULT",
      allowed: [],
      blocked: [],
    });
    expect(within(row).getByTestId("applied-mode")).toHaveTextContent(
      "Not configured (today's behavior)",
    );
    expect(within(row).getByTestId("applied-mode-source")).toHaveTextContent(/Default/);
  });

  it("a saved delivery mode that is not in effect says so", async () => {
    const row = await renderWith({
      value: "delivery",
      effective: "unset",
      source: "TENANT",
      allowed: [],
      blocked: ["delivery"],
    });
    fireEvent.click(within(row).getByRole("button", { name: /Details for Where orders go/ }));
    expect(document.getElementById("why-panel-fulfilment_model")).toHaveTextContent(
      /saved value "Own delivery" is not in effect/,
    );
  });
});

describe("SA-1: plain names on the console's controls", () => {
  async function renderConsole(onCustomise = jest.fn(), onChangePlan = jest.fn()) {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        tenantLabel="Acme Wholesale"
        onChangePlan={onChangePlan}
        onCustomise={onCustomise}
      />,
    );
    await screen.findByText("compliance");
    return { onCustomise, onChangePlan };
  }

  it("'Customise' is now 'Set override' and fires the same handler with the same key", async () => {
    const { onCustomise } = await renderConsole();
    const row = document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement;
    expect(within(row).queryByRole("button", { name: /^Customise/ })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /^Set override/ }));
    expect(onCustomise).toHaveBeenCalledTimes(1);
    expect(onCustomise).toHaveBeenCalledWith("tobacco_dealer");
    expect(within(row).getByRole("button", { name: /^Set override/ })).toHaveTextContent(
      "Set override",
    );
  });

  it("'Set override' and 'Turn on as add-on' are 44 px targets below md: the important min-h beats the .surface-admin 40 px button floor", async () => {
    await renderConsole();
    const row = document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement;
    for (const btn of [
      within(row).getByRole("button", { name: /^Set override/ }),
      within(row).getByRole("button", { name: /Turn on .* as an add-on/ }),
    ]) {
      expect(btn).toHaveClass("!min-h-11");
      expect(btn).toHaveClass("md:!min-h-0");
      expect(btn).not.toHaveClass("min-h-11");
    }
  });

  it("'Enable as add-on' is now 'Turn on as add-on' and still opens the same confirm", async () => {
    await renderConsole();
    const row = document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement;
    const btn = within(row).getByRole("button", { name: /Turn on .* as an add-on/ });
    expect(btn).toHaveTextContent("Turn on as add-on");
    expect(screen.queryByText("Enable as add-on")).toBeNull();
    fireEvent.click(btn);
    expect(await screen.findByText(/this will be a free grant, not billed/)).toBeInTheDocument();
  });

  it("'Preview tier change' is now 'Preview plan change' and opens the same preview", async () => {
    await renderConsole();
    expect(screen.queryByRole("button", { name: "Preview tier change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview plan change" })).toBeInTheDocument();
  });

  // BO-12 (U7, U9): the release stage and the dark note moved into the Details panel as plain
  // text, so the state is read once and no chip carries a tooltip or hidden duplicate copy.
  it("explains the dark gate and the release stage in the Details panel text", async () => {
    mockFetchRegistry.mockResolvedValue([
      {
        ...REGISTRY_FIXTURE[0],
        key: "chip_row",
        label: "Chip row",
        lifecycle: "proposed",
        gate: { ...REGISTRY_FIXTURE[0]!.gate, state: "dark" },
      },
    ]);
    mockFetchEffective.mockResolvedValue([]);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("Chip row");
    const row = document.querySelector('[data-feature-key="chip_row"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Details for Chip row" }));
    const panel = document.getElementById("why-panel-chip_row") as HTMLElement;
    expect(panel).toHaveTextContent(
      "Release stage: Planned. Not released yet, and nothing relies on it today.",
    );
    expect(panel).toHaveTextContent(
      "Not enforced yet. This check only logs a warning when it would refuse the feature, and still allows it.",
    );
    // no chip, tooltip or hidden duplicate copy on the row itself
    expect(row.querySelector(".sr-only")).toBeNull();
    expect(row.querySelector("[title]")).toBeNull();
    expect(within(row).queryByText("dark")).toBeNull();
    expect(within(row).queryByText("proposed")).toBeNull();
  });
});

// BO-09: "Set override" is a quiet link-button, and is not offered where it would do nothing.
describe("BO-09: Set override stops shouting and leaves rows where it does nothing", () => {
  const SHIP_MODE = {
    value: "ship",
    effective: "ship",
    source: "TENANT" as const,
    allowed: ["unset", "delivery", "ship"],
    blocked: [],
  };

  async function renderRows() {
    mockFetchRegistry.mockResolvedValue([
      ...REGISTRY_FIXTURE,
      FULFILMENT_MODEL_ROW,
      UNCHECKED_SETTING_ROW,
    ]);
    mockFetchEffective.mockResolvedValue([
      ...EFFECTIVE_FIXTURE,
      fulfilmentModeEffective(SHIP_MODE),
      uncheckedSettingEffective(),
    ]);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    const rowOf = (key: string) =>
      document.querySelector(`[data-feature-key="${key}"]`) as HTMLElement;
    return { rowOf };
  }

  it("a gate-less configuration row (Where orders go) has no Set override button", async () => {
    const { rowOf } = await renderRows();
    expect(
      within(rowOf("fulfilment_model")).queryByRole("button", { name: /^Set override/ }),
    ).toBeNull();
  });

  it("a gate-less plain row has no Set override button either", async () => {
    const { rowOf } = await renderRows();
    expect(
      within(rowOf("unchecked_setting")).queryByRole("button", { name: /^Set override/ }),
    ).toBeNull();
  });

  it("a gated row keeps Set override, as a quiet link-button with no fill", async () => {
    const { rowOf } = await renderRows();
    const btn = within(rowOf("tobacco_dealer")).getByRole("button", { name: /^Set override/ });
    expect(btn).toHaveAttribute("aria-label", "Set override Regulated items (tobacco)");
    expect(btn).not.toHaveClass("bg-indigo-600");
    expect(btn.className).not.toMatch(/(^|\s)bg-/);
    expect(btn).toHaveClass("text-indigo-300");
  });

  it("Set override has a visible keyboard focus ring and a 44 px tap target below md", async () => {
    const { rowOf } = await renderRows();
    const btn = within(rowOf("tobacco_dealer")).getByRole("button", { name: /^Set override/ });
    for (const cls of [
      "focus-visible:ring-2",
      "focus-visible:ring-indigo-400",
      "focus-visible:ring-offset-2",
      "focus-visible:ring-offset-slate-800",
      // Important: the .surface-admin 40 px button floor outranks a plain min-h (R1 proof, 390 px).
      "!min-h-11",
      "md:!min-h-0",
    ]) {
      expect(btn).toHaveClass(cls);
    }
  });

  it("Turn on as add-on is an outlined secondary: a ring and no fill", async () => {
    const { rowOf } = await renderRows();
    const btn = within(rowOf("tobacco_dealer")).getByRole("button", {
      name: /Turn on .* as an add-on/,
    });
    expect(btn.className).not.toMatch(/(^|\s)bg-/);
    expect(btn).toHaveClass("ring-1", "ring-slate-500");
  });

  it("no Setup row has a filled indigo button (only real primaries are filled)", async () => {
    const { rowOf } = await renderRows();
    for (const key of ["tobacco_dealer", "recurring_routes", "msrp", "route_optimization"]) {
      for (const b of within(rowOf(key)).queryAllByRole("button")) {
        expect(b).not.toHaveClass("bg-indigo-600");
      }
    }
  });

  it("buttons read in the order Why, Set override, Turn on as add-on", async () => {
    const { rowOf } = await renderRows();
    const names = within(rowOf("tobacco_dealer"))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Details for Regulated items (tobacco)",
      "Set override Regulated items (tobacco)",
      "Turn on Regulated items (tobacco) as an add-on",
    ]);
    expect(
      within(rowOf("tobacco_dealer")).getByRole("button", { name: /^Set override/ }).parentElement,
    ).toHaveClass("gap-2");
  });

  it("a gate-less plain row's Why panel says nothing checks it, so an override would do nothing", async () => {
    const { rowOf } = await renderRows();
    const row = rowOf("unchecked_setting");
    fireEvent.click(within(row).getByRole("button", { name: /^Details for Unchecked setting/ }));
    expect(document.getElementById("why-panel-unchecked_setting")).toHaveTextContent(
      "Nothing checks this setting yet, so an override would have no effect.",
    );
  });

  it("the gate-less note is not added to a gated row or to a configuration row", async () => {
    const { rowOf } = await renderRows();
    fireEvent.click(within(rowOf("tobacco_dealer")).getByRole("button", { name: /^Details for/ }));
    expect(document.getElementById("why-panel-tobacco_dealer")).not.toHaveTextContent(
      /Nothing checks/,
    );
    fireEvent.click(
      within(rowOf("fulfilment_model")).getByRole("button", { name: /^Details for/ }),
    );
    expect(document.getElementById("why-panel-fulfilment_model")).not.toHaveTextContent(
      /Nothing checks/,
    );
  });
});

// BO-10 (keep-the-picker fallback): the console marks "current" from the resolved plan,
// `planKey ?? plan`, the same value the header and Overview show. The picker stays.
describe("BO-10: the Tier picker reads the resolved plan, not the legacy plan enum", () => {
  async function renderBusinessOnScale(extra: { planKey?: string } = { planKey: "SCALE" }) {
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "BUSINESS", ...extra }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    return screen.getByLabelText("Tier") as HTMLSelectElement;
  }

  // PROFESSIONAL is the legacy enum whose display label is "Business" (the header-vs-console
  // mismatch the audit saw); BUSINESS is the raw value from the card and renders as-is.
  it.each(["BUSINESS", "PROFESSIONAL"])(
    "never shows the legacy plan %s as current when planKey says otherwise",
    async (legacy) => {
      render(
        <FeatureConsole
          tenant={{ id: TENANT_ID, plan: legacy, planKey: "SCALE" }}
          onChangePlan={jest.fn()}
          onCustomise={jest.fn()}
        />,
      );
      await screen.findByText("compliance");
      const select = screen.getByLabelText("Tier") as HTMLSelectElement;
      const labels = Array.from(select.options).map((o) => o.textContent ?? "");
      expect(labels.some((l) => /business/i.test(l))).toBe(false);
      expect(screen.queryByText(/business\s+—\s+current/i)).toBeNull();
    },
  );

  it("marks the resolved plan (Scale) as current and selects it", async () => {
    const select = await renderBusinessOnScale();
    expect(select.value).toBe("SCALE");
    const current = Array.from(select.options).filter((o) => /current/.test(o.textContent ?? ""));
    expect(current.map((o) => o.value)).toEqual(["SCALE"]);
    expect(current[0]?.textContent).toMatch(/Scale/);
  });

  it("disables Preview plan change while the resolved plan is selected, and enables it for another", async () => {
    const select = await renderBusinessOnScale();
    const preview = screen.getByRole("button", { name: "Preview plan change" });
    expect(preview).toBeDisabled();
    fireEvent.change(select, { target: { value: "STARTER" } });
    expect(preview).not.toBeDisabled();
    fireEvent.change(select, { target: { value: "SCALE" } });
    expect(preview).toBeDisabled();
  });

  it("falls back to the plan enum when there is no planKey, so a legacy-only tenant still shows its tier", async () => {
    const select = await renderBusinessOnScale({});
    expect(select.value).toBe("BUSINESS");
    expect(
      Array.from(select.options)
        .filter((o) => /current/.test(o.textContent ?? ""))
        .map((o) => o.value),
    ).toEqual(["BUSINESS"]);
  });

  it("keeps the picker and its preview button (the lead default for this build)", async () => {
    await renderBusinessOnScale();
    expect(screen.getByLabelText("Tier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview plan change" })).toBeInTheDocument();
  });

  it("follows the resolved plan when it changes after mount", async () => {
    const { rerender } = render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "BUSINESS", planKey: "SCALE" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    rerender(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "BUSINESS", planKey: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    expect((screen.getByLabelText("Tier") as HTMLSelectElement).value).toBe("GROWTH");
  });
});

// BO-12: one state readout per row, release stage and the dark note in the Details panel.
describe("BO-12: one state readout per console row", () => {
  const DARK_NOTE =
    "Not enforced yet. This check only logs a warning when it would refuse the feature, and still allows it.";

  const regRow = (key: string, over: Partial<FeatureRegistryRow> = {}): FeatureRegistryRow => ({
    key,
    kind: "boolean",
    area: "bo12",
    label: `Row ${key}`,
    description: `Description of ${key}.`,
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequirePlanFlag", state: "enforced" },
    billing: { skus: [] },
    ...over,
  });
  const effRow = (key: string, over: Partial<EffectiveFeature> = {}): EffectiveFeature => ({
    key,
    area: "bo12",
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: "GROWTH", catalogVersionId: "catalog-v11", enforced: true },
    billing: { charged: false },
    ...over,
  });
  const SHIP_MODE = {
    value: "ship",
    effective: "ship",
    source: "TENANT" as const,
    allowed: ["unset", "delivery", "ship"],
    blocked: [],
  };

  // Every readout state in one registry. The T1-style row is dark + no source + serving: it used
  // to read "Off", "dark" and "On" at once.
  const REGISTRY: FeatureRegistryRow[] = [
    ...REGISTRY_FIXTURE,
    FULFILMENT_MODEL_ROW,
    UNCHECKED_SETTING_ROW,
    regRow("t1_style", { gate: { via: "RequirePlanFlag", state: "dark" } }),
    regRow("t1_denied", { gate: { via: "RequireAddon", state: "dark" } }),
    regRow("not_reported"),
    regRow("resolver_error"),
    regRow("is_beta", { lifecycle: "beta" }),
    regRow("is_ga", { lifecycle: "ga" }),
    regRow("is_deprecated", { lifecycle: "deprecated" }),
    regRow("is_sunset", { lifecycle: "sunset" }),
    regRow("plain_on"),
    regRow("grant_but_off"),
  ];
  const EFFECTIVE: EffectiveFeature[] = [
    ...EFFECTIVE_FIXTURE,
    fulfilmentModeEffective(SHIP_MODE),
    uncheckedSettingEffective(),
    effRow("t1_style", { serving: true, source: "NONE" }),
    effRow("t1_denied", { serving: true, source: "OVERRIDE_DENY" }),
    effRow("resolver_error", { source: "UNKNOWN" }),
    effRow("is_beta", { serving: true, source: "PRESET" }),
    effRow("is_ga"),
    effRow("is_deprecated", { serving: true, source: "PRESET" }),
    effRow("is_sunset"),
    effRow("plain_on", { serving: true, resolver: true, source: "PRESET" }),
    effRow("grant_but_off", { serving: false, resolver: true, source: "OVERRIDE_GRANT" }),
  ];

  async function renderAll() {
    mockFetchRegistry.mockResolvedValue(REGISTRY);
    mockFetchEffective.mockResolvedValue(EFFECTIVE);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    fireEvent.click(screen.getByLabelText("Show internal"));
    const rowOf = (key: string) =>
      document.querySelector(`[data-feature-key="${key}"]`) as HTMLElement;
    const open = (key: string) =>
      fireEvent.click(within(rowOf(key)).getByRole("button", { name: /^Details for/ }));
    const panelOf = (key: string) => document.getElementById(`why-panel-${key}`) as HTMLElement;
    return { rowOf, open, panelOf };
  }

  /** Everything on the row except the Details panel and the mode radios. */
  function headerText(row: HTMLElement): string {
    const clone = row.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[id^='why-panel-'], [role='radiogroup']").forEach((n) => n.remove());
    return clone.textContent ?? "";
  }

  it("no row renders both On and Off text", async () => {
    const { rowOf } = await renderAll();
    for (const r of REGISTRY) {
      const row = rowOf(r.key);
      expect(row).toBeTruthy();
      const stateWords = within(row).queryAllByText(/^(On|Off)\b/);
      expect({ key: r.key, stateWords: stateWords.length <= 1 }).toEqual({
        key: r.key,
        stateWords: true,
      });
      expect(within(row).queryByText("Unknown")).toBeNull();
      expect(within(row).queryByText("Inherited")).toBeNull();
    }
  });

  it("every row has exactly one readout", async () => {
    const { rowOf } = await renderAll();
    for (const r of REGISTRY) {
      expect({
        key: r.key,
        readouts: within(rowOf(r.key)).queryAllByTestId("readout").length,
      }).toEqual({
        key: r.key,
        readouts: 1,
      });
    }
  });

  it("no row has more than one status chip outside the Details panel (the T1-style row had three)", async () => {
    const { rowOf } = await renderAll();
    for (const r of REGISTRY) {
      const chips = Array.from(rowOf(r.key).querySelectorAll('[class~="text-[10px]"]')).filter(
        (el) => !el.closest("[id^='why-panel-']") && !el.closest("[role='radiogroup']"),
      );
      expect({ key: r.key, atMostOne: chips.length <= 1 }).toEqual({
        key: r.key,
        atMostOne: true,
      });
    }
    // the old lifecycle and dark chips are gone from the row for good
    const t1 = rowOf("t1_style");
    expect(within(t1).queryByText("dark")).toBeNull();
    expect(within(t1).queryByText("ga")).toBeNull();
  });

  it("a mode is applied: one readout with the mode label and the source as muted text", async () => {
    const { rowOf } = await renderAll();
    const row = rowOf("fulfilment_model");
    const readout = within(row).getByTestId("readout");
    expect(readout).toHaveTextContent("Ship by carrier · Set for this business");
    expect(within(readout).getByTestId("applied-mode-source")).toHaveClass("text-slate-400");
    expect(within(row).getAllByTestId("readout")).toHaveLength(1);
    expect(within(row).queryByText("Off")).toBeNull();
    expect(within(row).queryByText("On")).toBeNull();
  });

  it("a row with no effective data reads Not reported once, in amber, and not Off", async () => {
    const { rowOf } = await renderAll();
    const row = rowOf("not_reported");
    expect(within(row).getAllByText("Not reported")).toHaveLength(1);
    expect(within(row).getByTestId("readout")).toHaveClass("text-amber-300");
    expect(within(row).queryByText("Off")).toBeNull();
    expect(within(row).queryByText("Unknown")).toBeNull();
  });

  it("a resolver error (source UNKNOWN) is also Not reported, never On or Off", async () => {
    const { rowOf } = await renderAll();
    expect(within(rowOf("resolver_error")).getByTestId("readout")).toHaveTextContent(
      /^Not reported$/,
    );
  });

  it("feature on, gate dark, source none or an override that removes it: On, not enforced yet, in amber", async () => {
    const { rowOf } = await renderAll();
    for (const key of ["t1_style", "t1_denied"]) {
      const readout = within(rowOf(key)).getByTestId("readout");
      expect(readout).toHaveTextContent(/^On, not enforced yet$/);
      expect(readout).toHaveClass("text-amber-300");
      expect(readout).not.toHaveClass("text-[10px]");
    }
  });

  it("a dark row that is on for a real reason keeps that reason (the first rule that applies wins)", async () => {
    const { rowOf } = await renderAll();
    // route_optimization: dark, serving, source PRESET. developer_mode: dark, serving, GRANT.
    expect(within(rowOf("route_optimization")).getByTestId("readout")).toHaveTextContent(/^On$/);
    expect(within(rowOf("developer_mode")).getByTestId("readout")).toHaveTextContent(
      /^On, added by override$/,
    );
  });

  it("the four source chips use the badge colours and are a 10 px chip", async () => {
    const { rowOf } = await renderAll();
    const cases: Array<[string, string, string]> = [
      ["developer_mode", "On, added by override", BADGE_COLORS.added],
      ["tobacco_dealer", "Off, removed by override", BADGE_COLORS.removed],
      ["recurring_routes", "On, paid add-on", BADGE_COLORS.purchased],
      ["msrp", "On, kept from an earlier plan", BADGE_COLORS.grandfathered],
    ];
    for (const [key, text, colours] of cases) {
      const readout = within(rowOf(key)).getByTestId("readout");
      expect(readout.textContent).toBe(text);
      expect(readout).toHaveClass("text-[10px]");
      for (const cls of colours.split(" ")) expect(readout).toHaveClass(cls);
    }
  });

  it("a plain On or Off stays 12 px text (emerald or slate), never a chip", async () => {
    const { rowOf } = await renderAll();
    const on = within(rowOf("plain_on")).getByTestId("readout");
    expect(on).toHaveTextContent(/^On$/);
    expect(on).toHaveClass("text-xs", "text-emerald-400");
    expect(on).not.toHaveClass("text-[10px]");
    const off = within(rowOf("is_ga")).getByTestId("readout");
    expect(off).toHaveTextContent(/^Off$/);
    expect(off).toHaveClass("text-xs", "text-slate-400");
    expect(off).not.toHaveClass("text-[10px]");
  });

  it("a source that contradicts what the row is serving falls back to plain On or Off", async () => {
    const { rowOf } = await renderAll();
    // the resolver would grant it but it is not served today: never claim "On, added by override"
    expect(within(rowOf("grant_but_off")).getByTestId("readout")).toHaveTextContent(/^Off$/);
  });

  it("deprecated and sunset rows carry a muted plain-text word after the label, not a chip", async () => {
    const { rowOf } = await renderAll();
    expect(headerText(rowOf("is_deprecated"))).toContain("· Being phased out");
    expect(headerText(rowOf("is_sunset"))).toContain("· Retired");
    const word = within(rowOf("is_deprecated")).getByText("· Being phased out");
    expect(word).toHaveClass("text-slate-400");
    expect(word).not.toHaveClass("text-[10px]");
    // ga and beta rows say nothing about lifecycle on the row
    const quiet = /Released|Beta|phased|Retired|Planned/;
    expect(headerText(rowOf("is_ga"))).not.toMatch(quiet);
    expect(headerText(rowOf("is_beta"))).not.toMatch(quiet);
  });

  it("the Details panel states the release stage in the exact copy", async () => {
    const { open, panelOf } = await renderAll();
    const stages: Array<[string, string]> = [
      ["is_ga", "Release stage: Released."],
      ["is_beta", "Release stage: Beta. Released for testing and may still change."],
      [
        "unchecked_setting", // lifecycle: proposed
        "Release stage: Planned. Not released yet, and nothing relies on it today.",
      ],
      ["is_deprecated", "Release stage: Being phased out. Avoid turning it on for new businesses."],
      ["is_sunset", "Release stage: Retired. No longer offered."],
    ];
    for (const [key, copy] of stages) {
      open(key);
      expect(panelOf(key)).toHaveTextContent(copy);
    }
  });

  it("the Details panel for a dark row contains the dark note, and a non-dark row does not", async () => {
    const { open, panelOf } = await renderAll();
    open("t1_style");
    expect(panelOf("t1_style")).toHaveTextContent(DARK_NOTE);
    open("is_ga");
    expect(panelOf("is_ga")).not.toHaveTextContent(/Not enforced yet/);
  });

  it("the Details panel renders for a row with no effective data, so the release stage stays reachable", async () => {
    const { open, panelOf } = await renderAll();
    open("not_reported");
    expect(panelOf("not_reported")).toHaveTextContent("Release stage: Released.");
    expect(panelOf("not_reported")).toHaveTextContent(
      "The server did not report a state for this feature.",
    );
  });

  it("the readout is plain visible text: no title, no aria-label, no hidden copy", async () => {
    const { rowOf } = await renderAll();
    for (const r of REGISTRY) {
      const readout = within(rowOf(r.key)).getByTestId("readout");
      expect(readout).not.toHaveAttribute("title");
      expect(readout).not.toHaveAttribute("aria-label");
      expect(readout.querySelector("[title], [aria-label], .sr-only")).toBeNull();
      expect(rowOf(r.key).querySelector(".sr-only")).toBeNull();
    }
  });

  it("the toggle is Details with its own name; the panel is always mounted, hidden until opened, and focus stays", async () => {
    const { rowOf } = await renderAll();
    const row = rowOf("tobacco_dealer");
    const toggle = within(row).getByRole("button", {
      name: "Details for Regulated items (tobacco)",
    });
    expect(toggle).toHaveTextContent("Details");
    expect(within(row).queryByText("Why is this on/off?")).toBeNull();
    const panelId = toggle.getAttribute("aria-controls") as string;
    expect(document.getElementById(panelId)).toBeInTheDocument();
    expect(document.getElementById(panelId)).toHaveAttribute("hidden");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(panelId)).not.toHaveAttribute("hidden");
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    expect(document.getElementById(panelId)).toHaveAttribute("hidden");
  });

  it("the Details panel comes after the mode radios, full width", async () => {
    const { rowOf, open, panelOf } = await renderAll();
    open("route_optimization");
    const radios = within(rowOf("route_optimization")).getByRole("radiogroup");
    const panel = panelOf("route_optimization");
    expect(radios.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel).toHaveClass("bg-slate-900/50", "text-slate-300");
    expect(panel.parentElement).toBe(rowOf("route_optimization"));
  });

  it("label and readout share one line; the actions follow the description under them", async () => {
    const { rowOf } = await renderAll();
    const row = rowOf("tobacco_dealer");
    const label = within(row).getByText("Regulated items (tobacco)");
    const readout = within(row).getByTestId("readout");
    expect(readout.parentElement).toBe(label.parentElement);
    const description = within(row).getByText(/License-column ledgers/);
    const actions = within(row).getByRole("button", { name: /^Details for/ })
      .parentElement as HTMLElement;
    expect(actions.contains(readout)).toBe(false);
    expect(
      description.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // below lg the actions stack under the description, left aligned; from lg they sit at the right
    expect(actions.parentElement).toHaveClass("flex-col", "lg:flex-row");
  });
});

describe("BO-06: console mode radios render for config rows", () => {
  const MODE = {
    value: "ship",
    effective: "ship",
    source: "TENANT" as const,
    allowed: ["unset", "delivery", "ship", "both"],
    blocked: [] as string[],
  };
  // fulfilment_model with the fourth option the server also accepts.
  const FULFIL_ROW: FeatureRegistryRow = {
    ...FULFILMENT_MODEL_ROW,
    config: {
      fallbackMode: "unset",
      modes: [
        ...(FULFILMENT_MODEL_ROW.config?.modes ?? []),
        { key: "both", label: "Delivery and shipping", lifecycle: "ga" },
      ],
    },
  };

  // previewFixture only flips keys that EFFECTIVE_FIXTURE holds, so build this row's own diff.
  function previewFulfil(to: string) {
    const before = fulfilmentModeEffective(MODE);
    const after = { ...before, mode: { ...MODE, value: to, effective: to } };
    return { before: [before], after: [after], changed: ["fulfilment_model"] };
  }

  async function renderRows(effective: EffectiveFeature[]) {
    mockFetchRegistry.mockResolvedValue([...REGISTRY_FIXTURE, FULFIL_ROW, UNCHECKED_SETTING_ROW]);
    mockFetchEffective.mockResolvedValue([...EFFECTIVE_FIXTURE, ...effective]);
    render(
      <FeatureConsole
        tenant={{ id: TENANT_ID, plan: "GROWTH" }}
        onChangePlan={jest.fn()}
        onCustomise={jest.fn()}
      />,
    );
    await screen.findByText("compliance");
    fireEvent.click(screen.getByLabelText("Show internal"));
    return (key: string) => document.querySelector(`[data-feature-key="${key}"]`) as HTMLElement;
  }

  it("a gate-less config row that reports serving:false still gets its radios, named by the label", async () => {
    const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
    const group = within(rowOf("fulfilment_model")).getByRole("radiogroup", {
      name: "Where orders go mode",
    });
    expect(within(group).getByRole("radio", { name: "Ship by carrier" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Delivery and shipping" })).not.toBeChecked();
  });

  it("names every radiogroup by the row label, never the raw key", async () => {
    const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
    expect(
      within(rowOf("route_optimization")).getByRole("radiogroup", {
        name: "Route optimization mode",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: /fulfilment_model|route_optimization/ })).toBe(
      null,
    );
  });

  it("a row without config renders no radiogroup, and a config row with no mode reported renders none", async () => {
    const rowOf = await renderRows([
      fulfilmentModeEffective(undefined),
      uncheckedSettingEffective(),
    ]);
    expect(within(rowOf("unchecked_setting")).queryByRole("radiogroup")).toBeNull();
    expect(within(rowOf("tobacco_dealer")).queryByRole("radiogroup")).toBeNull();
    expect(within(rowOf("fulfilment_model")).queryByRole("radiogroup")).toBeNull();
  });

  it("gives each console row a stable link target id", async () => {
    const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
    expect(document.getElementById("feature-fulfilment_model")).toBe(rowOf("fulfilment_model"));
    expect(document.getElementById("feature-route_optimization")).toBe(rowOf("route_optimization"));
  });

  it("picking a mode opens the preview drawer and Cancel writes nothing", async () => {
    mockPreview.mockResolvedValueOnce(previewFulfil("delivery"));
    const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
    fireEvent.click(within(rowOf("fulfilment_model")).getByRole("radio", { name: "Own delivery" }));
    expect(await screen.findByText("Preview mode change", { selector: "h3" })).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, {
      modes: { fulfilment_model: "delivery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  describe("BO-05 follow-up: a click on a radio is never silent", () => {
    const BLOCKED_MODE = { ...MODE, blocked: ["both"] };
    const withRequires = {
      ...FULFIL_ROW,
      config: {
        fallbackMode: "unset",
        modes: (FULFIL_ROW.config?.modes ?? []).map((m) =>
          m.key === "both" ? { ...m, requires: ["order_delivery"] } : m,
        ),
      },
    };

    async function renderBlocked() {
      mockFetchRegistry.mockResolvedValue([
        ...REGISTRY_FIXTURE,
        withRequires,
        UNCHECKED_SETTING_ROW,
      ]);
      mockFetchEffective.mockResolvedValue([
        ...EFFECTIVE_FIXTURE,
        fulfilmentModeEffective(BLOCKED_MODE),
        uncheckedSettingEffective(),
      ]);
      render(
        <FeatureConsole
          tenant={{ id: TENANT_ID, plan: "GROWTH" }}
          onChangePlan={jest.fn()}
          onCustomise={jest.fn()}
        />,
      );
      await screen.findByText("compliance");
      fireEvent.click(screen.getByLabelText("Show internal"));
      return document.querySelector('[data-feature-key="fulfilment_model"]') as HTMLElement;
    }

    it("a blocked option says why in visible text tied to the radio, not only in a tooltip", async () => {
      const row = await renderBlocked();
      const radio = within(row).getByRole("radio", { name: "Delivery and shipping" });
      expect(radio).toBeDisabled();
      const reason = within(row).getByText(/Requires order_delivery/);
      expect(reason).toBeVisible();
      expect(radio).toHaveAccessibleDescription(reason.textContent!);
    });

    it("an enabled option shows a pending state the moment it is clicked, then the drawer opens", async () => {
      let release: (v: unknown) => void = () => {};
      mockPreview.mockReturnValueOnce(new Promise((r) => (release = r)));
      const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
      const row = rowOf("fulfilment_model");
      const radio = within(row).getByRole("radio", { name: "Own delivery" });
      fireEvent.click(radio);
      await waitFor(() => expect(radio).toHaveAttribute("aria-busy", "true"));
      expect(within(row).getByText("Checking what would change…")).toBeVisible();
      release(previewFulfil("delivery"));
      expect(
        await screen.findByText("Preview mode change", { selector: "h3" }),
      ).toBeInTheDocument();
      expect(radio).not.toHaveAttribute("aria-busy", "true");
      expect(within(row).queryByText("Checking what would change…")).toBeNull();
      // the radio still reads the server's value: it changes only after Confirm
      expect(within(row).getByRole("radio", { name: "Ship by carrier" })).toBeChecked();
    });

    it("a preview that fails says so on the row instead of doing nothing", async () => {
      mockPreview.mockRejectedValueOnce(new Error("down"));
      const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
      const row = rowOf("fulfilment_model");
      fireEvent.click(within(row).getByRole("radio", { name: "Own delivery" }));
      const alert = await within(row).findByRole("alert");
      expect(alert).toHaveTextContent("Could not preview that mode change. Try again.");
      expect(screen.queryByText("Preview mode change", { selector: "h3" })).toBeNull();
      expect(mockWriteConfig).not.toHaveBeenCalled();
    });

    it("each option's label row is a 44 px target below sm", async () => {
      const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
      const label = within(rowOf("fulfilment_model"))
        .getByRole("radio", { name: "Own delivery" })
        .closest("label")!;
      expect(label).toHaveClass("min-h-[44px]", "sm:min-h-6");
    });
  });

  it("picking both on a tenant without a fleet shows the console's fixed copy, never the server text", async () => {
    const SERVER_TEXT =
      "SERVER-TEXT fulfilment_model both needs driver_app_addon or route_optimization";
    mockPreview.mockResolvedValueOnce(previewFulfil("both"));
    mockWriteConfig.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: "FULFILMENT_MODE_NEEDS_FLEET", message: SERVER_TEXT },
      },
    });
    const rowOf = await renderRows([fulfilmentModeEffective(MODE), uncheckedSettingEffective()]);
    fireEvent.click(
      within(rowOf("fulfilment_model")).getByRole("radio", { name: "Delivery and shipping" }),
    );
    await screen.findByText("Preview mode change", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This business has no delivery fleet, so Delivery and shipping can't be turned on yet.",
    );
    expect(document.body).not.toHaveTextContent("SERVER-TEXT");
  });
});
