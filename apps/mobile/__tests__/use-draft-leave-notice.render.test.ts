import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

const mockToast = jest.fn();
jest.mock("../lib/toast", () => ({ showToast: (t: string) => mockToast(t) }));

import { useDraftLeaveNotice } from "../components/new-order/use-draft-leave-notice";
import { DRAFT_SAVED_ON_LEAVE } from "../lib/draft-leave-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Row 699, moved into the hook (size ratchet): the hook registers the screen's `beforeRemove` listener itself. Leaving flushes;
 * "Draft saved" shows only after the flush succeeded; a failed flush reports its error and shows no notice; a submit in flight
 * says nothing.
 */
function mount(flush: () => Promise<void>, submitting = false) {
  let listener: (() => void) | undefined;
  const navigation = { addListener: (_: string, cb: () => void) => ((listener = cb), () => {}) };
  const onSaved = jest.fn();
  const onError = jest.fn();
  function Probe() {
    useDraftLeaveNotice(() => "draft-1", true, {
      navigation,
      flush,
      onSaved,
      onError,
      isSubmitting: () => submitting,
    });
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  return { leave: () => listener!(), onSaved, onError };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("useDraftLeaveNotice registers the leave listener (Row 699)", () => {
  beforeEach(() => mockToast.mockClear());

  it("a successful flush: onSaved, then the notice", async () => {
    const h = mount(() => Promise.resolve());
    h.leave();
    await tick();
    expect(h.onSaved).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(DRAFT_SAVED_ON_LEAVE);
  });

  it("a failed flush: onError, and no notice", async () => {
    const err = new Error("offline");
    const h = mount(() => Promise.reject(err));
    h.leave();
    await tick();
    expect(h.onError).toHaveBeenCalledWith(err);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("a submit in flight at leave time: no notice", async () => {
    const h = mount(() => Promise.resolve(), true);
    h.leave();
    await tick();
    expect(mockToast).not.toHaveBeenCalled();
  });
});
