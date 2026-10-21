/**
 * Operator permissions PR1 — account administration is TENANT_ADMIN-only.
 *
 * These endpoints used to admit an OPERATOR (a TENANT_ADMIN satisfies @Roles(OPERATOR), so the
 * handlers named OPERATOR meant "operator or admin"). Owner ruling 2026-10-07: the one difference
 * between an operator and an admin is account administration (staff, SMTP / sending domain, the AI
 * key, the CRM connection, Stripe connect, data import / migration / numbering, the billing export,
 * the whole-catalog / whole-customer wipes). Each handler below must now resolve to
 * `@Roles(TENANT_ADMIN)` and the real RolesGuard must refuse an OPERATOR (403) and admit a
 * TENANT_ADMIN. Reads the real Nest metadata, never source text.
 *
 * The handler list is NOT retyped here: it is the owner's usage report's own list
 * (`CLOSED_HANDLERS` in `scripts/lib/operator-account-blast-radius.mjs`), so the report and the
 * guards cannot disagree. The module is ESM and this suite runs under ts-jest's CommonJS
 * transform, so it is loaded in ONE `node --input-type=module` child that imports it by `file://`
 * URL and prints JSON (the convention of report-operator-account-blast-radius-script.spec.ts,
 * hence the `-script.spec.ts` name: spawn specs run in the serial script lane).
 *
 * Every mutating handler must also match the report's audit-action regex (`buildActionRegex`): a
 * closed endpoint the report cannot see would make "who loses what" incomplete.
 *
 * `users.update` (PATCH /users/:id) is the one list entry that is NOT a role decorator: it stays
 * open to every signed-in user for their own record and is admin-only for anyone else, enforced in
 * the handler body (see users.controller.update-scope.spec.ts), so it is excluded from the
 * decorator checks below and pinned by name instead.
 */
import "reflect-metadata";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { RolesGuard } from "./roles.guard";
import { UsersController } from "../../users/users.controller";
import { StripeConnectController } from "../../stripe-connect/stripe-connect.controller";
import { ImportController } from "../../import/import.controller";
import { MigrationController } from "../../import/migration.controller";
import { NumberingController } from "../../import/numbering.controller";
import { SettingsBillingController } from "../../billing/settings-billing.controller";
import { SettingsController } from "../../system-config/settings.controller";
import { CrmController } from "../../crm/crm.controller";
import { CustomersController } from "../../customers/customers.controller";
import { ProductsController } from "../../products/products.controller";
import { BatchController } from "../../import/batch.controller";

type Ctl = { new (...a: never[]): unknown; prototype: Record<string, unknown> };

interface Handler {
  id: string;
  httpMethod: string;
  route: string;
  controller: string;
  method: string;
  nonSelfOnly: boolean;
  audited: boolean;
}

const API_DIR = path.resolve(__dirname, "../../..");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/operator-account-blast-radius.mjs"),
).href;

