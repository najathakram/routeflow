import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import AdminCreateTenantPage from "./page";
import { superAdminClient } from "@/lib/admin-api";
import { CAPABILITY_PRESETS_FIXTURE } from "../[id]/_features/__fixtures__/capabilities.fixtures";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

const mockFetchPlanCatalog = jest.fn();
const mockFetchProfiles = jest.fn();
const mockApplyProfile = jest.fn();
const mockPreviewProfile = jest.fn();

jest.mock("@/lib/platform-admin/capabilities-contract", () => ({
  CAPABILITIES_ERROR_CODES: { BUSINESS_CAPABILITIES_EMPTY: "BUSINESS_CAPABILITIES_EMPTY" },
  fetchCapabilityCatalog: () => mockFetchProfiles(),
  previewBusinessCapabilities: (tenantId: string, body: unknown) =>
    mockPreviewProfile(tenantId, body),
  applyBusinessCapabilities: (tenantId: string, body: unknown, planFingerprint: string) =>
    mockApplyProfile(tenantId, body, planFingerprint),
}));

const CATALOG_RESPONSE = { presets: CAPABILITY_PRESETS_FIXTURE, availability: {} };

jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

// SA-2: the form's Create opens the review sheet; only the sheet's Create sends the request.
async function submitViaSheet() {
  fireEvent.click(screen.getByRole("button", { name: /^create tenant$/i }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
}

function planEntry(planKey: string, sortOrder: number) {
  return {
    planKey,
    name: planKey,
    monthlyPrice: "0",
    annualPrice: null,
    isCustom: false,
    sortOrder,
  };
}

beforeEach(() => {
  mockFetchProfiles.mockResolvedValue(CATALOG_RESPONSE);
  mockApplyProfile.mockResolvedValue({});
  mockPreviewProfile.mockResolvedValue({ planFingerprint: "f".repeat(64), blocked: null });
});

describe("AdminCreateTenantPage — plan <select> sourced from the catalog (T14)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("T14-2 / R24: renders options from fetchPlanCatalog, sorted by sortOrder, labeled via planLabel", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [
        planEntry("SCALE", 3),
        planEntry("ENTERPRISE", 4),
        planEntry("STARTER", 1),
        planEntry("GROWTH", 2),
      ],
    });

    render(<AdminCreateTenantPage />);

    const select = await screen.findByRole("combobox", { name: "Plan" });
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll("option"));
      expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
        "STARTER",
        "GROWTH",
        "SCALE",
        "ENTERPRISE",
      ]);
    });
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual(["Starter", "Growth", "Scale", "Enterprise"]);
  });

  it("T14-3 / R25 (case A — rejects): falls back to the full PLAN_KEYS list, with an inline unavailable message", async () => {
    mockFetchPlanCatalog.mockRejectedValue(new Error("network down"));

    render(<AdminCreateTenantPage />);

    await waitFor(() => {
      expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
    });
    const select = screen.getByRole("combobox", { name: "Plan" }) as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([...PLAN_KEYS]);
    const submit = screen.getByRole("button", { name: /create tenant/i });
    expect(submit).not.toBeDisabled();
  });

  it("T14-3 / R25 (case B — empty catalog): falls back the same way when plans resolve empty", async () => {
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });

    render(<AdminCreateTenantPage />);

    await waitFor(() => {
      expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
    });
    const select = screen.getByRole("combobox", { name: "Plan" }) as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([...PLAN_KEYS]);
    const submit = screen.getByRole("button", { name: /create tenant/i });
    expect(submit).not.toBeDisabled();
  });

  it("T14-4 / R26: resets form.plan to plans[0].planKey when the default (STARTER) isn't in the loaded catalog", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [planEntry("GROWTH", 1), planEntry("SCALE", 2)],
    });

    render(<AdminCreateTenantPage />);

    const select = (await screen.findByRole("combobox", { name: "Plan" })) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe("GROWTH");
    });
  });

  // REG-743-F1: the server rejects a non-PLAN_KEYS plan (create-tenant.dto.ts's
  // @IsIn(PLAN_KEYS)), so a catalog row outside PLAN_KEYS (a legacy or not-yet-launched plan)
  // must never be offered here even though it comes from the same published catalog.
  it("REG-743-F1 every rendered option is a PLAN_KEYS member, even when the catalog includes an extra key", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [
        planEntry("TEAM", 1),
        planEntry("STARTER", 2),
        planEntry("GROWTH", 3),
        planEntry("SCALE", 4),
        planEntry("ENTERPRISE", 5),
      ],
    });

    render(<AdminCreateTenantPage />);

    const select = await screen.findByRole("combobox", { name: "Plan" });
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
      expect(options.map((o) => o.value)).toEqual(["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]);
    });
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    for (const option of options) {
      expect(PLAN_KEYS).toContain(option.value);
    }
  });

  it("REG-743-F1 falls back to exactly PLAN_KEYS when the catalog has no PLAN_KEYS-eligible row", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [planEntry("TEAM", 1), planEntry("BUSINESS", 2)],
    });

    render(<AdminCreateTenantPage />);

    await waitFor(() => {
      expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
    });
    const select = screen.getByRole("combobox", { name: "Plan" }) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual([...PLAN_KEYS]);
  });
});

