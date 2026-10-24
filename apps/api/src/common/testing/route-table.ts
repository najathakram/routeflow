import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "../../auth/decorators/roles.decorator";

/**
 * SA-776: a static, DB-free route table over the Nest module graph. It walks `imports` / `controllers`
 * metadata from a root module (dynamic modules and forwardRefs resolved) and reads each handler's route and
 * guard metadata with `Reflect.getMetadata`. Nothing is instantiated, so no Postgres / Redis is needed and
 * every REGISTERED controller is seen — not only the ones a file-name glob would find.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctor = abstract new (...args: any[]) => unknown;

/** The auth context a route's guards give it (what the global TenantStatusGuard / buyer guard cover). */
export type AuthContext = "SUPER_ADMIN" | "BUYER_SELLER" | "BUYER_ACCOUNT" | "STAFF" | "NONE";

export interface RouteRecord {
  controller: string;
  handler: string;
  /** Upper-case verb (GET / POST / PUT / PATCH / DELETE / ALL / ...). */
  method: string;
  /** The full routed path, global prefix included, e.g. `/api/v1/orders/:id/receipt`. */
  path: string;
  /** Guard class names, class level then handler level, de-duplicated. */
  guards: string[];
  /** `@Roles(...)` on the handler, else the class (undefined when none). */
  roles: string[] | undefined;
  context: AuthContext;
  mutating: boolean;
}

export const GLOBAL_PREFIX = "/api/v1";

const READ_VERBS = new Set(["GET", "HEAD", "OPTIONS"]);

function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
  return `/${joined}`;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function guardName(g: unknown): string {
  if (typeof g === "function") return g.name;
  const ctor = (g as { constructor?: { name?: string } } | null)?.constructor;
  return ctor?.name ?? String(g);
}

export function authContextOf(guards: readonly string[]): AuthContext {
  if (guards.includes("SuperAdminGuard")) return "SUPER_ADMIN";
  if (guards.includes("BuyerSellerContextGuard")) return "BUYER_SELLER";
  if (guards.includes("BuyerJwtAuthGuard")) return "BUYER_ACCOUNT";
  if (guards.includes("JwtAuthGuard")) return "STAFF";
  return "NONE";
}

interface ResolvedModule {
  cls: Ctor;
  imports: unknown[];
  controllers: Ctor[];
}

function resolveModule(m: unknown): ResolvedModule | null {
  let ref: unknown = m;
  if (ref && typeof ref === "object" && "forwardRef" in ref) {
    ref = (ref as { forwardRef: () => unknown }).forwardRef();
  }
  if (ref && typeof ref === "object" && "module" in ref) {
    const dyn = ref as { module: Ctor; imports?: unknown[]; controllers?: Ctor[] };
    return {
      cls: dyn.module,
      imports: [...(Reflect.getMetadata("imports", dyn.module) ?? []), ...(dyn.imports ?? [])],
      controllers: [
        ...(Reflect.getMetadata("controllers", dyn.module) ?? []),
        ...(dyn.controllers ?? []),
      ],
    };
  }
  if (typeof ref === "function") {
    return {
      cls: ref as Ctor,
      imports: Reflect.getMetadata("imports", ref) ?? [],
      controllers: Reflect.getMetadata("controllers", ref) ?? [],
    };
  }
  return null; // a Promise (async dynamic module) or something unrecognised
}

/** Every controller class registered anywhere under `root`, each once. */
export function collectControllers(root: unknown): Ctor[] {
  const seen = new Set<Ctor>();
  const controllers = new Set<Ctor>();
  const walk = (m: unknown) => {
    const r = resolveModule(m);
    if (!r || seen.has(r.cls)) return;
    seen.add(r.cls);
    for (const c of r.controllers) controllers.add(c);
    for (const i of r.imports) walk(i);
  };
  walk(root);
  return [...controllers];
}

/** Own methods up the prototype chain; reads descriptors so a getter (`get uploadDir()`) is never invoked. */
function handlersOf(ctrl: Ctor): Array<[string, (...args: unknown[]) => unknown]> {
  const out = new Map<string, (...args: unknown[]) => unknown>();
  for (let p = ctrl.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) {
      if (n === "constructor" || out.has(n)) continue;
      const v = Object.getOwnPropertyDescriptor(p, n)?.value;
      if (typeof v === "function") out.set(n, v as (...args: unknown[]) => unknown);
    }
  }
  return [...out];
}

