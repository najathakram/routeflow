import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { BusinessProfilePicker } from "./BusinessProfilePicker";
import {
  PROFILES_FIXTURE,
  matchingPreview,
  shippingPreviewWithBilling,
} from "./__fixtures__/profiles.fixtures";

const mockFetchProfiles = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
const mockConfigValue = jest.fn();
let storedModes: Record<string, string> = {};

jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchBusinessProfiles: () => mockFetchProfiles(),
  fetchTenantConfigValue: (tenantId: string, key: string) => mockConfigValue(tenantId, key),
  previewBusinessProfile: (tenantId: string, profile: string) => mockPreview(tenantId, profile),
  applyBusinessProfile: (tenantId: string, profile: string, planFingerprint: string) =>
    mockApply(tenantId, profile, planFingerprint),
}));

const TENANT_ID = "tenant-1";

function apiError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error("Request failed"), { response: { status, data } });
}

async function renderPicker(onApplied = jest.fn()) {
  render(<BusinessProfilePicker tenantId={TENANT_ID} onApplied={onApplied} />);
  await screen.findByRole("radio", { name: /Delivery distributor/ });
  return { onApplied };
}

async function choose(name: RegExp) {
  fireEvent.click(await screen.findByRole("radio", { name }));
}

async function openPreview(profileName: RegExp = /Shipping wholesaler/) {
  await choose(profileName);
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  jest.clearAllMocks();
  storedModes = {};
  mockConfigValue.mockImplementation((_t: string, key: string) =>
    Promise.resolve(storedModes[key] ?? "unset"),
  );
  mockFetchProfiles.mockResolvedValue(PROFILES_FIXTURE);
  mockPreview.mockResolvedValue(shippingPreviewWithBilling());
  mockApply.mockResolvedValue({
    profile: "shipping_wholesaler",
    plan: {},
    changed: [],
    summary: [],
  });
});

