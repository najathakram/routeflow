import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { BarcodeScannerButton } from "./BarcodeScannerButton";

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
});
