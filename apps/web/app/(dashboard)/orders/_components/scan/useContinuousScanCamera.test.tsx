import * as React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { useContinuousScanCamera, type ScanFrame } from "./useContinuousScanCamera";

const decodeFromStream = jest.fn();
jest.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: jest.fn().mockImplementation(() => ({ decodeFromStream })),
}));

/** Renders the hook with a real <video> so the ref resolves; exposes the latest hook value. */
function Harness({
  enabled,
  onDetect,
  probe,
}: {
  enabled: boolean;
  onDetect: (c: string, frame?: ScanFrame) => void;
  probe: (cam: ReturnType<typeof useContinuousScanCamera>) => void;
}) {
  const cam = useContinuousScanCamera({ enabled, onDetect });
  probe(cam);
  return <video ref={cam.videoRef} />;
}

describe("useContinuousScanCamera", () => {
  let getUserMedia: jest.Mock;
  let stop: jest.Mock;
  let trackStop: jest.Mock;
  let track: { stop: jest.Mock; getCapabilities: () => object; applyConstraints: jest.Mock };
  let stream: { getTracks: () => unknown[]; getVideoTracks: () => unknown[] };
  let deliver: (code: string | null, points?: Array<[number, number]>) => void;
  let latest: ReturnType<typeof useContinuousScanCamera>;
  const probe = (c: ReturnType<typeof useContinuousScanCamera>) => {
    latest = c;
  };

  beforeEach(() => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    stop = jest.fn();
    trackStop = jest.fn();
    track = {
      stop: trackStop,
      getCapabilities: () => ({}),
      applyConstraints: jest.fn().mockResolvedValue(undefined),
    };
    stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    getUserMedia = jest.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    decodeFromStream.mockReset();
    decodeFromStream.mockImplementation(
      async (_s: unknown, _v: unknown, cb: (r: unknown, e: unknown, c: unknown) => void) => {
        deliver = (code, points) =>
          cb(
            code
              ? {
                  getText: () => code,
                  getResultPoints: () =>
                    (points ?? []).map(([x, y]) => ({ getX: () => x, getY: () => y })),
                }
              : undefined,
            undefined,
            { stop },
          );
        return { stop };
      },
    );
  });
  afterEach(() => {
    // @ts-expect-error — test-only cleanup of a stubbed browser property
    delete navigator.mediaDevices;
  });

  it("opens the rear camera and calls onDetect for EVERY decode — it never stops after a hit", async () => {
    const onDetect = jest.fn();
    render(<Harness enabled onDetect={onDetect} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());

    expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ ideal: "environment" });
    act(() => {
      deliver("111");
      deliver("222");
      deliver("111");
    });

    expect(onDetect.mock.calls.map((c) => c[0])).toEqual(["111", "222", "111"]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("reads fast enough for steady-read: zxing's default 500 ms throttles would stretch a 3-frame streak past its gap window", async () => {
    // @zxing/browser waits delayBetweenScanSuccess (default 500 ms) after every decode and delayBetweenScanAttempts
    // (default 500 ms) after a miss; steady-read resets a streak after 700 ms and treats ~800 ms as an absence, so a held
    // code on a slow phone would never scan (or be re-accepted after one missed decode). Keep the cadence well inside it.
    const { BrowserMultiFormatReader } = jest.requireMock("@zxing/browser");
    BrowserMultiFormatReader.mockClear();
    render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    expect(BrowserMultiFormatReader).toHaveBeenCalledWith(undefined, {
      delayBetweenScanSuccess: 100,
      delayBetweenScanAttempts: 100,
    });
  });

  it("aim box + steady-read inputs: every decode carries the result-point bounds and the DRAWN box in video pixels", async () => {
    const onDetect = jest.fn();
    render(<Harness enabled onDetect={onDetect} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    const video = latest.videoRef.current!;
    for (const [k, v] of [
      ["videoWidth", 1200],
      ["videoHeight", 600],
      ["clientWidth", 600],
      ["clientHeight", 300],
    ] as const) {
      Object.defineProperty(video, k, { value: v, configurable: true });
    }
    act(() =>
      deliver("111", [
        [550, 290],
        [650, 310],
      ]),
    );
    expect(onDetect).toHaveBeenCalledWith("111", {
      bounds: { origin: { x: 550, y: 290 }, size: { width: 100, height: 20 } },
      aimBox: { x: 100, y: 120, width: 1000, height: 360 },
    });
  });

  it("no geometry (video not sized yet, no result points): the frame carries nothing, so the filter fails OPEN", async () => {
    const onDetect = jest.fn();
    render(<Harness enabled onDetect={onDetect} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    act(() => deliver("111"));
    expect(onDetect).toHaveBeenCalledWith("111", { bounds: undefined, aimBox: undefined });
  });

  it("ignores a decode callback with no result (zxing reports 'not found' per frame)", async () => {
    const onDetect = jest.fn();
    render(<Harness enabled onDetect={onDetect} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    act(() => deliver(null));
    expect(onDetect).not.toHaveBeenCalled();
  });

  it("does not reopen the camera when the parent re-renders with a new onDetect", async () => {
    const { rerender } = render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    rerender(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    rerender(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("uses the LATEST onDetect for a detection that lands after a re-render", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Harness enabled onDetect={first} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    rerender(<Harness enabled onDetect={second} probe={probe} />);
    act(() => deliver("111"));
    expect(second).toHaveBeenCalledWith("111", expect.anything());
    expect(first).not.toHaveBeenCalled();
  });

  it("stops the camera when enabled flips off (the screen pauses under the create-product dialog)", async () => {
    const { rerender } = render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
    rerender(<Harness enabled={false} onDetect={jest.fn()} probe={probe} />);
    expect(stop).toHaveBeenCalled();
  });

  it("does not open the camera at all while disabled", () => {
    render(<Harness enabled={false} onDetect={jest.fn()} probe={probe} />);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops the controls when disabled WHILE decodeFromStream is still awaiting the preview", async () => {
    let resolveDecode!: (c: { stop: () => void }) => void;
    decodeFromStream.mockImplementation(
      () => new Promise((resolve) => (resolveDecode = resolve as typeof resolveDecode)),
    );
    const { rerender } = render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());

    rerender(<Harness enabled={false} onDetect={jest.fn()} probe={probe} />);
    expect(stop).not.toHaveBeenCalled(); // controls not delivered yet
    await act(async () => resolveDecode({ stop }));

    expect(stop).toHaveBeenCalled();
  });

  it("releases the stream when disabled WHILE getUserMedia is still pending", async () => {
    let resolveStream!: (s: unknown) => void;
    getUserMedia.mockImplementation(() => new Promise((resolve) => (resolveStream = resolve)));
    const { rerender } = render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    rerender(<Harness enabled={false} onDetect={jest.fn()} probe={probe} />);
    await act(async () => resolveStream(stream));

    expect(trackStop).toHaveBeenCalled();
    expect(decodeFromStream).not.toHaveBeenCalled();
  });

  it("surfaces a permission-denied failure as an operator-readable error", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(latest.error).toMatch(/Camera access was denied/));
    expect(decodeFromStream).not.toHaveBeenCalled();
  });

  it("stops a granted stream when zxing then fails to start", async () => {
    decodeFromStream.mockRejectedValue(new Error("video never played"));
    render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(latest.error).toBeTruthy());
    expect(trackStop).toHaveBeenCalled();
  });

  it("reports an insecure context instead of a black panel", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(latest.error).toMatch(/secure connection/));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("offers a torch only when the camera reports one, and drops it when the capability lied", async () => {
    track.getCapabilities = () => ({ torch: true });
    track.applyConstraints.mockRejectedValue(new Error("nope"));
    render(<Harness enabled onDetect={jest.fn()} probe={probe} />);
    await waitFor(() => expect(latest.torchAvailable).toBe(true));

    await act(async () => latest.toggleTorch());

    await waitFor(() => expect(latest.torchAvailable).toBe(false));
  });
});
