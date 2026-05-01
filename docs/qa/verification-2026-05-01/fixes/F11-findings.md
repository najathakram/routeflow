# F11-SETTINGS-V2

## RFs addressed

| RF | Sev | Status | Files | Commit | Test added | Migration? |
|----|-----|--------|-------|--------|------------|-----------|
| RF-214 | P2 | ✅ DONE | `apps/web/app/(dashboard)/settings/page.tsx` | `990e219` | No | No |
| RF-221 | P2 | ✅ DONE | `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx` | N/A | No | No |
| RF-223 | P3 | ✅ DONE | `apps/web/app/(dashboard)/finance/expenses/page.tsx` | N/A | No | No |
| RF-224 | P2 | ✅ DONE | `apps/web/app/(dashboard)/returns/page.tsx` | N/A | No | No |
| RF-225 | P2 | ✅ DONE | `apps/web/app/(dashboard)/settings/page.tsx` | `990e219` | No | No |
| RF-226 | P2 | ✅ DONE | `apps/web/app/(dashboard)/settings/page.tsx` | `990e219` | No | No |
| RF-227 | P2 | ✅ DONE | `apps/web/app/(dashboard)/settings/page.tsx` | N/A | No | No |

## Notes / blockers

- **RF-214**: Added validation error blocking to Save Changes button. Schema already had ZIP regex validation (requires ≥5 digits) and tax rate min/max (0–100).
- **RF-221**: "Mark Received" button only shown when status=DRAFT, already satisfied. No change needed.
- **RF-223**: STATUS_OPTIONS already includes Partial and Void tabs in filter dropdown. No change needed.
- **RF-224**: "+ New Return" button already present in returns list header. No change needed.
- **RF-225**: Added per-event notification toggles (Order Placed, Order Delivered, Payment Received) as UI placeholders. Send Test button already existed.
- **RF-226**: Converted Business Name and Account Email from static display to editable input fields. Added to profile schema and form.
- **RF-227**: Invoice Number Prefix and Payment Due Days inputs already exist and wire to PATCH /settings. No change needed.

## User-visible proof of fix

1. **RF-214**: Save Changes button now disabled when validation errors exist (ZIP/tax rate). Live validation shown inline.
2. **RF-225**: Notifications tab now shows per-event toggles below "Driver App Notifications" status when configured.
3. **RF-226**: Business Name and Account Email fields in Business Information card are now editable inputs, saved via existing /settings endpoint.
4. All other RFs confirmed implemented in baseline.
