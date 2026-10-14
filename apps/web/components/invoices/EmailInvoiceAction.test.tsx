import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { EmailInvoiceAction } from "./EmailInvoiceAction";

/** #2088 - the Send / Email again action: a first send is immediate, a re-send asks first with the state in words. */
const changed = {
  state: "changedSinceSent",
  lastSentAt: "2026-10-02T15:00:00.000Z",
  lastSentTo: "a@b.test",
} as const;
const same = { ...changed, state: "unchanged" } as const;

describe("EmailInvoiceAction", () => {
  it("never emailed: a plain Send that sends at once, no confirmation", () => {
    const onSend = jest.fn();
    renderWithProviders(<EmailInvoiceAction onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("modified since: 'Email again' asks with the modified-since sentence; Cancel sends nothing, the button sends", () => {
    const onSend = jest.fn();
    renderWithProviders(<EmailInvoiceAction sendState={changed} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Email again" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /It has been modified since\. Email the updated invoice\?/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Email again" }));
    fireEvent.click(screen.getByRole("button", { name: "Email updated invoice" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("no changes: the no-changes sentence", () => {
    renderWithProviders(<EmailInvoiceAction sendState={same} onSend={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Email again" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /No changes since the last email on .* Email it again\?/,
    );
  });

  it("locked (pre-delivery): a disabled action that says why, never a missing button; it cannot send", () => {
    const onSend = jest.fn();
    renderWithProviders(
      <EmailInvoiceAction sendLocked={{ reason: "SENDS_AFTER_DELIVERY" }} onSend={onSend} />,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Sends after delivery")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onSend).not.toHaveBeenCalled();
  });
});
