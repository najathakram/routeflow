import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { FulfillmentSettingsTab } from "./FulfillmentSettingsTab";

/**
 * Settings → Fulfillment (dark behind the API's FULFILMENT_SELF_SERVE; the page only mounts this tab
 * when GET /settings/fulfilment says `selfServe`). Two cards: "Delivery method" (a radiogroup, changed
 * through Review Change -> a server-built preview dialog -> Confirm Change) and "Counter sales" (a
 * switch that opens the same dialog). The server owns the fingerprint, the effects text and every
 * refusal; this tab sends exactly what the admin chose plus the fingerprint it reviewed.
 */
const get = jest.fn();
const post = jest.fn();
const patch = jest.fn();
const toast = jest.fn();
const users = jest.fn();

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: (...a: unknown[]) => users(...a),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const OPTIONS = [
  { key: "delivery", label: "Own delivery", selectable: true },
  { key: "ship", label: "Ship by carrier", selectable: true },
  { key: "both", label: "Both", selectable: true },
  { key: "pickup", label: "In store only", selectable: true },
  { key: "pickup_ship", label: "In store + shipping", selectable: true },
  { key: "unset", label: "Not configured", selectable: true },
];

function settings(over: Record<string, unknown> = {}) {
  return {
    fulfilmentModel: { value: "unset", effective: "unset", options: OPTIONS },
    counterSales: { value: "off", effective: "off" },
    capability: {},
    selfServe: true,
    canEdit: true,
    fingerprint: "fp-aaaaaaaaaaaa1",
    lastChange: null,
    ...over,
  };
}
const withOptions = (patchBy: Record<string, Record<string, unknown>>) =>
  OPTIONS.map((o) => ({ ...o, ...(patchBy[o.key] ?? {}) }));

const previewFor = (over: Record<string, unknown> = {}) => ({
  changes: [{ key: "fulfilmentModel", from: "unset", to: "ship" }],
  effects: [
    {
      code: "OPEN_ROUTE_ORDERS",
      count: 3,
      text: "3 open orders are still on your delivery routes.",
    },
    { code: "PORTAL_CHOICE", count: 0, text: "Customers' portal orders will go by carrier." },
  ],
  notChanged: [
    "Existing orders keep their delivery method.",
    "Routes, drivers and your add-ons are not changed.",
  ],
  fingerprint: "fp-aaaaaaaaaaaa1",
  ...over,
});

const axiosError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

const radio = (name: RegExp | string) => screen.getByRole("radio", { name });
const review = () => screen.getByRole("button", { name: "Review Change" });
const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: settings() });
  users.mockReturnValue({ data: { data: [], meta: { total: 0 } }, isLoading: false });
});

async function renderLoaded() {
  const utils = renderWithProviders(<FulfillmentSettingsTab />);
  await screen.findByRole("radiogroup", { name: "Delivery method" });
  return utils;
}

