import {
  STOP_BUSY_COPY,
  STOP_GENERIC_COPY,
  STOP_KEY_CONFLICT_COPY,
  STOP_MOVED_COPY,
  STOP_REGULATED_COPY,
  STOP_REOPENED_COPY,
  stopErrorCopy,
} from "./driver-stop-copy";
import { releaseStopKey, stopKey } from "./stop-completion-key";

const err = (status?: number, code?: string, message?: string) => ({
  response: status === undefined ? undefined : { status, data: { code, message } },
});

/** SA-1098 PR-2 error table: what the driver reads for each answer, and whether the screen refreshes or offers another try. */
describe("stopErrorCopy", () => {
  it.each([
    [
      "a 400 fit refusal shows the server's words",
      err(400, undefined, "Only 7 left."),
      "Only 7 left.",
      false,
      false,
    ],
    [
      "409 IDEMPOTENCY_KEY_CONFLICT reads as the fixed line and refreshes",
      err(409, "IDEMPOTENCY_KEY_CONFLICT", "raw"),
      STOP_KEY_CONFLICT_COPY,
      true,
      false,
    ],
    [
      "a lost race (409, no code) refreshes",
      err(409, undefined, "raw"),
      STOP_MOVED_COPY,
      true,
      false,
    ],
    [
      "409 STOP_ALREADY_COMPLETED refreshes",
      err(409, "STOP_ALREADY_COMPLETED"),
      STOP_MOVED_COPY,
      true,
      false,
    ],
    [
      "D-31: 409 STOP_REOPENED reads as the reopened line and refreshes",
      err(409, "STOP_REOPENED", "raw server words"),
      STOP_REOPENED_COPY,
      true,
      false,
    ],
    [
      "409 MERGE_IN_PROGRESS offers another try",
      err(409, "MERGE_IN_PROGRESS"),
      STOP_BUSY_COPY,
      false,
      true,
    ],
    [
      "503 LOCK_UNAVAILABLE offers another try",
      err(503, "LOCK_UNAVAILABLE"),
      STOP_BUSY_COPY,
      false,
      true,
    ],
    [
      "a regulated stop says to call the office",
      err(400, "REGULATED_POD_REQUIRED", "raw"),
      STOP_REGULATED_COPY,
      false,
      false,
    ],
    [
      "a 403 (not your run, or not in progress) refreshes",
      err(403, undefined, "raw"),
      STOP_MOVED_COPY,
      true,
      false,
    ],
    ["no response (offline) offers another try", err(undefined), STOP_GENERIC_COPY, false, true],
    ["a 500 offers another try", err(500), STOP_GENERIC_COPY, false, true],
  ])("%s", (_l, e, message, refresh, retry) => {
    expect(stopErrorCopy(e)).toEqual({ message, refresh, retry });
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
