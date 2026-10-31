import * as React from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useNewCustomerDoor } from "./useNewCustomerDoor";
import { CounterBuyerChoice } from "./CounterBuyerChoice";

/**
 * SA-1066 F21: the Add Customer window opens with no Radix trigger, so closing it by Escape, X or Cancel dropped focus to
 * <body>. The counter's door now hands focus back to the button that opened it (the New customer button, or the no-match
 * `Add "<typed>" as a new customer` one) while that button is still mounted, else to the Find a customer box. A save is the
 * success path and leaves focus alone: the screen's own pick refocuses the scan box.
 */
jest.mock("../../customers/_components/CustomerFormModal", () => ({
  CustomerFormModal: ({
    onClose,
    onCreated,
  }: {
    onClose: () => void;
    onCreated: (c: { id: string; businessName: string }) => void;
  }) => (
    // Like the real window, it takes focus on open; on close the focused element is removed and focus falls to <body>.
    <div
      role="dialog"
      aria-label="Add Customer"
      tabIndex={-1}
      ref={(el) => {
        el?.focus();
      }}
    >
      <button type="button" onClick={onClose}>
        Close dialog
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        onClick={() => {
          onCreated({ id: "c1", businessName: "Acme Cafe" });
          onClose();
        }}
      >
        Create Customer
      </button>
    </div>
  ),
}));

function Harness({ noMatch = false, picked }: { noMatch?: boolean; picked: () => void }) {
  const findRef = React.useRef<HTMLInputElement>(null);
  const scanRef = React.useRef<HTMLInputElement>(null);
  const door = useNewCustomerDoor(
    () => {
      picked();
      scanRef.current?.focus(); // what the screen does after a pick
    },
    false,
    () => findRef.current,
  );
  return (
    <div>
      <input aria-label="Scan" ref={scanRef} />
      <CounterBuyerChoice
        kind={null}
        disabled={false}
        onWalkIn={jest.fn()}
        onNewCustomer={noMatch ? undefined : (opener) => door.open("", opener)}
      />
      <input aria-label="Find a customer" ref={findRef} />
      {noMatch ? (
        <button type="button" onClick={() => door.open("Acme")}>
          Add &quot;Acme&quot; as a new customer
        </button>
      ) : null}
      {door.modal}
    </div>
  );
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));
const open = async (name: string) => {
  const btn = screen.getByRole("button", { name });
  btn.focus();
  fireEvent.click(btn);
  expect(screen.getByRole("dialog", { name: "Add Customer" })).toBeInTheDocument();
  return btn;
};

afterEach(cleanup);

describe("the counter's new-customer door hands focus back (F21)", () => {
  it.each(["Close dialog", "Cancel"])(
    "%s returns focus to the New customer button that opened it",
    async (closer) => {
      render(<Harness picked={jest.fn()} />);
      const btn = await open("New customer");
      fireEvent.click(screen.getByRole("button", { name: closer }));
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(btn);
    },
  );

  it("a click that did not focus the button (Safari) still returns focus to it", async () => {
    render(<Harness picked={jest.fn()} />);
    const btn = screen.getByRole("button", { name: "New customer" });
    fireEvent.click(btn); // no .focus(): activeElement stays <body>
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(document.activeElement).toBe(btn);
  });

  it("the no-match Add button is the opener when it is still mounted", async () => {
    render(<Harness noMatch picked={jest.fn()} />);
    const btn = await open('Add "Acme" as a new customer');
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(document.activeElement).toBe(btn);
  });

  it("an opener that is gone falls back to the Find a customer box", async () => {
    const { rerender } = render(<Harness noMatch picked={jest.fn()} />);
    await open('Add "Acme" as a new customer');
    rerender(<Harness picked={jest.fn()} />); // the no-match row went away while the window was open
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(document.activeElement).toBe(screen.getByLabelText("Find a customer"));
  });

  it("success path: creating a customer leaves focus where the screen put it (the scan box)", async () => {
    const picked = jest.fn();
    render(<Harness picked={picked} />);
    await open("New customer");
    fireEvent.click(screen.getByRole("button", { name: "Create Customer" }));
    await flush();
    expect(picked).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText("Scan"));
  });
});
