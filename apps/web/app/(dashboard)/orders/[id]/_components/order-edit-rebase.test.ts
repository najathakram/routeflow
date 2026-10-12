/**
 * Row 372 MF3: after Reload an untouched line another writer changed must NOT be re-sent with the editor's stale
 * qty (it silently reverted them). The edit is judged against the lines captured at edit-open; Reload rebases.
 * Uses the page's own buildItemUpdates / buildEditItemFromLine, so the pin is on the real diff, not a copy.
 */
import { buildEditItemFromLine, buildItemUpdates, type EditItemState } from "../page";
import { rebaseEditItems, rebaseOnReload, rebasePendingDeletes } from "./order-edit-rebase";
import type { OrderItem } from "@/lib/api/orders";

const line = (id: string, qty: number, extra: Partial<OrderItem> = {}): OrderItem =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name: `Item ${id}`, unit: "Each", unitsPerBox: 1 },
    qty,
    unitPrice: 10,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    status: "PENDING",
    ...extra,
  }) as OrderItem;

const deps = { seed: buildEditItemFromLine };
const seedAll = (ls: OrderItem[]) => ls.map(buildEditItemFromLine);

describe("order edit rebase (row 372 MF3)", () => {
  const base = [line("a", 5), line("b", 3)];

  it("the old diff (editItems vs the REFRESHED lines) reverts another writer's change to an untouched line", () => {
    const edits = seedAll(base);
    edits[1] = { ...edits[1], qty: 4 }; // the user changed b only
    const fresh = [line("a", 9), line("b", 3)]; // someone else raised a to 9
    const reverts = buildItemUpdates(edits, fresh).filter((u) => u.id === "a");
    expect(reverts).toHaveLength(1); // the defect: a is re-sent at qty 5
  });

  it("diffed against the edit-open lines, an untouched line sends nothing", () => {
    const edits = seedAll(base);
    edits[1] = { ...edits[1], qty: 4 };
    expect(buildItemUpdates(edits, base).map((u) => u.id)).toEqual(["b"]);
  });

  it("Reload: untouched lines refresh from the server, the touched line keeps the edit, new server lines appear", () => {
    const edits = seedAll(base);
    edits[1] = { ...edits[1], qty: 4 };
    const fresh = [line("a", 9), line("b", 3), line("c", 2)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.dropped).toBe(0);
    expect(r.items.map((i) => [i.id, i.qty])).toEqual([
      ["a", 9],
      ["b", 4],
      ["c", 2],
    ]);
    // judged against the fresh lines (the new base): ONLY the user's own change is sent
    expect(buildItemUpdates(r.items, fresh)).toEqual([
      expect.objectContaining({ id: "b", qty: 4 }),
    ]);
  });

  it("per FIELD: the user's qty edit survives another writer's price change, and the price still refreshes", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 6 }; // the user changed a's qty only
    const fresh = [line("a", 5, { unitPrice: 12 }), line("b", 3)]; // someone else repriced a to 12
    const r = rebaseEditItems(edits, base, fresh, deps);
    const a = r.items.find((i) => i.id === "a")!;
    expect(a.qty).toBe(6); // the user's change
    expect(a.unitPrice).toBe(12); // the other writer's change is NOT reverted
    // the save sends only the user's qty change: the stale price is not re-sent
    const sent = buildItemUpdates(r.items, fresh).find((u) => u.id === "a")!;
    expect(sent).toMatchObject({ qty: 6 });
    expect(sent).not.toHaveProperty("unitPrice");
  });

  it("M1: another writer switched the line's UNIT: the user's qty is never mixed with the new unit", () => {
    const boxed = [line("a", 24, { unitsPerBox: 12, boxes: 2, pieces: 0 })];
    const edits = seedAll(boxed);
    edits[0] = { ...edits[0], qty: 36 }; // the user meant 36 pieces = 3 boxes
    const fresh = [
      line("a", 2, { unitLabel: "Case", unitsPerBox: 12, boxes: 2, pieces: 0, unitPrice: 18 }),
    ];
    const r = rebaseEditItems(edits, boxed, fresh, deps);
    expect(r.conflicts).toBe(1);
    const a = r.items[0];
    expect(a.unitLabel).toBe("Case");
    expect(a.qty).toBe(2); // the server's count of cases, NOT the user's 36
    // nothing is sent for it: the user must re-enter the change against the new unit
    expect(buildItemUpdates(r.items, fresh)).toEqual([]);
  });

  it("M1: another writer changed the pack size: the fresh row wins whole and is counted", () => {
    const boxed = [line("a", 24, { unitsPerBox: 12, boxes: 2, pieces: 0 })];
    const edits = seedAll(boxed);
    edits[0] = { ...edits[0], qty: 36 };
    const fresh = [line("a", 24, { unitsPerBox: 6, boxes: 4, pieces: 0 })];
    const r = rebaseEditItems(edits, boxed, fresh, deps);
    expect(r.conflicts).toBe(1);
    expect(r.items[0].unitsPerBox).toBe(6);
    expect(r.items[0].qty).toBe(deps.seed(fresh[0]).qty);
  });

  it("M1: the user substituted and nobody else touched the line: the user's row stands whole", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], substituteProductId: "p-sub", qty: 7 };
    const r = rebaseEditItems(edits, base, base, deps);
    expect(r.conflicts).toBe(0);
    expect(r.items[0]).toMatchObject({ id: "a", substituteProductId: "p-sub", qty: 7 });
  });

  it("M1b: the user substituted (same qty) while another writer changed the qty: the fresh row wins and is counted, nothing is re-sent", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], substituteProductId: "p-sub" }; // qty stays 5
    const fresh = [line("a", 9), line("b", 3)]; // the other writer raised a to 9
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.conflicts).toBe(1);
    expect(r.items[0].qty).toBe(9);
    expect(r.items[0].substituteProductId).toBeUndefined();
    expect(buildItemUpdates(r.items, fresh)).toEqual([]);
  });

  it("M1b: a unit change by the user and another writer's note edit on the line: no stale note is re-sent", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], unitLabel: "Case", qty: 2 };
    const fresh = [line("a", 5, { notes: "dock 4" }), line("b", 3)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.conflicts).toBe(1);
    expect(r.items[0].notes).toBe("dock 4");
    expect(buildItemUpdates(r.items, fresh)).toEqual([]);
  });

  it("M2: both sides changed the SAME field: the server's value stands and the line is counted (no silent overwrite)", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 7 }; // the user typed 7 on a stale 5
    const fresh = [line("a", 9), line("b", 3)]; // the other writer set 9
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.conflicts).toBe(1);
    expect(r.items[0].qty).toBe(9);
    expect(buildItemUpdates(r.items, fresh)).toEqual([]);
  });

  it("M2: the user's change to a DIFFERENT field than the other writer's is kept, and not counted", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 7 };
    const fresh = [line("a", 5, { unitPrice: 12 }), line("b", 3)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.conflicts).toBe(0);
    expect(r.items[0]).toMatchObject({ qty: 7, unitPrice: 12 });
  });

  it("M2: a note typed-and-erased ('' vs null) or padded with a space is NOT an edit, so it never overwrites theirs", () => {
    const withNullNote = [line("a", 5, { notes: null as never }), line("b", 3)];
    const edits = seedAll(withNullNote);
    edits[0] = { ...edits[0], notes: "" };
    const fresh = [line("a", 5, { notes: "dock 4" }), line("b", 3)];
    const r = rebaseEditItems(edits, withNullNote, fresh, deps);
    expect(r.conflicts).toBe(0);
    expect(r.items[0].notes).toBe("dock 4");
    const padded = [line("a", 5, { notes: "Leave at back" }), line("b", 3)];
    const e2 = seedAll(padded);
    e2[0] = { ...e2[0], notes: "Leave at back " };
    const r2 = rebaseEditItems(
      e2,
      padded,
      [line("a", 5, { notes: "Leave at dock 4" }), line("b", 3)],
      deps,
    );
    expect(r2.items[0].notes).toBe("Leave at dock 4");
  });

  it("M2: the user's picker flags survive a rebase of a line they changed", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 7, priceEdited: true };
    const fresh = [line("a", 5, { unitPrice: 12 }), line("b", 3)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.items[0].priceEdited).toBe(true);
  });

  it("M2: a catalog-only change (unitCost) is not 'someone else changed the line'", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 7 };
    const r = rebaseEditItems(
      edits,
      base,
      [
        line("a", 5, {
          product: {
            id: "p-a",
            name: "Item a",
            unit: "Each",
            unitsPerBox: 1,
            averageCost: 3,
          } as never,
        }),
        line("b", 3),
      ],
      deps,
    );
    expect(r.conflicts).toBe(0);
    expect(r.items[0].qty).toBe(7);
  });

  it("picker-only flags (priceEdited false vs absent) are not an edit: the row refreshes", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], priceEdited: false, startOnDefaultUnit: false };
    const fresh = [line("a", 9), line("b", 3)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.conflicts).toBe(0);
    expect(r.items[0].qty).toBe(9);
  });

  it("a 'Not available' strike survives a conflict (it sends no qty)", () => {
    const boxed = [line("a", 24, { unitsPerBox: 12, boxes: 2, pieces: 0 })];
    const edits = seedAll(boxed);
    edits[0] = { ...edits[0], cancelled: true };
    const fresh = [line("a", 2, { unitLabel: "Case", unitsPerBox: 12, boxes: 2, pieces: 0 })];
    const r = rebaseEditItems(edits, boxed, fresh, deps);
    expect(r.conflicts).toBe(1);
    expect(r.items[0].cancelled).toBe(true);
  });

  it("a line CANCELLED at edit-open that another writer revived appears after Reload", () => {
    const wasCancelled = [line("a", 5, { status: "CANCELLED" }), line("b", 3)];
    const edits = seedAll([wasCancelled[1]]);
    const fresh = [line("a", 5), line("b", 3)];
    const r = rebaseEditItems(edits, wasCancelled, fresh, deps);
    expect(r.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("a line another writer removed is dropped (an edit of it would 409 on every save), and counted", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 6 }; // the user touched a, which someone else then cancelled
    const fresh = [line("a", 5, { status: "CANCELLED" }), line("b", 3)];
    const r = rebaseEditItems(edits, base, fresh, deps);
    expect(r.items.map((i) => i.id)).toEqual(["b"]);
    expect(r.dropped).toBe(1);
  });

  it("a user-added (new) line survives the rebase untouched", () => {
    const added = {
      ...buildEditItemFromLine(line("n", 1)),
      isNew: true,
      id: "new-1",
    } as EditItemState;
    const r = rebaseEditItems([...seedAll(base), added], base, base, deps);
    expect(r.items.map((i) => i.id)).toEqual(["a", "b", "new-1"]);
  });

  it("pendingDeletes drops an id whose line is gone or cancelled on the server", () => {
    const fresh = [line("a", 5, { status: "CANCELLED" }), line("b", 3)];
    expect(rebasePendingDeletes(["a", "b"], fresh)).toEqual(["b"]);
    expect(rebasePendingDeletes(["z"], fresh)).toEqual([]);
  });
});

