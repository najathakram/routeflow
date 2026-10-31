import * as React from "react";
import { act, render } from "@testing-library/react";
import { CounterCameraStrip, createPausableClock, useCameraScanEngine } from "./CounterCameraStrip";

/**
 * SA-1059: the strip's clock, on its own. The screen-level rows (CounterSaleScreen.camera.test.tsx) prove the behaviour end to
 * end; these pin the clock's arithmetic and that a dropped frame costs no render after the first.
 */
jest.mock("./scan/useContinuousScanCamera", () => ({
  useContinuousScanCamera: (opts: { onDetect: (code: string) => void }) => {
    captured.onDetect = opts.onDetect;
    return {
      videoRef: { current: null },
      torchAvailable: false,
      torchOn: false,
      toggleTorch: () => undefined,
      refocus: () => undefined,
      error: null,
    };
  },
}));
const captured: { onDetect: ((code: string) => void) | null } = { onDetect: null };

describe("createPausableClock", () => {
  const make = () => {
    let t = 1000;
    const clock = createPausableClock(() => t);
    return { clock, at: (n: number) => void (t = n), tick: (n: number) => void (t += n) };
  };

  it("runs with real time when nothing is blocked", () => {
    const { clock, tick } = make();
    const a = clock.now();
    tick(500);
    expect(clock.now() - a).toBe(500);
  });

  it("a hard block (camera off) freezes everything up to the first accepted frame", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.block();
    tick(3000);
    expect(clock.now() - a).toBe(0); // frozen while blocked
    tick(1500); // the camera is back on but has not delivered a frame
    clock.unblock(); // the first accepted frame
    expect(clock.now() - a).toBe(0);
    tick(100);
    expect(clock.now() - a).toBe(100);
  });

  it("a block of dropped frames freezes only up to the last frame dropped", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.drop();
    tick(2000);
    clock.drop(); // still in view 2 s later
    tick(5000); // then nothing in front of the camera for 5 s
    clock.unblock();
    expect(clock.now() - a).toBe(5000);
  });

  it("a hard block inside a block of dropped frames still freezes right up to the accepted frame", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.drop();
    tick(1000);
    clock.block();
    tick(4000);
    clock.unblock();
    expect(clock.now() - a).toBe(0);
  });

  it("a later block starts clean (nothing is carried from an earlier one)", () => {
    const { clock, tick } = make();
    const a = clock.now();
    clock.block();
    tick(1000);
    clock.unblock();
    tick(300);
    clock.drop();
    tick(2000);
    clock.unblock(); // the last drop was the first: 0 ms frozen, 2000 ms real
    expect(clock.now() - a).toBe(2300);
  });
});

describe("CounterCameraStrip renders", () => {
  it("a dropped frame re-renders the strip once (the note appears), not once per frame", () => {
    let commits = 0;
    function Harness() {
      const engine = useCameraScanEngine();
      return (
        <React.Profiler id="strip" onRender={() => void (commits += 1)}>
          <CounterCameraStrip
            engine={engine}
            enabled
            frameBlocked={() => true}
            onCode={() => undefined}
          />
        </React.Profiler>
      );
    }
    const { getByText } = render(<Harness />);
    const base = commits;
    for (let i = 0; i < 25; i += 1) act(() => captured.onDetect!("200000000001"));
    expect(getByText("Camera paused")).toBeInTheDocument();
    expect(commits - base).toBe(1);
  });
});
