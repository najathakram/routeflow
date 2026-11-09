import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FeatureConsole } from "./FeatureConsole";
import { REGISTRY_FIXTURE } from "./__fixtures__/registry.fixtures";
import { EFFECTIVE_FIXTURE } from "./__fixtures__/effective.fixtures";
import { diffsFixture } from "./__fixtures__/diffs.fixtures";
import { UNDO_WINDOW_MS } from "./FeatureChangeBar";

const mockFetchRegistry = jest.fn();
const mockFetchEffective = jest.fn();
const mockHash = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
const mockUndo = jest.fn();

jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () => mockFetchRegistry(),
  fetchTenantFeaturesEffective: (id: string) => mockFetchEffective(id),
  fetchTenantFeatureDiffs: () => Promise.resolve(diffsFixture("tenant-1")),
  fetchEntitlementsMode: () => Promise.resolve({ mode: "shadow" }),
  previewTenantFeatures: jest.fn(),
  writeTenantFeatureConfig: jest.fn(),
  fetchTenantBillingInfo: () => Promise.resolve({ stripeConfigured: false }),
  enableTenantAddon: jest.fn(),
}));
jest.mock("@/lib/platform-admin/feature-changes", () => ({
  fetchFeatureInputsHash: (...a: unknown[]) => mockHash(...a),
  previewFeatureChanges: (...a: unknown[]) => mockPreview(...a),
  applyFeatureChanges: (...a: unknown[]) => mockApply(...a),
  undoFeatureChanges: (...a: unknown[]) => mockUndo(...a),
  isInputsChanged: (e: { response?: { data?: { code?: string } } }) =>
    e?.response?.data?.code === "FEATURE_INPUTS_CHANGED",
  featureChangeMessage: (_e: unknown, fallback: string) => fallback,
}));

const TOBACCO = "Regulated items (tobacco)";
const MSRP = "MSRP on invoices";

function setSuperAdminToken() {
  const payload = window.btoa(JSON.stringify({ role: "SUPER_ADMIN" }));
  window.localStorage.setItem("superAdminToken", `h.${payload}.s`);
}

async function renderConsole() {
  render(
    <FeatureConsole
      tenant={{ id: "tenant-1", plan: "GROWTH" }}
      onChangePlan={jest.fn()}
      onCustomise={jest.fn()}
    />,
  );
  await screen.findByText("compliance");
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  setSuperAdminToken();
  mockFetchRegistry.mockResolvedValue(REGISTRY_FIXTURE);
  mockFetchEffective.mockResolvedValue(EFFECTIVE_FIXTURE);
  mockHash.mockResolvedValue("h1");
});

