/**
 * Row 372 MF3: after Reload an untouched line another writer changed must NOT be re-sent with the editor's stale
 * qty (it silently reverted them). The edit is judged against the lines captured at edit-open; Reload rebases.
 * Uses the page's own buildItemUpdates / buildEditItemFromLine, so the pin is on the real diff, not a copy.
 */
import { buildEditItemFromLine, buildItemUpdates, type EditItemState } from "../page";
import { rebaseEditItems, rebasePendingDeletes } from "./order-edit-rebase";
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
