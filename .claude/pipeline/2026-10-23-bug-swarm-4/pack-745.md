1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row 745: local:seed test products have non-UUID ids

## Liveness
apps/api/prisma/seed.ts:445 id: seed-prod-09 (also :547, :841 refs); counter DTO requires UUID productId.

## Files / signatures
apps/api/prisma/seed.ts (seed script, product ids seed-prod-NN and stock/order refs)

## Radius
prisma/seed.ts, e2e fixtures referencing seed-prod-*, local:seed wrapper, orders DTO

## Lessons
L-282 prod e2e seed changes only via reviewed PR; L-294 find every writer of a stored shape; L-262 prisma generate in tree