function evalLib<T>(body: string): T {
  const code = `import * as lib from ${JSON.stringify(LIB_HREF)};\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: API_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`child failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

const { handlers: ALL_HANDLERS, actionRegex: ACTION_REGEX } = evalLib<{
  handlers: Handler[];
  actionRegex: string;
}>(
  "console.log(JSON.stringify({ handlers: lib.CLOSED_HANDLERS, actionRegex: lib.buildActionRegex() }));",
);

/** The controller class that declares each `controller` source file on the report's list. */
const CONTROLLER_CLASS: Record<string, Ctl> = {
  "users/users.controller.ts": UsersController as unknown as Ctl,
  "stripe-connect/stripe-connect.controller.ts": StripeConnectController as unknown as Ctl,
  "import/import.controller.ts": ImportController as unknown as Ctl,
  "import/migration.controller.ts": MigrationController as unknown as Ctl,
  "import/numbering.controller.ts": NumberingController as unknown as Ctl,
  "billing/settings-billing.controller.ts": SettingsBillingController as unknown as Ctl,
  "system-config/settings.controller.ts": SettingsController as unknown as Ctl,
  "crm/crm.controller.ts": CrmController as unknown as Ctl,
  "customers/customers.controller.ts": CustomersController as unknown as Ctl,
  "products/products.controller.ts": ProductsController as unknown as Ctl,
};

/** Every list entry resolved to its real controller class + method (the body-enforced one aside). */
const BODY_ENFORCED = ["users.update"];
const CLOSED: (readonly [Ctl, string, Handler])[] = ALL_HANDLERS.filter(
  (x) => !BODY_ENFORCED.includes(x.id),
).map((x) => [CONTROLLER_CLASS[x.controller], x.method, x] as const);

/** Handlers that must STAY open to an operator: closing the account items must not swallow these. */
const STAYS_OPEN: [Ctl, string[]][] = [
  [UsersController as unknown as Ctl, ["findAll"]],
  [StripeConnectController as unknown as Ctl, ["status"]],
  [SettingsBillingController as unknown as Ctl, ["getSubscription", "getUsage"]],
  [SettingsController as unknown as Ctl, ["getSettings", "getRouteSettings", "getInvoiceSettings"]],
  [CrmController as unknown as Ctl, ["getStatus", "listPipelines", "listHandoffs", "sync"]],
  [CustomersController as unknown as Ctl, ["findAll", "create", "batchDelete"]],
  [ProductsController as unknown as Ctl, ["create"]],
  [BatchController as unknown as Ctl, ["scan"]],
];

const METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
};

/** The HTTP verb Nest has recorded on a controller method. */
function verbOf(ctl: Ctl, method: string): string | undefined {
  const code = Reflect.getMetadata(METHOD_METADATA, ctl.prototype[method] as object) as number;
  return METHOD_NAME[code];
}

const reflector = new Reflector();
const guard = new RolesGuard(reflector);

function rolesOf(ctl: Ctl, method: string): UserRole[] | undefined {
  return reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
    ctl.prototype[method] as () => void,
    ctl as unknown as () => void,
  ]);
}

