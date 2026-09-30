import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { PreviewDrawer } from "./PreviewDrawer";
import type { EffectiveFeature, FeaturePreviewResponse } from "./types";

function feature(overrides: Partial<EffectiveFeature> = {}): EffectiveFeature {
  return {
    key: "route_optimization",
    area: "routes",
    serving: true,
    resolver: true,
    source: "PRESET",
    detail: { planKey: "GROWTH", catalogVersionId: "catalog-v11", enforced: false },
    billing: { charged: false },
    ...overrides,
  };
}

// Opus review round 2: the button must not depend on the server listing a mode-only diff in
// `changed[]` — some servers only track serving/source flips there, not mode.
describe("PreviewDrawer — Confirm enablement is not solely driven by response.changed", () => {
  it("enables Confirm for a mode-only change even when changed[] is empty", () => {
    const response: FeaturePreviewResponse = {
      before: [
        feature({
          mode: {
            value: "manual",
            effective: "manual",
            source: "TENANT",
            allowed: ["manual"],
            blocked: [],
          },
        }),
      ],
      after: [
        feature({
          mode: {
            value: "scheduled",
            effective: "scheduled",
            source: "TENANT",
            allowed: ["manual", "scheduled"],
            blocked: [],
          },
        }),
      ],
      changed: [], // deliberately empty — this is the case under test
    };

    render(
      <PreviewDrawer
        open
        title="Preview mode change"
        response={response}
        registryByKey={{ route_optimization: { label: "Route optimization mode" } }}
        confirming={false}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Confirm" })).not.toBeDisabled();
    expect(
      within(screen.getByTestId("preview-diff")).getByText("Route optimization mode"),
    ).toBeInTheDocument();
  });

  it("disables Confirm when nothing actually differs, even with a non-empty changed[] lie", () => {
    const same = feature();
    const response: FeaturePreviewResponse = {
      before: [same],
      after: [same],
      changed: [],
    };

    render(
      <PreviewDrawer
        open
        title="Preview"
        response={response}
        registryByKey={{}}
        confirming={false}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(
      screen.getByText("This change makes no difference for this tenant."),
    ).toBeInTheDocument();
  });
});
