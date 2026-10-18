import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import type { BusinessCapabilitiesPreviewResponse } from "@/lib/platform-admin/capabilities-contract";
import { CapabilitiesCard } from "./CapabilitiesCard";
import { INCLUDED_FREE_COPY } from "./profile-plain-copy";
import {
  CAPABILITY_PRESETS_FIXTURE,
  DELIVERY_COUNTER_FIXTURE,
  NOT_CONFIGURED_FIXTURE,
  capabilitiesFixture,
  capabilitiesPreview,
  capabilitiesPreviewWithBilling,
  capabilitiesPreviewWithComps,
} from "./__fixtures__/capabilities.fixtures";

const mockFetchCapabilities = jest.fn();
const mockFetchPresets = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();

jest.mock("@/lib/platform-admin/capabilities-contract", () => ({
  CAPABILITIES_ERROR_CODES: { BUSINESS_CAPABILITIES_EMPTY: "BUSINESS_CAPABILITIES_EMPTY" },
  fetchBusinessCapabilities: (tenantId: string) => mockFetchCapabilities(tenantId),
  fetchCapabilityPresets: () => mockFetchPresets(),
  previewBusinessCapabilities: (tenantId: string, body: unknown, signal?: AbortSignal) =>
    mockPreview(tenantId, body, signal),
  applyBusinessCapabilities: (tenantId: string, body: unknown, fingerprint: string) =>
    mockApply(tenantId, body, fingerprint),
}));

const TENANT_ID = "tenant-1";
const DELIVERY = "Delivers on own trucks";
const DOOR = "Collect payment at the door";
const SHIPPING = "Ships by carrier";
const COUNTER = "Sells at the counter";

function apiError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error("Request failed"), { response: { status, data } });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const box = (name: string) => screen.getByRole("checkbox", { name });
const applyButton = () =>
  screen.getByRole("button", { name: /^(Apply|Stop billing and apply|Applying…)$/ });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renderCard(onApplied = jest.fn()) {
  render(<CapabilitiesCard tenantId={TENANT_ID} onApplied={onApplied} />);
  await screen.findByRole("checkbox", { name: DELIVERY });
  return { onApplied };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchCapabilities.mockResolvedValue(DELIVERY_COUNTER_FIXTURE);
  mockFetchPresets.mockResolvedValue(CAPABILITY_PRESETS_FIXTURE);
  mockPreview.mockResolvedValue(capabilitiesPreview());
  mockApply.mockResolvedValue({ plan: {}, changed: [], summary: [] });
});

