### RC-865 — confirm B865 cause

`addon.service.ts:246-260` no `priceSnapshot`, no BillingEventService (ctor :48-55), no tx. `subscription-mutation.service.ts:1259-1265,:1324-1329` emit for any tenant; :1322 books −catalog. Probe: `-t "REG-ADMIN-ADDON-MRR"` green today.
