# API landing 2026-10-12 (MacBook lane pushed branches)

Pushed, not yet merged. Symbols read at the branch tip. Paths are under `apps/api/src/`.

## Delivery + POS business profile (`feat/sa2-delivery-pos-profile`, `df643f3f7`)

- `billing/business-profiles.ts`: NEW registry row `delivery_pos` (label "Delivery + POS", `fleet: true`, `modes: { fulfilment_model: "delivery", counter_sales: "on" }`; `delivery`, not `both`, because `both` adds carrier shipping). The registry now has five profiles in picker order; `packages/types/api/profiles.ts` carries the new key.
