import { Prisma } from "@prisma/client";

/**
 * SA-1110 (B929, replaces SA-620's one-level predicate): the ONE place that reads a write payload's nested relation
 * writes, at every depth. Pure: no Nest, no Prisma client, only the DMMF. Two functions over one traversal:
 *
 * - `stampNestedTenant`: under a TENANT context, writes the context's tenant into every tenant-owned nested create.
 * - `findNestedTenantGaps`: reports every tenant-owned nested create that names no tenant (tenantless contexts, and a
 *   walker miss under TENANT), as relation paths without indices or payload words (`VendorBill.items`, `A.items.sub`),
 *   so the guard's counter key stays bounded.
 *
 * Traversal: for each key of the payload that is a relation of the current model, visit `create` (object or list),
 * `createMany.data`, `connectOrCreate[].create`, `upsert[].create` and `upsert[].update`, `update[].data` / `update.data`
 * and recurse into each visited child with the child's model. Only a `create`-kind payload is judged or stamped (an
 * update of an existing child never moves its tenant); update payloads are only searched for creates below them.
 * Scalars, `connect`, `set`, `disconnect`, `delete*` and `updateMany` (scalars only) are not payloads.
 */
export interface RelationInfo {
  child: string;
  childIsTenantOwned: boolean;
  /** The child has a relation field named `tenant` (the checked-input way to name a tenant). */
  childHasTenantRelation: boolean;
  /** The child's relation fields that hold the FK (what `relationFromFields` names), `tenant` excluded. */
  owningRelationKeys: ReadonlySet<string>;
}
/** model name -> relation field name -> what the relation points at. */
export type RelationIndex = ReadonlyMap<string, ReadonlyMap<string, RelationInfo>>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const hasField = (m: Prisma.DMMF.Model | undefined, name: string, kind: string): boolean =>
  (m?.fields ?? []).some((f) => f.name === name && f.kind === kind);

/**
 * The generated client's runtime DMMF (`Prisma.dmmf`) carries only `name`, `kind`, `type` and `relationName` per field:
 * no `relationFromFields`. A relation `R` holds the FK when the model has the scalar `<R>Id`, or when `Model.R` is listed
 * here (an FK scalar that is not named after its relation). `tenant-nested-walker.spec.ts` reads the schema folder and
 * fails on any relation this rule gets wrong, so a new unconventional FK name is caught the day it lands.
 */
const OWNING_WITH_OTHER_FK_NAME: ReadonlySet<string> = new Set([
  "Product.parent",
  "ProductUnit.parent",
  "Recipe.family",
  "Order.orderTemplate",
  "CommissionStatementLine.carriedFrom",
  "BuyerMergeRequest.initiatingTenant",
]);

function holdsFk(m: Prisma.DMMF.Model, f: Prisma.DMMF.Field): boolean {
  if ((f.relationFromFields?.length ?? 0) > 0) return true; // a full DMMF (specs) says so itself
  return (
    hasField(m, `${f.name}Id`, "scalar") || OWNING_WITH_OTHER_FK_NAME.has(`${m.name}.${f.name}`)
  );
}

function build(models: readonly Prisma.DMMF.Model[]): RelationIndex {
  const byName = new Map(models.map((m) => [m.name, m]));
  const index = new Map<string, Map<string, RelationInfo>>();
  for (const m of models) {
    const rels = new Map<string, RelationInfo>();
    for (const f of m.fields) {
      if (f.kind !== "object") continue;
      const child = byName.get(f.type);
      const owning = (child?.fields ?? []).filter(
        (c) => c.kind === "object" && c.name !== "tenant" && child && holdsFk(child, c),
      );
      rels.set(f.name, {
        child: f.type,
        childIsTenantOwned: hasField(child, "tenantId", "scalar"),
        childHasTenantRelation: hasField(child, "tenant", "object"),
        owningRelationKeys: new Set(owning.map((c) => c.name)),
      });
    }
    if (rels.size > 0) index.set(m.name, rels);
  }
  return index;
}

let defaultIndex: RelationIndex | undefined;
/** The index over the generated client's DMMF, built once; a custom model list (specs) is never cached. */
export function buildRelationIndex(models?: readonly Prisma.DMMF.Model[]): RelationIndex {
  if (models) return build(models);
  return (defaultIndex ??= build(Prisma.dmmf.datamodel.models));
}

/**
 * A row names its tenant by a non-empty `tenantId` or by a `tenant` relation. An absent key, `undefined`, `null` and
 * "" all write NULL (the L-124 class), so they are all "missing". The one predicate, shared with the guard.
 */
export const lacksTenant = (d: unknown): boolean => {
  if (!d || typeof d !== "object") return true;
  const row = d as { tenantId?: unknown; tenant?: unknown };
  if (row.tenant !== undefined && row.tenant !== null) return false;
  return row.tenantId === undefined || row.tenantId === null || row.tenantId === "";
};

