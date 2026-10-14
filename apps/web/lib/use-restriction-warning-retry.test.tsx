import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  API_ERROR_CODES,
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  type RestrictionWarningError,
} from "@routeflow/types";
import { useRestrictionWarningRetry } from "./use-restriction-warning-retry";

const mkWarning = (hash: string, names: string[]): RestrictionWarningError => ({
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "m",
  warningHash: hash,
  lines: names.map((n, i) => ({
    lineKey: `n:${i}`,
    productId: `p${i}`,
    displayName: n,
    outcome: "BLOCK" as const,
    rules: [
      { id: "r", states: ["CA"], legal: true, reasonText: "This product is banned in CA by law." },
    ],
  })),
});
const err409 = (data: unknown) => ({ response: { status: 409, data } });

/** A flow: `submit` sends `attach(base)`; a failing server is scripted per call. */
function Host({ script, base }: { script: unknown[]; base: Record<string, unknown> }) {
  const rw = useRestrictionWarningRetry();
  const sent = (globalThis as any).__sent as unknown[];
  const submit = () => {
    const payload = rw.attach(base);
    sent.push(payload);
    const outcome = script[sent.length - 1];
    if (outcome === "ok") return;
    if (rw.handle(outcome, submit)) return;
    (globalThis as any).__otherError = outcome;
  };
  return (
    <>
      <button onClick={submit}>Save</button>
      {rw.dialog}
    </>
  );
}

beforeEach(() => {
  (globalThis as any).__sent = [];
  (globalThis as any).__otherError = undefined;
});

describe("useRestrictionWarningRetry", () => {
  it("opens the dialog on a 409 RESTRICTION_WARNING and resubmits the SAME payload plus the ack", async () => {
    const user = userEvent.setup();
    render(
      <Host
        script={[err409(mkWarning("h1", ["Acme Gummies"])), "ok"]}
        base={{ customerId: "c1", items: [1] }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Acme Gummies")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    const sent = (globalThis as any).__sent;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ customerId: "c1", items: [1] });
    expect(sent[1]).toEqual({
      customerId: "c1",
      items: [1],
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "h1",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a repeat 409 with a fresh list re-shows the dialog, says the list changed and CLEARS the reason so it is re-confirmed", async () => {
    const user = userEvent.setup();
    render(
      <Host
        script={[
          err409(mkWarning("h1", ["Acme Gummies"])),
          err409(mkWarning("h2", ["Acme Gummies", "Acme Vape"])),
          "ok",
        ]}
        base={{ a: 1 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("status")).toBeNull(); // the first warning has no "changed" notice
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    // second dialog: the new lines, a polite notice, and an EMPTY reason
    expect(screen.getByText("Acme Vape")).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("The list changed; review it again");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Sell anyway" })).toBeDisabled();
    await user.type(screen.getByLabelText(/reason/i), "Reviewed both items");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    const sent = (globalThis as any).__sent;
    expect(sent).toHaveLength(3);
    expect(sent[2].warningHash).toBe("h2");
    expect(sent[2].restrictionOverrides).toEqual([
      { lineKey: "n:0", reason: "Reviewed both items" },
      { lineKey: "n:1", reason: "Reviewed both items" },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the notice is for a repeat only: a fresh attempt after Go back shows none", async () => {
    const user = userEvent.setup();
    render(
      <Host
        script={[
          err409(mkWarning("h1", ["Acme Gummies"])),
          err409(mkWarning("h2", ["Acme Gummies", "Acme Vape"])),
          err409(mkWarning("h3", ["Acme Gummies"])),
        ]}
        base={{ a: 1 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go back" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Go back keeps the flow untouched: no resubmit, no leaked ack, and the reason is dropped", async () => {
    const user = userEvent.setup();
    render(
      <Host
        script={[
          err409(mkWarning("h1", ["Acme Gummies"])),
          err409(mkWarning("h3", ["Acme Gummies"])),
        ]}
        base={{ a: 1 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText(/reason/i), "typed");
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect((globalThis as any).__sent).toHaveLength(1);
    // a brand-new attempt does not inherit the cancelled reason or an ack
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((globalThis as any).__sent[1]).toEqual({ a: 1 });
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");
  });

  it("an ack is single-use: it never rides a later, unrelated send", async () => {
    const user = userEvent.setup();
    render(
      <Host script={[err409(mkWarning("h1", ["Acme Gummies"])), "ok", "ok"]} base={{ a: 1 }} />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(screen.getByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((globalThis as any).__sent[2]).toEqual({ a: 1 });
  });

  it("returns false for any other error so the flow's own handler runs", async () => {
    const user = userEvent.setup();
    const other = { response: { status: 500, data: {} } };
    render(<Host script={[other]} base={{}} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((globalThis as any).__otherError).toBe(other);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the driver hard block with no override and does not resubmit", async () => {
    const user = userEvent.setup();
    const driver = err409({
      code: "SELLING_RESTRICTED",
      message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
      blockedLines: [
        {
          productId: "p1",
          productName: "Acme Gummies",
          ruleId: "r",
          reason: "STATE_BAN",
          state: "CA",
          message: "m",
        },
      ],
    });
    render(<Host script={[driver]} base={{}} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getAllByText("Ask the office to approve this sale").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Sell anyway" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect((globalThis as any).__sent).toHaveLength(1);
  });

  it("an async submit (it awaits before it sends) still carries the ack, exactly once", async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    let first = true;
    function AsyncHost() {
      const rw = useRestrictionWarningRetry();
      const submit = async (): Promise<void> => {
        await Promise.resolve(); // e.g. settling default units before the request leaves
        await Promise.resolve();
        sent.push(rw.attach({ a: 1 }));
        if (first) {
          first = false;
          rw.handle(err409(mkWarning("h1", ["Acme Gummies"])), submit);
        }
      };
      return (
        <>
          <button onClick={() => void submit()}>Save</button>
          {rw.dialog}
        </>
      );
    }
    render(<AsyncHost />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({ a: 1 });
    expect(sent[1]).toEqual({
      a: 1,
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "h1",
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({ a: 1 }); // single use
  });
});
