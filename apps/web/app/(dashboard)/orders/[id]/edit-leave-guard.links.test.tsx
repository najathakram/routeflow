/* eslint-disable @next/next/no-html-link-for-pages -- plain anchors on purpose: the guard must catch any link, and jsdom has no router */
import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { leavingHref, useEditLeaveGuard } from "./edit-leave-guard";

/**
 * UX audit 2026-11-24 F03: the guard covered Back and reload, and any link the page wired by hand; nothing was wired,
 * so the side menu left an edit with no question. The guard now catches every link click itself.
 */
function Harness({
  dirty,
  onDiscard,
  navigate,
  what,
}: {
  dirty: boolean;
  onDiscard: () => void;
  navigate?: (href: string) => void;
  what?: string;
}) {
  const guard = useEditLeaveGuard(dirty, onDiscard, jest.fn(), { navigate, what });
  return (
    <>
      <a href="/customers?tab=open">Customers</a>
      <a href="#notes">Notes</a>
      <a href="/orders/o1">This order</a>
      <a href="/help" target="_blank" rel="noreferrer">
        Help
      </a>
      <a href="https://example.com/x">Elsewhere</a>
      <a href="/file.csv" download>
        Export
      </a>
      {guard.dialog}
    </>
  );
}

/** Click a link; report whether the guard stopped it (and stop jsdom from trying to navigate). */
function clickLink(name: string, init: MouseEventInit = {}): boolean {
  let stopped = true;
  const record = (e: MouseEvent) => {
    stopped = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", record);
  fireEvent.click(screen.getByRole("link", { name }), init);
  document.removeEventListener("click", record);
  return stopped;
}

beforeEach(() => window.history.replaceState({}, "", "/orders/o1"));

describe("Edit leave guard: links that leave the page", () => {
  it("dirty: a link to another page is stopped and the question names the record", async () => {
    const navigate = jest.fn();
    render(<Harness dirty onDiscard={jest.fn()} navigate={navigate} what="product" />);
    expect(clickLink("Customers")).toBe(true);
    expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
    expect(
      screen.getByText("You have unsaved edits to this product. If you leave now they are lost."),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("the record is an order unless the page says otherwise", async () => {
    render(<Harness dirty onDiscard={jest.fn()} navigate={jest.fn()} />);
    clickLink("Customers");
    expect(
      await screen.findByText(
        "You have unsaved edits to this order. If you leave now they are lost.",
      ),
    ).toBeInTheDocument();
  });

  it("Keep editing: nothing is discarded and nothing navigates", async () => {
    const navigate = jest.fn();
    const discard = jest.fn();
    render(<Harness dirty onDiscard={discard} navigate={navigate} />);
    clickLink("Customers");
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(screen.queryByText("Discard your changes?")).not.toBeInTheDocument(),
    );
    expect(discard).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Discard: the edit is dropped, then the link's address (query included) is followed", async () => {
    const navigate = jest.fn();
    const discard = jest.fn();
    const view = render(<Harness dirty onDiscard={discard} navigate={navigate} />);
    clickLink("Customers");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    view.rerender(<Harness dirty={false} onDiscard={discard} navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/customers?tab=open"));
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("not dirty: no link is stopped", () => {
    render(<Harness dirty={false} onDiscard={jest.fn()} navigate={jest.fn()} />);
    expect(clickLink("Customers")).toBe(false);
    expect(screen.queryByText("Discard your changes?")).not.toBeInTheDocument();
  });

  it("dirty: clicks that do not leave the page are left alone", () => {
    render(<Harness dirty onDiscard={jest.fn()} navigate={jest.fn()} />);
    expect(clickLink("Notes")).toBe(false); // a place on this page
    expect(clickLink("This order")).toBe(false); // this very page
    expect(clickLink("Help")).toBe(false); // opens a new tab
    expect(clickLink("Export")).toBe(false); // a download
    expect(clickLink("Elsewhere")).toBe(false); // another site: the browser's own prompt covers it
    expect(clickLink("Customers", { ctrlKey: true })).toBe(false); // new tab by keyboard
    expect(clickLink("Customers", { button: 1 })).toBe(false); // middle click
    expect(screen.queryByText("Discard your changes?")).not.toBeInTheDocument();
  });
});

describe("leavingHref", () => {
  const click = (el: Element) => {
    let out: string | null = "unset";
    const read = (e: MouseEvent) => {
      out = leavingHref(e);
      e.preventDefault();
    };
    document.addEventListener("click", read);
    fireEvent.click(el);
    document.removeEventListener("click", read);
    return out;
  };

  it("gives path, query and hash of a link to another page, from a click on a child of the link", () => {
    render(
      <a href="/products/p2?tab=prices#tiers">
        <span>Other product</span>
      </a>,
    );
    expect(click(screen.getByText("Other product"))).toBe("/products/p2?tab=prices#tiers");
  });

  it("is null for a click that is not on a link", () => {
    render(<button type="button">Save</button>);
    expect(click(screen.getByText("Save"))).toBeNull();
  });
});
