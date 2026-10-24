/**
 * SA-815 B5 - `updateAddonRowsTx` records only the rows its guarded write actually changed.
 *
 * The pre-read happens before the `FOR UPDATE` lock, so a row a concurrent transaction changed in between no longer
 * matches the guard: the `updateMany` skips it, but the old code still recorded it (a PHANTOM `addon.state_changed`
 * that blames this actor for the other transaction's change). The invariant job reads these records as evidence, so
 * a phantom corrupts it. The fake `tx` below is an in-memory table; locking a row runs a hook that plays the
 * concurrent commit.
 */
import { updateAddonRowsTx, type AddonActor } from "./tenant-addon-writer";

type Row = {
  id: string;
  tenantId: string;
  addonKey: string;
  sku: string;
  active: boolean;
  isComp: boolean;
  quantity: number;
  priceSnapshot: number;
  stripeItemId: string | null;
  stripePriceId: string | null;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  tenantId: "t1",
  addonKey: `K_${id}`,
  sku: `K_${id}`,
  active: true,
  isComp: false,
  quantity: 1,
  priceSnapshot: 10,
  stripeItemId: null,
  stripePriceId: null,
  ...over,
});

/** Just enough `where` for the guards the writer's callers use: scalar equality, `{ in }`, and `AND`. */
function matches(r: Row, where: any): boolean {
  if (!where) return true;
  if (Array.isArray(where.AND)) return where.AND.every((w: any) => matches(r, w));
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return true;
    if (v && typeof v === "object" && "in" in (v as object)) {
      return ((v as any).in as unknown[]).includes((r as any)[k]);
    }
    return (r as any)[k] === v;
  });
}

function fakeTx(rows: Row[], onLock: (id: string, table: Row[]) => void) {
  return {
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, id: string) => {
      onLock(id, rows);
      return [{ id }];
    }),
    tenantAddon: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
  } as any;
}

const actor: AddonActor = { kind: "SYSTEM", id: null, source: "plan.stop_billing" };
const recordedRowIds = (events: { emit: jest.Mock }) =>
  events.emit.mock.calls.map((c) => (c[2] as { rowId: string }).rowId);

describe("SA-815 B5 - no phantom addon.state_changed records", () => {
  it("a row a concurrent transaction changed after the pre-read gets NO record; the row we wrote does", async () => {
    const table = [row("x"), row("y")];
    // while we wait for X's lock, another transaction commits X as a comp (it no longer matches isComp:false)
    const tx = fakeTx(table, (id, t) => {
      if (id === "x") t.find((r) => r.id === "x")!.isComp = true;
    });
    const events = { emit: jest.fn().mockResolvedValue(undefined) };

    const res = await updateAddonRowsTx(tx, events as any, {
      where: { tenantId: "t1", isComp: false },
      data: { active: false },
      actor,
    });

    expect(res.count).toBe(1);
    expect(recordedRowIds(events)).toEqual(["y"]);
    expect(table.find((r) => r.id === "x")).toMatchObject({ isComp: true, active: true });
    expect(table.find((r) => r.id === "y")!.active).toBe(false);
  });

  it("when EVERY pre-read row was changed concurrently there are 0 records and count is 0", async () => {
    const table = [row("x")];
    const tx = fakeTx(table, (_id, t) => {
      t[0].isComp = true;
    });
    const events = { emit: jest.fn().mockResolvedValue(undefined) };

    const res = await updateAddonRowsTx(tx, events as any, {
      where: { tenantId: "t1", isComp: false },
      data: { active: false },
      actor,
    });

    expect(res).toEqual({ count: 0 });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("unraced rows are each recorded once (the happy path is unchanged)", async () => {
    const table = [row("x"), row("y")];
    const tx = fakeTx(table, () => undefined);
    const events = { emit: jest.fn().mockResolvedValue(undefined) };

    const res = await updateAddonRowsTx(tx, events as any, {
      where: { tenantId: "t1", isComp: false },
      data: { active: false },
      actor,
    });

    expect(res.count).toBe(2);
    expect(recordedRowIds(events).sort()).toEqual(["x", "y"]);
  });
});
