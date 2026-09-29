import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";

// A unit test has no live Postgres: run the advisory-lock critical section directly.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: unknown, fn: () => Promise<unknown>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

/**
 * F4 — the customer-side writers of `CustomerAddress.state` derive `stateCode` /
 * `stateNeedsReview`. The restrictions engine reads ONLY `stateCode`: nothing derived it for a NEW
 * address (the customer stayed "can't tell where"), and `updateAddress` spread the DTO without
 * touching it, so editing a backfilled row's state from TX to CA kept TX (a fail-open). The helper
 * and the "every writer is classified" inventory are pinned in `address-state.spec.ts`.
 */
describe("CustomersService — address state columns are derived at the write boundary (F4)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const CUSTOMER = { id: "cust-1", userId: "user-1", businessName: "Acme Corp" };
  const ADDRESS = { label: "Main", line1: "1 Congress Ave", city: "Austin", zip: "78701" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const module = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } }, // no geocoder key
        { provide: StorageService, useValue: {} },
        {
          provide: MeterService,
          useValue: { read: jest.fn().mockResolvedValue({ included: null, used: 0 }) },
        },
        {
          provide: PlanCatalogService,
          useValue: { getPublishedVersion: jest.fn().mockResolvedValue(null) },
        },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue({}) } },
        { provide: CommissionEngineService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = module.get(CustomersService);
    prisma.customer.findUnique.mockResolvedValue(CUSTOMER);
  });

  describe("addAddress", () => {
    const add = (state: string, zip = "78701") =>
      service.addAddress("cust-1", { ...ADDRESS, state, zip } as any);
    const written = () => prisma.customerAddress.create.mock.calls[0][0].data;

    beforeEach(() => {
      prisma.customerAddress.create.mockResolvedValue({ id: "addr-1" });
    });

    it.each([
      ["Texas", "78701", "TX"],
      [" tx ", "78701", "TX"],
      ["Colorado", "80202", "CO"],
    ])("a newly added %j address (zip %s) resolves to %s", async (state, zip, code) => {
      await add(state, zip);
      expect(written()).toMatchObject({ state, stateCode: code, stateNeedsReview: false });
    });

    // F5: the zip column decides an ambiguous name and can contradict any state.
    it.each([
      ["Washington", "98101", "WA"], // a confirming zip resolves it
      ["Washington", "20001", null], // a DC zip: never Washington state
      ["Washington", "", null], // no zip: an ambiguous name is never guessed
      ["Texas", "10001", null], // a zip that contradicts the state: unresolved, not a written guess
    ])("%j with zip %j is stored with stateCode %j", async (state, zip, code) => {
      await add(state, zip);
      expect(written()).toMatchObject({ stateCode: code, stateNeedsReview: code === null });
    });

    it("an unresolvable state is stored, flagged for review and NOT rejected (fail closed in the engine)", async () => {
      await add("Tejas");
      expect(written()).toMatchObject({ state: "Tejas", stateCode: null, stateNeedsReview: true });
    });
  });

  describe("updateAddress", () => {
    const edit = (dto: Record<string, unknown>) =>
      service.updateAddress("cust-1", "addr-1", dto as any);
    const written = (call = 0) => prisma.customerAddress.update.mock.calls[call][0].data;

    beforeEach(() => {
      prisma.customerAddress.update.mockResolvedValue({ id: "addr-1", customerId: "cust-1" });
      prisma.customerAddress.findFirst.mockResolvedValue({
        state: "Texas",
        zip: "78701",
        stateCode: "TX",
      }); // stored
    });

    it("editing TX -> CO (with the new zip) recomputes stateCode to CO (never keeps the old TX)", async () => {
      await edit({ state: "Colorado", zip: "80202" });
      expect(written()).toMatchObject({ stateCode: "CO", stateNeedsReview: false });
    });

    it("editing the state but NOT the zip leaves a contradiction: unresolved (fail closed), never the stale TX or a guess", async () => {
      await edit({ state: "Colorado" }); // the stored zip is still a Texas one
      expect(written()).toMatchObject({ stateCode: null, stateNeedsReview: true });
    });

    it("an edit to an unresolvable state clears the code and flags the row (not the old code)", async () => {
      await edit({ state: "Tejas" });
      await edit({ state: "" });
      expect(written(0)).toMatchObject({ stateCode: null, stateNeedsReview: true });
      expect(written(1)).toMatchObject({ stateCode: null, stateNeedsReview: true });
    });

    it("a row whose stateCode is NULL heals on ANY edit, from its stored text (written after the backfill)", async () => {
      prisma.customerAddress.findFirst.mockResolvedValue({
        state: "Texas",
        zip: "78701",
        stateCode: null,
      });
      await edit({ city: "Dallas" });
      expect(written()).toMatchObject({ stateCode: "TX", stateNeedsReview: false });
    });

    it("adding the zip that CONFIRMS an ambiguous 'Washington' heals the row (it had no zip, so it was unresolved)", async () => {
      prisma.customerAddress.findFirst.mockResolvedValue({
        state: "Washington",
        zip: "",
        stateCode: null,
      });
      await edit({ zip: "98101" });
      expect(written()).toMatchObject({ stateCode: "WA", stateNeedsReview: false });
    });

    describe("a ZIP-only edit of an already-coded row (a written code must never contradict its zip)", () => {
      beforeEach(() => {
        prisma.customerAddress.findFirst.mockResolvedValue({
          state: "Washington",
          zip: "98101",
          stateCode: "WA",
        });
      });

      it("a contradicting zip (a DC one) drops the code to unresolved + review, like a fresh write of that pair", async () => {
        await edit({ zip: "20001" });
        expect(written()).toMatchObject({ stateCode: null, stateNeedsReview: true });
      });

      it("a zip that still confirms keeps the code; an UNCHANGED zip echoed by the form recomputes nothing", async () => {
        await edit({ zip: "98102" });
        expect(written(0)).toMatchObject({ stateCode: "WA", stateNeedsReview: false });
        await edit({ zip: "98101" });
        expect(written(1)).not.toHaveProperty("stateCode");
      });
    });

    it("an address that is not this customer's is a 404, not a derivation from nothing", async () => {
      prisma.customerAddress.findFirst.mockResolvedValue(null);
      await expect(edit({ city: "Dallas" })).rejects.toThrow("Address not found");
      expect(prisma.customerAddress.update).not.toHaveBeenCalled();
    });

    it("an edit that does not touch `state` leaves BOTH derived columns alone", async () => {
      await edit({ city: "Dallas", addressType: "SHIPPING" });
      expect(written()).not.toHaveProperty("stateCode");
      expect(written()).not.toHaveProperty("stateNeedsReview");
    });

    // The web edit modal resends the unchanged `state` on every save, and the backfill may have
    // resolved it by a rule the strict write boundary lacks ("TX 77001" -> TX): recomputing then
    // would turn a correct code into "unresolved" (and INDETERMINATE for the customer).
    it("resubmitting the UNCHANGED state text keeps the stored code (a typo fix in line1 must not un-resolve it)", async () => {
      prisma.customerAddress.findFirst.mockResolvedValue({
        state: "TX 77001",
        zip: "77001",
        stateCode: "TX",
      });
      await edit({ state: "TX 77001", line1: "2 Congress Ave" });
      expect(written()).not.toHaveProperty("stateCode");
      expect(written()).not.toHaveProperty("stateNeedsReview");
      expect(written()).toMatchObject({ line1: "2 Congress Ave" });
    });
  });

  describe("create (customer with addresses)", () => {
    it("derives the columns for each address it creates", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });

      await service.create({
        businessName: "Acme Corp",
        contactName: "Jo",
        phone: "555-0100",
        addresses: [
          { ...ADDRESS, state: "Texas" },
          { label: "Yard", line1: "9 Nowhere Rd", city: "Elsewhere", state: "Tejas", zip: "00000" },
        ],
      } as any);

      const [main, yard] = prisma.customerAddress.createMany.mock.calls[0][0].data;
      expect(main).toMatchObject({ stateCode: "TX", stateNeedsReview: false });
      expect(yard).toMatchObject({ stateCode: null, stateNeedsReview: true });
    });
  });
});
