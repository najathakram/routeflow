import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { plainToInstance } from "class-transformer";
import { defaultMetadataStorage } from "class-transformer/cjs/storage";
import { getMetadataStorage, validateSync, type ValidationError } from "class-validator";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import { BUYER_LINE_QTY_MAX } from "@routeflow/pricing";
import { BuyerCreateOrderDto } from "../buyer/dto/buyer-create-order.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";

/**
 * B1386 (SA-1285): class-level inventory of every CUSTOMER-reachable API handler whose request body can carry a
 * line quantity, and the guard each one uses against `BUYER_LINE_QTY_MAX` (100,000 pieces, `@routeflow/pricing`).
 *
 * It is a pin, not a proof: the REG tests prove each service cap works; this proves no writer is UNACCOUNTED for.
 * A new CUSTOMER-reachable handler whose body carries `qty` / `boxes` / `pieces` / `newQty`, or whose body is
 * untyped (`dto: any`, an inline object type), fails assertion (a) until it is classified here.
 *
 * Discovery is the real Nest runtime metadata of every `*.controller.ts` (never a text scrape: L-205), and a
 * discovery that finds nothing, or a controller that cannot be loaded, FAILS rather than passing (L-202).
 *
 * CUSTOMER reachability (the rule, derived from the real auth wiring):
 *  - There is NO global roles guard. The APP_GUARDs (app.module.ts:222-229: ThrottlerGuard, TenantStatusGuard,
 *    ImpersonationGuard) authorize nothing; authentication and roles are per route (app.module.ts:212-220).
 *  - A staff-JWT controller is `@UseGuards(JwtAuthGuard)` and a handler restricts roles by also applying
 *    `RolesGuard` + `@Roles(...)` (auth/guards/roles.guard.ts:41-47). When RolesGuard is applied (class or
 *    handler), the handler's `@Roles` (handler first, then class: `getAllAndOverride`, roles.guard.ts:41) must
 *    name CUSTOMER, and NO `@Roles` at all is a deny (roles.guard.ts:46 `return false`). SUPER_ADMIN satisfies
 *    CUSTOMER only by hierarchy (roles.guard.ts:19-25) and is not a customer, so it does not count.
 *  - When RolesGuard is NOT applied, any role that passes the authentication guard reaches the handler, CUSTOMER
 *    included (a `@Roles` with no RolesGuard is decoration, not enforcement).
 *  - A class guarded by `BuyerJwtAuthGuard` (buyer/buyer.controller.ts:131, buyer/buyer-quote.controller.ts:25) is
 *    the buyer portal: its routes run as a CUSTOMER pseudo-user (buyer.controller.ts:120 `role: UserRole.CUSTOMER`).
 *  - `SuperAdminGuard` routes are never customer-reachable. An unguarded route is reachable by everyone.
 */

// ── Inventory ───────────────────────────────────────────────────────────────────────────────────────────────────

type SamplePlan = (qty: number) => object;

/**
 * The body DTO's own per-field `@Max(BUYER_LINE_QTY_MAX)` on every quantity path. Not the cap: one field alone can be
 * under 100,000 while the line is not (boxes x pack + pieces; a plain qty counts packs). It stays as the first,
 * cheap refusal, and is pinned here so it cannot be dropped, next to the piece-total guard that actually certifies.
 */
interface FieldBounds {
  dto: () => Function;
  /** A request body with `qty` on every quantity path. */
  sample: SamplePlan;
  /** Quantity paths this DTO carries that are NOT a buyer sale line, each with why. */
  exemptPaths?: Record<string, string>;
}

type Guard =
  | {
      /** The service or controller refuses a line past the cap via `assertBuyerLinesWithinCap` (orders/buyer-line-cap.ts). */
      guard: "service-cap";
      /** The REG id of the test that proves it: `REG-B1386 <id>`. */
      reg: string;
      /** A body DTO that also bounds each field (pinned below); never what certifies the writer. */
      fieldBounds?: FieldBounds;
    }
  | { guard: "not-a-line"; reason: string }
  | { guard: "untyped"; reason: string };

const line = (qty: number) => ({ productId: "p-1", qty, boxes: qty, pieces: qty });
const INLINE_RETURN_STAFF_ONLY =
  "an inline return line, not a sale line: inline returns are staff-only (InlineReturnsService.assertInlineReturnAllowed refuses a CUSTOMER before any read) and bounded by the remaining returnable qty";
const NO_QTY_BODY = (what: string) => `untyped body, but it carries ${what}, no line quantity`;

