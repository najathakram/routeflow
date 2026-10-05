import * as React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import TenantDetailPage from "./page";
import { REGISTRY_FIXTURE } from "./_features/__fixtures__/registry.fixtures";
import { EFFECTIVE_FIXTURE } from "./_features/__fixtures__/effective.fixtures";
import { diffsFixture } from "./_features/__fixtures__/diffs.fixtures";
import { previewFixture } from "./_features/__fixtures__/preview.fixtures";
import {
  PROFILES_FIXTURE,
  shippingPreviewWithBilling,
} from "./_features/__fixtures__/profiles.fixtures";

const TENANT_ID = "tenant-1";

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: TENANT_ID }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const mockFetchRegistry = jest.fn();
const mockFetchEffective = jest.fn();
const mockFetchDiffs = jest.fn();
const mockFetchMode = jest.fn();
const mockPreview = jest.fn();
const mockWriteConfig = jest.fn();

// Records the ORDER preview vs. create fire in, across two independently-mocked modules
// (brief D test 4: "submit → preview first (asserted call order), then #795's create").
const callOrder: string[] = [];

jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () => mockFetchRegistry(),
  fetchTenantFeaturesEffective: (tenantId: string) => mockFetchEffective(tenantId),
  fetchTenantFeatureDiffs: (tenantId: string) => mockFetchDiffs(tenantId),
  fetchEntitlementsMode: () => mockFetchMode(),
  previewTenantFeatures: (tenantId: string, req: unknown) => {
    callOrder.push("preview");
    return mockPreview(tenantId, req);
  },
  writeTenantFeatureConfig: (tenantId: string, key: string, req: unknown) =>
    mockWriteConfig(tenantId, key, req),
}));

let tenantOverrides: Record<string, unknown> = {};

function tenantFixture() {
  return {
    id: TENANT_ID,
    slug: "acme",
    name: "Acme",
    status: "ACTIVE",
    plan: "GROWTH",
    trialEndsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    businessName: "Acme",
    primaryColor: null,
    logoKey: null,
    addressLine1: null,
    city: null,
    state: null,
    zip: null,
    country: null,
    phone: null,
    subscription: null,
    counts: { users: 1, customers: 0, orders: 0, drivers: 0, routes: 0, customerLinks: 0 },
    ...tenantOverrides,
  };
}

// The overrides drawer's own registry fetch (a direct superAdminClient.get call, #795-era —
// unrelated to lib/platform-admin/features). B478 (#843) fixed the drawer to read the real
// nested `gate.via`/`gate.state` shape instead of a flat `via` — this fixture must match, or
// `selectedRegistryEntry?.gate.via` crashes with "Cannot read properties of undefined".
const OVERRIDES_REGISTRY_OPTION_FIXTURE = REGISTRY_FIXTURE.map((r) => ({
  key: r.key,
  label: r.label,
  area: r.area,
  kind: r.kind,
  internal: r.internal,
  gate: r.gate,
}));

const mockPost = jest.fn();
const mockProfilePreview = jest.fn();
const mockProfileApply = jest.fn();
let fulfilmentModeValue = "delivery";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: jest.fn((url: string) => {
      if (/\/admin$/.test(url)) return Promise.resolve({ data: { admin: null } });
      if (/\/audit-logs/.test(url))
        return Promise.resolve({ data: { data: [], meta: { total: 0, pages: 1 } } });
      if (/\/addons$/.test(url)) return Promise.resolve({ data: [] });
      if (/\/feature-overrides$/.test(url)) return Promise.resolve({ data: [] });
      if (/\/features\/registry$/.test(url))
        return Promise.resolve({ data: OVERRIDES_REGISTRY_OPTION_FIXTURE });
      if (/\/platform-admin\/business-profiles$/.test(url))
        return Promise.resolve({ data: { profiles: PROFILES_FIXTURE } });
      if (/\/feature-config\/fulfilment_model$/.test(url))
        return Promise.resolve({ data: { value: fulfilmentModeValue } });
      if (/\/feature-config\/counter_sales$/.test(url))
        return Promise.resolve({ data: { value: "unset" } });
      if (new RegExp(`/tenants/${TENANT_ID}$`).test(url))
        return Promise.resolve({ data: tenantFixture() });
      return Promise.resolve({ data: [] });
    }),
    post: jest.fn((url: string, body: unknown) => {
      if (/\/feature-overrides$/.test(url)) {
        callOrder.push("create");
        return mockPost(url, body);
      }
      if (/\/business-profile\/preview$/.test(url)) return mockProfilePreview(url, body);
      if (/\/business-profile$/.test(url)) return mockProfileApply(url, body);
      return Promise.resolve({ data: {} });
    }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

// B857: the plan controls read the published catalog (GET /billing/plans via fetchPlanCatalog).
const mockFetchPlanCatalog = jest.fn();
jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
  fetchTenantPricing: () => new Promise(() => {}),
}));

