import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * SA-620 B1: ONE DMMF-driven walker for NESTED relation writes. The tenant extension stamps `tenantId` on
 * a top-level `data`; a child created through `items: { create | createMany | connectOrCreate | upsert }`
 * used to pass through untouched, so a child model with a NULLABLE tenantId got NULL and every later
 * tenant-scoped child query silently skipped it. This walks `args.data` through the relation fields the
 * generated data model declares (never a hand-typed list: a new child model is covered automatically):
 *  - `stampNestedTenant`: the TENANT path; returns new data with each nested tenant-owned create stamped;
 *  - `findNestedWithoutTenant`: the SA-619 non-TENANT check; lists nested tenant-owned creates that name
 *    no tenant (the same walk, so the two cannot drift).
 * The input is never mutated (copy-on-write along changed branches). An explicit tenantId that differs
 * from the context, or nesting deeper than MAX_DEPTH, THROWS (fail loud, naming the path).
 */
export class NestedTenantWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NestedTenantWalkError";
  }
}

const MAX_DEPTH = 8;

interface ModelTable {
  tenantOwned: boolean;
  /** relation field name -> target model name */
  relations: Map<string, string>;
}

let tables: Map<string, ModelTable> | null = null;
let builds = 0;

function buildTables(): Map<string, ModelTable> {
  if (tables) return tables;
  builds++;
  const models: Array<{
    name: string;
    fields: Array<{ name: string; kind: string; type: string }>;
  }> = (Prisma as any).dmmf?.datamodel?.models ?? [];
  const t = new Map<string, ModelTable>();
  for (const m of models) {
    t.set(m.name, {
      tenantOwned: m.fields.some((f) => f.name === "tenantId"),
      relations: new Map(m.fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type])),
    });
  }
  // An empty table would make every nested write pass silently (e.g. a generator without `Prisma.dmmf`).
  if (t.size === 0)
    new Logger("TenantContext").error(
      "Prisma.dmmf exposes no models: the SA-619/SA-620 tenant checks are INACTIVE",
    );
  tables = t;
  return t;
}

/** How many times the DMMF tables were built (a memoization pin: once per process). */
export function walkTablesBuiltCount(): number {
  return builds;
}

/** True when the model carries a `tenantId` column (the ONE list: derived from the data model). */
export function isTenantOwnedModel(model: string): boolean {
  return buildTables().get(model)?.tenantOwned ?? false;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

type Visit = (
  model: string,
  payload: Record<string, unknown>,
  path: string,
) => Record<string, unknown>;

/** `throw`: stamping must never silently stop (fail loud). `stop`: the dark check reports and never breaks a write. */
type DepthMode = "throw" | "stop";

/** Walk one model's data object: every relation key's write operations, recursively. */
function walkData(
  model: string,
  data: unknown,
  visit: Visit,
  path: string,
  depth: number,
  mode: DepthMode,
): unknown {
  if (!isObj(data)) return data;
  if (depth > MAX_DEPTH) {
    if (mode === "stop") return data;
    throw new NestedTenantWalkError(
      `nested write exceeds the depth limit of ${MAX_DEPTH} relations at ${path}: refusing to leave rows unstamped`,
    );
  }
  // A child created through a Tenant relation gets its tenant from the relation itself (the Prisma
  // `*WithoutTenant` create inputs have no tenantId scalar): nothing to stamp or check below a Tenant.
  if (model === "Tenant") return data;
  const table = buildTables().get(model);
  if (!table) return data;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(data)) {
    const target = table.relations.get(key);
    if (!target || !isObj(value)) continue;
    const next = walkOps(target, value, visit, `${path}.${key}`, depth + 1, mode);
    if (next !== value) (out ??= { ...data })[key] = next;
  }
  return out ?? data;
}