describe("FeatureConsole staging (WP11)", () => {
  it("T-ui1: staging writes nothing, shows the bar with the count, and Discard clears it", async () => {
    await renderConsole();
    expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `Turn off ${TOBACCO} for this business` }));
    fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
    const bar = await screen.findByRole("region", { name: "Staged changes" });
    await waitFor(() =>
      expect(within(bar).getByTestId("stage-count")).toHaveTextContent("2 changes"),
    );
    expect(mockHash).toHaveBeenCalledTimes(1); // read once, before the first staged change
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument();
  });

  it("a staged row says what it will be, and Take back removes just that one", async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: `Turn off ${TOBACCO} for this business` }));
    fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
    await screen.findAllByTestId("staged-chip");
    expect(screen.getAllByTestId("staged-chip").map((e) => e.textContent)).toEqual([
      expect.stringContaining("Will be off"),
      expect.stringContaining("Will be on"),
    ]);
    fireEvent.click(screen.getByRole("button", { name: `Take back the change to ${TOBACCO}` }));
    await waitFor(() => expect(screen.getAllByTestId("staged-chip")).toHaveLength(1));
    expect(screen.getByTestId("stage-count")).toHaveTextContent("1 change");
  });

  it("T27a: Review changes opens the sheet, Save sends one request, the stage clears and a toast offers Undo", async () => {
    mockPreview.mockResolvedValue({
      inputsHash: "h1",
      stale: false,
      changes: [
        {
          key: "tobacco_dealer",
          before: null,
          after: { effect: "DENY", kind: "COMP", expiresAt: null },
          unchanged: false,
        },
        {
          key: "msrp",
          before: null,
          after: { effect: "GRANT", kind: "COMP", expiresAt: null },
          unchanged: false,
        },
      ],
    });
    mockApply.mockResolvedValue({ changeSetId: "cs1", hashAfter: "h2", changes: [] });
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: `Turn off ${TOBACCO} for this business` }));
    fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
    await waitFor(() => expect(screen.getByTestId("stage-count")).toHaveTextContent("2 changes"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText(`${TOBACCO}: Plan default to Off`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Pilot ended" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
    expect(await screen.findByText("Saved 2 changes.")).toBeInTheDocument();
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][1]).toMatchObject({
      expected: "h1",
      reason: "Pilot ended",
      changes: [
        { type: "override", key: "tobacco_dealer", action: "DENY" },
        { type: "override", key: "msrp", action: "GRANT" },
      ],
    });
    expect(screen.queryByRole("region", { name: "Staged changes" })).not.toBeInTheDocument();
  });

  it("F-A: a row that is on through the plan says 'On from plan to Off', not 'Plan default to Off'", async () => {
    mockFetchEffective.mockResolvedValue(
      EFFECTIVE_FIXTURE.map((f) =>
        f.key === "msrp" ? { ...f, serving: true, source: "NONE" as const } : f,
      ),
    );
    mockPreview.mockResolvedValue({
      inputsHash: "h1",
      stale: false,
      changes: [
        {
          key: "msrp",
          before: null,
          after: { effect: "DENY", kind: "COMP", expiresAt: null },
          unchanged: false,
        },
      ],
    });
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: `Turn off ${MSRP} for this business` }));
    await waitFor(() => expect(screen.getByTestId("stage-count")).toHaveTextContent("1 change"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText(`${MSRP}: On from plan to Off`)).toBeInTheDocument();
  });

  it("F-D: after a stale save, Reload keeps the staged change and the typed reason and end date", async () => {
    mockPreview.mockResolvedValue({
      inputsHash: "h1",
      stale: false,
      changes: [
        {
          key: "msrp",
          before: null,
          after: { effect: "GRANT", kind: "COMP", expiresAt: null },
          unchanged: false,
        },
      ],
    });
    mockApply.mockRejectedValue({
      response: { status: 409, data: { code: "FEATURE_INPUTS_CHANGED" } },
    });
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
    await waitFor(() => expect(screen.getByTestId("stage-count")).toHaveTextContent("1 change"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByText(/MSRP on invoices:/);
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Pilot ended" },
    });
    fireEvent.change(screen.getByLabelText(/End date/), { target: { value: "2030-06-30" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Save 1/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^Save 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByTestId("stage-count")).toHaveTextContent("1 change"));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByLabelText(/Why are you making these changes/)).toHaveValue(
      "Pilot ended",
    );
    expect(screen.getByLabelText(/End date/)).toHaveValue("2030-06-30");
  });

  it("Undo in the toast calls undo once with the saved set's id, then the toast goes", async () => {
    mockPreview.mockResolvedValue({
      inputsHash: "h1",
      stale: false,
      changes: [
        {
          key: "msrp",
          before: null,
          after: { effect: "GRANT", kind: "COMP", expiresAt: null },
          unchanged: false,
        },
      ],
    });
    mockApply.mockResolvedValue({ changeSetId: "cs-undo", hashAfter: "h2", changes: [] });
    mockUndo.mockResolvedValue({ changeSetId: "u1", undoOf: "cs-undo" });
    await renderConsole();
    fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
    await waitFor(() => expect(screen.getByTestId("stage-count")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByText(`${MSRP}: Plan default to On`);
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Trial" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    await screen.findByText("Saved 1 change.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mockUndo).toHaveBeenCalledTimes(1));
    expect(mockUndo.mock.calls[0].slice(0, 2)).toEqual(["tenant-1", "cs-undo"]);
    await waitFor(() => expect(screen.queryByText("Saved 1 change.")).not.toBeInTheDocument());
  });

  it("the Undo offer goes quiet after 10 seconds", async () => {
    jest.useFakeTimers();
    try {
      mockPreview.mockResolvedValue({
        inputsHash: "h1",
        stale: false,
        changes: [
          {
            key: "msrp",
            before: null,
            after: { effect: "GRANT", kind: "COMP", expiresAt: null },
            unchanged: false,
          },
        ],
      });
      mockApply.mockResolvedValue({ changeSetId: "cs1", hashAfter: "h2", changes: [] });
      await renderConsole();
      fireEvent.click(screen.getByRole("button", { name: `Turn on ${MSRP} for this business` }));
      await waitFor(() => expect(screen.getByTestId("stage-count")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
      await screen.findByText(`${MSRP}: Plan default to On`);
      fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
        target: { value: "Trial" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
      await screen.findByText("Saved 1 change.");
      act(() => {
        jest.advanceTimersByTime(UNDO_WINDOW_MS + 50);
      });
      expect(screen.queryByText("Saved 1 change.")).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
