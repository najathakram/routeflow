import { buildQuickKeysPatch } from "./counter-quick-keys";

describe("buildQuickKeysPatch", () => {
  it("writes registers.main and default, and keeps the window, cap and other registers", () => {
    const other = { pinned: ["p-x"], hidden: [] };
    const body = buildQuickKeysPatch(
      {
        counter: {
          default: { pinned: [], hidden: [] },
          windowDays: 7,
          cap: 6,
          registers: { back: other },
        },
      },
      ["p-a"],
      ["p-b"],
    );
    const list = { pinned: ["p-a"], hidden: ["p-b"] };
    expect(body).toEqual({
      quickKeys: {
        counter: { windowDays: 7, cap: 6, default: list, registers: { back: other, main: list } },
      },
    });
  });

  it("with nothing saved yet sends only the lists", () => {
    const list = { pinned: ["p-a"], hidden: [] };
    expect(buildQuickKeysPatch(undefined, ["p-a"], [])).toEqual({
      quickKeys: { counter: { default: list, registers: { main: list } } },
    });
  });
});
