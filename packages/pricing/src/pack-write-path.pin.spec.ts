import { PACK_WRITE_PATH_COMPLETE } from "./pack-write-path";

describe("PACK_WRITE_PATH_COMPLETE pin (SA-1041 A-1)", () => {
  it("stays false: only the pack row moves the five columns, so the pack row is base", () => {
    // A flip must be re-ruled by the SA. Expected post-flip rule: a save whose materialized
    // pack differs from the stored columns is base.
    expect(PACK_WRITE_PATH_COMPLETE).toBe(false);
  });
});
