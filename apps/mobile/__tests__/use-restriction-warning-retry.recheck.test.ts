import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Row 672 (SA-924 SHOULD): "Check the sale again" (the modal's `onRecheck`, after a missing state was added) re-runs the
 * flow's own save as a FRESH attempt: no ack, no old hash (so the next warning is never "the list changed"), the modal
 * closes, and the flow's "closed without selling" callback does not run. The modal is stubbed to its props: this pins
 * the hook, not the RN view.
 */
const modalProps: { current?: any } = {};
jest.mock("../components/RestrictionWarningModal", () => ({
  RestrictionWarningModal: (props: unknown) => {
    modalProps.current = props;
    return null;
  },
}));
// eslint-disable-next-line import/first
import { useRestrictionWarningRetry } from "../lib/use-restriction-warning-retry";

const warning = (hash: string) => ({
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "m",
      warningHash: hash,
      lines: [
        {
          lineKey: "n:0",
          productId: "p1",
          displayName: "Acme Gummies",
          outcome: "INDETERMINATE",
          rules: [],
          remedy: "ADD_CUSTOMER_STATE",
          customerId: "c1",
        },
      ],
    },
  },
});

function mount(script: unknown[]) {
  const sent: unknown[] = [];
  const onDismiss = jest.fn();
  let rw!: ReturnType<typeof useRestrictionWarningRetry>;
  const submit = () => {
    const payload = rw.attach({ a: 1 });
    sent.push(payload);
    const outcome = script[sent.length - 1];
    if (outcome !== "ok") rw.handle(outcome, submit, onDismiss);
  };
  function Probe() {
    rw = useRestrictionWarningRetry();
    return rw.modal;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  return { sent, onDismiss, submit: () => act(() => submit()) };
}

describe("mobile useRestrictionWarningRetry: onRecheck", () => {
  it("re-sends the same payload with no ack, closes the modal and never runs onDismiss", () => {
    const h = mount([warning("h1"), "ok"]);
    h.submit();
    expect(modalProps.current.view).toMatchObject({ kind: "warning" });
    act(() => modalProps.current.onRecheck());
    expect(h.sent).toEqual([{ a: 1 }, { a: 1 }]);
    expect(modalProps.current.view).toBeNull();
    expect(h.onDismiss).not.toHaveBeenCalled();
  });

  it("forgets the acknowledged hash: a warning after the recheck is a first warning, not 'the list changed'", () => {
    const h = mount([warning("h1"), warning("h2"), warning("h3")]);
    h.submit();
    act(() => modalProps.current.onConfirm({ restrictionOverrides: [], warningHash: "h1" }, "ok"));
    expect(modalProps.current.listChanged).toBe(true); // h2 answered our h1 re-send
    act(() => modalProps.current.onRecheck());
    expect(h.sent[2]).toEqual({ a: 1 }); // fresh: no ack rides the recheck
    expect(modalProps.current.listChanged).toBe(false);
    expect(modalProps.current.initialReason).toBe("");
  });
});