// #2439: the success panel reports the welcome email's delivery and the stable Pay-now link —
// and never shows a password.
describe("#2439 create-tenant success panel", () => {
  async function submitWith(data: Record<string, unknown>) {
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({ data });
    render(<AdminCreateTenantPage />);
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/admin email/i), {
      target: { value: "o@acme.example" },
    });
    fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
    await submitViaSheet();
    return screen.findByTestId("welcome-email-status");
  }

  it("says the welcome email was sent, and shows the stable Pay-now link", async () => {
    const status = await submitWith({
      id: "t1",
      slug: "acme",
      payUrl: "https://app.example/login?redirect=%2Fsettings%2Fbilling",
      welcomeEmail: { to: "o@acme.example", delivered: true, transport: "smtp" },
    });
    expect(status).toHaveTextContent(/Welcome email sent to o@acme.example/);
    expect(screen.getByRole("link", { name: /login\?redirect/ })).toHaveAttribute(
      "href",
      "https://app.example/login?redirect=%2Fsettings%2Fbilling",
    );
    expect(screen.queryByText(/temporary password/i)).not.toBeInTheDocument();
  });

  it("warns loudly when the welcome email was NOT delivered", async () => {
    const status = await submitWith({
      id: "t1",
      slug: "acme",
      payUrl: null,
      welcomeEmail: {
        to: "o@acme.example",
        delivered: false,
        transport: "none",
        error: "no transport",
      },
    });
    expect(status).toHaveAttribute("role", "alert");
    expect(status).toHaveTextContent(/NOT delivered/);
    expect(status).toHaveTextContent(/Reset admin password/);
  });

  // #2438: the Pay-now link is one unbroken monospace token; it ran off the card on a phone.
  it("wraps the Pay-now link inside the card (break-all) and gives it its own Copy button", async () => {
    const payUrl = "https://app.example/login?redirect=%2Fsettings%2Fbilling";
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
    await submitWith({
      id: "t1",
      slug: "acme",
      payUrl,
      welcomeEmail: { to: "o@acme.example", delivered: true, transport: "smtp" },
    });
    expect(screen.getByRole("link", { name: /login\?redirect/ })).toHaveClass("break-all");
    const copy = screen.getByRole("button", { name: "Copy Pay-now link" });
    fireEvent.click(copy);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(payUrl);
    await waitFor(() => expect(copy).toHaveTextContent("Copied"));
  });

  // #2598 review: a false "Copied" leaves the PREVIOUS clipboard (maybe another tenant's link) to be
  // pasted into the client's email. A failed copy must say so and select the link instead.
  it("a failed copy of the Pay-now link says so and selects the link, never 'Copied'", async () => {
    const payUrl = "https://app.example/login?redirect=%2Fsettings%2Fbilling";
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) },
    });
    await submitWith({
      id: "t1",
      slug: "acme",
      payUrl,
      welcomeEmail: { to: "o@acme.example", delivered: true, transport: "smtp" },
    });
    const copy = screen.getByRole("button", { name: "Copy Pay-now link" });
    fireEvent.click(copy);
    await waitFor(() => expect(copy).toHaveTextContent("Copy failed — select the link"));
    expect(copy).not.toHaveTextContent("Copied");
    expect(window.getSelection()?.toString()).toBe(payUrl);
  });

  it("renders no Copy button when there is no Pay-now link", async () => {
    await submitWith({
      id: "t1",
      slug: "acme",
      payUrl: null,
      welcomeEmail: { to: "o@acme.example", delivered: true, transport: "smtp" },
    });
    expect(screen.queryByRole("button", { name: "Copy Pay-now link" })).not.toBeInTheDocument();
  });
});