function ctxFor(ctl: Ctl, method: string, user: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ctl.prototype[method],
    getClass: () => ctl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const OPERATOR = { sub: "u-op", role: UserRole.OPERATOR, tenantId: "t1" };
const OPERATOR_DRIVER = { ...OPERATOR, canActAsDriver: true };
const ADMIN = { sub: "u-ad", role: UserRole.TENANT_ADMIN, tenantId: "t1" };

const flat = (list: [Ctl, string[]][]) =>
  list.flatMap(([ctl, methods]) => methods.map((m) => [ctl, m] as const));

describe("operator permissions PR1: account endpoints are TENANT_ADMIN-only", () => {
  it("pins the report's list: 53 entries, 52 of them role-decorated handlers (a typo in a method name would shrink it silently)", () => {
    expect(ALL_HANDLERS).toHaveLength(54);
    expect(ALL_HANDLERS.filter((x) => BODY_ENFORCED.includes(x.id))).toHaveLength(1);
    expect(CLOSED).toHaveLength(53);
    for (const [ctl, m, handler] of CLOSED) {
      expect({ id: handler.id, resolved: ctl !== undefined }).toEqual({
        id: handler.id,
        resolved: true,
      });
      expect({ id: handler.id, fn: typeof ctl.prototype[m] }).toEqual({
        id: handler.id,
        fn: "function",
      });
    }
  });

  it.each(CLOSED.map(([ctl, m, handler]) => [`${ctl.name}.${m}`, ctl, m, handler] as const))(
    "%s: resolves to TENANT_ADMIN only; OPERATOR (also with driver capacity) is refused, TENANT_ADMIN admitted",
    (_name, ctl, m) => {
      expect(rolesOf(ctl, m)).toEqual([UserRole.TENANT_ADMIN]);
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR))).toBe(false);
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR_DRIVER))).toBe(false);
      expect(guard.canActivate(ctxFor(ctl, m, ADMIN))).toBe(true);
    },
  );

  it("the one body-enforced entry is PATCH /users/:id, counted only for a non-self target", () => {
    const update = ALL_HANDLERS.find((x) => x.id === "users.update");
    expect(update).toMatchObject({ httpMethod: "PATCH", route: "/users/:id", nonSelfOnly: true });
    // No role decorator: a signed-in user may edit their own record; the handler body refuses anyone
    // else who is not an admin (pinned in users.controller.update-scope.spec.ts).
    expect(rolesOf(UsersController as unknown as Ctl, "update")).toBeUndefined();
  });

  it.each(flat(STAYS_OPEN).map(([ctl, m]) => [`${ctl.name}.${m}`, ctl, m] as const))(
    "%s: still open to an operator (control: the account list did not swallow it)",
    (_name, ctl, m) => {
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR))).toBe(true);
      expect(guard.canActivate(ctxFor(ctl, m, ADMIN))).toBe(true);
    },
  );

  it("every list entry's verb matches the real controller metadata", () => {
    const wrong: string[] = [];
    for (const [ctl, m, handler] of CLOSED) {
      const verb = verbOf(ctl, m);
      if (verb !== handler.httpMethod) {
        wrong.push(`${handler.id}: list ${handler.httpMethod}, code ${verb}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every closed MUTATING handler is counted by the owner's usage report", () => {
    const re = new RegExp(ACTION_REGEX);
    const unseen: string[] = [];
    for (const [ctl, m] of CLOSED) {
      const verb = verbOf(ctl, m);
      if (verb === "GET") continue; // reads leave no AuditLog row
      const base = Reflect.getMetadata(PATH_METADATA, ctl) as string | string[];
      const own =
        (Reflect.getMetadata(PATH_METADATA, ctl.prototype[m] as object) as string | undefined) ??
        "";
      const prefix = (Array.isArray(base) ? base[0] : base).replace(/^\//, "");
      const path = [prefix, own.replace(/^\//, "").replace(/:[A-Za-z]+/g, "x")]
        .filter(Boolean)
        .join("/");
      const action = `${verb} /${path}`;
      if (!re.test(action)) unseen.push(`${ctl.name}.${m} -> ${action}`);
    }
    expect(unseen).toEqual([]);
  });
});

/** Every method on a controller that Nest routes (it carries METHOD_METADATA), by reflection, never by hand. */
function routeHandlersOf(ctl: Ctl): string[] {
  return Object.getOwnPropertyNames(ctl.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof ctl.prototype[m] === "function" &&
      Reflect.getMetadata(METHOD_METADATA, ctl.prototype[m] as object) !== undefined,
  );
}

describe("SA Perms PR1 M3: the import / migration / numbering pin is structural", () => {
  // These three are closed at the CLASS level: any handler added to them is account-level by construction, so
  // every routed method must be on the report's list. A new handler that is not listed goes red here.
  const STRUCTURAL: [string, Ctl][] = [
    ["import/import.controller.ts", ImportController as unknown as Ctl],
    ["import/migration.controller.ts", MigrationController as unknown as Ctl],
    ["import/numbering.controller.ts", NumberingController as unknown as Ctl],
  ];
  const listed = (file: string) =>
    new Set(ALL_HANDLERS.filter((h) => h.controller === file).map((h) => h.method));
  const unlisted = (file: string, ctl: Ctl) =>
    routeHandlersOf(ctl).filter((m) => !listed(file).has(m));

  it.each(STRUCTURAL)("%s: every routed handler is on the report's list", (file, ctl) => {
    expect(routeHandlersOf(ctl).length).toBeGreaterThan(0);
    expect(unlisted(file, ctl)).toEqual([]);
  });

  it("the detector itself: a planted, unlisted handler is caught", () => {
    class Planted extends (ImportController as unknown as { new (...a: never[]): object }) {
      sneaky() {
        return null;
      }
    }
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.POST, Planted.prototype.sneaky);
    expect(unlisted("import/import.controller.ts", Planted as unknown as Ctl)).toEqual(["sneaky"]);
  });
});
