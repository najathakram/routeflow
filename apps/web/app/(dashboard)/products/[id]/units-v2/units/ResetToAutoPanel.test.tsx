import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResetToAutoPanel } from "./ResetToAutoPanel";

const opener = () => screen.getByTestId("units-v2-reset-open");
const panel = () => screen.queryByTestId("units-v2-reset-panel");

describe("ResetToAutoPanel (V17)", () => {
  it("starts closed with a 'Reset all to Auto' button", () => {
    render(<ResetToAutoPanel onApply={jest.fn()} />);
    expect(opener()).toHaveTextContent("Reset all to Auto");
    expect(panel()).toBeNull();
  });

  it("opens, explains the Retail exception, and hides the opener", async () => {
    render(<ResetToAutoPanel onApply={jest.fn()} anchorName="Box" />);
    await userEvent.click(opener());
    expect(panel()).toHaveTextContent("Reset all to Auto?");
    expect(panel()).toHaveTextContent("Box Retail price");
    expect(opener()).not.toBeVisible();
  });

  it("renders the preview slot and the changed count", async () => {
    render(<ResetToAutoPanel onApply={jest.fn()} changedCount={3} preview={<p>Preview rows</p>} />);
    await userEvent.click(opener());
    expect(screen.getByText("Preview rows")).toBeInTheDocument();
    expect(panel()).toHaveTextContent("3 prices will change");
  });

  it("Reset to Auto calls onApply once and closes", async () => {
    const onApply = jest.fn();
    render(<ResetToAutoPanel onApply={onApply} />);
    await userEvent.click(opener());
    await userEvent.click(screen.getByTestId("units-v2-reset-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });

  it("Cancel calls onCancel, closes and focuses the opener", async () => {
    const onCancel = jest.fn();
    render(<ResetToAutoPanel onApply={jest.fn()} onCancel={onCancel} />);
    await userEvent.click(opener());
    await userEvent.click(screen.getByTestId("units-v2-reset-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
  });

  it("Escape closes the panel and returns focus to the opener", async () => {
    const onApply = jest.fn();
    render(<ResetToAutoPanel onApply={onApply} />);
    await userEvent.click(opener());
    await userEvent.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(opener()).toHaveFocus();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("is disabled, with a hint, while the price draft has unsaved changes", () => {
    render(<ResetToAutoPanel onApply={jest.fn()} dirty />);
    expect(opener()).toBeDisabled();
    expect(screen.getByText("Save or discard your price changes first")).toBeInTheDocument();
  });

  it("is disabled when told so, and Apply is disabled while applying", async () => {
    const { rerender } = render(<ResetToAutoPanel onApply={jest.fn()} disabled />);
    expect(opener()).toBeDisabled();
    rerender(<ResetToAutoPanel onApply={jest.fn()} />);
    await userEvent.click(opener());
    rerender(<ResetToAutoPanel onApply={jest.fn()} disabled />);
    expect(screen.getByTestId("units-v2-reset-apply")).toBeDisabled();
  });

  it("uses no em or en dashes in its copy", async () => {
    const { container } = render(<ResetToAutoPanel onApply={jest.fn()} />);
    await userEvent.click(opener());
    expect(container.textContent).not.toMatch(/[–—]/);
  });
});

describe("ResetToAutoPanel reveals itself when it opens (K10d, under the Edit save bar)", () => {
  const seen: Element[] = [];
  beforeEach(() => {
    seen.length = 0;
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      expect(opts).toEqual({ block: "nearest" });
      seen.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("scrolls the panel to the nearest edge, once per opening", async () => {
    render(<ResetToAutoPanel onApply={jest.fn()} />);
    expect(seen).toEqual([]);
    await userEvent.click(opener());
    expect(seen).toEqual([screen.getByTestId("units-v2-reset-panel")]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(opener());
    expect(seen).toHaveLength(2);
  });
});