/** Every routed handler of one controller (reads and writes). */
export function routesOf(ctrl: Ctor, prefix: string = GLOBAL_PREFIX): RouteRecord[] {
  const out: RouteRecord[] = [];
  const basePaths = asArray<string>(Reflect.getMetadata(PATH_METADATA, ctrl) ?? "");
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];
  for (const [name, fn] of handlersOf(ctrl)) {
    const method = Reflect.getMetadata(METHOD_METADATA, fn);
    if (method === undefined) continue;
    const verb = RequestMethod[method as number];
    const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, fn) ?? [];
    const guards = [...new Set([...classGuards, ...handlerGuards].map(guardName))];
    const roles: string[] | undefined =
      Reflect.getMetadata(ROLES_KEY, fn) ?? Reflect.getMetadata(ROLES_KEY, ctrl);
    const methodPaths = asArray<string>(Reflect.getMetadata(PATH_METADATA, fn) ?? "");
    for (const base of basePaths) {
      for (const mp of methodPaths) {
        out.push({
          controller: ctrl.name,
          handler: name,
          method: verb,
          path: joinPath(prefix, base, mp),
          guards,
          roles,
          context: authContextOf(guards),
          mutating: !READ_VERBS.has(verb),
        });
      }
    }
  }
  return out;
}

export function routeTableOf(root: unknown, prefix: string = GLOBAL_PREFIX): RouteRecord[] {
  return collectControllers(root)
    .flatMap((c) => routesOf(c, prefix))
    .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** A concrete URL for a declared path: every `:param` becomes a UUID, so UUID-anchored patterns match. */
export function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "0b1f2c3d-aaaa-4bbb-8ccc-1234567890ab");
}

// ── SA-776: classification of every mutating route against the read-only registries ──────────────────────────────

export interface RouteRegistries {
  allowList: ReadonlyArray<{ method: string; pattern: RegExp; reason: string }>;
  buyerAccountWrites: ReadonlyArray<{ route: string; reason: string }>;
  publicWrites: ReadonlyArray<{ route: string; reason: string }>;
}

export type RouteClass =
  | "STAFF_GUARDED"
  | "STAFF_ALLOW_LISTED"
  | "SUPER_ADMIN"
  | "BUYER_SELLER_GUARDED"
  | "BUYER_ACCOUNT"
  | "PUBLIC"
  | "UNCLASSIFIED";

export interface ClassifiedRow {
  route: RouteRecord;
  key: string;
  klass: RouteClass;
  reason: string;
}

// `/platform-admin/...` and `/<area>/admin/...` (billing/admin/plans); NOT `/users/:id/admin` (a tenant toggle).
const SUPER_ADMIN_PATH = /^\/api\/v1\/(platform-admin|[a-z-]+\/admin)(\/|$)/;

/** A route that CLAIMS to be super-admin only (by `@Roles` or by an admin path) must carry `SuperAdminGuard`. */
export function claimsSuperAdmin(r: RouteRecord): boolean {
  const onlySuperAdminRole =
    !!r.roles && r.roles.length > 0 && r.roles.every((x) => x === "SUPER_ADMIN");
  return onlySuperAdminRole || SUPER_ADMIN_PATH.test(r.path);
}

function entryMatches(
  e: { method: string; pattern: RegExp },
  method: string,
  concrete: string,
): boolean {
  return (e.method === "ANY" || e.method === method) && e.pattern.test(concrete);
}

/**
 * Classify every MUTATING route and collect problems. Pure: the real graph and a fixture graph go through the
 * same function, so the red proofs exercise the shipped logic.
 */