/** Called for every `create`-kind child payload; returns the payload to keep (the stamper returns a copy). */
type Visit = (info: RelationInfo, payload: Obj, createMany: boolean, path: string) => Obj;

/** Copy-on-write map: the same array comes back when no element changed. */
function mapOne(v: unknown, fn: (x: unknown) => unknown): unknown {
  if (!Array.isArray(v)) return fn(v);
  const next = v.map(fn);
  return next.every((x, i) => x === v[i]) ? v : next;
}

function walkRow(model: string, row: unknown, index: RelationIndex, visit: Visit, path: string) {
  const rels = index.get(model);
  if (!rels || !isObj(row)) return row;
  let out: Obj | undefined;
  for (const [key, ops] of Object.entries(row)) {
    const info = rels.get(key);
    if (!info || !isObj(ops)) continue;
    const next = walkOps(info, ops, index, visit, `${path}.${key}`);
    if (next !== ops) (out ??= { ...row })[key] = next;
  }
  return out ?? row;
}

function walkOps(info: RelationInfo, ops: Obj, index: RelationIndex, visit: Visit, path: string) {
  let out: Obj | undefined;
  const put = (key: string, value: unknown) => {
    if (value !== ops[key]) (out ??= { ...ops })[key] = value;
  };
  const created = (payload: unknown, createMany = false): unknown => {
    if (!isObj(payload)) return payload;
    return walkRow(info.child, visit(info, payload, createMany, path), index, visit, path);
  };
  const updated = (payload: unknown): unknown => walkRow(info.child, payload, index, visit, path);
  // `update` is `{ where?, data }` or, on a to-one relation, the data itself.
  const updateItem = (item: unknown): unknown => {
    if (
      !isObj(item) ||
      !isObj(item.data) ||
      !Object.keys(item).every((k) => k === "where" || k === "data")
    ) {
      return updated(item);
    }
    const data = updated(item.data);
    return data === item.data ? item : { ...item, data };
  };

  if (ops.create !== undefined)
    put(
      "create",
      mapOne(ops.create, (c) => created(c)),
    );
  if (isObj(ops.createMany) && ops.createMany.data !== undefined) {
    const data = mapOne(ops.createMany.data, (c) => created(c, true));
    if (data !== ops.createMany.data) put("createMany", { ...ops.createMany, data });
  }
  if (ops.connectOrCreate !== undefined) {
    put(
      "connectOrCreate",
      mapOne(ops.connectOrCreate, (item) => {
        if (!isObj(item)) return item;
        const create = created(item.create);
        return create === item.create ? item : { ...item, create };
      }),
    );
  }
  if (ops.upsert !== undefined) {
    put(
      "upsert",
      mapOne(ops.upsert, (item) => {
        if (!isObj(item)) return item;
        const create = created(item.create);
        const update = updateItem(item.update);
        return create === item.create && update === item.update
          ? item
          : { ...item, create, update };
      }),
    );
  }
  if (ops.update !== undefined) put("update", mapOne(ops.update, updateItem));
  return out ?? ops;
}

/** The tenant a stamped child names: rules 1-4, first hit wins. Context wins over any explicit value. */
function stampRow(info: RelationInfo, row: Obj, tenantId: string, createMany: boolean): Obj {
  const connect = { connect: { id: tenantId } };
  const checked = { ...row };
  delete checked.tenantId; // Prisma refuses a scalar tenantId beside a relation key
  // 1. the child already holds a tenant relation key
  if ("tenant" in row && info.childHasTenantRelation) return { ...checked, tenant: connect };
  // 2. createMany takes scalars only
  if (createMany) return { ...row, tenantId };
  // 3. an owning relation in checked form: Prisma's checked input has no `tenantId`
  if (info.childHasTenantRelation && [...info.owningRelationKeys].some((k) => isObj(row[k]))) {
    return { ...checked, tenant: connect };
  }
  // 4. otherwise the scalar
  return { ...row, tenantId };
}

/** `data` with the context's tenant written into every tenant-owned nested create. Never mutates `data`. */
export function stampNestedTenant(
  model: string,
  data: unknown,
  tenantId: string,
  rel: RelationIndex = buildRelationIndex(),
): any {
  const visit: Visit = (info, payload, createMany) =>
    info.childIsTenantOwned ? stampRow(info, payload, tenantId, createMany) : payload;
  return mapOne(data, (row) => walkRow(model, row, rel, visit, model));
}

/** Relation paths (`Model.rel.rel`) of every tenant-owned nested create that names no tenant, deduped. */
export function findNestedTenantGaps(
  model: string,
  data: unknown,
  rel: RelationIndex = buildRelationIndex(),
): string[] {
  const gaps = new Set<string>();
  const visit: Visit = (info, payload, _createMany, path) => {
    if (info.childIsTenantOwned && lacksTenant(payload)) gaps.add(path);
    return payload;
  };
  mapOne(data, (row) => walkRow(model, row, rel, visit, model));
  return [...gaps];
}
