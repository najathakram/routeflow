import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOrderStaleRevision } from "./OrderStaleNotice";

/**
 * Row 372 (SA-735 item 2, web half): the edit screen sends the revision it LOADED, a 409 ORDER_REVISION_STALE
 * shows "This order changed since you opened it. Reload to see the latest." with a Reload that refetches the
 * order and re-bases the revision, keeping the editor's typed edits.
 */
const stale = (status = 409, code = "ORDER_REVISION_STALE") => ({
  response: { status, data: { code } },
});

function Harness({ order, editing }: { order: any; editing: boolean }) {
  const s = useOrderStaleRevision(order, editing);
  return (
    <div>
      <span data-testid="expected">{String(s.expected())}</span>
      <button onClick={() => s.capture(stale())}>fail</button>
      <button onClick={() => s.capture(stale(409, "SOMETHING_ELSE"))}>other</button>
      <span data-testid="owns">{String(s.ownsToast(stale()))}</span>
      {s.node}
    </div>
  );
}

function setup(order: any, editing = true) {
  const qc = new QueryClient();
  qc.setQueryData(["orders", order.id], order);
  const view = render(
    <QueryClientProvider client={qc}>
      <Harness order={order} editing={editing} />
    </QueryClientProvider>,
  );
  return { qc, view };
}

describe("useOrderStaleRevision (row 372)", () => {
  it("expected() is the revision the order had when edit mode opened, not a later refetch", () => {
    const qc = new QueryClient();
    const tree = (order: any) => (
      <QueryClientProvider client={qc}>
        <Harness order={order} editing />
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ id: "o1", revisionNumber: 4 }));
    expect(screen.getByTestId("expected")).toHaveTextContent("4");
    rerender(tree({ id: "o1", revisionNumber: 5 })); // a background refetch while editing
    expect(screen.getByTestId("expected")).toHaveTextContent("4");
  });

  it("a server that does not send revisionNumber leaves expected undefined (the field is not sent)", () => {
    setup({ id: "o1" });
    expect(screen.getByTestId("expected")).toHaveTextContent("undefined");
  });

  it("a 409 ORDER_REVISION_STALE shows the reload notice; another error does not, and the toast is owned", () => {
    setup({ id: "o1", revisionNumber: 4 });
    expect(screen.queryByTestId("order-stale-notice")).toBeNull();
    fireEvent.click(screen.getByText("other"));
    expect(screen.queryByTestId("order-stale-notice")).toBeNull();
    fireEvent.click(screen.getByText("fail"));
    expect(screen.getByTestId("order-stale-notice")).toHaveTextContent(
      "This order changed since you opened it. Reload to see the latest.",
    );
    expect(screen.getByTestId("owns")).toHaveTextContent("true");
  });

  it("Reload refetches the order, re-bases expected() on the latest revision and clears the notice", async () => {
    const { qc } = setup({ id: "o1", revisionNumber: 4 });
    fireEvent.click(screen.getByText("fail"));
    // the refetch lands a newer order in the cache
    jest.spyOn(qc, "invalidateQueries").mockImplementation(async () => {
      qc.setQueryData(["orders", "o1"], { id: "o1", revisionNumber: 7 });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["orders", "o1"] });
    expect(screen.getByTestId("expected")).toHaveTextContent("7");
    expect(screen.queryByTestId("order-stale-notice")).toBeNull();
  });

  it("an order that sent no revision at edit-open never falls back to the live one (no silent self-judging)", () => {
    const qc = new QueryClient();
    const tree = (order: any) => (
      <QueryClientProvider client={qc}>
        <Harness order={order} editing />
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ id: "o1" }));
    rerender(tree({ id: "o1", revisionNumber: 6 })); // the revision shows up later (a refetch)
    expect(screen.getByTestId("expected")).toHaveTextContent("undefined");
  });

  it("Reload hands the FRESH lines and the edit-open lines to onRebase, then re-bases both", async () => {
    const onRebase = jest.fn();
    const qc = new QueryClient();
    const open = {
      id: "o1",
      revisionNumber: 4,
      shippingFee: 10,
      lineItems: [{ id: "a" }, { id: "b" }],
    };
    qc.setQueryData(["orders", "o1"], open);
    function H({ order }: { order: any }) {
      const s = useOrderStaleRevision(order, true, onRebase);
      return (
        <div>
          <span data-testid="base">{JSON.stringify(s.baseLines())}</span>
          <span data-testid="fee">{String(s.baseFee())}</span>
          <button onClick={() => s.capture(stale())}>fail</button>
          {s.node}
        </div>
      );
    }
    const tree = (order: any) => (
      <QueryClientProvider client={qc}>
        <H order={order} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(open));
    // a background refetch lands while typing: the base must stay the edit-open lines
    rerender(tree({ ...open, lineItems: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
    expect(screen.getByTestId("base")).toHaveTextContent('[{"id":"a"},{"id":"b"}]');
    fireEvent.click(screen.getByText("fail"));
    const fresh = {
      id: "o1",
      revisionNumber: 7,
      shippingFee: 15,
      lineItems: [{ id: "a" }, { id: "c" }],
    };
    jest.spyOn(qc, "invalidateQueries").mockImplementation(async () => {
      qc.setQueryData(["orders", "o1"], fresh);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    });
    expect(onRebase).toHaveBeenCalledWith(
      expect.objectContaining({ lines: fresh.lineItems, fee: 15, rev: 7 }),
      expect.objectContaining({ lines: open.lineItems, fee: 10, rev: 4 }),
    );
    expect(screen.getByTestId("base")).toHaveTextContent('[{"id":"a"},{"id":"c"}]');
    expect(screen.getByTestId("fee")).toHaveTextContent("15");
  });

  it("baseFee() is the fee the editor loaded, not a later refetch (MF3: the fee must not revert another writer)", () => {
    const qc = new QueryClient();
    function F({ order }: { order: any }) {
      const s = useOrderStaleRevision(order, true);
      return <span data-testid="fee">{String(s.baseFee())}</span>;
    }
    const tree = (order: any) => (
      <QueryClientProvider client={qc}>
        <F order={order} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ id: "o1", revisionNumber: 4, shippingFee: "10.00" }));
    rerender(tree({ id: "o1", revisionNumber: 5, shippingFee: "15.00" })); // another writer's fee lands
    expect(screen.getByTestId("fee")).toHaveTextContent("10");
  });

  it("feeChanged is judged against the fee loaded at edit-open, even after a refetch moves the live fee", () => {
    const qc = new QueryClient();
    let probe = (_c: number, _l: number | string | null | undefined) => false;
    function F({ order }: { order: any }) {
      const s = useOrderStaleRevision(order, true);
      probe = s.feeChanged;
      return null;
    }
    const tree = (order: any) => (
      <QueryClientProvider client={qc}>
        <F order={order} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ id: "o1", revisionNumber: 4, shippingFee: "10.00" }));
    rerender(tree({ id: "o1", revisionNumber: 5, shippingFee: "15.00" })); // another writer's fee lands
    expect(probe(10, "15.00")).toBe(false); // the user left 10 alone: NOT a change
    expect(probe(12, "15.00")).toBe(true);
  });

  it("outside edit mode nothing is captured and nothing is sent", () => {
    setup({ id: "o1", revisionNumber: 4 }, false);
    expect(screen.getByTestId("expected")).toHaveTextContent("undefined");
    fireEvent.click(screen.getByText("fail"));
    expect(screen.queryByTestId("order-stale-notice")).toBeNull();
  });
});