describe("BusinessProfilePicker — the five profiles", () => {
  it("lists all five profiles with their plain-English descriptions", async () => {
    await renderPicker();
    for (const p of PROFILES_FIXTURE) {
      const radio = screen.getByRole("radio", { name: new RegExp(p.label.replace("+", "\\+")) });
      expect(radio).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(5);
  });

  it("shows the in-store profiles disabled, with no 'Available when counter sales launch' note (SA-1)", async () => {
    await renderPicker();
    const inStore = screen.getByRole("radio", { name: /In-store retailer/ });
    const inStoreShipping = screen.getByRole("radio", { name: /In-store \+ shipping retailer/ });
    expect(inStore).toBeDisabled();
    expect(inStoreShipping).toBeDisabled();
    expect(screen.queryByText("Available when counter sales launch")).toBeNull();
    // The two available ones stay selectable.
    expect(screen.getByRole("radio", { name: /Delivery distributor/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Shipping wholesaler/ })).toBeEnabled();
  });

  it("an in-store profile can never be chosen or previewed", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("radio", { name: /In-store retailer/ }));
    expect(screen.getByRole("radio", { name: /In-store retailer/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("enables an in-store profile once the API reports it available (no hardcoded lock)", async () => {
    mockFetchProfiles.mockResolvedValue(
      PROFILES_FIXTURE.map((p) => (p.key === "in_store_retailer" ? { ...p, available: true } : p)),
    );
    await renderPicker();
    expect(screen.getByRole("radio", { name: /In-store retailer/ })).toBeEnabled();
    expect(screen.queryByText("Available when counter sales launch")).toBeNull();
  });

  it("Preview changes stays disabled until a profile is chosen", async () => {
    await renderPicker();
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeDisabled();
    await choose(/Shipping wholesaler/);
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
  });

  it("shows an alert with Retry when the profile list cannot load", async () => {
    mockFetchProfiles.mockRejectedValueOnce(new Error("down"));
    render(<BusinessProfilePicker tenantId={TENANT_ID} onApplied={jest.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load business profiles.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("radio", { name: /Delivery distributor/ })).toBeInTheDocument();
  });
});

describe("BusinessProfilePicker — preview", () => {
  it("previews first: calls the preview for the chosen profile and writes nothing", async () => {
    await renderPicker();
    await openPreview();
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, "shipping_wholesaler");
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("builds Billing from plan.billing: a Stripe-billed module stops billing, a MANUAL one must come off their manual invoice", async () => {
    await renderPicker();
    const dialog = await openPreview();
    const billing = within(dialog).getByTestId("profile-preview-billing");
    expect(within(billing).getByText(/billing/i, { selector: "h4" })).toBeInTheDocument();
    const stops = within(billing).getByTestId("profile-preview-billing-stops");
    expect(
      within(stops).getByText(
        "At-door payment collection will be switched off and its billing stopped",
      ),
    ).toBeInTheDocument();
    expect(within(stops).getByText("Billing stops as soon as you confirm.")).toBeInTheDocument();
    const manual = within(billing).getByTestId("profile-preview-billing-manual");
    expect(
      within(manual).getByText("Ad hoc order delivery will be switched off"),
    ).toBeInTheDocument();
    expect(
      within(manual).getByText("You must remove this from their manual invoice."),
    ).toBeInTheDocument();
    // the manual entry never claims its billing stops on its own
    expect(within(manual).queryByText(/Billing stops/)).not.toBeInTheDocument();
    const changes = within(dialog).getByTestId("profile-preview-changes");
    expect(
      within(changes).getByText("Where orders go: Own delivery → Ship by carrier"),
    ).toBeInTheDocument();
    expect(within(changes).queryByText(/billing stopped/)).not.toBeInTheDocument();
  });

  it("MUST: when EVERY billing line is manual, 'Billing stops as soon as you confirm' is never shown", async () => {
    mockPreview.mockResolvedValue(
      shippingPreviewWithBilling({
        plan: {
          overrides: [],
          modes: [{ key: "fulfilment_model", from: "delivery", to: "ship" }],
          billing: [
            { featureKey: "driver_payments", action: "disable", manual: true },
            { featureKey: "order_delivery", action: "disable", manual: true },
          ],
        },
      }),
    );
    await renderPicker();
    const dialog = await openPreview();
    expect(
      within(dialog).queryByText(/Billing stops as soon as you confirm/),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("profile-preview-billing-stops")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("You must remove this from their manual invoice."),
    ).toBeInTheDocument();
  });

  it("says modules a profile turns on are a free comp, with no charge", async () => {
    await renderPicker();
    expect(screen.getByText(/with no charge/)).toBeInTheDocument();
  });

  it("a preview with no billing lines has no Billing section", async () => {
    mockPreview.mockResolvedValue(
      shippingPreviewWithBilling({
        summary: ["Turn off Recurring routes", "Where orders go: Own delivery → Ship by carrier"],
        changes: ["Turn off Recurring routes", "Where orders go: Own delivery → Ship by carrier"],
        plan: { overrides: [], modes: [], billing: [] },
      }),
    );
    await renderPicker();
    const dialog = await openPreview();
    expect(within(dialog).queryByTestId("profile-preview-billing")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Turn off Recurring routes")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Billing stops/)).not.toBeInTheDocument();
  });

  it("a tenant that already matches shows 'nothing will change' and cannot be confirmed", async () => {
    mockPreview.mockResolvedValue(matchingPreview("shipping_wholesaler"));
    await renderPicker();
    const dialog = await openPreview();
    expect(within(dialog).getByTestId("profile-preview-empty")).toHaveTextContent(
      "This tenant already matches this profile. Nothing will change.",
    );
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("Cancel closes the preview without applying", async () => {
    await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("a failed preview shows fixed copy inline and opens nothing", async () => {
    mockPreview.mockRejectedValue(
      apiError(400, {
        code: API_ERROR_CODES.BUSINESS_PROFILE_UNAVAILABLE,
        message: "RAW SERVER TEXT should never show",
      }),
    );
    await renderPicker();
    await choose(/Shipping wholesaler/);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This business profile isn't available for this tenant.");
    expect(document.body.textContent).not.toContain("RAW SERVER TEXT");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("an unexpected preview failure falls back to a generic retry line", async () => {
    mockPreview.mockRejectedValue(new Error("Network Error"));
    await renderPicker();
    await choose(/Shipping wholesaler/);
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not preview that business profile. Try again.",
    );
  });
});

describe("BusinessProfilePicker — confirm", () => {
  it("Confirm applies the previewed profile once, closes, and tells the parent to reload", async () => {
    const { onApplied } = await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    // the confirm carries the previewed plan's fingerprint (#3199: the server applies only that plan)
    expect(mockApply).toHaveBeenCalledWith(TENANT_ID, "shipping_wholesaler", "a".repeat(64));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Business profile applied: Shipping only.",
    );
  });

  it("locks the dialog while the apply is in flight (no double apply)", async () => {
    let finish: (v: unknown) => void = () => {};
    mockApply.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const busy = await within(dialog).findByRole("button", { name: "Applying..." });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(mockApply).toHaveBeenCalledTimes(1);
    finish({});
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("BILLING_FAILED with nothing stopped: fixed copy in the dialog, dialog stays open, no reload", async () => {
    mockApply.mockRejectedValue(
      apiError(503, {
        code: API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED,
        featureKey: "driver_payments",
        alreadyDisabled: [],
        failedStep: { step: "billing", key: "driver_payments" },
        message: "Stripe: No such subscription_item si_RAW",
      }),
    );
    const { onApplied } = await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      "The business profile was not applied: billing for At-door payment collection could not be stopped. Nothing was changed. Try again.",
    );
    expect(document.body.textContent).not.toContain("si_RAW");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    // The admin can retry from the same dialog.
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("BILLING_FAILED after some add-ons were stopped: names them, and reloads the page behind", async () => {
    mockApply.mockRejectedValue(
      apiError(503, {
        code: API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED,
        featureKey: "order_delivery",
        alreadyDisabled: ["driver_payments"],
        failedStep: { step: "billing", key: "order_delivery" },
      }),
    );
    const { onApplied } = await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The business profile was only partly applied. Billing was already stopped for At-door payment collection, but not for Ad hoc order delivery. Try again to finish.",
    );
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("maps the fleet-needed conflict to fixed copy", async () => {
    mockApply.mockRejectedValue(
      apiError(409, {
        code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
        missing: ["recurring_routes", "order_delivery"],
        message: "This profile's delivery mode needs Routes or Order delivery turned on.",
      }),
    );
    await renderPicker();
    const dialog = await openPreview(/Delivery distributor/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Delivery needs a fleet feature turned on first: Recurring routes or Ad hoc order delivery. Any one is enough.",
    );
  });

  it("an unexpected apply failure falls back to a generic retry line", async () => {
    mockApply.mockRejectedValue(new Error("Network Error"));
    await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not apply that business profile. Try again.",
    );
  });
});

describe("BusinessProfilePicker — a stale preview is re-run before Confirm (#3220 c, #3199)", () => {
  it("PROFILE_PLAN_CHANGED: fixed copy, the preview is fetched again, and Confirm comes back only with the new plan", async () => {
    mockApply.mockRejectedValueOnce(
      apiError(409, { code: API_ERROR_CODES.PROFILE_PLAN_CHANGED, message: "RAW" }),
    );
    await renderPicker();
    const dialog = await openPreview();
    mockPreview.mockResolvedValueOnce(
      shippingPreviewWithBilling({ planFingerprint: "c".repeat(64) }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This account changed since the preview.",
    );
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockApply).toHaveBeenLastCalledWith(TENANT_ID, "shipping_wholesaler", "c".repeat(64)),
    );
  });

  it("while the fresh preview is still loading, Confirm is disabled and says Refreshing…", async () => {
    mockApply.mockRejectedValueOnce(apiError(409, { code: API_ERROR_CODES.PROFILE_PLAN_CHANGED }));
    await renderPicker();
    const dialog = await openPreview();
    let finish: (v: unknown) => void = () => {};
    mockPreview.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const button = await within(dialog).findByRole("button", { name: "Refreshing…" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mockApply).toHaveBeenCalledTimes(1); // no second apply while refreshing
    finish(shippingPreviewWithBilling({ planFingerprint: "d".repeat(64) }));
    expect(await within(dialog).findByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("a partial apply (billing stopped for some) reloads the page AND re-previews before Confirm", async () => {
    mockApply.mockRejectedValueOnce(
      apiError(503, {
        code: API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED,
        alreadyDisabled: ["driver_payments"],
        failedStep: { step: "billing", key: "order_delivery" },
      }),
    );
    const { onApplied } = await renderPicker();
    const dialog = await openPreview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
  });
});

describe("SA-1: plain profile names", () => {
  it("names each profile in plain words and keeps the server label as a secondary line", async () => {
    await renderPicker();
    const delivery = screen.getByRole("radio", { name: /Delivery distributor/ }).closest("label")!;
    expect(within(delivery).getByText("Delivery")).toBeInTheDocument();
    expect(
      within(delivery).getByText(/Delivers on its own trucks, with routes/),
    ).toBeInTheDocument();
    const ship = screen.getByRole("radio", { name: /Shipping wholesaler/ }).closest("label")!;
    expect(within(ship).getByText("Shipping only")).toBeInTheDocument();
    const pos = screen.getByRole("radio", { name: /^POS only: counter sales/ }).closest("label")!;
    expect(
      within(pos).getByText(/Sells over the counter\. Customers pick up in store/),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^POS \+ shipping/ })).toBeInTheDocument();
  });

  it("an unknown profile key falls back to the server label and description", async () => {
    mockFetchProfiles.mockResolvedValue([
      ...PROFILES_FIXTURE,
      {
        ...PROFILES_FIXTURE[0]!,
        key: "future_profile",
        label: "Future profile",
        description: "Server text for a profile this build has never heard of.",
      },
    ]);
    await renderPicker();
    expect(screen.getByRole("radio", { name: /Future profile/ })).toBeInTheDocument();
    expect(
      screen.getByText("Server text for a profile this build has never heard of."),
    ).toBeInTheDocument();
  });
});

describe("SA-1: the applied profile is marked 'Current'", () => {
  async function current() {
    return screen.queryAllByTestId("profile-current");
  }

  it("marks the profile whose modes the tenant stores, as text, and keeps it selectable", async () => {
    storedModes = { fulfilment_model: "ship" };
    await renderPicker();
    await waitFor(async () => expect(await current()).toHaveLength(1));
    const ship = screen.getByRole("radio", { name: /Shipping wholesaler/ });
    expect(within(ship.closest("label")!).getByText("Current")).toBeInTheDocument();
    expect(ship).toBeEnabled();
    expect(
      screen.getByRole("radio", { name: /Delivery distributor/ }).closest("label"),
    ).not.toHaveTextContent("Current");
  });

  it("an in-store profile needs BOTH of its modes to match", async () => {
    mockFetchProfiles.mockResolvedValue(PROFILES_FIXTURE.map((p) => ({ ...p, available: true })));
    storedModes = { fulfilment_model: "pickup", counter_sales: "off" };
    await renderPicker();
    await screen.findByRole("radio", { name: /In-store retailer/ });
    await waitFor(() => expect(mockConfigValue).toHaveBeenCalled());
    expect(await current()).toHaveLength(0);
  });

  it("no profile applied (unset) shows no marker", async () => {
    await renderPicker();
    await waitFor(() => expect(mockConfigValue).toHaveBeenCalled());
    expect(await current()).toHaveLength(0);
  });

  it("cannot be determined (config read fails) shows no marker and the picker still works", async () => {
    mockConfigValue.mockRejectedValue(new Error("down"));
    await renderPicker();
    await waitFor(() => expect(mockConfigValue).toHaveBeenCalled());
    expect(await current()).toHaveLength(0);
    await choose(/Shipping wholesaler/);
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
  });

  it("moves to the new profile after Confirm, and Preview/Confirm calls are unchanged", async () => {
    storedModes = { fulfilment_model: "delivery" };
    await renderPicker();
    await waitFor(async () => expect(await current()).toHaveLength(1));
    const dialog = await openPreview(/Shipping wholesaler/);
    mockApply.mockImplementation(() => {
      storedModes = { fulfilment_model: "ship" };
      return Promise.resolve({
        profile: "shipping_wholesaler",
        plan: {},
        changed: [],
        summary: [],
      });
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, "shipping_wholesaler");
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("radio", { name: /Shipping wholesaler/ }).closest("label")!,
        ).queryByText("Current"),
      ).not.toBeNull(),
    );
    expect(await current()).toHaveLength(1);
  });
});

describe("SA-1 review nit: an older 'Current' read cannot overwrite a newer one", () => {
  it("a first read that resolves late leaves the marker where the newer read put it", async () => {
    const late: Array<() => void> = [];
    // the two reads of the first load (one per config key) stay pending and say "delivery" when released
    mockConfigValue.mockImplementationOnce(
      () => new Promise((resolve) => late.push(() => resolve("delivery"))),
    );
    mockConfigValue.mockImplementationOnce(
      () => new Promise((resolve) => late.push(() => resolve("unset"))),
    );
    storedModes = { fulfilment_model: "ship" };
    await renderPicker();
    const dialog = await openPreview(/Shipping wholesaler/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("radio", { name: /Shipping wholesaler/ }).closest("label")!,
        ).queryByText("Current"),
      ).not.toBeNull(),
    );
    await act(async () => {
      late.forEach((release) => release());
    });
    expect(await screen.findAllByTestId("profile-current")).toHaveLength(1);
    expect(
      within(
        screen.getByRole("radio", { name: /Shipping wholesaler/ }).closest("label")!,
      ).queryByText("Current"),
    ).not.toBeNull();
  });
});

describe("SA-1: the preview modal names the profile like the radios do", () => {
  it("shows the plain name, not the server label", async () => {
    await renderPicker();
    const dialog = await openPreview(/Shipping wholesaler/);
    expect(within(dialog).getByText("Shipping only")).toBeInTheDocument();
    expect(within(dialog).queryByText("Shipping wholesaler")).toBeNull();
  });
});
