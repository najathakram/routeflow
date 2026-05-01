# L1-Coverage-Delta — Phase E re-run (multi-tab GUI)

Phase E added three workers (M1 driver, M2 auth/blocked, M3 polish) running in dedicated Chrome tabs to close coverage gaps left by Phase B. All actions GUI-only.

## Coverage delta

| Worker | Tab | Role | Pass | Fail | Partial | Blocked |
|--------|-----|------|------|------|---------|---------|
| M1 | own | driver | 1 | 0 | 1 | 3 |
| M2 | own | operator + driver | 2 | 0 | 3 | 3 |
| M3 | own | operator | 1 | 7 | 1 | 0 |

## RF status — gaps now closed

| RF | Sev | Pre-Phase-E | Phase-E result | Worker | Notes |
|----|-----|-------------|----------------|--------|-------|
| RF-004 | P1 | NOT COVERED | ✅ VERIFIED | m1 | Driver B navigating to Driver A's stop UUID → "Stop not found" copy; cross-driver access blocked at API layer |
| RF-005 | P1 | NOT COVERED | ⛔ BLOCKED | m1 | All test stops already DELIVERED; offline-disconnect mid-flow not exercisable |
| RF-006 | P1 | NOT COVERED | ⛔ BLOCKED | m1 | Same — no PENDING stop available |
| RF-009 | P1 | NOT COVERED | ⚠️ PARTIAL | m2 | Operator web login fires zero push-token registration calls; web gracefully skips, native untestable here |
| RF-016 | P1 | NOT COVERED | ⚠️ PARTIAL → ❌ effectively FAIL | m1 | Last-stop completion does NOT auto-flip RouteRun to COMPLETED; driver must tap "Mark route complete" — this is the RF-016 deadlock |
| RF-018 | P1 | NOT COVERED | ⚠️ PARTIAL | m2 | "Forgot?" link shows placeholder modal "Self-serve reset is coming soon"; feature not implemented |
| RF-019 | P1 | NOT COVERED | ⛔ BLOCKED | m1 | No live payment screen reachable on test data |
| RF-074 | P0 | BLOCKED | ⛔ STILL BLOCKED | m2 | Cross-tab session collision (NEW-m2-1) blocked operator stable session; not a /customers 500 anymore — list now loads, but new-customer creation hit "Forbidden resource" toast |
| RF-079 | P1 | BLOCKED | ✅ VERIFIED | m2 | "Tax exempt" toggle visible in New Customer form |
| RF-080 | P1 | BLOCKED | ⛔ STILL BLOCKED | m2 | Cross-tab session collision |
| RF-083 | P1 | BLOCKED | ✅ VERIFIED | m2 | Driver navigating to /customers redirected to /route; PII not exposed |
| RF-197 | P0 | BLOCKED | ⛔ STILL BLOCKED | m2 | Same cross-tab collision; could not complete create-then-delete cycle |
| RF-201 | P2 | BLOCKED | ⚠️ PARTIAL | m3 | Adjust-stock form has REASON chips + NOTES field — UI present, payload not verifiable from network panel after navigation |
| RF-206 | P2 | BLOCKED | ✅ VERIFIED | m3 | Dispatch "All routes" lists 4 unique rows; no duplicates |
| RF-214 | P2 | BLOCKED | ❌ FAIL | m3 | ZIP="1234" + tax="150" persisted on save with "Settings saved" toast; no validation |
| RF-221 | P2 | BLOCKED | ❌ FAIL | m3 | "Mark received" CTA still active on RECEIVED bill |
| RF-223 | P3 | BLOCKED | ❌ FAIL | m3 | Filter tabs: All/Unpaid/Paid/Draft only — Partial and Void absent |
| RF-224 | P2 | BLOCKED | ❌ FAIL | m3 | No "Create Return" CTA anywhere on operator returns page |
| RF-225 | P2 | BLOCKED | ❌ FAIL | m3 | Single push toggle only; no Send Test, no per-event prefs |
| RF-226 | P2 | BLOCKED | ❌ FAIL | m3 | Tenant name and email static read-only text |
| RF-227 | P2 | BLOCKED | ❌ FAIL | m3 | Default tax rate field only; no prefix/due-days |
| RF-228 | P2 | BLOCKED | ⚠️ PARTIAL → effectively FAIL | m2 | Two simultaneous operator tabs both retain in-memory React auth state; no kickout, no warning |