describe("CapabilitiesCard: what is saved", () => {
  it("is titled 'What this business does', never 'Business profile'", async () => {
    await renderCard();
    expect(screen.getByRole("heading", { name: "What this business does" })).toBeInTheDocument();
    expect(screen.queryByText(/business profile/i)).toBeNull();
  });

  it("a tenant nobody set up shows the empty state, nothing ticked, Apply off with its reason (R11)", async () => {
    mockFetchCapabilities.mockResolvedValue(NOT_CONFIGURED_FIXTURE);
    await renderCard();
    expect(
      screen.getByText(
        "Not set up yet. The business works as before. Tick what it does, or start from a preset.",
      ),
    ).toBeVisible();
    for (const n of [DELIVERY, SHIPPING, COUNTER]) expect(box(n)).not.toBeChecked();
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("Tick at least one.")).toBeVisible();
    expect(applyButton()).toHaveAccessibleDescription("Tick at least one.");
    await act(async () => {
      await sleep(400);
    });
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("shows the saved ticks, sends no request while they are unchanged, and says why Apply is off", async () => {
    await renderCard();
    expect(box(DELIVERY)).toBeChecked();
    expect(box(DOOR)).toBeChecked();
    expect(box(COUNTER)).toBeChecked();
    expect(box(SHIPPING)).not.toBeChecked();
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("Already set up this way.")).toBeVisible();
    expect(screen.queryByTestId("capability-preview")).toBeNull();
    await act(async () => {
      await sleep(400);
    });
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("'Current' is on the server's matched preset and in its accessible name (red on master: no marker)", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    expect(
      screen.getByRole("menuitem", { name: "Delivery + counter, current setup" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });

  it("Shipping + counter saved by hand is NOT 'Shipping only' (red on master: the picker marked it Current)", async () => {
    mockFetchCapabilities.mockResolvedValue(
      capabilitiesFixture({ shipping: true, counter: true, opensAs: "order", matchedPreset: null }),
    );
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    expect(screen.queryByText("Current")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /current setup/ })).toBeNull();
  });

  it("a preset pick only pre-ticks: nothing is written and no preview is asked for until the ticks differ", async () => {
    mockFetchCapabilities.mockResolvedValue(NOT_CONFIGURED_FIXTURE);
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delivery + shipping" }));
    expect(box(DELIVERY)).toBeChecked();
    expect(box(SHIPPING)).toBeChecked();
    expect(mockApply).not.toHaveBeenCalled();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(mockPreview.mock.calls[0]![1]).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: false,
    });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("an unreadable tenant says so with a Retry", async () => {
    mockFetchCapabilities.mockRejectedValueOnce(apiError(503, { code: "FEATURES_UNAVAILABLE" }));
    render(<CapabilitiesCard tenantId={TENANT_ID} onApplied={jest.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load what this business does.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("checkbox", { name: DELIVERY })).toBeInTheDocument();
  });

  it("works without presets: the boxes are there, only the menu button is missing", async () => {
    mockFetchPresets.mockRejectedValue(new Error("down"));
    await renderCard();
    expect(screen.queryByRole("button", { name: "Start from…" })).toBeNull();
  });
});

describe("CapabilitiesCard: the live preview", () => {
  it("a tick change asks for ONE preview after 300 ms, with the final ticks (debounce)", async () => {
    await renderCard();
    fireEvent.click(box(SHIPPING));
    fireEvent.click(box(SHIPPING));
    fireEvent.click(box(SHIPPING));
    expect(mockPreview).not.toHaveBeenCalled();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    await act(async () => {
      await sleep(400);
    });
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview.mock.calls[0]![0]).toBe(TENANT_ID);
    expect(mockPreview.mock.calls[0]![1]).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: true,
      counter: true,
    });
  });

  it("ticking back to the saved setup cancels the request and hides the panel", async () => {
    await renderCard();
    fireEvent.click(box(SHIPPING));
    fireEvent.click(box(SHIPPING));
    await act(async () => {
      await sleep(450);
    });
    expect(mockPreview).not.toHaveBeenCalled();
    expect(screen.queryByTestId("capability-preview")).toBeNull();
    expect(screen.getByText("Already set up this way.")).toBeVisible();
  });

  it("while loading: Apply is off with 'Updating preview…', the panel is busy and labelled", async () => {
    const pending = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValue(pending.promise);
    await renderCard();
    fireEvent.click(box(SHIPPING));
    const region = await screen.findByRole("region", { name: "Updating preview…" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("Updating preview…", { selector: "p" })).toBeVisible();
    await act(async () => {
      pending.resolve(capabilitiesPreview());
    });
    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(screen.queryByRole("region", { name: "Updating preview…" })).toBeNull();
  });

  it("while the next preview loads, the last one stays on screen, dimmed", async () => {
    await renderCard();
    fireEvent.click(box(SHIPPING));
    expect(
      await screen.findByText("Where orders go: Own delivery → Delivery and shipping"),
    ).toBeVisible();
    const next = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValue(next.promise);
    fireEvent.click(box(SHIPPING)); // back to the saved ticks...
    fireEvent.click(box(SHIPPING)); // ...and away again
    fireEvent.click(box(DOOR)); // a new key
    const region = await screen.findByRole("region", { name: "Updating preview…" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(
      within(region).getByText("Where orders go: Own delivery → Delivery and shipping"),
    ).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
    await act(async () => {
      next.resolve(capabilitiesPreview({ changes: ["A newer change"] }));
    });
    expect(await screen.findByText("A newer change")).toBeVisible();
  });

  it("last request wins: a slow answer for older ticks is dropped", async () => {
    const first = deferred<BusinessCapabilitiesPreviewResponse>();
    const second = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    fireEvent.click(box(DOOR));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
    const firstSignal = mockPreview.mock.calls[0]![2] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      second.resolve(
        capabilitiesPreview({ changes: ["SECOND ticks"], planFingerprint: "2".repeat(64) }),
      );
    });
    expect(await screen.findByText("SECOND ticks")).toBeVisible();
    await act(async () => {
      first.resolve(
        capabilitiesPreview({ changes: ["FIRST ticks"], planFingerprint: "1".repeat(64) }),
      );
    });
    expect(screen.queryByText("FIRST ticks")).toBeNull();
    expect(screen.getByText("SECOND ticks")).toBeVisible();

    fireEvent.click(applyButton());
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0]![2]).toBe("2".repeat(64));
  });

  it("an error is an inline alert with Retry, Apply stays off, and Retry asks again", async () => {
    mockPreview.mockRejectedValueOnce(new Error("boom"));
    await renderCard();
    fireEvent.click(box(SHIPPING));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't preview this change.");
    expect(applyButton()).toBeDisabled();
    mockPreview.mockResolvedValueOnce(capabilitiesPreview());
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(mockPreview).toHaveBeenCalledTimes(2);
  });

  it("aria-live is one short summary line only; the panel itself is not live", async () => {
    mockPreview.mockResolvedValue(capabilitiesPreviewWithComps());
    await renderCard();
    fireEvent.click(box(SHIPPING));
    const panel = await screen.findByTestId("capability-preview");
    await waitFor(() => expect(applyButton()).toBeEnabled());
    const live = document.querySelectorAll("[aria-live]");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute("aria-live", "polite");
    expect(panel.contains(live[0]!)).toBe(true);
    expect(live[0]!.textContent!.length).toBeLessThan(80);
    expect(panel).not.toHaveAttribute("aria-live");
  });

  it("lists comps as 'Included free', billing under its own section, and changes", async () => {
    mockPreview.mockResolvedValue(
      capabilitiesPreview({
        ...capabilitiesPreviewWithComps(),
        plan: {
          ...capabilitiesPreviewWithComps().plan,
          billing: [{ featureKey: "driver_payments", action: "disable", manual: false }],
        },
      }),
    );
    await renderCard();
    fireEvent.click(box(SHIPPING));
    const comps = await screen.findByTestId("profile-preview-comps");
    for (const name of ["Recurring routes", "Ad hoc order delivery"]) {
      expect(within(comps).getByText(new RegExp(`Turn on ${name}`))).toBeInTheDocument();
    }
    expect(within(comps).getAllByText(INCLUDED_FREE_COPY)).toHaveLength(3);
    const billing = screen.getByTestId("profile-preview-billing");
    expect(within(billing).getByText(/Turn off At-door payment collection/)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("profile-preview-changes")).getByText(
        "Where orders go: Ship by carrier → Delivery and shipping",
      ),
    ).toBeInTheDocument();
  });

  it("blocked by orders with the carrier: Apply is off and the reason is in view", async () => {
    mockPreview.mockResolvedValue(
      capabilitiesPreview({ blocked: { code: "FULFILMENT_CARRIER_IN_TRANSIT", count: 2 } }),
    );
    await renderCard();
    fireEvent.click(box(SHIPPING));
    const reason = await screen.findByText(
      "Orders are with the carrier right now. Change this once they are delivered.",
    );
    expect(reason).toBeVisible();
    expect(applyButton()).toBeDisabled();
    expect(applyButton()).toHaveAccessibleDescription(reason.textContent!);
  });

  it("unticking everything on a saved tenant: Apply off, 'Tick at least one.', no empty request", async () => {
    await renderCard();
    fireEvent.click(box(DELIVERY));
    fireEvent.click(box(COUNTER));
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("Tick at least one.")).toBeVisible();
    await act(async () => {
      await sleep(400);
    });
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("door payments off is sent as such", async () => {
    await renderCard();
    fireEvent.click(box(DOOR));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(mockPreview.mock.calls[0]![1]).toEqual({
      delivery: true,
      doorPayments: false,
      shipping: false,
      counter: true,
    });
  });
});

