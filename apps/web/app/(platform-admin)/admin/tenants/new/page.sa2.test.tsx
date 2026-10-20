import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdminCreateTenantPage from "./page";
import { superAdminClient } from "@/lib/admin-api";
import { CAPABILITY_PRESETS_FIXTURE } from "../[id]/_features/__fixtures__/capabilities.fixtures";

// SA-2: the Create Tenant page — Plan and start, capability choices (BO-05), Free add-ons, the review sheet,
// the create chain (tenant -> activate -> capabilities -> add-ons) and the result banner that scrolls and takes focus.

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { post: jest.fn() },
}));

const mockFetchPlanCatalog = jest.fn();
const mockFetchProfiles = jest.fn();
const mockApplyProfile = jest.fn();
const mockPreviewProfile = jest.fn();
const mockFetchRegistry = jest.fn();

jest.mock("@/lib/platform-admin/capabilities-contract", () => ({
  CAPABILITIES_ERROR_CODES: { BUSINESS_CAPABILITIES_EMPTY: "BUSINESS_CAPABILITIES_EMPTY" },
  fetchCapabilityCatalog: () => mockFetchProfiles(),
  previewBusinessCapabilities: (tenantId: string, body: unknown) =>
    mockPreviewProfile(tenantId, body),
  applyBusinessCapabilities: (tenantId: string, body: unknown, planFingerprint: string) =>
    mockApplyProfile(tenantId, body, planFingerprint),
}));
jest.mock("@/lib/platform-admin/features", () => ({
  ...jest.requireActual("@/lib/platform-admin/features"),
  fetchFeatureRegistry: () => mockFetchRegistry(),
}));
jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

const post = superAdminClient.post as jest.Mock;
const scrollIntoView = jest.fn();

const CATALOG_RESPONSE = { presets: CAPABILITY_PRESETS_FIXTURE, availability: {} };

const SHIPPING = "Ships by carrier";
const DELIVERY = "Delivers on own trucks";
const COUNTER = "Sells at the counter";
const tick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name }));

function planEntry(planKey: string, sortOrder: number, monthlyPrice = "99") {
  return { planKey, name: planKey, monthlyPrice, annualPrice: null, isCustom: false, sortOrder };
}
const CATALOG = {
  version: 1,
  effectiveAt: null,
  plans: [planEntry("LITE", 0, "0"), planEntry("STARTER", 1, "99"), planEntry("GROWTH", 2, "249")],
};
const REGISTRY = [
  {
    key: "ocr",
    label: "Receipt scanning",
    description: "Reads receipts into bills.",
    lifecycle: "ga",
  },
  {
    key: "tobacco_dealer",
    label: "Tobacco dealer",
    description: "Tobacco compliance.",
    lifecycle: "ga",
  },
  {
    key: "driver_payments",
    label: "At-door payment collection",
    description: "Collect at the door.",
    lifecycle: "ga",
  },
  { key: "not_an_addon", label: "Some limit", description: "x", lifecycle: "ga" },
];

type PostHandler = (body: unknown) => unknown;
function setPost(over: Record<string, PostHandler> = {}) {
  post.mockImplementation(async (url: string, body: unknown) => {
    if (over[url]) {
      const out = over[url](body);
      if (out instanceof Error) throw out;
      return out;
    }
    if (url === "/platform-admin/tenants") return { data: { id: "t1", slug: "acme" } };
    if (url.endsWith("/activate-subscription")) {
      return { data: { plan: "STARTER", periodEnd: "2026-12-07T00:00:00Z" } };
    }
    return { data: {} };
  });
}
function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`status ${status}`), { response: { status, data } });
}
const TRIAL_COPY = "Enter a trial length from 1 to 90 days.";
/** The field's own error (the billing line can show the same sentence, so match by id). */
const trialErr = () => document.getElementById("create-tenant-start-days-error");
const urls = () => post.mock.calls.map((c) => c[0] as string);
const bodyOf = (url: string) => post.mock.calls.find((c) => c[0] === url)?.[1];

