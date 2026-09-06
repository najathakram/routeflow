# F09 reader-state report (read-only) — 2026-09-06

Worktree: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`
Branch: `fix/F09-credit-notes-wallet`, HEAD `3d8e6076` ("chore(f09): checkpoint before account switch"), based on master `d12203a3`.
This report is a factual snapshot only — no code, tests, or planning docs were modified to produce it. All facts below are grounded in a command actually run or a file actually read in this worktree during this session.

---

## 1. Jest — wallet-integrity gate + pins (verbatim test list, pass/fail)

Command: `cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts --runInBand --verbose`

**Gate file** — `src/credit-notes/credit-notes.wallet-integrity.spec.ts` — **FAIL** (3 failed / 9 total in this file):

| Test                                                                                                                                                                                                                        | Result           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CreditNotesService — wallet-exclusion on the credit apply paths (F09 gate)` › T1 (R1, REG-B67): a WRITTEN_OFF invoice with an unmet credit intent receives NO CREDIT_NOTE payment                                          | PASS (132 ms)    |
| › T2 (R1, REG-B67): a VOID invoice with an unmet credit intent receives NO CREDIT_NOTE payment (pins the existing VOID exclusion through the rewrite)                                                                       | PASS (38 ms)     |
| › T5 (R2, REG-B67): autoApplyOldestCreditsInTx — F07's send()/sendEmail() door — applies NO credit to a WRITTEN_OFF invoice                                                                                                 | PASS (35 ms)     |
| `CreditNotesService — create() refuses VOID/WRITTEN_OFF source invoices (F09 gate)` › T6 (R4, REG-B66): create({ invoiceId }) against a VOID invoice rejects, naming the status, with no creditNote.create call             | **PASS (80 ms)** |
| › T7 (R4, REG-B66): create({ invoiceId }) against a WRITTEN_OFF invoice rejects, naming the status, with no creditNote.create call                                                                                          | **PASS (29 ms)** |
| `InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced (F09 gate)` › T9 (R5, REG-B66): a fully-unused sourced credit note (amountUsed=0) is set VOID inside the same tx, before the invoice row is finalised | **FAIL (32 ms)** |
| › T10 (R5+R6, REG-B66): a partly-used sourced note is capped to amountUsed, never voided, and already-spent dollars are never clawed back                                                                                   | **FAIL (37 ms)** |
| › T11 (R5, REG-B66): only the notes THIS invoice sourced are capped — a note from a different invoice in the same fetched set is untouched                                                                                  | **FAIL (65 ms)** |
| `CreditNotesService — findAll invoice-number include (F09, R9)` › T12 (R9): findAll's creditNote.findMany call includes invoice: { select: { id, invoiceNumber } }, matching findOne's shape                                | PASS (30 ms)     |

**Pins file** — `src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts` — **PASS** (6/6):

- `CreditNotesService — settleOrderCreditsInTx positive controls (F09 pins)` › T3 (R3, REG-B67) — PASS (29 ms)
- › T3b (R3, REG-B67) — PASS (22 ms)
- › T4 (R1, REG-B67) — PASS (21 ms)
- `CreditNotesService — create() unaffected for a live SENT source invoice (F09 pins)` › T8 (R4, REG-B66): creates exactly as before against a live SENT invoice — PASS (79 ms)
- › T8 (R4, REG-B66): the existing over-credit cap still throws on a SENT invoice — PASS (84 ms)
- `CreditNotesService — create() unaffected for a DRAFT source invoice (F09 pins)` › T7b (R4, REG-B66) — PASS (26 ms)

**Totals**: Test Suites: 1 failed, 1 passed, 2 total. Tests: **3 failed, 12 passed, 15 total.**

**Exact failing assertions:**

```
● InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced (F09 gate) › T9 (R5, REG-B66): a fully-unused sourced credit note (amountUsed=0) is set VOID inside the same tx, before the invoice row is finalised

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"where": ObjectContaining {"invoiceId": "inv-void-src-1"}}

    Number of calls: 0
      at credit-notes.wallet-integrity.spec.ts:423:40   (expect(prisma.creditNote.findMany).toHaveBeenCalledWith(...))

● … › T10 (R5+R6, REG-B66): a partly-used sourced note is capped to amountUsed, never voided, and already-spent dollars are never clawed back

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"data": ObjectContaining {"amount": 40}, "where": {"id": "cn-src-partial"}}

    Number of calls: 0
      at credit-notes.wallet-integrity.spec.ts:456:38   (expect(prisma.creditNote.update).toHaveBeenCalledWith(...))

● … › T11 (R5, REG-B66): only the notes THIS invoice sourced are capped — a note from a different invoice in the same fetched set is untouched

    expect(jest.fn()).toHaveBeenCalledWith(...expected)

    Expected: ObjectContaining {"where": {"id": "cn-this-inv"}}

    Number of calls: 0
      at credit-notes.wallet-integrity.spec.ts:504:38   (expect(prisma.creditNote.update).toHaveBeenCalledWith(...))
```

**IMPORTANT DISCREPANCY vs `RESUME.md`**: RESUME.md's audit-2 table says the "one remaining BEHAVIORAL blocker" is **T6/T7** ("`caught` is `undefined` — create() never throws today"). That is **no longer true on this tree** — the actual jest run above shows **T6 and T7 PASS**. All three currently-failing tests (T9, T10, T11) are exactly the ones the P3 package (void-side capping in `voidInvoiceInTx`) was supposed to cover, and P3 is confirmed NOT implemented (see §4). RESUME.md's audit table appears to describe an audit round captured before the "one fix round (8 fixes)" and the P1/P2/P5/P6/P7 implementation landed — it is stale with respect to the current tree and should not be trusted as the current red-gate state. The current, verified red gate is: **T9, T10, T11 fail; everything else (T1,T2,T5,T6,T7,T12 + all 6 pins) passes.**

---

## 2. Verbatim test bodies — T6, T7, T9, T10, T11 + fixture setup

All five live in the **gate** file: `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts` (T11 is confirmed to live here, not in the pins file — see file header comment at lines 34–39 explaining why: it would otherwise pass vacuously).

### Fixture setup for T6/T7 (lines 280–314)