/** One relation's write operations (`create`, `createMany`, `connectOrCreate`, `upsert`, `update`, ...). */
function walkOps(
  target: string,
  ops: Record<string, unknown>,
  visit: Visit,
  path: string,
  depth: number,
  mode: DepthMode,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  const set = (k: string, v: unknown) => {
    if (v !== ops[k]) (out ??= { ...ops })[k] = v;
  };
  const each = (v: unknown, f: (item: unknown, p: string) => unknown, p: string) =>
    Array.isArray(v) ? v.map((x, i) => f(x, `${p}[${i}]`)) : f(v, p);
  const changed = (a: unknown, b: unknown) =>
    Array.isArray(a) ? a.some((x, i) => x !== (b as unknown[])[i]) : a !== b;
  const child = (payload: unknown, p: string): unknown => {
    if (!isObj(payload)) return payload;
    const stamped = visit(target, payload, p);
    return walkData(target, stamped, visit, p, depth, mode);
  };

  for (const op of Object.keys(ops)) {
    const v = ops[op];
    const p = `${path}.${op}`;
    if (op === "create") {
      const next = each(v, child, p);
      if (changed(v, next)) set(op, next);
    } else if (op === "createMany" && isObj(v)) {
      const rows = each(v.data, child, `${p}.data`);
      if (changed(v.data, rows)) set(op, { ...v, data: rows });
    } else if (op === "connectOrCreate") {
      const next = each(
        v,
        (e, ep) => {
          if (!isObj(e)) return e;
          const c = child(e.create, `${ep}.create`);
          return c === e.create ? e : { ...e, create: c };
        },
        p,
      );
      if (changed(v, next)) set(op, next);
    } else if (op === "upsert") {
      const next = each(
        v,
        (e, ep) => {
          if (!isObj(e)) return e;
          const c = child(e.create, `${ep}.create`);
          const u = walkData(target, e.update, visit, `${ep}.update`, depth, mode);
          return c === e.create && u === e.update ? e : { ...e, create: c, update: u };
        },
        p,
      );
      if (changed(v, next)) set(op, next);
    } else if (op === "update" || op === "updateMany") {
      const next = each(
        v,
        (e, ep) => {
          if (!isObj(e)) return e;
          if (isObj(e.data)) {
            const d = walkData(target, e.data, visit, `${ep}.data`, depth, mode);
            return d === e.data ? e : { ...e, data: d };
          }
          // to-one `update: { ...data }` shorthand
          return op === "update" ? walkData(target, e, visit, ep, depth, mode) : e;
        },
        p,
      );
      if (changed(v, next)) set(op, next);
    }
    // connect / disconnect / set / delete / deleteMany: nothing to stamp.
  }
  return out ?? ops;
}

/**
 * The TENANT path: returns `data` with every nested tenant-owned create stamped with `tenantId`.
 * An explicit tenantId on a child that differs from `tenantId` throws (a cross-tenant write).
 */
export function stampNestedTenant(model: string, data: unknown, tenantId: string): any {
  return walkData(
    model,
    data,
    (childModel, payload, path) => {
      if (!isTenantOwnedModel(childModel)) return payload;
      const given = payload.tenantId;
      if (given !== undefined && given !== null && given !== tenantId)
        throw new NestedTenantWalkError(
          `cross-tenant nested write: ${childModel} at ${path} carries a tenantId that differs from the tenant context`,
        );
      return given === tenantId ? payload : { ...payload, tenantId };
    },
    "data",
    0,
    "throw",
  );
}

/**
 * The non-TENANT check (SA-619): the nested tenant-owned creates in `data` that name no tenant. An
 * explicit `tenantId: null` is a deliberate platform row; an absent key / `undefined` is the omission.
 */
export function findNestedWithoutTenant(
  model: string,
  data: unknown,
): Array<{ model: string; path: string }> {
  const found: Array<{ model: string; path: string }> = [];
  walkData(
    model,
    data,
    (childModel, payload, path) => {
      if (isTenantOwnedModel(childModel) && payload.tenantId === undefined)
        found.push({ model: childModel, path });
      return payload;
    },
    "data",
    0,
    "stop",
  );
  return found;
}
