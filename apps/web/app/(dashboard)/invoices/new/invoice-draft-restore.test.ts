import { sanitizeSnapshot } from "@/lib/invoice-draft-storage";
import { checkDraftReferences } from "./invoice-draft-restore";

const snap = (lines: Array<Record<string, unknown>>, customer = true) =>
  sanitizeSnapshot({
    basis: "standalone",
    customer: customer ? { id: "c-1", businessName: "Acme Co" } : null,
    lines,
  })!;
const line = (productId: string) => ({
  productId,
  description: productId,
  qty: 1,
  unitPrice: 5,
  discount: 0,
  taxable: false,
});

type Res = { data?: unknown } | { reject: unknown };
function getter(map: Record<string, Res>) {
  return (url: string) => {
    const r = map[url] ?? { data: {} };
    return "reject" in r ? Promise.reject(r.reject) : Promise.resolve(r);
  };
}
const status = (s: number) => ({ reject: { response: { status: s } } });

describe("checkDraftReferences: what counts as gone (ROW 447)", () => {
  it("an inactive product is dropped", async () => {
    const r = await checkDraftReferences(
      snap([line("p-off"), line("p-on")]),
      getter({
        "/products/p-off": { data: { id: "p-off", isActive: false } },
        "/products/p-on": { data: { id: "p-on", isActive: true } },
      }),
    );
    expect(r.snapshot.lines.map((l) => l.productId)).toEqual(["p-on"]);
    expect(r.droppedLines).toBe(1);
  });

  it("a soft-deleted or archived product is dropped", async () => {
    const r = await checkDraftReferences(
      snap([line("p-del"), line("p-arc")]),
      getter({
        "/products/p-del": { data: { id: "p-del", deletedAt: "2026-01-01T00:00:00Z" } },
        "/products/p-arc": { data: { id: "p-arc", archivedAt: "2026-01-01T00:00:00Z" } },
      }),
    );
    expect(r.snapshot.lines).toHaveLength(0);
    expect(r.droppedLines).toBe(2);
  });

  it.each([403, 404, 410])("a %i on a product drops the line", async (s) => {
    const r = await checkDraftReferences(
      snap([line("p-x")]),
      getter({ "/products/p-x": status(s) }),
    );
    expect(r.droppedLines).toBe(1);
  });

  it("a soft-deleted customer is cleared", async () => {
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", deletedAt: "2026-01-01" } },
      }),
    );
    expect(r.customerCleared).toBe(true);
    expect(r.snapshot.customer).toBeNull();
    expect(r.snapshot.lines).toHaveLength(1);
  });

  it("an inactive customer is cleared", async () => {
    const r = await checkDraftReferences(
      snap([]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", isActive: false } },
      }),
    );
    expect(r.customerCleared).toBe(true);
  });

  it.each([403, 404, 410])("a %i on the customer clears it", async (s) => {
    const r = await checkDraftReferences(snap([]), getter({ "/customers/c-1": status(s) }));
    expect(r.customerCleared).toBe(true);
  });

  it("a network failure keeps both the customer and the line", async () => {
    const off = { reject: new Error("offline") };
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({ "/customers/c-1": off, "/products/p-1": off }),
    );
    expect(r.customerCleared).toBe(false);
    expect(r.droppedLines).toBe(0);
    expect(r.snapshot.customer?.id).toBe("c-1");
  });

  it("a live product and customer are kept", async () => {
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", deletedAt: null } },
        "/products/p-1": { data: { id: "p-1", isActive: true, deletedAt: null } },
      }),
    );
    expect(r.droppedLines).toBe(0);
    expect(r.customerCleared).toBe(false);
  });
});
