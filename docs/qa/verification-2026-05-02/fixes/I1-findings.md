# I1

## Errors fixed (one row per file)

| File | Rule | Fix |
|------|------|-----|
| `src/buyer/buyer.controller.ts` | `prettier/prettier` | Auto-fixed 5 line-length/trailing-comma formatting errors via `eslint --fix` |
| `src/common/throttler-exception.filter.ts` | `prettier/prettier` | Auto-fixed 7 import and method-chain formatting errors via `eslint --fix` |
| `src/invoices/invoices.service.ts` | `prettier/prettier` | Auto-fixed 1 stray CRLF/whitespace error via `eslint --fix` |
| `src/returns/returns.service.ts` | `prettier/prettier` | Auto-fixed 1 chained-call formatting error via `eslint --fix` |
| `src/routes/routes.service.ts` | `prettier/prettier` + `@typescript-eslint/no-redundant-type-constituents` | Auto-fixed 2 CRLF formatting errors; manually changed return type of `checkIdempotencyKey` from `Promise<unknown \| null>` to `Promise<unknown>` (null is subsumed by unknown) |

## Final lint output

```
✖ 3427 problems (0 errors, 3427 warnings)
  0 errors and 1 warning potentially fixable with the --fix option.
```

## Build status

`npx nest build` — completed with no output (success, 0 type errors).

Unit tests (buyer, routes, invoices, returns, throttler): **4 suites, 48 tests — all passed**.
