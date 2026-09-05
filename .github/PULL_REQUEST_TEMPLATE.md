## Summary

<!-- Brief description of what this PR does and why -->

## Changes

-

## Checklist

- [ ] Ran `npm run local:validate` (and `npm run local:e2e` for UI changes) against the local Docker stack
- [ ] Tested locally
- [ ] No `console.log` left in code
- [ ] Migration included if schema changed
- [ ] Adds or tightens an entitlement gate on an existing route? → `@RequireAddon` keys need a registry row
      in apps/api/src/billing/addon-gate-registry.ts (state dark); `@RequirePlanFlag` flags ship inside
      DARK_PLAN_FLAGS (apps/api/src/billing/plan-flag.guard.ts). Blast-radius report attached, grant path named,
      enforcement flips in a separate diff
- [ ] Relevant mocks updated
