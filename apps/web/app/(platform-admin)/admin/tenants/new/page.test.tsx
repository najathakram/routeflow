import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PLAN_KEYS } from "@routeflow/types";
import AdminCreateTenantPage from "./page";
import { superAdminClient } from "@/lib/admin-api";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

const mockFetchPlanCatalog = jest.fn();

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

    const select = await screen.findByLabelText("Plan");
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
    const select = screen.getByLabelText("Plan") as HTMLSelectElement;
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
    const select = screen.getByLabelText("Plan") as HTMLSelectElement;
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

    const select = (await screen.findByLabelText("Plan")) as HTMLSelectElement;
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

    const select = await screen.findByLabelText("Plan");
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
    const select = screen.getByLabelText("Plan") as HTMLSelectElement;
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

describe("AdminCreateTenantPage — 'How do orders reach your customers?' (business profile)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [planEntry("STARTER", 1)],
    });
  });

  const fill = () => {
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "acme-co" } });
    fireEvent.change(screen.getByLabelText("Business Name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Admin Email"), { target: { value: "a@acme.example" } });
    fireEvent.change(screen.getByLabelText("Admin Username"), { target: { value: "acme" } });
  };

  it("offers Own delivery and Ship by carrier (no Pickup), defaulting to 'Not set yet'", async () => {
    render(<AdminCreateTenantPage />);
    const select = (await screen.findByLabelText(
      "How do orders reach your customers?",
    )) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Not set yet",
      "Own delivery",
      "Ship by carrier",
    ]);
  });

  it("not set: the create payload carries NO profile (today's behaviour)", async () => {
    render(<AdminCreateTenantPage />);
    await screen.findByLabelText("Plan");
    fill();
    fireEvent.click(screen.getByRole("button", { name: /create tenant/i }));
    await waitFor(() => expect(superAdminClient.post).toHaveBeenCalled());
    expect((superAdminClient.post as jest.Mock).mock.calls[0][1]).not.toHaveProperty("profile");
  });

  it.each([
    ["Own delivery", "delivery_distributor"],
    ["Ship by carrier", "shipping_wholesaler"],
  ])("choosing %s sends profile %s", async (label, key) => {
    render(<AdminCreateTenantPage />);
    const select = await screen.findByLabelText("How do orders reach your customers?");
    fill();
    fireEvent.change(select, { target: { value: key } });
    expect((select as HTMLSelectElement).selectedOptions[0]!.textContent).toBe(label);
    fireEvent.click(screen.getByRole("button", { name: /create tenant/i }));
    await waitFor(() => expect(superAdminClient.post).toHaveBeenCalled());
    expect((superAdminClient.post as jest.Mock).mock.calls[0][1]).toMatchObject({ profile: key });
  });
});
