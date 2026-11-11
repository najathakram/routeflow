import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FeatureChangeLogRow } from "@/lib/platform-admin/feature-changes";
import { FeatureChangeHistory } from "./FeatureChangeHistory";
import {
  describeChangeSet,
  restoreInputs,
  restorePlan,
  undoableId,
} from "./feature-change-history";

const mockLog = jest.fn();
const mockUndo = jest.fn();
const mockHash = jest.fn();
const mockPreview = jest.fn();
const mockApply = jest.fn();
jest.mock("@/lib/platform-admin/features", () => ({
  fetchFeatureRegistry: () =>
    Promise.resolve([
      { key: "sales_agents", label: "Sales agents" },
      { key: "msrp", label: "MSRP on invoices" },
      { key: "ocr", label: "Scan invoices" },
    ]),
}));
jest.mock("@/lib/platform-admin/feature-changes", () => ({
  fetchFeatureChangeLog: (...a: unknown[]) => mockLog(...a),
  fetchFeatureInputsHash: (...a: unknown[]) => mockHash(...a),
  undoFeatureChanges: (...a: unknown[]) => mockUndo(...a),
  previewFeatureChanges: (...a: unknown[]) => mockPreview(...a),
  applyFeatureChanges: (...a: unknown[]) => mockApply(...a),
  featureChangeErrorCode: (e: { response?: { data?: { code?: string } } }) =>
    e?.response?.data?.code,
  isInputsChanged: () => false,
}));

const ON = { effect: "GRANT" as const, kind: "COMP", expiresAt: null, id: "o1" };
const OFF = { effect: "DENY" as const, kind: "COMP", expiresAt: null, id: "o2" };

const applied = (over: Partial<FeatureChangeLogRow> = {}): FeatureChangeLogRow => ({
  id: "cs1",
  action: "FEATURE_CHANGE_SET_APPLIED",
  createdAt: "2026-11-09T10:00:00.000Z",
  actor: { email: "maria@acme.test" },
  meta: {
    reason: "Pilot ended",
    changes: [
      {
        type: "override",
        key: "sales_agents",
        before: ON,
        after: { ...OFF },
        createdIds: [],
        revokedIds: [],
      },
      {
        type: "override",
        key: "msrp",
        before: null,
        after: { effect: "GRANT", kind: "COMP", expiresAt: null },
        createdIds: [],
        revokedIds: [],
      },
      { type: "override", key: "ocr", before: OFF, after: null, createdIds: [], revokedIds: [] },
    ],
  },
  ...over,
});
const label = (k: string) =>
  ({ sales_agents: "Sales agents", msrp: "MSRP on invoices", ocr: "Scan invoices" })[k] ?? k;

beforeEach(() => {
  jest.clearAllMocks();
  mockHash.mockResolvedValue("h1");
});

