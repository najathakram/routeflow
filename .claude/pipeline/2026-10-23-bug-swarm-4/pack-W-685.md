1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row W-685: Mobile customer edit cannot clear creditLimit

## Liveness
apps/mobile/lib/customer-payload.ts:5-9 parseOptionalNumber returns undefined for empty; :65 creditLimit: parseOptionalNumber(form.creditLimit). Web uses creditLimitForSubmit (apps/web/lib/customer-credit-limit.ts).

## Files / signatures
parseOptionalNumber(v: string): number|undefined; buildCustomerPayload; web creditLimitForSubmit(value, mode, ...)

## Radius
mobile/lib/customer-payload.ts, mobile/components/CustomerForm, web/lib/customer-credit-limit.ts, api customers dto, mobile __tests__

## Lessons
L-300 snapshot server state at edit start, diff only vs it; L-317 list all consumers; L-072 shared types in packages/types