```
280  describe("CreditNotesService — create() refuses VOID/WRITTEN_OFF source invoices (F09 gate)", () => {
281    let service: CreditNotesService;
282    let prisma: ReturnType<typeof createMockPrisma>;
283
284    beforeEach(async () => {
285      prisma = createMockPrisma();
286      const mod: TestingModule = await Test.createTestingModule({
287        providers: [
288          CreditNotesService,
289          { provide: PrismaService, useValue: prisma },
290          { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
291          {
292            provide: RegulatedLedgerService,
293            useValue: {
294              reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
295              unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
296            },
297          },
298          {
299            provide: CommissionEngineService,
300            useValue: {
301              syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
302              syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
303              removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
304            },
305          },
306        ],
307      }).compile();
308      service = mod.get(CreditNotesService);
309      prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001
310      prisma.creditNote.create.mockImplementation((args: any) =>
311        Promise.resolve({ id: "cn-should-not-exist", ...args.data, customer: {} }),
312      );
313    });
314
```

### T6 (lines 315–334)

```
315  it("T6 (R4, REG-B66): create({ invoiceId }) against a VOID invoice rejects, naming the status, with no creditNote.create call", async () => {
316    prisma.invoice.findFirst.mockResolvedValueOnce({
317      total: 100,
318      customerId: "c1",
319      items: [],
320      status: "VOID",
321    });
322    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });
323
324    let caught: any;
325    try {
326      await service.create({ customerId: "c1", invoiceId: "inv-void-1", amount: 30 });
327    } catch (e) {
328      caught = e;
329    }
330
331    expect(caught).toBeInstanceOf(BadRequestException);
332    expect(caught?.message).toMatch(/VOID/);
333    expect(prisma.creditNote.create).not.toHaveBeenCalled();
334  });
```

### T7 (lines 336–355)

```
336  it("T7 (R4, REG-B66): create({ invoiceId }) against a WRITTEN_OFF invoice rejects, naming the status, with no creditNote.create call", async () => {
337    prisma.invoice.findFirst.mockResolvedValueOnce({
338      total: 100,
339      customerId: "c1",
340      items: [],
341      status: "WRITTEN_OFF",
342    });
343    prisma.creditNote.aggregate.mockResolvedValueOnce({ _sum: { amount: 0 } });
344
345    let caught: any;
346    try {
347      await service.create({ customerId: "c1", invoiceId: "inv-written-off-1", amount: 30 });
348    } catch (e) {
349      caught = e;
350    }
351
352    expect(caught).toBeInstanceOf(BadRequestException);
353    expect(caught?.message).toMatch(/WRITTEN_OFF/);
354    expect(prisma.creditNote.create).not.toHaveBeenCalled();
355  });
356  });
```

### Fixture setup for T9/T10/T11 (lines 363–397)

```
363  describe("InvoicesService — voidInvoiceInTx caps/voids credit notes it sourced (F09 gate)", () => {
364    let service: InvoicesService;
365    let prisma: ReturnType<typeof createMockPrisma>;
366    let ledger: { reverseInvoiceEntries: jest.Mock };
367    let commissionEngine: { syncInvoiceCommissionSafe: jest.Mock };
368
369    beforeEach(async () => {
370      prisma = createMockPrisma();
371      ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };
372      commissionEngine = { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) };
373
374      const module: TestingModule = await Test.createTestingModule({
375        providers: [
376          InvoicesService,
377          { provide: PrismaService, useValue: prisma },
378          { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
379          { provide: EmailService, useValue: {} },
380          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
381          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
382          { provide: RegulatedLedgerService, useValue: ledger },
383          { provide: AuthorizationGuardService, useValue: {} },
384          // voidInvoiceInTx never touches this.creditNotes directly — the
385          // sourced-note capping is new logic INSIDE voidInvoiceInTx itself.
386          { provide: CreditNotesService, useValue: {} },
387          { provide: MessagingService, useValue: {} },
388          { provide: StorageService, useValue: {} },
389          { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
390          { provide: CommissionEngineService, useValue: commissionEngine },
391        ],
392      }).compile();
393
394      service = module.get<InvoicesService>(InvoicesService);
395      prisma.invoice.updateMany.mockResolvedValue({ count: 1 }); // the void claim succeeds
396    });
397
```

### T9 (lines 398–441)

```
398  it("T9 (R5, REG-B66): a fully-unused sourced credit note (amountUsed=0) is set VOID inside the same tx, before the invoice row is finalised", async () => {
399    prisma.creditNote.findMany.mockResolvedValueOnce([
400      {
401        id: "cn-src-unused",
402        invoiceId: "inv-void-src-1",
403        amount: 75,
404        amountUsed: 0,
405        status: "ISSUED",
406      },
407    ]);
408    const calls: string[] = [];
409    prisma.creditNote.update.mockImplementation(async (args: any) => {
410      calls.push(`creditNote.update:${args.where.id}`);
411      return { id: args.where.id, ...args.data };
412    });
413    prisma.invoice.findUnique.mockImplementation(async () => {
414      calls.push("invoice.findUnique:final");
415      return { id: "inv-void-src-1", status: "VOID" };
416    });
417
418    await service.voidInvoiceInTx(prisma as any, "inv-void-src-1", null);
419
420    // Scoping oracle (test-plan T9 row): the capping loop must fetch ONLY the
421    // notes this invoice sourced — a broader query would let the loop reach
422    // notes minted from other invoices.
423    expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
424      expect.objectContaining({
425        where: expect.objectContaining({ invoiceId: "inv-void-src-1" }),
426      }),
427    );
428    expect(prisma.creditNote.update).toHaveBeenCalledWith(
429      expect.objectContaining({
430        where: { id: "cn-src-unused" },
431        data: expect.objectContaining({ status: "VOID" }),
432      }),
433    );
434    // Call-order oracle: the void must happen before the final invoice read
435    // that hands back the "finalised" row.
436    const capIdx = calls.indexOf("creditNote.update:cn-src-unused");
437    const finalIdx = calls.indexOf("invoice.findUnique:final");
438    expect(capIdx).toBeGreaterThanOrEqual(0);
439    expect(finalIdx).toBeGreaterThan(-1);
440    expect(capIdx).toBeLessThan(finalIdx);
441  });
```

### T10 (lines 443–474)

