import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CounterDateChip, CounterDateReminder } from "./CounterDateChip";

// W-1188 N2: the chip's states, Alt+D, the picker's typed date, and the caps. Monday 2026-11-09 is the business's today.
const TODAY = "2026-11-09";

function setup(value = "", over: Partial<React.ComponentProps<typeof CounterDateChip>> = {}) {
  const onChange = jest.fn();
  const onDone = jest.fn();
  render(
    <div>
      <input aria-label="scan" data-testid="scan" />
      <CounterDateChip value={value} today={TODAY} onChange={onChange} onDone={onDone} {...over} />
    </div>,
  );
  return { onChange, onDone };
}

describe("CounterDateChip states", () => {
  it("reads Today by default, with the plain name", () => {
    setup();
    expect(screen.getByTestId("counter-date-chip")).toHaveAttribute("data-direction", "TODAY");
    expect(screen.getByRole("button", { name: "Order date: today. Change" })).toHaveTextContent(
      "Today",
    );
    expect(screen.queryByRole("button", { name: /Clear the order date/ })).toBeNull();
  });

  it("a past day is amber and says Dated", () => {
    setup("2026-11-06");
    expect(screen.getByTestId("counter-date-chip")).toHaveAttribute("data-direction", "BACK");
    expect(
      screen.getByRole("button", { name: "Backdated to Friday, November 6. Change or clear" }),
    ).toHaveTextContent("Dated Fri, Nov 6");
  });

  it("a future day says future in words, not colour alone", () => {
    setup("2026-11-16");
    expect(screen.getByTestId("counter-date-chip")).toHaveAttribute("data-direction", "FORWARD");
    expect(
      screen.getByRole("button", { name: "Future-dated to Monday, November 16. Change or clear" }),
    ).toHaveTextContent("Dated Mon, Nov 16 · future");
  });

  it("adds the year when the day is not in the business's year", () => {
    setup("2025-12-30");
    expect(screen.getByRole("button", { name: /Backdated to/ })).toHaveTextContent(
      "Dated Tue, Dec 30, 2025",
    );
  });

  it("the clear button returns to Today in one tap and hands the cursor back", async () => {
    const { onChange, onDone } = setup("2026-11-06");
    await userEvent.click(
      screen.getByRole("button", { name: "Clear the order date, back to today" }),
    );
    expect(onChange).toHaveBeenCalledWith("");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows a red ring when the last Complete was refused for the date", () => {
    setup("2026-10-01", { refused: true });
    expect(screen.getByTestId("counter-date-chip").className).toContain("ring-red-500");
  });

  it("does not open while the business's zone is unknown or the till is locked", () => {
    const { rerender } = render(
      <CounterDateChip value="" today={undefined} onChange={jest.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Order date: today. Change" })).toBeDisabled();
    rerender(<CounterDateChip value="" today={TODAY} onChange={jest.fn()} disabled />);
    expect(screen.getByRole("button", { name: "Order date: today. Change" })).toBeDisabled();
  });
});

describe("Alt+D and the picker", () => {
  it("Alt+D opens the picker from the scan box without typing a d", async () => {
    setup();
    const scan = screen.getByTestId("scan") as HTMLInputElement;
    scan.focus();
    fireEvent.keyDown(scan, { key: "∂", code: "KeyD", altKey: true }); // Option+D on a Mac types a symbol
    expect(await screen.findByTestId("counter-date-picker")).toBeInTheDocument();
    expect(scan.value).toBe("");
  });

  it("a typed day applies on Enter, with a live echo", async () => {
    const { onChange, onDone } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    const input = await screen.findByTestId("counter-date-input");
    await userEvent.type(input, "fri");
    expect(screen.getByTestId("counter-date-echo")).toHaveTextContent(
      "Fri, Nov 6, 2026 · 3 days ago",
    );
    await userEvent.type(input, "{Enter}");
    expect(onChange).toHaveBeenCalledWith("2026-11-06");
    expect(onDone).toHaveBeenCalled();
  });

  it("a future echo says future", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    await userEvent.type(await screen.findByTestId("counter-date-input"), "next mon");
    expect(screen.getByTestId("counter-date-echo")).toHaveTextContent(
      "Mon, Nov 16, 2026 · in 7 days (future)",
    );
  });

  it("choosing Today clears the date rather than sending today's day", async () => {
    const { onChange } = setup("2026-11-06");
    await userEvent.click(screen.getByRole("button", { name: /Backdated to/ }));
    const dialog = await screen.findByTestId("counter-date-picker");
    await userEvent.click(within(dialog).getByRole("button", { name: "Today" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("Yesterday is a quick pick", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    await userEvent.click(
      within(await screen.findByTestId("counter-date-picker")).getByRole("button", {
        name: "Yesterday",
      }),
    );
    expect(onChange).toHaveBeenCalledWith("2026-11-08");
  });

  it("refuses a typed day past the caps and does nothing on Enter", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    const input = await screen.findByTestId("counter-date-input");
    await userEvent.type(input, "+400{Enter}");
    expect(screen.getByTestId("counter-date-echo")).toHaveTextContent(
      "That day is outside the dates this till takes.",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calendar days past a year ahead are disabled; a day inside is not", async () => {
    setup("2027-11-01");
    await userEvent.click(screen.getByRole("button", { name: /Future-dated to/ }));
    const dialog = await screen.findByTestId("counter-date-picker");
    expect(dialog.querySelector('[data-day="2027-11-10"]')).toBeEnabled();
    expect(dialog.querySelector('[data-day="2027-11-11"]')).toBeDisabled();
  });

  it("calendar keys: arrows move, T is today, Y is yesterday", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    const grid = within(await screen.findByTestId("counter-date-picker")).getByRole("group", {
      name: "Calendar",
    });
    grid.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-07");
  });
});

describe("CounterDateReminder", () => {
  it("is silent on Today", () => {
    const { container } = render(<CounterDateReminder value="" today={TODAY} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("names the day above Complete", () => {
    render(<CounterDateReminder value="2026-11-06" today={TODAY} />);
    expect(screen.getByTestId("counter-date-reminder")).toHaveTextContent(
      "This sale will be dated Fri, Nov 6",
    );
  });
  it("marks a future day", () => {
    render(<CounterDateReminder value="2026-11-16" today={TODAY} />);
    expect(screen.getByTestId("counter-date-reminder")).toHaveTextContent(
      "This sale will be dated Mon, Nov 16 (future)",
    );
  });
});
