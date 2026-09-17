import * as React from "react";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { FeatureConsole } from "./FeatureConsole";
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

jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () => mockFetchRegistry(),
  fetchTenantFeaturesEffective: (tenantId: string) => mockFetchEffective(tenantId),
  fetchTenantFeatureDiffs: (tenantId: string) => mockFetchDiffs(tenantId),
  fetchEntitlementsMode: () => mockFetchMode(),
  previewTenantFeatures: (tenantId: string, req: unknown) => mockPreview(tenantId, req),
  writeTenantFeatureConfig: (tenantId: string, key: string, req: unknown) =>
    mockWriteConfig(tenantId, key, req),
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
});
