/**
 * B962: the web toast is `position: fixed; left: 50%; transform: translateX(-50%)`, which sizes it
 * to its content. With `white-space: nowrap` a message wider than the viewport (a long one at 390px)
 * is clipped on BOTH sides. It must wrap inside the viewport instead: a max width of the viewport
 * minus a 16px gutter each side, normal white-space, long words allowed to break, text centred.
 * Short messages keep the pill look (content-sized, still centred).
 */
jest.mock("react-native", () => ({
  Platform: { OS: "web" },
  ToastAndroid: { show: jest.fn(), SHORT: 0, LONG: 1 },
  Alert: { alert: jest.fn() },
}));

import { showToast } from "../lib/toast";

type FakeEl = { textContent: string; style: Record<string, string>; remove: jest.Mock };

describe("showToast on web (B962)", () => {
  let created: FakeEl[];

  beforeEach(() => {
    jest.useFakeTimers();
    created = [];
    (globalThis as { document?: unknown }).document = {
      createElement: jest.fn(() => {
        const el: FakeEl = { textContent: "", style: {}, remove: jest.fn() };
        created.push(el);
        return el;
      }),
      body: { appendChild: jest.fn() },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { document?: unknown }).document;
  });

  it("wraps inside the viewport instead of clipping on both sides", () => {
    showToast("A very long toast message that would be wider than a 390px phone viewport");
    const s = created[0].style;
    expect(s.whiteSpace).toBe("normal");
    expect(s.width).toBe("max-content"); // not the right-half shrink-to-fit width of left: 50%
    expect(s.maxWidth).toBe("calc(100vw - 32px)");
    expect(s.boxSizing).toBe("border-box");
    expect(s.overflowWrap).toBe("anywhere");
    expect(s.textAlign).toBe("center");
  });

  it("stays centred on the viewport and clear of the bottom nav (unchanged)", () => {
    showToast("Saved");
    const s = created[0].style;
    expect(s.position).toBe("fixed");
    expect(s.left).toBe("50%");
    expect(s.transform).toBe("translateX(-50%)");
    expect(s.bottom).toBe("96px");
    expect(created[0].textContent).toBe("Saved");
  });

  it("does nothing without a document (server render)", () => {
    delete (globalThis as { document?: unknown }).document;
    expect(() => showToast("x")).not.toThrow();
    expect(created).toHaveLength(0);
  });
});
