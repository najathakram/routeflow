import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TierChangeControl } from "./TierChangeControl";
import type { EffectiveFeature, FeaturePreviewResponse } from "./types";

const mockPreview = jest.fn();
const mockRegistry = jest.fn();
jest.mock("@/lib/platform-admin/features", () => ({
  previewTenantFeatures: (tenantId: string, req: unknown) => mockPreview(tenantId, req),
  fetchFeatureRegistry: () => mockRegistry(),
}));

// AdminModal is a real component (focus trap etc.) — jsdom is fine with it.

const TENANT_ID = "tenant-1";
const PLANS = ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;
const planLabel = (p: string) => p.charAt(0) + p.slice(1).toLowerCase();

function feature(key: string, over: Partial<EffectiveFeature> = {}): EffectiveFeature {
  return {
    key,
    area: "routes",
    serving: true,
    resolver: true,
    source: "PRESET",
    detail: { planKey: "PROFESSIONAL", catalogVersionId: "catalog-v11", enforced: false },
    billing: { charged: false },
    ...over,
  };
}

/** PROFESSIONAL → STARTER: recurring routes lost, MSRP gained. A `{planKey}` preview never carries
 *  `modes`, so before/after modes are identical — exactly what the real endpoint returns. */
const DOWNGRADE: FeaturePreviewResponse = {
  before: [feature("recurring_routes"), feature("msrp", { serving: false })],
  after: [feature("recurring_routes", { serving: false }), feature("msrp")],
  changed: ["recurring_routes", "msrp"],
};

const REGISTRY = [
  { key: "recurring_routes", label: "Recurring routes" },
  { key: "msrp", label: "MSRP" },
];

function renderControl(over: Partial<React.ComponentProps<typeof TierChangeControl>> = {}) {
  const onChangePlan = jest.fn().mockResolvedValue(undefined);
  const utils = render(
    <TierChangeControl
      tenantId={TENANT_ID}
      currentPlan="PROFESSIONAL"
      plans={PLANS}
      planLabel={planLabel}
      onChangePlan={onChangePlan}
      {...over}
    />,
  );
  return { ...utils, onChangePlan };
}

function pickPlan(plan: string) {
  fireEvent.change(screen.getByLabelText("New plan"), { target: { value: plan } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRegistry.mockResolvedValue(REGISTRY);
});

describe("TierChangeControl — preview before apply (B539)", () => {
  it("cannot start a change to the plan the tenant is already on", () => {
    renderControl();
    expect(screen.getByRole("button", { name: "Change Plan" })).toBeDisabled();
  });

  it("previews first: nothing is applied until Confirm", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    const { onChangePlan } = renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));

    expect(await screen.findByText("Preview tier change", { selector: "h3" })).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledWith(TENANT_ID, { planKey: "STARTER" });
    expect(onChangePlan).not.toHaveBeenCalled();
  });

  it("shows what is gained and lost with registry labels, and says what it cannot show", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");

    expect(screen.getByText("Professional → Starter")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("preview-panel-gained")).getByText("MSRP"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("preview-panel-lost")).getByText("Recurring routes"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel-limits")).toBeNull(); // a plan swap carries no modes
    expect(screen.getByTestId("preview-summary")).toHaveTextContent("1 gained · 1 lost");
    expect(
      screen.getByText(/Seat, route, customer and monthly-price allowances are not part/),
    ).toBeInTheDocument();
  });

  it("Confirm applies the previewed plan and closes the drawer", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    const { onChangePlan } = renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onChangePlan).toHaveBeenCalledWith("STARTER"));
    await waitFor(() =>
      expect(screen.queryByText("Preview tier change", { selector: "h3" })).not.toBeInTheDocument(),
    );
  });

  it("Cancel closes the drawer and applies nothing", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    const { onChangePlan } = renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Preview tier change", { selector: "h3" })).not.toBeInTheDocument();
    expect(onChangePlan).not.toHaveBeenCalled();
  });

  it("a plan change with no feature diff shows the no-change state but CAN still be applied", async () => {
    // e.g. an alias swap, or an override masking the one flag that differs: the plan (and its
    // price/allowances) still changes, so Confirm must not be a dead end.
    const same = feature("msrp");
    mockPreview.mockResolvedValueOnce({ before: [same], after: [same], changed: [] });
    const { onChangePlan } = renderControl();

    pickPlan("ENTERPRISE");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));

    expect(await screen.findByTestId("preview-empty")).toHaveTextContent("No feature differences");
    expect(screen.queryByTestId("preview-diff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onChangePlan).toHaveBeenCalledWith("ENTERPRISE"));
  });

  it("Confirm sends the PREVIEWED plan even if the select changes while the drawer is open", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    const { onChangePlan } = renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");
    pickPlan("ENTERPRISE"); // the select is still in the DOM behind the drawer
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onChangePlan).toHaveBeenCalledTimes(1));
    expect(onChangePlan).toHaveBeenCalledWith("STARTER");
  });

  it("while the change is being applied, Cancel and Escape cannot dismiss the drawer", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    let finish!: () => void;
    const onChangePlan = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderControl({ onChangePlan });

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("button", { name: "Applying..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Preview tier change", { selector: "h3" })).toBeInTheDocument();

    finish();
    await waitFor(() =>
      expect(screen.queryByText("Preview tier change", { selector: "h3" })).not.toBeInTheDocument(),
    );
  });
});

describe("TierChangeControl — failure paths", () => {
  it("a failed preview shows an error and never opens the drawer", async () => {
    mockPreview.mockRejectedValueOnce(new Error("boom"));
    const { onChangePlan } = renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not preview that plan change. Try again.",
    );
    expect(screen.queryByText("Preview tier change", { selector: "h3" })).not.toBeInTheDocument();
    expect(onChangePlan).not.toHaveBeenCalled();
  });

  it("a failed apply keeps the drawer open with the error so the operator can retry", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    const onChangePlan = jest.fn().mockRejectedValueOnce(new Error("nope"));
    renderControl({ onChangePlan });

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not apply that change. Try again.",
    );
    expect(screen.getByText("Preview tier change", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).not.toBeDisabled();
  });

  it("if the registry cannot be read the preview still works with raw feature keys", async () => {
    mockPreview.mockResolvedValueOnce(DOWNGRADE);
    mockRegistry.mockRejectedValueOnce(new Error("registry down"));
    renderControl();

    pickPlan("STARTER");
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));
    await screen.findByTestId("preview-diff");

    expect(
      within(screen.getByTestId("preview-panel-gained")).getByText("msrp"),
    ).toBeInTheDocument();
  });

  it("follows the tenant's plan after a confirmed change refetches it", () => {
    const { rerender } = renderControl();
    pickPlan("STARTER");
    rerender(
      <TierChangeControl
        tenantId={TENANT_ID}
        currentPlan="STARTER"
        plans={PLANS}
        planLabel={planLabel}
        onChangePlan={jest.fn()}
      />,
    );
    expect(screen.getByLabelText("New plan")).toHaveValue("STARTER");
    expect(screen.getByRole("button", { name: "Change Plan" })).toBeDisabled();
  });
});