describe("feature change history helpers (WP11, R48/R50)", () => {
  it("R48: one sentence, who + what + why, no action codes", () => {
    expect(describeChangeSet(applied(), label)).toBe(
      "maria@acme.test turned off Sales agents, turned on MSRP on invoices and cleared the override on Scan invoices. Reason: Pilot ended.",
    );
    const text = describeChangeSet(applied(), label);
    expect(text).not.toMatch(/FEATURE_CHANGE|GRANT|DENY/);
  });

  it("an undo row reads as an undo, and a row with no recorded set still reads plainly", () => {
    expect(
      describeChangeSet(
        applied({ action: "FEATURE_CHANGE_SET_UNDONE", meta: { reason: "Oops" } }),
        label,
      ),
    ).toBe("maria@acme.test undid an earlier change. Reason: Oops.");
    expect(describeChangeSet(applied({ meta: { reason: "Pilot ended" } }), label)).toBe(
      "maria@acme.test saved feature changes. Reason: Pilot ended.",
    );
  });

  it("R50: restore puts the before-state back: no override clears, an override is set again", () => {
    expect(restoreInputs(applied())).toEqual([
      { type: "override", key: "sales_agents", action: "GRANT", kind: "COMP" },
      { type: "override", key: "msrp", action: "CLEAR" },
      { type: "override", key: "ocr", action: "DENY", kind: "COMP" },
    ]);
  });

  it("R-1 (SA-1133): a PILOT before comes back as a PILOT with the same end date, not a standing COMP", () => {
    const row = applied({
      meta: {
        reason: "x",
        changes: [
          {
            type: "override",
            key: "ocr",
            before: {
              effect: "GRANT",
              kind: "PILOT",
              expiresAt: "2099-11-20T23:59:59.000Z",
              id: "o1",
            },
            after: null,
            createdIds: [],
            revokedIds: [],
          },
        ],
      },
    });
    expect(restoreInputs(row)).toEqual([
      {
        type: "override",
        key: "ocr",
        action: "GRANT",
        kind: "PILOT",
        expiresAt: "2099-11-20T23:59:59.000Z",
      },
    ]);
  });

  it("R-2 (SA-1133): a before whose end date has passed is skipped and named, not written as a standing grant", () => {
    const row = applied({
      meta: {
        reason: "x",
        changes: [
          {
            type: "override",
            key: "ocr",
            before: {
              effect: "GRANT",
              kind: "PILOT",
              expiresAt: "2026-11-01T00:00:00.000Z",
              id: "o9",
            },
            after: null,
            createdIds: [],
            revokedIds: [],
          },
        ],
      },
    });
    const plan = restorePlan(row, Date.parse("2026-11-10T00:00:00.000Z"));
    expect(plan.changes).toEqual([]);
    expect(plan.skippedExpired).toEqual([
      { key: "ocr", id: "o9", expiresAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  it("only the newest row, and only a saved set, is offered Undo", () => {
    const older = applied({ id: "old" });
    const undo = applied({ id: "u", action: "FEATURE_CHANGE_SET_UNDONE" });
    expect(undoableId([older])).toBe("old");
    expect(undoableId([undo, older])).toBeNull();
    expect(undoableId([])).toBeNull();
  });
});

describe("FeatureChangeHistory (WP11)", () => {
  it("T48: shows the sentence and not the raw action code", async () => {
    mockLog.mockResolvedValue([applied()]);
    render(<FeatureChangeHistory tenantId="t1" />);
    expect(await screen.findByText(/turned off Sales agents/)).toBeInTheDocument();
    expect(screen.queryByText(/FEATURE_CHANGE_SET_APPLIED/)).not.toBeInTheDocument();
  });

  it("T28: Undo this change calls undo once for that set and reloads", async () => {
    mockLog.mockResolvedValue([applied()]);
    mockUndo.mockResolvedValue({ changeSetId: "u1", undoOf: "cs1" });
    render(<FeatureChangeHistory tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo this change" }));
    await waitFor(() => expect(mockUndo).toHaveBeenCalledTimes(1));
    expect(mockUndo.mock.calls[0].slice(0, 2)).toEqual(["t1", "cs1"]);
    expect(await screen.findByText(/Undone\./)).toBeInTheDocument();
    expect(mockLog).toHaveBeenCalledTimes(2);
  });

  it("T28d: an undo that skipped settings which had already ended says so", async () => {
    mockLog.mockResolvedValue([applied()]);
    mockUndo.mockResolvedValue({
      changeSetId: "u1",
      undoOf: "cs1",
      skippedExpired: [{ key: "ocr", id: "o9", expiresAt: "2026-11-01T00:00:00.000Z" }],
    });
    render(<FeatureChangeHistory tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo this change" }));
    expect(
      await screen.findByText("Undone. Not restored: Scan invoices. Its end date has passed."),
    ).toBeVisible();
  });

  it("U-3 (SA-1133): an undo row keeps what it left alone, so History says so after a reload", async () => {
    mockLog.mockResolvedValue([
      applied({
        id: "u",
        action: "FEATURE_CHANGE_SET_UNDONE",
        meta: {
          reason: "Oops",
          skippedExpired: [{ key: "ocr", id: "o9", expiresAt: "2026-11-01T00:00:00.000Z" }],
        },
      }),
    ]);
    render(<FeatureChangeHistory tenantId="t1" />);
    expect(
      await screen.findByText(
        "maria@acme.test undid an earlier change. Reason: Oops. Not restored: Scan invoices. Its end date has passed.",
      ),
    ).toBeVisible();
  });

  it("T28b: a refused undo says why in plain words and writes nothing else", async () => {
    mockLog.mockResolvedValue([applied()]);
    mockUndo.mockRejectedValue({
      response: { status: 409, data: { code: "FEATURE_CHANGE_NOT_UNDOABLE" } },
    });
    render(<FeatureChangeHistory tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo this change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be undone any more/);
  });

  it("an older set has no Undo button, but can still be restored", async () => {
    mockLog.mockResolvedValue([
      applied({
        id: "u",
        action: "FEATURE_CHANGE_SET_UNDONE",
        createdAt: "2026-11-09T11:00:00.000Z",
      }),
      applied(),
    ]);
    render(<FeatureChangeHistory tenantId="t1" />);
    await screen.findByText(/turned off Sales agents/);
    expect(screen.queryByRole("button", { name: "Undo this change" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore the earlier settings" })).toHaveLength(1);
  });

  it("T50: Restore opens the same review sheet, and one save sends the whole set", async () => {
    mockLog.mockResolvedValue([applied()]);
    mockPreview.mockResolvedValue({
      inputsHash: "h1",
      stale: false,
      changes: [
        { key: "sales_agents", before: OFF, after: ON, unchanged: false },
        { key: "msrp", before: ON, after: null, unchanged: false },
      ],
    });
    mockApply.mockResolvedValue({ changeSetId: "cs2", hashAfter: "h2", changes: [] });
    render(<FeatureChangeHistory tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore the earlier settings" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Sales agents: Off to On")).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(/Why are you making these changes/) as HTMLTextAreaElement)
        .value,
    ).toMatch(/^Restored the settings from /);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save 2 changes/ }));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0][1]).toMatchObject({
      expected: "h1",
      changes: [
        { key: "sales_agents", action: "GRANT", kind: "COMP" },
        { key: "msrp", action: "CLEAR" },
        { key: "ocr", action: "DENY", kind: "COMP" },
      ],
    });
    expect(await screen.findByText(/Restored\. 2 changes saved\./)).toBeInTheDocument();
  });
});
