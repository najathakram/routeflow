import * as React from "react";
import { isTextEntryActive, scheduleScannerRefocus } from "./refocus-scanner";

/**
 * B744 — the shared scanner re-arm. The rule is evaluated when each timer FIRES (never when it
 * is scheduled): skip only when focus sits on a text-entry control other than the target; in
 * every other state — nothing, <body>, a button, a checkbox, the dialog container, or the target
 * itself — focus (and optionally select) the target exactly as the unguarded code did.
 */

function mount<T extends HTMLElement>(html: string): T {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const el = wrap.firstElementChild as T;
  document.body.appendChild(el);
  return el;
}

function scanTarget() {
  const input = mount<HTMLInputElement>(
    '<input type="search" data-testid="scan" value="012345" />',
  );
  const ref = { current: input } as React.RefObject<HTMLInputElement>;
  return { input, ref };
}

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = "";
  (document.activeElement as HTMLElement | null)?.blur?.();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("isTextEntryActive", () => {
  it.each([
    ["a textarea", "<textarea></textarea>"],
    ["an input with no type (text)", "<input />"],
    ["input[type=text]", '<input type="text" />'],
    ["input[type=search]", '<input type="search" />'],
    ["input[type=number]", '<input type="number" />'],
    ["input[type=email]", '<input type="email" />'],
    ["input[type=password]", '<input type="password" />'],
    ["input[type=date]", '<input type="date" />'],
    ["a select", "<select><option>a</option></select>"],
    ["a readonly input (still protected)", '<input type="text" readonly />'],
  ])("is true when %s holds focus", (_label, html) => {
    const el = mount<HTMLElement>(html);
    el.focus();
    expect(document.activeElement).toBe(el);
    expect(isTextEntryActive()).toBe(true);
  });

  it("is true for a contenteditable element", () => {
    const el = mount<HTMLElement>('<div contenteditable="true" tabindex="0"></div>');
    // jsdom does not implement isContentEditable; the helper must read the attribute itself.
    el.focus();
    expect(isTextEntryActive()).toBe(true);
  });

  it.each([
    ["a button", "<button>Add</button>"],
    ["input[type=checkbox]", '<input type="checkbox" />'],
    ["input[type=radio]", '<input type="radio" />'],
    ["input[type=submit]", '<input type="submit" />'],
    ["a link", '<a href="#x">x</a>'],
    ["a focusable div (e.g. a dialog container)", '<div tabindex="-1"></div>'],
  ])("is false when %s holds focus", (_label, html) => {
    const el = mount<HTMLElement>(html);
    el.focus();
    expect(document.activeElement).toBe(el);
    expect(isTextEntryActive()).toBe(false);
  });

  it("is false when nothing holds focus (<body>)", () => {
    expect(document.activeElement).toBe(document.body);
    expect(isTextEntryActive()).toBe(false);
  });
});