const INVENTORY: Record<string, Guard> = {
  // Buyer portal cart: the controller caps each line's built PIECE total (assertBuyerCreateItemsWithinCap) before the
  // create path and the merge path; the body DTO's per-field bound stays pinned.
  "BuyerController.createOrder": {
    guard: "service-cap",
    reg: "REG-B1386 K1",
    fieldBounds: { dto: () => BuyerCreateOrderDto, sample: (qty) => ({ items: [line(qty)] }) },
  },
  "BuyerQuoteController.quote": {
    guard: "service-cap",
    reg: "REG-B1386 K2",
    fieldBounds: { dto: () => BuyerCreateOrderDto, sample: (qty) => ({ items: [line(qty)] }) },
  },
  // Staff-JWT order create (CUSTOMER, OPERATOR, DRIVER): the piece-total cap runs for a CUSTOMER caller only; staff keep
  // OrderItemDto's per-field bound (BUYER_LINE_QTY_MAX).
  "OrdersController.create": {
    guard: "service-cap",
    reg: "REG-B1386 K3",
    fieldBounds: {
      dto: () => CreateOrderDto,
      sample: (qty) => ({ items: [line(qty)] }),
      exemptPaths: {
        "inlineReturn[].items[].qty": INLINE_RETURN_STAFF_ONLY,
        "inlineReturn[].items[].boxes": INLINE_RETURN_STAFF_ONLY,
        "inlineReturn[].items[].pieces": INLINE_RETURN_STAFF_ONLY,
      },
    },
  },
  // Order edit: a CUSTOMER (portal or staff-JWT) reaches the same buyer-line path, which calls assertBuyerLinesWithinCap.
  // The unit-aware per-line diff branch (SA-407, updateUnitLine) is covered by "REG-B1386 E7" (unit-line-edit.b1386.spec.ts).
  "BuyerController.updateOrderItems": { guard: "service-cap", reg: "REG-B1386 E1" },
  "OrdersController.updateOrderItems": { guard: "service-cap", reg: "REG-B1386 E1" },
  // Change request: filed by a CUSTOMER, resolved by staff; the filing refuses a line past the cap.
  "BuyerController.createChangeRequest": { guard: "service-cap", reg: "REG-B1386 C1" },
  "OrdersController.createChangeRequest": { guard: "service-cap", reg: "REG-B1386 C1" },
  // Standing order templates: a CUSTOMER creates and edits their own template lines.
  "OrderTemplatesController.create": { guard: "service-cap", reg: "REG-B1386 T1" },
  "OrderTemplatesController.update": { guard: "service-cap", reg: "REG-B1386 T3" },
  // Untyped bodies (`dto: any` or an inline object type): listed so a new one cannot slip in unseen.
  "ReturnsController.create": {
    guard: "untyped",
    reason:
      "return qty is bounded by the remaining returnable qty in returns.service.ts (`exceeds remaining returnable qty`), and it is not a new sale line",
  },
  "OrdersController.toggleUrgent": {
    guard: "untyped",
    reason: NO_QTY_BODY("{ urgent?: boolean }"),
  },
  "AuthController.verifyEmail": { guard: "untyped", reason: NO_QTY_BODY("{ token }") },
  "BuyerMergeController.initiateMerge": {
    guard: "untyped",
    reason: NO_QTY_BODY("{ secondaryEmail, notes }"),
  },
  "NotificationsController.registerToken": {
    guard: "untyped",
    reason: NO_QTY_BODY("{ token, platform }"),
  },
  "PublicTenantsController.resendVerification": {
    guard: "untyped",
    reason: NO_QTY_BODY("{ email }"),
  },
  "UsersController.updateMyPreferences": {
    guard: "untyped",
    reason: NO_QTY_BODY("a Record<string, string> of UI preferences (PreferencesBodyPipe)"),
  },
};

// ── Discovery ───────────────────────────────────────────────────────────────────────────────────────────────────

