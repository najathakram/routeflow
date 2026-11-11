import {
  changeCountLabel,
  EMPTY_STAGE,
  stagedAction,
  type FeatureStage,
  stageChange,
  unstageChange,
} from "./useFeatureStage";

const on = (key: string) => ({ type: "override" as const, key, action: "GRANT" as const });
const off = (key: string) => ({ type: "override" as const, key, action: "DENY" as const });

describe("useFeatureStage reducers (WP11)", () => {
  it("T-ui1: two off and one on make three staged changes, in the order they were staged", () => {
    let s: FeatureStage = { ...EMPTY_STAGE, baseHash: "h1" };
    s = stageChange(s, off("a"));
    s = stageChange(s, off("b"));
    s = stageChange(s, on("c"));
    expect(s.changes.map((c) => [c.key, c.action])).toEqual([
      ["a", "DENY"],
      ["b", "DENY"],
      ["c", "GRANT"],
    ]);
    expect(changeCountLabel(s.changes.length)).toBe("3 changes");
    expect(changeCountLabel(1)).toBe("1 change");
  });

  it("staging a key again replaces its change and keeps its place; it does not add a second row", () => {
    let s = stageChange(stageChange({ ...EMPTY_STAGE, baseHash: "h1" }, off("a")), on("b"));
    s = stageChange(s, on("a"));
    expect(s.changes.map((c) => [c.key, c.action])).toEqual([
      ["a", "GRANT"],
      ["b", "GRANT"],
    ]);
  });

  it("taking one back leaves the rest and the hash; the last one out forgets the hash (Discard does too)", () => {
    let s = stageChange(stageChange({ ...EMPTY_STAGE, baseHash: "h1" }, off("a")), on("b"));
    s = unstageChange(s, "a");
    expect(s.baseHash).toBe("h1");
    expect(s.changes).toHaveLength(1);
    s = unstageChange(s, "b");
    expect(s).toEqual(EMPTY_STAGE);
    expect(EMPTY_STAGE.baseHash).toBeNull();
  });

  it("stagedAction reads one key's staged action, or null", () => {
    const s = stageChange({ ...EMPTY_STAGE, baseHash: "h1" }, off("a"));
    expect(stagedAction(s, "a")).toBe("DENY");
    expect(stagedAction(s, "zzz")).toBeNull();
  });
});