```
443  it("T10 (R5+R6, REG-B66): a partly-used sourced note is capped to amountUsed, never voided, and already-spent dollars are never clawed back", async () => {
444    prisma.creditNote.findMany.mockResolvedValueOnce([
445      {
446        id: "cn-src-partial",
447        invoiceId: "inv-void-src-2",
448        amount: 100,
449        amountUsed: 40,
450        status: "ISSUED",
451      },
452    ]);
453
454    await service.voidInvoiceInTx(prisma as any, "inv-void-src-2", null);
455
456    expect(prisma.creditNote.update).toHaveBeenCalledWith(
457      expect.objectContaining({
458        where: { id: "cn-src-partial" },
459        data: expect.objectContaining({ amount: 40 }),
460      }),
461    );
462    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
463      expect.objectContaining({
464        where: { id: "cn-src-partial" },
465        data: expect.objectContaining({ status: "VOID" }),
466      }),
467    );
468    // Already-spent money (the $40 amountUsed) is never touched: no payment
469    // deletion and no amountUsed decrement anywhere in the tx.
470    expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
471    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
472      expect.objectContaining({ data: expect.objectContaining({ amountUsed: expect.anything() }) }),
473    );
474  });
```

### T11 (lines 476–510)

```
476  it("T11 (R5, REG-B66): only the notes THIS invoice sourced are capped — a note from a different invoice in the same fetched set is untouched", async () => {
477    // Defense-in-depth fixture: the fetched set carries one note this invoice
478    // really sourced AND one it does not (as it would if a future query were
479    // scoped too broadly). The service itself, not just the query, must cap the
480    // first and leave the second alone.
481    prisma.creditNote.findMany.mockResolvedValueOnce([
482      {
483        id: "cn-this-inv",
484        invoiceId: "inv-void-src-4",
485        amount: 50,
486        amountUsed: 0,
487        status: "ISSUED",
488      },
489      {
490        id: "cn-other-inv",
491        invoiceId: "inv-completely-different",
492        amount: 50,
493        amountUsed: 0,
494        status: "ISSUED",
495      },
496    ]);
497
498    await service.voidInvoiceInTx(prisma as any, "inv-void-src-4", null);
499
500    // Positive half — RED today (`voidInvoiceInTx` never touches a credit
501    // note), so this test cannot pass against an empty function body; it is
502    // what makes the negative half below a real scoping oracle instead of a
503    // vacuous pass.
504    expect(prisma.creditNote.update).toHaveBeenCalledWith(
505      expect.objectContaining({ where: { id: "cn-this-inv" } }),
506    );
507    expect(prisma.creditNote.update).not.toHaveBeenCalledWith(
508      expect.objectContaining({ where: { id: "cn-other-inv" } }),
509    );
510  });
511  });
```

### `createMockPrisma` helper — `apps/api/src/testing/prisma-mock.ts` (full file, 243 lines)

Key structural facts (verbatim from the file):

- Every model gets a `modelProxy()` — an object of `jest.fn()`s for `findMany/findUnique/findUniqueOrThrow/findFirst/findFirstOrThrow/create/createMany/update/updateMany/delete/deleteMany/count/aggregate/groupBy/upsert`, each pre-seeded with a sensible default resolved value (`findMany → []`, `findUnique → null`, `update → {}`, etc.) (lines 12–56).
- `creditNote: modelProxy()` is included in both `allModels()` (line 82) and `txModels()` (line 185).
- Crucially: `$transaction`/`tenantTransaction` do **not** deep-clone the models — they spread the SAME `models` object reference into the callback each call (lines 223–236):
  ```
  215    return {
  216      ...models,
  217      forTenant: jest.fn().mockReturnValue(models),
  218      getTenantId: jest.fn().mockReturnValue("test-tenant"),
  219      tenantTransaction: jest.fn((fn: any) =>
  220        fn({
  221          ...models,
  222          $executeRaw: jest.fn().mockResolvedValue(0),
  223          $queryRaw: jest.fn().mockResolvedValue([]),
  224        }),
  225      ),
  226      $transaction: jest.fn((fn: any) =>
  227        fn({
  228          ...models,
  229          $executeRaw: jest.fn().mockResolvedValue(0),
  230          $queryRaw: jest.fn().mockResolvedValue([]),
  231        }),
  232      ),
  ```
  (line numbers approximate — verbatim content confirmed, see full file). This is why the T9/T10/T11 tests can call `service.voidInvoiceInTx(prisma as any, ...)` directly, passing the top-level mocked `prisma` object itself as the `tx` argument, and `prisma.creditNote.findMany.mockResolvedValueOnce(...)` set on the outer mock is visible to the function under test.

---

## 3. `create()` (credit-notes.service.ts) verbatim + `invoice-status-sets.ts` (full)

### Imports (lines 1–18)

```
1   import {
2     BadRequestException,
3     ForbiddenException,
4     Injectable,
5     NotFoundException,
6   } from "@nestjs/common";
7   import type { JwtPayload } from "../auth/jwt-payload.interface";
8   import { PrismaService } from "../prisma/prisma.service";
9   import { RouteFlowGateway } from "../gateways/routeflow.gateway";
10  import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
11  import { roundMoney } from "@routeflow/pricing";
12  import { InvoiceStatus, PaymentMethod } from "@prisma/client";
13  import { CommissionEngineService } from "../sales-agents/commission-engine.service";
14  import {
15    CREDIT_NOT_APPLICABLE,
16    CREDIT_SETTLE_EXCLUDED,
17    CREDIT_SOURCE_EXCLUDED,
18  } from "../invoices/invoice-status-sets";
```

### `create()` — select / customer check / status guard / throw message (lines 65–139, the relevant head of the method)

```
65   async create(dto: {
66     customerId: string;
67     invoiceId?: string;
68     amount: number;
69     reason?: string;
70     items?: Array<{ invoiceItemId: string; amount: number; qty?: number }>;
77     expiresAt?: string;
78   }) {
79     if (!dto.amount || dto.amount <= 0)
80       throw new BadRequestException("Amount must be greater than 0");
...
96     const tenantId = this.prisma.getTenantId();
102    const cn = await this.prisma.tenantTransaction(
103      async (tx: any) => {
...
112        if (dto.invoiceId) {
113          const invoice = await tx.invoice.findFirst({
114            where: { id: dto.invoiceId },
115            select: {
116              total: true,
117              customerId: true,
118              status: true,
119              items: {
120                select: {
121                  id: true,
122                  subtotal: true,
123                  qty: true,
124                  trackedCategoryId: true,
125                  categoryTaxAmount: true,
126                },
127              },
128            },
129          });
130          if (!invoice) throw new BadRequestException("Invoice not found");
131          if (invoice.customerId !== dto.customerId)
132            throw new BadRequestException("Invoice does not belong to this customer");
133          // F09/B66: a dead or forgiven invoice justifies no new credit. DRAFT is
134          // allowed on purpose (returns.processRefund and the UI picker rely on it).
135          if (CREDIT_SOURCE_EXCLUDED.includes(invoice.status)) {
136            throw new BadRequestException(
137              `Cannot issue a credit note against a ${invoice.status} invoice.`,
138            );
139          }
```

