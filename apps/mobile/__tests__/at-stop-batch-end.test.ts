import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;
import {
  AT_STOP_RESTRICTED_SENT_COPY,
  AT_STOP_RESTRICTED_SENT_TITLE,
  decideAtStopBatchEnd,
  type AtStopBatchEnd,
} from "../lib/at-stop-cr-outcome";
import { useAtStopBatchEnd } from "../lib/use-at-stop-batch-end";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Row 510 (SA final pass): after the driver taps OK on the restricted-CR block there was NO confirmation. Root cause: the
 * OK handler resumes the batch with `setSaving(true)` and, with no entry left, finishes in the same tick with
 * `setSaving(false)`. React batches the two, `saving` is unchanged, and the completion effect (deps `[saving, added]`)
 * never re-runs, so neither the toast nor the navigation happened. The completion now has its own signal.
 */
describe("decideAtStopBatchEnd", () => {
  it("a plain finish says 'Order updated' and goes back", () => {
    expect(decideAtStopBatchEnd({ added: [], handedToOffice: false })).toEqual({
      kind: "done",
      message: "Order updated",
    });
  });

  it("a finish with an entry handed to the office is a confirmation that stays until the driver taps Done", () => {
    expect(decideAtStopBatchEnd({ added: [], handedToOffice: true })).toEqual({
      kind: "sent-to-office",
      title: AT_STOP_RESTRICTED_SENT_TITLE,
      body: AT_STOP_RESTRICTED_SENT_COPY,
    });
    expect(AT_STOP_RESTRICTED_SENT_TITLE).toBe("Sent to the office");
    expect(AT_STOP_RESTRICTED_SENT_COPY).toBe(
      "Order updated. The office will review the restricted item.",
    );
  });

  it("units a concurrent re-scan left behind are never discarded: the leftover message wins, even after a hand-off", () => {
    const end = decideAtStopBatchEnd({ added: [{}, {}], handedToOffice: true });
    expect(end).toEqual({ kind: "leftover", message: "2 items still to send — tap Save again." });
  });
});

describe("useAtStopBatchEnd (the real hook, driven by react-test-renderer)", () => {
  let api: {
    setSaving: (v: boolean) => void;
    setAdded: (v: unknown[]) => void;
    markEnded: () => void;
  };
  const onEnd = jest.fn<void, [AtStopBatchEnd]>();
  let handed = false;

  function Harness() {
    const [saving, setSaving] = React.useState(false);
    const [added, setAdded] = React.useState<unknown[]>([]);
    const { markEnded } = useAtStopBatchEnd({
      saving,
      added,
      handedToOffice: () => handed,
      onEnd,
    });
    api = { setSaving, setAdded, markEnded };
    return null;
  }
  const mount = () => {
    act(() => {
      TestRenderer.create(React.createElement(Harness));
    });
  };
  beforeEach(() => {
    onEnd.mockClear();
    handed = false;
    jest.spyOn(console, "error").mockImplementation(() => undefined); // react-test-renderer's deprecation notice
  });
  afterEach(() => jest.restoreAllMocks());

  it("fires when saving goes true -> false in ONE batch (the resume-after-OK path with nothing left to send)", () => {
    handed = true;
    mount();
    act(() => {
      api.setSaving(true);
      api.markEnded();
      api.setSaving(false);
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][0].kind).toBe("sent-to-office");
  });

  it("the old [saving, added] effect does NOT fire in that case (the diagnosis)", () => {
    const naive = jest.fn();
    function NaiveHarness() {
      const [saving, setSaving] = React.useState(false);
      const [added] = React.useState<unknown[]>([]);
      const pending = React.useRef(false);
      React.useEffect(() => {
        if (!pending.current || saving) return;
        pending.current = false;
        naive();
      }, [saving, added]);
      api = {
        setSaving,
        setAdded: () => undefined,
        markEnded: () => {
          pending.current = true;
        },
      };
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(NaiveHarness));
    });
    act(() => {
      api.setSaving(true);
      api.markEnded();
      api.setSaving(false);
    });
    expect(naive).not.toHaveBeenCalled();
  });

  it("waits for saving to settle, then fires exactly once", () => {
    mount();
    act(() => {
      api.setSaving(true);
      api.markEnded();
    });
    expect(onEnd).not.toHaveBeenCalled();
    act(() => api.setSaving(false));
    expect(onEnd).toHaveBeenCalledTimes(1);
    act(() => api.setAdded([])); // an unrelated re-render does not fire it again
    act(() => api.setSaving(false));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("reads the settled draft list: a unit left behind is the leftover message", () => {
    mount();
    act(() => api.setAdded([{}]));
    act(() => {
      api.markEnded();
    });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0][0]).toEqual({
      kind: "leftover",
      message: "1 item still to send — tap Save again.",
    });
  });

  it("each batch end fires once: a second batch fires again", () => {
    mount();
    act(() => api.markEnded());
    act(() => api.markEnded());
    expect(onEnd).toHaveBeenCalledTimes(2);
  });
});