function fillForm() {
  fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Acme" } });
  fireEvent.change(screen.getByLabelText(/admin email/i), { target: { value: "o@acme.example" } });
  fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("Time zone"), {
    target: { value: "America/New_York" },
  });
}
const formCreate = () => screen.getByRole("button", { name: /^create tenant$/i });
async function openSheet() {
  fireEvent.click(formCreate());
  return screen.findByRole("dialog");
}
async function createThroughSheet() {
  const dialog = await openSheet();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
}
const fmt = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = scrollIntoView;
  mockFetchPlanCatalog.mockResolvedValue(CATALOG);
  mockFetchProfiles.mockResolvedValue(CATALOG_RESPONSE);
  mockFetchRegistry.mockResolvedValue(REGISTRY);
  mockApplyProfile.mockResolvedValue({ summary: [] });
  mockPreviewProfile.mockResolvedValue({ planFingerprint: "f".repeat(64), blocked: null });
  setPost();
});

async function renderPage() {
  render(<AdminCreateTenantPage />);
  await screen.findByRole("button", { name: "Start from…" });
  await waitFor(() => expect(screen.getByLabelText("Plan")).toHaveValue("STARTER"));
}

describe("SA-2 Plan and start", () => {
  it("(1) a 21-day trial posts trialLengthDays 21; the default start is a 14-day trial", async () => {
    await renderPage();
    expect(screen.getByRole("radio", { name: "Start a trial" })).toBeChecked();
    expect(screen.getByLabelText("Trial length (days)")).toHaveValue(14);
    fillForm();
    fireEvent.change(screen.getByLabelText("Trial length (days)"), { target: { value: "21" } });
    await createThroughSheet();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(bodyOf("/platform-admin/tenants")).toMatchObject({
      plan: "STARTER",
      trialLengthDays: 21,
      startMode: "trial", // #3334
    });
  });

  it("shows the plan price line and the trial billing line", async () => {
    await renderPage();
    expect(screen.getByTestId("plan-line")).toHaveTextContent("Starter: $99/month.");
    expect(screen.getByTestId("billing-line")).toHaveTextContent(
      `No charge now. On ${fmt(inDays(14))} the account becomes read-only unless you activate it.`,
    );
  });

  it("(2) Start active shows payment method + period and posts activate-subscription after the create", async () => {
    await renderPage();
    expect(screen.queryByLabelText("Payment method")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Start active" }));
    expect(screen.getByText("You've already been paid, outside Stripe.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Payment method"), { target: { value: "CHECK" } });
    fireEvent.change(screen.getByLabelText("Billing period (days)"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Reference (optional)"), { target: { value: "R-77" } });
    expect(screen.getByTestId("billing-line")).toHaveTextContent(
      `Paid through ${fmt(inDays(90))}. No Stripe charge. You record each payment yourself.`,
    );
    fillForm();
    await createThroughSheet();
    await waitFor(() =>
      expect(urls()).toContain("/platform-admin/tenants/t1/activate-subscription"),
    );
    expect(urls().indexOf("/platform-admin/tenants")).toBeLessThan(
      urls().indexOf("/platform-admin/tenants/t1/activate-subscription"),
    );
    expect(bodyOf("/platform-admin/tenants/t1/activate-subscription")).toEqual({
      plan: "STARTER",
      paymentMethod: "CHECK",
      paymentRef: "R-77",
      billingPeriodDays: 90,
    });
    expect(bodyOf("/platform-admin/tenants")).not.toHaveProperty("trialLengthDays");
    // #3334: the server omits the trial line and Pay now from the welcome email for this start
    expect(bodyOf("/platform-admin/tenants")).toMatchObject({ startMode: "active" });
  });

  it("(3) Lite disables the trial with the reason and preselects Start active", async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "LITE" } });
    expect(screen.getByRole("radio", { name: "Start a trial" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Start active" })).toBeChecked();
    expect(screen.getByText(/Lite is invite only and has no trial\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Payment method")).toBeInTheDocument();
    // going back to a plan with a trial gives the trial back
    fireEvent.change(screen.getByLabelText("Plan"), { target: { value: "STARTER" } });
    expect(screen.getByRole("radio", { name: "Start a trial" })).toBeEnabled();
  });
});

describe("SA-2 capability choices", () => {
  it("(8) nothing is ticked by default, nothing is applied, activated or comped", async () => {
    await renderPage();
    for (const n of [DELIVERY, SHIPPING, COUNTER]) {
      expect(screen.getByRole("checkbox", { name: n })).not.toBeChecked();
    }
    expect(screen.queryByRole("radio", { name: /Custom/ })).toBeNull();
    expect(
      screen.getByText(
        "Nothing ticked: the account starts with the plan's defaults. You can set this later in Setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "What this business does" })).toBeInTheDocument();
    fillForm();
    await createThroughSheet();
    await screen.findByText("Tenant created successfully!");
    expect(urls()).toEqual(["/platform-admin/tenants"]);
    expect(mockPreviewProfile).not.toHaveBeenCalled();
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("Start from… only pre-ticks: nothing is sent until the tenant is created", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Counter + shipping" }));
    expect(screen.getByRole("checkbox", { name: SHIPPING })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: COUNTER })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Counter sale" })).toBeChecked();
    expect(post).not.toHaveBeenCalled();
    expect(mockPreviewProfile).not.toHaveBeenCalled();
  });

  it("a catalog that cannot load still leaves the boxes, with a note and no menu", async () => {
    mockFetchProfiles.mockRejectedValue(new Error("down"));
    render(<AdminCreateTenantPage />);
    expect(await screen.findByRole("checkbox", { name: SHIPPING })).toBeInTheDocument();
    expect(
      await screen.findByText(
        "The presets could not be loaded. You can still tick what the business does, or set it later in Setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start from…" })).toBeNull();
  });

  it("a capability the server marks unavailable is disabled with its reason", async () => {
    mockFetchProfiles.mockResolvedValue({
      presets: CAPABILITY_PRESETS_FIXTURE,
      availability: { counter: "Not available yet" },
    });
    await renderPage();
    expect(screen.getByRole("checkbox", { name: COUNTER })).toBeDisabled();
    expect(screen.getByText("Not available yet")).toBeVisible();
  });
});

describe("SA-2 Free add-ons", () => {
  it("is collapsed with a count badge, lists only add-on keys, and says nothing is billed", async () => {
    await renderPage();
    const details = (await screen.findByText("Free add-ons (comped, never billed)")).closest(
      "details",
    )!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByTestId("addons-count")).toHaveTextContent("0");
    expect(within(details).getByRole("checkbox", { name: /Receipt scanning/ })).toBeInTheDocument();
    expect(within(details).getByRole("checkbox", { name: /Tobacco dealer/ })).toBeInTheDocument();
    expect(within(details).queryByRole("checkbox", { name: /Some limit/ })).toBeNull();
    expect(
      within(details).getByText(
        "These turn on at no charge and never appear on an invoice. Billed add-ons are bought by the business at checkout.",
      ),
    ).toBeInTheDocument();
  });

  it("(7) a ticked free add-on is enabled after the create as a comp", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Receipt scanning/ }));
    expect(screen.getByTestId("addons-count")).toHaveTextContent("1");
    fillForm();
    const dialog = await openSheet();
    expect(within(dialog).getByTestId("sheet-addons")).toHaveTextContent("Receipt scanning");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
    await waitFor(() => expect(urls()).toContain("/platform-admin/tenants/t1/addons/enable"));
    expect(bodyOf("/platform-admin/tenants/t1/addons/enable")).toEqual({
      addonKey: "ocr",
      comp: true,
    });
  });

  it("a registry that cannot load says so and the form still creates a tenant", async () => {
    mockFetchRegistry.mockRejectedValue(new Error("down"));
    await renderPage();
    expect(await screen.findByText(/Free add-ons could not be loaded/)).toBeInTheDocument();
    fillForm();
    await createThroughSheet();
    await screen.findByText("Tenant created successfully!");
  });
});

