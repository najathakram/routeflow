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
  ageDays: 10,
  entries: { configs: 2, overrides: 1 },
  restoreReport: null,
  ...over,
});

const PREVIEW: ConfigSnapshotPreview = {
  snapshotId: "s1",
  takenAt: "2026-09-10T12:00:00.000Z",
  planKey: "SCALE",
  restoredAt: null,
  ageDays: 10,
  beyondAutoRestoreHorizon: false,
  autoRestoreMaxAgeDays: 90,
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
  it("the intro copy does not promise automatic snapshots (the platform switch may be off)", async () => {
    await renderTab([]);
    const intro = screen.getByText(/Archived when a plan change downgrades this tenant/);
    expect(intro.textContent).toMatch(/once automatic archiving is switched on/);
    expect(document.body.textContent).not.toMatch(/Taken automatically/);
  });

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
    expect(screen.getAllByRole("button", { name: /^Restore now/ })).toHaveLength(1);
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
    expect(screen.queryByRole("button", { name: /^Restore now/ })).toBeNull();
  });

  it("Restore now opens a PREVIEW first — restored / kept / skipped / unchanged — and writes nothing", async () => {
    mockPreview.mockResolvedValue(PREVIEW);
    await renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));

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
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
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

  describe("a partial restore (BO-13 held rows) says what was held and why", () => {
    const RESULT = {
      snapshotId: "s1",
      takenAt: "2026-09-10T12:00:00.000Z",
      planKey: "SCALE",
      restoredToPlanKey: "SCALE",
      report: { restored: 1, skipped: 1, keptNewer: 0, unchanged: 3 },
      supersededSnapshots: 0,
    };
    const confirm = async () => {
      mockPreview.mockResolvedValue(PREVIEW);
      await renderTab();
      fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Will be restored (2)");
      fireEvent.click(within(dialog).getByRole("button", { name: "Restore now" }));
      return (await screen.findByRole("status")).textContent ?? "";
    };

    it("one held row: names the Delivery model and the reason", async () => {
      mockRestore.mockResolvedValue({
        ...RESULT,
        held: [
          {
            kind: "fulfilment",
            featureKey: "fulfilment_model",
            from: "ship",
            to: "delivery",
            reason: "CARRIER_IN_TRANSIT",
            count: 2,
          },
        ],
      });
      const text = await confirm();
      expect(text).toContain(
        "Restored, except Delivery model: held while orders are with the carrier",
      );
    });

    it("several held rows: each is listed with its own reason", async () => {
      mockRestore.mockResolvedValue({
        ...RESULT,
        held: [
          {
            kind: "fulfilment",
            featureKey: "fulfilment_model",
            from: "ship",
            to: "delivery",
            reason: "CARRIER_IN_TRANSIT",
          },
          {
            kind: "fulfilment",
            featureKey: "other_key",
            from: "a",
            to: "b",
            reason: "FULFILMENT_MODE_NEEDS_FLEET",
          },
        ],
      });
      const text = await confirm();
      expect(text).toContain("Delivery model: held while orders are with the carrier");
      expect(text).toContain("other_key: held while own delivery needs a fleet module");
    });

    it("row 640: a held GRANT override names the key and says it is not paid for", async () => {
      mockRestore.mockResolvedValue({
        ...RESULT,
        held: [
          { kind: "override", featureKey: "ocr", overrideKind: "PILOT", reason: "ADDON_NOT_PAID" },
          {
            kind: "override",
            featureKey: "driver_payments",
            overrideKind: "COMP",
            reason: "REQUIRES_UNMET",
          },
        ],
      });
      const text = await confirm();
      expect(text).toContain("ocr: held while the add-on is not paid for or included in the plan");
      expect(text).toContain("driver_payments: held while a required feature is missing");
    });

    it("an empty held list is a plain restore (no 'except')", async () => {
      mockRestore.mockResolvedValue({ ...RESULT, held: [] });
      const text = await confirm();
      expect(text).toMatch(/^Restored the /);
      expect(text).not.toMatch(/except/);
    });
  });

  it("nothing to restore disables the confirm button", async () => {
    mockPreview.mockResolvedValue({ ...PREVIEW, willRestore: [], keptNewer: [], skipped: [] });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
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
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Will be restored (2)");

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore now" }));

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/already restored/);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("a failed preview shows the error and cannot be confirmed", async () => {
    mockPreview.mockRejectedValue({ response: { status: 422 } });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
    const dialog = await screen.findByRole("dialog");

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/unreadable/);
    expect(
      (within(dialog).getByRole("button", { name: "Restore now" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows each row's age, and each restored row's restore report inline in its status", async () => {
    await renderTab([
      snap({ ageDays: 12 }),
      snap({
        id: "s2",
        restoredAt: "2026-09-12T00:00:00.000Z",
        restoredToPlanKey: "SCALE",
        restoreReport: { automatic: true, restored: 4, skipped: 1, keptNewer: 2, unchanged: 0 },
      }),
      snap({
        id: "s3",
        restoredAt: "2026-09-13T00:00:00.000Z",
        restoredToPlanKey: "GROWTH",
        restoreReport: { automatic: false, restored: 1, skipped: 0, keptNewer: 0, unchanged: 3 },
      }),
    ]);

    expect((await screen.findAllByText(/12d ago/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/automatic: 4 restored, 2 kept, 1 skipped/)).toBeTruthy();
    expect(screen.getByText(/manual: 1 restored, 0 kept, 0 skipped/)).toBeTruthy();
  });

  it("a restored row with no report (audit row missing) shows the plain restored label, never a fabricated count", async () => {
    await renderTab([
      snap({
        restoredAt: "2026-09-12T00:00:00.000Z",
        restoredToPlanKey: "SCALE",
        restoreReport: null,
      }),
    ]);
    const label = await screen.findByText(/Restored/);
    expect(label.textContent).not.toMatch(/restored,.*kept/);
  });

  it("the restore button's accessible name identifies WHICH snapshot, for a screen-reader user with several rows", async () => {
    await renderTab([snap({ id: "s1" }), snap({ id: "s2", takenAt: "2026-09-11T12:00:00.000Z" })]);
    const buttons = await screen.findAllByRole("button", { name: /^Restore now/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).not.toEqual(
      buttons[1].getAttribute("aria-label"),
    );
  });

  it("two downgrades on the SAME day get different accessible names (the plan key is part of the name)", async () => {
    await renderTab([
      snap({ id: "s1", planKey: "GROWTH", takenAt: "2026-09-11T08:00:00.000Z" }),
      snap({ id: "s2", planKey: "SCALE", takenAt: "2026-09-11T17:00:00.000Z" }),
    ]);
    const buttons = await screen.findAllByRole("button", { name: /^Restore now/ });
    const names = buttons.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toMatch(/GROWTH/);
    expect(names[1]).toMatch(/SCALE/);
  });

  it("the preview says '1 day old', not '1 days old'", async () => {
    mockPreview.mockResolvedValue({ ...PREVIEW, ageDays: 1 });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/\(1 day old,/);
    expect(dialog.textContent).not.toMatch(/1 days old/);
  });

  it("warns when the snapshot is beyond the automatic-restore horizon — a deliberate override", async () => {
    mockPreview.mockResolvedValue({ ...PREVIEW, ageDays: 120, beyondAutoRestoreHorizon: true });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
    const dialog = await screen.findByRole("dialog");

    expect((await within(dialog).findByRole("status")).textContent).toMatch(
      /older than 90 days.*deliberately/,
    );
  });

  it("does NOT warn when the snapshot is within the automatic-restore horizon", async () => {
    mockPreview.mockResolvedValue({ ...PREVIEW, beyondAutoRestoreHorizon: false });
    await renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Restore now/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/Snapshot of/);

    expect(within(dialog).queryByText(/older than \d+ days/)).toBeNull();
  });
});
