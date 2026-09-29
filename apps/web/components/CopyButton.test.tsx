import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./CopyButton";

/**
 * #2438: each CopyButton owns its status (the create-tenant card used to share one flag between two
 * copy controls), "Copied" shows only after the clipboard write resolves, a failed write says so and
 * selects the value for a manual copy (#2598 review), and the reset timer never outlives the button.
 */
function mockClipboard(writeText: jest.Mock | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

async function clickAndSettle(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe("CopyButton", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClipboard(jest.fn().mockResolvedValue(undefined));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("copies its own value and shows Copied only once the write resolves, then resets", async () => {
    render(<CopyButton value="abc-123" label="Copy code" />);
    const btn = screen.getByRole("button", { name: "Copy code" });
    await clickAndSettle(btn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abc-123");
    expect(btn).toHaveTextContent("Copied");
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    expect(btn).toHaveTextContent("Copy");
    expect(btn).not.toHaveTextContent("Copied");
  });

  it("two buttons keep independent states", async () => {
    render(
      <>
        <CopyButton value="one" label="Copy one" />
        <CopyButton value="two" label="Copy two" />
      </>,
    );
    await clickAndSettle(screen.getByRole("button", { name: "Copy one" }));
    expect(screen.getByRole("button", { name: "Copy one" })).toHaveTextContent("Copied");
    expect(screen.getByRole("button", { name: "Copy two" })).not.toHaveTextContent("Copied");
  });

  it("a rejected write never shows Copied: it shows the failure text and selects the value", async () => {
    mockClipboard(jest.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    function Harness() {
      const ref = React.useRef<HTMLSpanElement>(null);
      return (
        <>
          <span ref={ref}>https://pay.example/link-for-this-tenant</span>
          <CopyButton
            value="https://pay.example/link-for-this-tenant"
            label="Copy link"
            failedText="Copy failed — select the link"
            selectOnFail={ref}
          />
        </>
      );
    }
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "Copy link" });
    await clickAndSettle(btn);
    expect(btn).not.toHaveTextContent("Copied");
    expect(btn).toHaveTextContent("Copy failed — select the link");
    expect(window.getSelection()?.toString()).toBe("https://pay.example/link-for-this-tenant");
  });

  it("a missing Clipboard API is a failure too, not a silent Copied", async () => {
    mockClipboard(undefined);
    render(<CopyButton value="x" />);
    const btn = screen.getByRole("button", { name: "Copy value" });
    await clickAndSettle(btn);
    expect(btn).not.toHaveTextContent("Copied");
    expect(btn).toHaveTextContent("Copy failed — select it manually");
  });

  it("announces its status through a polite live region", () => {
    render(<CopyButton value="x" />);
    const live = screen.getByRole("button", { name: "Copy value" }).querySelector("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("clears its reset timer on unmount (no state update after unmount)", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<CopyButton value="x" />);
    await clickAndSettle(screen.getByRole("button", { name: "Copy value" }));
    unmount();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses the caller's className instead of the default styling", () => {
    render(<CopyButton value="x" className="my-dark-btn" />);
    expect(screen.getByRole("button", { name: "Copy value" })).toHaveClass("my-dark-btn");
  });
});
