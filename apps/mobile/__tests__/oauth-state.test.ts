/**
 * F12-005 — OAuth deep-link session-fixation guard (pure logic).
 * Verifies state generation is unguessable/unique and that the callback only
 * accepts a returned state that matches the one the app stored for this flow.
 */
import { generateOAuthState, isValidReturnedState, OAUTH_STATE_KEY } from "../lib/oauth-state";

describe("generateOAuthState", () => {
  it("produces a 64-char hex string (256 bits) by default", () => {
    const s = generateOAuthState();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a distinct value on every call", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateOAuthState()));
    expect(values.size).toBe(50);
  });

  it("uses the injected random source deterministically (testability)", () => {
    const fixed = (n: number) => new Uint8Array(n).fill(0xab);
    expect(generateOAuthState(fixed)).toBe("ab".repeat(32));
  });
});

describe("isValidReturnedState", () => {
  it("accepts an exact match", () => {
    const state = generateOAuthState();
    expect(isValidReturnedState(state, state)).toBe(true);
  });

  it("rejects a mismatch (attacker-supplied state)", () => {
    expect(isValidReturnedState("stored-abc", "returned-xyz")).toBe(false);
  });

  it("rejects when nothing was stored (unsolicited deep link — no pending flow)", () => {
    expect(isValidReturnedState(null, "anything")).toBe(false);
    expect(isValidReturnedState(undefined, "anything")).toBe(false);
  });

  it("rejects when the callback carries no state", () => {
    expect(isValidReturnedState("stored-abc", undefined)).toBe(false);
    expect(isValidReturnedState("stored-abc", null)).toBe(false);
    expect(isValidReturnedState("stored-abc", "")).toBe(false);
  });

  it("rejects two empties (no false-positive on empty === empty)", () => {
    expect(isValidReturnedState("", "")).toBe(false);
  });
});

describe("OAUTH_STATE_KEY", () => {
  it("is namespaced so it can't collide with token buckets", () => {
    expect(OAUTH_STATE_KEY).toBe("rf:oauth:pendingState");
  });
});
