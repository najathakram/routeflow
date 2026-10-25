1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row 302: Business Name never saves (Settings > Business profile)

## Liveness
Likely fixed-on-master: settings/page.tsx:116,284,312-318 submits businessName via saveSettings; api tenants.service.ts:435-448 persists dto.businessName. Register says VERIFY-CLOSE, #3353 merged. Needs a runtime confirm only.

## Files / signatures
apps/web/app/(dashboard)/settings/page.tsx: onSubmit({timezone,...rest}); apps/api/src/tenants/tenants.service.ts updateBranding; dto/update-branding.dto.ts businessName?: string

## Radius
settings/page.tsx, settings/_components/BusinessCard.tsx, tenants.service.ts, tenants.controller.ts, update-branding.dto.ts

## Lessons
L-304 name the select/serializer/allowlist behind a display gap; L-333 compute derived values in render; L-205 assert real behavior in regression tests
