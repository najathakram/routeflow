ebc237be009b73e56e4f5d15934ed3d7921be02d
# Row 302 Business Name never saves (LIVE)
Evidence: apps/web/app/(dashboard)/settings/page.tsx:116,328 businessName is an editable zod/Input field; :170 toast 'Profile saved'.
apps/api/src/system-config/settings.controller.ts:253 patch allow-list is [taxRate, logoUrl] only; businessName is super-admin-owned, silently dropped.
Fix shape: render field read-only (or send nothing) with copy; no API money/tenancy.
Signatures: function BusinessProfileTab(); profileSchemaFor(canEditTimeZone); SettingsController.updateSettings (PATCH /settings).
Radius: settings/page.tsx, settings.controller.ts, settings tests.
Lessons: L-305 enumerate surfaces by search; L-322 repoint static pins after edits.
