# W4 - Driver & POD Flow QA Audit - Findings Report

**Audit Date:** 2026-04-29
**Auditor:** W4 (Code Audit Agent)
**Scope:** RouteFlow Driver Mobile App + Route Execution API
**Status:** Pre-release QA audit

---

## Executive Summary

Critical audit identified 6 high-priority issues:

1. No guard preventing premature stop completion before route run starts
2. Silent failure of offline queue submissions when server returns 404/409
3. Payment submission without amount validation allows $0 or negative payments
4. No photo/signature validation before marking stop as complete
5. Offline queue accumulates indefinitely without user awareness
6. Race conditions enable double-submit and overpayment

## W4-001 - Stop can be marked COMPLETED when route run is SCHEDULED

- **Severity:** P0 (Critical)
- **File:** API: \n- **Issue:** completeStop does NOT verify parent route run status
- **Repro:** Driver submits POD for SCHEDULED run
- **Impact:** Violates delivery workflow
- **Recommended fix:** Guard: if (run.status !== 'IN_PROGRESS') throw BadRequest
- **Expected:** Only IN_PROGRESS runs allow stop completion

---

## Findings Summary

### W4-001: Stop completion without run status guard
- File: API routes.service.ts:975
- Issue: completeStop accepts SCHEDULED runs
- Fix: Check run.status === IN_PROGRESS before accepting completion

### W4-002: Double-submit race condition  
- File: API routes.service.ts:980
- Issue: Check before transaction allows concurrent races
- Fix: Add optimistic locking or pessimistic lock during validation

### W4-003: Silent offline queue discards on 404/409
- File: useNetworkSync.ts:30-35
- Issue: Failed syncs silently dropped without user notification
- Fix: Show toast alerts and persist to failed inbox

### W4-004: Payment amount $0 validation missing
- File: payment.tsx:170-177
- Issue: No validation that payment > 0 (except ON_ACCOUNT)
- Fix: API validate amount >= 0 and enforce > 0 for CASH/CARD

### W4-005: POD (photo/signature) not enforced
- File: payment.tsx:103-114  
- Issue: Can complete without photo OR signature
- Fix: Config flag; reject if required and missing

### W4-006: Payment overpayment race on concurrent submits
- File: invoices.service.ts:1031-1041
- Issue: Concurrent payments bypass remaining balance check
- Fix: Re-verify within transaction after reading alreadyPaid

### W4-007: Offline queue unbounded growth
- File: offlineQueue.ts + useNetworkSync.ts
- Issue: Queue grows indefinitely, no user awareness
- Fix: Max 100 items, add UI badge, add 24h TTL

### W4-008: Photo file size/format not validated
- File: PhotoCapture.tsx:37-57
- Issue: HEIC files (8MB) uploaded without validation
- Fix: Client size check; API max 5MB; server convert to JPEG

### W4-009: EXIF GPS not stripped from photos
- File: Photo upload flow
- Issue: GPS coordinates embedded in photos
- Fix: Server-side EXIF strip before storage

### W4-010: Location not enforced at payment
- File: payment.tsx:36-46
- Issue: Location perm only requested when opening Maps
- Fix: Optional tenant config to enforce at payment time

### W4-011: Signature lost on app crash
- File: podStore.ts (in-memory)
- Issue: No AsyncStorage persistence
- Fix: Add persistence middleware to Zustand

### W4-012: No atomicity for completeStop + payment
- File: payment.tsx:90-168
- Issue: Separate API calls; second can fail after first
- Fix: Unify to single endpoint or queue both

### W4-013: Offline queue no order guarantee
- File: useNetworkSync.ts:17-37
- Issue: Replay order not guaranteed for dependent stops
- Fix: Document independence; add sequenceNumber if needed

### W4-014: Reopen doesn't check credit memos
- File: routes.service.ts:1225-1237
- Issue: Credit memos checked but not blocking reopen
- Fix: Check all adjustments; require ops approval

### W4-015: On-account $0 confuses reporting
- File: payment.tsx:123-124
- Issue: ON_ACCOUNT method with amount=0 excluded from reports
- Fix: Change method name; update report filters

---

## Test Checklist

- [ ] Can't complete stop on SCHEDULED run
- [ ] Double-submit returns 409 on second attempt
- [ ] Offline sync failure shows user notification
- [ ] CASH payment requires amount > 0
- [ ] Required POD (photo/sig) enforced before complete
- [ ] Overpayment rejected for concurrent submits
- [ ] Queue shows size badge and has max limit
- [ ] Photos compressed to <2MB JPEG
- [ ] EXIF data stripped from uploaded photos
- [ ] Signature persists across app crashes
- [ ] completeStop + payment both succeed or both fail
- [ ] On-account visible in ops reports

---

**Report Location:** `/docs/qa/workers/w4-driver-pod/findings.md`
**Generated:** 2026-04-29
**Status:** Complete
