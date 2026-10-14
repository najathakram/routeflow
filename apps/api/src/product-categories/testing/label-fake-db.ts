import { Prisma } from "@prisma/client";

/**
 * A tiny in-memory stand-in for the four Prisma models the label write side touches. It applies the
 * REAL `where` filters the services pass (equality and `{ in: [...] }`, incl. `tenantId`) and the
 * nested `categoryLabels` select/where, so a spec built on it fails when a query drops its tenant
 * predicate or its parent/category filter — unlike a mock that returns whatever it was told.
 * Test support only (not a `.spec`, so Jest does not collect it).
 */
export interface FakeProduct {
  id: string;
  tenantId: string;
  name: string;
  parentProductId: string | null;
}
export interface FakeLabel {
  id: string;
  tenantId: string;
  productId: string;
  categoryId: string;
  mode: "INCLUDE" | "EXCLUDE";
  reason: string | null;
  parentProductIdAtWrite: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
}
export interface FakeCategory {
  id: string;
  tenantId: string;
  name: string;
  archivedAt: Date | null;
}

type Where = Record<string, unknown> | undefined;

function matches(row: Record<string, unknown>, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as object)) {
      return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      throw new Error(`label-fake-db: unsupported where operator on "${k}": ${JSON.stringify(v)}`);
    }
    return row[k] === v;
  });
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>) {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k] === true) out[k] = row[k];
  return out;
}

export class LabelFakeDb {
  products: FakeProduct[] = [];
  labels: FakeLabel[] = [];
  categories: FakeCategory[] = [];
  /** Every query issued, so a spec can assert on what was (not) asked. */
  calls: Array<{ model: string; op: string; args: any }> = [];
  /**
   * Active selling rules as `labelHasActiveFederalRule` reads them (already filtered to ACTIVE by the caller's where;
   * the fake honours only the jurisdiction and category filters).
   */
  rules: Array<{
    jurisdiction: string;
    categoryId: string | null;
    targets: Array<{
      productId: string | null;
      categoryId: string | null;
      addedAt: Date;
      removedAt: Date | null;
    }>;
  }> = [];
  /** When set, the advisory-lock statement rejects with it (simulates lock_timeout / a dead connection). */
  lockError: unknown = null;
  private seq = 0;

  private log(model: string, op: string, args: any) {
    this.calls.push({ model, op, args });
  }

  private labelRow(l: FakeLabel, args: any) {
    const base = pick(l as unknown as Record<string, unknown>, args?.select);
    if (args?.include?.category) {
      const c = this.categories.find((x) => x.id === l.categoryId)!;
      return { ...l, category: { name: c.name, archivedAt: c.archivedAt } };
    }
    return base;
  }

  private productRow(p: FakeProduct, args: any) {
    const out = pick(p as unknown as Record<string, unknown>, args?.select);
    const nested = args?.select?.categoryLabels;
    if (nested) {
      out.categoryLabels = this.labels
        .filter((l) => l.productId === p.id && matches(l as any, nested.where))
        .map((l) => pick(l as unknown as Record<string, unknown>, nested.select));
    }
    return out;
  }

