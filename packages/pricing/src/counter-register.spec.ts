import { COUNTER_DEFAULT_REGISTER, REGISTER_KEY_PATTERN } from "./counter-register";

describe("counter register (the one source for every register-keyed counter feature)", () => {
  it("the default register is main", () => {
    expect(COUNTER_DEFAULT_REGISTER).toBe("main");
    expect(REGISTER_KEY_PATTERN.test(COUNTER_DEFAULT_REGISTER)).toBe(true);
  });

  it("a register key is a 1..64 character slug of letters, digits, underscore and dash", () => {
    for (const ok of ["main", "front-1", "Till_2", "a", "x".repeat(64)]) {
      expect(REGISTER_KEY_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["", "x".repeat(65), "a b", "a/b", "a.b", "__proto__ ", "é", "a\nb"]) {
      expect(REGISTER_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});