describe("CapabilitiesCard: apply", () => {
  it("no billing stops: 'Apply' applies directly with the shown preview's fingerprint, then reloads", async () => {
    const { onApplied } = await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(applyButton()).toHaveTextContent("Apply");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const reads = mockFetchCapabilities.mock.calls.length;
    mockFetchCapabilities.mockResolvedValue(
      capabilitiesFixture({
        delivery: true,
        doorPayments: true,
        shipping: true,
        counter: true,
        matchedPreset: "delivery_shipping_pos",
      }),
    );
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith(
      TENANT_ID,
      { delivery: true, doorPayments: true, shipping: true, counter: true },
      "f".repeat(64),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mockFetchCapabilities.mock.calls.length).toBeGreaterThan(reads);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(screen.queryByText(/business profile applied/i)).toBeNull();
    // the saved setup is now the shown one: nothing to apply
    expect(await screen.findByText("Already set up this way.")).toBeVisible();
  });

  it("billing stops: the button reads 'Stop billing and apply' and opens an alert dialog naming each add-on", async () => {
    mockPreview.mockResolvedValue(capabilitiesPreviewWithBilling());
    await renderCard();
    fireEvent.click(box(DELIVERY));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(applyButton()).toHaveTextContent("Stop billing and apply");
    fireEvent.click(applyButton());

    const dialog = await screen.findByRole("alertdialog", { name: "Stop billing for 2 add-ons?" });
    expect(mockApply).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText("At-door payment collection. Billing stops now."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Ad hoc order delivery. Remove it from their manual invoice."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("Cancel on the billing dialog writes nothing and keeps the ticks", async () => {
    mockPreview.mockResolvedValue(capabilitiesPreviewWithBilling());
    await renderCard();
    fireEvent.click(box(DELIVERY));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockApply).not.toHaveBeenCalled();
    expect(box(DELIVERY)).not.toBeChecked();
  });

  it("the destructive button applies with the shown fingerprint", async () => {
    mockPreview.mockResolvedValue(capabilitiesPreviewWithBilling());
    await renderCard();
    fireEvent.click(box(DELIVERY));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop billing and apply" }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0]![2]).toBe("a".repeat(64));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("a comp row switched off is not a billing stop: plain 'Apply'", async () => {
    mockPreview.mockResolvedValue(
      capabilitiesPreview({
        plan: {
          overrides: [],
          comps: [],
          modes: [],
          billing: [
            { featureKey: "driver_payments", action: "disable", manual: false, comp: true },
          ],
        },
      }),
    );
    await renderCard();
    fireEvent.click(box(DELIVERY));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    expect(applyButton()).toHaveTextContent(/^Apply$/);
  });

  it("a stale fingerprint (409) re-previews in place and says so; the next Apply sends the new one", async () => {
    mockApply.mockRejectedValueOnce(apiError(409, { code: API_ERROR_CODES.PROFILE_PLAN_CHANGED }));
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    const next = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValue(next.promise);
    fireEvent.click(applyButton());
    const notice = await screen.findByText("This business changed. Check the preview again.");
    expect(notice).toBeVisible();
    expect(applyButton()).toBeDisabled();
    await act(async () => {
      next.resolve(
        capabilitiesPreview({ changes: ["Fresh plan"], planFingerprint: "9".repeat(64) }),
      );
    });
    expect(await screen.findByText("Fresh plan")).toBeVisible();
    // the notice goes away once the fresh preview is on screen
    expect(screen.queryByText("This business changed. Check the preview again.")).toBeNull();
    expect(mockPreview).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(2));
    expect(mockApply.mock.calls[1]![2]).toBe("9".repeat(64));
  });

  it("another failure is fixed copy, never the server text, and nothing is hidden", async () => {
    mockApply.mockRejectedValueOnce(
      Object.assign(new Error("secret server text"), { response: { status: 500, data: {} } }),
    );
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("secret server text");
    expect(alert).toHaveTextContent("Could not apply this change. Try again.");
    expect(screen.queryByText(/business profile/i)).toBeNull();
  });

  it("while applying, the boxes and Apply are off", async () => {
    const pending = deferred<unknown>();
    mockApply.mockReturnValue(pending.promise);
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    await waitFor(() => expect(box(SHIPPING)).toBeDisabled());
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    await act(async () => {
      pending.resolve({ plan: {}, changed: [], summary: [] });
    });
  });
});

