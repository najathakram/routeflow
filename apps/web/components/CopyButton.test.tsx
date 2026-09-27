import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CopyButton } from "./CopyButton";

/**
 * #2438: each CopyButton owns its "Copied" state (the create-tenant card used to share one flag
 * between two copy controls), and the reset timer never outlives the button.
 */
describe("CopyButton", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("copies its own value and shows Copied, then resets", () => {
    render(<CopyButton value="abc-123" label="Copy code" />);
    const btn = screen.getByRole("button", { name: "Copy code" });
    fireEvent.click(btn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("abc-123");
    expect(btn).toHaveTextContent("Copied");
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    expect(btn).toHaveTextContent("Copy");
    expect(btn).not.toHaveTextContent("Copied");
  });

  it("two buttons keep independent Copied states", () => {
    render(
      <>
        <CopyButton value="one" label="Copy one" />
        <CopyButton value="two" label="Copy two" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy one" }));
    expect(screen.getByRole("button", { name: "Copy one" })).toHaveTextContent("Copied");
    expect(screen.getByRole("button", { name: "Copy two" })).not.toHaveTextContent("Copied");
  });

  it("clears its reset timer on unmount (no state update after unmount)", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<CopyButton value="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
    unmount();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses the caller's className instead of the default styling", () => {
    render(<CopyButton value="x" className="my-dark-btn" />);
    expect(screen.getByRole("button", { name: "Copy value" })).toHaveClass("my-dark-btn");
  });
});
