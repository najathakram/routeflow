import { createFieldScanRun, isScanKey, startsScanRun } from "./scan-run";

const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });

describe("isScanKey (S1)", () => {
  it.each(["a", "A", "4", "-", ".", "?", "@"])("%s is a scan key", (k) => {
    expect(isScanKey(key(k))).toBe(true);
  });
  it("AltGr @ is a scan key", () => {
    const e = key("@", { ctrlKey: true, altKey: true });
    e.getModifierState = (m: string) => m === "AltGraph";
    expect(isScanKey(e)).toBe(true);
  });
  it.each([
    [" ", {}],
    ["Enter", {}],
    ["Shift", {}],
    ["a", { ctrlKey: true }],
    ["4", { altKey: true }],
    ["a", { metaKey: true }],
  ])("%j with %j is not", (k, init) => {
    expect(isScanKey(key(k, init as KeyboardEventInit))).toBe(false);
  });
});

describe("startsScanRun by focus (S2)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });
  const focusOn = (html: string) => {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild as HTMLElement;
    el.focus();
    return el;
  };
  it("a button, the page, a checkbox and a field in a closing dialog start a run", () => {
    expect(startsScanRun(key("c"), focusOn("<button>x</button>"))).toBe(true);
    expect(startsScanRun(key("c"), document.body)).toBe(true);
    expect(startsScanRun(key("c"), focusOn('<input type="checkbox" />'))).toBe(true);
    document.body.innerHTML =
      '<div role="dialog" data-state="closed"><input id="f" type="text" /></div>';
    expect(startsScanRun(key("c"), document.getElementById("f"))).toBe(true);
  });
  it("a text input, textarea, contenteditable, combobox, listbox option and menu item do not", () => {
    expect(startsScanRun(key("c"), focusOn('<input type="text" />'))).toBe(false);
    expect(startsScanRun(key("c"), focusOn("<textarea></textarea>"))).toBe(false);
    expect(
      startsScanRun(key("c"), focusOn('<div contenteditable="true" tabindex="0"></div>')),
    ).toBe(false);
    expect(startsScanRun(key("c"), focusOn('<button role="combobox">x</button>'))).toBe(false);
    document.body.innerHTML =
      '<div role="listbox"><div id="o" role="option" tabindex="0">o</div></div>';
    expect(startsScanRun(key("c"), document.getElementById("o"))).toBe(false);
    document.body.innerHTML = '<div role="menu"><button id="m" role="menuitem">m</button></div>';
    expect(startsScanRun(key("c"), document.getElementById("m"))).toBe(false);
  });
});

describe("createFieldScanRun (S3)", () => {
  let field: HTMLInputElement;
  let btn: HTMLButtonElement;
  let seen: string[];
  beforeEach(() => {
    document.body.innerHTML = '<button id="b">b</button><input id="s" type="search" />';
    btn = document.getElementById("b") as HTMLButtonElement;
    field = document.getElementById("s") as HTMLInputElement;
    seen = [];
    field.addEventListener("keydown", (e) => seen.push(e.key));
    btn.focus();
  });
  const send = (
    run: ReturnType<typeof createFieldScanRun>,
    k: string,
    init: KeyboardEventInit = {},
  ) => {
    const e = key(k, init);
    const handled = run.onKeyDown(e, field);
    return { e, handled };
  };

  it("arms on a scan key, hands it over without stopping it, sends the Enter once, then one more", () => {
    const run = createFieldScanRun();
    const a = send(run, "c");
    expect(a.handled).toBe(true);
    expect(a.e.cancelBubble).toBe(false);
    expect(document.activeElement).toBe(field);
    btn.focus(); // the chip takes focus back after the picker closes
    const e1 = send(run, "Enter");
    expect(e1.handled).toBe(true);
    expect(e1.e.defaultPrevented).toBe(true);
    btn.focus();
    expect(send(run, "Enter").handled).toBe(true); // CR+LF
    btn.focus();
    expect(send(run, "Enter").handled).toBe(false); // a person
    expect(seen).toEqual(["c", "Enter", "Enter"]);
  });
  it("Tab, Escape, arrows and reset() end the run", () => {
    for (const k of ["Tab", "Escape", "ArrowDown"]) {
      const run = createFieldScanRun();
      send(run, "c");
      btn.focus();
      send(run, k);
      expect(send(run, "Enter").handled).toBe(false);
    }
    const run = createFieldScanRun();
    send(run, "c");
    run.reset();
    btn.focus();
    expect(send(run, "Enter").handled).toBe(false);
  });
  it("an Enter with no run passes, and a missing field resets", () => {
    const run = createFieldScanRun();
    expect(send(run, "Enter").handled).toBe(false);
    send(run, "c");
    expect(run.onKeyDown(key("x"), null)).toBe(false);
    btn.focus();
    expect(send(run, "Enter").handled).toBe(false);
  });
  it("Shift alone does not end a run", () => {
    const run = createFieldScanRun();
    send(run, "c");
    btn.focus();
    send(run, "Shift");
    expect(send(run, "Enter").handled).toBe(true);
  });
});