// B956: a refused formula-led business name shows FIXED copy with a human label, not the server text.
describe("B956 create-tenant refused business name", () => {
  it("shows the Business name copy, never the raw server message", async () => {
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });
    (superAdminClient.post as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: {
          data: {
            statusCode: 400,
            code: "TEXT_CELL_FORMULA_LEAD",
            field: "businessName",
            message: "businessName must not start with = + - @ or a tab/line break",
          },
        },
      }),
    );
    render(<AdminCreateTenantPage />);
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "=EVIL(1)" } });
    fireEvent.change(screen.getByLabelText(/admin email/i), {
      target: { value: "o@acme.example" },
    });
    fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
    await submitViaSheet();

    expect(
      await screen.findByText("Business name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/businessName must not start/)).not.toBeInTheDocument();
  });
});

// Capabilities (BO-05): a new account can start with ticks. The create API takes none, so the page creates the
// tenant first, previews the ticks for the new id and confirms that plan; a plan that would stop billing opens
// the review for the admin instead of applying (#3220). A failed apply never hides that the account WAS created.
describe("create-tenant capabilities", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProfiles.mockResolvedValue(CATALOG_RESPONSE);
    mockApplyProfile.mockResolvedValue({});
    mockPreviewProfile.mockResolvedValue({ planFingerprint: "f".repeat(64), blocked: null });
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });
  });

  function fillForm() {
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/admin email/i), {
      target: { value: "o@acme.example" },
    });
    fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
  }
  async function submit() {
    await submitViaSheet();
  }
  /** Ticks Shipping + Counter, creates, and lets the chain run. */
  async function createWithTicks(boxes: string[] = ["Ships by carrier", "Sells at the counter"]) {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "new-tenant-id", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    for (const name of boxes) {
      fireEvent.click(await screen.findByRole("checkbox", { name }));
    }
    fillForm();
    await submit();
  }

  it("offers the three boxes and a Start from… menu of the seven presets, nothing ticked, no Custom", async () => {
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Start from…" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);
    for (const name of ["Delivers on own trucks", "Ships by carrier", "Sells at the counter"]) {
      expect(screen.getByRole("checkbox", { name })).not.toBeChecked();
    }
    expect(screen.queryByRole("radio", { name: /Custom/ })).toBeNull();
  });

  it("SA-1: after the capabilities apply, an interim line lists what was set (from the apply response)", async () => {
    mockApplyProfile.mockResolvedValue({
      changed: ["fulfilment_model"],
      summary: ["Where orders go: Not configured → Ship by carrier", "Recurring routes: off"],
    });
    await createWithTicks(["Ships by carrier"]);
    const list = await screen.findByTestId("profile-applied-summary");
    expect(
      within(list).getByText("Where orders go: Not configured → Ship by carrier"),
    ).toBeInTheDocument();
    expect(within(list).getByText("Recurring routes: off")).toBeInTheDocument();
    expect(
      screen.getByText("Saved what this business does: Ships by carrier."),
    ).toBeInTheDocument();
  });

  it("SA-1: an apply that changed nothing says so instead of showing an empty list", async () => {
    mockApplyProfile.mockResolvedValue({ changed: [], summary: [] });
    await createWithTicks(["Ships by carrier"]);
    expect(await screen.findByTestId("profile-applied-nothing")).toHaveTextContent(
      "Nothing needed to change",
    );
    expect(screen.queryByTestId("profile-applied-summary")).toBeNull();
  });

  // The old picker's "Custom: I'll choose the features myself" meant: no profile, the plan's defaults, features
  // chosen later. Nothing ticked is exactly that, and manual ticking replaces choosing a profile, so no path is lost.
  it("Custom parity: a preset pick can be cleared by hand, and nothing ticked creates an unset tenant like the old Custom", async () => {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t1", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Start from…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delivery + counter" }));
    expect(screen.getByRole("checkbox", { name: "Sells at the counter" })).toBeChecked();
    // clear every box by hand: back to the plan's defaults
    for (const name of ["Delivers on own trucks", "Ships by carrier", "Sells at the counter"]) {
      const box = screen.getByRole("checkbox", { name });
      if ((box as HTMLInputElement).checked) fireEvent.click(box);
    }
    expect(
      screen.getByText(
        "Nothing ticked: the account starts with the plan's defaults. You can set this later in Setup.",
      ),
    ).toBeVisible();
    fillForm();
    await submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    // exactly the create, nothing else: no preview, no apply, no profile result line
    expect(superAdminClient.post as jest.Mock).toHaveBeenCalledTimes(1);
    expect(mockPreviewProfile).not.toHaveBeenCalled();
    expect(mockApplyProfile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("profile-applied")).toBeNull();
    expect(screen.queryByTestId("profile-apply-failed")).toBeNull();
  });

  it("without ticks: creates the tenant with no capabilities field and applies nothing", async () => {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t1", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    await screen.findByRole("button", { name: "Start from…" });
    fillForm();
    await submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    const [, payload] = (superAdminClient.post as jest.Mock).mock.calls[0];
    expect(payload).not.toHaveProperty("profile");
    expect(mockPreviewProfile).not.toHaveBeenCalled();
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("with ticks {shipping, counter}: creates first, then previews and applies those ticks to the new tenant (red on master: posted a profile key)", async () => {
    await createWithTicks();
    expect(
      await screen.findByText(
        "Saved what this business does: Ships by carrier, Sells at the counter.",
      ),
    ).toBeInTheDocument();
    const [url, payload] = (superAdminClient.post as jest.Mock).mock.calls[0];
    expect(url).toBe("/platform-admin/tenants");
    expect(payload).not.toHaveProperty("profile");
    expect(mockApplyProfile).toHaveBeenCalledTimes(1);
    // previewed first, then confirmed with that plan's fingerprint (#3199); Shipping + Counter opens as a Counter sale
    const body = { delivery: false, shipping: true, counter: true, opensAs: "counter" };
    expect(mockPreviewProfile).toHaveBeenCalledWith("new-tenant-id", body);
    expect(mockApplyProfile).toHaveBeenCalledWith("new-tenant-id", body, "f".repeat(64));
  });

  it("a failed create applies nothing", async () => {
    (superAdminClient.post as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Ships by carrier" }));
    fillForm();
    await submit();
    await screen.findByText("Could not create the tenant. Try again.");
    expect(mockPreviewProfile).not.toHaveBeenCalled();
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("a failed apply still reports the created account, with fixed copy and where to retry", async () => {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t9", slug: "acme" },
    });
    mockApplyProfile.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: {
          status: 400,
          data: {
            code: API_ERROR_CODES.BUSINESS_PROFILE_UNAVAILABLE,
            message: "RAW SERVER TEXT should never show",
          },
        },
      }),
    );
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Delivers on own trucks" }));
    fillForm();
    await submit();
    const alert = await screen.findByTestId("profile-apply-failed");
    expect(screen.getByTestId("create-banner")).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "Created Acme, but what this business does didn't save. Open Setup to finish it.",
    );
    expect(alert).toHaveTextContent("This isn't available for this business.");
    expect(document.body.textContent).not.toContain("RAW SERVER TEXT");
    expect(screen.getByRole("link", { name: "Open Acme" })).toHaveAttribute(
      "href",
      "/admin/tenants/t9?tab=setup",
    );
  });

  it("a preview that comes back blocked applies nothing and says so", async () => {
    mockPreviewProfile.mockResolvedValueOnce({
      planFingerprint: "d".repeat(64),
      blocked: { code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 1 },
    });
    await createWithTicks(["Ships by carrier"]);
    expect(await screen.findByTestId("profile-apply-failed")).toHaveTextContent(
      "Created Acme, but what this business does didn't save.",
    );
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("a catalog that cannot load says so and the form still creates a tenant", async () => {
    mockFetchProfiles.mockRejectedValue(new Error("down"));
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t1", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    expect(
      await screen.findByText(
        "The presets could not be loaded. You can still tick what the business does, or set it later in Setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start from…" })).not.toBeInTheDocument();
    fillForm();
    await submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("#3220: a plan that would STOP billing is never auto-applied: the review opens for the admin", async () => {
    mockPreviewProfile.mockResolvedValueOnce({
      plan: {
        overrides: [],
        comps: [],
        modes: [],
        billing: [{ featureKey: "driver_payments", action: "disable", manual: false }],
      },
      summary: [],
      changes: [],
      planFingerprint: "e".repeat(64),
      blocked: null,
    });
    await createWithTicks();
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Change what this business does",
    });
    // the review names the ticked capabilities, not a profile
    expect(within(reviewDialog).getByText("Ships by carrier, Sells at the counter")).toBeVisible();
    expect(
      within(reviewDialog).getByText("Turn off At-door payment collection. Billing stops."),
    ).toBeInTheDocument();
    expect(mockApplyProfile).not.toHaveBeenCalled();
    fireEvent.click(within(reviewDialog).getByRole("button", { name: "Stop billing and apply" }));
    await waitFor(() =>
      expect(mockApplyProfile).toHaveBeenCalledWith(
        "new-tenant-id",
        { delivery: false, shipping: true, counter: true, opensAs: "counter" },
        "e".repeat(64),
      ),
    );
  });

  it("a review that only switches comp rows off applies with plain 'Apply'", async () => {
    mockPreviewProfile.mockResolvedValueOnce({
      plan: {
        overrides: [],
        comps: [],
        modes: [],
        billing: [{ featureKey: "driver_payments", action: "disable", manual: false, comp: true }],
      },
      summary: [],
      changes: [],
      planFingerprint: "e".repeat(64),
      blocked: null,
    });
    await createWithTicks();
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Change what this business does",
    });
    expect(within(reviewDialog).getByRole("button", { name: "Apply" })).toBeEnabled();
    for (const name of ["Cancel", "Apply"]) {
      expect(within(reviewDialog).getByRole("button", { name })).toHaveClass("!min-h-[44px]");
    }
  });

  it("#3220: a failed preview applies NOTHING and says so", async () => {
    mockPreviewProfile.mockRejectedValueOnce(new Error("Network Error"));
    await createWithTicks();
    expect(await screen.findByTestId("profile-apply-failed")).toHaveTextContent(
      "Created Acme, but what this business does didn't save. Open Setup to finish it.",
    );
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });
});

describe("AdminCreateTenantPage — test-tenant slug notice (row 195)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });
  });

  it("shows 'this will be a TEST tenant' only while the slug matches a test pattern", async () => {
    render(<AdminCreateTenantPage />);
    const slug = await screen.findByLabelText("Slug");
    expect(screen.queryByTestId("test-tenant-notice")).toBeNull();
    fireEvent.change(slug, { target: { value: "acme-foods" } });
    expect(screen.queryByTestId("test-tenant-notice")).toBeNull();
    fireEvent.change(slug, { target: { value: "qa-smoke-1" } });
    expect(screen.getByTestId("test-tenant-notice").textContent).toMatch(/TEST tenant/);
    fireEvent.change(slug, { target: { value: "e2e-routeflow" } });
    expect(screen.getByTestId("test-tenant-notice")).toBeTruthy();
  });
});
