# Web landing 2026-10-20, bo-train and billing G1 (#3551, merge `af2ab59df`)

Train `train/r1b-r2` (#3551), web side. Paths under `apps/web/` unless noted; `T/` = `app/(platform-admin)/admin/tenants/[id]/`. Api: `api/landing-2026-10-20-bo-train-g1.md`. Tests and fixtures not indexed.

## BO: Capabilities card (replaces the profile picker)

- `T/_features/CapabilitiesCard.tsx` (NEW) `CapabilitiesCard(...)`: tick Delivery, Shipping, Counter, preview, review, apply. Deleted: `BusinessProfileChoices`, `BusinessProfilePicker`, `BusinessProfilePreviewModal`, `tenants/new/_components/setup-lines.ts`.
- `T/_features/CapabilityChoices.tsx` `CapabilityChoices`, `CapabilityChoicesProps` (presets plus ticks, "opens as" choice); `CapabilityPlanSections.tsx` `CapabilityPlanSections`, `billingStops(...)`, `isEmptyPlan(...)`; `CapabilityReviewModal.tsx`; `CapabilityBillingDialog.tsx`.
- `T/_features/capability-ticks.ts` `CapabilityTicks`, `NO_TICKS`, `CAPABILITY_LABELS`, `ticksFromPreset`, `ticksFromCapabilities`, `nothingTicked`, `ticksKey`; `opens-as.ts` `opensAsChoosableFor(ticks)`; `useFocusTarget.ts` `useFocusTarget(key, ref?)` (a deep link waits for its target to mount, then focuses it).
- `T/_features/FeatureConsole.tsx` (reworked, `ADDON_ROW_KEY_BY_REGISTRY_KEY`, `FeatureConsoleProps`), `badge.ts`, `profile-errors.ts`, `profile-plain-copy.ts`, `setup-copy.ts`, `SetupSection.tsx`, `SetupSummary.tsx`, `ConfigSnapshotsTab.tsx`; `T/_components/ReadinessCard.tsx` reads the server's capability answer; `T/page.tsx` and `tenants/new/page.tsx` (wizard) use them.
- `lib/platform-admin/business-profiles.ts` `fetchBusinessProfiles`, `fetchBusinessCapabilities`, `previewBusinessCapabilities`, `applyBusinessCapabilities`, `previewBusinessProfile`, `applyBusinessProfile`, `fetchTenantConfigValue` (contract in `@routeflow/types` `profiles.ts`). `lib/platform-admin/capabilities-contract.ts` and `readiness-contract.ts` are TEMPORARY local contract copies (replace with the shared types). `app/(platform-admin)/_components/AdminModal.tsx` small change.

## G1: activation add-on checklist

- `app/(platform-admin)/_components/ActivationAddonChecklist.tsx` (NEW, SA-788 c) `ActivationAddonChecklist({...})`, `addonsTurnedOff(addons)`: under the success line of a manual activation (tenant page and new-tenant wizard) lists each add-on as Off, Comp, "On, Included" or "On, $N a month"; an amber line shows ONLY when something that was on is now off (tripwire for SA-787). `lib/platform-admin/activate-subscription.ts` returns `ManualActivationResult`; `lib/api/billing.ts` small addition.

## Till permission (BO-07)

- `lib/api/my-permissions.ts` (NEW) `MY_PERMISSIONS_KEY`, `useMyPermissions(userId, {enabled})`, `deniedGroupsOf(perms)`, `isPermissionDenied(err)`, `usePermissionDeniedWatcher()`: the denied groups for the till; `lib/api/counter-sale.ts`, `lib/counter-sale.ts`, `orders/_components/CounterSaleScreen.tsx`, `orders/_components/CreateOrderModal.tsx`, `orders/page.tsx`, `dashboard/page.tsx`, `orders/[id]/_components/PickupHandOver.tsx` hide or refuse the till for a denied operator. e2e: `e2e/helpers/bo-api-mocks.ts`, `playwright.config.ts` BO project.

## Extraction: SendInvoiceModal

- `app/(dashboard)/orders/[id]/_components/SendInvoiceModal.tsx` (moved out of `orders/[id]/page.tsx`, `0320e6fd1`) `InvoiceModalData`, `SendInvoiceModal({data, onClose})`. The static print-surface pin (`invoices/print-surfaces.static.test.ts`) reads the new file (L-322).
