import { countFieldErrors, fixFieldsTitle, onInvalidFocus } from "./form-errors";

afterEach(() => {
  document.body.innerHTML = "";
  jest.useRealTimers();
});

describe("countFieldErrors", () => {
  it("counts leaf errors, nested and in arrays", () => {
    expect(
      countFieldErrors({
        a: { type: "required", message: "x" },
        b: { c: { type: "min" }, d: { type: "max", message: "y" } },
        e: [{ f: { type: "required" } }, undefined],
      }),
    ).toBe(4);
  });
  it("is 0 for none", () => {
    expect(countFieldErrors({})).toBe(0);
    expect(countFieldErrors(undefined)).toBe(0);
  });
});

describe("fixFieldsTitle", () => {
  it("is singular for one and plural otherwise", () => {
    expect(fixFieldsTitle(1)).toBe("Fix 1 field");
    expect(fixFieldsTitle(2)).toBe("Fix 2 fields");
  });
});

describe("onInvalidFocus", () => {
  it("toasts the count and scrolls to and focuses the first aria-invalid field", () => {
    jest.useFakeTimers();
    document.body.innerHTML = `
      <input id="ok" />
      <input id="first" aria-invalid="true" />
      <input id="second" aria-invalid="true" />`;
    const first = document.getElementById("first") as HTMLInputElement;
    first.scrollIntoView = jest.fn();
    const toast = jest.fn();
    onInvalidFocus({ a: { type: "required" }, b: { type: "required" } }, toast);
    expect(toast).toHaveBeenCalledWith({ title: "Fix 2 fields", variant: "error" });
    jest.runAllTimers();
    expect(first.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it("does nothing when there are no errors", () => {
    jest.useFakeTimers();
    document.body.innerHTML = `<input id="x" aria-invalid="true" />`;
    const toast = jest.fn();
    onInvalidFocus({}, toast);
    jest.runAllTimers();
    expect(toast).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});
