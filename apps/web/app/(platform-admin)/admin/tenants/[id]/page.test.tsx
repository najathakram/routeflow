import * as React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import TenantDetailPage from "./page";
import { superAdminClient } from "@/lib/admin-api";
import { REGISTRY_FIXTURE } from "./_features/__fixtures__/registry.fixtures";
import { EFFECTIVE_FIXTURE } from "./_features/__fixtures__/effective.fixtures";
import { diffsFixture } from "./_features/__fixtures__/diffs.fixtures";
import { previewFixture } from "./_features/__fixtures__/preview.fixtures";
import {
  PROFILES_FIXTURE,
  shippingPreviewWithBilling,
} from "./_features/__fixtures__/profiles.fixtures";

const TENANT_ID = "tenant-1";

const mockRouterPush = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: TENANT_ID }),
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
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
// The tenant's admin account card (GET .../admin); null = no admin yet.
let mockAdmin: unknown = null;

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
const mockSetImpersonation = jest.fn();
const mockProfilePreview = jest.fn();
const mockProfileApply = jest.fn();
let fulfilmentModeValue = "delivery";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: jest.fn((url: string) => {
      if (/\/admin$/.test(url)) return Promise.resolve({ data: { admin: mockAdmin } });
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

// Back-office P2: Impersonate records WHICH tenant it started from, so Exit can return there.
jest.mock("@/lib/impersonation", () => ({
  setImpersonation: (...args: unknown[]) => mockSetImpersonation(...args),
}));

// B857: the plan controls read the published catalog (GET /billing/plans via fetchPlanCatalog).
const mockFetchPlanCatalog = jest.fn();
jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
  fetchTenantPricing: () => new Promise(() => {}),
}));