**This guard is already present and working** — confirmed by the jest run in §1 (T6/T7 both PASS). `select` now includes `status: true` (line 118) as build-plan.md §3 specified.

### `apps/api/src/invoices/invoice-status-sets.ts` (full file, 29 lines)

```
1   import { InvoiceStatus } from "@prisma/client";
2   /** Manual operator apply (`applyToInvoice`): refuses a settled, dead or forgiven target. */
3   export const CREDIT_NOT_APPLICABLE: InvoiceStatus[] = [
4     InvoiceStatus.PAID,
5     InvoiceStatus.VOID,
6     InvoiceStatus.WRITTEN_OFF,
7   ];
8   /**
9    * Automatic apply (`applyCreditInTx`, reached by settleOrderCreditsInTx and autoApplyOldestCreditsInTx).
10   * Deliberately NARROWER than CREDIT_NOT_APPLICABLE: PAID must stay applicable-but-zero-balance because
11   * settle's SHRINK pass runs over the same invoice list and PAID is exactly where shrink has work.
12   * This set gates the WRITE, not the query — the settle `where` keeps WRITTEN_OFF so shrink can restore excess.
13   */
14  export const CREDIT_SETTLE_EXCLUDED: InvoiceStatus[] = [
15    InvoiceStatus.VOID,
16    InvoiceStatus.WRITTEN_OFF,
17  ];
18  /** Minting (`CreditNotesService.create`): a dead or forgiven invoice justifies no new credit. DRAFT is allowed on purpose. */
19  export const CREDIT_SOURCE_EXCLUDED: InvoiceStatus[] = [
20    InvoiceStatus.VOID,
21    InvoiceStatus.WRITTEN_OFF,
22  ];
23  /** Delivery payment targets (`recordDeliveryPaymentInTx`): an ALLOW-list. */
24  export const PAYABLE: InvoiceStatus[] = [
25    InvoiceStatus.DRAFT,
26    InvoiceStatus.SENT,
27    InvoiceStatus.PARTIAL,
28    InvoiceStatus.OVERDUE,
29  ];
```

Matches build-plan.md §1 exactly, verbatim.

---

## 4. `voidInvoiceInTx` (invoices.service.ts) — full function + import checks

### Full function, `apps/api/src/invoices/invoices.service.ts` lines 3837–3852

```
3837  async voidInvoiceInTx(tx: any, id: string, orderId: string | null) {
3838    const claimed = await tx.invoice.updateMany({
3839      where: { id, status: { not: InvoiceStatus.VOID } },
3840      data: { status: InvoiceStatus.VOID },
3841    });
3842    if (claimed.count === 0) {
3843      throw new ConflictException("Invoice was already voided.");
3844    }
3845    await this.adjustInvoicedQtyForInvoice(tx, id, orderId, -1);
3846    await this.ledger.reverseInvoiceEntries({ invoiceId: id, db: tx });
3847    // Sales agents & commissions: a voided invoice targets zero — this
3848    // emits the compensating CLAWBACK adjustment when commission was claimed.
3849    await this.commissionEngine.syncInvoiceCommissionSafe(id, tx);
3850    // Status already flipped to VOID by the claim above; return the fresh record.
3851    return tx.invoice.findUnique({ where: { id } });
3852  }
```

**No `tx.creditNote.*` call exists anywhere inside this function** — confirmed by reading the full body above. This is exactly why T9/T10/T11 fail (0 calls recorded against `prisma.creditNote.findMany`/`.update`). **P3 (build-plan §4, the void-side capping) is confirmed NOT implemented on this tree.**

For context, the caller `voidInvoice` (lines 3854–3878) wraps `releaseWalletPaymentsInTx` then `voidInvoiceInTx` inside one `tenantTransaction` — matches build-plan.md's note "Callers … already call `releaseWalletPaymentsInTx` first — do not reorder."

### `roundMoney` import — confirmed present

`apps/api/src/invoices/invoices.service.ts` lines 13–19:

```
13  import {
14    computeLineSubtotal,
15    computeCategoryTax,
16    roundMoney,
17    normalizeBoxesPieces,
18    type CategoryTaxType,
19  } from "@routeflow/pricing";
```

`roundMoney` is used extensively elsewhere in the file (e.g. lines 255, 352, 399, 420, 424, 425, 747, 876–893, 1056, 1078–1094) — it is a live import, ready for P3 to call.

### `invoice-status-sets` import — confirmed present, but PARTIAL

`apps/api/src/invoices/invoices.service.ts` line 22:

```
22  import { PAYABLE } from "./invoice-status-sets";
```

