import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CounterDateChip, CounterDateReminder } from "./CounterDateChip";
import { OFFICE_FUTURE_HINT } from "./CounterDatePicker";

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
  it("unknown day: shows the day with checking, never Today, never Dated (R8)", () => {
    setup("2026-11-06", { today: undefined });
    const chip = screen.getByTestId("counter-date-chip");
    expect(chip).not.toHaveAttribute("data-direction", "TODAY");
    expect(chip).toHaveTextContent("Nov 6");
    expect(chip).toHaveTextContent("checking");
    expect(chip).not.toHaveTextContent("Today");
    expect(chip).not.toHaveTextContent("Dated");
    expect(chip.className).not.toContain("amber");
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

async function openGrid(over: Partial<React.ComponentProps<typeof CounterDateChip>> = {}) {
  const view = setup("", over);
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

// W-1188 round 4: a scan's first key in the picker. NO timing anywhere: no real sleeps, no thresholds. Every case runs at
// S0 (no timer between keys) and S400 (timers fire between keys) and must give the SAME result.
describe("a scan's first key in the picker acts on nothing (no timing)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });
  const SPEEDS: Array<[string, number | null]> = [
    ["S0", null],
    ["S400", 400],
  ];
  const userAt = (delay: number | null) =>
    userEvent.setup({ delay, advanceTimers: jest.advanceTimersByTime });

  /** every focus position, read from the DOM: the grid plus each enabled button in the dialog outside the grid */
  const positions = (picker: HTMLElement): HTMLElement[] => {
    const dialog = picker.closest('[role="dialog"]') as HTMLElement;
    const grid = within(picker).getByRole("grid", { name: /^Calendar/ });
    return [
      grid,
      ...Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])")).filter(
        (b) => !grid.contains(b),
      ),
    ];
  };
  const labelOf = (el: HTMLElement) => el.getAttribute("aria-label") || el.textContent || "grid";
  const openFresh = async (
    user: ReturnType<typeof userAt>,
    over: Partial<React.ComponentProps<typeof CounterDateChip>> = {},
  ) => {
    const view = setup("", over);
    await user.click(screen.getByRole("button", { name: "Order date: today. Change" }));
    const picker = await screen.findByTestId("counter-date-picker");
    return { ...view, picker };
  };
  /** the number of focus positions, counted once from a fresh picker */
  const countPositions = async (user: ReturnType<typeof userAt>) => {
    const first = await openFresh(user);
    const labels = positions(first.picker).map(labelOf);
    cleanup();
    return labels;
  };

  it.each(SPEEDS)(
    "C1 till: the first key at every position calls onScanKey, closes, sets no day (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const labels = await countPositions(user);
      expect(labels.length).toBeGreaterThanOrEqual(8); // grid, X, quick picks, month buttons, Cancel, Apply: enumerated
      for (let i = 0; i < labels.length; i++) {
        const onScanKey = jest.fn();
        const { onChange, onDone, picker } = await openFresh(user, { onScanKey });
        act(() => positions(picker)[i].focus());
        await user.keyboard("4006381333931");
        expect(onScanKey).toHaveBeenCalledTimes(1);
        expect(onScanKey).toHaveBeenCalledWith("4");
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByTestId("counter-date-picker")).toBeNull();
        expect(onDone).toHaveBeenCalled();
        cleanup();
      }
    },
  );

  it.each(SPEEDS)(
    "C1 a typed date pending in the text box does not change the result (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const onScanKey = jest.fn();
      const { onChange, picker } = await openFresh(user, { onScanKey });
      await user.type(within(picker).getByTestId("counter-date-input"), "fri");
      const grid = within(picker).getByRole("grid", { name: /^Calendar/ });
      act(() => grid.focus());
      await user.keyboard("C");
      expect(onScanKey).toHaveBeenCalledWith("C");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByTestId("counter-date-picker")).toBeNull();
    },
  );

  it.each(SPEEDS)(
    "C2 office (no onScanKey): the picker stays open, shows the note, swallows the run and its Enter (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const labels = await countPositions(user);
      for (let i = 0; i < labels.length; i++) {
        const { onChange, picker } = await openFresh(user);
        act(() => positions(picker)[i].focus());
        await user.keyboard("COLA123{Enter}");
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
        expect(screen.getByTestId("counter-date-scan-note")).toHaveTextContent(
          "That looked like a scan, so nothing was picked.",
        );
        expect(within(picker).getByText("November 2026")).toBeInTheDocument();
        // the next Enter is a person's and works as usual
        const grid = within(picker).getByRole("grid", { name: /^Calendar/ });
        act(() => grid.focus());
        await user.keyboard("{Enter}");
        expect(onChange).toHaveBeenCalledTimes(1);
        cleanup();
      }
    },
  );

  it.each(SPEEDS)(
    "D1 Alt+1,2,3 then Enter at every position: nothing pressed, no day, the note shows (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const labels = await countPositions(user);
      for (let i = 0; i < labels.length; i++) {
        const onScanKey = jest.fn();
        const { onChange, picker } = await openFresh(user, { onScanKey });
        act(() => positions(picker)[i].focus());
        await user.keyboard("{Alt>}123{/Alt}{Enter}");
        expect(onChange).not.toHaveBeenCalled();
        expect(onScanKey).not.toHaveBeenCalled();
        expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
        expect(screen.getByTestId("counter-date-scan-note")).toBeInTheDocument();
        cleanup();
      }
    },
  );

  it.each(SPEEDS)(
    "C3 the text box: dates apply, codes go to onScan, other text only hints (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const apply: Array<[string, string]> = [
        ["tomorrow", "2026-11-10"],
        ["11-02", "2026-11-02"],
        ["fri", "2026-11-06"],
        ["+3", "2026-11-12"],
        ["yesterday", "2026-11-08"],
      ];
      for (const [text, day] of apply) {
        const onScan = jest.fn();
        const { onChange, picker } = await openFresh(user, { onScan });
        await user.type(within(picker).getByTestId("counter-date-input"), `${text}{Enter}`);
        expect(onChange).toHaveBeenCalledWith(day);
        expect(onScan).not.toHaveBeenCalled();
        cleanup();
      }
      for (const code of ["4006381333931", "COLA123"]) {
        const onScan = jest.fn();
        const { onChange, picker } = await openFresh(user, { onScan });
        await user.type(within(picker).getByTestId("counter-date-input"), `${code}{Enter}`);
        expect(onChange).not.toHaveBeenCalled();
        expect(onScan).toHaveBeenCalledWith(code);
        expect(screen.queryByTestId("counter-date-picker")).toBeNull();
        cleanup();
      }
      for (const text of ["102", "1102", "tomorow", "ABC"]) {
        const onScan = jest.fn();
        const { onChange, picker } = await openFresh(user, { onScan });
        await user.type(within(picker).getByTestId("counter-date-input"), `${text}{Enter}`);
        expect(screen.getByTestId("counter-date-echo")).toHaveTextContent('Try "yesterday"');
        expect(onChange).not.toHaveBeenCalled();
        expect(onScan).not.toHaveBeenCalled();
        expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
        cleanup();
      }
      const out = await openFresh(user, { onScan: jest.fn() });
      await user.type(within(out.picker).getByTestId("counter-date-input"), "+400{Enter}");
      expect(screen.getByTestId("counter-date-echo")).toHaveTextContent("outside the dates");
      expect(out.onChange).not.toHaveBeenCalled();
      cleanup();
      const office = await openFresh(user, { policy: "OFFICE" });
      await user.type(within(office.picker).getByTestId("counter-date-input"), "tomorrow{Enter}");
      expect(screen.getByTestId("counter-date-echo")).toHaveTextContent(OFFICE_FUTURE_HINT);
      expect(office.onChange).not.toHaveBeenCalled();
    },
  );

  it("C3 office: a code typed in the text box shows the note and is not applied", async () => {
    const user = userAt(null);
    const { onChange, picker } = await openFresh(user, { policy: "OFFICE" });
    await user.type(within(picker).getByTestId("counter-date-input"), "4006381333931{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("counter-date-scan-note")).toBeInTheDocument();
    expect(screen.getByTestId("counter-date-picker")).toBeInTheDocument();
  });

  it.each(SPEEDS)(
    "C4 people: a held arrow, Page keys, Home/End and Space on a quick pick all work (%s)",
    async (_n, delay) => {
      const user = userAt(delay);
      const gridOf = (picker: HTMLElement) =>
        within(picker).getByRole("grid", { name: /^Calendar/ });
      let view = await openFresh(user);
      act(() => gridOf(view.picker).focus());
      await user.keyboard("{ArrowRight>6/}{Enter}");
      expect(view.onChange).toHaveBeenLastCalledWith("2026-11-15");
      cleanup();

      view = await openFresh(user);
      act(() => gridOf(view.picker).focus());
      await user.keyboard("{PageDown}{PageUp}{PageUp}");
      expect(within(view.picker).getByText("October 2026")).toBeInTheDocument();
      cleanup();

      view = await openFresh(user);
      act(() => gridOf(view.picker).focus());
      await user.keyboard("{Home}{End}{ArrowLeft}{PageUp}{Enter}");
      expect(view.onChange).toHaveBeenLastCalledWith("2026-10-13"); // the day the keys moved to, not a no-op
      cleanup();

      view = await openFresh(user);
      act(() => within(view.picker).getByRole("button", { name: "Yesterday" }).focus());
      await user.keyboard(" ");
      expect(view.onChange).toHaveBeenLastCalledWith("2026-11-08");
    },
  );
});