describe("SA-2 review sheet", () => {
  it("(4) Create opens the sheet and sends NOTHING until the sheet's Create; Cancel keeps every input", async () => {
    await renderPage();
    fillForm();
    const dialog = await openSheet();
    expect(within(dialog).getByRole("heading", { name: "Create Acme?" })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId("sheet-account")).toHaveTextContent("acme");
    expect(within(dialog).getByTestId("sheet-account")).toHaveTextContent("o@acme.example");
    expect(within(dialog).getByTestId("sheet-plan")).toHaveTextContent("Starter");
    expect(within(dialog).getByTestId("sheet-addons")).toHaveTextContent("None");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/slug/i)).toHaveValue("acme");
    expect(screen.getByLabelText(/admin email/i)).toHaveValue("o@acme.example");
    // Escape = no request either
    await openSheet();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(post).not.toHaveBeenCalled();
    // and the sheet's Create sends exactly one create
    await createThroughSheet();
    await screen.findByText("Tenant created successfully!");
    expect(urls().filter((u) => u === "/platform-admin/tenants")).toHaveLength(1);
  });

  it("the sheet's primary button takes the initial focus", async () => {
    await renderPage();
    fillForm();
    const dialog = await openSheet();
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Create Tenant" })).toHaveFocus(),
    );
  });

  it.each([
    [
      "Delivery + counter",
      [DELIVERY, COUNTER],
      ["Delivers on own trucks", "Collect payment at the door", "Sells at the counter"],
    ],
    ["Shipping only", [SHIPPING], ["Ships by carrier"]],
    ["nothing ticked", [], ["Plan defaults only. Nothing else is turned on."]],
  ])("(5) the review for %s lists only the ticked names", async (_label, boxes, lines) => {
    await renderPage();
    fillForm();
    for (const n of boxes) tick(n);
    const dialog = await openSheet();
    const items = within(within(dialog).getByTestId("sheet-setup")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(lines);
  });

  it("(9) the native required-field bubble still works: an empty slug opens no sheet", async () => {
    await renderPage();
    fireEvent.click(formCreate());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText(/slug/i) as HTMLInputElement).validity.valueMissing).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("SA-2 chain and partial failure", () => {
  it("(6a) an activation that fails after the create names the step, links the tenant's Billing", async () => {
    setPost({
      "/platform-admin/tenants/t1/activate-subscription": () => httpError(500, { message: "RAW" }),
    });
    await renderPage();
    fireEvent.click(screen.getByRole("radio", { name: "Start active" }));
    tick(SHIPPING);
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("partial-banner");
    expect(banner).toHaveTextContent(
      "Created Acme, but activation didn't finish. Open Billing to finish it.",
    );
    expect(screen.getByRole("link", { name: "Open Acme" })).toHaveAttribute(
      "href",
      "/admin/tenants/t1?tab=billing",
    );
    expect(document.body.textContent).not.toContain("RAW");
    expect(mockApplyProfile).not.toHaveBeenCalled();
  });

  it("(6b) capabilities that fail after the create name the step, links the tenant's Setup", async () => {
    mockApplyProfile.mockRejectedValueOnce(new Error("boom"));
    await renderPage();
    tick(SHIPPING);
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("partial-banner");
    expect(banner).toHaveTextContent(
      "Created Acme, but what this business does didn't save. Open Setup to finish it.",
    );
    expect(screen.getByRole("link", { name: "Open Acme" })).toHaveAttribute(
      "href",
      "/admin/tenants/t1?tab=setup",
    );
  });

  it("an add-on that fails does not hide the tenant that was created", async () => {
    setPost({ "/platform-admin/tenants/t1/addons/enable": () => httpError(500, {}) });
    await renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Receipt scanning/ }));
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("partial-banner");
    expect(banner).toHaveTextContent("Created Acme, but a free add-on didn't turn on");
    expect(banner).toHaveTextContent("Receipt scanning");
  });

  it("SA-769: an add-on the capabilities already comped is not enabled again, and is not reported as failed", async () => {
    mockApplyProfile.mockResolvedValue({
      summary: [],
      plan: { overrides: [], comps: [{ featureKey: "driver_payments" }], modes: [], billing: [] },
    });
    await renderPage();
    tick(DELIVERY);
    fireEvent.click(await screen.findByRole("checkbox", { name: /At-door payment collection/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Receipt scanning/ }));
    fillForm();
    await createThroughSheet();
    await waitFor(() => expect(urls()).toContain("/platform-admin/tenants/t1/addons/enable"));
    const enabled = post.mock.calls
      .filter((c) => c[0] === "/platform-admin/tenants/t1/addons/enable")
      .map((c) => (c[1] as { addonKey: string }).addonKey);
    expect(enabled).toEqual(["ocr"]); // driver_payments is on already: the apply comped it
    expect(screen.queryByTestId("partial-banner")).not.toBeInTheDocument();
  });

  it("SA-769: a 409 already-active on a comp add-on is success (the module is on), other failures still name the add-on", async () => {
    setPost({
      "/platform-admin/tenants/t1/addons/enable": (body) =>
        (body as { addonKey: string }).addonKey === "driver_payments"
          ? httpError(409, { message: "Add-on is already active" })
          : httpError(500, {}),
    });
    await renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: /At-door payment collection/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Receipt scanning/ }));
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("partial-banner");
    expect(banner).toHaveTextContent("Receipt scanning");
    expect(banner).not.toHaveTextContent("At-door payment collection");
  });

  it("SA-769: after the billing-stop review, the comped add-ons are skipped too", async () => {
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
    mockApplyProfile.mockResolvedValue({
      summary: [],
      plan: { overrides: [], comps: [{ featureKey: "driver_payments" }], modes: [], billing: [] },
    });
    await renderPage();
    tick(SHIPPING);
    fireEvent.click(await screen.findByRole("checkbox", { name: /At-door payment collection/ }));
    fillForm();
    await createThroughSheet();
    await screen.findByText("Turn off At-door payment collection. Billing stops.");
    fireEvent.click(screen.getByRole("button", { name: "Stop billing and apply" }));
    await waitFor(() => expect(mockApplyProfile).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("Turn off At-door payment collection. Billing stops.")).toBeNull(),
    );
    expect(urls()).not.toContain("/platform-admin/tenants/t1/addons/enable");
    expect(screen.queryByTestId("partial-banner")).not.toBeInTheDocument();
  });

  it("the success banner links to the tenant's Overview", async () => {
    await renderPage();
    fillForm();
    await createThroughSheet();
    expect(await screen.findByRole("link", { name: "Open Acme" })).toHaveAttribute(
      "href",
      "/admin/tenants/t1?tab=overview",
    );
  });

  it("the billing-stop confirm still appears, and add-ons wait for it", async () => {
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
    await renderPage();
    tick(SHIPPING);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Receipt scanning/ }));
    fillForm();
    await createThroughSheet();
    const review = await screen.findByText("Turn off At-door payment collection. Billing stops.");
    expect(review).toBeInTheDocument();
    expect(urls()).not.toContain("/platform-admin/tenants/t1/addons/enable");
    fireEvent.click(screen.getByRole("button", { name: "Stop billing and apply" }));
    await waitFor(() => expect(urls()).toContain("/platform-admin/tenants/t1/addons/enable"));
    expect(mockApplyProfile).toHaveBeenCalledWith(
      "t1",
      { delivery: false, shipping: true, counter: false },
      "e".repeat(64),
    );
  });

  it("while creating, the button reads Creating... and inputs are disabled", async () => {
    let release: (v: unknown) => void = () => {};
    post.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await renderPage();
    fillForm();
    await createThroughSheet();
    const btn = await screen.findByRole("button", { name: /creating/i });
    expect(btn).toBeDisabled();
    expect(screen.getByLabelText(/slug/i)).toBeDisabled();
    release({ data: { id: "t1", slug: "acme" } });
    await screen.findByText("Tenant created successfully!");
  });
});

