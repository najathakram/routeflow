import { StripeService } from "./stripe.service";

// SA-733r M2 / r7 r-note (3): a tenant's open invoices are read ALL pages (a starting_after loop with a hard cap), and
// "owed" is open + uncollectible. Never silently truncated at the first page.
describe("StripeService invoice lists (paged)", () => {
  const page = (ids: string[], hasMore: boolean, created = 0) => ({
    data: ids.map((id, i) => ({ id, created: created + i })),
    has_more: hasMore,
  });
  function make(pages: Record<string, any[]>) {
    const list = jest.fn(async (args: any) => {
      const queue = pages[args.status];
      return queue.shift() ?? { data: [], has_more: false };
    });
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { invoices: { list } };
    return { svc, list };
  }

  it("follows has_more with starting_after until the last page", async () => {
    const { svc, list } = make({
      open: [page(["in_1", "in_2"], true, 10), page(["in_3"], false, 20)],
    });
    const rows = await svc.listOpenSubscriptionInvoices("sub_1");
    expect(rows.map((r) => r.id)).toEqual(["in_1", "in_2", "in_3"]);
    expect(list).toHaveBeenNthCalledWith(1, { subscription: "sub_1", status: "open", limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, {
      subscription: "sub_1",
      status: "open",
      limit: 100,
      starting_after: "in_2",
    });
  });

  it("stops at the hard page cap even if Stripe keeps saying has_more", async () => {
    const endless = Array.from({ length: 10 }, (_, i) => page([`in_${i}`], true, i));
    const { svc, list } = make({ open: endless });
    const rows = await svc.listOpenSubscriptionInvoices("sub_1", 3);
    expect(list).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
  });

  it("owed = open + uncollectible, oldest first", async () => {
    const { svc, list } = make({
      open: [page(["in_open"], false, 50)],
      uncollectible: [page(["in_unc"], false, 5)],
    });
    const rows = await svc.listOwedSubscriptionInvoices("sub_1");
    expect(rows.map((r) => r.id)).toEqual(["in_unc", "in_open"]);
    expect(list.mock.calls.map((c: any[]) => c[0].status).sort()).toEqual([
      "open",
      "uncollectible",
    ]);
  });
});