describe("scheduleScannerRefocus", () => {
  it("U1: a focused note (textarea) keeps focus when the re-arm fires", () => {
    const { ref } = scanTarget();
    const note = mount<HTMLTextAreaElement>("<textarea></textarea>");
    scheduleScannerRefocus(ref, 50);
    note.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(note);
  });

  it.each([
    ["input[type=text]", '<input type="text" />'],
    ["a select", "<select><option>a</option></select>"],
  ])("U2/U4: a focused %s keeps focus", (_label, html) => {
    const { ref } = scanTarget();
    const field = mount<HTMLElement>(html);
    scheduleScannerRefocus(ref, 50);
    field.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(field);
  });

  it("U3: a focused contenteditable keeps focus", () => {
    const { ref } = scanTarget();
    const editor = mount<HTMLElement>('<div contenteditable="true" tabindex="0"></div>');
    scheduleScannerRefocus(ref, 50);
    editor.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(editor);
  });

  it("U5: a focused checkbox does not block the re-arm", () => {
    const { input, ref } = scanTarget();
    const box = mount<HTMLInputElement>('<input type="checkbox" />');
    scheduleScannerRefocus(ref, 50);
    box.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
  });

  it("U6: a focused BUTTON does not block the re-arm (scanning never dies after a mouse add)", () => {
    const { input, ref } = scanTarget();
    const button = mount<HTMLButtonElement>("<button>Add</button>");
    scheduleScannerRefocus(ref, 50);
    button.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
  });

  it("U7: with nothing focused the target is focused", () => {
    const { input, ref } = scanTarget();
    scheduleScannerRefocus(ref, 50);
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
  });

  it("does nothing before the delay elapses (the rule is evaluated at FIRE time)", () => {
    const { ref } = scanTarget();
    scheduleScannerRefocus(ref, 50);
    jest.advanceTimersByTime(49);
    expect(document.activeElement).toBe(document.body);
  });

  it("evaluates at fire time, not schedule time: a note focused AFTER scheduling still wins", () => {
    const { ref } = scanTarget();
    scheduleScannerRefocus(ref, 50); // body focused at schedule time — would re-arm if checked now
    const note = mount<HTMLTextAreaElement>("<textarea></textarea>");
    jest.advanceTimersByTime(20);
    note.focus();
    jest.advanceTimersByTime(30);
    expect(document.activeElement).toBe(note);
  });

  it("U8: a target that is null or unmounted at fire time is a no-op and never throws", () => {
    const { input, ref } = scanTarget();
    const other = mount<HTMLButtonElement>("<button>x</button>");
    other.focus();
    scheduleScannerRefocus(ref, 50);
    input.remove();
    expect(() => jest.advanceTimersByTime(50)).not.toThrow();
    expect(document.activeElement).toBe(other);

    const nullRef: React.RefObject<HTMLInputElement | null> = { current: null };
    scheduleScannerRefocus(nullRef, 50);
    expect(() => jest.advanceTimersByTime(50)).not.toThrow();
  });

  it("U9: with two delays, each fire is guarded on its own", () => {
    const { input, ref } = scanTarget();
    const note = mount<HTMLTextAreaElement>("<textarea></textarea>");
    scheduleScannerRefocus(ref, [80, 200]);
    jest.advanceTimersByTime(80);
    expect(document.activeElement).toBe(input); // nothing focused at 80 → re-armed
    jest.advanceTimersByTime(20);
    note.focus(); // the operator moves into a note at 100 ms
    jest.advanceTimersByTime(100);
    expect(document.activeElement).toBe(note); // the 200 ms fallback must not steal it back
  });

  it("U10: cancel clears every pending fire", () => {
    const { ref } = scanTarget();
    const cancel = scheduleScannerRefocus(ref, [80, 200]);
    cancel();
    jest.advanceTimersByTime(300);
    expect(document.activeElement).toBe(document.body);
  });

  it("U11: select:true focuses AND selects when allowed, and does neither when a note holds focus", () => {
    const { input, ref } = scanTarget();
    const select = jest.spyOn(input, "select");
    scheduleScannerRefocus(ref, 50, { select: true });
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalledTimes(1);

    select.mockClear();
    const note = mount<HTMLTextAreaElement>("<textarea></textarea>");
    scheduleScannerRefocus(ref, 50, { select: true });
    note.focus();
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(note);
    expect(select).not.toHaveBeenCalled();
  });

  it("U12: focus already ON the target is not 'someone else typing' — select still runs (rescan overwrites the code)", () => {
    // The archived / ambiguous / network-error rescan sites select the code IN the scan input the
    // operator is already in, so the next wedge scan overwrites it instead of appending. The scan
    // input is itself a text-entry control; the helper must exempt its own target.
    const { input, ref } = scanTarget();
    input.focus();
    const select = jest.spyOn(input, "select");
    scheduleScannerRefocus(ref, 50, { select: true });
    jest.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleScannerRefocus yieldFrom (SA-762r: the register's own fields)", () => {
  it("takes focus from a listed text-entry field, and still protects an unlisted one", () => {
    const { input, ref } = scanTarget();
    const own = mount<HTMLInputElement>('<input type="text" />');
    const other = mount<HTMLInputElement>('<input type="text" />');
    own.focus();
    scheduleScannerRefocus(ref, 0, { yieldFrom: [{ current: own }] });
    jest.advanceTimersByTime(1);
    expect(document.activeElement).toBe(input);
    other.focus();
    scheduleScannerRefocus(ref, 0, { yieldFrom: [{ current: own }] });
    jest.advanceTimersByTime(1);
    expect(document.activeElement).toBe(other);
  });
});
