import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BusinessProfileSummary } from "@routeflow/types";
import { BusinessProfilePicker } from "./BusinessProfilePicker";

const mockList = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchBusinessProfiles: () => mockList(),
  previewBusinessProfile: (...a: unknown[]) => mockPreview(...a),
  applyBusinessProfile: (...a: unknown[]) => mockApply(...a),
}));

const profiles: BusinessProfileSummary[] = [
  {
    key: "delivery_distributor",
    label: "Delivery distributor",
    description: "Own trucks and routes",
    available: true,
    modes: { fulfilment_model: "delivery" },
    grants: ["order_delivery"],
    denies: [],
  },
  {
    key: "shipping_wholesaler",
    label: "Shipping wholesaler",
    description: "Ships by carrier",
    available: true,
    modes: { fulfilment_model: "ship" },
    grants: [],
    denies: ["order_delivery"],
  },
  {
    key: "pickup_counter",
    label: "Pickup counter",
    description: "Customers collect",
    available: false,
    modes: {},
    grants: [],
    denies: [],
  },
];

const response = (over = {}) => ({
  profile: "shipping_wholesaler",
  before: [],
  after: [],
  changed: [],
  plan: {
    overrides: [{ featureKey: "order_delivery", effect: "DENY", action: "create" }],
    modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
  },
  ...over,
});

const renderPicker = (onApplied = jest.fn()) =>
  render(<BusinessProfilePicker tenantId="t1" registryByKey={{}} onApplied={onApplied} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(profiles);
  mockPreview.mockResolvedValue(response());
  mockApply.mockResolvedValue({
    profile: "shipping_wholesaler",
    plan: response().plan,
    changed: [],
  });
});

describe("BusinessProfilePicker", () => {
  it("lists the profiles from the API; an unavailable one is disabled and never selectable", async () => {
    renderPicker();
    const select = await screen.findByLabelText("Business profile");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /shipping wholesaler/i })).toBeInTheDocument(),
    );
    const pickup = screen.getByRole("option", { name: /pickup counter/i }) as HTMLOptionElement;
    expect(pickup.disabled).toBe(true);
    expect(select).toHaveValue("");
    expect(screen.getByRole("button", { name: /preview profile/i })).toBeDisabled();
  });

  it("choose → Preview calls the DRY-RUN endpoint (not apply) and opens the drawer with the mode change", async () => {
    renderPicker();
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "shipping_wholesaler" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    await screen.findByText(/apply business profile/i);
    expect(mockPreview).toHaveBeenCalledWith("t1", "shipping_wholesaler");
    expect(mockApply).not.toHaveBeenCalled();
    expect(screen.getByText(/fulfilment model/i)).toBeInTheDocument();
    expect(screen.getByText(/unset/)).toBeInTheDocument();
  });

  it("Confirm applies exactly the previewed profile once, closes the drawer and reloads the console", async () => {
    const onApplied = jest.fn();
    renderPicker(onApplied);
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "shipping_wholesaler" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith("t1", "shipping_wholesaler", undefined);
    expect(screen.queryByText(/apply business profile/i)).not.toBeInTheDocument();
  });

  it("Cancel applies nothing", async () => {
    renderPicker();
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "delivery_distributor" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("an already-matching tenant (all skip, no mode change) can still be confirmed and says so", async () => {
    mockPreview.mockResolvedValue(
      response({
        plan: {
          overrides: [{ featureKey: "order_delivery", effect: "DENY", action: "skip" }],
          modes: [],
        },
      }),
    );
    renderPicker();
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "shipping_wholesaler" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    expect(await screen.findByText(/already matches this profile/i)).toBeInTheDocument();
  });

  it("a preview failure shows FIXED copy chosen by code, never the server message", async () => {
    mockPreview.mockRejectedValue({
      response: {
        status: 409,
        data: { code: "BUSINESS_PROFILE_UNAVAILABLE", message: "raw server text" },
      },
    });
    renderPicker();
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "delivery_distributor" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That business profile is not available yet.",
    );
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });

  it("an apply failure keeps the drawer open with fixed copy", async () => {
    mockApply.mockRejectedValue({
      response: {
        status: 409,
        data: { code: "FEATURE_MODE_REQUIRES", message: "internal detail" },
      },
    });
    renderPicker();
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "shipping_wholesaler" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(
      await screen.findByText(/needs a feature this tenant does not have/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("a FULFILMENT_MODE_NEEDS_FLEET 409 on confirm names the fleet features by label, never the message", async () => {
    mockApply.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: "FULFILMENT_MODE_NEEDS_FLEET",
          missing: ["recurring_routes", "order_delivery"],
          message: "server says no",
        },
      },
    });
    render(
      <BusinessProfilePicker
        tenantId="t1"
        registryByKey={{
          recurring_routes: { label: "Recurring routes" },
          order_delivery: { label: "Order delivery" },
        }}
        onApplied={jest.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Business profile"), {
      target: { value: "delivery_distributor" },
    });
    fireEvent.click(screen.getByRole("button", { name: /preview profile/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/Recurring routes or Order delivery/)).toBeInTheDocument();
    expect(screen.queryByText(/server says no/)).not.toBeInTheDocument();
  });

  it("a failed profile list shows a fixed message with Retry", async () => {
    mockList.mockRejectedValueOnce(new Error("boom"));
    renderPicker();
    expect(await screen.findByText(/could not load business profiles/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByLabelText("Business profile")).toBeInTheDocument();
  });
});
