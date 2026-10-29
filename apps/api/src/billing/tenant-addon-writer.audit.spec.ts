/**
 * Row 556 / SA-970 §2 - the writer's audit record.
 *   gap 1: every changed field records (a pointer-only write too: Stripe bills by price id);
 *   gap 3: a change made under impersonation carries `impersonatedBy` on the event payload.
 */
import { runWithImpersonation } from "../tenant/impersonation-context";
import { updateAddonRowsTx, updateAddonRowTx, type AddonActor } from "./tenant-addon-writer";

type Row = Record<string, unknown> & { id: string };
const base = (): Row => ({
  id: "ta1",
  tenantId: "t1",
  addonKey: "FORECASTING",
  sku: "FORECASTING",
  active: true,
  isComp: false,
  quantity: 1,
  priceSnapshot: 25,
  stripeItemId: "si_1",
  stripePriceId: "price_old",
});

function fake(row: Row) {
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: row.id }]),
    tenantAddon: {
      findMany: jest.fn(async () => [{ ...row }]),
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      updateMany: jest.fn(async ({ data }: any) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  const events: any = { emit: jest.fn(async () => undefined) };
  return { tx, events };
}

const adopt: AddonActor = { kind: "SYSTEM", id: null, source: "checkout.adopt" };

describe("every diff records (gap 1)", () => {
  it.each([
    ["stripePriceId", { stripePriceId: "price_new" }],
    ["stripeItemId", { stripeItemId: "si_2" }],
    ["sku", { sku: "FORECASTING_V2" }],
  ])("checkout.adopt changing ONLY %s emits one addon.state_changed", async (field, data) => {
    const { tx, events } = fake(base());
    await updateAddonRowsTx(tx, events, { where: { id: "ta1" }, data, actor: adopt });
    expect(events.emit).toHaveBeenCalledTimes(1);
    const payload = events.emit.mock.calls[0][2];
    expect(Object.keys(payload.changes)).toEqual([field]);
  });

  it("a write that changes nothing still emits nothing", async () => {
    const { tx, events } = fake(base());
    await updateAddonRowsTx(tx, events, {
      where: { id: "ta1" },
      data: { stripePriceId: "price_old" },
      actor: adopt,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("impersonation on the event (gap 3)", () => {
  const tenantUser: AddonActor = { kind: "TENANT_USER", id: "u1", source: "tenant.disable" };

  it("a change made under impersonation carries impersonatedBy", async () => {
    const { tx, events } = fake(base());
    await runWithImpersonation("sa-1", () =>
      updateAddonRowTx(tx, events, { id: "ta1", data: { active: false }, actor: tenantUser }),
    );
    expect(events.emit.mock.calls[0][2]).toMatchObject({
      actor: { kind: "TENANT_USER", id: "u1" },
      impersonatedBy: "sa-1",
    });
  });

  it("a change with no impersonation has no impersonatedBy key", async () => {
    const { tx, events } = fake(base());
    await updateAddonRowTx(tx, events, { id: "ta1", data: { active: false }, actor: tenantUser });
    expect(events.emit.mock.calls[0][2]).not.toHaveProperty("impersonatedBy");
  });
});
