import * as React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { BarcodeScannerButton } from "./BarcodeScannerButton";

// The webcam path: @zxing/browser is mocked so a decode can be fired on demand, and
// navigator.mediaDevices is stubbed so the constraints the component asks for can be inspected.
const decodeFromStream = jest.fn();
jest.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: jest.fn().mockImplementation(() => ({ decodeFromStream })),
}));

// B499 — webcam scanning previously failed silently (console.error + close, no operator-visible
// feedback) on permission-denied, no-camera, and insecure-context. This covers the one failure
// mode a plain render/click test can exercise without mocking getUserMedia/@zxing/browser:
// insecure context, checked synchronously before the camera overlay ever opens.
describe("BarcodeScannerButton", () => {
  afterEach(() => {
    // @ts-expect-error — test-only override of a normally read-only browser property
    delete window.isSecureContext;
  });

  it("renders the camera button", () => {
    render(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);
    expect(screen.getByTitle("Scan barcode")).toBeInTheDocument();
  });

  it("on an insecure context, calls onError instead of opening the camera overlay", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const onError = jest.fn();
    render(<BarcodeScannerButton onScan={jest.fn()} onError={onError} title="Scan barcode" />);

    fireEvent.click(screen.getByTitle("Scan barcode"));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("https"));
    expect(screen.queryByText("Align barcode within the box")).not.toBeInTheDocument();
  });

  it("on an insecure context with no onError provided, never throws (silent by design for old call sites)", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);

    expect(() => fireEvent.click(screen.getByTitle("Scan barcode"))).not.toThrow();
  });

  describe("webcam path", () => {
    let getUserMedia: jest.Mock;
    let stop: jest.Mock;
    let trackStop: jest.Mock;
    let track: { stop: jest.Mock; getCapabilities: () => object; applyConstraints: jest.Mock };
    let stream: { getTracks: () => unknown[]; getVideoTracks: () => unknown[] };
    let onDecode: (r: { getText: () => string }) => void;

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
      decodeFromStream.mockImplementation(async (_s: unknown, _v: unknown, cb: typeof onDecode) => {
        onDecode = cb;
        return { stop };
      });
    });
    afterEach(() => {
      // @ts-expect-error — test-only cleanup of a stubbed browser property
      delete navigator.mediaDevices;
    });

    const openScanner = async (ui: React.ReactElement) => {
      const utils = render(ui);
      fireEvent.click(screen.getByTitle("Scan barcode"));
      await waitFor(() => expect(decodeFromStream).toHaveBeenCalled());
      return utils;
    };

    it("acquires the rear camera via getUserMedia and hands that stream to zxing", async () => {
      await openScanner(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);

      expect(getUserMedia.mock.calls[0][0].video.facingMode).toEqual({ ideal: "environment" });
      expect(decodeFromStream.mock.calls[0][0]).toBe(stream);
    });

    it("calls onScan exactly once even when zxing delivers a second decode before stop lands", async () => {
      const onScan = jest.fn();
      await openScanner(<BarcodeScannerButton onScan={onScan} title="Scan barcode" />);

      act(() => {
        onDecode({ getText: () => "012345678905" });
        onDecode({ getText: () => "012345678905" });
      });

      expect(onScan).toHaveBeenCalledTimes(1);
      expect(onScan).toHaveBeenCalledWith("012345678905");
      expect(stop).toHaveBeenCalled();
    });

    it("does not reopen the camera when the parent re-renders with a new onScan", async () => {
      const { rerender } = await openScanner(
        <BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />,
      );
      rerender(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);
      rerender(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    });

    it("renders no torch control when the camera reports no torch capability (iOS Safari)", async () => {
      await openScanner(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);
      expect(screen.queryByLabelText(/flashlight/i)).not.toBeInTheDocument();
    });

    it("renders a torch toggle when the camera reports torch, and it drives applyConstraints", async () => {
      track.getCapabilities = () => ({ torch: true });
      await openScanner(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);

      const btn = await screen.findByLabelText("Turn flashlight on");
      fireEvent.click(btn);

      await waitFor(() =>
        expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] }),
      );
      expect(await screen.findByLabelText("Turn flashlight off")).toBeInTheDocument();
    });

    it("silently drops the torch control when applyConstraints rejects (capability lied)", async () => {
      track.getCapabilities = () => ({ torch: true });
      track.applyConstraints.mockRejectedValue(new Error("nope"));
      await openScanner(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);

      fireEvent.click(await screen.findByLabelText("Turn flashlight on"));

      await waitFor(() => expect(screen.queryByLabelText(/flashlight/i)).not.toBeInTheDocument());
    });

    it("stops the camera stream when the operator cancels", async () => {
      await openScanner(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);
      fireEvent.click(screen.getByText("Cancel"));
      expect(stop).toHaveBeenCalled();
    });

    it("surfaces a permission-denied getUserMedia failure through onError", async () => {
      getUserMedia.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const onError = jest.fn();
      render(<BarcodeScannerButton onScan={jest.fn()} onError={onError} title="Scan barcode" />);
      fireEvent.click(screen.getByTitle("Scan barcode"));

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith(expect.stringContaining("Camera access was denied")),
      );
      expect(decodeFromStream).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