## Re-open list (FAIL/PARTIAL — ranked by severity)

**P1 escalations from NOT COVERED → confirmed broken**
- **RF-016** — Route auto-complete missing. Server doesn't auto-transition RouteRun to COMPLETED when the last stop is DELIVERED; driver must explicitly tap "Mark route complete". Fix: add server-side trigger on stop status change, OR document the manual-confirm intent and remove the "deadlock" framing from the audit.
- **RF-018** — No self-service password reset. UI shows "coming soon" modal; no `/auth/request-password-reset` endpoint reachable from GUI flow. Fix: implement endpoint + email delivery + wire "Forgot?" link to a real form.

**P2 escalations from BLOCKED → confirmed broken** (all by M3)
- RF-214 (validation), RF-221 (Mark Received state), RF-223 (filter tabs), RF-224 (Create Return), RF-225 (Notifications), RF-226 (BP read-only), RF-227 (Invoicing fields).

## New regressions (Phase E)

- **NEW-m2-1 [P1]** Operator and driver apps share the SAME `accessToken` localStorage key on the same origin. Concurrent tabs cause silent cross-role session overwriting with no warning. Repro: open driver tab and operator tab in same browser → second login overwrites first; first tab's API calls now fire as the wrong role. **Implication**: this re-opens RF-077 (claimed VERIFIED in Phase B) at a deeper layer — even though the *separate* keys exist for the buyer flow, operator+driver still collide.
- **NEW-m1-1 [P1]** React error #185 (max update depth exceeded) crash on tapping any item checkbox of an already-DELIVERED stop. Reproduces 100%; page goes white.
- **NEW-m1-2 [P2]** Driver B has a phantom `W32-BUG5-TEST` zero-stop scheduled run leaking from a prior QA cycle.
- **NEW-m1-3 [P3]** "Complete & collect" silently no-ops on a DELIVERED stop with unchecked items — no validation message, no API call.
- **NEW-m2-2 [P2]** POST /customers Forbidden toast shows generic "Forbidden resource" copy with no role/status detail.
- **NEW-m2-3 [P3]** Programmatic DOM `value` set does not trigger React onChange in customer form — frustrates QA automation.
- **NEW-m3-1 [P3]** Settings accepted tax rate "150" without validation; risk of invoice corruption if consumed as multiplier.
- **NEW-m3-2 [P2]** QA tenant stock permanently mutated by adjustments (no rollback guard for `ux-audit` tenant).

## Domain verdict (post-Phase-E)

- auth/security: **HOLD** — RF-076/157 XSS unchanged; NEW-m2-1 cross-role token collision adds a fresh P1.
- dispatch/driver-pod: **HOLD** — RF-002 socket.io still dead; RF-016 missing auto-complete; NEW-m1-1 crash on delivered-stop interaction.
- buyer portal: **HOLD** — unchanged from Phase B; /buyer/orders + /buyer/invoices 500.
- operator UI: **RE-FIX** — RF-203 create-form spinner; RF-090/213 Settings tabs missing; M3 confirmed seven settings/finance/returns gaps.
- finance/money: **RE-FIX** — RF-011, RF-012, RF-014, NEW-v2-1 vendor receive qty bug; M3 confirmed RF-221 and RF-223 still open.
- polish: **HOLD** — most BLOCKED items in Phase B turned out to be FAIL once the GUI was driven; only RF-206 came back clean.