jest.mock("@/lib/tenant-cookie", () => ({ setTenantCookie: jest.fn() }));
jest.mock("@/lib/impersonation", () => ({ setImpersonation: jest.fn() }));

async function gotoSetupTab() {
  render(<TenantDetailPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Setup" }));
  await screen.findByText("compliance");
}

function setSuperAdminToken() {
  const payload = window.btoa(JSON.stringify({ role: "SUPER_ADMIN" }));
  window.localStorage.setItem("superAdminToken", `h.${payload}.s`);
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
  window.localStorage.clear();
  setSuperAdminToken();
  mockFetchRegistry.mockResolvedValue(REGISTRY_FIXTURE);
  mockFetchEffective.mockResolvedValue(EFFECTIVE_FIXTURE);
  mockFetchDiffs.mockResolvedValue(diffsFixture(TENANT_ID));
  mockFetchMode.mockResolvedValue({ mode: "shadow" });
  mockPost.mockResolvedValue({ data: {} });
  mockProfilePreview.mockResolvedValue({ data: shippingPreviewWithBilling() });
  mockProfileApply.mockResolvedValue({ data: {} });
  fulfilmentModeValue = "delivery";
  tenantOverrides = {};
  mockFetchPlanCatalog.mockResolvedValue(v11Catalog());
});

describe("Tenant detail page — Feature Console 'Customise' action (brief D test 4)", () => {
  it("opens #795's drawer prefilled for the clicked feature; submit previews, then Confirm creates — in that order", async () => {
    mockPreview.mockResolvedValueOnce(
      previewFixture({
        overrides: [{ featureKey: "tobacco_dealer", effect: "GRANT", reason: "Pilot waiver" }],
      }),
    );

    await gotoSetupTab();

    const tobaccoRow = document.querySelector('[data-feature-key="tobacco_dealer"]') as HTMLElement;
    fireEvent.click(within(tobaccoRow).getByRole("button", { name: /^Customise/ }));

    // Prefilled: the drawer opens with this feature key already selected.
    const featureSelect = (await screen.findByLabelText("Feature Key")) as HTMLSelectElement;
    expect(featureSelect.value).toBe("tobacco_dealer");

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Pilot waiver" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Override" }));

    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, {
      overrides: [
        {
          featureKey: "tobacco_dealer",
          effect: "GRANT",
          kind: "COMP",
          reason: "Pilot waiver",
          expiresAt: null,
        },
      ],
    });
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

    expect(callOrder).toEqual(["preview", "create"]);
    // B524 prep — this form has no missing-requires warning UI, so there is nothing for an
    // operator to acknowledge; `acknowledgeUnmetRequires` must be ABSENT, never sent as `false`
    // (a hardcoded `false` would assert an acknowledgment that never happened).
    expect(mockPost).toHaveBeenCalledWith(
      `/platform-admin/tenants/${TENANT_ID}/feature-overrides`,
      {
        featureKey: "tobacco_dealer",
        effect: "GRANT",
        kind: "COMP",
        reason: "Pilot waiver",
        expiresAt: null,
      },
    );
    const [, sentPayload] = mockPost.mock.calls[0];
    expect(sentPayload).not.toHaveProperty("acknowledgeUnmetRequires");
  });
});

// v11-shaped published catalog: the public projection never carries invite-only LITE.
function v11Catalog() {
  const entry = (planKey: string, sortOrder: number) => ({
    planKey,
    name: planKey,
    monthlyPrice: "0",
    annualPrice: null,
    isCustom: false,
    sortOrder,
  });
  return {
    version: 11,
    effectiveAt: null,
    plans: [entry("SCALE", 2), entry("STARTER", 0), entry("ENTERPRISE", 3), entry("GROWTH", 1)],
  };
}

function optionValues(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.value);
}

