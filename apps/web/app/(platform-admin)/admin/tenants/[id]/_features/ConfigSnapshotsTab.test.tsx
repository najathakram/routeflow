import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ConfigSnapshotListItem, ConfigSnapshotPreview } from "@routeflow/types";
import { ConfigSnapshotsTab } from "./ConfigSnapshotsTab";

const mockList = jest.fn();
const mockPreview = jest.fn();
const mockRestore = jest.fn();
jest.mock("@/lib/platform-admin/config-snapshots", () => ({
  fetchConfigSnapshots: (t: string) => mockList(t),
  previewConfigSnapshotRestore: (t: string, s: string) => mockPreview(t, s),
  restoreConfigSnapshot: (t: string, s: string) => mockRestore(t, s),
}));

const TENANT = "tenant-1";

const snap = (over: Partial<ConfigSnapshotListItem> = {}): ConfigSnapshotListItem => ({
  id: "s1",
  takenAt: "2026-09-10T12:00:00.000Z",
  planKey: "SCALE",
  reason: "DOWNGRADE",
  restoredAt: null,
  restoredToPlanKey: null,
  createdByName: "Ann Admin",
  entries: { configs: 2, overrides: 1 },
  ...over,
});

const PREVIEW: ConfigSnapshotPreview = {
  snapshotId: "s1",
  takenAt: "2026-09-10T12:00:00.000Z",
  planKey: "SCALE",
  restoredAt: null,
  currentPlanKey: "SCALE",
  willRestore: [
    { kind: "config", featureKey: "routes_dispatch" },
    { kind: "override", featureKey: "msrp" },
  ],
  keptNewer: ["recurring_routes"],
  skipped: [{ kind: "override", featureKey: "old.flag", reason: "UNKNOWN_FEATURE" }],
  unchangedCount: 3,
};

beforeEach(() => {
  mockList.mockReset();
  mockPreview.mockReset();
  mockRestore.mockReset();
});

async function renderTab(rows: ConfigSnapshotListItem[] = [snap()]) {
  mockList.mockResolvedValue(rows);
  render(<ConfigSnapshotsTab tenantId={TENANT} />);
  await waitFor(() => expect(mockList).toHaveBeenCalledWith(TENANT));
}

describe("ConfigSnapshotsTab", () => {
  it("lists snapshots with plan, reason, entry counts and status", async () => {
    await renderTab([
      snap(),
      snap({
        id: "s2",
        planKey: "GROWTH",
        reason: "MANUAL",
        createdByName: null,
        restoredAt: "2026-09-12T00:00:00.000Z",
        restoredToPlanKey: "SCALE",
      }),
      snap({ id: "s3", restoredAt: "2026-09-13T00:00:00.000Z", restoredToPlanKey: "SUPERSEDED" }),
    ]);

    expect(await screen.findAllByText("2 settings, 1 grants")).toHaveLength(3);
    expect(screen.getAllByText("Downgrade · Ann Admin")).toHaveLength(2);
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Not restored")).toBeTruthy();
    expect(screen.getByText(/→ SCALE/)).toBeTruthy();
    expect(screen.getByText("Superseded by a newer snapshot")).toBeTruthy();
    // Only the un-restored row offers the action.
    expect(screen.getAllByRole("button", { name: "Restore now" })).toHaveLength(1);
  });

  it("explains the empty state", async () => {
    await renderTab([]);
    expect(await screen.findByText(/No snapshots yet/)).toBeTruthy();
  });

  it("shows a load error instead of an empty table", async () => {
    mockList.mockRejectedValue(new Error("boom"));
    render(<ConfigSnapshotsTab tenantId={TENANT} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Failed to load/);
  });

  it("an unreadable snapshot is labelled and offers no restore", async () => {
    await renderTab([snap({ entries: null })]);
    expect(await screen.findByText("Unreadable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore now" })).toBeNull();
  });

  it("Restore now opens a PREVIEW first — restored / kept / skipped / unchanged — and writes nothing", async () => {
    mockPreview.mockResolvedValue(PREVIEW);
    await renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Restore now" }));

    const dialog = await screen.findByRole("dialog");
    expect(mockPreview).toHaveBeenCalledWith(TENANT, "s1");
    expect(await within(dialog).findByText("Will be restored (2)")).toBeTruthy();
    expect(within(dialog).getByText("routes_dispatch")).toBeTruthy();
    expect(within(dialog).getByText("Kept — changed since the snapshot (1)")).toBeTruthy();
    expect(within(dialog).getByText("Feature no longer exists", { exact: false })).toBeTruthy();
    expect(within(dialog).getByText(/3 already match/)).toBeTruthy();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("confirming restores, shows the report, closes the dialog and refreshes the list", async () => {
    mockPreview.mockResolvedValue(PREVIEW);
    mockRestore.mockResolvedValue({
      snapshotId: "s1",
      takenAt: "2026-09-10T12:00:00.000Z",
      planKey: "SCALE",
      restoredToPlanKey: "SCALE",
      report: { restored: 2, skipped: 1, keptNewer: 1, unchanged: 3 },
    });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Restore now" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Will be restored (2)");

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore now" }));

    await waitFor(() => expect(mockRestore).toHaveBeenCalledWith(TENANT, "s1"));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /2 restored, 1 kept \(changed since\), 1 skipped/,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockList).toHaveBeenCalledTimes(2); // initial load + refresh
  });

  it("nothing to restore disables the confirm button", async () => {
    mockPreview.mockResolvedValue({ ...PREVIEW, willRestore: [], keptNewer: [], skipped: [] });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Restore now" }));
    const dialog = await screen.findByRole("dialog");

    await within(dialog).findByText(/Nothing to restore/);
    expect(
      (within(dialog).getByRole("button", { name: "Restore now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a 409 (already restored) is explained, keeps the dialog honest and refreshes the list", async () => {
    mockPreview.mockResolvedValue(PREVIEW);
    mockRestore.mockRejectedValue({ response: { status: 409 } });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Restore now" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Will be restored (2)");

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore now" }));

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already restored/);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("a failed preview shows the error and cannot be confirmed", async () => {
    mockPreview.mockRejectedValue({ response: { status: 422 } });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Restore now" }));
    const dialog = await screen.findByRole("dialog");

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/unreadable/);
    expect(
      (within(dialog).getByRole("button", { name: "Restore now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
