import { FulfillPath, OrderStatus } from "@prisma/client";
import { PackingSlipService } from "./packing-slip.service";

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async () => Buffer.from("pdf")),
}));

const full = (id: string, over: any = {}) => ({
  id,
  orderNumber: `N-${id}`,
  status: OrderStatus.CONFIRMED,
  fulfillPath: FulfillPath.SHIP,
  shippingCarrier: null,
  shippingTrackingNumber: null,
  customer: { businessName: "B", contactName: "C", addresses: [] },
  lineItems: [],
  ...over,
});

function build(rows: any[], tenantId: string | null = "t1") {
  const findMany = jest.fn(async ({ where }: any) =>
    rows.filter((r) => where.id.in.includes(r.id)),
  );
  const prisma = {
    forTenant: () => ({ order: { findMany } }),
    getTenantId: () => tenantId,
    tenantConfig: { findUnique: jest.fn(async () => ({ businessName: "Seller" })) },
  } as any;
  const storage = {
    upload: jest.fn(async () => "k"),
    presignedUrl: jest.fn(async (k: string) => `https://signed/${k}`),
  } as any;
  return { svc: new PackingSlipService(prisma, storage), storage, findMany };
}

describe("PackingSlipService.generate", () => {
  it("includes SHIP orders in request order, skips non-SHIP / cancelled / foreign with outcomes", async () => {
    const { svc, storage } = build([
      full("a"),
      full("r", { fulfillPath: FulfillPath.ROUTE }),
      full("x", { status: OrderStatus.CANCELLED }),
    ]);
    const res = await svc.generate(["a", "r", "x", "foreign"]);
    expect(res.included).toEqual(["a"]);
    expect(res.skipped).toEqual([
      { orderId: "r", outcome: "NOT_CARRIER_ORDER" },
      { orderId: "x", outcome: "NOT_CONFIRMED" },
      { orderId: "foreign", outcome: "NOT_FOUND" },
    ]);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [key, , type] = storage.upload.mock.calls[0];
    expect(key).toMatch(/^packing-slips\/t1\/[0-9a-f-]{36}\.pdf$/);
    expect(type).toBe("application/pdf");
    expect(res.url).toBe(`https://signed/${key}`);
  });

  it("nothing includable -> url null and no upload", async () => {
    const { svc, storage } = build([]);
    const res = await svc.generate(["nope"]);
    expect(res).toEqual({
      url: null,
      included: [],
      skipped: [{ orderId: "nope", outcome: "NOT_FOUND" }],
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("reads through prisma.forTenant()", async () => {
    const { svc, findMany } = build([full("a")]);
    await svc.generate(["a"]);
    expect(findMany).toHaveBeenCalled();
  });

  it("throws (never writes under a literal 'none' prefix) when the tenant id is missing", async () => {
    const { svc, storage } = build([full("a")], null);
    await expect(svc.generate(["a"])).rejects.toThrow(/tenant/i);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("reads the customer's addresses with addressType and without a take:1 cut", async () => {
    const { svc, findMany } = build([full("a")]);
    await svc.generate(["a"]);
    const addr = findMany.mock.calls[0][0].select.customer.select.addresses;
    expect(addr.select.addressType).toBe(true);
    expect(addr.take).toBeUndefined();
  });
});