Only `PAYABLE` is imported here — `CREDIT_SETTLE_EXCLUDED`/`CREDIT_SOURCE_EXCLUDED`/`CREDIT_NOT_APPLICABLE` are imported in `credit-notes.service.ts` instead (see §3), not in `invoices.service.ts`. Nothing in `invoice-status-sets.ts` is specifically for the P3 void-capping logic (build-plan's P3 snippet doesn't reference any of the four exported sets — the capping loop only reads `amountUsed` numerically and doesn't need a status-set import).

---

## 5. `scripts/campaign/bugs.mjs` — usage header, `prove`/`discharge`, and `refuted`

### Usage header block (verbatim, the file's own top-of-file comment)

```
// USAGE — every implemented command (`cmds.*` below is the source of truth;
// keep this list in sync with it, not the other way round):
//   node scripts/campaign/bugs.mjs import                     # seed the catalogue from the register HTML (owner-machine only)
//   node scripts/campaign/bugs.mjs file "<title>" --location "<where>" --severity high|medium|low|critical [--symptom "..."] [--batch F## --tier T1|T2|T3] [--files "a.ts b.ts"]   (--tier is required whenever --batch is given)
//   node scripts/campaign/bugs.mjs next [--json] [--no-claims]  # the next batch an agent may take (the head of wave 1)
//   node scripts/campaign/bugs.mjs waves [--cap N] [--hub-threshold N] [--json] [--no-claims]  # the parallel schedule
//   node scripts/campaign/bugs.mjs list [--open] [--sensitive] [--batch F09]
//   node scripts/campaign/bugs.mjs stats
//   node scripts/campaign/bugs.mjs expand                      # create/refresh one record per catalogue row
//   node scripts/campaign/bugs.mjs sync [--quiet] [--rescan]    # derive History from the ledger + an ANCHORED git scan (idempotent; Gate 4 runs this every turn)
//   node scripts/campaign/bugs.mjs show <B###>
//   node scripts/campaign/bugs.mjs note <B###> "<text>" [--section "Root cause"]
//   node scripts/campaign/bugs.mjs index                        # rebuild bugs.jsonl from the records (regenerate, never hand-edit)
//   node scripts/campaign/bugs.mjs brief <F##|B###>             # everything an agent needs to start a batch, in one output
//   node scripts/campaign/bugs.mjs prove <B###> --pr <n> --proof "REG-B### ..." [--pending-deploy] [--build-plan <path>]  (--build-plan is REQUIRED for a T3 row)
//   node scripts/campaign/bugs.mjs discharge <F##> --evidence "<post-deploy proof>" [--evidence-B### "<per-row proof>"]   # per-row evidence is REQUIRED for every T2 row
//   node scripts/campaign/bugs.mjs reopen <B###> --why "<failing REG-B### token or the run that showed the regression>"
//   node scripts/campaign/bugs.mjs claim <F##>                  # flip that batch's workable rows to in-flight (next/waves skip it)
//   node scripts/campaign/bugs.mjs release <F##>                # give them back
//   node scripts/campaign/bugs.mjs tier <B###> <T1|T2|T3> --why "<reason>"
//   node scripts/campaign/bugs.mjs status [F##]                 # per-batch done/analysed counts
//   node scripts/campaign/bugs.mjs triage                       # catalogue bugs with no ledger row at all
//   node scripts/campaign/bugs.mjs move <B###> --to <F##> [--why "<reason>"]
//   node scripts/campaign/bugs.mjs enrich                       # pull the register's detail blocks + files into every record (owner-machine only)
//   node scripts/campaign/bugs.mjs deps [--bug B###] [--hub-threshold N] [--all]
//   node scripts/campaign/bugs.mjs render [--open]              # regenerate the derived HTML view
//   node scripts/campaign/bugs.mjs self-test                    # also runs as a step of `npm run verify`
```

There is **no `refute` command listed** and no `refuted` state anywhere in this list.

### `cmds.prove` (lines 2245–2346, full function)

```
2245  cmds.prove = (args) => {
2246    const typed = (args[0] ?? "").toUpperCase();
2247    const prRaw = flag(args, "pr");
2248    const proof = flag(args, "proof");
2249    const buildPlanRaw = flag(args, "build-plan");
2250    if (!BUG_ID_RE.test(typed) || !prRaw || !proof)
2251      fail(
2252        'usage: prove <B###> --pr <number> --proof "REG-B### <what the passing test asserts>" ' +
2253          "[--build-plan <path/to/build-plan.md>]   # required for a T3 row",
2254      );
2255    const id = resolveId(typed);
2256    const pr = Number(prRaw);
2257    if (!Number.isInteger(pr) || pr <= 0) fail(`--pr must be a positive integer (got "${prRaw}")`);
2258    if (!new RegExp(`REG-${id}(?![0-9])`).test(proof))
2259      fail(
2260        `--proof must cite the exact token REG-${id} — campaign-check matches that token and nothing else`,
2261      );
2262
2263    const batch = findShardOf(id);
2264    if (!batch) fail(`${id} is in no ledger shard — file it with a --batch first`);
2265
2266    withShardLock(batch, () => {
2267      const row = readShard(batch).rows.find((r) => r.id === id);
2268      if (!row) fail(`${id} vanished from ${batch}.jsonl while this prove waited for the lock`);
2269      const pending = args.includes("--pending-deploy");
2270      const state = pending ? "proven-pending-deploy" : "proven";
2271      if (pending && row.tier !== "T2")
2272        fail("--pending-deploy is for T2 rows only (their proof cannot run pre-merge)");
2273
2274      let buildPlan = row.buildPlan ?? null;
2275      if (row.tier === "T3") {
2276        if (!buildPlanRaw)
2277          fail(
2278            `${id} is tier T3 — --build-plan <path/to/build-plan.md> is required, or campaign-check ` +
2279              `has no way to find its manual-verification row and this prove can never be discharged`,
2280          );
2281        const { resolved, rel } = repoRelativeBuildPlan(buildPlanRaw);
2282        if (!existsSync(resolved))
2283          fail(`--build-plan ${buildPlanRaw} does not exist (resolved to ${resolved})`);
2284        const text = readFileSync(resolved, "utf8");
2285        if (!hasManualVerificationRow(text, id))
2286          fail(
2287            `--build-plan ${buildPlanRaw} has no REG-${id} row in its "## Manual verification" ` +
2288              `section — campaign-check will look there and find nothing`,
2289          );
2290        buildPlan = rel;
2291      } else if (buildPlanRaw) {
2292        buildPlan = repoRelativeBuildPlan(buildPlanRaw).rel;
2293      }
2294      ...
```

(function continues to line 2346 — sets the ledger row's `state`/`pr`/`proof`/`buildPlan`, writes back, and mirrors into the record's History.)

**Required flags for `prove`**: `<B###>` positional, `--pr <positive integer>`, `--proof "REG-B### ..."` (must literally contain `REG-<id>` token). `--build-plan <path>` is **mandatory only for T3 rows** (verified: F09's B13/B18/B19 are tier **T2**, B66/B67 are tier **T1** — none are T3, so `--build-plan` would not be required for any F09 row). `--pending-deploy` flips the target state to `proven-pending-deploy` and is refused unless `row.tier === "T2"`. Otherwise `prove` sets `state: "proven"`.

### `cmds.discharge` (lines 2362–2404+, first ~45 lines shown)

```
2362  cmds.discharge = (args) => {
2363    const evidence = flag(args, "evidence");
2364    if (!evidence)
2365      fail(
2366        'usage: discharge <F##> --evidence "<post-deploy proof: deploy id + the CI run that exercised it>"' +
2367          '\n       [--evidence-B### "<that row\'s own post-deploy proof>"]   # REQUIRED for every T2 row',
2368      );
2369    const batch = normBatch(args[0]);
2370    const thin = (what, text) =>
2371      text.length < 40 &&
2372      fail(
2373        `${what} must actually cite the deploy and the run that proved it — this is the claim campaign-check cannot check for you`,
2374      );
2375    thin("--evidence", evidence);
2376
2377    withCatalogueLock(() =>
2378      withShardLock(batch, () => {
2379        const { rows } = readShard(batch);
2380        const ready = rows.filter((r) => r.state === "proven" || r.state === "proven-pending-deploy");
2381        if (!ready.length)
2382          fail(
2383            `${batch} has no proven row to discharge (states: ${[...new Set(rows.map((r) => r.state))].join(", ")})`,
2384          );
2385
2386        // --evidence-B### <text>, collected before ANY write so a missing one refuses
2387        // the whole discharge rather than leaving half the batch done.
2388        const perRow = new Map();
2389        for (let i = 0; i < args.length; i++) {
2390          const m = /^--evidence-(B\d+)$/i.exec(args[i]);
2391          if (!m) continue;
2392          ...
```

**Required flags for `discharge`**: `<F##>` positional (the batch, e.g. `F09`) and `--evidence "<≥40-char post-deploy proof>"` (rejected if under 40 chars — "thin" check). It requires at least one row in the batch already in state `proven` or `proven-pending-deploy` (fails otherwise). Per the file's own header comment (lines 2348–2361, quoted above the function): **every T2 row additionally requires its own `--evidence-B### "<text>"`**, or the discharge is refused outright with nothing partial written. Since B13/B18/B19 are all tier T2, discharging F09 will require `--evidence-B13`, `--evidence-B18`, and `--evidence-B19` individually (each its own post-deploy proof), in addition to the batch-wide `--evidence`.

### `refuted` — literal grep result

`grep -n "refuted" scripts/campaign/bugs.mjs` returns exactly **one hit**, and it is unrelated to any state transition:

```
7001:        "> ⚠️ Treat this as a hypothesis, not a plan. On F11 the adversarial pass refuted the",
```

There is **no `cmds.refute`, no `cmds.reopen`-adjacent "refuted" case, and no state literal `"refuted"` written anywhere in `bugs.mjs`.** The only state literals the file writes are: `queued`, `in-flight`, `regressed`, `proven`, `proven-pending-deploy`, `done`, `already-fixed` (confirmed via `grep -n "state ===" \| "\"queued\"\|\"proven\"\|\"done\""`). A further check of every bug record under `.claude/campaign/bugs/*.md` for `^state: refuted` returned **zero matches** — no bug in the repo currently carries that state, and grep of `.claude/campaign/status/*.jsonl` for `refuted` also returned nothing.

**Consequence for build-plan.md's P8 package**: its instruction "`B13 → refuted (evidence: no affordance ever existed, git log -S; feature deferred)`" does not correspond to any existing `bugs.mjs` command or machine-checkable state. There is a `note <B###> "<text>" [--section "Root cause"]` command that could record the rationale as free text, and a `move`/`tier` command, but none of them sets `state` to `refuted`. Whoever executes P8 will need to either (a) find/confirm an undocumented mechanism this reader did not locate, (b) use `note` to record the refutation rationale while leaving `state` at its current value (`queued`), or (c) ask the owner how a refuted-but-never-fixed row should be represented in the ledger. This is flagged, not resolved, per this task's read-only scope.

---

## 6. `.claude/campaign/status/F09.jsonl` (full) + bug front matter (B13, B18, B19, B66, B67)

### F09.jsonl — full file, verbatim

```
{"id":"B13","batch":"F09","tier":"T2","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"2d0270fd"}
{"id":"B18","batch":"F09","tier":"T2","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"2d0270fd"}
{"id":"B19","batch":"F09","tier":"T2","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"2d0270fd"}
{"id":"B66","batch":"F09","tier":"T1","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"e5b0af8e"}
{"id":"B67","batch":"F09","tier":"T1","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"e5b0af8e"}
```

**All five rows are still `state: "queued"`** — none has been `prove`d despite the implementation work already landed (P1/P2/P5/P6/P7). No prior `bugs.mjs prove`/`discharge` call has touched F09.

### Front matter — B13.md

```
---
id: B13
title: No way to apply a customer advance on web
location: Invoices / advances · web
severity: medium
batch: F09
tier: T2
state: queued
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx apps/mobile/lib/api/customers.ts apps/web/lib/api/customers.ts apps/web/lib/api/invoices.ts
---
```

### Front matter — B18.md

```
---
id: B18
title: Credit-note Issue flow can never trigger
location: Credit notes · web + mobile
severity: low
batch: F09
tier: T2
state: queued
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/api/prisma/schema.prisma apps/api/src/credit-notes/credit-notes.service.ts apps/api/src/returns/returns.service.ts apps/mobile/lib/credit-notes-logic.ts apps/web/.../credit-notes/[id]/page.tsx
---
```

### Front matter — B19.md

```
---
id: B19
title: Credit notes display raw IDs instead of invoice numbers
location: Credit notes · web
severity: medium
batch: F09
tier: T2
state: queued
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/api/src/credit-notes/credit-notes.service.ts apps/web/.../credit-notes/[id]/page.tsx apps/web/.../credit-notes/page.tsx
---
```

### Front matter — B66.md

```
---
id: B66
title: Credit notes outlive their source invoice's void — and can still be issued against a VOID/DRAFT invoice
location: apps/api/src/invoices + apps/api/src/credit-notes
severity: high
batch: F09
tier: T1
state: queued
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/api/src/credit-notes/credit-notes.service.ts apps/api/src/invoices/invoices.service.ts
---
```

### Front matter — B67.md

```
---
id: B67
title: Order-edit settle applies wallet credit to WRITTEN_OFF invoices
location: apps/api/src/credit-notes — settleOrderCreditsInTx
severity: high
batch: F09
tier: T1
state: queued
proof:
sensitive: true
sensitiveFor: money
closed:
files: apps/api/src/credit-notes/credit-notes.service.ts apps/api/src/invoices/invoices.service.ts apps/api/src/orders/orders.service.ts
---
```

---

## 7. Git state

`git status --porcelain` (worktree root): **empty** — the worktree is clean, nothing uncommitted.

`git log --oneline d12203a3..HEAD`:

```
3d8e6076 chore(f09): checkpoint before account switch
9c719827 docs(pipeline): f09 cause refutation, ruling and revised bug plan
1ff43335 chore(f09): safekeep planning artifacts and red-gate specs
```

`git diff d12203a3..HEAD --stat`: 28 files changed, 2740 insertions(+), 237 deletions(-) — full file list includes all 11 `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/*` docs, the two wallet-integrity spec files, `credit-notes.controller.ts`, `credit-notes.service.ts`, `invoice-status-sets.ts` (new), `invoices.service.ts`, the mobile credit-notes files (4), the web credit-notes/customers files (4), `apps/web/e2e/28-credit-note-wallet.spec.ts` (new), and `apps/web/playwright.config.ts`.

`git diff d12203a3..9c719827 --stat` (the two planning-only commits, i.e. everything BEFORE the checkpoint commit `3d8e6076`):

```
 .../bug-test-plan.md                               |  32 ++
 .../build-plan.md                                  | 132 ++++++
 .../cause-brief.md                                 | 397 ++++++++++++++++++
 .../cause-ruling.md                                |  46 ++
 .../discovery.md                                   |  87 ++++
 .../refutation.md                                  | 361 ++++++++++++++++
 .../2026-09-01-f09-credit-notes-wallet/spec.md     |  86 ++++
 .../test-plan.md                                   |  58 +++
 .../credit-notes.wallet-integrity.pins.spec.ts     | 420 +++++++++++++++++++
 .../credit-notes.wallet-integrity.spec.ts          | 461 +++++++++++++++++++++
 10 files changed, 2080 insertions(+)
```

**Answer to RESUME.md's "1 excluded command?" open question**: confirmed resolved / not a problem. Every file touched between `d12203a3` and `9c719827` is either under `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/**` or is one of the two wallet-integrity spec files (`credit-notes.wallet-integrity.spec.ts`, `credit-notes.wallet-integrity.pins.spec.ts`). **No production source file and no other test file changed in that range.** All actual implementation changes (credit-notes.service.ts, credit-notes.controller.ts, invoices.service.ts, invoice-status-sets.ts, the web/mobile/e2e files) were introduced entirely in the third commit, `3d8e6076` (the checkpoint commit itself), consistent with RESUME.md's claim that Baseline captured a genuinely clean pre-implementation state.

---

## 8. `apps/web/e2e/28-credit-note-wallet.spec.ts` + playwright config

**File exists**: `apps/web/e2e/28-credit-note-wallet.spec.ts` — confirmed present.

**No other `28-*` file** exists in `apps/web/e2e/` (`ls apps/web/e2e/ | grep "^28-"` returned exactly one match).

**Test titles / REG tokens** (verbatim):

```
2:  * F09 — credit-note wallet UI surfaces (T13 / T14, R10 / R7, REG-B19 / REG-B18).
4:  * REG-B19 (R10): the credit-notes list and detail pages used to fall back to
11: * REG-B18 (R7): `issue()` (and its route + the "Issue Credit Note" button)
28: * pre-merge check; the deploy-signal e2e run discharges REG-B18/REG-B19
85:  test("REG-B19: /credit-notes renders the mocked row's invoice number, never the raw UUID (R10 / T13)", async ({
110: test("REG-B18: /credit-notes/:id loads (number heading) with no Issue Credit Note button (R7 / T14)", async ({
```

Two `test(...)` cases: `REG-B19` (T13) and `REG-B18` (T14) — matches bug-test-plan.md's table.

**`git diff d12203a3..HEAD -- apps/web/playwright.config.ts`** (full diff, additive only):

```diff
diff --git a/apps/web/playwright.config.ts b/apps/web/playwright.config.ts
index c5481ed3..b8040be1 100644
--- a/apps/web/playwright.config.ts
+++ b/apps/web/playwright.config.ts
@@ -493,5 +493,20 @@ export default defineConfig({
         timezoneId: "America/Los_Angeles",
       },
     },
+
+    // ── Credit-note wallet UI (F09, spec 28) ───────────────────────────────────
+    // REG-B19 / REG-B18: invoice number over raw UUID on the credit-notes list
+    // and detail pages, and no "Issue Credit Note" affordance. Fully mocked —
+    // no writes to any tenant. Uses operator auth state.
+    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
+    {
+      name: "credit-note-wallet",
+      testMatch: /28-credit-note-wallet\.spec\.ts/,
+      dependencies: ["setup"],
+      use: {
+        ...devices["Desktop Chrome"],
+        storageState: path.join(AUTH_DIR, "operator.json"),
+      },
+    },
   ],
 });
```

A new `credit-note-wallet` project entry is wired and targets the new spec by regex — the slot is confirmed free (no pre-existing `28-*` collision) and the project is registered.

---

## 9. Code map + lessons meta

### `credit-notes.service.ts` — `.claude/code-map/api.md`

No dedicated entry for the file's current shape/exports. Two INDIRECT mentions only:

- line 811: `... Verified NOT bugs (already guarded / different model): credit-notes.service.ts (filters VOID, P5-13) ...` (stale — pre-F09 note about a different, older guard)
- line 1502: `... credit-notes.service.ts: applyCreditInTx, restoreCreditFromPaymentInTx. ...` (a commission-hook-sites list, not describing F09's changes)

Neither line reflects the F09 changes (`CREDIT_SOURCE_EXCLUDED` guard in `create()`, `findAll` include, `issue()` deletion).

### `credit-notes.controller.ts` — `.claude/code-map/api.md`

**Zero matches.** No entry at all — confirmed via `grep -n "credit-notes.controller.ts" .claude/code-map/api.md` (exit code 1 / no output).

### `invoices.service.ts` — `.claude/code-map/api.md`

Multiple entries exist (lines 230, 474, 809, 1087, 1098, 1109, 1492, 1497, 1502, 1537, 1923) but all describe pre-existing functionality (check lifecycle, commission hooks, MSRP, cron jobs, etc.) — **none mentions `voidInvoiceInTx`'s (not-yet-implemented) credit-note capping, nor the new `PAYABLE` import from `invoice-status-sets.ts`.**

### `invoice-status-sets.ts` — `.claude/code-map/api.md`

**Zero matches.** The new file (created in this branch) has no code-map entry at all.

### Web files — `.claude/code-map/web.md`

- `apps/web/lib/api/credit-notes.ts` — **zero matches** (no entry for this exact path).
- `apps/web/lib/api/customers.ts` — **zero matches**.
- `credit-notes/page.tsx` — two matches, but both are stale pre-F09 notes about "Wallet (P5-13)" and "B14 search debounce" features (lines 616, 619) — do not reflect F09's DRAFT/Issue removal or invoice-number rendering changes.
- `credit-notes/[id]/page.tsx` — **zero matches** as an exact standalone entry (only appears folded into the same stale line 616/619 text above).

### Mobile files — `.claude/code-map/mobile.md`

- `apps/mobile/lib/api/credit-notes.ts` — one entry (line 36), describes the pre-F09 shape (`useIssue/Apply/VoidCreditNote`, etc.) — **does not reflect F09's removal of Issue/DRAFT handling.**
- `credit-notes-logic.ts` — same line 36 entry, same staleness.
- `(operator)/credit-notes/` — same line 36 entry.

### e2e spec 28 — anywhere in code-map

**Zero matches** for `28-credit-note-wallet` across `.claude/code-map/*.md` — no code-map entry exists for the new e2e spec.

**Conclusion: P8 (code-map bump) is confirmed NOT done**, consistent with RESUME.md's stage-reached table. Every touched production file either has no code-map entry or has only a stale pre-F09 entry.

### `.claude/code-map/_meta.json` — first 8 lines

```json
{
  "mappedSha": "1ebd4f54",
  "generatedAt": "2026-09-05T20:50:00.000Z",
  "areas": ["api", "web", "mobile", "packages"],
  "fileCount": 1006,
  "notes": "**2026-09-05** — (branch `feat/imp-02b-cron-leader-lock`, improvements item 2b) CRON LEADER LOCK: ...
```

Note: `mappedSha` is `1ebd4f54`, which per the repo's own recent commit log (`0ee2672e` → `17e81c2c` → `d12203a3` → `4c890f1c` → `1ebd4f54`) is **2 commits behind F09's own base** `d12203a3` — the code map was already stale by 2 unrelated master commits before F09 started; this predates F09 and is not something F09 caused, but it means a P8 map bump for F09 will also need to account for whatever those 2 commits changed if they touched any of the same files (not checked here — out of this task's scope).

### `.claude/code-map/CHANGELOG.md` — first 5 bullets (dates only, for brevity; full text is long)

1. **2026-09-05** — worktree `rf-watchdog`, branch `fix/e2e-recurring-toast-locator` — FINAL REBASE onto `origin/master 1ebd4f54` (#623 PR-2b `imp-02b-cron-leader-lock`); spec-30 toast locator fix; lesson L-076.
2. **2026-09-05** — branch `test/upload-routes-multipart-coverage` — static compatibility review of the lifted upload-routes security spec; no code changed.
3. **2026-09-05** — worktree `rf-imp-E`, branch `fix/imp-wave-e-structure` — FINAL REBASE onto `origin/master 7281e4d7` (#616); lesson renumbering L-071→L-073.
4. **2026-09-05** — worktree `rf-watchdog`, branch `fix/ocr-gate-observe-first` — OCR add-on gate observe-first salvaged close-out; lesson L-062.
5. **2026-09-05** — worktree `rf-watchdog`, branch `fix/e2e-spec-locators-and-seed-target` — `e2e-seed.js` DATABASE_URL resolution hardening; lesson L-074.

None of these five most-recent bullets mention F09 — confirming (again) that no CHANGELOG bullet has been added for this branch's work yet.

### `.claude/lessons/_meta.json` — full file

```json
{
  "nextId": 77,
  "activeCount": 39,
  "archivedCount": 33,
  "maxEntries": 40,
  "maxBytes": 40960,
  "updatedAt": "2026-09-05T21:15:00.000Z",
  "schemaVersion": 1,
  "note": "fix/e2e-recurring-toast-locator, rebased onto origin/master 1ebd4f54 (#623 PR-2b `imp-02b-cron-leader-lock` ...) ... Final state: 39 active, 33 archived, nextId 77 (max id 76 across both files, +1)."
}
```

**39/40 active entries** — 1 slot of headroom remains before the cap forces an archive-before-add per `L-039`. F09's planned lesson (build-plan.md P8: "a wallet leak was fixed at the query while a second primitive shared the write") has **not yet been added** — `nextId` is still 77 and the `note` field still describes the prior (unrelated) session's work.

---

## 10. API-scoped TypeScript typecheck

Command: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`

**Exit code: 0. No output (no errors, no warnings).** The current tree — including the not-yet-implemented P3 gap in `voidInvoiceInTx` — compiles cleanly under the API's own build tsconfig. (Web/mobile typechecks were explicitly out of scope for this task and were not run.)

---

## Summary of surprising findings

1. **T6/T7 already pass** — contrary to RESUME.md's "one remaining BEHAVIORAL blocker" framing, the create()-side guard (P2) is fully implemented and both tests pass on the current tree. Only T9/T10/T11 (the P3 void-side capping) are red. RESUME.md's audit-2 table is stale.
2. **`bugs.mjs` has no `refuted` state or command** — build-plan.md's P8 instruction to mark B13 `refuted` does not map onto any implemented `bugs.mjs` mechanism (only `queued/in-flight/regressed/proven/proven-pending-deploy/done/already-fixed` exist as states); this will need a decision before P8 can literally be carried out as written.
3. **All five F09 ledger rows are still `queued`** — no `prove` has been run yet despite P1/P2/P5/P6/P7 landing.
4. **P8 (code map + lesson) is fully unstarted** — none of the touched files have a current-state code-map entry, and the lessons register's `_meta.json`/`note` still reflect an unrelated prior session.
5. **Baseline range (`d12203a3..9c719827`) is clean** — resolves RESUME.md's "1 excluded command?" concern; only planning docs and the two spec files changed there, no production code.
6. `roundMoney` and `PAYABLE` (from `invoice-status-sets.ts`) are already imported into `invoices.service.ts`, so P3 has its dependencies in place and only needs the capping loop itself (per build-plan.md §4) inserted into `voidInvoiceInTx` between the `claimed.count` check and the final `tx.invoice.findUnique`.
