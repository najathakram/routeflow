import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("W-1188: while the business's day is unknown a set date is still shown as dated, never as Today", () => {
    setup("2026-11-06", { today: undefined });
    const chip = screen.getByTestId("counter-date-chip");
    expect(chip).not.toHaveAttribute("data-direction", "TODAY");
    expect(chip).toHaveTextContent("Dated");
    expect(chip).toHaveTextContent("Nov 6");
    expect(chip).not.toHaveTextContent("Today");
    expect(screen.getByRole("button", { name: /Clear the order date/ })).toBeEnabled();
  });

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
    const { onChange } = setup("2026-11-06", { onDone: undefined });
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

  it("calendar keys: arrows move the cursor and Enter applies it", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    const grid = within(await screen.findByTestId("counter-date-picker")).getByRole("grid", {
      name: /^Calendar/,
    });
    grid.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-07");
  });
});

async function openGrid() {
  const view = setup();
  await userEvent.click(screen.getByRole("button", { name: "Order date: today. Change" }));
  const picker = await screen.findByTestId("counter-date-picker");
  const grid = within(picker).getByRole("grid", { name: /^Calendar/ });
  return { ...view, picker, grid };
}

describe("calendar details (reader SHOULDs)", () => {
  it("the grid's name carries the month and year", async () => {
    const { picker } = await openGrid();
    expect(
      within(picker).getByRole("grid", { name: "Calendar, November 2026" }),
    ).toBeInTheDocument();
  });

  it("paging back to the lowest month never leaves the cursor on a disabled day", async () => {
    const { picker, grid } = await openGrid();
    const prev = within(picker).getByRole("button", { name: "Previous month" });
    for (let i = 0; i < 24; i++) await userEvent.click(prev);
    expect(within(picker).getByText("November 2024")).toBeInTheDocument();
    const cell = document.getElementById(grid.getAttribute("aria-activedescendant")!);
    expect(cell).not.toBeNull();
    expect(cell).toBeEnabled();
  });

  it("a scan landing on the grid after arrowing never applies the cursor day", async () => {
    const { onChange, grid } = await openGrid();
    grid.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await userEvent.keyboard("COLA123{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    // a deliberate Enter, with no typing before it, still applies
    await new Promise((r) => setTimeout(r, 700));
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-07");
  });

  it("a two-digit year gets the same answer as the four-digit year", async () => {
    const { picker } = await openGrid();
    const input = within(picker).getByTestId("counter-date-input");
    await userEvent.type(input, "11/02/2024");
    const four = within(picker).getByTestId("counter-date-echo").textContent;
    await userEvent.clear(input);
    await userEvent.type(input, "11/02/24");
    expect(within(picker).getByTestId("counter-date-echo").textContent).toBe(four);
    expect(four).toMatch(/outside the dates/);
  });
});

describe("calendar is a real grid (reader A2)", () => {
  it("Enter on Next month pages and does not apply or close", async () => {
    const { onChange, picker } = await openGrid();
    within(picker).getByRole("button", { name: "Next month" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(within(picker).getByText("December 2026")).toBeInTheDocument();
    within(picker).getByRole("button", { name: "Previous month" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(within(picker).getByText("November 2026")).toBeInTheDocument();
  });

  it("scanner-like letters never set a date: T and Y on the grid or the month buttons do nothing", async () => {
    const { onChange, picker, grid } = await openGrid();
    grid.focus();
    await userEvent.keyboard("T");
    await userEvent.keyboard("Y");
    await userEvent.keyboard("t");
    within(picker).getByRole("button", { name: "Next month" }).focus();
    await userEvent.keyboard("T");
    await userEvent.keyboard("Y");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
  });

  it("rows, gridcells, the selected day, today, and the announced cursor", async () => {
    const { picker, grid } = await openGrid();
    expect(within(picker).getAllByRole("row").length).toBeGreaterThanOrEqual(5);
    const today = picker.querySelector('[data-day="2026-11-09"]') as HTMLElement;
    expect(today).toHaveAttribute("aria-current", "date");
    expect(today.closest('[role="gridcell"]')).toHaveAttribute("aria-selected", "true");
    expect(
      picker.querySelector('[data-day="2026-11-10"]')!.closest('[role="gridcell"]'),
    ).toHaveAttribute("aria-selected", "false");
    const cursorId = grid.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(cursorId)).toBe(today);
    grid.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.getElementById(grid.getAttribute("aria-activedescendant")!)).toBe(
      picker.querySelector('[data-day="2026-11-10"]'),
    );
  });

  it("PageUp/PageDown change month, Home/End go to the week's ends", async () => {
    const { onChange, picker, grid } = await openGrid();
    grid.focus();
    await userEvent.keyboard("{PageDown}");
    expect(within(picker).getByText("December 2026")).toBeInTheDocument();
    await userEvent.keyboard("{PageUp}{PageUp}");
    expect(within(picker).getByText("October 2026")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 700)); // a person pauses; a scanner's burst would hold Enter
    await userEvent.keyboard("{PageDown}{Home}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-08"); // Sunday of Mon Nov 9's week
    onChange.mockClear();
  });

  it("End goes to the Saturday", async () => {
    const { onChange, grid } = await openGrid();
    grid.focus();
    await userEvent.keyboard("{End}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("2026-11-14");
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

describe("scan bursts never pick a date; people still can (browser MUST)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("an Alt-code scan (digits with Alt held) then Enter up to 400 ms later applies nothing", async () => {
    const { onChange, grid } = await openGrid();
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "Alt", altKey: true });
    for (const key of ["1", "2", "3"]) fireEvent.keyDown(grid, { key, altKey: true });
    await sleep(400);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a Home/End/Left/PageUp burst then Enter applies nothing, whatever the keys", async () => {
    const { onChange, grid } = await openGrid();
    grid.focus();
    for (const key of ["Home", "End", "ArrowLeft", "PageUp"]) fireEvent.keyDown(grid, { key });
    await sleep(400);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a slow person pressing Home, then Enter, still picks the day", async () => {
    const { onChange, grid } = await openGrid();
    grid.focus();
    fireEvent.keyDown(grid, { key: "Home" });
    await sleep(120);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2026-11-08");
  });
});

describe("clear and focus (browser SHOULDs)", () => {
  it("Enter on the clear x clears the date, and focus goes back to the chip", async () => {
    const { onChange } = setup("2026-11-06", { onDone: undefined });
    const x = screen.getByRole("button", { name: /Clear the order date/ });
    x.focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Backdated to/ })),
    );
  });
});
