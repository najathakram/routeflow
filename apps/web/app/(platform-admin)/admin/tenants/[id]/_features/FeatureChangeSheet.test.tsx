import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureChangeInput, FeatureChangePreviewRow } from "@routeflow/types";
import {
  CHANGED_BY_SOMEONE_ELSE,
  changeSentence,
  endOfDayIso,
  FeatureChangeSheet,
  NOT_CHECKED,
  stateWords,
} from "./FeatureChangeSheet";

const mockPreview = jest.fn();
const mockApply = jest.fn();
jest.mock("@/lib/platform-admin/feature-changes", () => ({
  previewFeatureChanges: (...a: unknown[]) => mockPreview(...a),
  applyFeatureChanges: (...a: unknown[]) => mockApply(...a),
  isInputsChanged: (e: { response?: { data?: { code?: string } } }) =>
    e?.response?.data?.code === "FEATURE_INPUTS_CHANGED",
  featureChangeMessage: (_e: unknown, fallback: string) => fallback,
}));

const CHANGES: FeatureChangeInput[] = [
  { type: "override", key: "a", action: "DENY" },
  { type: "override", key: "b", action: "DENY" },
  { type: "override", key: "c", action: "GRANT" },
];
const label = (k: string) => ({ a: "Alpha", b: "Beta", c: "Gamma" })[k] ?? k;
const row = (
  key: string,
  before: FeatureChangePreviewRow["before"],
  after: FeatureChangePreviewRow["after"],
  unchanged = false,
): FeatureChangePreviewRow => ({ key, before, after, unchanged });
const ON = { effect: "GRANT" as const, kind: "COMP", expiresAt: null };
const OFF = { effect: "DENY" as const, kind: "COMP", expiresAt: null };

const ready = (rows: FeatureChangePreviewRow[]) =>
  mockPreview.mockResolvedValue({ inputsHash: "h1", stale: false, changes: rows });

function renderSheet(over: Partial<React.ComponentProps<typeof FeatureChangeSheet>> = {}) {
  const props = {
    open: true,
    tenantId: "t1",
    expected: "h1",
    changes: CHANGES,
    labelOf: label,
    onClose: jest.fn(),
    onSaved: jest.fn(),
    onStale: jest.fn(),
    ...over,
  };
  render(<FeatureChangeSheet {...props} />);
  return props;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FeatureChangeSheet (WP11)", () => {
  it("words: On / Off / Plan default; one sentence per row", () => {
    expect(stateWords(ON)).toBe("On");
    expect(stateWords(OFF)).toBe("Off");
    expect(stateWords(null)).toBe("Plan default");
    expect(changeSentence("Alpha", row("a", ON, OFF))).toBe("Alpha: On to Off");
    expect(changeSentence("Gamma", row("c", null, ON))).toBe("Gamma: Plan default to On");
  });

  it("T-ui1: checks the set on open (one dry run), lists the changes under Changes now, offers Save 3 changes", async () => {
    ready([row("a", ON, OFF), row("b", ON, OFF), row("c", null, ON)]);
    renderSheet();
    expect(await screen.findByText("Alpha: On to Off")).toBeInTheDocument();
    expect(screen.getByText("Changes now")).toBeInTheDocument();
    expect(screen.getByText("Beta: On to Off")).toBeInTheDocument();
    expect(screen.getByText("Gamma: Plan default to On")).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(mockPreview.mock.calls[0][1]).toMatchObject({ expected: "h1", changes: CHANGES });
    expect(screen.getByRole("button", { name: "Save 3 changes" })).toBeDisabled(); // no reason yet
    expect(mockApply).not.toHaveBeenCalled();
    expect(screen.getByText(/No charge/)).toBeInTheDocument();
  });

  it("a row already set that way is listed under Stays on for now and is not counted", async () => {
    ready([row("a", ON, OFF), row("b", OFF, OFF, true)]);
    renderSheet({ changes: CHANGES.slice(0, 2) });
    expect(await screen.findByText("Stays on for now")).toBeInTheDocument();
    expect(screen.getByText("Beta: already off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save 1 change" })).toBeInTheDocument();
  });

  it("T27a: Save sends exactly one request carrying the whole set, the hash and the reason; then onSaved", async () => {
    ready([row("a", ON, OFF), row("b", ON, OFF), row("c", null, ON)]);
    mockApply.mockResolvedValue({ changeSetId: "cs1", hashAfter: "h2", changes: [] });
    const props = renderSheet();
    await screen.findByText("Alpha: On to Off");
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Pilot ended" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save 3 changes" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply).toHaveBeenCalledWith("t1", {
      expected: "h1",
      reason: "Pilot ended",
      changes: CHANGES,
    });
    expect((props.onSaved as jest.Mock).mock.calls[0][1]).toBe(3);
  });

  it("an end date goes on the turn-on/turn-off changes only, as the end of that day", async () => {
    ready([row("a", ON, OFF), row("c", null, ON)]);
    mockApply.mockResolvedValue({ changeSetId: "cs1", hashAfter: "h2", changes: [] });
    renderSheet({
      changes: [
        { type: "override", key: "a", action: "CLEAR" },
        { type: "override", key: "c", action: "GRANT" },
      ],
    });
    await screen.findByText("Gamma: Plan default to On");
    fireEvent.change(screen.getByLabelText(/End date/), { target: { value: "2030-06-30" } });
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
    const sent = mockPreview.mock.calls[1][1].changes;
    expect(sent[0]).toEqual({ type: "override", key: "a", action: "CLEAR" });
    expect(sent[1].expiresAt).toBe(endOfDayIso("2030-06-30"));
  });

  it("T-ui2: a 409 on save shows Changed by someone else, waits for Reload (onStale), and does not close the sheet or clear anything", async () => {
    ready([row("a", ON, OFF)]);
    mockApply.mockRejectedValue({
      response: { status: 409, data: { code: "FEATURE_INPUTS_CHANGED" } },
    });
    const props = renderSheet({ changes: CHANGES.slice(0, 1) });
    await screen.findByText("Alpha: On to Off");
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Pilot ended" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    expect(await screen.findByText(new RegExp(CHANGED_BY_SOMEONE_ELSE))).toBeInTheDocument();
    expect(props.onStale).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(props.onStale).toHaveBeenCalledTimes(1);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("T-ui2: a dry run that reports the hash as stale blocks Save", async () => {
    mockPreview.mockResolvedValue({ inputsHash: "h9", stale: true, changes: [] });
    renderSheet();
    expect(await screen.findByText(new RegExp(CHANGED_BY_SOMEONE_ELSE))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("T-ui3: a dry run that fails shows Not checked, blocks Save, and Retry checks again", async () => {
    mockPreview.mockRejectedValueOnce(new Error("down"));
    renderSheet();
    expect(await screen.findByText(NOT_CHECKED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    ready([row("a", ON, OFF)]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Alpha: On to Off")).toBeInTheDocument();
    expect(mockPreview).toHaveBeenCalledTimes(2);
  });

  it("a save the server refuses for another reason shows its message and keeps the sheet open", async () => {
    ready([row("a", ON, OFF)]);
    mockApply.mockRejectedValue({ response: { status: 400, data: { message: "nope" } } });
    const props = renderSheet({ changes: CHANGES.slice(0, 1) });
    await screen.findByText("Alpha: On to Off");
    fireEvent.change(screen.getByLabelText(/Why are you making these changes/), {
      target: { value: "Pilot ended" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save. Nothing was changed.",
    );
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});