describe("rebaseOnReload: fee and credits follow the same rule as a line field (row 372)", () => {
  function run(
    state: { fee: number; credits: any[]; touched: boolean; pending?: string[] },
    base: { fee: number; credits: any[] },
    fresh: { fee: number; credits: any[] },
  ) {
    const out = {
      fee: state.fee,
      credits: state.credits,
      touched: state.touched,
      pending: state.pending ?? [],
    };
    const n = rebaseOnReload(
      {
        editItems: [] as EditItemState[],
        editShippingFee: state.fee,
        editCredits: state.credits,
        creditsTouched: state.touched,
        deps,
        setEditItems: () => undefined,
        setPendingDeletes: (f) => {
          out.pending = f(out.pending);
        },
        setEditShippingFee: (f) => {
          out.fee = f(out.fee);
        },
        setEditCredits: (c) => {
          out.credits = c;
        },
        setCreditsTouched: (t) => {
          out.touched = t;
        },
      },
      { lines: [], fee: fresh.fee, credits: fresh.credits },
      { lines: [], fee: base.fee, credits: base.credits },
    );
    return { n, ...out };
  }

  it("the user did not touch the fee: another writer's fee is taken and nothing is counted", () => {
    const r = run(
      { fee: 10, credits: [], touched: false },
      { fee: 10, credits: [] },
      { fee: 15, credits: [] },
    );
    expect(r.fee).toBe(15);
    expect(r.n).toBe(0);
  });

  it("the user changed the fee and nobody else did: theirs stands", () => {
    const r = run(
      { fee: 12, credits: [], touched: false },
      { fee: 10, credits: [] },
      { fee: 10, credits: [] },
    );
    expect(r.fee).toBe(12);
  });

  it("both changed the fee to different values: the server's stands and the page is told", () => {
    const r = run(
      { fee: 12, credits: [], touched: false },
      { fee: 10, credits: [] },
      { fee: 15, credits: [] },
    );
    expect(r.fee).toBe(15);
    expect(r.n).toBe(1);
  });

  it("another operator applied a credit while the user's stale selection was touched: the server's set stands", () => {
    const mine = [{ creditNoteId: "A", amount: 5 }];
    const theirs = [{ creditNoteId: "B", amount: 7 }];
    const r = run(
      { fee: 0, credits: mine, touched: true },
      { fee: 0, credits: [] },
      { fee: 0, credits: theirs },
    );
    expect(r.credits).toEqual(theirs); // B is NOT pulled back by sending [A]
    expect(r.touched).toBe(false);
    expect(r.n).toBe(1);
  });

  it("credits unchanged by anyone: the user's touched selection is left alone", () => {
    const mine = [{ creditNoteId: "A", amount: 5 }];
    const r = run(
      { fee: 0, credits: mine, touched: true },
      { fee: 0, credits: [] },
      { fee: 0, credits: [] },
    );
    expect(r.credits).toEqual(mine);
    expect(r.touched).toBe(true);
  });

  it("a queued delete of a line that vanished is dropped", () => {
    const r = run(
      { fee: 0, credits: [], touched: false, pending: ["gone"] },
      { fee: 0, credits: [] },
      { fee: 0, credits: [] },
    );
    expect(r.pending).toEqual([]); // fresh has no lines, so "gone" does not exist any more
  });
});
