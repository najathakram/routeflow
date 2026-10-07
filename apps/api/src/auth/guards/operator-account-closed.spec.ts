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
 * The same routes feed the owner's read-only usage report (`report-operator-account-blast-radius`),
 * so every mutating handler here must also match one of the report's patterns: a closed endpoint the
 * report cannot see would make "who loses what" incomplete.
 */
import "reflect-metadata";
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLOSED_MUTATIONS } = require("../../../scripts/lib/operator-account-routes.cjs") as {
  CLOSED_MUTATIONS: { group: string; re: string; notSelf?: boolean }[];
};

type Ctl = { new (...a: never[]): unknown; prototype: Record<string, unknown> };

/** Every handler the owner's list closes to the account admin (51). */
const CLOSED: [Ctl, string[]][] = [
  [
    UsersController as unknown as Ctl,
    [
      "createOperator",
      "changeStatus",
      "resetPassword",
      "unlock",
      "toggleAdmin",
      "toggleDriverPermit",
    ],
  ],
  [StripeConnectController as unknown as Ctl, ["link", "disconnect"]],
  [
    ImportController as unknown as Ctl,
    [
      "importContacts",
      "importInvoices",
      "importPayments",
      "importExpenses",
      "listExpenseBatches",
      "repairInventoryPurchaseExpenses",
      "rollbackExpenseBatch",
      "importProducts",
      "importInventory",
      "importExpenseSuppliers",
      "markSupplierOnlyCustomers",
      "diagnoseOrphanedContacts",
      "adoptOrphanedContacts",
    ],
  ],
  [MigrationController as unknown as Ctl, ["list", "create", "get", "stage", "confirm", "undo"]],
  [NumberingController as unknown as Ctl, ["getSettings", "updateSettings"]],
  [SettingsBillingController as unknown as Ctl, ["export"]],
  [
    SettingsController as unknown as Ctl,
    [
      "getEmailSettings",
      "updateEmailSettings",
      "testEmailSettings",
      "verifyEmailConnection",
      "getSendingDomain",
      "addSendingDomain",
      "refreshSendingDomain",
      "verifySendingDomain",
      "setSendingFrom",
      "removeSendingDomain",
      "getAnthropicSettings",
      "updateAnthropicSettings",
    ],
  ],
  [
    CrmController as unknown as Ctl,
    ["saveConnection", "testConnection", "disconnect", "updateConfig"],
  ],
  [CustomersController as unknown as Ctl, ["deleteAll", "cleanupPreview", "cleanupImported"]],
  [ProductsController as unknown as Ctl, ["importFromZoho", "clearAll"]],
];

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
  it("pins the owner's list: 51 handlers (a typo in a method name would shrink it silently)", () => {
    expect(flat(CLOSED)).toHaveLength(51);
    for (const [ctl, m] of flat(CLOSED)) {
      expect(typeof ctl.prototype[m]).toBe("function");
    }
  });

  it.each(flat(CLOSED).map(([ctl, m]) => [`${ctl.name}.${m}`, ctl, m] as const))(
    "%s: resolves to TENANT_ADMIN only; OPERATOR (also with driver capacity) is refused, TENANT_ADMIN admitted",
    (_name, ctl, m) => {
      expect(rolesOf(ctl, m)).toEqual([UserRole.TENANT_ADMIN]);
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR))).toBe(false);
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR_DRIVER))).toBe(false);
      expect(guard.canActivate(ctxFor(ctl, m, ADMIN))).toBe(true);
    },
  );

  it.each(flat(STAYS_OPEN).map(([ctl, m]) => [`${ctl.name}.${m}`, ctl, m] as const))(
    "%s: still open to an operator (control: the account list did not swallow it)",
    (_name, ctl, m) => {
      expect(guard.canActivate(ctxFor(ctl, m, OPERATOR))).toBe(true);
      expect(guard.canActivate(ctxFor(ctl, m, ADMIN))).toBe(true);
    },
  );

  it("every closed MUTATING handler is counted by the owner's usage report", () => {
    const methodName: Record<number, string> = {
      [RequestMethod.GET]: "GET",
      [RequestMethod.POST]: "POST",
      [RequestMethod.PUT]: "PUT",
      [RequestMethod.PATCH]: "PATCH",
      [RequestMethod.DELETE]: "DELETE",
    };
    const unseen: string[] = [];
    for (const [ctl, m] of flat(CLOSED)) {
      const verb = methodName[Reflect.getMetadata(METHOD_METADATA, ctl.prototype[m])];
      if (verb === "GET") continue; // reads leave no AuditLog row
      const base = Reflect.getMetadata(PATH_METADATA, ctl) as string | string[];
      const own =
        (Reflect.getMetadata(PATH_METADATA, ctl.prototype[m]) as string | undefined) ?? "";
      const prefix = (Array.isArray(base) ? base[0] : base).replace(/^\//, "");
      const path = [prefix, own.replace(/^\//, "").replace(/:[A-Za-z]+/g, "x")]
        .filter(Boolean)
        .join("/");
      const action = `${verb} /${path}`;
      const counted = CLOSED_MUTATIONS.some((c) => new RegExp(c.re).test(action));
      if (!counted) unseen.push(`${ctl.name}.${m} -> ${action}`);
    }
    expect(unseen).toEqual([]);
  });
});