  /** The object `prisma.forTenant()` and the `tenantTransaction` `tx` both resolve to. */
  get models() {
    return {
      product: {
        findFirst: async (args: any) => {
          const p = this.products.find((x) => matches(x as any, args?.where));
          return p ? this.productRow(p, args) : null;
        },
        findMany: async (args: any) => {
          return this.products
            .filter((x) => matches(x as any, args?.where))
            .map((p) => this.productRow(p, args));
        },
      },
      productCategory: {
        findFirst: async (args: any) => {
          return this.categories.find((x) => matches(x as any, args?.where)) ?? null;
        },
        findMany: async (args: any) => {
          return this.categories
            .filter((x) => matches(x as any, args?.where))
            .map((c) => pick(c as unknown as Record<string, unknown>, args?.select));
        },
      },
      sellingRestriction: {
        findMany: async (args: any) => {
          this.log("sellingRestriction", "findMany", args);
          // The one-label read narrows by category; the tenant-wide read (the card's list) takes every rule.
          const cat = args?.where?.AND?.[1]?.OR?.[0]?.categoryId;
          return this.rules
            .filter((r) => !args?.where?.jurisdiction || r.jurisdiction === args.where.jurisdiction)
            .filter(
              (r) => !cat || r.categoryId === cat || r.targets.some((t) => t.categoryId === cat),
            )
            .map((r) => ({
              ...r,
              targets: r.targets.filter((t) =>
                cat ? t.categoryId === cat : t.categoryId !== null,
              ),
              _count: { targets: r.targets.length },
            }));
        },
      },
      productCategoryLabel: {
        findFirst: async (args: any) => {
          const l = this.labels.find((x) => matches(x as any, args?.where));
          return l ? this.labelRow(l, args) : null;
        },
        findMany: async (args: any) => {
          return this.labels
            .filter((x) => matches(x as any, args?.where))
            .map((l) => this.labelRow(l, args));
        },
        create: async (args: any) => {
          const l: FakeLabel = {
            id: `l${++this.seq}`,
            reason: null,
            parentProductIdAtWrite: null,
            createdById: null,
            createdByName: null,
            createdAt: new Date("2026-09-20T00:00:00Z"),
            ...args.data,
          };
          if (
            this.labels.some((x) => x.productId === l.productId && x.categoryId === l.categoryId)
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              "unique violation (productId, categoryId)",
              {
                code: "P2002",
                clientVersion: "test",
              },
            );
          }
          this.labels.push(l);
          return this.labelRow(l, args);
        },
        update: async (args: any) => {
          const l = this.labels.find((x) => matches(x as any, args.where));
          if (!l) throw new Error("update: row not found");
          Object.assign(l, args.data);
          return this.labelRow(l, args);
        },
        deleteMany: async (args: any) => {
          const before = this.labels.length;
          this.labels = this.labels.filter((x) => !matches(x as any, args?.where));
          return { count: before - this.labels.length };
        },
      },
    };
  }

  /**
   * Wraps the raw models the way Prisma's tenant extension does: it LOGS the args the service passed
   * (before any injection, so a spec can see whether the service scoped a query itself), then injects
   * the ambient tenantId into `where` / `data`. `tenantId === null` (SUPER_ADMIN) = unscoped.
   */
  private scoped(tenantId: string | null) {
    const raw = this.models as Record<string, Record<string, (a: any) => Promise<any>>>;
    const out: Record<string, Record<string, (a: any) => Promise<any>>> = {};
    for (const [model, ops] of Object.entries(raw)) {
      out[model] = {};
      for (const [op, fn] of Object.entries(ops)) {
        out[model][op] = (args: any) => {
          this.log(model, op, JSON.parse(JSON.stringify(args ?? {})));
          if (!tenantId) return fn(args);
          const a = { ...(args ?? {}) };
          if (op === "create") a.data = { ...a.data, tenantId };
          else a.where = { ...(a.where ?? {}), tenantId };
          return fn(a);
        };
      }
    }
    return out as unknown as ReturnType<LabelFakeDb["rawModels"]>;
  }

  private rawModels() {
    return this.models;
  }

  /** A PrismaService look-alike bound to one ambient tenant (null = SUPER_ADMIN). */
  prisma(tenantId: string | null = "t1") {
    const models = this.scoped(tenantId);
    return {
      ...models,
      getTenantId: () => tenantId,
      forTenant: () => models,
      tenantTransaction: async (fn: (tx: any) => Promise<unknown>) => {
        // Roll the fake back if the callback throws, like a real transaction.
        const snap = this.labels.map((l) => ({ ...l }));
        try {
          return await fn({
            ...models,
            // Tagged-template call: (strings, ...values). Recorded so specs can assert the lock's
            // key and that it is taken before the first read.
            $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
              this.log("$executeRaw", strings.join("?"), values);
              if (this.lockError) throw this.lockError as Error;
              return 0;
            },
            $executeRawUnsafe: async (sql: string) => {
              this.log("$executeRawUnsafe", sql, []);
              return 0;
            },
            // lockLabelCategory reads the caller's lock_timeout to restore it after the lock.
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
              this.log("$queryRaw", strings.join("?"), values);
              return [{ lock_timeout: "0" }];
            },
          });
        } catch (e) {
          this.labels = snap;
          throw e;
        }
      },
    } as any;
  }

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────
  addProduct(id: string, parentProductId: string | null = null, tenantId = "t1") {
    this.products.push({ id, tenantId, name: `Product ${id}`, parentProductId });
    return this;
  }
  addCategory(id: string, name = id, tenantId = "t1", archivedAt: Date | null = null) {
    this.categories.push({ id, tenantId, name, archivedAt });
    return this;
  }
  addLabel(
    productId: string,
    categoryId: string,
    mode: "INCLUDE" | "EXCLUDE",
    parentProductIdAtWrite: string | null = null,
    tenantId = "t1",
  ) {
    const id = `seed${++this.seq}`;
    this.labels.push({
      id,
      tenantId,
      productId,
      categoryId,
      mode,
      reason: mode === "EXCLUDE" ? "seed" : null,
      parentProductIdAtWrite,
      createdById: null,
      createdByName: null,
      createdAt: new Date("2026-09-19T00:00:00Z"),
    });
    return id;
  }
  label(productId: string, categoryId: string) {
    return this.labels.find((l) => l.productId === productId && l.categoryId === categoryId);
  }
}