describe("CapabilitiesCard: review fixes", () => {
  it("a refresh that fails AFTER a successful apply still says Saved, softly asks for a reload, and tells the screen", async () => {
    const { onApplied } = await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    mockFetchCapabilities.mockRejectedValue(apiError(503, { code: "FEATURES_UNAVAILABLE" }));
    fireEvent.click(applyButton());
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/^Saved:/)).toBeVisible();
    expect(
      screen.getByText("Couldn't refresh. Reload the page to see the saved setup."),
    ).toBeVisible();
    expect(screen.queryByText("Could not apply this change. Try again.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // the boxes now read as the saved setup, so nothing is offered to apply again
    expect(box(SHIPPING)).toBeChecked();
    expect(screen.getByText("Already set up this way.")).toBeVisible();
  });

  it("a 409 re-reads what is saved, so the card agrees with the server", async () => {
    mockApply.mockRejectedValueOnce(apiError(409, { code: API_ERROR_CODES.PROFILE_PLAN_CHANGED }));
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    const reads = mockFetchCapabilities.mock.calls.length;
    // someone else already saved exactly these ticks
    mockFetchCapabilities.mockResolvedValue(
      capabilitiesFixture({
        delivery: true,
        doorPayments: true,
        shipping: true,
        counter: true,
        matchedPreset: "delivery_shipping_pos",
      }),
    );
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockFetchCapabilities.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText("Already set up this way.")).toBeVisible();
    expect(screen.queryByTestId("capability-preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    expect(screen.getByRole("menuitem", { name: "Everything, current setup" })).toBeInTheDocument();
  });

  it("the stale-plan notice is never inside the aria-live summary line", async () => {
    mockApply.mockRejectedValueOnce(apiError(409, { code: API_ERROR_CODES.PROFILE_PLAN_CHANGED }));
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    const next = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValue(next.promise);
    fireEvent.click(applyButton());
    const notice = await screen.findByText("This business changed. Check the preview again.");
    const live = document.querySelector("[aria-live]")!;
    expect(live.contains(notice)).toBe(false);
    expect(live.textContent).not.toContain("This business changed");
    await act(async () => {
      next.resolve(capabilitiesPreview());
    });
  });

  it("a saved, ticked box that is now unavailable can still be unticked; an unticked one cannot be ticked", async () => {
    mockFetchCapabilities.mockResolvedValue({
      ...DELIVERY_COUNTER_FIXTURE,
      unavailable: { counter: "Not available yet", shipping: "Not available yet" },
    });
    await renderCard();
    expect(box(COUNTER)).toBeChecked();
    expect(box(COUNTER)).toBeEnabled();
    expect(box(SHIPPING)).toBeDisabled();
    expect(screen.getByText("Not available yet")).toBeVisible();
    fireEvent.click(box(COUNTER));
    expect(box(COUNTER)).not.toBeChecked();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(mockPreview.mock.calls[0]![1]).toEqual({
      delivery: true,
      doorPayments: true,
      shipping: false,
      counter: false,
    });
  });

  it("a preset that would tick an unavailable box cannot be chosen from the menu", async () => {
    mockFetchCapabilities.mockResolvedValue({
      ...DELIVERY_COUNTER_FIXTURE,
      unavailable: { shipping: "Not available yet" },
    });
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Start from…" }));
    const everything = screen.getByRole("menuitem", { name: "Everything" });
    expect(everything).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(everything);
    expect(box(SHIPPING)).not.toBeChecked();
    expect(mockPreview).not.toHaveBeenCalled();
    // a preset that needs nothing unavailable still works
    fireEvent.click(screen.getByRole("menuitem", { name: "Delivery" }));
    expect(box(COUNTER)).not.toBeChecked();
  });

  it("the billing dialog is described by its add-on list, and focus returns to a stable control after Apply", async () => {
    mockPreview.mockResolvedValue(capabilitiesPreviewWithBilling());
    await renderCard();
    fireEvent.click(box(DELIVERY));
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    const dialog = await screen.findByRole("alertdialog", { name: "Stop billing for 2 add-ons?" });
    expect(dialog).toHaveAccessibleDescription(/Billing stops now\./);
    expect(dialog).toHaveAccessibleDescription(/Remove it from their manual invoice\./);

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop billing and apply" }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // not the (now disabled) Apply button, and not <body>
    await waitFor(() => expect(box(DELIVERY)).toHaveFocus());
  });

  it("Apply stays off until the answer for the CURRENT ticks lands, even if an older answer matches them", async () => {
    mockPreview.mockResolvedValueOnce(capabilitiesPreview({ planFingerprint: "1".repeat(64) }));
    await renderCard();
    fireEvent.click(box(SHIPPING));
    await waitFor(() => expect(applyButton()).toBeEnabled());

    const second = deferred<BusinessCapabilitiesPreviewResponse>();
    mockPreview.mockReturnValue(second.promise);
    fireEvent.click(box(SHIPPING)); // back to the saved ticks
    fireEvent.click(box(SHIPPING)); // and the first ticks again: the old answer matches their key
    expect(applyButton()).toBeDisabled();
    expect(screen.getByText("Updating preview…", { selector: "p" })).toBeVisible();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
    expect(applyButton()).toBeDisabled();

    await act(async () => {
      second.resolve(capabilitiesPreview({ planFingerprint: "2".repeat(64) }));
    });
    await waitFor(() => expect(applyButton()).toBeEnabled());
    fireEvent.click(applyButton());
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0]![2]).toBe("2".repeat(64));
  });
});
