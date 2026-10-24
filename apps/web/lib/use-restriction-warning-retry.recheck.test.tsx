import * as React from "react";
import { act, render } from "@testing-library/react";

/**
 * Row 672 (SA-924 SHOULD): "Check the sale again" (the dialog's `onRecheck`, after a missing state was added) re-runs the
 * flow's own save as a FRESH attempt: no ack, no old hash (so the next warning is never "the list changed"), and the
 * dialog closes. The dialog is stubbed to its props: this pins the hook (the remedy UI is RestrictionRemedyActions.test).
 */
const dialogProps: { current?: any } = {};
jest.mock("@/components/RestrictionWarningDialog", () => ({
  RestrictionWarningDialog: (props: unknown) => {
    dialogProps.current = props;
    return null;
  },
}));
// eslint-disable-next-line import/first
import { useRestrictionWarningRetry } from "./use-restriction-warning-retry";

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
  let rw!: ReturnType<typeof useRestrictionWarningRetry>;
  const submit = () => {
    const payload = rw.attach({ a: 1 });
    sent.push(payload);
    const outcome = script[sent.length - 1];
    if (outcome !== "ok") rw.handle(outcome, submit);
  };
  function Probe() {
    rw = useRestrictionWarningRetry();
    return rw.dialog;
  }
  render(<Probe />);
  return { sent, submit: () => act(() => submit()) };
}

describe("web useRestrictionWarningRetry: onRecheck", () => {
  it("re-sends the same payload with no ack and closes the dialog", () => {
    const h = mount([warning("h1"), "ok"]);
    h.submit();
    expect(dialogProps.current.view).toMatchObject({ kind: "warning" });
    act(() => dialogProps.current.onRecheck());
    expect(h.sent).toEqual([{ a: 1 }, { a: 1 }]);
    expect(dialogProps.current.view).toBeNull();
  });

  it("forgets the acknowledged hash: a warning after the recheck is a first warning, not 'the list changed'", () => {
    const h = mount([warning("h1"), warning("h2"), warning("h3")]);
    h.submit();
    act(() => dialogProps.current.onConfirm({ restrictionOverrides: [], warningHash: "h1" }, "ok"));
    expect(dialogProps.current.listChanged).toBe(true); // h2 answered our h1 re-send
    act(() => dialogProps.current.onRecheck());
    expect(h.sent[2]).toEqual({ a: 1 }); // fresh: no ack rides the recheck
    expect(dialogProps.current.listChanged).toBe(false);
    expect(dialogProps.current.initialReason).toBe("");
  });
});
