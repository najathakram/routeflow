/**
 * F3 (second part): the staff order-edit payload must never carry one line id twice, because the API refuses that
 * with 400 DUPLICATE_LINE_ID. Builders covered: `buildItemUpdates` (the per-line diff), and the Reload rebase
 * (`rebaseEditItems` + `rebasePendingDeletes`) whose output feeds the save as `[...pendingDeletes DELETE, ...diff]`.
 */
import { buildEditItemFromLine, buildItemUpdates, type EditItemState } from "./page";
import { rebaseEditItems, rebasePendingDeletes } from "./_components/order-edit-rebase";
import type { OrderItem, ItemUpdate } from "@/lib/api/orders";

const line = (id: string, qty: number, extra: Partial<OrderItem> = {}): OrderItem =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name: id, unit: "Box", unitsPerBox: null },
    qty,
    unitPrice: 5,
    status: "PENDING",
    ...extra,
  }) as OrderItem;

const caseLine = (id: string, count: number): OrderItem =>
  line(id, count * 12, { boxes: count, pieces: 0, unitsPerBox: 12, unitLabel: "Case" });

const seedAll = (ls: OrderItem[]): EditItemState[] => ls.map(buildEditItemFromLine);
/** Exactly the save's shape in page.tsx: queued DELETEs first, then the diff. */
const savePayload = (
  deletes: string[],
  edits: EditItemState[],
  base: OrderItem[],
): ItemUpdate[] => [
  ...deletes.map((id): ItemUpdate => ({ id, action: "DELETE" })),
  ...buildItemUpdates(edits, base),
];
const expectUnique = (items: ItemUpdate[]) => {
  const all = items.map((i) => i.id).filter((v): v is string => !!v);
  expect(new Set(all).size).toBe(all.length);
};

describe("staff order edit payload never emits a duplicate line id (F3)", () => {
  const base = [line("a", 5), line("b", 3)];

  it("the same line edited twice (qty, then price, then a note) is ONE entry", () => {
    const edits = seedAll(base);
    edits[0] = { ...edits[0], qty: 6 };
    edits[0] = { ...edits[0], unitPrice: 7, overrideReason: "deal" };
    edits[0] = { ...edits[0], notes: "left at dock" };
    const out = buildItemUpdates(edits, base);
    expect(out.filter((u) => u.id === "a")).toHaveLength(1);
    expectUnique(out);
  });

  it("a unit change on a line: the stored line is one entry and the new unit line has no id", () => {
    const stored = [line("a", 5)];
    const edits = seedAll(stored);
    edits[0] = { ...edits[0], qty: 4 };
    const added = {
      ...buildEditItemFromLine(caseLine("tmp", 2)),
      id: "new-1",
      isNew: true,
      productId: "p-a",
    } as EditItemState;
    const out = buildItemUpdates([...edits, added], stored);
    expectUnique(out);
    expect(out.filter((u) => u.id === undefined)).toHaveLength(1);
  });

  it("a line removed then another writer's Reload: the deleted id is not also in the edit rows", () => {
    const edits = seedAll(base).filter((e) => e.id !== "a"); // the user trashed a
    const deletes = ["a"];
    const fresh = [line("a", 9), line("b", 3)]; // a is still live on the server
    const rebased = rebaseEditItems(edits, base, fresh, { seed: buildEditItemFromLine });
    const kept = rebasePendingDeletes(deletes, fresh);
    expect(rebased.items.map((i) => i.id)).not.toContain("a");
    expectUnique(savePayload(kept, rebased.items, fresh));
  });

  it("a line revived by another writer after the user deleted its old row is one entry", () => {
    const withCancelled = [line("a", 5, { status: "CANCELLED" }), line("b", 3)];
    const edits = seedAll(withCancelled.filter((l) => l.status !== "CANCELLED"));
    const fresh = [line("a", 5), line("b", 3)]; // a revived
    const rebased = rebaseEditItems(edits, withCancelled, fresh, { seed: buildEditItemFromLine });
    expect(rebased.items.filter((i) => i.id === "a")).toHaveLength(1);
    expectUnique(savePayload([], rebased.items, fresh));
  });

  it("a rebase that sees a line twice in the edit rows' source (merged/rebased) keeps one row per id", () => {
    const edits = seedAll(base);
    edits[1] = { ...edits[1], qty: 4 };
    const fresh = [line("a", 9), line("b", 3), line("c", 2)];
    const rebased = rebaseEditItems(edits, base, fresh, { seed: buildEditItemFromLine });
    const rowIds = rebased.items.map((i) => i.id);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    expectUnique(savePayload([], rebased.items, fresh));
  });
});
