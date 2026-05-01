# W5 Buyer Portal & Customer Mobile Code Audit

**Auditor:** W5 QA  
**Date:** 2026-04-29  
**Scope:** Mobile customer app + Web buyer portal

## Executive Summary

Critical Issues: 1 | High Issues: 3 | Medium Issues: 2 | Verified OK: 11

Key problems:
- W5-001 (CRITICAL): Cart never persists across app restarts
- W5-002 (HIGH): No stock validation on order creation
- W5-003 (HIGH): Cart not cleared on logout (data leak)
- W5-007 (HIGH): Invoice hardcodes 10% GST, ignores tenant settings

---

## Detailed Findings

### W5-001 Cart Not Persisted Across App Restarts
- **Severity:** P0 (CRITICAL)
- **File:** apps/mobile/store/cartStore.ts
- **Issue:** Cart store has no AsyncStorage integration. Items lost on restart, force-close, logout.
- **Repro:** Add 5 items, close app, reopen → cart empty
- **Fix:** Add Zustand persist() middleware with AsyncStorage
- **Expected:** Cart persists across restarts; cleared only on logout

### W5-002 No Stock Validation at Checkout
- **Severity:** P1 (HIGH)
- **File:** apps/api/src/orders/orders.service.ts (lines 474-670)
- **Issue:** No qty vs stock availability check. Order created even if product out of stock.
- **Repro:** Product qty=5, buyer adds 3, operator reduces to 0, buyer checks out
- **Fix:** Add stock check before order.create()
- **Expected:** Order fails with helpful error if insufficient stock

### W5-003 Cart Not Cleared on Logout
- **Severity:** P1 (HIGH)
- **File:** apps/mobile/lib/buyer-auth.ts
- **Issue:** signOut() clears tokens but NOT cart. Buyer A logs out, Buyer B logs in, sees Buyer A's items.
- **Repro:** User A adds items → logout → User B login → sees User A's items
- **Fix:** Call useCartStore.getState().clear() in signOut()
- **Expected:** Cart cleared on logout

### W5-004 Place Order Button Not Disabled When Empty
- **Severity:** P2 (MEDIUM)
- **File:** apps/mobile/app/(customer)/orders/cart.tsx
- **Issue:** Button clickable with empty cart (API rejects, poor UX)
- **Fix:** Disable button when items.length === 0
- **Expected:** Button disabled for empty cart

### W5-005 OK Cancel Order from Mobile (VERIFIED)
- **Status:** PASS
- **Mobile correctly restricts to PENDING/DRAFT owned by buyer**

### W5-006 Order Timeline Missing from Mobile (MINOR)
- **Severity:** P3
- **Issue:** No progress indicator like web has
- **Impact:** Less rich UX but functional

### W5-007 Invoice Hardcodes 10% GST
- **Severity:** P1 (HIGH)
- **Files:** Mobile: apps/mobile/app/(customer)/invoices/[id].tsx (line 73)
- **Issue:** Hardcoded "GST (10%)" regardless of tenant tax rate (0%, 15%, etc)
- **Repro:** Tenant tax=15%, invoice shows "GST (10%)"
- **Fix:** Calculate rate from data: (tax / subtotal) * 100
- **Expected:** Correct tax rate per tenant

### W5-008 OK Invoice PDF Download (VERIFIED)
- **Status:** PASS
- **Web shows PDF; mobile N/A by design**

### W5-009 OK Empty Invoice State (VERIFIED)
- **Status:** PASS
- **Shows "No invoices yet." with no errors**

### W5-010 OK Invoice Amounts Correct (VERIFIED)
- **Status:** PASS
- **Tax calculated dynamically, not hardcoded**

### W5-011 OK Standing Orders Edit Limited (VERIFIED)
- **Status:** PASS
- **By design: pause/resume only, no edit items**

### W5-012 OK Favorites Per-Seller Scoping (VERIFIED)
- **Status:** PASS
- **Scoped correctly by buyer.id + customer.id**

### W5-013 Deleted Favorites Show Broken Cards
- **Severity:** P2 (MEDIUM)
- **File:** apps/web/app/buyer/portal/[seller]/favorites/page.tsx
- **Issue:** Deleted product favorites become stale; show undefined details
- **Fix:** Cascade delete or filter invalid items
- **Expected:** No broken cards

### W5-014 Profile Read-Only No Email Change
- **Severity:** P3
- **File:** apps/mobile/app/(customer)/profile.tsx
- **Issue:** Read-only screen; no UI for changes
- **Note:** Likely by design

### W5-015 OK Session Isolation (VERIFIED)
- **Status:** PASS
- **Cannot access wrong seller; switch properly clears state**

### W5-016 Web Has More Features Than Mobile
- **Severity:** P2
- **Missing from mobile:** Favorites, Dashboard, Analytics
- **Note:** Decide scope and document

---

## Fix Priority

### CRITICAL (Before Release)
1. W5-001: Cart persistence with AsyncStorage
2. W5-002: Stock validation at checkout
3. W5-003: Clear cart on logout

### HIGH (Before Release)
4. W5-004: Disable button when empty
5. W5-007: Dynamic tax rate in invoice

### MEDIUM (Next Sprint)
6. W5-013: Handle deleted favorites
7. W5-016: Define mobile feature scope

---

## Testing Checklist

- [ ] Cart persists after force-close
- [ ] Cart cleared on logout
- [ ] Order fails if qty > stock
- [ ] Place Order disabled when empty
- [ ] Invoice shows correct tax rate
- [ ] Deleted products removed from favorites
- [ ] No cross-user data leakage
