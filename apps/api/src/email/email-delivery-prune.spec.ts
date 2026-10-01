import { readFileSync } from "fs";
import { join } from "path";
import { EmailDeliveryPruneService } from "./email-delivery-prune.service";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T03:00:00Z");

/**
 * Real bounded batching: per tenant+predicate, select ids with `take: 5000` through
 * `prisma.emailDelivery.findMany`, then `deleteMany({ where: { id: { in } } })` (plus the tenantId),
 * looping until a select returns no rows. `batches` lets a spec script the successive selects.
 */
function make(
  tenantIds: string[] = ["t1"],
  opts: { batches?: string[][]; deleteImpl?: jest.Mock } = {},
) {
  const queue = [...(opts.batches ?? [])];
  const findMany = jest.fn(async () => (queue.shift() ?? []).map((id) => ({ id })));
  const deleteMany =
    opts.deleteImpl ??
    jest.fn(async (a: any) => ({
      count: Array.isArray(a?.where?.id?.in) ? a.where.id.in.length : 0,
    }));
  const emailDelivery = { deleteMany, findMany };
  const prisma = {
    tenant: { findMany: jest.fn().mockResolvedValue(tenantIds.map((id) => ({ id }))) },
    emailDelivery,
    forTenant: jest.fn().mockReturnValue({ emailDelivery }),
    $executeRaw: jest.fn().mockResolvedValue(0),
  } as any;
  return { svc: new EmailDeliveryPruneService(prisma), deleteMany, findMany, prisma };
}

/** Flatten a where clause (incl. OR/AND branches) to the candidate leaf objects. */
function leaves(where: any): any[] {
  if (!where) return [];
  const out: any[] = [where];
  for (const k of ["OR", "AND"]) {
    if (Array.isArray(where[k])) for (const w of where[k]) out.push(...leaves(w));
  }
  return out;
}

describe("EmailDeliveryPruneService.prune", () => {
  it("non-Invoice cutoff is 90 days, Invoice cutoff is 2 years", async () => {
    const { svc, findMany } = make();
    await svc.prune(NOW);
    const all = findMany.mock.calls.flatMap((c: any[]) => leaves(c[0].where));
    const cutoffs = all
      .map((w) => w.createdAt?.lt as Date | undefined)
      .filter((d): d is Date => d instanceof Date)
      .map((d) => Math.round((NOW.getTime() - d.getTime()) / DAY));
    // 89d row survives, 91d row is deleted for non-invoice: cutoff must be exactly 90d.
    expect(cutoffs).toContain(90);
    // 729d survives, 731d deleted for invoices: cutoff ~730d (2 years, leap-tolerant).
    expect(cutoffs.some((d) => d >= 729 && d <= 731)).toBe(true);
  });

  it("89-day-old non-Invoice row is outside the delete window, 91-day-old inside", async () => {
    const { svc, findMany } = make();
    await svc.prune(NOW);
    const nonInvoice = findMany.mock.calls
      .flatMap((c: any[]) => leaves(c[0].where))
      .filter((w) => w.entityType && typeof w.entityType === "object" && "not" in w.entityType);
    expect(nonInvoice.length).toBeGreaterThan(0);
    for (const w of nonInvoice) {
      expect(w.entityType.not).toBe("Invoice");
      const cutoff: Date = w.createdAt.lt;
      const age = (d: number) => new Date(NOW.getTime() - d * DAY);
      expect(age(89) < cutoff).toBe(false);
      expect(age(91) < cutoff).toBe(true);
    }
  });

  it("729-day-old Invoice row survives, 731-day-old is deleted", async () => {
    const { svc, findMany } = make();
    await svc.prune(NOW);
    const invoice = findMany.mock.calls
      .flatMap((c: any[]) => leaves(c[0].where))
      .filter((w) => w.entityType === "Invoice");
    expect(invoice.length).toBeGreaterThan(0);
    for (const w of invoice) {
      const cutoff: Date = w.createdAt.lt;
      const age = (d: number) => new Date(NOW.getTime() - d * DAY);
      expect(age(729) < cutoff).toBe(false);
      expect(age(731) < cutoff).toBe(true);
    }
  });

  it("selects at most 5000 ids per statement and loops until none remain", async () => {
    const full = Array.from({ length: 5000 }, (_, i) => `id${i}`);
    const { svc, findMany, deleteMany } = make(["t1"], {
      batches: [full, ["x1", "x2", "x3"]],
    });
    const out = await svc.prune(NOW);
    expect(out.deleted).toBe(5003);
    for (const c of findMany.mock.calls as any[][]) {
      expect(c[0].take).toBe(5000);
      expect(c[0].select).toEqual({ id: true });
    }
    for (const c of deleteMany.mock.calls as any[][]) {
      expect(c[0].where.id.in.length).toBeLessThanOrEqual(5000);
      expect(c[0].where.tenantId).toBe("t1");
    }
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("never crosses tenants: every delete is scoped to exactly one tenantId", async () => {
    const { svc, findMany } = make(["t1", "t2"]);
    await svc.prune(NOW);
    const seen = new Set<string>();
    for (const c of findMany.mock.calls as any[][]) {
      const tenantIds = leaves(c[0].where)
        .map((w) => w.tenantId)
        .filter((v) => typeof v === "string");
      expect(tenantIds.length).toBeGreaterThan(0);
      for (const id of tenantIds) seen.add(id);
    }
    expect([...seen].sort()).toEqual(["t1", "t2"]);
  });

  it("one tenant failing does not stop the others", async () => {
    const deleteMany = jest
      .fn()
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValue({ count: 1 });
    const { svc, findMany } = make(["t1", "t2"], {
      deleteImpl: deleteMany,
      batches: [["a"], [], ["b"], [], ["c"], []],
    });
    await expect(svc.prune(NOW)).resolves.toEqual(
      expect.objectContaining({ deleted: expect.any(Number) }),
    );
    expect(deleteMany.mock.calls.length).toBeGreaterThan(1);
    expect(findMany.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("EmailDeliveryPruneService cron wiring", () => {
  const src = readFileSync(join(__dirname, "email-delivery-prune.service.ts"), "utf8");

  it('is decorated @LeaderCron("0 3 * * *", "email.pruneDeliveries")', () => {
    expect(src).toMatch(/@LeaderCron\(\s*"0 3 \* \* \*"\s*,\s*"email\.pruneDeliveries"\s*\)/);
  });

  it("never uses a bare @Cron(", () => {
    expect(src).not.toMatch(/@Cron\(/);
  });
});
