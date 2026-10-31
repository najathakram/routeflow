import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { BarcodeScannerButton } from "./BarcodeScannerButton";

/**
 * SA-1067 C1 (rows C-1 to C-3): a camera that can't start says so. 15 of the button's 18 mounts pass no `onError`, so a
 * denied permission or a plain-http page left the clerk looking at nothing. With no `onError` the button now shows the
 * same classified message as a toast; a mount that passes `onError` keeps handling it alone.
 */
const decodeFromStream = jest.fn();
jest.mock("@zxing/browser", () => ({
  BrowserMultiFormatReader: jest.fn().mockImplementation(() => ({ decodeFromStream })),
}));

const mount = (props: Partial<React.ComponentProps<typeof BarcodeScannerButton>> = {}) =>
  render(
    <ToastProvider>
      <BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" {...props} />
    </ToastProvider>,
  );

afterEach(() => {
  // @ts-expect-error — test-only cleanup of stubbed browser properties
  delete window.isSecureContext;
  // @ts-expect-error — test-only cleanup of a stubbed browser property
  delete navigator.mediaDevices;
});

describe("SA-1067 C1: a camera that can't start says so", () => {
  it("C-1: permission denied, no onError: a toast carries the classified copy", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" })),
      },
      configurable: true,
    });
    mount();
    fireEvent.click(screen.getByTitle("Scan barcode"));
    expect(await screen.findByText(/Camera access was denied/)).toBeInTheDocument();
  });

  it("C-2: no secure context, no onError: a toast says to use https", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    mount();
    fireEvent.click(screen.getByTitle("Scan barcode"));
    expect(await screen.findByText(/secure connection \(https\)/)).toBeInTheDocument();
  });

  it("C-3: a mount with onError keeps it, and shows no toast", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const onError = jest.fn();
    mount({ onError });
    fireEvent.click(screen.getByTitle("Scan barcode"));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/secure connection \(https\)/)).toBeNull();
  });

  it("with no ToastProvider above and no onError, a failure is still silent and never throws", () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<BarcodeScannerButton onScan={jest.fn()} title="Scan barcode" />);
    expect(() => fireEvent.click(screen.getByTitle("Scan barcode"))).not.toThrow();
  });
});
