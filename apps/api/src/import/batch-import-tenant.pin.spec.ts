/**
 * B1420 (SA-1503) R5, the class pin: EVERY entry point of BatchImportService and
 * VariantResolutionService refuses a caller with no tenant (403 TENANT_CONTEXT_REQUIRED) before it
 * touches prisma or a collaborator. A method added without the check turns this red.
 *
 * TypeScript `private` is compile-time only, so the runtime prototype also lists the internal
 * helpers. They are named in NOT_ENTRY_POINTS with a reason, never guessed from the source.
 */
import { ForbiddenException } from "@nestjs/common";
import { createMockPrisma } from "../testing/prisma-mock";
import { BatchImportService } from "./batch-import.service";
import { VariantResolutionService } from "./variant-resolution.service";

/** Entry points that legitimately take no tenant. Each needs a reason. Empty today (SA-1503). */
const NO_TENANT_METHODS: Record<string, string> = {};

/**
 * SA-B C2: private helpers, reached only after a public method's check. Explicit, count-pinned and
 * shrink-only: a new helper (or a new public method) must be classified here or carry the check, or
 * this pin goes red.
 */
const NOT_ENTRY_POINTS: Record<string, Record<string, string>> = {
  BatchImportService: {
    deriveStatus: "pure status derivation, no I/O",
    classifyAndPersist: "private; reached only from scanAndRecord after its check",
    annotateItem: "pure view annotation, no I/O",
    recomputeBatch: "private; reached only after a public method's loader has checked the tenant",
    getBatchOrThrow: "private loader; takes the tenantId its caller already checked",
    getItemOrThrow: "private loader; takes the tenantId its caller already checked",
  },
  VariantResolutionService: {},
};
const NOT_ENTRY_POINT_COUNT = 6;

function entryPoints(ctor: { prototype: object; name: string }): string[] {
  const helpers = NOT_ENTRY_POINTS[ctor.name] ?? {};
  return Object.getOwnPropertyNames(ctor.prototype).filter(
    (n) =>
      n !== "constructor" && typeof (ctor.prototype as any)[n] === "function" && !(n in helpers),
  );
}

/** Query calls only: every model delegate and transaction door; getTenantId is not a query. */
function callCount(prisma: any, ...collaborators: any[]): number {
  const seen = new Set<unknown>();
  let n = 0;
  const walk = (o: any, depth: number) => {
    if (!o || seen.has(o) || depth > 2) return;
    seen.add(o);
    for (const key of Object.keys(o)) {
      if (key === "getTenantId") continue;
      const v = o[key];
      if (jest.isMockFunction(v)) n += v.mock.calls.length;
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(prisma, 0);
  walk(prisma.forTenant(), 0);
  for (const c of collaborators) walk(c, 0);
  return n;
}

const noop = () => jest.fn().mockResolvedValue(undefined);

describe("B1420 R5 pin: every entry point refuses a tenantless caller", () => {
  const cases = [
    {
      label: "BatchImportService",
      ctor: BatchImportService,
      build: (prisma: any, collab: any) =>
        new BatchImportService(
          prisma,
          Object.assign(collab, {
            scanInvoice: noop(),
            create: noop(),
            receive: noop(),
            saveProductMapping: noop(),
          }) as any,
          { findVendorBillDuplicate: noop() } as any,
        ),
    },
    {
      label: "VariantResolutionService",
      ctor: VariantResolutionService,
      build: (prisma: any, collab: any) =>
        new VariantResolutionService(
          prisma,
          Object.assign(collab, { create: noop() }) as any,
          { learn: noop() } as any,
        ),
    },
  ];

  it.each(cases)("$label enumerates a non-empty entry-point surface", ({ ctor }) => {
    expect(entryPoints(ctor).length).toBeGreaterThanOrEqual(4);
  });

  it("NOT_ENTRY_POINTS is count-pinned, carries reasons, and names only real prototype members", () => {
    const total = Object.values(NOT_ENTRY_POINTS).reduce((n, m) => n + Object.keys(m).length, 0);
    expect(total).toBe(NOT_ENTRY_POINT_COUNT);
    for (const { ctor } of cases) {
      const onPrototype = new Set(Object.getOwnPropertyNames(ctor.prototype));
      for (const [name, reason] of Object.entries(NOT_ENTRY_POINTS[ctor.name] ?? {})) {
        expect(onPrototype.has(name)).toBe(true);
        expect(reason.length).toBeGreaterThan(10);
      }
    }
  });

  for (const { label, ctor, build } of cases) {
    for (const name of entryPoints(ctor)) {
      if (name in NO_TENANT_METHODS) continue;
      it(`${label}.${name} -> 403 TENANT_CONTEXT_REQUIRED, 0 query calls`, async () => {
        const prisma: any = createMockPrisma();
        prisma.getTenantId.mockReturnValue(null);
        const collab: any = {};
        const service: any = build(prisma, collab);
        const err: any = await Promise.resolve()
          .then(() => service[name]("id1", [], "f.pdf"))
          .then(
            () => null,
            (e) => e,
          );
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getResponse()).toMatchObject({ code: "TENANT_CONTEXT_REQUIRED" });
        expect(callCount(prisma, collab)).toBe(0);
        expect(prisma.getTenantId).toHaveBeenCalledTimes(1);
      });
    }
  }

  it("the no-tenant list is empty today, and every entry carries a reason", () => {
    expect(Object.keys(NO_TENANT_METHODS)).toEqual([]);
    for (const reason of Object.values(NO_TENANT_METHODS))
      expect(reason.length).toBeGreaterThan(10);
  });
});
