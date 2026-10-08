import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import AdminCreateTenantPage from "./page";
import { superAdminClient } from "@/lib/admin-api";
import { PROFILES_FIXTURE } from "../[id]/_features/__fixtures__/profiles.fixtures";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

const mockFetchPlanCatalog = jest.fn();
const mockFetchProfiles = jest.fn();
const mockApplyProfile = jest.fn();
const mockPreviewProfile = jest.fn();

jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchBusinessProfiles: () => mockFetchProfiles(),
  previewBusinessProfile: (tenantId: string, profile: string) =>
    mockPreviewProfile(tenantId, profile),
  applyBusinessProfile: (tenantId: string, profile: string, planFingerprint: string) =>
    mockApplyProfile(tenantId, profile, planFingerprint),
}));

jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

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
  mockFetchProfiles.mockResolvedValue(PROFILES_FIXTURE);
  mockApplyProfile.mockResolvedValue({});
  mockPreviewProfile.mockResolvedValue({ planFingerprint: "f".repeat(64) });
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

    const select = await screen.findByRole("combobox");
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
    const select = screen.getByRole("combobox") as HTMLSelectElement;
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
    const select = screen.getByRole("combobox") as HTMLSelectElement;
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

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
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

    const select = await screen.findByRole("combobox");
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
    const select = screen.getByRole("combobox") as HTMLSelectElement;
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
    fireEvent.submit(screen.getByRole("button", { name: /create tenant/i }).closest("form")!);
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
    fireEvent.submit(screen.getByRole("button", { name: /create tenant/i }).closest("form")!);

    expect(
      await screen.findByText("Business name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/businessName must not start/)).not.toBeInTheDocument();
  });
});