describe("loading and error states", () => {
  it("shows a skeleton of 6 radio rows and 1 switch while loading", () => {
    get.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FulfillmentSettingsTab />);
    const sk = screen.getByTestId("fulfilment-skeleton");
    expect(within(sk).getAllByTestId("fulfilment-skeleton-radio")).toHaveLength(6);
    expect(within(sk).getAllByTestId("fulfilment-skeleton-switch")).toHaveLength(1);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("a failed load says so and Try Again loads it", async () => {
    get.mockRejectedValueOnce(new Error("boom"));
    renderWithProviders(<FulfillmentSettingsTab />);
    expect(await screen.findByText("Couldn't load your fulfillment settings.")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("radiogroup", { name: "Delivery method" })).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("the Delivery method card", () => {
  it("lists the six options with their plain-language copy and reads the stored value", async () => {
    await renderLoaded();
    const card = document.getElementById("delivery-method")!;
    expect(card).toBeInTheDocument();
    expect(within(card).getByText("Delivery method")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "How new orders reach your customers. Orders you already have keep their delivery method.",
      ),
    ).toBeInTheDocument();
    for (const [name, hint] of [
      ["On our own trucks", "Orders go on your delivery routes."],
      ["By carrier", "Orders ship with UPS, FedEx or another carrier."],
      ["Our trucks and by carrier", "Staff choose per order; customers choose in the portal."],
      ["Pickup at our store", "Customers collect orders. New Order opens the counter."],
      ["Pickup and by carrier", "Customers collect or you ship. New Order opens the counter."],
      [
        "No preference (today's setup)",
        "Staff choose trucks or carrier per order. Customers don't choose.",
      ],
    ]) {
      expect(within(card).getByText(name)).toBeInTheDocument();
      expect(within(card).getByText(hint)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(radio(/No preference/)).toBeChecked();
  });

  it("Review Change is disabled until the selection differs from the saved value", async () => {
    await renderLoaded();
    expect(review()).toBeDisabled();
    fireEvent.click(radio(/^By carrier/));
    expect(review()).toBeEnabled();
    fireEvent.click(radio(/No preference/));
    expect(review()).toBeDisabled();
  });

  it("an option the plan cannot run is disabled with a badge, the hint and a link", async () => {
    get.mockResolvedValue({
      data: settings({
        fulfilmentModel: {
          value: "unset",
          effective: "unset",
          options: withOptions({
            delivery: { selectable: false, blockedBy: "plan" },
            both: { selectable: false, blockedBy: "plan" },
          }),
        },
      }),
    });
    await renderLoaded();
    expect(radio(/On our own trucks/)).toBeDisabled();
    expect(radio(/Our trucks and by carrier/)).toBeDisabled();
    expect(radio(/^By carrier/)).toBeEnabled();
    expect(screen.getAllByText("Not on your plan")).toHaveLength(2);
    expect(screen.getAllByText("Needs Routes or Order delivery on your plan.")).toHaveLength(2);
    const links = screen.getAllByRole("link", { name: "See Plan & Billing" });
    expect(links).toHaveLength(2);
    for (const l of links) expect(l).toHaveAttribute("href", "/settings/billing");
  });

  it("a disabled option cannot be selected", async () => {
    get.mockResolvedValue({
      data: settings({
        fulfilmentModel: {
          value: "unset",
          effective: "unset",
          options: withOptions({ delivery: { selectable: false, blockedBy: "plan" } }),
        },
      }),
    });
    await renderLoaded();
    fireEvent.click(radio(/On our own trucks/));
    expect(radio(/No preference/)).toBeChecked();
    expect(review()).toBeDisabled();
  });
});

describe("changing the delivery method", () => {
  it("Review Change previews, the dialog shows the server's effects, Confirm sends the model and the fingerprint", async () => {
    post.mockResolvedValue({ data: previewFor() });
    patch.mockResolvedValue({
      data: {
        ...settings({
          fulfilmentModel: { value: "ship", effective: "ship", options: OPTIONS },
          fingerprint: "fp-bbbbbbbbbbbb2",
        }),
        changed: true,
      },
    });
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());

    expect(
      await screen.findByRole("dialog", { name: "Change delivery method?" }),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/settings/fulfilment/preview", { fulfilmentModel: "ship" });
    const d = dialog();
    expect(within(d).getByText(/No preference \(today's setup\)/)).toBeInTheDocument();
    expect(within(d).getByText(/By carrier/)).toBeInTheDocument();
    expect(
      within(d).getByText("3 open orders are still on your delivery routes."),
    ).toBeInTheDocument();
    expect(within(d).getByText("Existing orders keep their delivery method.")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(within(d).getByRole("button", { name: "Confirm Change" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/fulfilment", {
        fulfilmentModel: "ship",
        fingerprint: "fp-aaaaaaaaaaaa1",
      }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "success", title: "Delivery method updated." }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(radio(/^By carrier/)).toBeChecked();
    expect(review()).toBeDisabled();
  });

  it('the button reads "Saving…" and is disabled while the change is in flight', async () => {
    post.mockResolvedValue({ data: previewFor() });
    patch.mockReturnValue(new Promise(() => undefined));
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Change" }));
    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
  });

  it("Cancel closes the dialog without saving and focus returns to Review Change", async () => {
    post.mockResolvedValue({ data: previewFor() });
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    const btn = review();
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
    await waitFor(() => expect(review()).toHaveFocus());
  });

  it("a stale change shows the notice; Review Again reloads and previews again with the NEW fingerprint", async () => {
    post
      .mockResolvedValueOnce({ data: previewFor() })
      .mockResolvedValueOnce({ data: previewFor({ fingerprint: "fp-cccccccccccc3" }) });
    patch
      .mockRejectedValueOnce(
        axiosError(409, {
          code: "FULFILMENT_SETTINGS_STALE",
          message: "stale",
          ...settings({
            fulfilmentModel: { value: "both", effective: "both", options: OPTIONS },
            fingerprint: "fp-cccccccccccc3",
          }),
        }),
      )
      .mockResolvedValueOnce({
        data: {
          ...settings({
            fulfilmentModel: { value: "ship", effective: "ship", options: OPTIONS },
            fingerprint: "fp-dddddddddddd4",
          }),
          changed: true,
        },
      });
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Change" }));

    expect(
      await screen.findByText(
        "Someone changed this a moment ago. Review the new setting before you try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm Change" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review Again" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith("/settings/fulfilment/preview", {
      fulfilmentModel: "ship",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Change" }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith("/settings/fulfilment", {
        fulfilmentModel: "ship",
        fingerprint: "fp-cccccccccccc3",
      }),
    );
  });

  it("carrier orders in transit: says so and offers Review Again", async () => {
    post.mockResolvedValue({ data: previewFor() });
    patch.mockRejectedValue(
      axiosError(409, { code: "FULFILMENT_CARRIER_IN_TRANSIT", message: "x", count: 2 }),
    );
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Change" }));
    expect(await screen.findByText(/2 orders are with the carrier/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review Again" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });

  it("own delivery without a plan: the fixed sentence and a Plan & Billing link", async () => {
    post.mockResolvedValue({ data: previewFor() });
    patch.mockRejectedValue(axiosError(409, { code: "FULFILMENT_MODE_NEEDS_FLEET", message: "x" }));
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Change" }));
    const d = dialog();
    expect(
      await within(d).findByText("Own delivery needs Routes or Order delivery on your plan."),
    ).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: "See Plan & Billing" })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
  });

  it("a preview that cannot load toasts fixed copy and opens no dialog", async () => {
    post.mockRejectedValue(axiosError(500, { message: "internal detail" }));
    await renderLoaded();
    fireEvent.click(radio(/^By carrier/));
    fireEvent.click(review());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error" })),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(JSON.stringify(toast.mock.calls)).not.toContain("internal detail");
  });
});

describe("the Counter sales card", () => {
  const theSwitch = () => screen.getByRole("switch", { name: "Allow counter sales" });

  it("shows the intro and a switch reflecting the effective counter", async () => {
    await renderLoaded();
    const card = document.getElementById("counter-sales")!;
    expect(within(card).getByText("Counter sales")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Lets staff ring up walk-in customers and take payment on one screen.",
      ),
    ).toBeInTheDocument();
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("link", { name: "Open the Counter" })).not.toBeInTheDocument();
  });

  it("turning it on previews, confirms with the fingerprint, toasts, and then links to the counter", async () => {
    post.mockResolvedValue({
      data: previewFor({
        changes: [{ key: "counterSales", from: "off", to: "on" }],
        effects: [
          { code: "COUNTER_OPENS", count: 0, text: "Staff can ring up walk-in customers." },
        ],
      }),
    });
    patch.mockResolvedValue({
      data: {
        ...settings({
          counterSales: { value: "on", effective: "optional" },
          fingerprint: "fp-eeeeeeeeeeee5",
        }),
        changed: true,
      },
    });
    await renderLoaded();
    fireEvent.click(theSwitch());
    expect(
      await screen.findByRole("dialog", { name: "Turn on counter sales?" }),
    ).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/settings/fulfilment/preview", { counterSales: "on" });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Confirm Change" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings/fulfilment", {
        counterSales: "on",
        fingerprint: "fp-aaaaaaaaaaaa1",
      }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "success", title: "Counter sales turned on." }),
      ),
    );
    expect(await screen.findByRole("link", { name: "Open the Counter" })).toHaveAttribute(
      "href",
      "/orders/counter-sale",
    );
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("turning it off asks 'Turn off counter sales?' and toasts the matching copy", async () => {
    get.mockResolvedValue({
      data: settings({ counterSales: { value: "on", effective: "optional" } }),
    });
    post.mockResolvedValue({
      data: previewFor({
        changes: [{ key: "counterSales", from: "on", to: "off" }],
        effects: [{ code: "COUNTER_CLOSES", count: 0, text: "Staff can no longer ring up sales." }],
      }),
    });
    patch.mockResolvedValue({
      data: { ...settings({ counterSales: { value: "off", effective: "off" } }), changed: true },
    });
    await renderLoaded();
    fireEvent.click(theSwitch());
    expect(
      await screen.findByRole("dialog", { name: "Turn off counter sales?" }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Confirm Change" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Counter sales turned off." }),
      ),
    );
    expect(patch).toHaveBeenCalledWith("/settings/fulfilment", {
      counterSales: "off",
      fingerprint: "fp-aaaaaaaaaaaa1",
    });
  });

  it("an in-store business always has the counter: switch on, disabled, with the reason", async () => {
    get.mockResolvedValue({
      data: settings({
        fulfilmentModel: { value: "pickup", effective: "pickup", options: OPTIONS },
        counterSales: { value: "off", effective: "always" },
      }),
    });
    await renderLoaded();
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(theSwitch()).toBeDisabled();
    expect(screen.getByText("In-store businesses always have the counter.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the Counter" })).toBeInTheDocument();
    fireEvent.click(theSwitch());
    expect(post).not.toHaveBeenCalled();
  });
});

describe("a non-admin (canEdit false)", () => {
  beforeEach(() => {
    get.mockResolvedValue({ data: settings({ canEdit: false }) });
    users.mockReturnValue({
      data: {
        data: [
          { id: "1", username: "ada", role: "TENANT_ADMIN", status: "ACTIVE" },
          { id: "2", username: "bob", role: "OPERATOR", status: "ACTIVE" },
          { id: "3", username: "cy", role: "TENANT_ADMIN", status: "ACTIVE" },
        ],
        meta: { total: 3 },
      },
      isLoading: false,
    });
  });

  it("reads everything, changes nothing: all controls disabled, no Review Change, the admins named", async () => {
    await renderLoaded();
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow counter sales" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Review Change" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only an admin can change these settings\. Your admins: ada, cy/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Allow counter sales" }));
    expect(post).not.toHaveBeenCalled();
  });
});

describe("the last-changed footer", () => {
  it("names the business user", async () => {
    get.mockResolvedValue({
      data: settings({
        lastChange: { at: "2026-10-05T15:00:00.000Z", by: "business", name: "ada" },
      }),
    });
    await renderLoaded();
    expect(screen.getByText(/^Last changed by ada on /)).toBeInTheDocument();
  });

  it("names RouteFlow support when the platform changed it", async () => {
    get.mockResolvedValue({
      data: settings({
        lastChange: { at: "2026-10-05T15:00:00.000Z", by: "routeflow", name: null },
      }),
    });
    await renderLoaded();
    expect(screen.getByText(/^Last changed by RouteFlow support on /)).toBeInTheDocument();
  });

  it("says nothing when it was never changed", async () => {
    await renderLoaded();
    expect(screen.queryByText(/Last changed by/)).not.toBeInTheDocument();
  });
});