describe("SA-2 addendum: the result lands in view and takes focus", () => {
  it("a failed create scrolls the error banner into view and focuses it", async () => {
    setPost({ "/platform-admin/tenants": () => httpError(500, {}) });
    await renderPage();
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("create-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Could not create the tenant. Try again.");
    await waitFor(() => expect(banner).toHaveFocus());
    expect(scrollIntoView.mock.instances).toContain(banner);
    // input kept
    expect(screen.getByLabelText(/slug/i)).toHaveValue("acme");
  });

  it("a 500 with server text shows the fixed sentence, never the server message", async () => {
    setPost({
      "/platform-admin/tenants": () => httpError(500, { message: "secret server text" }),
    });
    await renderPage();
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("create-banner");
    expect(banner).toHaveTextContent("Could not create the tenant. Try again.");
    expect(banner).not.toHaveTextContent("secret server text");
  });

  it("a blank trial length opens no review sheet (never '?-day trial')", async () => {
    await renderPage();
    fillForm();
    fireEvent.change(screen.getByLabelText("Trial length (days)"), { target: { value: "" } });
    fireEvent.click(formCreate());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (screen.getByLabelText("Trial length (days)") as HTMLInputElement).validity.valueMissing,
    ).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("a trial with no valid length sends nothing and names the field (submit bypassing native checks)", async () => {
    await renderPage();
    fillForm();
    const days = screen.getByLabelText("Trial length (days)");
    fireEvent.change(days, { target: { value: "" } });
    fireEvent.submit(formCreate().closest("form") as HTMLFormElement);
    await waitFor(() => expect(trialErr()).toHaveTextContent(TRIAL_COPY));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(urls()).not.toContain("/platform-admin/tenants");
    expect(days).toHaveAttribute("aria-invalid", "true");
    expect(days).toHaveFocus();
    expect(screen.getByLabelText(/slug/i)).toHaveValue("acme");
    fireEvent.change(days, { target: { value: "30" } });
    expect(trialErr()).toBeNull();
  });

  it("the server's TENANT_TRIAL_DAYS_REQUIRED refusal shows the same trial-length copy", async () => {
    setPost({
      "/platform-admin/tenants": () =>
        httpError(400, {
          statusCode: 400,
          code: "TENANT_TRIAL_DAYS_REQUIRED",
          message: "trialLengthDays is required",
        }),
    });
    await renderPage();
    fillForm();
    await createThroughSheet();
    await waitFor(() => expect(trialErr()).toHaveTextContent(TRIAL_COPY));
    expect(screen.getByLabelText("Trial length (days)")).toHaveAttribute("aria-invalid", "true");
    expect(document.body.textContent).not.toContain("trialLengthDays is required");
  });

  it("a taken slug focuses and scrolls to the slug field, says so inline, and keeps the input", async () => {
    setPost({
      "/platform-admin/tenants": () =>
        httpError(409, { statusCode: 409, message: 'Slug "acme" is already taken' }),
    });
    await renderPage();
    fillForm();
    await createThroughSheet();
    expect(await screen.findByText("That slug isn't available. Try another.")).toBeInTheDocument();
    const slug = screen.getByLabelText(/slug/i);
    await waitFor(() => expect(slug).toHaveFocus());
    expect(scrollIntoView.mock.instances).toContain(slug);
    expect(slug).toHaveAttribute("aria-invalid", "true");
    expect(slug).toHaveValue("acme");
    expect(document.body.textContent).not.toContain("is already taken");
    expect(document.body.textContent).not.toContain('Slug "acme"');
  });

  it("an email or username already in use is named by its code, inline on the email field", async () => {
    setPost({
      "/platform-admin/tenants": () =>
        httpError(400, {
          statusCode: 400,
          code: "ACCOUNT_IDENTIFIER_IN_USE",
          message: "Email or username already in use",
        }),
    });
    await renderPage();
    fillForm();
    await createThroughSheet();
    expect(
      await screen.findByText("That email or username is already in use."),
    ).toBeInTheDocument();
    const email = screen.getByLabelText(/admin email/i);
    await waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(document.body.textContent).not.toContain("Email or username already in use");
  });

  it("an invalid email focuses the email field first (named by the DTO's rules, not the server text)", async () => {
    setPost({
      "/platform-admin/tenants": () =>
        httpError(400, { statusCode: 400, message: ["adminEmail must be an email"] }),
    });
    await renderPage();
    fillForm();
    fireEvent.change(screen.getByLabelText(/admin email/i), { target: { value: "o@acme" } });
    await createThroughSheet();
    const email = screen.getByLabelText(/admin email/i);
    await waitFor(() => expect(email).toHaveFocus());
    expect(scrollIntoView.mock.instances).toContain(email);
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveValue("o@acme");
  });

  it("the success banner is a status region that scrolls into view and takes focus", async () => {
    await renderPage();
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("create-banner");
    expect(banner).toHaveAttribute("role", "status");
    await waitFor(() => expect(banner).toHaveFocus());
    expect(scrollIntoView.mock.instances).toContain(banner);
  });

  it("a partial-failure banner takes focus too", async () => {
    mockApplyProfile.mockRejectedValueOnce(new Error("boom"));
    await renderPage();
    tick(SHIPPING);
    fillForm();
    await createThroughSheet();
    const banner = await screen.findByTestId("create-banner");
    await waitFor(() => expect(banner).toHaveFocus());
    expect(banner).toHaveAttribute("role", "alert");
  });
});

describe("SA-1 review nit: the applied-summary list keys are unique", () => {
  it("two identical summary lines raise no duplicate-key warning", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockApplyProfile.mockResolvedValue({
      summary: ["Recurring routes: off", "Recurring routes: off"],
    });
    await renderPage();
    tick(SHIPPING);
    fillForm();
    await createThroughSheet();
    const list = await screen.findByTestId("profile-applied-summary");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const keyWarnings = spy.mock.calls.filter((c) => String(c[0]).includes("same key"));
    spy.mockRestore();
    expect(keyWarnings).toHaveLength(0);
  });
});