jest.mock("@/lib/tenant-cookie", () => ({ setTenantCookie: jest.fn() }));

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
  mockAdmin = null;
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
          // P2: a comp starts at 30 days, never permanent by omission.
          expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ],
    });
    const previewed = mockPreview.mock.calls[0][1].overrides[0].expiresAt as string;
    const days = (new Date(previewed).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
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
        expiresAt: previewed,
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

describe("Tenant detail page — Impersonate and Extend Trial ask first (back office P1)", () => {
  const post = () => superAdminClient.post as unknown as jest.Mock;
  const calls = (re: RegExp) => post().mock.calls.filter((c) => re.test(String(c[0])));
  const ADMIN = {
    id: "u-1",
    username: "acme_admin",
    email: null,
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    forcePasswordChange: false,
  };

  it("Impersonate: click sends nothing and opens a dialog naming the tenant and its admin; Cancel sends nothing; Confirm sends one request", async () => {
    mockAdmin = ADMIN;
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    await waitFor(() => expect(screen.getAllByText("acme_admin").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    const dialog = await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    expect(within(dialog).getByText("acme_admin")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(calls(/impersonate$/)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls(/impersonate$/)).toHaveLength(0);

    // The confirmed request fails (no admin) so jsdom never navigates; only the request is asserted.
    post().mockRejectedValueOnce({ response: { data: { message: "No active TENANT_ADMIN" } } });
    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    const again = await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    fireEvent.click(within(again).getByRole("button", { name: "Impersonate" }));
    await waitFor(() => expect(calls(/impersonate$/)).toHaveLength(1));
    expect(calls(/impersonate$/)[0][0]).toBe("/platform-admin/tenants/tenant-1/impersonate");
    expect(
      await screen.findByText(
        "Acme has no active admin. Create one in Admin Account, then try again.",
      ),
    ).toBeInTheDocument();
  });

  it("Impersonate remembers the source tenant ID (only the id, never a URL) for Exit", async () => {
    mockAdmin = ADMIN;
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    await waitFor(() => expect(screen.getAllByText("acme_admin").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    const dialog = await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    post().mockResolvedValueOnce({
      data: { accessToken: "tok.en.x", impersonatedUser: { username: "acme_admin" } },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Impersonate" }));
    await waitFor(() => expect(mockSetImpersonation).toHaveBeenCalledTimes(1));
    expect(mockSetImpersonation).toHaveBeenCalledWith("tok.en.x", "acme", "acme_admin", TENANT_ID);
  });

  it("Extend Trial on a SUSPENDED tenant: nothing is sent until Confirm, and the dialog says the status becomes Trial", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));

    const dialog = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    expect(
      within(dialog).getByText(
        /Acme \(acme\) is Suspended\. Extending the trial changes its status to Trial until /,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(calls(/extend-trial$/)).toHaveLength(0);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls(/extend-trial$/)).toHaveLength(0);

    post().mockResolvedValueOnce({ data: { trialEndsAt: "2026-10-21T12:00:00.000Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    const again = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    fireEvent.click(within(again).getByRole("button", { name: "Extend Trial" }));
    await waitFor(() => expect(calls(/extend-trial$/)).toHaveLength(1));
    expect(calls(/extend-trial$/)[0]).toEqual([
      "/platform-admin/tenants/tenant-1/extend-trial",
      { days: 14 },
    ]);
    expect(
      await screen.findByText("Trial extended. It ends October 21, 2026."),
    ).toBeInTheDocument();
  });

  it("Extend Trial on an ACTIVE tenant is off, with the reason on screen (the server refuses it too)", async () => {
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    const btn = screen.getByRole("button", { name: "Extend Trial" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-describedby", "extend-trial-hint");
    expect(document.getElementById("extend-trial-hint")).toHaveTextContent(
      "This tenant is Active, so it can't be put on a trial. Suspend it or change its plan instead.",
    );
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls(/extend-trial$/)).toHaveLength(0);
  });

  it.each(["ACTIVE", "SUSPENDED", "READ_ONLY"])(
    "Extend Trial stays VISIBLE on a %s tenant, with a 'Not on a trial.' note (never hidden)",
    async (status) => {
      tenantOverrides = { status };
      render(<TenantDetailPage />);
      await screen.findByText("Quick Actions");
      expect(screen.getByRole("heading", { name: "Extend Trial" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Extend Trial" })).toBeInTheDocument();
      expect(screen.getByLabelText("Days")).toBeInTheDocument();
      expect(screen.getByText("Not on a trial.")).toBeInTheDocument();
      // ACTIVE is blocked (the server refuses it); the others may still be put on a trial.
      const btn = screen.getByRole("button", { name: "Extend Trial" });
      if (status === "ACTIVE") expect(btn).toBeDisabled();
      else expect(btn).toBeEnabled();
    },
  );

  it("on a TRIAL tenant there is no 'Not on a trial.' note and Extend Trial is enabled", async () => {
    tenantOverrides = { status: "TRIAL" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    expect(screen.queryByText("Not on a trial.")).toBeNull();
    expect(screen.getByRole("button", { name: "Extend Trial" })).toBeEnabled();
  });

  it("a race: the server's coded refusal reads the fixed Active-tenant copy, never its raw text", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    post().mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: "TENANT_TRIAL_EXTEND_NOT_ALLOWED", message: "raw internal wording" },
      },
    });
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    const dialog = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Extend Trial" }));
    expect(
      await screen.findByText(
        "This tenant is Active, so it can't be put on a trial. Suspend it or change its plan instead.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw internal wording/)).toBeNull();
  });

  it("Extend Trial on a TRIAL tenant: the dialog states the end date and says nothing about a status change", async () => {
    tenantOverrides = { status: "TRIAL" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    const dialog = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    expect(within(dialog).getByText(/^The trial will end on /)).toBeInTheDocument();
    expect(within(dialog).queryByText(/changes its status to Trial/)).not.toBeInTheDocument();
  });
});

describe("Tenant detail page — Suspend and Delete ask first (back office P1)", () => {
  const client = () => superAdminClient as unknown as { patch: jest.Mock; delete: jest.Mock };
  const statusPatches = () =>
    client().patch.mock.calls.filter((c) => /\/status$/.test(String(c[0])));

  it("Suspend: nothing is sent until Confirm; the dialog names the tenant and slug; Cancel sends nothing", async () => {
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(statusPatches()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(statusPatches()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const again = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    fireEvent.click(within(again).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(statusPatches()).toHaveLength(1));
    expect(statusPatches()[0]).toEqual([
      "/platform-admin/tenants/tenant-1/status",
      { status: "SUSPENDED" },
    ]);
  });

  it("Reactivate stays a single click (it restores access, it removes nothing)", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(statusPatches()).toHaveLength(1));
    expect(statusPatches()[0][1]).toEqual({ status: "ACTIVE" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["ACTIVE", "TRIAL", "READ_ONLY"])(
    "Delete Tenant is visible but DIM for a %s tenant, with the reason on screen (P2 flips the P1 enabled pin)",
    async (status) => {
      tenantOverrides = { status };
      render(<TenantDetailPage />);
      await screen.findByText("Quick Actions");
      const del = screen.getByRole("button", { name: "Delete Tenant" });
      expect(del).toBeDisabled();
      expect(del).toHaveAttribute("aria-describedby", "delete-tenant-hint");
      expect(document.getElementById("delete-tenant-hint")).toHaveTextContent(
        "Only a suspended tenant can be deleted. Suspend it first, then delete.",
      );
      fireEvent.click(del);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(client().delete).not.toHaveBeenCalled();
    },
  );

  it("Delete Tenant is enabled once the tenant is SUSPENDED, and the suspend-first line is gone", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    expect(screen.getByRole("button", { name: "Delete Tenant" })).toBeEnabled();
    expect(document.getElementById("delete-tenant-hint")).toBeNull();
  });

  it("N5: while a Suspend is in flight the Suspend button is disabled (its busy key is the real one)", async () => {
    let release: (v: unknown) => void = () => {};
    client().patch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(statusPatches()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled());
    release({ data: {} });
    await waitFor(() => expect(screen.getByRole("button", { name: "Suspend" })).toBeEnabled());
  });

  it("Delete: the type-the-slug dialog gates the button; DELETE is sent once and the page navigates away", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Delete Tenant" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme (acme)?" });
    const del = within(dialog).getByRole("button", { name: "Delete Tenant" });
    expect(del).toBeDisabled();
    expect(client().delete).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Type the tenant slug to confirm deletion"), {
      target: { value: "acme" },
    });
    fireEvent.click(del);
    await waitFor(() => expect(client().delete).toHaveBeenCalledTimes(1));
    expect(client().delete).toHaveBeenCalledWith("/platform-admin/tenants/tenant-1");
    await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith("/admin/tenants"));
  });

  it("a server refusal shows FIXED copy inside the dialog, which stays open; no navigation", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    client().delete.mockRejectedValueOnce({
      response: { status: 400, data: { message: "Tenant must be SUSPENDED (internal state 7)" } },
    });
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Delete Tenant" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme (acme)?" });
    fireEvent.change(within(dialog).getByLabelText("Type the tenant slug to confirm deletion"), {
      target: { value: "acme" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Tenant" }));
    expect(
      await within(dialog).findByText(
        "Only a suspended tenant can be deleted. Suspend it first, then delete.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal state 7/)).toBeNull();
    // N4: ONE message (inside the dialog), not a second banner on the page behind it.
    expect(
      screen.getAllByText("Only a suspended tenant can be deleted. Suspend it first, then delete."),
    ).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Delete Acme (acme)?" })).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("Escape closes the delete dialog and sends nothing", async () => {
    tenantOverrides = { status: "SUSPENDED" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Delete Tenant" }));
    await screen.findByRole("dialog", { name: "Delete Acme (acme)?" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client().delete).not.toHaveBeenCalled();
  });

  it("Extend Trial: days cleared / 0 / over 365 block Confirm with a plain line and send nothing", async () => {
    tenantOverrides = { status: "TRIAL" };
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    const dialog = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    expect(within(dialog).getByText("Enter 1–365 days.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Extend Trial" })).toBeDisabled();
    expect(within(dialog).queryByText(/Invalid Date/)).toBeNull();
    expect(
      (superAdminClient.post as unknown as jest.Mock).mock.calls.filter((c) =>
        /extend-trial$/.test(String(c[0])),
      ),
    ).toHaveLength(0);
  });

  it("a failed Extend Trial shows fixed copy, not the server's text", async () => {
    tenantOverrides = { status: "TRIAL" };
    (superAdminClient.post as unknown as jest.Mock).mockRejectedValueOnce({
      response: { data: { message: "prisma: unique constraint failed" } },
    });
    render(<TenantDetailPage />);
    await screen.findByText("Quick Actions");
    fireEvent.click(screen.getByRole("button", { name: "Extend Trial" }));
    const dialog = await screen.findByRole("dialog", { name: "Extend the trial for Acme (acme)?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Extend Trial" }));
    expect(await screen.findByText("Couldn't extend the trial. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/prisma/)).toBeNull();
  });
});
