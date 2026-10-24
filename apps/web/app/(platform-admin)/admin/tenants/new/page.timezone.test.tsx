import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdminCreateTenantPage from "./page";
import { superAdminClient } from "@/lib/admin-api";

// R16-4: the create-tenant form asks for a REQUIRED IANA time zone and sends it as `timezone`.

jest.mock("@/lib/admin-api", () => ({ superAdminClient: { post: jest.fn() } }));
jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => Promise.resolve({ version: 1, effectiveAt: null, plans: [] }),
}));
jest.mock("@/lib/platform-admin/capabilities-contract", () => ({
  fetchCapabilityCatalog: () => Promise.resolve({ presets: [], availability: {} }),
  previewBusinessCapabilities: jest.fn(),
  applyBusinessCapabilities: jest.fn(),
}));
jest.mock("@/lib/platform-admin/features", () => ({
  ...jest.requireActual("@/lib/platform-admin/features"),
  fetchFeatureRegistry: () => Promise.resolve([]),
}));

const post = superAdminClient.post as jest.Mock;

function fillRest() {
  fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: "acme" } });
  fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Acme" } });
  fireEvent.change(screen.getByLabelText(/admin email/i), { target: { value: "o@acme.example" } });
  fireEvent.change(screen.getByLabelText(/admin username/i), { target: { value: "owner" } });
}
const createButton = () => screen.getByRole("button", { name: /^create tenant$/i });

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = jest.fn();
  post.mockResolvedValue({ data: { id: "t1", slug: "acme" } });
});

describe("create tenant: time zone", () => {
  it("blocks submit without a time zone and shows a plain inline message", async () => {
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.click(createButton());
    expect(await screen.findByText("Choose a time zone.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects text that is not an IANA zone", async () => {
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Mars/Olympus" } });
    fireEvent.click(createButton());
    expect(await screen.findByText("Choose a time zone.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("suggests America/New_York without pre-filling it", async () => {
    render(<AdminCreateTenantPage />);
    expect(screen.getByLabelText("Time zone")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Use America/New_York" }));
    expect(screen.getByLabelText("Time zone")).toHaveValue("America/New_York");
  });

  it("sends the chosen zone as `timezone` in the create payload", async () => {
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "America/Chicago" } });
    fireEvent.click(createButton());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe("/platform-admin/tenants");
    expect(post.mock.calls[0]![1]).toMatchObject({ timezone: "America/Chicago" });
  });

  it("keeps focus on the time-zone input after the suggestion is used", () => {
    render(<AdminCreateTenantPage />);
    fireEvent.click(screen.getByRole("button", { name: "Use America/New_York" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Time zone"));
  });

  it("sends the canonical spelling of a lower-case zone", async () => {
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "america/chicago" } });
    fireEvent.click(createButton());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1]).toMatchObject({ timezone: "America/Chicago" });
  });

  it("a server INVALID_TIME_ZONE refusal lands on the time-zone field with fixed copy, not the generic banner", async () => {
    post.mockRejectedValue({
      response: { status: 400, data: { code: "INVALID_TIME_ZONE", message: "RAW SERVER TEXT" } },
    });
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "America/Chicago" } });
    fireEvent.click(createButton());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Tenant" }));
    expect(await screen.findByText("Choose a time zone.")).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.queryByText("Failed to create tenant")).toBeNull();
  });

  it("canonicalises the spelling when the field loses focus", () => {
    render(<AdminCreateTenantPage />);
    const field = screen.getByLabelText("Time zone");
    fireEvent.change(field, { target: { value: "america/chicago" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("America/Chicago");
  });

  it("leaves text that is not a zone alone on blur (the submit check explains it)", () => {
    render(<AdminCreateTenantPage />);
    const field = screen.getByLabelText("Time zone");
    fireEvent.change(field, { target: { value: "chicago time" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("chicago time");
  });

  it("the review sheet's Account card shows the zone that will be saved", async () => {
    render(<AdminCreateTenantPage />);
    fillRest();
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "america/chicago" } });
    fireEvent.click(createButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/America\/Chicago/)).toBeInTheDocument();
  });
});
