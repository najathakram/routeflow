import {
  COUNTER_DEFAULT_REGISTER,
  QUICK_KEYS_DEFAULT_CAP,
  QUICK_KEYS_DEFAULT_WINDOW_DAYS,
  defaultQuickKeys,
  parseQuickKeysSettings,
  resolveRegister,
} from "./quick-keys-settings";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("parseQuickKeysSettings", () => {
  it("fills the defaults when nothing is stored", () => {
    for (const raw of [null, undefined, ""]) {
      expect(parseQuickKeysSettings(raw)).toEqual({
        counter: {
          default: { pinned: [], hidden: [] },
          windowDays: QUICK_KEYS_DEFAULT_WINDOW_DAYS,
          cap: QUICK_KEYS_DEFAULT_CAP,
        },
      });
    }
    expect(defaultQuickKeys().counter.cap).toBe(12);
    expect(defaultQuickKeys().counter.windowDays).toBe(30);
  });

  it("never throws on a corrupt stored value: it falls back to the defaults", () => {
    for (const raw of ["{not json", "[]", "null", '"x"', "12", '{"counter":5}', '{"counter":{}}']) {
      expect(() => parseQuickKeysSettings(raw)).not.toThrow();
      expect(parseQuickKeysSettings(raw)).toEqual(defaultQuickKeys());
    }
    // a default register whose lists are not string arrays is corrupt as a whole
    expect(
      parseQuickKeysSettings(JSON.stringify({ counter: { default: { pinned: [1], hidden: [] } } })),
    ).toEqual(defaultQuickKeys());
  });

  it("reads a stored value and fills only the missing numbers", () => {
    const raw = JSON.stringify({ counter: { default: { pinned: [A, B], hidden: [C] }, cap: 8 } });
    expect(parseQuickKeysSettings(raw)).toEqual({
      counter: {
        default: { pinned: [A, B], hidden: [C] },
        windowDays: 30,
        cap: 8,
      },
    });
  });

  it("falls back per number when windowDays or cap is out of range", () => {
    const raw = JSON.stringify({
      counter: { default: { pinned: [], hidden: [] }, cap: 99, windowDays: 0 },
    });
    expect(parseQuickKeysSettings(raw).counter).toMatchObject({ cap: 12, windowDays: 30 });
  });

  it("keeps well-formed extra registers and drops malformed ones", () => {
    const raw = JSON.stringify({
      counter: {
        default: { pinned: [], hidden: [] },
        registers: { front: { pinned: [A], hidden: [] }, bad: { pinned: "x" } },
      },
    });
    expect(parseQuickKeysSettings(raw).counter.registers).toEqual({
      front: { pinned: [A], hidden: [] },
    });
  });
});

describe("resolveRegister", () => {
  const settings = parseQuickKeysSettings(
    JSON.stringify({
      counter: {
        default: { pinned: [A], hidden: [] },
        registers: { front: { pinned: [B], hidden: [C] } },
      },
    }),
  );

  it("a missing register is the default register", () => {
    expect(resolveRegister(settings, undefined)).toEqual({
      register: COUNTER_DEFAULT_REGISTER,
      pinned: [A],
      hidden: [],
      windowDays: 30,
      cap: 12,
    });
  });

  it("main is the default register", () => {
    expect(resolveRegister(settings, "main").pinned).toEqual([A]);
  });

  it("an unknown register is answered as the default (and named main)", () => {
    for (const key of ["nope", "", "__proto__", "constructor", "toString", " front "]) {
      const r = resolveRegister(settings, key);
      expect(r.register).toBe("main");
      expect(r.pinned).toEqual([A]);
    }
  });

  it("a stored extra register is answered as itself", () => {
    expect(resolveRegister(settings, "front")).toMatchObject({
      register: "front",
      pinned: [B],
      hidden: [C],
    });
  });
});
