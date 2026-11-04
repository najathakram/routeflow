import {
  STOP_BUSY_COPY,
  STOP_GENERIC_COPY,
  STOP_KEY_CONFLICT_COPY,
  STOP_MOVED_COPY,
  STOP_NOT_ACCEPTED_COPY,
  RUN_CANNOT_FINISH_COPY,
  STOP_REGULATED_COPY,
  STOP_REOPENED_COPY,
  stopErrorCopy,
  runActionErrorCopy,
  leftToDeliverText,
} from "./driver-stop-copy";
import { readOnlyRefusalCopy } from "./read-only-refusal";
import { releaseStopKey, stopKey } from "./stop-completion-key";

const err = (status?: number, code?: string, message?: string) => ({
  response: status === undefined ? undefined : { status, data: { code, message } },
});

/** SA-1098 PR-2 error table: what the driver reads for each answer. */
describe("stopErrorCopy", () => {
  it.each([
    [
      "a 400 fit refusal reads as the fixed line and refreshes, never the server's words",
      err(400, undefined, "Only 7 left."),
      STOP_NOT_ACCEPTED_COPY,
    ],
    [
      "a READ_ONLY 403 reads as the read-only line, not the stop-changed line",
      err(403, "READ_ONLY", "raw"),
      readOnlyRefusalCopy(),
    ],
    [
      "409 IDEMPOTENCY_KEY_CONFLICT reads as the fixed line and refreshes",
      err(409, "IDEMPOTENCY_KEY_CONFLICT", "raw"),
      STOP_KEY_CONFLICT_COPY,
    ],
    ["a lost race (409, no code) refreshes", err(409, undefined, "raw"), STOP_MOVED_COPY],
    ["409 STOP_ALREADY_COMPLETED refreshes", err(409, "STOP_ALREADY_COMPLETED"), STOP_MOVED_COPY],
    [
      "D-31: 409 STOP_REOPENED reads as the reopened line and refreshes",
      err(409, "STOP_REOPENED", "raw server words"),
      STOP_REOPENED_COPY,
    ],
    ["409 MERGE_IN_PROGRESS offers another try", err(409, "MERGE_IN_PROGRESS"), STOP_BUSY_COPY],
    ["503 LOCK_UNAVAILABLE offers another try", err(503, "LOCK_UNAVAILABLE"), STOP_BUSY_COPY],
    [
      "a regulated stop says to call the office",
      err(400, "REGULATED_POD_REQUIRED", "raw"),
      STOP_REGULATED_COPY,
    ],
    [
      "a 403 (not your run, or not in progress) refreshes",
      err(403, undefined, "raw"),
      STOP_MOVED_COPY,
    ],
    ["no response (offline) offers another try", err(undefined), STOP_GENERIC_COPY],
    ["a 500 offers another try", err(500), STOP_GENERIC_COPY],
  ])("%s", (_l, e, text) => {
    expect(stopErrorCopy(e)).toEqual({ text });
  });
});

describe("runActionErrorCopy", () => {
  it("READ_ONLY reads as the read-only line", () => {
    expect(runActionErrorCopy(err(403, "READ_ONLY", "raw"))).toBe(readOnlyRefusalCopy());
  });
  it("a 400 never shows the server's words", () => {
    expect(runActionErrorCopy(err(400, undefined, "Cannot complete run: 2 stop(s)"))).toBe(
      RUN_CANNOT_FINISH_COPY,
    );
  });
  it("anything else reads as the generic line", () => {
    expect(runActionErrorCopy(err(500))).toBe(STOP_GENERIC_COPY);
    expect(runActionErrorCopy(err(undefined))).toBe(STOP_GENERIC_COPY);
  });
});

describe("leftToDeliverText (review-b F2: every line names its unit)", () => {
  it("a Case line reads in cases and pieces, not raw pieces", () => {
    expect(leftToDeliverText({ orderedQty: 53, unitLabel: "Case", unitsPerBox: 24 }, "ea")).toBe(
      "2 Cases + 5 pcs",
    );
    expect(leftToDeliverText({ orderedQty: 48, unitLabel: "Case", unitsPerBox: 24 })).toBe(
      "2 Cases",
    );
  });
  it("a plain line reads its product unit, or the number alone when it stores none (A-3: no unit is invented)", () => {
    expect(leftToDeliverText({ orderedQty: 12, unitLabel: null, unitsPerBox: null }, "lb")).toBe(
      "12 lb",
    );
    expect(leftToDeliverText({ orderedQty: 12, unitLabel: null, unitsPerBox: null }, null)).toBe(
      "12",
    );
    expect(leftToDeliverText({ orderedQty: 12, unitLabel: null, unitsPerBox: null }, " ")).toBe(
      "12",
    );
  });
  it("a factor-1 unit line counts pieces like a plain line", () => {
    expect(leftToDeliverText({ orderedQty: 6, unitLabel: "Piece", unitsPerBox: 1 }, "ea")).toBe(
      "6 ea",
    );
  });
});

describe("web stop key store", () => {
  beforeEach(() => window.sessionStorage.clear());
  it("keeps one key per stop across reads (and a reload), until released", () => {
    const a = stopKey("s1");
    expect(stopKey("s1")).toBe(a);
    expect(window.sessionStorage.getItem("rf-stop-key:s1")).toBe(a);
    expect(stopKey("s2")).not.toBe(a);
    releaseStopKey("s1");
    expect(window.sessionStorage.getItem("rf-stop-key:s1")).toBeNull();
    expect(stopKey("s1")).not.toBe(a);
  });
});