// Business profiles: a new account can start with one. The create API takes no `profile`, so the page creates the
// tenant first, previews the profile for the new id and confirms that plan; a plan that would stop billing opens
// the preview for the admin instead of applying (#3220). A failed apply never hides that the account WAS created.
describe("create-tenant business profile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProfiles.mockResolvedValue(PROFILES_FIXTURE);
    mockApplyProfile.mockResolvedValue({});
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });
  });

  function fillForm() {
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/admin email/i), {
      target: { value: "o@acme.example" },
    });
    fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
  }
  function submit() {
    fireEvent.submit(screen.getByRole("button", { name: /create tenant/i }).closest("form")!);
  }
  async function createWithProfile() {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "new-tenant-id", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("radio", { name: /Shipping wholesaler/ }));
    fillForm();
    submit();
  }

  it("offers the four profiles (in-store ones disabled) plus 'set up later', defaulting to none", async () => {
    render(<AdminCreateTenantPage />);
    expect(await screen.findByRole("radio", { name: /Delivery distributor/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Shipping wholesaler/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /In-store retailer/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /In-store \+ shipping retailer/ })).toBeDisabled();
    expect(screen.queryByText("Available when counter sales launch")).toBeNull();
    expect(screen.getByRole("radio", { name: /Set up later/ })).toBeChecked();
  });

  it("SA-1: after the profile applies, an interim line lists what was set (from the apply response)", async () => {
    mockApplyProfile.mockResolvedValue({
      profile: "shipping_wholesaler",
      changed: ["fulfilment_model"],
      summary: ["Where orders go: Not configured → Ship by carrier", "Recurring routes: off"],
    });
    await createWithProfile();
    const list = await screen.findByTestId("profile-applied-summary");
    expect(
      within(list).getByText("Where orders go: Not configured → Ship by carrier"),
    ).toBeInTheDocument();
    expect(within(list).getByText("Recurring routes: off")).toBeInTheDocument();
    expect(screen.getByText("Business profile applied: Shipping wholesaler.")).toBeInTheDocument();
  });

  it("SA-1: an apply that changed nothing says so instead of showing an empty list", async () => {
    mockApplyProfile.mockResolvedValue({
      profile: "shipping_wholesaler",
      changed: [],
      summary: [],
    });
    await createWithProfile();
    expect(await screen.findByTestId("profile-applied-nothing")).toHaveTextContent(
      "Nothing needed to change",
    );
    expect(screen.queryByTestId("profile-applied-summary")).toBeNull();
  });

  it("without a profile: creates the tenant with no profile field and applies nothing", async () => {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t1", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    await screen.findByRole("radio", { name: /Delivery distributor/ });
    fillForm();
    submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    const [, payload] = (superAdminClient.post as jest.Mock).mock.calls[0];
    expect(payload).not.toHaveProperty("profile");
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("with a profile: creates first (the create API takes no profile), then applies it to the new tenant", async () => {
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "new-tenant-id", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("radio", { name: /Shipping wholesaler/ }));
    fillForm();
    submit();
    expect(
      await screen.findByText("Business profile applied: Shipping wholesaler."),
    ).toBeInTheDocument();
    const [url, payload] = (superAdminClient.post as jest.Mock).mock.calls[0];
    expect(url).toBe("/platform-admin/tenants");
    expect(payload).not.toHaveProperty("profile");
    expect(mockApplyProfile).toHaveBeenCalledTimes(1);
    // previewed first, then confirmed with that plan's fingerprint (#3199)
    expect(mockPreviewProfile).toHaveBeenCalledWith("new-tenant-id", "shipping_wholesaler");
    expect(mockApplyProfile).toHaveBeenCalledWith(
      "new-tenant-id",
      "shipping_wholesaler",
      "f".repeat(64),
    );
  });

  it("a failed create applies no profile", async () => {
    (superAdminClient.post as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    render(<AdminCreateTenantPage />);
    fireEvent.click(await screen.findByRole("radio", { name: /Shipping wholesaler/ }));
    fillForm();
    submit();
    await screen.findByText("Failed to create tenant");
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("a failed profile apply still reports the created account, with fixed copy and where to retry", async () => {
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
    fireEvent.click(await screen.findByRole("radio", { name: /Delivery distributor/ }));
    fillForm();
    submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    const alert = await screen.findByTestId("profile-apply-failed");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "The account was created, but its business profile was not applied.",
    );
    expect(alert).toHaveTextContent(
      "That business profile is not available yet. In-store profiles open when counter sales launch.",
    );
    expect(alert).toHaveTextContent("Apply it from the tenant's Setup tab.");
    expect(document.body.textContent).not.toContain("RAW SERVER TEXT");
    expect(screen.getByRole("link", { name: "View tenant" })).toHaveAttribute(
      "href",
      "/admin/tenants/t9",
    );
  });

  it("a profile list that cannot load says so and the form still creates a tenant", async () => {
    mockFetchProfiles.mockRejectedValue(new Error("down"));
    (superAdminClient.post as jest.Mock).mockResolvedValueOnce({
      data: { id: "t1", slug: "acme" },
    });
    render(<AdminCreateTenantPage />);
    expect(
      await screen.findByText(
        "Business profiles could not be loaded. You can set one later from the tenant's Setup tab.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fillForm();
    submit();
    expect(await screen.findByText("Tenant created successfully!")).toBeInTheDocument();
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("#3220: a profile that would STOP billing is never auto-applied: the preview opens for the admin", async () => {
    mockPreviewProfile.mockResolvedValueOnce({
      profile: "shipping_wholesaler",
      plan: {
        overrides: [],
        modes: [],
        billing: [{ featureKey: "driver_payments", action: "disable", manual: false }],
      },
      summary: ["At-door payment collection will be switched off and its billing stopped"],
      changes: [],
      planFingerprint: "e".repeat(64),
      before: [],
      after: [],
      changed: [],
    });
    await createWithProfile();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Billing stops as soon as you confirm.")).toBeInTheDocument();
    expect(mockApplyProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockApplyProfile).toHaveBeenCalledWith(
        "new-tenant-id",
        "shipping_wholesaler",
        "e".repeat(64),
      ),
    );
  });

  it("#3220: a failed preview applies NOTHING and says so", async () => {
    mockPreviewProfile.mockRejectedValueOnce(new Error("Network Error"));
    await createWithProfile();
    expect(await screen.findByTestId("profile-apply-failed")).toHaveTextContent(
      "The account was created, but its business profile was not applied.",
    );
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });
});
