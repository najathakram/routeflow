import * as React from "react";
import { act, render } from "@testing-library/react";
import { CounterCameraStrip, useCameraScanEngine } from "./CounterCameraStrip";

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