export function classifyRoutes(
  table: readonly RouteRecord[],
  reg: RouteRegistries,
): { rows: ClassifiedRow[]; problems: string[] } {
  const rows: ClassifiedRow[] = [];
  const problems: string[] = [];
  const mutating = table.filter((r) => r.mutating);
  const buyerByKey = new Map(reg.buyerAccountWrites.map((e) => [e.route, e]));
  const publicByKey = new Map(reg.publicWrites.map((e) => [e.route, e]));

  for (const r of mutating) {
    const key = `${r.method} ${r.path}`;
    const concrete = concretePath(r.path);
    let klass: RouteClass = "UNCLASSIFIED";
    let reason = "";
    const fail = (why: string) => problems.push(`${key} (${r.controller}.${r.handler}): ${why}`);

    if (claimsSuperAdmin(r) && r.context !== "SUPER_ADMIN") {
      fail(
        "claims super-admin (a SUPER_ADMIN-only @Roles or an /admin path) but lacks SuperAdminGuard",
      );
    }

    switch (r.context) {
      case "SUPER_ADMIN":
        klass = "SUPER_ADMIN";
        reason = "SuperAdminGuard: a platform session, never a tenant status";
        break;
      case "STAFF": {
        const hit = reg.allowList.find((e) => entryMatches(e, r.method, concrete));
        if (hit) {
          klass = "STAFF_ALLOW_LISTED";
          reason = hit.reason;
          if (!hit.reason || hit.reason.trim() === "")
            fail("matches an allow-list entry with no reason");
        } else {
          klass = "STAFF_GUARDED";
          reason = "refused with 403 READ_ONLY by default";
        }
        break;
      }
      case "BUYER_SELLER":
        klass = "BUYER_SELLER_GUARDED";
        reason = "BuyerSellerContextGuard (SELLER_READ_ONLY_BUYER_GATE)";
        break;
      case "BUYER_ACCOUNT": {
        const e = buyerByKey.get(key);
        if (e) {
          klass = "BUYER_ACCOUNT";
          reason = e.reason;
        } else {
          fail("buyer-JWT write without BuyerSellerContextGuard and not in BUYER_ACCOUNT_WRITES");
        }
        break;
      }
      case "NONE": {
        const e = publicByKey.get(key);
        if (e) {
          klass = "PUBLIC";
          reason = e.reason;
        } else {
          fail(
            "no auth guard (no JwtAuthGuard / BuyerJwtAuthGuard / SuperAdminGuard) and not in PUBLIC_WRITE_ROUTES",
          );
        }
        break;
      }
    }
    rows.push({ route: r, key, klass, reason });
  }

  // Registry hygiene: every entry has a reason and matches at least one real route of the right context.
  for (const e of reg.allowList) {
    const label = `READ_ONLY_ALLOWED_MUTATIONS ${e.method} ${e.pattern}`;
    if (!e.reason || e.reason.trim() === "") problems.push(`${label}: empty reason`);
    const hits = mutating.filter((r) => entryMatches(e, r.method, concretePath(r.path)));
    if (hits.length === 0) problems.push(`${label}: dead entry (matches no mutating route)`);
  }
  const routeByKey = new Map(mutating.map((r) => [`${r.method} ${r.path}`, r]));
  for (const [name, entries, want] of [
    ["BUYER_ACCOUNT_WRITES", reg.buyerAccountWrites, "BUYER_ACCOUNT"],
    ["PUBLIC_WRITE_ROUTES", reg.publicWrites, "NONE"],
  ] as const) {
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.reason || e.reason.trim() === "") problems.push(`${name} ${e.route}: empty reason`);
      if (seen.has(e.route)) problems.push(`${name} ${e.route}: duplicate entry`);
      seen.add(e.route);
      const r = routeByKey.get(e.route);
      if (!r) problems.push(`${name} ${e.route}: dead entry (no such mutating route)`);
      else if (r.context !== want) {
        problems.push(`${name} ${e.route}: stale, the route's auth context is now ${r.context}`);
      }
    }
  }
  return { rows, problems };
}

/** The deliverable table (markdown), regenerated on demand. */
export function formatRouteTable(rows: readonly ClassifiedRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.klass, (counts.get(r.klass) ?? 0) + 1);
  const head = [...counts].map(([k, n]) => `${k}: ${n}`).join(" | ");
  const lines = [
    `Mutating routes: ${rows.length} (${head})`,
    "",
    "| class | method | path | handler | guards | reason |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.klass} | ${r.route.method} | ${r.route.path} | ${r.route.controller}.${r.route.handler} | ${r.route.guards.join(", ")} | ${r.reason} |`,
    ),
  ];
  return lines.join("\n");
}
