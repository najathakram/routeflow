import { priceWriteReplay, type ReplayCheck } from "./product-price-replay";

/**
 * SA-845 (W-662, B1247): a price write that would be a 409 is the client's OWN earlier write, replayed after a lost
 * reply, only when the stored audit row proves it exactly. Every miss falls back to today's 409: a false "yours"
 * would hide someone else's change, a false conflict only costs a reload.
 */
const saved = {
  request: {
    patches: [{ ref: "pack", tier: 3, to: 10.5 }],
    keeps: [],
    customerMoves: [{ customerId: "c1", ref: "pack", tier: 1, from: 12, to: 13 }],
  },
  undo: { patches: [{ ref: "pack", tier: 3, to: null }], customerMoves: [] },
  revisionBefore: 3,
  revisionAfter: 4,
  actor: "user-1",
  priceStateBefore: "state-before",
  priceStateAfter: "state-after",
};

const check = (over: Partial<ReplayCheck> = {}): ReplayCheck => ({
  stored: saved,
  actorId: "user-1",
  expectedRevision: 3,
  expectedPriceState: "state-before",
  request: {
    // Same request, keys in another order (jsonb does not keep key order).
    customerMoves: [{ to: 13, from: 12, tier: 1, ref: "pack", customerId: "c1" }],
    patches: [{ tier: 3, ref: "pack", to: 10.5 }],
    keeps: [],
  },
  live: { revision: 4, priceState: "state-after" },
  ...over,
});

describe("priceWriteReplay (SA-845)", () => {
  it("matches the same actor's identical write with nothing written since", () => {
    expect(priceWriteReplay(check())).toBe(true);
  });

  it("R3: another actor's identical body is a conflict", () => {
    expect(priceWriteReplay(check({ actorId: "user-2" }))).toBe(false);
  });

  it("a null actor never replays (two unknown actors are not provably the same)", () => {
    expect(priceWriteReplay(check({ actorId: null, stored: { ...saved, actor: null } }))).toBe(
      false,
    );
  });

  it("R4: a second save landed after it (live revision moved on)", () => {
    expect(priceWriteReplay(check({ live: { revision: 5, priceState: "state-later" } }))).toBe(
      false,
    );
  });

  it("R5: a legacy writer changed the prices after it without a revision bump", () => {
    expect(priceWriteReplay(check({ live: { revision: 4, priceState: "state-legacy" } }))).toBe(
      false,
    );
  });

  it("R6: a body differing in one patch `to` is a conflict", () => {
    const request = {
      ...(check().request as Record<string, unknown>),
      patches: [{ ref: "pack", tier: 3, to: 10.51 }],
    };
    expect(priceWriteReplay(check({ request }))).toBe(false);
  });

  it("R6b: an extra or missing request key is a conflict (orderUnit sent this time)", () => {
    const request = { ...(check().request as Record<string, unknown>), orderUnit: "Case" };
    expect(priceWriteReplay(check({ request }))).toBe(false);
  });

  it("R7: an audit row written before this change (no priceStateAfter) never replays", () => {
    const { priceStateAfter: _a, priceStateBefore: _b, ...legacy } = saved;
    expect(priceWriteReplay(check({ stored: legacy }))).toBe(false);
  });

  it("the client's expected revision must be the write's revisionBefore", () => {
    expect(priceWriteReplay(check({ expectedRevision: 2 }))).toBe(false);
  });

  it("the client's expected price state must be the write's priceStateBefore", () => {
    expect(priceWriteReplay(check({ expectedPriceState: "state-other" }))).toBe(false);
  });

  it("an undo replay compares the skip list and has no priceStateBefore to check", () => {
    const undone = {
      undoes: "a1",
      skipped: [],
      request: { skip: ["c1:pack:1"] },
      revisionBefore: 4,
      revisionAfter: 5,
      actor: "user-1",
      priceStateAfter: "state-undone",
    };
    const base: ReplayCheck = {
      stored: undone,
      actorId: "user-1",
      expectedRevision: 4,
      request: { skip: ["c1:pack:1"] },
      live: { revision: 5, priceState: "state-undone" },
    };
    expect(priceWriteReplay(base)).toBe(true);
    expect(priceWriteReplay({ ...base, request: { skip: [] } })).toBe(false);
    expect(priceWriteReplay({ ...base, live: { revision: 6, priceState: "x" } })).toBe(false);
  });

  it("a missing or malformed stored meta is a miss, never a throw", () => {
    expect(priceWriteReplay(check({ stored: null }))).toBe(false);
    expect(priceWriteReplay(check({ stored: "nope" }))).toBe(false);
    expect(priceWriteReplay(check({ stored: { ...saved, revisionAfter: "4" } }))).toBe(false);
  });
});
