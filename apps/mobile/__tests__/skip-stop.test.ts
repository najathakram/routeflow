/**
 * F11 (REG-B34): the driver "Skip stop" confirm used to navigate back
 * unconditionally, with no PATCH ever sent — the stop stayed PENDING while
 * the driver believed it was skipped, and its orders were silently stranded
 * on the run (never DELIVERED, never released). `createSkipStopHandler`
 * (../lib/skip-stop, a new module) is the extraction target: it must send
 * the PATCH, wait for the mutation to settle, and only THEN navigate on
 * success — with a distinct offline-queued path, a passthrough of the
 * server's own error message, and an in-flight guard against a double tap.
 *
 * The module does not exist pre-impl, so it is loaded via `require` inside
 * a try/catch (never a static import — that would throw at collection time,
 * which is a resolution failure, not an assertion failure). Every test's
 * first move is `make(...)`, which asserts the export exists before calling
 * it — so a pre-impl run fails on that assertion, not on a crash.
 */
import { readFileSync } from "fs";
import { join } from "path";

let mod: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("../lib/skip-stop");
} catch {
  mod = undefined;
}

const make = (deps: any) => {
  expect(mod?.createSkipStopHandler).toBeDefined();
  return mod.createSkipStopHandler(deps);
};

describe("createSkipStopHandler — REG-B34", () => {
  it("REG-B34: confirming Skip PATCHes the stop to SKIPPED and only then navigates back", () => {
    // T21 · R9
    const mutate = jest.fn();
    const navigateBack = jest.fn();
    const toast = jest.fn();
    const h = make({ runId: "run-1", stopId: "stop-1", mutate, navigateBack, toast });

    h();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      runId: "run-1",
      stopId: "stop-1",
      status: "SKIPPED",
    });
    expect(navigateBack).not.toHaveBeenCalled();

    // The mutation has not settled yet — only invoking the captured
    // onSuccess (as the mutation library would, once the PATCH resolves)
    // may trigger the toast + navigation.
    mutate.mock.calls[0][1].onSuccess();

    expect(toast).toHaveBeenCalledWith("Stop skipped");
    expect(navigateBack).toHaveBeenCalledTimes(1);
  });

  it("REG-B34: without a resolved runId nothing is sent and the driver stays on the stop", () => {
    // T22 · R9
    const mutate = jest.fn();
    const navigateBack = jest.fn();
    const toast = jest.fn();
    const h = make({ runId: undefined, stopId: "stop-1", mutate, navigateBack, toast });

    h();

    expect(mutate).not.toHaveBeenCalled();
    expect(navigateBack).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/not loaded/i));
  });

  it("REG-B34: an offline-queued rejection is reported as queued and the driver goes back; a real error keeps them on the stop", () => {
    // T23 · R9
    // (a) offline-queued: reported as queued, driver navigates back anyway
    // (the PATCH is sitting in the outbox and will replay later).
    const mutateA = jest.fn();
    const navigateBackA = jest.fn();
    const toastA = jest.fn();
    const hA = make({
      runId: "run-1",
      stopId: "stop-1",
      mutate: mutateA,
      navigateBack: navigateBackA,
      toast: toastA,
    });
    hA();
    const offlineErr = Object.assign(new Error("You are offline. Action queued."), {
      isOfflineQueued: true,
    });
    mutateA.mock.calls[0][1].onError(offlineErr);

    expect(toastA).toHaveBeenCalledWith(expect.stringMatching(/queued/i));
    expect(navigateBackA).toHaveBeenCalledTimes(1);

    // (b) a real server rejection (e.g. B71's "already completed" guard) —
    // its message is surfaced verbatim and the driver stays on the stop.
    const mutateB = jest.fn();
    const navigateBackB = jest.fn();
    const toastB = jest.fn();
    const hB = make({
      runId: "run-1",
      stopId: "stop-1",
      mutate: mutateB,
      navigateBack: navigateBackB,
      toast: toastB,
    });
    hB();
    const serverMessage =
      "This stop is completed. Reopen it instead — that reverses the delivery correctly.";
    mutateB.mock.calls[0][1].onError({ response: { data: { message: serverMessage } } });

    expect(toastB).toHaveBeenCalledWith(serverMessage);
    expect(navigateBackB).not.toHaveBeenCalled();

    // (c) a bare Error with no server payload — its own message is used,
    // still no navigation.
    const mutateC = jest.fn();
    const navigateBackC = jest.fn();
    const toastC = jest.fn();
    const hC = make({
      runId: "run-1",
      stopId: "stop-1",
      mutate: mutateC,
      navigateBack: navigateBackC,
      toast: toastC,
    });
    hC();
    mutateC.mock.calls[0][1].onError(new Error("boom"));

    expect(toastC).toHaveBeenCalledWith("boom");
    expect(navigateBackC).not.toHaveBeenCalled();
  });

  it("REG-B34: a second tap while the skip is in flight sends nothing — and the guard clears after settle", () => {
    // T24 · R9
    const mutate = jest.fn();
    const navigateBack = jest.fn();
    const toast = jest.fn();
    const h = make({ runId: "run-1", stopId: "stop-1", mutate, navigateBack, toast });

    // Two taps before the first mutation settles — only one PATCH goes out.
    h();
    h();
    expect(mutate).toHaveBeenCalledTimes(1);

    // The guard clears after an error settle — a retry tap is allowed.
    mutate.mock.calls[0][1].onError(new Error("x"));
    h();
    expect(mutate).toHaveBeenCalledTimes(2);

    // And it clears after a success settle too — a fresh handler instance
    // proves the guard is per-invocation, not permanently latched.
    const mutate2 = jest.fn();
    const navigateBack2 = jest.fn();
    const toast2 = jest.fn();
    const h2 = make({
      runId: "run-1",
      stopId: "stop-1",
      mutate: mutate2,
      navigateBack: navigateBack2,
      toast: toast2,
    });
    h2();
    mutate2.mock.calls[0][1].onSuccess();
    h2();
    expect(mutate2).toHaveBeenCalledTimes(2);
  });

  it("REG-B34 wiring: the driver stop screen routes Skip through createSkipStopHandler and useUpdateStopStatus, not a bare router.replace", () => {
    // T25 · R10
    const screenSrc = readFileSync(
      join(__dirname, "..", "app", "(driver)", "route", "stop", "[stopId]", "index.tsx"),
      "utf8",
    );
    expect(screenSrc).toMatch(/useUpdateStopStatus/);
    expect(screenSrc).toMatch(/createSkipStopHandler\(/);
    // The pre-fix shape: confirm(...)'s onConfirm is a bare
    // `() => router.replace(...)` with no PATCH in between.
    expect(screenSrc).not.toMatch(/confirm\([\s\S]{0,300}\(\)\s*=>\s*router\.replace\(/);
  });

  it("REG-B34: the confirm-navigate scan suppression for the driver stop screen is gone", () => {
    // T26 · R10
    const scanIgnoreSrc = readFileSync(
      join(__dirname, "..", "..", "..", ".claude", "skills", "bug-hunt", "scan-ignore.json"),
      "utf8",
    );
    const json = JSON.parse(scanIgnoreSrc);
    const entries = json["confirm-navigate"];

    if (entries === undefined) {
      expect(entries).toBeUndefined();
    } else {
      expect(
        entries.every((e: string) => !/\(driver\)\/route\/stop\/\[stopId\]\/index\.tsx/.test(e)),
      ).toBe(true);
    }
  });
});
