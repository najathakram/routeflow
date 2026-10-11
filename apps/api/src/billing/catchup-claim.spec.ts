import * as fs from "fs";
import * as path from "path";
import {
  CATCHUP_STATES,
  activationClaimRefusal,
  claimRefusal,
  invoiceDefinitivelyFailed,
  isCatchupSession,
  isCatchupState,
  type InvoiceFacts,
} from "./catchup-claim";
import { API_ERROR_CODES } from "../common/api-error-codes";

const facts = (over: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  status: "open",
  amountPaid: 0,
  amountDue: 100,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 1,
  subscriptionId: "sub_1",
  ...over,
});

describe("catchupState", () => {
  it("L-072: the TS union is set-equal to the DB CHECK constraint (read from the migration, not re-typed)", () => {
    const dir = path.resolve(__dirname, "../../prisma/migrations");
    const sql = fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, "migration.sql")))
      .map((d) => fs.readFileSync(path.join(dir, d, "migration.sql"), "utf8"))
      .find(
        (s) => s.includes("TenantSubscription_catchupState_chk") && s.includes("ADD CONSTRAINT"),
      );
    expect(sql).toBeDefined();
    const list = /"catchupState" IN \(([^)]*)\)/.exec(sql!)![1];
    const inDb = [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect([...CATCHUP_STATES].sort()).toEqual(inDb);
  });

  it("isCatchupState", () => {
    expect(isCatchupState("RELEASING")).toBe(true);
    expect(isCatchupState("DONE")).toBe(false);
    expect(isCatchupState(null)).toBe(false);
  });
});

describe("MF3: activationClaimRefusal", () => {
  it("every held state refuses a manual activation; the open-session state has its own code", () => {
    expect(activationClaimRefusal(null)).toBeNull();
    expect(activationClaimRefusal("SESSION_OPEN")!.getResponse()).toMatchObject({
      code: API_ERROR_CODES.ACTIVATION_CATCHUP_SESSION_OPEN,
    });
    for (const s of ["AWAITING_FIRST_PAYMENT", "RELEASING"]) {
      expect(activationClaimRefusal(s)!.getResponse()).toMatchObject({
        code: API_ERROR_CODES.CATCHUP_PENDING,
      });
    }
  });
});

describe("claimRefusal", () => {
  it("none -> null; SESSION_OPEN -> CATCHUP_SESSION_OPEN; every later state -> CATCHUP_PENDING; all 409", () => {
    expect(claimRefusal(null)).toBeNull();
    expect(claimRefusal(undefined)).toBeNull();
    const open = claimRefusal("SESSION_OPEN")!;
    expect(open.getStatus()).toBe(409);
    expect(open.getResponse()).toMatchObject({ code: API_ERROR_CODES.CATCHUP_SESSION_OPEN });
    for (const s of ["AWAITING_FIRST_PAYMENT", "RELEASING"]) {
      expect(claimRefusal(s)!.getResponse()).toMatchObject({
        code: API_ERROR_CODES.CATCHUP_PENDING,
      });
    }
  });
});

describe("invoiceDefinitivelyFailed (r3 N2: payment_failed with no next attempt)", () => {
  it("open + attempted + nothing scheduled = failed", () => {
    expect(invoiceDefinitivelyFailed(facts())).toBe(true);
  });
  it("Stripe will retry = not failed", () => {
    expect(invoiceDefinitivelyFailed(facts({ nextPaymentAttempt: 1791172800 }))).toBe(false);
  });
  it("never attempted yet = not failed", () => {
    expect(invoiceDefinitivelyFailed(facts({ attemptCount: 0 }))).toBe(false);
  });
  it("uncollectible / void = failed", () => {
    expect(invoiceDefinitivelyFailed(facts({ status: "uncollectible" }))).toBe(true);
    expect(invoiceDefinitivelyFailed(facts({ status: "void" }))).toBe(true);
  });
  it("a payment still PROCESSING (ACH) is never a failure, whatever else it says", () => {
    expect(invoiceDefinitivelyFailed(facts({ paymentProcessing: true }))).toBe(false);
    expect(
      invoiceDefinitivelyFailed(facts({ status: "uncollectible", paymentProcessing: true })),
    ).toBe(false);
  });
  it("paid / draft are not failures", () => {
    expect(invoiceDefinitivelyFailed(facts({ status: "paid" }))).toBe(false);
    expect(invoiceDefinitivelyFailed(facts({ status: "draft" }))).toBe(false);
  });
});

describe("isCatchupSession", () => {
  it("reads the catchup metadata marker", () => {
    expect(isCatchupSession({ metadata: { catchup: "2026-10" } })).toBe(true);
    expect(isCatchupSession({ metadata: { catchup: "prepaid" } })).toBe(true);
    expect(isCatchupSession({ metadata: {} })).toBe(false);
    expect(isCatchupSession({})).toBe(false);
  });
});