type Ctor = Function; // eslint-disable-line @typescript-eslint/no-unsafe-function-type
const SRC = path.resolve(__dirname, "..");
const QTY_PROPERTY = /^(qty|boxes|pieces|newQty|quantity|newQuantity)$/;

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") controllerFiles(p, out);
    } else if (e.name.endsWith(".controller.ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out.sort();
}

interface Loaded {
  controllers: Ctor[];
  loadFailures: string[];
  files: number;
}

function loadControllers(): Loaded {
  const controllers = new Set<Ctor>();
  const loadFailures: string[] = [];
  const files = controllerFiles(SRC);
  for (const f of files) {
    let mod: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require(f);
    } catch (err) {
      loadFailures.push(`${path.relative(SRC, f)}: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    for (const v of Object.values(mod)) {
      if (typeof v === "function" && Reflect.hasMetadata(PATH_METADATA, v)) controllers.add(v);
    }
  }
  return { controllers: [...controllers], loadFailures, files: files.length };
}

function guardNames(target: object): string[] {
  const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
  return guards.map((g) =>
    typeof g === "function" ? g.name : ((g as object)?.constructor?.name ?? String(g)),
  );
}

/** See the rule in the header comment. */
function customerReachable(ctrl: Ctor, handler: Function): boolean {
  const guards = new Set([...guardNames(ctrl), ...guardNames(handler)]);
  if (guards.has("SuperAdminGuard")) return false;
  if (guards.has("RolesGuard")) {
    const roles: string[] | undefined =
      Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, ctrl);
    return !!roles && roles.includes("CUSTOMER");
  }
  // BuyerJwtAuthGuard (buyer portal = CUSTOMER pseudo-user), JwtAuthGuard alone, or no guard: reachable.
  return true;
}

type BodyParam = { index: number; type: unknown };

/** The handler's whole-body parameters (`@Body()` with no property key) and their declared TS type. */
function bodyParams(ctrl: Ctor, name: string): BodyParam[] {
  const args: Record<string, { index: number; data?: unknown }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {};
  const types: unknown[] = Reflect.getMetadata("design:paramtypes", ctrl.prototype, name) ?? [];
  return Object.entries(args)
    .filter(([key, v]) => key.startsWith(`${RouteParamtypes.BODY}:`) && v.data === undefined)
    .map(([, v]) => ({ index: v.index, type: types[v.index] }));
}

const PRIMITIVES = new Set<unknown>([Object, String, Number, Boolean, Date, Array, Function]);

function isDtoClass(t: unknown): t is Ctor {
  return typeof t === "function" && !PRIMITIVES.has(t);
}

type ValidationMeta = { propertyName: string };

function validationMetas(cls: Ctor): ValidationMeta[] {
  return getMetadataStorage().getTargetValidationMetadatas(
    cls as never,
    undefined as unknown as string,
    true,
    false,
  ) as unknown as ValidationMeta[];
}

/** The nested class behind a property: class-transformer `@Type`, else the design type when it is a class. */
function nestedClassOf(cls: Ctor, prop: string): Ctor | undefined {
  const t = defaultMetadataStorage.findTypeMetadata(cls as never, prop);
  if (t) {
    const nested = t.typeFunction();
    if (isDtoClass(nested)) return nested;
  }
  const design = Reflect.getMetadata("design:type", cls.prototype, prop);
  return isDtoClass(design) && validationMetas(design).length > 0 ? design : undefined;
}

/** Quantity property paths a DTO carries, nested item DTOs included: `items[].qty`, `lines[].pieces`, ... */
function quantityPaths(cls: Ctor, prefix = "", seen: ReadonlySet<Ctor> = new Set()): string[] {
  if (seen.has(cls)) return [];
  const next = new Set(seen).add(cls);
  const props = [...new Set(validationMetas(cls).map((m) => m.propertyName))];
  const out: string[] = [];
  for (const prop of props) {
    if (QTY_PROPERTY.test(prop)) out.push(`${prefix}${prop}`);
    const nested = nestedClassOf(cls, prop);
    if (nested) out.push(...quantityPaths(nested, `${prefix}${prop}[].`, next));
  }
  return [...new Set(out)];
}

interface Candidate {
  key: string;
  why: string[];
}

function discover(): { found: Map<string, Candidate>; loaded: Loaded; reachableHandlers: number } {
  const loaded = loadControllers();
  const found = new Map<string, Candidate>();
  let reachableHandlers = 0;
  for (const ctrl of loaded.controllers) {
    const names = new Set<string>();
    for (let p = ctrl.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) {
        if (n === "constructor") continue;
        const fn = Object.getOwnPropertyDescriptor(p, n)?.value;
        if (typeof fn === "function" && Reflect.getMetadata(METHOD_METADATA, fn) !== undefined) {
          names.add(n);
        }
      }
    }
    for (const n of names) {
      const fn = (ctrl.prototype as Record<string, Function>)[n];
      if (!customerReachable(ctrl, fn)) continue;
      reachableHandlers++;
      const why: string[] = [];
      for (const b of bodyParams(ctrl, n)) {
        if (b.type === Object || b.type === undefined) why.push("untyped body");
        else if (isDtoClass(b.type)) {
          const paths = quantityPaths(b.type);
          if (paths.length > 0) why.push(`${b.type.name}: ${paths.join(", ")}`);
        }
      }
      if (why.length > 0) found.set(`${ctrl.name}.${n}`, { key: `${ctrl.name}.${n}`, why });
    }
  }
  return { found, loaded, reachableHandlers };
}

// ── Spec ────────────────────────────────────────────────────────────────────────────────────────────────────────

let discovery: ReturnType<typeof discover>;

beforeAll(() => {
  discovery = discover();
});

function flatten(errors: ValidationError[], base = ""): Array<{ path: string; max: boolean }> {
  return errors.flatMap((e) => {
    const here = /^\d+$/.test(e.property)
      ? `${base}[]`
      : base
        ? `${base}.${e.property}`
        : e.property;
    const own = e.constraints ? [{ path: here, max: "max" in e.constraints }] : [];
    return [...own, ...flatten(e.children ?? [], here)];
  });
}

describe("B1386 inventory: every CUSTOMER-reachable line-quantity writer is classified", () => {
  it("loads every controller (a load failure is a failure, never a skip)", () => {
    expect(discovery.loaded.loadFailures).toEqual([]);
  });

  it("sanity: discovery finds the controllers and the service-cap routes", () => {
    expect(discovery.loaded.files).toBeGreaterThan(20);
    expect(discovery.reachableHandlers).toBeGreaterThan(50);
    expect(discovery.found.size).toBeGreaterThanOrEqual(8);
    for (const key of [
      "BuyerController.createOrder",
      "BuyerQuoteController.quote",
      "OrdersController.create",
      "BuyerController.updateOrderItems",
      "BuyerController.createChangeRequest",
      "OrdersController.updateOrderItems",
      "OrdersController.createChangeRequest",
    ]) {
      expect(discovery.found.has(key)).toBe(true);
    }
  });

  it("FOUND equals the INVENTORY, so no CUSTOMER quantity writer is unaccounted for", () => {
    const found = [...discovery.found.keys()].sort();
    const declared = Object.keys(INVENTORY).sort();
    const unclassified = found.filter((k) => !(k in INVENTORY));
    const stale = declared.filter((k) => !discovery.found.has(k));
    const detail = unclassified.map(
      (k) => `  ${k}  <-  ${discovery.found.get(k)!.why.join(" | ")}`,
    );
    const message = [
      "A CUSTOMER-reachable handler carries a line quantity (or an untyped body) and is not in the B1386 inventory.",
      "A new CUSTOMER quantity writer must call assertBuyerLinesWithinCap (apps/api/src/orders/buyer-line-cap.ts)",
      "(a per-field @Max alone is not a guard: it cannot see boxes x pack + pieces), then be added to INVENTORY in this spec.",
      unclassified.length ? `Unclassified:\n${detail.join("\n")}` : "",
      stale.length
        ? `Inventory entries no handler matches (renamed or no longer reachable): ${stale.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      expect(found).toEqual(declared);
    } catch (err) {
      throw new Error(`${message}\n\n${(err as Error).message}`);
    }
  });

  it("service-cap entries name a REG id of the form `REG-B1386 <id>`", () => {
    for (const [key, g] of Object.entries(INVENTORY)) {
      if (g.guard === "service-cap")
        expect({ key, reg: g.reg }).toEqual({
          key,
          reg: expect.stringMatching(/^REG-B1386 [A-Z]\d+$/),
        });
    }
  });

  const withBounds = Object.entries(INVENTORY).flatMap(([key, g]) =>
    g.guard === "service-cap" && g.fieldBounds ? [[key, g.fieldBounds] as const] : [],
  );

  it("the three create entry points keep their body DTO's per-field bound pinned", () => {
    expect(withBounds.map(([key]) => key).sort()).toEqual([
      "BuyerController.createOrder",
      "BuyerQuoteController.quote",
      "OrdersController.create",
    ]);
  });

  it.each(withBounds)(
    "%s: the body DTO still rejects a quantity above BUYER_LINE_QTY_MAX on every quantity path",
    (_key, g) => {
      const dto = g.dto();
      const exempt = new Set(Object.keys(g.exemptPaths ?? {}));
      const norm = (x: string) => x.replace(/\[\]/g, "");
      const paths = quantityPaths(dto).filter((p) => !exempt.has(p));
      expect(paths.length).toBeGreaterThan(0);
      const over = flatten(
        validateSync(plainToInstance(dto as never, g.sample(BUYER_LINE_QTY_MAX + 1)) as object, {
          whitelist: false,
        }),
      );
      const at = flatten(
        validateSync(plainToInstance(dto as never, g.sample(BUYER_LINE_QTY_MAX)) as object, {
          whitelist: false,
        }),
      );
      for (const p of paths) {
        expect({
          path: p,
          rejectedAbove: over.some((e) => norm(e.path) === norm(p) && e.max),
        }).toEqual({
          path: p,
          rejectedAbove: true,
        });
        expect({
          path: p,
          rejectedAtMax: at.some((e) => norm(e.path) === norm(p) && e.max),
        }).toEqual({
          path: p,
          rejectedAtMax: false,
        });
      }
    },
  );
});
