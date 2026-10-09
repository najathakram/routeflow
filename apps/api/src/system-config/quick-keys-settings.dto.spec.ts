import { BadRequestException } from "@nestjs/common";
import { validateQuickKeysInput } from "./dto/quick-keys-settings.dto";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i));
const body = (over: Record<string, unknown> = {}, reg: Record<string, unknown> = {}) => ({
  counter: { default: { pinned: [], hidden: [], ...reg }, ...over },
});

function reject(raw: unknown) {
  try {
    validateQuickKeysInput(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error("expected a 400");
}

describe("validateQuickKeysInput", () => {
  it("accepts the contract shape and fills the defaults", () => {
    const out = validateQuickKeysInput(body({}, { pinned: [id(1), id(2)], hidden: [id(3)] }));
    expect(out).toEqual({
      counter: {
        default: { pinned: [id(1), id(2)], hidden: [id(3)] },
        windowDays: 30,
        cap: 12,
      },
    });
  });

  it("12 pins pass under the default cap; the 13th is a 400", () => {
    expect(
      validateQuickKeysInput(body({}, { pinned: ids(1, 12) })).counter.default.pinned,
    ).toHaveLength(12);
    expect(reject(body({}, { pinned: ids(1, 13) }))).toBe("quickKeys pinned exceeds the cap");
  });

  it("a raised cap admits more pins, up to the hard maximum of 24", () => {
    expect(validateQuickKeysInput(body({ cap: 24 }, { pinned: ids(1, 24) })).counter.cap).toBe(24);
    expect(reject(body({ cap: 25 }, { pinned: [] }))).toBe("quickKeys is invalid");
    expect(reject(body({ cap: 24 }, { pinned: ids(1, 25) }))).toBeDefined();
  });

  it("a lowered cap bounds the pins", () => {
    expect(reject(body({ cap: 3 }, { pinned: ids(1, 4) }))).toBe(
      "quickKeys pinned exceeds the cap",
    );
  });

  it("rejects a non-UUID id, a duplicate pin and a duplicate hide", () => {
    expect(reject(body({}, { pinned: ["not-a-uuid"] }))).toBe("quickKeys is invalid");
    expect(reject(body({}, { pinned: [id(1), id(1)] }))).toBe("quickKeys is invalid");
    expect(reject(body({}, { hidden: [id(1), id(1)] }))).toBe("quickKeys is invalid");
  });

  it("hidden holds at most 100", () => {
    expect(
      validateQuickKeysInput(body({}, { hidden: ids(1, 100) })).counter.default.hidden,
    ).toHaveLength(100);
    expect(reject(body({}, { hidden: ids(1, 101) }))).toBe("quickKeys is invalid");
  });

  it("windowDays is an integer 1..365; cap an integer 1..24", () => {
    for (const windowDays of [0, 366, 1.5, "30", null]) {
      expect(reject(body({ windowDays }))).toBe("quickKeys is invalid");
    }
    for (const cap of [0, 25, 2.5, "12", null]) {
      expect(reject(body({ cap }))).toBe("quickKeys is invalid");
    }
    expect(validateQuickKeysInput(body({ windowDays: 365, cap: 1 })).counter).toMatchObject({
      windowDays: 365,
      cap: 1,
    });
  });

  it("rejects unknown keys at every level", () => {
    expect(reject({ ...body(), extra: 1 })).toBe("quickKeys is invalid");
    expect(reject(body({ extra: 1 }))).toBe("quickKeys is invalid");
    expect(reject(body({}, { extra: [] }))).toBe("quickKeys is invalid");
    expect(reject(body({ registers: { front: { pinned: [], hidden: [], extra: 1 } } }))).toBe(
      "quickKeys is invalid",
    );
  });

  it("rejects anything that is not the object shape", () => {
    for (const raw of [null, undefined, 5, "x", [], {}, { counter: null }, { counter: {} }]) {
      expect(reject(raw)).toBe("quickKeys is invalid");
    }
  });

  it("an array where an object belongs is a 400, never a 500 (counter, default, a register)", () => {
    const ok = { pinned: [], hidden: [] };
    for (const raw of [
      { counter: [] },
      { counter: [{ default: ok }] },
      { counter: { default: [] } },
      { counter: { default: [ok] } },
      { counter: { default: ok, registers: [ok] } },
      { counter: { default: ok, registers: { main: [ok] } } },
    ]) {
      expect(reject(raw)).toBe("quickKeys is invalid");
    }
  });

  it("registers.main is accepted and stored as the default register", () => {
    const out = validateQuickKeysInput(
      body({ registers: { main: { pinned: [id(5)], hidden: [id(6)] } } }, { pinned: [id(1)] }),
    );
    expect(out.counter.default).toEqual({ pinned: [id(5)], hidden: [id(6)] });
    expect(out.counter.registers).toBeUndefined();
  });

  it("other registers are validated the same way and kept", () => {
    const out = validateQuickKeysInput(
      body({ registers: { front: { pinned: [id(5)], hidden: [] } } }),
    );
    expect(out.counter.registers).toEqual({ front: { pinned: [id(5)], hidden: [] } });
    expect(reject(body({ registers: { front: { pinned: ids(1, 13), hidden: [] } } }))).toBe(
      "quickKeys pinned exceeds the cap",
    );
    expect(reject(body({ registers: { front: { pinned: ["x"], hidden: [] } } }))).toBe(
      "quickKeys is invalid",
    );
    expect(reject(body({ registers: { front: 5 } }))).toBe("quickKeys is invalid");
  });

  it("refuses unsafe or oversized register keys", () => {
    for (const key of ["__proto__", "constructor", "prototype", "has space", "", "x".repeat(65)]) {
      const registers = Object.fromEntries([[key, { pinned: [], hidden: [] }]]);
      expect(reject(body({ registers }))).toBe("quickKeys is invalid");
    }
  });

  it("never echoes the input in the message", () => {
    const secret = "SECRET-VALUE-XYZ";
    expect(reject(body({}, { pinned: [secret] }))).not.toContain(secret);
  });
});
