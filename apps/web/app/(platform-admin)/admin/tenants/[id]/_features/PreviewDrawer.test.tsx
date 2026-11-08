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

// FG-1 WP2 (R5, SA-1099 section 4): the drawer says what it leaves out, and names what stays on for now.
describe("PreviewDrawer: omissions and stays-on-for-now (FG-1 WP2)", () => {
  const f = (key: string, serving: boolean, resolver: boolean) =>
    feature({
      key,
      serving,
      resolver,
      source: serving ? "PRESET" : "NONE",
      detail: {
        planKey: "STARTER",
        catalogVersionId: "catalog-v11",
        enforced: true,
        term: serving && !resolver ? "courtesy" : "flag",
      },
    });

  function show(response: unknown) {
    render(
      <PreviewDrawer
        open
        title="Preview plan change"
        response={response as FeaturePreviewResponse}
        registryByKey={{ "flag.reports": { label: "Reports" } }}
        confirming={false}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
  }

  it("says what a plan move leaves out", () => {
    show({
      before: [f("flag.reports", true, true)],
      after: [f("flag.reports", true, false)],
      changed: ["flag.reports"],
      laterLost: ["flag.reports"],
      omitted: ["limits", "price"],
    });
    expect(
      screen.getByText("Not shown here: customer limits and monthly price. See Plan & billing."),
    ).toBeInTheDocument();
  });

  it("lists a later-lost key under 'Stays on for now', not under Lost", () => {
    show({
      before: [f("flag.reports", true, true)],
      after: [f("flag.reports", true, false)],
      changed: ["flag.reports"],
      laterLost: ["flag.reports"],
      omitted: [],
    });
    const panel = screen.getByTestId("preview-panel-laterLost");
    expect(within(panel).getByText("Reports")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-panel-lost")).toBeNull();
  });

  it("WP4: warns that a turned-off key is still billed, naming it", () => {
    show({
      before: [f("flag.reports", true, true)],
      after: [f("flag.reports", false, false)],
      changed: ["flag.reports"],
      stillBilled: ["flag.reports"],
      omitted: [],
    });
    const warning = screen.getByTestId("preview-still-billed");
    expect(
      within(warning).getByText("Still billed: turning this off doesn't stop the charge."),
    ).toBeInTheDocument();
    expect(within(warning).getByText("Reports")).toBeInTheDocument();
  });

  it("WP4: no billing warning when nothing is still billed", () => {
    show({
      before: [f("flag.reports", true, true)],
      after: [f("flag.reports", false, false)],
      changed: ["flag.reports"],
      omitted: [],
    });
    expect(screen.queryByTestId("preview-still-billed")).toBeNull();
  });

  it("says nothing about omissions when there are none", () => {
    show({
      before: [f("flag.reports", false, false)],
      after: [f("flag.reports", true, true)],
      changed: ["flag.reports"],
      laterLost: [],
      omitted: [],
    });
    expect(screen.queryByText(/Not shown here/)).toBeNull();
  });
});

// SA-1099 A-2 N1 / SV-10: the drawer's row for a DENY the credit gate serves anyway says "Not enforced yet",
// never "Removed" next to an On chip.
describe("PreviewDrawer: a DENY served by courtesy (SV-10)", () => {
  it("labels the row 'Not enforced yet', not 'Removed'", () => {
    const row = (over: Partial<EffectiveFeature>) =>
      feature({ key: "flag.credit_limits", area: "orders", ...over });
    const response = {
      before: [row({ serving: true, resolver: true, source: "PRESET" })],
      after: [
        row({
          serving: true,
          resolver: false,
          source: "OVERRIDE_DENY",
          detail: { planKey: "STARTER", catalogVersionId: "v", enforced: false, term: "courtesy" },
        }),
      ],
      changed: ["flag.credit_limits"],
      laterLost: ["flag.credit_limits"],
      omitted: [],
    };
    render(
      <PreviewDrawer
        open
        title="Preview override"
        response={response as unknown as FeaturePreviewResponse}
        registryByKey={{ "flag.credit_limits": { label: "Credit limits" } }}
        confirming={false}
        onConfirm={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getAllByText("Not enforced yet").length).toBeGreaterThan(0);
    expect(screen.queryByText("Removed")).toBeNull();
  });
});
