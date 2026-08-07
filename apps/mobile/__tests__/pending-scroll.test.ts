/**
 * The scan-to-row scroll must survive the render where the target row does not
 * exist yet (product still refetching, list swapped by clearing the search) and
 * must fire exactly once when it appears.
 */
import {
  NO_PENDING_SCROLL,
  requestScroll,
  stepPendingScroll,
  type PendingScrollState,
} from "../lib/pending-scroll";

describe("pending scroll", () => {
  it("emits the index of a target that is already visible and clears", () => {
    const state = requestScroll(NO_PENDING_SCROLL, "b");
    const out = stepPendingScroll(state, ["a", "b", "c"]);
    expect(out.scrollIndex).toBe(1);
    expect(out.state.targetId).toBeNull();
  });

  it("stays pending and emits null while the target is absent", () => {
    let state: PendingScrollState = requestScroll(NO_PENDING_SCROLL, "z");
    let out = stepPendingScroll(state, ["a", "b"]);
    expect(out.scrollIndex).toBeNull();
    expect(out.state.targetId).toBe("z");

    // Refetch lands: the row exists now and the queued scroll resolves.
    state = out.state;
    out = stepPendingScroll(state, ["z", "a", "b"]);
    expect(out.scrollIndex).toBe(0);
    expect(out.state.targetId).toBeNull();
  });

  it("lets a new request replace a pending one", () => {
    const first = requestScroll(NO_PENDING_SCROLL, "y");
    const second = requestScroll(first, "z");
    expect(second.targetId).toBe("z");
    expect(stepPendingScroll(second, ["y", "z"]).scrollIndex).toBe(1);
  });

  it("keeps the same state reference when the pending id is re-requested", () => {
    const pending = requestScroll(NO_PENDING_SCROLL, "y");
    expect(requestScroll(pending, "y")).toBe(pending);
  });

  it("never re-emits a completed target", () => {
    const state = requestScroll(NO_PENDING_SCROLL, "b");
    const done = stepPendingScroll(state, ["a", "b"]);
    expect(done.scrollIndex).toBe(1);
    expect(stepPendingScroll(done.state, ["a", "b"]).scrollIndex).toBeNull();
    expect(stepPendingScroll(done.state, ["b", "a"]).scrollIndex).toBeNull();
  });

  it("re-emits when the same id is requested again after completing", () => {
    const done = stepPendingScroll(requestScroll(NO_PENDING_SCROLL, "b"), ["a", "b"]);
    const again = requestScroll(done.state, "b");
    expect(stepPendingScroll(again, ["a", "b"]).scrollIndex).toBe(1);
  });

  it("emits nothing when nothing is pending", () => {
    const out = stepPendingScroll(NO_PENDING_SCROLL, ["a"]);
    expect(out.scrollIndex).toBeNull();
    expect(out.state).toBe(NO_PENDING_SCROLL);
  });
});
