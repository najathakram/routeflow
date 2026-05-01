# F3-API-HOST

## RFs addressed
| RF/NEW | Sev | Status | Files | Commit | Test added | Migration? |
|--------|-----|--------|-------|--------|-----------|-----------|
| NEW-v1-1 | P0 | ✅ FIXED | apps/mobile/eas.json | TBD | N/A | No |

## Root cause
Expo EAS build config (`eas.json`) hardcoded stale API host `api.routeflow.app` in production and staging build environments. This URL no longer resolves; the correct Railway host is `routeflowapi-production.up.railway.app`.

## Fix applied
Updated `apps/mobile/eas.json`:
- **Line 36** (staging): Changed `EXPO_PUBLIC_API_URL` from `https://api.routeflow.app` → `https://routeflowapi-production.up.railway.app`
- **Line 42** (production): Changed `EXPO_PUBLIC_API_URL` from `https://api.routeflow.app` → `https://routeflowapi-production.up.railway.app`

The mobile app's `lib/api-client.ts` reads `process.env.EXPO_PUBLIC_API_URL` at build time and constructs the full endpoint as `${BASE_URL}/api/v1`. With the fix, deployed Expo web bundle will now request `https://routeflowapi-production.up.railway.app/api/v1` (correct) instead of stale domain.

## User-visible proof of fix
After EAS rebuilds with this change, verify in browser Network tab that API calls target `routeflowapi-production.up.railway.app` instead of the d504 or `api.routeflow.app` variants.

## Operator action required
1. Commit this change to `master`
2. Trigger a new Expo EAS production build: `eas build --platform web --profile production` (or rebuild in EAS dashboard)
3. Deploy the new bundle to the Expo-hosted URL or your deployment destination
