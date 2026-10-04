import * as React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { FeatureConsole } from "./FeatureConsole";
import { REGISTRY_FIXTURE } from "./__fixtures__/registry.fixtures";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";
import { diffsFixture } from "./__fixtures__/diffs.fixtures";
import { previewFixture } from "./__fixtures__/preview.fixtures";

const mockPreview = jest.fn();
const mockCapability = jest.fn();
jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () => Promise.resolve(REGISTRY_FIXTURE),
  fetchTenantFeaturesEffective: () => Promise.resolve(EFFECTIVE_FIXTURE),
  fetchTenantFeatureDiffs: () => Promise.resolve(diffsFixture("t1")),
  fetchEntitlementsMode: () => Promise.resolve({ mode: "shadow" }),
  previewTenantFeatures: (...a: unknown[]) => mockPreview(...a),
  writeTenantFeatureConfig: jest.fn(),
  fetchTenantBillingInfo: () => Promise.resolve({ stripeConfigured: false }),
  enableTenantAddon: jest.fn(),
}));
jest.mock("@/lib/platform-admin/business-profiles", () => ({
  fetchBusinessProfiles: () => Promise.resolve([]),
  previewBusinessProfile: jest.fn(),
  applyBusinessProfile: jest.fn(),
  fetchTenantCapability: () => mockCapability(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.setItem(
    "superAdminToken",
    `h.${window.btoa(JSON.stringify({ role: "SUPER_ADMIN" }))}.s`,
  );
  mockCapability.mockResolvedValue(null);
});

const renderConsole = (onChangePlan = jest.fn()) =>
  render(
    <FeatureConsole
      tenant={{ id: "t1", plan: "GROWTH" }}
      onChangePlan={onChangePlan}
      onCustomise={jest.fn()}
    />,
  );

describe("FeatureConsole: business profile + fulfilment consistency", () => {
  it("shows the Business profile control", async () => {
    renderConsole();
    expect(await screen.findByLabelText("Business profile")).toBeInTheDocument();
  });

  it("capability.consistent === false shows the fixed warning (SA-649 R1)", async () => {
    mockCapability.mockResolvedValue({
      fleet: false,
      fulfilment: "delivery",
      consistent: false,
      inconsistentModes: ["fulfilment_model"],
    });
    renderConsole();
    expect(await screen.findByTestId("capability-warning")).toBeInTheDocument();
  });

  it("consistent, or no capability from an older API: no warning", async () => {
    mockCapability.mockResolvedValue({
      fleet: true,
      fulfilment: "delivery",
      consistent: true,
      inconsistentModes: [],
    });
    renderConsole();
    await screen.findByLabelText("Business profile");
    await waitFor(() => expect(mockCapability).toHaveBeenCalled());
    expect(screen.queryByTestId("capability-warning")).not.toBeInTheDocument();
  });

  it("a 409 FULFILMENT_MODE_NEEDS_FLEET on a console write shows the named fleet features, never the message", async () => {
    const onChangePlan = jest.fn().mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: "FULFILMENT_MODE_NEEDS_FLEET",
          missing: ["recurring_routes", "order_delivery"],
          message: "raw server text",
        },
      },
    });
    mockPreview.mockResolvedValueOnce(previewFixture({ planKey: "STARTER" }));
    renderConsole(onChangePlan);
    await screen.findByText("compliance");
    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "STARTER" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview tier change" }));
    await screen.findByText("Preview tier change", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toMatch(
      /Delivery needs a fleet feature turned on first/,
    );
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });
});
