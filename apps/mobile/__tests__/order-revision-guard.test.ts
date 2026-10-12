/**
 * `lib/order-revision-guard.ts` — row 262, the mobile half of the order revision guard.
 * Pure decisions only: is this error the stale-revision 409, which fixed copy to show,
 * which revision the editor holds, and what goes on the PATCH body.
 */
import {
  ORDER_STALE_COPY,
  captureOpenRevision,
  expectedRevisionBody,
  isOrderRevisionStale,
  rebaseRevision,
} from "../lib/order-revision-guard";

const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("isOrderRevisionStale", () => {
  it("is true for a 409 carrying ORDER_REVISION_STALE", () => {
    expect(isOrderRevisionStale(err(409, { code: "ORDER_REVISION_STALE" }))).toBe(true);
  });
  it("leaves other 409 codes alone", () => {
    expect(isOrderRevisionStale(err(409, { code: "REGULATED_AUTH_REQUIRED" }))).toBe(false);
    expect(isOrderRevisionStale(err(409, {}))).toBe(false);
  });
  it("needs the 409 status as well as the code", () => {
    expect(isOrderRevisionStale(err(400, { code: "ORDER_REVISION_STALE" }))).toBe(false);
  });
  it("tolerates non-axios errors", () => {
    expect(isOrderRevisionStale(null)).toBe(false);
    expect(isOrderRevisionStale(new Error("boom"))).toBe(false);
    expect(isOrderRevisionStale({ response: {} })).toBe(false);
  });
});

describe("ORDER_STALE_COPY", () => {
  it("is the fixed sentence, never server text", () => {
    expect(ORDER_STALE_COPY).toBe(
      "This order changed since you opened it. Reload to see the latest.",
    );
  });
});

describe("captureOpenRevision", () => {
  it("captures the first known revision", () => {
    expect(captureOpenRevision(undefined, 4)).toBe(4);
  });
  it("never moves once captured (a refetch while typing must not re-base)", () => {
    expect(captureOpenRevision(4, 7)).toBe(4);
  });
  it("stays unknown while the order has no revision", () => {
    expect(captureOpenRevision(undefined, undefined)).toBeUndefined();
  });
  it("ignores a non-integer live value", () => {
    expect(captureOpenRevision(undefined, 1.5)).toBeUndefined();
    expect(captureOpenRevision(undefined, "3" as unknown as number)).toBeUndefined();
  });
});

describe("rebaseRevision", () => {
  it("adopts the freshly loaded revision on an explicit reload", () => {
    expect(rebaseRevision(9)).toBe(9);
  });
  it("is unknown when the reload did not return one", () => {
    expect(rebaseRevision(undefined)).toBeUndefined();
  });
});

describe("expectedRevisionBody", () => {
  it("includes expectedRevisionNumber when known", () => {
    expect(expectedRevisionBody(5)).toEqual({ expectedRevisionNumber: 5 });
    expect(expectedRevisionBody(0)).toEqual({ expectedRevisionNumber: 0 });
  });
  it("omits it when unknown or not an integer", () => {
    expect(expectedRevisionBody(undefined)).toEqual({});
    expect(expectedRevisionBody(Number.NaN)).toEqual({});
    expect(expectedRevisionBody(2.5)).toEqual({});
  });
});

// ── Reload re-base: another writer's change must not be reverted by the next save ─────────────
import {
  hydrateFromOrder,
  orderOriginals,
  rebaseEditOnReload,
  stagedDiffItems,
} from "../lib/edit-items-draft";

const line = (id: string, qty: number, extra: Record<string, unknown> = {}) => ({
  id,
  productId: `p-${id}`,
  qty,
  unitPrice: 10,
  status: "PENDING",
  product: { name: `Item ${id}`, pricePerUnit: 10 },
  ...extra,
});
const orderOf = (...lineItems: any[]) => ({ id: "o1", lineItems });

function openEditor(frozen: any) {
  const { draft, unlisted } = hydrateFromOrder(frozen);
  return { draft, unlisted, pendingDeletes: [] as string[] };
}

describe("rebaseEditOnReload", () => {
  it("an untouched line another writer changed is adopted, so Save does not re-send the stale qty", () => {
    const frozen = orderOf(line("a", 2), line("b", 1));
    const fresh = orderOf(line("a", 5), line("b", 1));
    const staged = openEditor(frozen);
    // the user touches only b
    staged.draft.b = { ...staged.draft.b, qty: 3 };
    const next = rebaseEditOnReload({ frozen, fresh, ...staged });
    expect(next.draft.a.qty).toBe(5);
    expect(next.draft.b.qty).toBe(3);
    const items = stagedDiffItems(next, orderOriginals(fresh as any));
    expect(items.map((i: any) => i.id)).toEqual(["b"]);
  });

  it("a zero-edit editor sends nothing after Reload", () => {
    const frozen = orderOf(line("a", 2));
    const fresh = orderOf(line("a", 5));
    const next = rebaseEditOnReload({ frozen, fresh, ...openEditor(frozen) });
    expect(stagedDiffItems(next, orderOriginals(fresh as any))).toEqual([]);
  });

  it("a touched line keeps the typed edit even when another writer changed it too", () => {
    const frozen = orderOf(line("a", 2));
    const fresh = orderOf(line("a", 5));
    const staged = openEditor(frozen);
    staged.draft.a = { ...staged.draft.a, qty: 7 };
    const next = rebaseEditOnReload({ frozen, fresh, ...staged });
    expect(next.draft.a.qty).toBe(7);
  });

  it("a line that vanished is dropped from the draft and from pending deletes", () => {
    const frozen = orderOf(line("a", 2), line("b", 1), line("c", 1));
    const fresh = orderOf(line("a", 2));
    const staged = openEditor(frozen);
    staged.draft.b = { ...staged.draft.b, qty: 9 };
    const next = rebaseEditOnReload({ frozen, fresh, ...staged, pendingDeletes: ["c"] });
    expect(Object.keys(next.draft)).toEqual(["a"]);
    expect(next.pendingDeletes).toEqual([]);
    expect(stagedDiffItems(next, orderOriginals(fresh as any))).toEqual([]);
  });

  it("a line another writer added appears untouched; a line the user removed stays removed", () => {
    const frozen = orderOf(line("a", 2), line("b", 1));
    const fresh = orderOf(line("a", 2), line("b", 1), line("n", 4));
    const staged = openEditor(frozen);
    delete staged.draft.b;
    const next = rebaseEditOnReload({ frozen, fresh, ...staged });
    expect(Object.keys(next.draft).sort()).toEqual(["a", "n"]);
    expect(stagedDiffItems(next, orderOriginals(fresh as any)).map((i: any) => i.id)).toEqual([
      "b",
    ]);
  });
});