async function gotoBillingTab() {
  render(<TenantDetailPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Billing & Subscription" }));
}

describe("REG-B857: tenant plan controls offer the published catalog, not a hardcoded list", () => {
  it("REG-B857 T1: Manual Activation offers every catalog plan, GROWTH included, in catalog order", async () => {
    tenantOverrides = { plan: "STARTER", planKey: "STARTER" };
    await gotoBillingTab();
    const select = await screen.findByRole("combobox", { name: "Plan" });
    await waitFor(() =>
      expect(optionValues(select)).toEqual(["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]),
    );
  });

  it("REG-B857 T2: Manual Activation shows the tenant's own plan and posts exactly what it shows", async () => {
    tenantOverrides = { plan: "TEAM", planKey: "GROWTH" };
    await gotoBillingTab();
    const select = (await screen.findByRole("combobox", { name: "Plan" })) as HTMLSelectElement;
    await waitFor(() => expect(optionValues(select)).toContain("GROWTH"));
    expect(select.value).toBe("GROWTH");

    const { superAdminClient } = jest.requireMock("@/lib/admin-api");
    superAdminClient.post.mockResolvedValueOnce({
      data: { plan: "GROWTH", periodEnd: "2026-10-25T00:00:00.000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate Subscription" }));
    await waitFor(() =>
      expect(superAdminClient.post).toHaveBeenCalledWith(
        `/platform-admin/tenants/${TENANT_ID}/activate-subscription`,
        expect.objectContaining({ plan: "GROWTH" }),
      ),
    );
  });

  it("REG-B857 T3: Change Plan offers the catalog plans with the tenant's resolved plan selected", async () => {
    tenantOverrides = { plan: "TEAM", planKey: "GROWTH" };
    render(<TenantDetailPage />);
    const select = (await screen.findByRole("combobox", { name: "New plan" })) as HTMLSelectElement;
    await waitFor(() =>
      expect(optionValues(select)).toEqual(["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]),
    );
    expect(select.value).toBe("GROWTH");
    expect(screen.getByRole("button", { name: "Change Plan" })).toBeDisabled();
  });

  it("pin: a tenant on a plan the catalog does not offer (invite-only LITE) keeps it selected", async () => {
    tenantOverrides = { plan: "LITE", planKey: "LITE" };
    await gotoBillingTab();
    const select = (await screen.findByRole("combobox", { name: "Plan" })) as HTMLSelectElement;
    await waitFor(() => expect(optionValues(select)).toContain("SCALE"));
    expect(optionValues(select)).toEqual(["STARTER", "GROWTH", "SCALE", "ENTERPRISE", "LITE"]);
    expect(select.value).toBe("LITE");
  });

  it("pin: an unreadable catalog falls back to every plan the API accepts, with a notice", async () => {
    mockFetchPlanCatalog.mockRejectedValue(new Error("down"));
    tenantOverrides = { plan: "STARTER", planKey: "STARTER" };
    await gotoBillingTab();
    const select = await screen.findByRole("combobox", { name: "Plan" });
    await waitFor(() => expect(optionValues(select)).toEqual([...PLAN_KEYS]));
    expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
  });
});

describe("Tenant detail page — the Setup tab (business profiles)", () => {
  it("names the tab Setup (not 'Addons & Features')", async () => {
    render(<TenantDetailPage />);
    expect(await screen.findByRole("button", { name: "Setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Addons & Features" })).not.toBeInTheDocument();
  });

  it("opens with the plain-English current setup, then the profile picker, then the feature console", async () => {
    await gotoSetupTab();
    expect(await screen.findByText("Current setup")).toBeInTheDocument();
    expect(
      await screen.findByText("Own delivery: orders go out on the business's own trucks"),
    ).toBeInTheDocument();
    expect(screen.getByText("Counter sales")).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /Delivery distributor/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^In-store retailer/ })).toBeDisabled();
    expect(screen.getAllByText("Available when counter sales launch")).toHaveLength(2);
    // The existing feature console is still there, below.
    expect(screen.getByText("compliance")).toBeInTheDocument();
  });

  it("previews with the API's change list, then Confirm applies once and the setup reloads", async () => {
    await gotoSetupTab();
    fireEvent.click(await screen.findByRole("radio", { name: /Shipping wholesaler/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));

    const dialog = await screen.findByRole("dialog");
    expect(mockProfilePreview).toHaveBeenCalledWith(
      `/platform-admin/tenants/${TENANT_ID}/business-profile/preview`,
      { profile: "shipping_wholesaler" },
    );
    expect(mockProfileApply).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText(
        "At-door payment collection will be switched off and its billing stopped",
      ),
    ).toBeInTheDocument();

    const registryCalls = mockFetchRegistry.mock.calls.length;
    fulfilmentModeValue = "ship";
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mockProfileApply).toHaveBeenCalledTimes(1));
    expect(mockProfileApply).toHaveBeenCalledWith(
      `/platform-admin/tenants/${TENANT_ID}/business-profile`,
      // the confirm sends back the previewed plan's fingerprint (#3199)
      { profile: "shipping_wholesaler", planFingerprint: "a".repeat(64) },
    );
    expect(
      await screen.findByText("Ship by carrier: orders are shipped, not delivered"),
    ).toBeInTheDocument();
    // The feature console behind it reloaded too.
    await waitFor(() => expect(mockFetchRegistry.mock.calls.length).toBeGreaterThan(registryCalls));
  });
});
